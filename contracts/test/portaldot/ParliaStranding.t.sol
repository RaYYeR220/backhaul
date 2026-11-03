// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BscHeader} from "../../src/lib/bsc/BscHeader.sol";
import {BscVerifier} from "../../src/portaldot/BscVerifier.sol";
import {ParliaClient} from "../../src/portaldot/ParliaClient.sol";
import {ParliaSynth} from "./ParliaSynth.sol";

/// Rotations and ring evictions that anyone can trigger with real headers must not take a
/// commitment away from the jobs waiting on it: the block that emitted it may become impossible to
/// finalize, but the Outbox's storage at any later finalized block still proves it.
contract ParliaStrandingTest is ParliaSynth {
    /// Two rotations by anyone, then a ring collision: the emitting block is gone from the ring and
    /// below every set the client holds, so its receipt can never be proven again. The commitment
    /// still is, from storage at a later block.
    function test_twoRotationsAndEvictionLeaveCommitmentProvable() public {
        ParliaClient lc = _client();
        BscVerifier v = new BscVerifier(lc, _outbox());
        uint64 b = 1500; // the block holding the Committed log of key1

        // The relayer finalized b, but the job that proves the commitment has not run yet.
        lc.submitWindow(_segment(b, 48, false));
        // Anyone: two rotations with real epoch windows, then b + 3·256, which takes b's ring slot.
        lc.submitWindow(_segment(2000, 56, true));
        lc.submitWindow(_segment(3000, 48, true));
        lc.submitWindow(_segment(b + 768, 48, false));

        vm.expectRevert(abi.encodeWithSelector(ParliaClient.NotFinalized.selector, b));
        lc.finalized(b);
        bytes[] memory again = _segment(b, 48, false);
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.BeforeTrustedSet.selector, b, 2040));
        lc.submitWindow(again);
        bytes memory receipt = bytes.concat(bytes1(v.RECEIPT_PROOF()), abi.encode(b, _receiptKey(), _receiptNodes(), uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.NotFinalized.selector, b));
        v.verifyCommitment(_key1(), _value1(), receipt);

        // The Outbox is write-once, so any later finalized block proves the commitment.
        _assertProvableFromStorageAt(lc, v, 3100);
    }

    /// A block below the current set that verified before a rotation still verifies after it,
    /// even though its window holds the seal of a validator the stale set does not know.
    function test_rotationDoesNotStrandBlockUnderPreviousSet() public {
        ParliaClient lc = _client();
        uint64 b = 2900; // after the live swap at 2000; the client still trusts S

        uint256 snap = vm.snapshotState();
        assertEq(lc.submitWindow(_segment(b, 56, false)), b, "plain window passes over X's seals");
        vm.revertToState(snap);

        // Anyone rotates straight to epoch 3000 (S still seals six distinct turns from 3000).
        lc.submitWindow(_segment(3000, 48, true));
        (,, uint64 epoch, uint64 activeFrom,,) = lc.validatorSet();
        assertEq(epoch, 3000);
        assertEq(activeFrom, 3040);

        // b is now checked by the previous set (S), which passes over X's seal at 2904 as well.
        bytes[] memory w = _segment(b, 56, false);
        assertEq(BscHeader.parse(w[4], CHAIN_ID).signer, vm.addr(PK_X));
        assertEq(lc.submitWindow(w), b);
        assertEq(lc.finalized(b).hash, keccak256(w[0]));

        // And whatever happens to b later, a later block proves the commitment from storage.
        _assertProvableFromStorageAt(lc, new BscVerifier(lc, _outbox()), 3100);
    }

    /// Finalizes block `n` (a plain window under the current set) with the Outbox state as its
    /// stateRoot, and proves commitments[key1] = value1 from it.
    function _assertProvableFromStorageAt(ParliaClient lc, BscVerifier v, uint64 n) internal {
        string memory syn = _syn();
        (rootAt, rootOverride) = (n, vm.parseJsonBytes32(syn, ".verifier.stateRoot"));
        assertEq(lc.submitWindow(_segment(n, 48, false)), n);
        assertEq(lc.finalized(n).stateRoot, rootOverride);
        bytes memory proof = bytes.concat(
            bytes1(v.STORAGE_PROOF()),
            abi.encode(n, vm.parseJsonBytesArray(syn, ".verifier.accountProof"), vm.parseJsonBytesArray(syn, ".verifier.presentProof"))
        );
        assertTrue(v.verifyCommitment(_key1(), _value1(), proof), "commitment proven from a later block");
        assertFalse(v.verifyCommitment(_key1(), keccak256("another value"), proof));
    }
}
