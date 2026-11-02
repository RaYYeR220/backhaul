// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgeFixture} from "./BridgeFixture.sol";
import {Outbox} from "../../src/core/Outbox.sol";
import {Transfer, Transfers} from "../../src/core/Transfer.sol";
import {GatewayBase} from "../../src/core/GatewayBase.sol";
import {PortaldotGateway} from "../../src/portaldot/PortaldotGateway.sol";
import {BscGateway} from "../../src/bsc/BscGateway.sol";
import {PPOT} from "../../src/bsc/PPOT.sol";
import {MockAssetPrecompile} from "../mocks/MockAssetPrecompile.sol";

/// Receives native and, while doing so, tries to finalize the same transfer again.
contract ReplayingRecipient {
    GatewayBase public gw;
    Transfer public pending;
    bool public armed;
    bool public replayBlocked;

    function arm(GatewayBase g, Transfer calldata t) external {
        gw = g;
        pending = t;
        armed = true;
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        try gw.finalize(pending, "") {
            replayBlocked = false;
        } catch {
            replayBlocked = true;
        }
    }
}

contract RejectingRecipient {
    receive() external payable {
        revert("no");
    }
}

/// An app that writes into the shared Outbox under the gateway's nonce, hoping to be mistaken for it.
contract Spoofer {
    function spoof(Outbox o, uint64 nonce, bytes32 value) external {
        o.commit(bytes32(uint256(nonce)), value);
    }
}

contract GatewaysTest is BridgeFixture {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    // ---------------------------------------------------------------- tPOT <-> pPOT

    function test_lockCommitsAndFinalizeMints() public {
        Transfer memory t = _lockPOT(alice, 2e18, bob);
        assertEq(t.nonce, 0);
        assertEq(outboxP.commitments(_key(address(pGw), 0)), keccak256(abi.encode(t)));
        assertEq(pGw.lockedPOT(), 2e18 - _fee(2e18));
        assertEq(pGw.gasPool(), _fee(2e18));

        vm.expectEmit(address(bGw));
        emit GatewayBase.Finalized(t.nonce, t, bob);
        bGw.finalize(t, "");
        assertEq(ppot.balanceOf(bob), t.amount);
        assertEq(ppot.totalSupply(), pGw.lockedPOT());
        assertTrue(bGw.isFinalized(0));
    }

    function test_lockEmitsLocked() public {
        vm.deal(alice, 1e18);
        Transfer memory t = Transfer(0, Transfers.POT_TO_BSC, bob, 1e18 - _fee(1e18));
        vm.expectEmit(address(pGw));
        emit GatewayBase.Locked(0, t);
        vm.prank(alice);
        pGw.lockPOT{value: 1e18}(bob);
    }

    function test_noncesIncrementAcrossKinds() public {
        Transfer memory a = _lockPOT(alice, 1e18, bob);
        bnbb.mint(alice, 1e18);
        Transfer memory b = _burnBNBb(alice, 1e18, bob);
        assertEq(a.nonce, 0);
        assertEq(b.nonce, 1);
        assertEq(pGw.nextNonce(), 2);
    }

    function test_finalizeTwiceReverts() public {
        // Portaldot -> BSC, kind 1
        Transfer memory t1 = _lockPOT(alice, 1e18, bob);
        bGw.finalize(t1, "");
        vm.expectRevert(abi.encodeWithSelector(GatewayBase.AlreadyFinalized.selector, t1.nonce));
        bGw.finalize(t1, "");

        // BSC -> Portaldot, kind 2
        Transfer memory t2 = _burnPPOT(bob, t1.amount, alice);
        pGw.finalize(t2, "");
        vm.expectRevert(abi.encodeWithSelector(GatewayBase.AlreadyFinalized.selector, t2.nonce));
        pGw.finalize(t2, "");

        // BSC -> Portaldot, kind 3
        Transfer memory t3 = _lockBNB(alice, 1e18, bob);
        pGw.finalize(t3, "");
        vm.expectRevert(abi.encodeWithSelector(GatewayBase.AlreadyFinalized.selector, t3.nonce));
        pGw.finalize(t3, "");

        // Portaldot -> BSC, kind 4
        Transfer memory t4 = _burnBNBb(bob, 1e18, alice);
        bGw.finalize(t4, "");
        vm.expectRevert(abi.encodeWithSelector(GatewayBase.AlreadyFinalized.selector, t4.nonce));
        bGw.finalize(t4, "");
    }

    function test_replayFromInsideReleaseReverts() public {
        ReplayingRecipient r = new ReplayingRecipient();
        Transfer memory t1 = _lockPOT(alice, 1e18, bob);
        bGw.finalize(t1, "");
        Transfer memory t2 = _burnPPOT(bob, t1.amount, address(r));
        r.arm(pGw, t2);
        pGw.finalize(t2, "");
        assertTrue(r.replayBlocked());
        assertEq(address(r).balance, t1.amount);
        assertEq(pGw.lockedPOT(), 0);
    }

    function test_finalizeWrongKindReverts() public {
        // A commitment that verifies but carries a kind the receiving gateway must not handle.
        for (uint8 kind = 0; kind <= 5; kind++) {
            Transfer memory t = Transfer(100 + kind, kind, bob, 1e18);
            bytes32 v = keccak256(abi.encode(t));
            verB.setCommitment(_key(address(pGw), t.nonce), v, true);
            verP.setCommitment(_key(address(bGw), t.nonce), v, true);

            if (kind != Transfers.POT_TO_BSC && kind != Transfers.BNBB_TO_BSC) {
                vm.expectRevert(abi.encodeWithSelector(GatewayBase.WrongKind.selector, kind));
                bGw.finalize(t, "");
            }
            if (kind != Transfers.PPOT_TO_PORTALDOT && kind != Transfers.BNB_TO_PORTALDOT) {
                vm.expectRevert(abi.encodeWithSelector(GatewayBase.WrongKind.selector, kind));
                pGw.finalize(t, "");
            }
        }
    }

    function test_invalidProofReverts() public {
        Transfer memory t = _lockPOT(alice, 1e18, bob);

        Transfer memory more = Transfer(t.nonce, t.kind, t.recipient, t.amount + 1);
        vm.expectRevert(GatewayBase.InvalidProof.selector);
        bGw.finalize(more, "");

        Transfer memory other = Transfer(t.nonce, t.kind, alice, t.amount);
        vm.expectRevert(GatewayBase.InvalidProof.selector);
        bGw.finalize(other, "");

        Transfer memory future = Transfer(t.nonce + 1, t.kind, bob, t.amount);
        vm.expectRevert(GatewayBase.InvalidProof.selector);
        bGw.finalize(future, "");

        // nothing was ever committed on BSC
        Transfer memory ghost = Transfer(0, Transfers.BNB_TO_PORTALDOT, bob, 1e18);
        vm.expectRevert(GatewayBase.InvalidProof.selector);
        pGw.finalize(ghost, "");

        // the real one still goes through
        bGw.finalize(t, "");
    }

    /// A different app writing the gateway's appKey into the same Outbox lands under its own key.
    function test_outboxKeyNamespacing() public {
        Spoofer s = new Spoofer();
        Transfer memory fake = Transfer(0, Transfers.POT_TO_BSC, alice, 1_000e18);
        s.spoof(outboxP, 0, keccak256(abi.encode(fake)));
        assertEq(outboxP.commitments(_key(address(s), 0)), keccak256(abi.encode(fake)));
        assertEq(outboxP.commitments(_key(address(pGw), 0)), bytes32(0));

        vm.expectRevert(GatewayBase.InvalidProof.selector);
        bGw.finalize(fake, "");

        // the gateway's own nonce 0 is unaffected
        Transfer memory real = _lockPOT(bob, 1e18, bob);
        assertEq(real.nonce, 0);
        bGw.finalize(real, "");
        assertEq(ppot.balanceOf(alice), 0);
        assertEq(ppot.balanceOf(bob), real.amount);
    }

    /// msg.value on revive is 18-decimal (1 tPOT = 1e18). pPOT is 18-decimal. No scaling anywhere.
    function test_decimalsRoundTrip() public {
        Transfer memory out = _lockPOT(alice, 1e18, bob);
        assertEq(out.amount, 1e18 - 1e15); // 10 bps fee, nothing else
        bGw.finalize(out, "");
        assertEq(ppot.balanceOf(bob), 999e15);

        uint256 before = alice.balance;
        Transfer memory back = _burnPPOT(bob, 999e15, alice);
        pGw.finalize(back, "");
        assertEq(alice.balance - before, 999e15);
        assertEq(ppot.totalSupply(), 0);
        assertEq(pGw.lockedPOT(), 0);
        assertEq(address(pGw).balance, 1e15); // only the fee stays, in the gas pool
        assertEq(pGw.gasPool(), 1e15);
    }

    function testFuzz_decimalsRoundTrip(uint96 raw) public {
        uint256 value = bound(uint256(raw), 1e4, 1e27);
        value -= value % 1e4; // native tPOT has 14 decimals: wei-units come in steps of 1e4
        Transfer memory out = _lockPOT(alice, value, bob);
        assertEq(out.amount + _fee(value), value);
        assertEq(out.amount % 1e4, 0);
        bGw.finalize(out, "");
        assertEq(ppot.balanceOf(bob), out.amount);

        uint256 before = alice.balance;
        pGw.finalize(_burnPPOT(bob, out.amount, alice), "");
        assertEq(alice.balance - before, out.amount);
        assertEq(pGw.lockedPOT(), 0);
        assertEq(address(pGw).balance, _fee(value));
    }

    /// Sub-1e4 wei-units can't be paid out as native tPOT, so they can't be burned either.
    function test_burnPPOTRejectsDust() public {
        Transfer memory t = _lockPOT(alice, 1e18, bob);
        bGw.finalize(t, "");
        vm.prank(bob);
        vm.expectRevert(BscGateway.Dust.selector);
        bGw.burnPPOT(1e18 - 1e15 - 1, alice);
    }

    function test_lockPOTRejectsDust() public {
        vm.deal(alice, 2e18);
        vm.prank(alice);
        vm.expectRevert(PortaldotGateway.Dust.selector);
        pGw.lockPOT{value: 1e18 + 1}(bob);
    }

    function test_releaseCannotExceedLocked() public {
        Transfer memory t = Transfer(55, Transfers.PPOT_TO_PORTALDOT, bob, 1e18);
        verP.setCommitment(_key(address(bGw), 55), keccak256(abi.encode(t)), true);
        pGw.donateGas{value: 5e18}();
        vm.expectRevert(PortaldotGateway.ExceedsLocked.selector);
        pGw.finalize(t, "");
        assertEq(pGw.gasPool(), 5e18);
    }

    function test_nativeReleaseToRejectingRecipientRevertsAndStaysRetryable() public {
        RejectingRecipient r = new RejectingRecipient();
        Transfer memory t1 = _lockPOT(alice, 1e18, bob);
        bGw.finalize(t1, "");
        Transfer memory t2 = _burnPPOT(bob, t1.amount, address(r));
        vm.expectRevert(GatewayBase.NativeTransferFailed.selector);
        pGw.finalize(t2, "");
        assertFalse(pGw.isFinalized(t2.nonce));
    }

    // ---------------------------------------------------------------- tBNB <-> BNB.b

    function test_bnbRoundTrip() public {
        vm.deal(bob, 1 ether); // not fresh: no gas drop
        Transfer memory t = _lockBNB(alice, 0.3 ether, bob);
        assertEq(address(bGw).balance, 0.3 ether);
        pGw.finalize(t, "");
        assertEq(bnbb.balanceOf(bob), 0.3 ether);
        assertEq(bob.balance, 1 ether);

        Transfer memory back = _burnBNBb(bob, 0.3 ether, alice);
        assertEq(bnbb.balanceOf(address(pGw)), BNBB_SUPPLY);
        uint256 before = alice.balance;
        bGw.finalize(back, "");
        assertEq(alice.balance - before, 0.3 ether);
        assertEq(address(bGw).balance, 0);
    }

    function test_gasDropFreshRecipient() public {
        pGw.donateGas{value: 2e18}();
        bnbb.setNonSufficient(true); // like the real asset: no credit to a non-existent account
        address fresh = makeAddr("fresh");
        assertEq(fresh.balance, 0);

        Transfer memory t = _lockBNB(alice, 0.002 ether, fresh);
        vm.expectEmit(address(pGw));
        emit PortaldotGateway.GasDropped(fresh, 0.5e18);
        pGw.finalize(t, "");

        assertEq(bnbb.balanceOf(fresh), 0.002 ether);
        assertEq(fresh.balance, 0.5e18);
        assertEq(pGw.gasPool(), 1.5e18);
    }

    function test_gasDropPoolEmpty() public {
        assertLt(pGw.gasPool(), 0.5e18);
        address fresh = makeAddr("fresh");
        Transfer memory t = _lockBNB(alice, 0.002 ether, fresh);
        pGw.finalize(t, "");
        assertEq(bnbb.balanceOf(fresh), 0.002 ether);
        assertEq(fresh.balance, 0);
    }

    function test_gasDropPoolJustShort() public {
        pGw.donateGas{value: 0.5e18 - 1e4}();
        address fresh = makeAddr("fresh");
        pGw.finalize(_lockBNB(alice, 0.002 ether, fresh), "");
        assertEq(bnbb.balanceOf(fresh), 0.002 ether);
        assertEq(fresh.balance, 0);
        assertEq(pGw.gasPool(), 0.5e18 - 1e4);
    }

    /// The pool is a separate bucket: a drop never spends locked tPOT.
    function test_gasDropNeverSpendsLockedPOT() public {
        _lockPOT(alice, 100e18, alice); // 99.9 locked, 0.1 in the pool
        assertEq(pGw.gasPool(), 0.1e18);
        address fresh = makeAddr("fresh");
        pGw.finalize(_lockBNB(alice, 0.002 ether, fresh), "");
        assertEq(fresh.balance, 0);
        assertEq(pGw.lockedPOT(), 99.9e18);
    }

    function test_gasDropSkippedForFundedRecipient() public {
        pGw.donateGas{value: 1e18}();
        vm.deal(bob, 1);
        pGw.finalize(_lockBNB(alice, 0.002 ether, bob), "");
        assertEq(bob.balance, 1);
        assertEq(pGw.gasPool(), 1e18);
    }

    function test_gasDropSkippedForContracts() public {
        pGw.donateGas{value: 1e18}();
        RejectingRecipient r = new RejectingRecipient();
        pGw.finalize(_lockBNB(alice, 0.002 ether, address(r)), "");
        assertEq(bnbb.balanceOf(address(r)), 0.002 ether);
        assertEq(pGw.gasPool(), 1e18);
    }

    /// Dust transfers don't qualify, so the pool can't be farmed with 1-wei locks.
    function test_gasDropNeedsMinimumAmount() public {
        pGw.donateGas{value: 1e18}();
        address fresh = makeAddr("fresh");
        pGw.finalize(_lockBNB(alice, 1e15 - 1, fresh), "");
        assertEq(fresh.balance, 0);
        assertEq(bnbb.balanceOf(fresh), 1e15 - 1);
        assertEq(pGw.gasPool(), 1e18);
    }

    function test_gasDropFailureIsIgnored() public {
        pGw.donateGas{value: 1e18}();
        address fresh = makeAddr("fresh");
        vm.mockCallRevert(fresh, 0.5e18, bytes(""), bytes("nope"));
        vm.etch(fresh, ""); // keep it looking like a plain account: the mock still intercepts the call
        assertEq(fresh.code.length, 0);
        pGw.finalize(_lockBNB(alice, 0.002 ether, fresh), "");
        assertEq(bnbb.balanceOf(fresh), 0.002 ether);
        assertEq(fresh.balance, 0);
        assertEq(pGw.gasPool(), 1e18);
    }

    /// Non-sufficient asset, empty pool, fresh account: the chain refuses the credit, the transfer
    /// stays unfinalized, and goes through once someone tops the pool up.
    function test_freshRecipientWaitsForGasPool() public {
        bnbb.setNonSufficient(true);
        address fresh = makeAddr("fresh");
        Transfer memory t = _lockBNB(alice, 0.002 ether, fresh);
        vm.expectRevert(MockAssetPrecompile.CannotCreate.selector);
        pGw.finalize(t, "");
        assertFalse(pGw.isFinalized(t.nonce));

        pGw.donateGas{value: 0.5e18}();
        pGw.finalize(t, "");
        assertEq(bnbb.balanceOf(fresh), 0.002 ether);
        assertEq(fresh.balance, 0.5e18);
    }

    function test_burnBNBbNeedsAllowance() public {
        bnbb.mint(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(MockAssetPrecompile.InsufficientAllowance.selector);
        pGw.burnBNBb(1e18, bob);
    }

    // ---------------------------------------------------------------- wiring and inputs

    function test_setRemoteOnce() public {
        PortaldotGateway g = new PortaldotGateway(outboxP, verP, BNBB);

        vm.prank(alice);
        vm.expectRevert(GatewayBase.NotDeployer.selector);
        g.setRemote(address(bGw));

        vm.expectRevert(GatewayBase.ZeroAddress.selector);
        g.setRemote(address(0));

        vm.expectEmit(address(g));
        emit GatewayBase.RemoteSet(address(bGw));
        g.setRemote(address(bGw));
        assertEq(g.remote(), address(bGw));

        vm.expectRevert(GatewayBase.RemoteAlreadySet.selector);
        g.setRemote(alice);
        assertEq(g.remote(), address(bGw));

        vm.expectRevert(GatewayBase.RemoteAlreadySet.selector);
        bGw.setRemote(alice);
    }

    function test_unwiredGatewayRefusesEverything() public {
        PortaldotGateway g = new PortaldotGateway(outboxP, verP, BNBB);
        vm.deal(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(GatewayBase.NotWired.selector);
        g.lockPOT{value: 1e18}(bob);

        Transfer memory t = Transfer(0, Transfers.BNB_TO_PORTALDOT, bob, 1);
        vm.expectRevert(GatewayBase.NotWired.selector);
        g.finalize(t, "");
    }

    function test_zeroInputsRevert() public {
        vm.expectRevert(GatewayBase.ZeroAddress.selector);
        pGw.lockPOT{value: 1e18}(address(0));
        vm.expectRevert(GatewayBase.ZeroAmount.selector);
        pGw.lockPOT{value: 0}(bob);
        vm.expectRevert(GatewayBase.ZeroAmount.selector);
        bGw.lockBNB{value: 0}(bob);
        vm.expectRevert(GatewayBase.ZeroAddress.selector);
        bGw.lockBNB{value: 1}(address(0));
        vm.expectRevert(GatewayBase.ZeroAmount.selector);
        bGw.burnPPOT(0, bob);
        vm.expectRevert(GatewayBase.ZeroAmount.selector);
        pGw.burnBNBb(0, bob);
    }

    function test_ppotOnlyGatewayMintsAndBurns() public {
        assertEq(ppot.gateway(), address(bGw));
        assertEq(ppot.decimals(), 18);
        assertEq(ppot.symbol(), "pPOT");
        vm.expectRevert(PPOT.NotGateway.selector);
        ppot.mint(alice, 1);
        vm.expectRevert(PPOT.NotGateway.selector);
        ppot.burn(alice, 1);
    }

    function test_bscGatewayChecksPpotBinding() public {
        PPOT wrong = new PPOT(alice);
        vm.expectRevert(BscGateway.PpotNotBound.selector);
        new BscGateway(outboxB, verB, wrong);
    }
}
