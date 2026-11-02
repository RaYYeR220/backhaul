// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BscFixtures} from "../bsc-lib/BscFixtures.sol";
import {BscVerifier} from "../../src/portaldot/BscVerifier.sol";
import {ParliaClient} from "../../src/portaldot/ParliaClient.sol";
import {IRemoteVerifier} from "../../src/interfaces/IRemoteVerifier.sol";

/// @dev BscVerifier that matches another event topic, so a real BSC log of the same shape as
///      Committed(bytes32 indexed, bytes32) can drive the full verifyCommitment path.
contract BscVerifierHarness is BscVerifier {
    bytes32 private immutable topic;

    constructor(ParliaClient lc, address outbox, bytes32 topic_) BscVerifier(lc, outbox) {
        topic = topic_;
    }

    function _committedTopic() internal view override returns (bytes32) {
        return topic;
    }
}

contract BscVerifierTest is BscFixtures {
    uint64 internal constant TRUSTING_PERIOD = 7 days;

    // ============================================================================================
    // Real BSC testnet receipt and storage proofs
    // ============================================================================================

    function test_commitmentFromRealReceipt() public {
        HeaderFixture memory real = _headers();
        string memory r = _fixture("bsc-receipt.json");
        ParliaClient lc = _client(real.chainId, real.epochLength, real.checkpoint);
        uint64 blockNumber = uint64(vm.parseJsonUint(r, ".blockNumber"));
        assertEq(blockNumber, real.epoch + 2);
        lc.submitWindow(_slice(real.rlps, 2, 48));

        address emitter = vm.parseJsonAddress(r, ".legacy.emitter");
        bytes32[] memory topics = vm.parseJsonBytes32Array(r, ".legacy.topics");
        bytes32 data = vm.parseJsonBytes32(r, ".legacy.data");
        bytes memory proof = _realReceiptProof(r, blockNumber);

        BscVerifierHarness v = new BscVerifierHarness(lc, emitter, topics[0]);
        assertTrue(v.verifyCommitment(topics[1], data, proof), "real log proves its own (key, value)");
        assertFalse(v.verifyCommitment(topics[1], bytes32(uint256(data) ^ 1), proof), "other value");
        assertFalse(v.verifyCommitment(bytes32(uint256(topics[1]) ^ 1), data, proof), "other key");

        // The production verifier only accepts the Committed topic.
        BscVerifier prod = new BscVerifier(lc, emitter);
        assertFalse(prod.verifyCommitment(topics[1], data, proof));
    }

    function test_rejectWrongEmitter() public {
        HeaderFixture memory real = _headers();
        string memory r = _fixture("bsc-receipt.json");
        ParliaClient lc = _client(real.chainId, real.epochLength, real.checkpoint);
        uint64 blockNumber = uint64(vm.parseJsonUint(r, ".blockNumber"));
        lc.submitWindow(_slice(real.rlps, 2, 48));
        bytes32[] memory topics = vm.parseJsonBytes32Array(r, ".legacy.topics");

        BscVerifierHarness v = new BscVerifierHarness(lc, address(0xB0B), topics[0]);
        assertFalse(v.verifyCommitment(topics[1], vm.parseJsonBytes32(r, ".legacy.data"), _realReceiptProof(r, blockNumber)));

        // Synthetic: a Committed event with the right topic from the wrong contract.
        string memory syn = _fixture("bsc-synthetic.json");
        BscVerifier sv = _synthVerifier(syn);
        assertFalse(
            sv.verifyCommitment(
                vm.parseJsonBytes32(syn, ".verifier.key3"),
                vm.parseJsonBytes32(syn, ".verifier.value3"),
                vm.parseJsonBytes(syn, ".verifier.encoded.impostor")
            )
        );
    }

    function test_absenceAfterDeadline() public {
        (BscVerifier v, uint64 timestamp, bytes32 key, bytes memory proof) = _realAbsence();
        assertTrue(v.verifyAbsence(key, timestamp, proof), "at the deadline");
        assertTrue(v.verifyAbsence(key, timestamp - 3600, proof), "well after it");
    }

    function test_absenceBeforeDeadlineFalse() public {
        (BscVerifier v, uint64 timestamp, bytes32 key, bytes memory proof) = _realAbsence();
        assertFalse(v.verifyAbsence(key, timestamp + 1, proof));
    }

    // ============================================================================================
    // Synthetic block with a real Outbox layout: Committed logs and commitments[key] at slot 0
    // ============================================================================================

    function test_commitmentFromSyntheticReceipt() public {
        string memory syn = _fixture("bsc-synthetic.json");
        BscVerifier v = _synthVerifier(syn);
        bytes32 key1 = vm.parseJsonBytes32(syn, ".verifier.key1");
        bytes32 value1 = vm.parseJsonBytes32(syn, ".verifier.value1");
        bytes memory p1 = vm.parseJsonBytes(syn, ".verifier.encoded.commitment1");

        assertTrue(v.verifyCommitment(key1, value1, p1), "legacy receipt, second log");
        assertTrue(
            v.verifyCommitment(
                vm.parseJsonBytes32(syn, ".verifier.key2"),
                vm.parseJsonBytes32(syn, ".verifier.value2"),
                vm.parseJsonBytes(syn, ".verifier.encoded.commitment2")
            ),
            "typed receipt"
        );
        assertFalse(v.verifyCommitment(key1, keccak256("another value"), p1), "wrong value");
        assertFalse(v.verifyCommitment(keccak256("another key"), value1, p1), "wrong key");

        // Pointing at the unrelated log in the same receipt.
        bytes[] memory nodes = vm.parseJsonBytesArray(syn, ".verifier.receipts[0].proof");
        bytes memory receiptKey = vm.parseJsonBytes(syn, ".verifier.receipts[0].key");
        assertFalse(v.verifyCommitment(key1, value1, abi.encode(uint64(1200), receiptKey, nodes, uint256(0))));
    }

    function test_absenceOfSyntheticSlot() public {
        string memory syn = _fixture("bsc-synthetic.json");
        BscVerifier v = _synthVerifier(syn);
        uint64 t = uint64(vm.parseJsonUint(syn, ".t0") + 1200);
        assertTrue(v.verifyAbsence(vm.parseJsonBytes32(syn, ".verifier.absentKey"), t, vm.parseJsonBytes(syn, ".verifier.encoded.absent")));
        assertFalse(v.verifyAbsence(vm.parseJsonBytes32(syn, ".verifier.absentKey"), t + 1, vm.parseJsonBytes(syn, ".verifier.encoded.absent")));
        // key1 is committed: its slot is present, so absence is false.
        assertFalse(v.verifyAbsence(vm.parseJsonBytes32(syn, ".verifier.key1"), t, vm.parseJsonBytes(syn, ".verifier.encoded.present")));
        assertEq(v.commitmentSlot(vm.parseJsonBytes32(syn, ".verifier.key1")), keccak256(abi.encode(vm.parseJsonBytes32(syn, ".verifier.key1"), uint256(0))));
    }

    function test_unfinalizedBlockReverts() public {
        string memory syn = _fixture("bsc-synthetic.json");
        BscVerifier v = new BscVerifier(_synthClient(syn), vm.parseJsonAddress(syn, ".verifier.outbox"));
        bytes memory p1 = vm.parseJsonBytes(syn, ".verifier.encoded.commitment1");
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.NotFinalized.selector, 1200));
        v.verifyCommitment(vm.parseJsonBytes32(syn, ".verifier.key1"), vm.parseJsonBytes32(syn, ".verifier.value1"), p1);
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.NotFinalized.selector, 1200));
        v.verifyAbsence(vm.parseJsonBytes32(syn, ".verifier.absentKey"), 0, vm.parseJsonBytes(syn, ".verifier.encoded.absent"));
    }

    function test_tamperedProofReverts() public {
        string memory syn = _fixture("bsc-synthetic.json");
        BscVerifier v = _synthVerifier(syn);
        bytes[] memory nodes = vm.parseJsonBytesArray(syn, ".verifier.receipts[0].proof");
        bytes memory leaf = nodes[nodes.length - 1];
        leaf[leaf.length - 1] = bytes1(uint8(leaf[leaf.length - 1]) ^ 0x01);
        bytes memory receiptKey = vm.parseJsonBytes(syn, ".verifier.receipts[0].key");
        vm.expectRevert();
        v.verifyCommitment(
            vm.parseJsonBytes32(syn, ".verifier.key1"),
            vm.parseJsonBytes32(syn, ".verifier.value1"),
            abi.encode(uint64(1200), receiptKey, nodes, uint256(1))
        );

        // An absence proof whose storage nodes do not hang from the account's storage root.
        bytes[] memory accountProof = vm.parseJsonBytesArray(syn, ".verifier.accountProof");
        bytes[] memory foreign = vm.parseJsonBytesArray(syn, ".verifier.receipts[1].proof");
        vm.expectRevert();
        v.verifyAbsence(vm.parseJsonBytes32(syn, ".verifier.absentKey"), 0, abi.encode(uint64(1200), accountProof, foreign));
    }

    function test_constructorRejectsZero() public {
        string memory syn = _fixture("bsc-synthetic.json");
        ParliaClient lc = _synthClient(syn);
        vm.expectRevert(BscVerifier.ZeroAddress.selector);
        new BscVerifier(ParliaClient(address(0)), address(1));
        vm.expectRevert(BscVerifier.ZeroAddress.selector);
        new BscVerifier(lc, address(0));
    }

    function test_isRemoteVerifier() public {
        string memory syn = _fixture("bsc-synthetic.json");
        IRemoteVerifier v = IRemoteVerifier(address(_synthVerifier(syn)));
        assertTrue(
            v.verifyCommitment(
                vm.parseJsonBytes32(syn, ".verifier.key1"),
                vm.parseJsonBytes32(syn, ".verifier.value1"),
                vm.parseJsonBytes(syn, ".verifier.encoded.commitment1")
            )
        );
    }

    // ---- helpers ----

    function _client(uint256 chainId, uint64 epochLength, CheckpointFixture memory c) internal returns (ParliaClient) {
        return new ParliaClient(
            chainId,
            epochLength,
            TRUSTING_PERIOD,
            ParliaClient.Checkpoint(c.epoch, c.timestamp, c.activeFrom, c.turnLength, c.validators)
        );
    }

    function _synthClient(string memory syn) internal returns (ParliaClient) {
        return new ParliaClient(
            vm.parseJsonUint(syn, ".chainId"),
            uint64(vm.parseJsonUint(syn, ".epochLength")),
            uint64(vm.parseJsonUint(syn, ".trustingPeriod")),
            _toCheckpoint(_checkpoint(syn, ".checkpoints.A1000"))
        );
    }

    function _toCheckpoint(CheckpointFixture memory c) internal pure returns (ParliaClient.Checkpoint memory) {
        return ParliaClient.Checkpoint(c.epoch, c.timestamp, c.activeFrom, c.turnLength, c.validators);
    }

    /// @dev Client with block 1200 (the synthetic Outbox block) finalized, and a verifier over it.
    function _synthVerifier(string memory syn) internal returns (BscVerifier) {
        ParliaClient lc = _synthClient(syn);
        lc.submitWindow(vm.parseJsonBytesArray(syn, ".segments.verifier.rlps"));
        return new BscVerifier(lc, vm.parseJsonAddress(syn, ".verifier.outbox"));
    }

    function _realReceiptProof(string memory r, uint64 blockNumber) internal pure returns (bytes memory) {
        return abi.encode(
            blockNumber,
            vm.parseJsonBytes(r, ".legacy.key"),
            vm.parseJsonBytesArray(r, ".legacy.proof"),
            vm.parseJsonUint(r, ".legacy.logIndex")
        );
    }

    /// @dev Real WBNB storage at a finalized BSC testnet block, with a key nobody committed.
    function _realAbsence() internal returns (BscVerifier v, uint64 timestamp, bytes32 key, bytes memory proof) {
        string memory s = _fixture("bsc-storage.json");
        ParliaClient lc = _client(
            vm.parseJsonUint(s, ".chainId"), uint64(vm.parseJsonUint(s, ".epochLength")), _checkpoint(s, ".checkpoint")
        );
        bytes[] memory rlps = vm.parseJsonBytesArray(s, ".rlps");
        uint64 blockNumber = uint64(vm.parseJsonUint(s, ".blockNumber"));
        assertEq(lc.submitWindow(_slice(rlps, 0, 48)), blockNumber);
        assertEq(lc.finalized(blockNumber).stateRoot, vm.parseJsonBytes32(s, ".stateRoot"));

        v = new BscVerifier(lc, vm.parseJsonAddress(s, ".account"));
        timestamp = uint64(vm.parseJsonUint(s, ".timestamp"));
        key = vm.parseJsonBytes32(s, ".absentKey");
        proof = abi.encode(blockNumber, vm.parseJsonBytesArray(s, ".accountProof"), vm.parseJsonBytesArray(s, ".absent.proof"));
    }
}
