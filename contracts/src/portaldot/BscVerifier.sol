// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRemoteVerifier} from "../interfaces/IRemoteVerifier.sol";
import {EthProofs} from "../lib/bsc/EthProofs.sol";
import {ParliaClient} from "./ParliaClient.sol";

/// @title BscVerifier
/// @notice Checks what the Outbox on BNB Smart Chain committed, against headers finalized by the
///         Parlia light client. A commitment is proven either from the Outbox's `Committed` event
///         in a receipt of the block that emitted it, or from the Outbox's storage at any finalized
///         block from then on: `commitments` is write-once, so a later state proves it just as
///         well, and no rotation or ring eviction can leave a commitment unprovable. Absence is
///         proven from the Outbox's storage. It also reads any BSC account's storage for other
///         contracts ({storageAt}, used by BscFeed). No owner, no configuration.
/// @dev Returns false when a well-formed proof shows something other than what is asked (another
///      emitter, topic, key or value; an absent or present slot; a header older than `notBefore`).
///      Reverts when the proof itself does not verify: block not finalized
///      ({ParliaClient.NotFinalized}), trie nodes that do not hang from the header root, bytes that
///      do not decode, or an unknown proof type.
contract BscVerifier is IRemoteVerifier {
    /// @notice Topic of `Committed(bytes32 indexed key, bytes32 value)`, emitted by the Outbox.
    bytes32 public constant COMMITTED_TOPIC = keccak256("Committed(bytes32,bytes32)");
    /// @notice First byte of a commitment proof: the `Committed` log, from a receipt proof.
    uint8 public constant RECEIPT_PROOF = 0x01;
    /// @notice First byte of a commitment proof: `commitments[key]`, from a storage proof.
    uint8 public constant STORAGE_PROOF = 0x02;

    /// @notice Light client whose finalized headers anchor every proof.
    ParliaClient public immutable lightClient;
    /// @notice Address of the Outbox on BSC.
    address public immutable remoteOutbox;

    error ZeroAddress();
    error UnknownProofType(uint8 proofType);

    constructor(ParliaClient lightClient_, address remoteOutbox_) {
        if (address(lightClient_) == address(0) || remoteOutbox_ == address(0)) revert ZeroAddress();
        lightClient = lightClient_;
        remoteOutbox = remoteOutbox_;
    }

    /// @inheritdoc IRemoteVerifier
    /// @dev proof = one type byte, then its ABI encoding:
    ///      - {RECEIPT_PROOF} ‖ abi.encode(uint64 blockNumber, bytes receiptKey, bytes[] receiptProof,
    ///        uint256 logIndex): the `logIndex`-th log of receipt `receiptKey` (RLP of the
    ///        transaction index) in finalized block `blockNumber` is `Committed(key, value)`
    ///        emitted by the remote Outbox. Only the emitting block can prove it.
    ///      - {STORAGE_PROOF} ‖ abi.encode(uint64 blockNumber, bytes[] accountProof, bytes[]
    ///        storageProof): the remote Outbox's slot {commitmentSlot}(key) holds `value` at
    ///        finalized block `blockNumber`, any block from the commitment on.
    function verifyCommitment(bytes32 key, bytes32 value, bytes calldata proof) external view returns (bool) {
        uint8 proofType = proof.length == 0 ? 0 : uint8(proof[0]);
        if (proofType == STORAGE_PROOF) {
            (uint64 n, bytes[] memory accountProof, bytes[] memory storageProof) =
                abi.decode(proof[1:], (uint64, bytes[], bytes[]));
            (bytes32 stored, bool exists) = EthProofs.storageAt(
                lightClient.finalized(n).stateRoot, remoteOutbox, accountProof, commitmentSlot(key), storageProof
            );
            return exists && value != bytes32(0) && stored == value;
        }
        if (proofType != RECEIPT_PROOF) revert UnknownProofType(proofType);
        (uint64 blockNumber, bytes memory receiptKey, bytes[] memory nodes, uint256 logIndex) =
            abi.decode(proof[1:], (uint64, bytes, bytes[], uint256));
        ParliaClient.FinalizedHeader memory header = lightClient.finalized(blockNumber);
        (address emitter, bytes32[] memory topics, bytes memory data) =
            EthProofs.receiptLog(header.receiptsRoot, receiptKey, nodes, logIndex);
        if (emitter != remoteOutbox || topics.length != 2 || data.length != 32) return false;
        if (topics[0] != _committedTopic() || topics[1] != key) return false;
        bytes32 committed;
        assembly ("memory-safe") {
            committed := mload(add(data, 32))
        }
        return committed == value;
    }

    /// @inheritdoc IRemoteVerifier
    /// @dev proof = abi.encode(uint64 blockNumber, bytes[] accountProof, bytes[] storageProof): the
    ///      remote Outbox's slot {commitmentSlot}(key) is empty at finalized block `blockNumber`,
    ///      whose timestamp is at least `notBefore`. An Outbox account that does not exist holds nothing.
    function verifyAbsence(bytes32 key, uint64 notBefore, bytes calldata proof) external view returns (bool) {
        (uint64 blockNumber, bytes[] memory accountProof, bytes[] memory storageProof) =
            abi.decode(proof, (uint64, bytes[], bytes[]));
        ParliaClient.FinalizedHeader memory header = lightClient.finalized(blockNumber);
        if (header.timestamp < notBefore) return false;
        (, bool exists) = EthProofs.storageAt(header.stateRoot, remoteOutbox, accountProof, commitmentSlot(key), storageProof);
        return !exists;
    }

    /// @notice Value of `slot` in the storage of any BSC account at finalized block `blockNumber`:
    ///         the data bridge for Portaldot contracts. Proofs are `eth_getProof`'s accountProof
    ///         and storageProof[i].proof.
    /// @return value The slot value (zero when absent).
    /// @return exists False when the account or the slot is absent at that block.
    /// @dev Reverts if the block is not finalized or the proof does not hang from its state root.
    function storageAt(
        uint64 blockNumber,
        address account,
        bytes[] calldata accountProof,
        bytes32 slot,
        bytes[] calldata storageProof
    ) external view returns (bytes32 value, bool exists) {
        return EthProofs.storageAt(lightClient.finalized(blockNumber).stateRoot, account, accountProof, slot, storageProof);
    }

    /// @notice Storage slot of `commitments[key]` in the Outbox, whose mapping is storage slot 0.
    function commitmentSlot(bytes32 key) public pure returns (bytes32) {
        return keccak256(abi.encode(key, uint256(0)));
    }

    /// @dev The event topic a commitment log must carry.
    function _committedTopic() internal view virtual returns (bytes32) {
        return COMMITTED_TOPIC;
    }
}
