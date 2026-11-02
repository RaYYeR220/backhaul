// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Rlp} from "./Rlp.sol";

/// @title EthProofs
/// @notice Merkle-Patricia proofs against an Ethereum-style header (BSC uses the same tries):
///         a log inside a receipt under `receiptsRoot`, and a storage slot under `stateRoot`.
/// @dev The trie walk follows the key's nibbles from the root. Every node is found by its keccak256
///      among the proof nodes (or embedded in its parent when shorter than 32 bytes), so everything
///      read is authenticated by the root, proof order does not matter and extra nodes are ignored.
///      A key is reported absent only when an authenticated node shows its path ends: an empty
///      branch slot, or a leaf or extension whose path diverges. A missing node reverts.
///      The tests check the walk against vectors from the ethereumjs trie and, on real BSC proofs, against
///      Polytope Labs' EthereumTrie (vendored under contracts/lib).
library EthProofs {
    /// @notice A node the walk needs is not among the proof nodes.
    error IncompleteProof();
    /// @notice A proof node does not have the shape of a trie node.
    error InvalidProof();
    /// @notice The receipts trie holds nothing under the given key.
    error ReceiptNotFound();
    /// @notice The proven value does not decode as a receipt (or log).
    error InvalidReceipt();
    /// @notice The receipt has fewer logs than `logIndex + 1`.
    error LogIndexOutOfRange(uint256 logIndex, uint256 logCount);
    /// @notice The proven account does not decode as [nonce, balance, storageRoot, codeHash].
    error InvalidAccount();

    /// @dev keccak256(rlp("")): root of an empty trie.
    bytes32 internal constant EMPTY_TRIE_ROOT = 0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421;

    /// @notice Proves receipt `key` (RLP of the transaction index) under `receiptsRoot` and returns
    ///         its `logIndex`-th log.
    /// @dev Typed receipts (EIP-2718) are `type ‖ rlp(receipt)`; legacy ones are `rlp(receipt)`.
    ///      Both decode to [statusOrRoot, cumulativeGasUsed, logsBloom, logs].
    function receiptLog(bytes32 receiptsRoot, bytes memory key, bytes[] memory proof, uint256 logIndex)
        internal
        pure
        returns (address emitter, bytes32[] memory topics, bytes memory data)
    {
        bytes memory receipt = get(receiptsRoot, proof, key);
        uint256 len = receipt.length;
        if (len == 0) revert ReceiptNotFound();
        uint256 ptr;
        assembly ("memory-safe") {
            ptr := add(receipt, 32)
        }
        uint256 end = ptr + len;
        uint8 first = uint8(receipt[0]);
        if (first < 0x80) {
            if (first == 0) revert InvalidReceipt();
            ++ptr; // EIP-2718 type byte
        } else if (first < 0xc0) {
            revert InvalidReceipt();
        }

        (uint256 p, uint256 e) = Rlp.list(ptr, end);
        p = Rlp.skip(p, e); // status or post-state root
        p = Rlp.skip(p, e); // cumulative gas used
        p = Rlp.skip(p, e); // logs bloom
        (uint256 logs, uint256 logsLen, bool isList) = Rlp.item(p, e);
        if (!isList || logs + logsLen != e) revert InvalidReceipt();

        uint256 logsEnd = logs + logsLen;
        uint256 i;
        for (uint256 q = logs; q < logsEnd; ++i) {
            (uint256 d, uint256 s, bool l) = Rlp.item(q, logsEnd);
            if (!l) revert InvalidReceipt();
            if (i == logIndex) return _log(d, d + s);
            q = d + s;
        }
        revert LogIndexOutOfRange(logIndex, i);
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
        bytes memory rawAccount = get(stateRoot, accountProof, abi.encodePacked(keccak256(abi.encodePacked(account))));
        if (rawAccount.length == 0) return (bytes32(0), false);
        bytes32 storageRoot = _storageRoot(rawAccount);

        bytes memory rawValue = get(storageRoot, storageProof, abi.encodePacked(keccak256(abi.encode(slot))));
        if (rawValue.length == 0) return (bytes32(0), false);
        // Storage leaves hold rlp(value) with the value's leading zeros stripped.
        (uint256 ptr, uint256 end) = _bounds(rawValue);
        (uint256 d, uint256 s, uint256 next) = Rlp.str(ptr, end);
        if (next != end) revert Rlp.InvalidRlp();
        return (bytes32(Rlp.toUint(d, s)), true);
    }

    /// @notice Value stored under `key` (the raw trie path) in the trie with root `root`, or empty
    ///         bytes when the proof shows the key is absent.
    function get(bytes32 root, bytes[] memory proof, bytes memory key) internal pure returns (bytes memory value) {
        if (root == EMPTY_TRIE_ROOT) return value;
        bytes32[] memory hashes = new bytes32[](proof.length);
        for (uint256 i = 0; i < proof.length; ++i) {
            hashes[i] = keccak256(proof[i]);
        }

        uint256 keyPtr;
        assembly ("memory-safe") {
            keyPtr := add(key, 32)
        }
        uint256 total = key.length * 2;
        uint256 at; // nibbles of the key consumed so far

        (uint256 node, uint256 nodeEnd) = _lookup(proof, hashes, root);
        while (true) {
            (uint256 p, uint256 end) = Rlp.list(node, nodeEnd);
            // One pass over the items: keep the first two (leaf / extension) and, assuming a branch,
            // the slot the key continues into (or the value slot once the key is used up).
            uint256 want = at == total ? 16 : _nibble(keyPtr, at);
            Item memory a;
            Item memory b;
            Item memory w;
            uint256 count;
            for (uint256 q = p; q < end; ++count) {
                if (count == 17) revert InvalidProof();
                (uint256 d, uint256 s, bool l) = Rlp.item(q, end);
                if (count == 0) a = Item(q, d, s, l);
                else if (count == 1) b = Item(q, d, s, l);
                if (count == want) w = Item(q, d, s, l);
                q = d + s;
            }

            if (count == 17) {
                if (w.isList) {
                    if (at == total) revert InvalidProof();
                } else if (w.size == 0 || at == total) {
                    // Empty slot: the key is absent. Value slot: this is the value.
                    return Rlp.copy(w.data, w.size);
                }
                ++at;
                (node, nodeEnd) = _child(proof, hashes, w);
                continue;
            }
            if (count != 2 || a.isList || a.size == 0) revert InvalidProof();

            // Leaf or extension: hex-prefix encoded path in `a`.
            uint256 flag = _byte(a.data) >> 4;
            if (flag > 3) revert InvalidProof();
            uint256 skip = flag & 1 == 1 ? 1 : 2;
            uint256 pathLen = a.size * 2 - skip;
            uint256 remaining = total - at;
            if (flag >= 2) {
                if (pathLen != remaining || !_matches(a.data, skip, keyPtr, at, pathLen)) return value;
                if (b.isList) revert InvalidProof();
                return Rlp.copy(b.data, b.size);
            }
            if (pathLen > remaining || !_matches(a.data, skip, keyPtr, at, pathLen)) return value;
            at += pathLen;
            (node, nodeEnd) = _child(proof, hashes, b);
        }
    }

    // ---------------------------------------------------------------------------------------------

    /// @dev An RLP item: where it starts, where its payload is, and whether it is a list.
    struct Item {
        uint256 start;
        uint256 data;
        uint256 size;
        bool isList;
    }

    /// @dev The node a branch slot or extension points at: embedded, or found by hash.
    function _child(bytes[] memory proof, bytes32[] memory hashes, Item memory ref)
        private
        pure
        returns (uint256 node, uint256 nodeEnd)
    {
        if (ref.isList) return (ref.start, ref.data + ref.size);
        if (ref.size != 32) revert InvalidProof();
        bytes32 h;
        uint256 d = ref.data;
        assembly ("memory-safe") {
            h := mload(d)
        }
        return _lookup(proof, hashes, h);
    }

    function _lookup(bytes[] memory proof, bytes32[] memory hashes, bytes32 h)
        private
        pure
        returns (uint256 node, uint256 nodeEnd)
    {
        for (uint256 i = 0; i < hashes.length; ++i) {
            if (hashes[i] == h) return _bounds(proof[i]);
        }
        revert IncompleteProof();
    }

    function _bounds(bytes memory b) private pure returns (uint256 ptr, uint256 end) {
        assembly ("memory-safe") {
            ptr := add(b, 32)
            end := add(ptr, mload(b))
        }
    }

    function _byte(uint256 ptr) private pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := byte(0, mload(ptr))
        }
    }

    /// @dev Nibble `i` of the bytes at `ptr` (high nibble first).
    function _nibble(uint256 ptr, uint256 i) private pure returns (uint256) {
        uint256 b = _byte(ptr + i / 2);
        return i % 2 == 0 ? b >> 4 : b & 0x0f;
    }

    /// @dev Whether `len` path nibbles (from nibble `skip` of `path`) equal the key's from nibble `at`.
    function _matches(uint256 path, uint256 skip, uint256 key, uint256 at, uint256 len) private pure returns (bool) {
        for (uint256 j = 0; j < len; ++j) {
            if (_nibble(path, skip + j) != _nibble(key, at + j)) return false;
        }
        return true;
    }

    /// @dev Decodes a log [address, topics, data] spanning [p, e).
    function _log(uint256 p, uint256 e)
        private
        pure
        returns (address emitter, bytes32[] memory topics, bytes memory data)
    {
        (uint256 ad, uint256 asz, uint256 next) = Rlp.str(p, e);
        if (asz != 20) revert InvalidReceipt();
        assembly ("memory-safe") {
            emitter := shr(96, mload(ad))
        }
        (uint256 td, uint256 tsz, bool tl) = Rlp.item(next, e);
        if (!tl) revert InvalidReceipt();
        uint256 tEnd = td + tsz;
        uint256 n;
        for (uint256 q = td; q < tEnd; ++n) {
            q = Rlp.skip(q, tEnd);
        }
        topics = new bytes32[](n);
        uint256 q2 = td;
        for (uint256 i = 0; i < n; ++i) {
            (uint256 d, uint256 s, uint256 nx) = Rlp.str(q2, tEnd);
            if (s != 32) revert InvalidReceipt();
            bytes32 t;
            assembly ("memory-safe") {
                t := mload(d)
            }
            topics[i] = t;
            q2 = nx;
        }
        (uint256 dd, uint256 dsz, uint256 dn) = Rlp.str(tEnd, e);
        if (dn != e) revert InvalidReceipt();
        data = Rlp.copy(dd, dsz);
    }

    function _storageRoot(bytes memory rawAccount) private pure returns (bytes32 root) {
        (uint256 ptr, uint256 end) = _bounds(rawAccount);
        (uint256 p, uint256 e) = Rlp.list(ptr, end);
        p = Rlp.skip(p, e); // nonce
        p = Rlp.skip(p, e); // balance
        (uint256 d, uint256 s, uint256 next) = Rlp.str(p, e);
        if (s != 32) revert InvalidAccount();
        (,, uint256 last) = Rlp.str(next, e); // codeHash
        if (last != e) revert InvalidAccount();
        assembly ("memory-safe") {
            root := mload(d)
        }
    }
}
