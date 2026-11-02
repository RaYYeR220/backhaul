// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EthereumTrie} from "@polytope-labs/solidity-merkle-trees/EthereumTrie.sol";
import {StorageValue} from "@polytope-labs/solidity-merkle-trees/trie/Node.sol";
import {RLPReader} from "@polytope-labs/solidity-merkle-trees/trie/ethereum/RLPReader.sol";

/// @title EthProofs
/// @notice Merkle-Patricia proofs against an Ethereum-style header (BSC uses the same tries):
///         a log inside a receipt under `receiptsRoot`, and a storage slot under `stateRoot`.
/// @dev Trie traversal is Polytope Labs' `EthereumTrie.VerifyProof` (Apache-2.0, vendored under
///      contracts/lib). Every node it reads is looked up by its keccak256, so the values returned
///      here are authenticated by the root; a missing or altered node makes the lookup revert.
library EthProofs {
    using RLPReader for bytes;
    using RLPReader for RLPReader.RLPItem;

    /// @notice The receipts trie holds nothing under the given key.
    error ReceiptNotFound();
    /// @notice The proven value does not decode as a receipt (or log).
    error InvalidReceipt();
    /// @notice The receipt has fewer logs than `logIndex + 1`.
    error LogIndexOutOfRange(uint256 logIndex, uint256 logCount);
    /// @notice The proven account does not decode as [nonce, balance, storageRoot, codeHash].
    error InvalidAccount();

    /// @notice Proves receipt `key` (RLP of the transaction index) under `receiptsRoot` and returns
    ///         its `logIndex`-th log.
    /// @dev Typed receipts (EIP-2718) are `type ‖ rlp(receipt)`; legacy ones are `rlp(receipt)`.
    ///      Both decode to [statusOrRoot, cumulativeGasUsed, logsBloom, logs].
    function receiptLog(bytes32 receiptsRoot, bytes memory key, bytes[] memory proof, uint256 logIndex)
        internal
        pure
        returns (address emitter, bytes32[] memory topics, bytes memory data)
    {
        bytes memory receipt = _get(receiptsRoot, proof, key);
        if (receipt.length == 0) revert ReceiptNotFound();

        RLPReader.RLPItem[] memory fields = _receiptBody(receipt).toList();
        if (fields.length != 4) revert InvalidReceipt();
        RLPReader.RLPItem[] memory logs = fields[3].toList();
        if (logIndex >= logs.length) revert LogIndexOutOfRange(logIndex, logs.length);

        RLPReader.RLPItem[] memory log = logs[logIndex].toList();
        if (log.length != 3) revert InvalidReceipt();
        emitter = log[0].toAddress();
        RLPReader.RLPItem[] memory t = log[1].toList();
        topics = new bytes32[](t.length);
        for (uint256 i = 0; i < t.length; ++i) {
            topics[i] = bytes32(t[i].toUintStrict());
        }
        data = log[2].toBytes();
    }

    /// @notice Proves the value of `slot` in `account`'s storage under `stateRoot` (EIP-1186 proofs).
    /// @return value The slot value (zero when absent).
    /// @return exists False when the account or the slot is absent from the state.
    function storageAt(
        bytes32 stateRoot,
        address account,
        bytes[] memory accountProof,
        bytes32 slot,
        bytes[] memory storageProof
    ) internal pure returns (bytes32 value, bool exists) {
        bytes memory rawAccount = _get(stateRoot, accountProof, abi.encodePacked(keccak256(abi.encodePacked(account))));
        if (rawAccount.length == 0) return (bytes32(0), false);

        RLPReader.RLPItem[] memory fields = rawAccount.toRlpItem().toList();
        if (fields.length != 4) revert InvalidAccount();
        bytes32 storageRoot = bytes32(fields[2].toUintStrict());

        bytes memory rawValue = _get(storageRoot, storageProof, abi.encodePacked(keccak256(abi.encode(slot))));
        if (rawValue.length == 0) return (bytes32(0), false);
        // Storage leaves hold rlp(value) with the value's leading zeros stripped.
        return (bytes32(rawValue.toRlpItem().toUint()), true);
    }

    function _get(bytes32 root, bytes[] memory proof, bytes memory key) private pure returns (bytes memory) {
        bytes[] memory keys = new bytes[](1);
        keys[0] = key;
        StorageValue[] memory values = EthereumTrie.VerifyProof(root, proof, keys);
        return values[0].value;
    }

    /// @dev Strips the EIP-2718 type byte of a typed receipt without copying.
    function _receiptBody(bytes memory receipt) private pure returns (RLPReader.RLPItem memory item) {
        uint256 ptr;
        assembly ("memory-safe") {
            ptr := add(receipt, 32)
        }
        uint8 first = uint8(receipt[0]);
        if (first >= 0xc0) return RLPReader.RLPItem(receipt.length, ptr);
        if (first == 0 || first >= 0x80) revert InvalidReceipt();
        return RLPReader.RLPItem(receipt.length - 1, ptr + 1);
    }
}
