// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BscFixtures} from "../bsc-lib/BscFixtures.sol";
import {BscHeader, ParsedHeader} from "../../src/lib/bsc/BscHeader.sol";
import {ParliaClient} from "../../src/portaldot/ParliaClient.sol";

contract ParliaClientTest is BscFixtures {
    uint64 internal constant TRUSTING_PERIOD = 7 days;


    // ============================================================================================
    // Real BSC testnet data: epoch 140342000, where 0x76d7… left the set and 0x9040… joined.
    // ============================================================================================

    function test_finalizeRealEpochWindow() public {
        HeaderFixture memory real = _headers();
        ParliaClient lc = _realClient(real);
        bytes[] memory window = _slice(real.rlps, 0, 48);

        vm.expectEmit(address(lc));
        emit ParliaClient.Finalized(real.epoch, real.hashes[0]);
        vm.expectEmit(address(lc));
        emit ParliaClient.ValidatorSetUpdated(real.epoch, real.switchHeight, 9);
        uint64 n = lc.submitWindow(window);

        assertEq(n, real.epoch);
        ParliaClient.FinalizedHeader memory h = lc.finalized(real.epoch);
        assertEq(h.hash, real.hashes[0]);
        assertEq(h.number, real.epoch);
        assertEq(h.timestamp, real.timestamps[0]);
        assertEq(h.stateRoot, real.stateRoots[0]);
        assertEq(h.receiptsRoot, real.receiptsRoots[0]);

        (address[] memory vals, uint8 turnLength, uint64 epoch, uint64 activeFrom, uint64 epochTime) = lc.validatorSet();
        assertEq(vals.length, real.epochValidators.length);
        for (uint256 i = 0; i < vals.length; i++) {
            assertEq(vals[i], real.epochValidators[i]);
        }
        assertEq(turnLength, real.epochTurnLength);
        assertEq(epoch, real.epoch);
        assertEq(activeFrom, real.switchHeight);
        assertEq(activeFrom, real.epoch + 40, "9 validators, turnLength 8: the new set seals from E+40");
        assertEq(epochTime, real.timestamps[0]);
    }

    function test_realIncomingValidatorAfterRotation() public {
        HeaderFixture memory real = _headers();
        ParliaClient lc = _realClient(real);
        lc.submitWindow(_slice(real.rlps, 0, 48));
        // E+48 .. E+95 includes the first turn of the incoming validator (E+88 .. E+95).
        uint256 first = real.firstIncomingSeal - real.epoch;
        assertEq(first, 88);
        assertEq(real.miners[first], real.incoming);
        assertEq(lc.submitWindow(_slice(real.rlps, 48, 48)), real.epoch + 48);
    }

    function test_realIncomingRejectedBeforeRotation() public {
        HeaderFixture memory real = _headers();
        ParliaClient lc = _realClient(real);
        vm.expectRevert(
            abi.encodeWithSelector(ParliaClient.UnauthorizedSigner.selector, real.firstIncomingSeal, real.incoming)
        );
        lc.submitWindow(_slice(real.rlps, 48, 48));
    }

    function test_realSkipWindowAcrossUnprocessedEpoch() public {
        HeaderFixture memory real = _headers();
        // Epoch E is never submitted: block E+2 is finalized by the checkpoint set alone, because the
        // only post-switch sealer in the window (0x0826…, from E+40) belongs to both sets.
        ParliaClient lc = _realClient(real);
        assertEq(lc.submitWindow(_slice(real.rlps, 2, 48)), real.epoch + 2);
        assertEq(lc.finalized(real.epoch + 2).receiptsRoot, real.receiptsRoots[2]);
        (,, uint64 epoch,,) = lc.validatorSet();
        assertEq(epoch, real.checkpoint.epoch, "a window without an epoch block does not rotate");
    }

    function test_rejectsTooFewSigners() public {
        HeaderFixture memory real = _headers();
        ParliaClient lc = _realClient(real);
        // E+1 .. E+39: five turns, five distinct validators; six are needed.
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.TooFewSigners.selector, 5, 6));
        lc.submitWindow(_slice(real.rlps, 1, 39));
        // One more header brings in a sixth validator.
        assertEq(lc.submitWindow(_slice(real.rlps, 1, 40)), real.epoch + 1);
    }

    function test_rejectsNonValidatorSeal() public {
        HeaderFixture memory real = _headers();
        string memory syn = _syn();
        // Real headers against a set that is missing one of their sealers.
        CheckpointFixture memory cp = real.checkpoint;
        address dropped = real.miners[8];
        for (uint256 i = 0; i < cp.validators.length; i++) {
            if (cp.validators[i] == dropped) cp.validators[i] = address(0xdead);
        }
        ParliaClient lc = _deploy(real.chainId, real.epochLength, cp);
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.UnauthorizedSigner.selector, real.epoch + 8, dropped));
        lc.submitWindow(_slice(real.rlps, 1, 48));

        // A synthetic header sealed by a key outside the set.
        lc = _synthClient("A1000");
        vm.expectRevert(
            abi.encodeWithSelector(ParliaClient.UnauthorizedSigner.selector, 1120, vm.parseJsonAddress(syn, ".outsider"))
        );
        lc.submitWindow(_segment("outsider"));
    }

    function test_rejectsBrokenParentLink() public {
        HeaderFixture memory real = _headers();
        ParliaClient lc = _realClient(real);
        bytes[] memory w = _slice(real.rlps, 0, 49);
        // Drop E+10.
        bytes[] memory gap = new bytes[](48);
        for (uint256 i = 0; i < 48; i++) {
            gap[i] = w[i < 10 ? i : i + 1];
        }
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.BrokenLink.selector, real.epoch + 11));
        lc.submitWindow(gap);

        // Swap E+5 and E+6.
        bytes[] memory swapped = _slice(real.rlps, 0, 48);
        (swapped[5], swapped[6]) = (swapped[6], swapped[5]);
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.BrokenLink.selector, real.epoch + 6));
        lc.submitWindow(swapped);

        // A header from another chain spliced in at the right height.
        bytes[] memory foreign = _slice(real.rlps, 0, 48);
        foreign[20] = _segment("outsider")[0];
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.BrokenLink.selector, 1100));
        lc.submitWindow(foreign);
    }

    function test_rejectsWrongChainId() public {
        HeaderFixture memory real = _headers();
        ParliaClient lc = _deploy(56, real.epochLength, real.checkpoint);
        // Under chain id 56 the seal recovers to some unrelated address.
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.CoinbaseMismatch.selector, real.epoch));
        lc.submitWindow(_slice(real.rlps, 0, 48));
    }

    function test_previousSetProvesOlderBlocks() public {
        HeaderFixture memory real = _headers();
        ParliaClient lc = _realClient(real);
        lc.submitWindow(_slice(real.rlps, 0, 48));
        // E+2 is below the new set's first height (E+40): the previous set still checks it, and
        // the new set checks the part of the window from E+40 on.
        assertEq(lc.submitWindow(_slice(real.rlps, 2, 48)), real.epoch + 2);
        (address[] memory prev,, uint64 epoch, uint64 activeFrom,) = lc.previousValidatorSet();
        assertEq(epoch, real.checkpoint.epoch);
        assertEq(activeFrom, real.checkpoint.activeFrom);
        assertEq(prev.length, real.checkpoint.validators.length);
    }

    function test_previousSetStillRejectsOutgoingAfterSwitch() public {
        string memory syn = _syn();
        ParliaClient lc = _synthClient("A1000");
        lc.submitWindow(_segment("rotation"));
        // Under the previous set (A) for 4000..4039, under the current one (B) from 4040.
        vm.expectRevert(
            abi.encodeWithSelector(ParliaClient.UnauthorizedSigner.selector, 4040, vm.parseJsonAddress(syn, ".outgoing"))
        );
        lc.submitWindow(_segment("rotationOutgoingLate"));
        // A window entirely below 4040 is checked by A alone.
        assertEq(lc.submitWindow(_slice(_segment("gas"), 0, 16)), 1100);
    }

    function test_rejectsBeforeTrustedSet() public {
        // Below the checkpoint set's first height, with no previous set.
        ParliaClient lc = _synthClient("A3000");
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.BeforeTrustedSet.selector, 1100, 3040));
        lc.submitWindow(_slice(_segment("gas"), 0, 16));

        // After two rotations the set trusted for 1100 is gone.
        lc = _synthClient("A1000");
        lc.submitWindow(_segment("rotation")); // 4000: A -> B
        lc.submitWindow(_segment("skipEpoch")); // 5000: B -> A
        (,, uint64 prevEpoch, uint64 prevFrom,) = lc.previousValidatorSet();
        assertEq(prevEpoch, 4000);
        assertEq(prevFrom, 4040);
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.BeforeTrustedSet.selector, 1100, 4040));
        lc.submitWindow(_slice(_segment("gas"), 0, 16));
    }

    function test_rejectsResubmission() public {
        HeaderFixture memory real = _headers();
        ParliaClient lc = _realClient(real);
        lc.submitWindow(_slice(real.rlps, 2, 48));
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.AlreadyFinalized.selector, real.epoch + 2));
        lc.submitWindow(_slice(real.rlps, 2, 48));
    }

    function test_rejectsEmptyWindow() public {
        ParliaClient lc = _realClient(_headers());
        vm.expectRevert(ParliaClient.EmptyWindow.selector);
        lc.submitWindow(new bytes[](0));
    }

    function test_finalizedRevertsWhenUnknown() public {
        HeaderFixture memory real = _headers();
        ParliaClient lc = _realClient(real);
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.NotFinalized.selector, real.epoch));
        lc.finalized(real.epoch);
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.NotFinalized.selector, 0));
        lc.finalized(0);
    }

    // ============================================================================================
    // Synthetic chains (test keys, chain id 9797): rotation edges, skipping and expiry.
    // ============================================================================================

    function test_rotationSwitchHeight() public {
        string memory syn = _syn();
        ParliaClient lc = _synthClient("A3000");
        bytes[] memory w = _segment("rotation");
        uint256 chainId = vm.parseJsonUint(syn, ".chainId");
        // E + checkLen = 4039 is still sealed by the old set (here by the outgoing validator) and
        // E + checkLen + 1 = 4040 already by the new one (here by the incoming validator).
        assertEq(BscHeader.parse(w[39], chainId).signer, vm.parseJsonAddress(syn, ".outgoing"));
        assertEq(BscHeader.parse(w[40], chainId).signer, vm.parseJsonAddress(syn, ".incoming"));

        assertEq(lc.submitWindow(w), 4000);
        (address[] memory vals,, uint64 epoch, uint64 activeFrom,) = lc.validatorSet();
        assertEq(epoch, 4000);
        assertEq(activeFrom, 4040);
        _assertSet(vals, ".sets.B");

        // The incoming validator one block early is rejected.
        lc = _synthClient("A3000");
        vm.expectRevert(
            abi.encodeWithSelector(ParliaClient.UnauthorizedSigner.selector, 4039, vm.parseJsonAddress(syn, ".incoming"))
        );
        lc.submitWindow(_segment("rotationIncomingEarly"));
    }

    function test_outgoingValidatorRejectedAfterSwitch() public {
        string memory syn = _syn();
        address outgoing = vm.parseJsonAddress(syn, ".outgoing");
        // Inside the epoch window: one block after the switch.
        ParliaClient lc = _synthClient("A3000");
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.UnauthorizedSigner.selector, 4040, outgoing));
        lc.submitWindow(_segment("rotationOutgoingLate"));

        // After the rotation: any later window it seals.
        lc.submitWindow(_segment("rotation"));
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.UnauthorizedSigner.selector, 4200, outgoing));
        lc.submitWindow(_segment("afterRotationOutgoing"));

        // The incoming validator counts towards the quorum of the new set.
        assertEq(lc.submitWindow(_segment("afterRotation")), 4100);
    }

    function test_skipEpochsWithinTrustingPeriod() public {
        string memory syn = _syn();
        ParliaClient lc = _synthClient("A1000");
        // No epoch block in the window: epochs 2000, 3000 and 4000 are skipped.
        assertEq(lc.submitWindow(_segment("skip")), 4500);
        (,, uint64 epoch,,) = lc.validatorSet();
        assertEq(epoch, 1000);

        // Epoch 5000 submitted straight after the checkpoint at 1000 becomes the trusted epoch.
        assertEq(lc.submitWindow(_segment("skipEpoch")), 5000);
        (address[] memory vals,, uint64 epoch2, uint64 activeFrom, uint64 epochTime) = lc.validatorSet();
        assertEq(epoch2, 5000);
        assertEq(activeFrom, 5040);
        assertEq(epochTime, vm.parseJsonUint(syn, ".t0") + 5000);
        _assertSet(vals, ".sets.A");
    }

    function test_rejectAfterTrustingPeriod() public {
        string memory syn = _syn();
        ParliaClient lc = _synthClient("A1000");
        bytes[] memory s = _segment("expiry");
        uint64 deadline = uint64(vm.parseJsonUint(syn, ".t0") + 1000 + TRUSTING_PERIOD);
        // headers[0] one second past checkpoint time + trusting period.
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.TrustingPeriodExpired.selector, deadline + 1, deadline));
        lc.submitWindow(_slice(s, 1, 48));
        // Exactly at the deadline is still accepted.
        assertEq(lc.submitWindow(_slice(s, 0, 48)), 1000 + TRUSTING_PERIOD);
    }

    function test_rotationAfterSkippedEpochs() public {
        // The checkpoint is at 1000; the set changes at 4000, which is submitted directly.
        ParliaClient lc = _synthClient("A1000");
        assertEq(lc.submitWindow(_segment("rotation")), 4000);
        (address[] memory vals,, uint64 epoch, uint64 activeFrom,) = lc.validatorSet();
        assertEq(epoch, 4000);
        assertEq(activeFrom, 4040);
        _assertSet(vals, ".sets.B");
        assertEq(lc.submitWindow(_segment("afterRotation")), 4100);
    }

    function test_windowFailsWhenSetChangedTooMuch() public {
        string memory syn = _syn();
        ParliaClient lc = _synthClient("A1000");
        // Epoch 2000 replaced four of nine. A window sealed by the new set cannot be checked
        // against the old one…
        address newcomer = BscHeader.parse(_segment("tooMuchAfter")[0], vm.parseJsonUint(syn, ".chainId")).signer;
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.UnauthorizedSigner.selector, 2100, newcomer));
        lc.submitWindow(_segment("tooMuchAfter"));

        // …so the relayer submits the epoch that changed it, then the same window passes.
        assertEq(lc.submitWindow(_segment("tooMuchEpoch")), 2000);
        (address[] memory vals,,,,) = lc.validatorSet();
        _assertSet(vals, ".sets.C");
        assertEq(lc.submitWindow(_segment("tooMuchAfter")), 2100);
    }

    function test_rejectsSelfCertifiedEpoch() public {
        // A forged epoch block announcing an attacker set, sealed by five trusted validators (one
        // short of quorum) and then by six attacker keys. Only trusted signers count.
        ParliaClient lc = _synthClient("A1000");
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.TooFewSigners.selector, 5, 6));
        lc.submitWindow(_segment("selfCertified"));
    }

    function test_rejectsCoinbaseMismatch() public {
        ParliaClient lc = _synthClient("A1000");
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.CoinbaseMismatch.selector, 1110));
        lc.submitWindow(_segment("coinbaseMismatch"));
    }

    function test_rejectsMalleatedSeal() public {
        ParliaClient lc = _synthClient("A1000");
        vm.expectRevert(BscHeader.InvalidSignature.selector);
        lc.submitWindow(_segment("highS"));
    }

    function test_ringOverwrite() public {
        ParliaClient lc = _synthClient("A1000");
        assertEq(lc.RING_SIZE(), 256);
        bytes[] memory a = _slice(_segment("gas"), 0, 16);
        bytes[] memory b = _segment("ring");

        lc.submitWindow(a);
        assertEq(lc.finalized(1100).hash, keccak256(a[0]));

        // 1356 = 1100 + 256 takes the same slot.
        lc.submitWindow(b);
        assertEq(lc.finalized(1356).hash, keccak256(b[0]));
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.NotFinalized.selector, 1100));
        lc.finalized(1100);

        // An evicted header can be finalized again.
        lc.submitWindow(a);
        assertEq(lc.finalized(1100).hash, keccak256(a[0]));
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.NotFinalized.selector, 1356));
        lc.finalized(1356);
    }

    // ---- constructor ----

    function test_constructorRejectsBadCheckpoint() public {
        HeaderFixture memory real = _headers();
        CheckpointFixture memory cp = _headers().checkpoint;

        cp.epoch += 1;
        vm.expectRevert(ParliaClient.InvalidCheckpoint.selector);
        _deploy(real.chainId, real.epochLength, cp);

        cp = _headers().checkpoint;
        cp.activeFrom = cp.epoch;
        vm.expectRevert(ParliaClient.InvalidCheckpoint.selector);
        _deploy(real.chainId, real.epochLength, cp);
        cp.activeFrom = cp.epoch + real.epochLength;
        vm.expectRevert(ParliaClient.InvalidCheckpoint.selector);
        _deploy(real.chainId, real.epochLength, cp);

        cp = _headers().checkpoint;
        cp.turnLength = 0;
        vm.expectRevert(ParliaClient.InvalidValidatorSet.selector);
        _deploy(real.chainId, real.epochLength, cp);

        cp = _headers().checkpoint;
        cp.validators = new address[](0);
        vm.expectRevert(ParliaClient.InvalidValidatorSet.selector);
        _deploy(real.chainId, real.epochLength, cp);

        // A set whose switch would not fit inside an epoch (offset 40, epoch length 40).
        cp = _headers().checkpoint;
        cp.activeFrom = cp.epoch + 1;
        vm.expectRevert(ParliaClient.InvalidValidatorSet.selector);
        _deploy(real.chainId, 40, _alignedTo40(cp));

        cp = _headers().checkpoint;
        vm.expectRevert(ParliaClient.InvalidCheckpoint.selector);
        new ParliaClient(real.chainId, real.epochLength, 0, _toCheckpoint(cp));
        vm.expectRevert(ParliaClient.InvalidCheckpoint.selector);
        new ParliaClient(0, real.epochLength, TRUSTING_PERIOD, _toCheckpoint(cp));
    }

    function _alignedTo40(CheckpointFixture memory c) internal pure returns (CheckpointFixture memory) {
        c.epoch = 40 * 1000;
        c.activeFrom = c.epoch + 1;
        return c;
    }

    // ---- helpers ----

    function _toCheckpoint(CheckpointFixture memory c) internal pure returns (ParliaClient.Checkpoint memory) {
        return ParliaClient.Checkpoint({
            epoch: c.epoch,
            timestamp: c.timestamp,
            activeFrom: c.activeFrom,
            turnLength: c.turnLength,
            validators: c.validators
        });
    }

    function _deploy(uint256 chainId, uint64 epochLength, CheckpointFixture memory c) internal returns (ParliaClient) {
        return new ParliaClient(chainId, epochLength, TRUSTING_PERIOD, _toCheckpoint(c));
    }

    function _realClient(HeaderFixture memory real) internal returns (ParliaClient) {
        return _deploy(real.chainId, real.epochLength, real.checkpoint);
    }

    function _synthClient(string memory checkpoint) internal returns (ParliaClient) {
        string memory syn = _syn();
        return new ParliaClient(
            vm.parseJsonUint(syn, ".chainId"),
            uint64(vm.parseJsonUint(syn, ".epochLength")),
            uint64(vm.parseJsonUint(syn, ".trustingPeriod")),
            _toCheckpoint(_checkpoint(syn, string.concat(".checkpoints.", checkpoint)))
        );
    }

    function _syn() internal view returns (string memory) {
        return _fixture("bsc-synthetic.json");
    }

    function _segment(string memory name) internal view returns (bytes[] memory) {
        string memory syn = _syn();
        return vm.parseJsonBytesArray(syn, string.concat(".segments.", name, ".rlps"));
    }

    function _assertSet(address[] memory got, string memory path) internal view {
        string memory syn = _syn();
        address[] memory want = vm.parseJsonAddressArray(syn, path);
        assertEq(got.length, want.length);
        for (uint256 i = 0; i < want.length; i++) {
            assertEq(got[i], want[i]);
        }
    }
}
