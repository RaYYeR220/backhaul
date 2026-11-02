// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Outbox} from "../../src/core/Outbox.sol";
import {Transfer, Transfers} from "../../src/core/Transfer.sol";
import {PortaldotGateway} from "../../src/portaldot/PortaldotGateway.sol";
import {BscGateway} from "../../src/bsc/BscGateway.sol";
import {PPOT} from "../../src/bsc/PPOT.sol";
import {MockRemoteVerifier} from "../mocks/MockRemoteVerifier.sol";
import {MockAssetPrecompile} from "../mocks/MockAssetPrecompile.sol";

/// @notice Both chains in one EVM. Each verifier mirrors the other chain's Outbox, so it accepts
/// exactly what the real light-client verifier would prove.
abstract contract BridgeFixture is Test {
    /// pallet-assets ERC-20 precompile address shape: asset id in the first 4 bytes, 0x0120 suffix.
    address internal constant BNBB = 0x0000000700000000000000000000000001200000;
    uint256 internal constant BNBB_SUPPLY = 1_000_000e18;

    Outbox internal outboxP; // Portaldot Outbox
    Outbox internal outboxB; // BSC Outbox
    MockRemoteVerifier internal verP; // on Portaldot, proves BSC state
    MockRemoteVerifier internal verB; // on BSC, proves Portaldot state
    PortaldotGateway internal pGw;
    BscGateway internal bGw;
    PPOT internal ppot;
    MockAssetPrecompile internal bnbb;

    function setUp() public virtual {
        outboxP = new Outbox();
        outboxB = new Outbox();
        verP = new MockRemoteVerifier();
        verB = new MockRemoteVerifier();
        verP.setMirror(address(outboxB));
        verB.setMirror(address(outboxP));

        MockAssetPrecompile impl = new MockAssetPrecompile();
        vm.etch(BNBB, address(impl).code);
        bnbb = MockAssetPrecompile(BNBB);

        pGw = new PortaldotGateway(outboxP, verP, BNBB);
        ppot = new PPOT(vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1));
        bGw = new BscGateway(outboxB, verB, ppot);
        pGw.setRemote(address(bGw));
        bGw.setRemote(address(pGw));

        bnbb.mint(address(pGw), BNBB_SUPPLY);
    }

    function _fee(uint256 value) internal pure returns (uint256 fee) {
        fee = value * 10 / 10_000;
        fee -= fee % 1e4;
    }

    function _lockPOT(address from, uint256 value, address to) internal returns (Transfer memory t) {
        vm.deal(from, from.balance + value);
        vm.prank(from);
        uint64 nonce = pGw.lockPOT{value: value}(to);
        t = Transfer(nonce, Transfers.POT_TO_BSC, to, value - _fee(value));
    }

    function _burnPPOT(address from, uint256 amount, address to) internal returns (Transfer memory t) {
        vm.prank(from);
        uint64 nonce = bGw.burnPPOT(amount, to);
        t = Transfer(nonce, Transfers.PPOT_TO_PORTALDOT, to, amount);
    }

    function _lockBNB(address from, uint256 value, address to) internal returns (Transfer memory t) {
        vm.deal(from, from.balance + value);
        vm.prank(from);
        uint64 nonce = bGw.lockBNB{value: value}(to);
        t = Transfer(nonce, Transfers.BNB_TO_PORTALDOT, to, value);
    }

    function _burnBNBb(address from, uint256 amount, address to) internal returns (Transfer memory t) {
        vm.startPrank(from);
        bnbb.approve(address(pGw), amount);
        uint64 nonce = pGw.burnBNBb(amount, to);
        vm.stopPrank();
        t = Transfer(nonce, Transfers.BNBB_TO_BSC, to, amount);
    }

    function _key(address app, uint64 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(app, bytes32(uint256(nonce))));
    }
}
