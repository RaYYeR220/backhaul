// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BscFixtures} from "../bsc-lib/BscFixtures.sol";
import {EthProofs} from "../../src/lib/bsc/EthProofs.sol";
import {BscFeed} from "../../src/portaldot/BscFeed.sol";
import {BscVerifier} from "../../src/portaldot/BscVerifier.sol";
import {ParliaClient} from "../../src/portaldot/ParliaClient.sol";

/// @dev Chainlink BNB/USD on BSC testnet (bsc-feed.json, from packages/sdk/scripts/fixtures-bsc-feed.ts):
///      three real snapshots of the proxy and its OCR1 aggregator, each with the header window that
///      finalizes its block. `a` and `aLater` hold the same round, `b` a later one.
contract BscFeedTest is BscFixtures {
    struct Snap {
        uint64 blockNumber;
        bytes[] proxyAccountProof;
        bytes[] phaseProof;
        bytes[] aggregatorAccountProof;
        bytes[] hotVarsProof;
        bytes[] transmissionProof;
        bytes[] rlps;
        uint80 roundId;
        int256 answer;
        uint256 updatedAt;
    }

    string internal f;
    ParliaClient internal lc;
    BscVerifier internal verifier;
    BscFeed internal feed;

    function setUp() public {
        f = _fixture("bsc-feed.json");
        CheckpointFixture memory c = _checkpoint(f, ".checkpoint");
        lc = new ParliaClient(97, 1000, 7 days, ParliaClient.Checkpoint(c.epoch, c.timestamp, c.activeFrom, c.turnLength, c.validators));
        verifier = new BscVerifier(lc, address(1));
        feed = new BscFeed(verifier, vm.parseJsonAddress(f, ".proxy"), uint8(vm.parseJsonUint(f, ".decimals")));
    }

    function test_updateFromRealProofs() public {
        Snap memory a = _finalized(".a");
        vm.expectEmit(address(feed));
        emit BscFeed.AnswerUpdated(a.answer, a.roundId, a.updatedAt, a.blockNumber);
        assertEq(_update(a), a.roundId);

        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        assertEq(roundId, a.roundId, "proxy numbering: phase << 64 | aggregator round");
        assertEq(roundId >> 64, vm.parseJsonUint(f, ".a.phaseId"));
        assertEq(answer, a.answer);
        assertGt(answer, 0);
        assertEq(startedAt, a.updatedAt);
        assertEq(updatedAt, a.updatedAt);
        assertEq(answeredInRound, a.roundId);
        assertEq(feed.provenAtBscBlock(), a.blockNumber);
        assertEq(feed.decimals(), 8);
        assertEq(feed.version(), 4);

        (uint80 r2,,,,) = feed.getRoundData(a.roundId);
        assertEq(r2, a.roundId);
        vm.expectRevert(BscFeed.NoData.selector);
        feed.getRoundData(a.roundId - 1);
    }

    function test_newerRoundReplacesOlder() public {
        Snap memory a = _finalized(".a");
        _update(a);
        // b is 3840 = 15 × 256 blocks later: its header takes a's ring slot, after a's round is stored.
        Snap memory b = _finalized(".b");
        assertGt(b.roundId, a.roundId);
        assertEq(_update(b), b.roundId);
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(roundId, b.roundId);
        assertEq(answer, b.answer);
        assertEq(updatedAt, b.updatedAt);
        assertEq(feed.provenAtBscBlock(), b.blockNumber);
    }

    function test_rejectsOlderRound() public {
        Snap memory a = _finalized(".a");
        Snap memory b = _finalized(".b");
        _update(b);
        // An older block, holding an older round.
        vm.expectRevert(abi.encodeWithSelector(BscFeed.StaleBlock.selector, a.blockNumber, b.blockNumber));
        _update(a);
    }

    function test_rejectsReplayedRound() public {
        Snap memory a = _finalized(".a");
        Snap memory aLater = _finalized(".aLater");
        assertGt(aLater.blockNumber, a.blockNumber);
        assertEq(aLater.roundId, a.roundId);
        _update(a);
        // The same proof again.
        vm.expectRevert(abi.encodeWithSelector(BscFeed.StaleBlock.selector, a.blockNumber, a.blockNumber));
        _update(a);
        // The same round proven again from a later block.
        vm.expectRevert(abi.encodeWithSelector(BscFeed.StaleRound.selector, a.roundId, a.roundId));
        _update(aLater);
    }

    function test_rejectsWrongAccount() public {
        Snap memory a = _finalized(".a");
        // The proxy's account proof where the aggregator's belongs: the aggregator's key does not
        // lead through it.
        vm.expectRevert();
        feed.update(a.blockNumber, a.proxyAccountProof, a.phaseProof, a.proxyAccountProof, a.hotVarsProof, a.transmissionProof);

        // A feed bound to another proxy address: the proven account is not that proxy.
        BscFeed other = new BscFeed(verifier, address(0xB0B), 8);
        vm.expectRevert();
        other.update(a.blockNumber, a.proxyAccountProof, a.phaseProof, a.aggregatorAccountProof, a.hotVarsProof, a.transmissionProof);
    }

    function test_rejectsTamperedSlot() public {
        Snap memory a = _finalized(".a");
        // A changed byte in the transmission leaf: its parent no longer points at it.
        bytes[] memory t = _copy(a.transmissionProof);
        bytes memory leaf = t[t.length - 1];
        leaf[leaf.length - 1] = bytes1(uint8(leaf[leaf.length - 1]) ^ 0x01);
        vm.expectRevert(EthProofs.IncompleteProof.selector);
        feed.update(a.blockNumber, a.proxyAccountProof, a.phaseProof, a.aggregatorAccountProof, a.hotVarsProof, t);

        // A changed hot-vars node.
        bytes[] memory h = _copy(a.hotVarsProof);
        h[0][7] = bytes1(uint8(h[0][7]) ^ 0x01);
        vm.expectRevert(EthProofs.IncompleteProof.selector);
        feed.update(a.blockNumber, a.proxyAccountProof, a.phaseProof, a.aggregatorAccountProof, h, a.transmissionProof);

        // The hot-vars proof in place of the transmission's: the slot it proves is not the round's.
        vm.expectRevert();
        feed.update(a.blockNumber, a.proxyAccountProof, a.phaseProof, a.aggregatorAccountProof, a.hotVarsProof, a.hotVarsProof);

        // Proofs from another block against this one's state root.
        Snap memory b = _snap(".b");
        vm.expectRevert();
        feed.update(a.blockNumber, b.proxyAccountProof, b.phaseProof, b.aggregatorAccountProof, b.hotVarsProof, b.transmissionProof);
    }

    function test_rejectsUnfinalizedBlock() public {
        Snap memory a = _snap(".a");
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.NotFinalized.selector, a.blockNumber));
        _update(a);
    }

    function test_noDataBeforeFirstUpdate() public {
        vm.expectRevert(BscFeed.NoData.selector);
        feed.latestRoundData();
        assertEq(feed.provenAtBscBlock(), 0);
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(BscFeed.ZeroAddress.selector);
        new BscFeed(BscVerifier(address(0)), address(1), 8);
        vm.expectRevert(BscFeed.ZeroAddress.selector);
        new BscFeed(verifier, address(0), 8);
    }

    function test_fixtureLayout() public view {
        // The aggregator the proven phase slot points at is the one the fixture recorded.
        Snap memory a = _snap(".a");
        assertEq(vm.parseJsonUint(f, ".slots.proxyPhase"), 2);
        assertEq(vm.parseJsonUint(f, ".slots.hotVars"), 43);
        assertEq(vm.parseJsonUint(f, ".slots.transmissions"), 44);
        assertEq(uint256(a.roundId) & type(uint32).max, vm.parseJsonUint(f, ".a.aggregatorRound"));
    }

    // ---- helpers ----

    function _snap(string memory at) internal view returns (Snap memory s) {
        s.blockNumber = uint64(vm.parseJsonUint(f, string.concat(at, ".blockNumber")));
        s.proxyAccountProof = vm.parseJsonBytesArray(f, string.concat(at, ".proxyAccountProof"));
        s.phaseProof = vm.parseJsonBytesArray(f, string.concat(at, ".phaseProof"));
        s.aggregatorAccountProof = vm.parseJsonBytesArray(f, string.concat(at, ".aggregatorAccountProof"));
        s.hotVarsProof = vm.parseJsonBytesArray(f, string.concat(at, ".hotVarsProof"));
        s.transmissionProof = vm.parseJsonBytesArray(f, string.concat(at, ".transmissionProof"));
        s.rlps = vm.parseJsonBytesArray(f, string.concat(at, ".rlps"));
        s.roundId = uint80(vm.parseJsonUint(f, string.concat(at, ".roundId")));
        s.answer = vm.parseJsonInt(f, string.concat(at, ".answer"));
        s.updatedAt = vm.parseJsonUint(f, string.concat(at, ".updatedAt"));
    }

    /// @dev The snapshot with its block finalized on the light client.
    function _finalized(string memory at) internal returns (Snap memory s) {
        s = _snap(at);
        assertEq(lc.submitWindow(s.rlps), s.blockNumber);
        assertEq(lc.finalized(s.blockNumber).stateRoot, vm.parseJsonBytes32(f, string.concat(at, ".stateRoot")));
    }

    function _update(Snap memory s) internal returns (uint80) {
        return feed.update(s.blockNumber, s.proxyAccountProof, s.phaseProof, s.aggregatorAccountProof, s.hotVarsProof, s.transmissionProof);
    }

    function _copy(bytes[] memory p) internal pure returns (bytes[] memory out) {
        out = new bytes[](p.length);
        for (uint256 i = 0; i < p.length; i++) {
            out[i] = bytes.concat(p[i]);
        }
    }
}
