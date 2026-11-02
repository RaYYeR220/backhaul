// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BridgeFixture} from "./BridgeFixture.sol";
import {Transfer, Transfers} from "../../src/core/Transfer.sol";
import {GatewayBase} from "../../src/core/GatewayBase.sol";
import {PortaldotGateway} from "../../src/portaldot/PortaldotGateway.sol";
import {BscGateway} from "../../src/bsc/BscGateway.sol";
import {PPOT} from "../../src/bsc/PPOT.sol";
import {MockAssetPrecompile} from "../mocks/MockAssetPrecompile.sol";

contract BridgeHandler is Test {
    PortaldotGateway internal pGw;
    BscGateway internal bGw;
    PPOT internal ppot;
    MockAssetPrecompile internal bnbb;

    address[4] internal actors;
    Transfer[] internal inFlightP2B; // committed on Portaldot, not yet finalized on BSC (kinds 1, 4)
    Transfer[] internal inFlightB2P; // committed on BSC, not yet finalized on Portaldot (kinds 2, 3)
    Transfer[] internal doneOnBsc;
    Transfer[] internal doneOnP;

    uint256 public pendingPOT; // tPOT locked but not minted + pPOT burned but not released
    uint256 public pendingBNB; // tBNB locked but not credited + BNB.b burned but not released
    bool public forgedAccepted;

    constructor(PortaldotGateway p, BscGateway b, PPOT pp, MockAssetPrecompile a) {
        pGw = p;
        bGw = b;
        ppot = pp;
        bnbb = a;
        for (uint256 i; i < 4; i++) {
            actors[i] = makeAddr(string(abi.encodePacked("actor", vm.toString(i))));
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % 4];
    }

    function lockPOT(uint256 seed, uint256 value) external {
        value = bound(value, 1, 1e24);
        value -= value % 1e4;
        if (value == 0) return;
        address a = _actor(seed);
        vm.deal(a, a.balance + value);
        vm.prank(a);
        uint64 n = pGw.lockPOT{value: value}(_actor(seed >> 8));
        Transfer memory t = Transfer(n, Transfers.POT_TO_BSC, _actor(seed >> 8), value - _fee(value));
        inFlightP2B.push(t);
        pendingPOT += t.amount;
    }

    function burnPPOT(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        uint256 bal = ppot.balanceOf(a);
        if (bal < 1e4) return;
        amount = bound(amount, 1e4, bal);
        amount -= amount % 1e4;
        vm.prank(a);
        uint64 n = bGw.burnPPOT(amount, _actor(seed >> 8));
        inFlightB2P.push(Transfer(n, Transfers.PPOT_TO_PORTALDOT, _actor(seed >> 8), amount));
        pendingPOT += amount;
    }

    function lockBNB(uint256 seed, uint256 value) external {
        value = bound(value, 1, 1e22);
        address a = _actor(seed);
        vm.deal(a, a.balance + value);
        vm.prank(a);
        uint64 n = bGw.lockBNB{value: value}(_actor(seed >> 8));
        inFlightB2P.push(Transfer(n, Transfers.BNB_TO_PORTALDOT, _actor(seed >> 8), value));
        pendingBNB += value;
    }

    function burnBNBb(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        uint256 bal = bnbb.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.startPrank(a);
        bnbb.approve(address(pGw), amount);
        uint64 n = pGw.burnBNBb(amount, _actor(seed >> 8));
        vm.stopPrank();
        inFlightP2B.push(Transfer(n, Transfers.BNBB_TO_BSC, _actor(seed >> 8), amount));
        pendingBNB += amount;
    }

    function donate(uint256 value) external {
        value = bound(value, 0, 10e18);
        value -= value % 1e4;
        vm.deal(address(this), value);
        pGw.donateGas{value: value}();
    }

    function finalizeOnBsc(uint256 idx) external {
        if (inFlightP2B.length == 0) return;
        idx %= inFlightP2B.length;
        Transfer memory t = inFlightP2B[idx];
        inFlightP2B[idx] = inFlightP2B[inFlightP2B.length - 1];
        inFlightP2B.pop();
        bGw.finalize(t, "");
        doneOnBsc.push(t);
        if (t.kind == Transfers.POT_TO_BSC) pendingPOT -= t.amount;
        else pendingBNB -= t.amount;
    }

    function finalizeOnPortaldot(uint256 idx) external {
        if (inFlightB2P.length == 0) return;
        idx %= inFlightB2P.length;
        Transfer memory t = inFlightB2P[idx];
        inFlightB2P[idx] = inFlightB2P[inFlightB2P.length - 1];
        inFlightB2P.pop();
        pGw.finalize(t, "");
        doneOnP.push(t);
        if (t.kind == Transfers.PPOT_TO_PORTALDOT) pendingPOT -= t.amount;
        else pendingBNB -= t.amount;
    }

    /// Replays a finalized transfer, or a tampered copy of an in-flight one. Must never succeed.
    function attack(uint256 idx, uint256 mode) external {
        Transfer memory t;
        bool onBsc = mode % 2 == 0;
        if (mode % 4 < 2) {
            Transfer[] storage done = onBsc ? doneOnBsc : doneOnP;
            if (done.length == 0) return;
            t = done[idx % done.length];
        } else {
            Transfer[] storage live = onBsc ? inFlightP2B : inFlightB2P;
            if (live.length == 0) return;
            t = live[idx % live.length];
            t.amount += 1 + (mode >> 8) % 1e18;
        }
        GatewayBase g = onBsc ? GatewayBase(address(bGw)) : GatewayBase(address(pGw));
        try g.finalize(t, "") {
            forgedAccepted = true;
        } catch {}
    }

    function _fee(uint256 value) internal pure returns (uint256 fee) {
        fee = value * 10 / 10_000;
        fee -= fee % 1e4;
    }
}

contract GatewaysInvariantTest is BridgeFixture {
    BridgeHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new BridgeHandler(pGw, bGw, ppot, bnbb);
        targetContract(address(handler));
    }

    function invariant_ppotSupplyEqualsLocked() public view {
        assertEq(ppot.totalSupply() + handler.pendingPOT(), pGw.lockedPOT());
    }

    function invariant_bnbbCirculatingEqualsLockedBnb() public view {
        uint256 circulating = BNBB_SUPPLY - bnbb.balanceOf(address(pGw));
        assertEq(circulating + handler.pendingBNB(), address(bGw).balance);
    }

    function invariant_gasPoolIsSeparateFromLocked() public view {
        assertEq(address(pGw).balance, pGw.lockedPOT() + pGw.gasPool());
    }

    function invariant_noReplayOrForgery() public view {
        assertFalse(handler.forgedAccepted());
    }
}
