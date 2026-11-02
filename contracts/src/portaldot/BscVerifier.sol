// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRemoteVerifier} from "../interfaces/IRemoteVerifier.sol";
import {EthProofs} from "../lib/bsc/EthProofs.sol";
import {ParliaClient} from "./ParliaClient.sol";

/// @title BscVerifier
/// @notice Checks what the Outbox on BNB Smart Chain committed, against headers finalized by the
///         Parlia light client. Commitments are proven from the Outbox's `Committed` event in a
///         receipt; absence is proven from the Outbox's storage. No owner, no configuration.
/// @dev Returns false when a well-formed proof shows something other than what is asked (another
///      emitter, topic, key or value; a present slot; a header older than `notBefore`). Reverts when
///      the proof itself does not verify: block not finalized ({ParliaClient.NotFinalized}), trie
///      nodes that do not hang from the header root, or bytes that do not decode.
contract BscVerifier is IRemoteVerifier {
    /// @notice Topic of `Committed(bytes32 indexed key, bytes32 value)`, emitted by the Outbox.
    bytes32 public constant COMMITTED_TOPIC = keccak256("Committed(bytes32,bytes32)");

    /// @notice Light client whose finalized headers anchor every proof.
    ParliaClient public immutable lightClient;
    /// @notice Address of the Outbox on BSC.
    address public immutable remoteOutbox;

    error ZeroAddress();

    constructor(ParliaClient lightClient_, address remoteOutbox_) {
        if (address(lightClient_) == address(0) || remoteOutbox_ == address(0)) revert ZeroAddress();
        lightClient = lightClient_;
        remoteOutbox = remoteOutbox_;
    }

    /// @inheritdoc IRemoteVerifier
    /// @dev proof = abi.encode(uint64 blockNumber, bytes receiptKey, bytes[] receiptProof, uint256 logIndex):
    ///      the `logIndex`-th log of receipt `receiptKey` (RLP of the transaction index) in finalized
    ///      block `blockNumber` must be `Committed(key, value)` emitted by the remote Outbox.
    function verifyCommitment(bytes32 key, bytes32 value, bytes calldata proof) external view returns (bool) {
        (uint64 blockNumber, bytes memory receiptKey, bytes[] memory nodes, uint256 logIndex) =
            abi.decode(proof, (uint64, bytes, bytes[], uint256));
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

    /// @notice Storage slot of `commitments[key]` in the Outbox, whose mapping is storage slot 0.
    function commitmentSlot(bytes32 key) public pure returns (bytes32) {
        return keccak256(abi.encode(key, uint256(0)));
    }

    /// @dev The event topic a commitment log must carry.
    function _committedTopic() internal view virtual returns (bytes32) {
        return COMMITTED_TOPIC;
    }
}
