// Copyright (C) Polytope Labs Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// 	http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Modified by the Backhaul authors from polytope-labs/solidity-merkle-trees `PolkadotTrie.sol`
// (commit 6bbc83d):
//  - trie nodes and hashed (trie layout V1) values are looked up by blake2_256, Substrate's
//    default hasher, instead of keccak256;
//  - a key is reported present only when a value was found for it (a branch without a value
//    at the key's position means the key is absent);
//  - child tries are read with a separate main-trie proof and child-trie proof, and the child
//    root must be exactly 32 bytes;
//  - custom errors replace revert strings.
pragma solidity ^0.8.28;

import {
    NodeKind,
    NodeHandle,
    NibbledBranch,
    NodeHandleOption,
    Leaf,
    TrieNode,
    NibbleSlice
} from "@polytope-labs/solidity-merkle-trees/trie/Node.sol";
import {Option} from "@polytope-labs/solidity-merkle-trees/trie/Option.sol";
import {NibbleSliceOps} from "@polytope-labs/solidity-merkle-trees/trie/NibbleSlice.sol";
import {TrieDB} from "@polytope-labs/solidity-merkle-trees/trie/TrieDB.sol";
import {PolkadotTrieDb} from "@polytope-labs/solidity-merkle-trees/trie/polkadot/PolkadotTrieDb.sol";
import {Blake2b256} from "./Blake2b256.sol";

/// @title SubstrateTrie
/// @notice Verifies Substrate base-16 Patricia trie proofs (as returned by `state_getReadProof`
///         and `state_getChildReadProof`) with blake2_256 node hashing and trie layout V1.
library SubstrateTrie {
    using NibbleSliceOps for NibbleSlice;
    using PolkadotTrieDb for NodeKind;

    /// @notice A node or hashed value needed to walk to a key is missing from the proof.
    error IncompleteProof();
    /// @notice The child-trie root found in the main trie is not a 32-byte hash.
    error InvalidChildRoot();

    /// @notice Prefix of the main-trie key that holds a default child trie's root.
    bytes internal constant CHILD_STORAGE_PREFIX = ":child_storage:default:";

    /// @notice Reads `keys` from the trie with root `root`.
    /// @return values the value of each key (empty when absent)
    /// @return present whether each key holds a value
    function readMain(bytes32 root, bytes[] memory proof, bytes[] memory keys)
        internal
        view
        returns (bytes[] memory values, bool[] memory present)
    {
        TrieNode[] memory nodes = new TrieNode[](proof.length);
        for (uint256 i = 0; i < proof.length; i++) {
            nodes[i] = TrieNode(Blake2b256.hash(proof[i]), proof[i]);
        }
        values = new bytes[](keys.length);
        present = new bool[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            (values[i], present[i]) = _lookup(nodes, root, keys[i]);
        }
    }

    /// @notice Reads `keys` from a default child trie. `childInfoKey` is the full main-trie key
    ///         of the child root, `":child_storage:default:" ‖ childId`.
    /// @dev A child trie that does not exist (no root in the main trie) holds no keys.
    function readChild(
        bytes32 root,
        bytes[] memory mainProof,
        bytes[] memory childProof,
        bytes memory childInfoKey,
        bytes[] memory keys
    ) internal view returns (bytes[] memory values, bool[] memory present) {
        bytes[] memory k = new bytes[](1);
        k[0] = childInfoKey;
        (bytes[] memory v, bool[] memory p) = readMain(root, mainProof, k);
        if (!p[0]) {
            return (new bytes[](keys.length), new bool[](keys.length));
        }
        return readMain(childRoot(v[0]), childProof, keys);
    }

    /// @notice Interprets a main-trie value as a child-trie root.
    function childRoot(bytes memory value) internal pure returns (bytes32 r) {
        if (value.length != 32) revert InvalidChildRoot();
        assembly ("memory-safe") {
            r := mload(add(value, 32))
        }
    }

    function _lookup(TrieNode[] memory nodes, bytes32 root, bytes memory key)
        private
        pure
        returns (bytes memory value, bool present)
    {
        NibbleSlice memory keyNibbles = NibbleSlice(key, 0);
        NodeKind memory node = PolkadotTrieDb.decodeNodeKind(_get(nodes, root));

        // Unbounded on purpose: a prover must not be able to cut a deep path short and claim
        // absence by exhausting a loop bound. Running out of gas reverts instead.
        while (true) {
            NodeHandle memory nextNode;

            if (TrieDB.isLeaf(node)) {
                Leaf memory leaf = node.decodeLeaf();
                if (leaf.key.eq(keyNibbles)) {
                    return (_load(nodes, leaf.value), true);
                }
                return ("", false);
            } else if (TrieDB.isNibbledBranch(node)) {
                NibbledBranch memory nibbled = node.decodeNibbledBranch();
                uint256 nibbledBranchKeyLength = nibbled.key.len();
                if (!keyNibbles.startsWith(nibbled.key)) {
                    return ("", false);
                }
                if (keyNibbles.len() == nibbledBranchKeyLength) {
                    if (Option.isSome(nibbled.value)) {
                        return (_load(nodes, nibbled.value.value), true);
                    }
                    return ("", false);
                }
                uint256 index = keyNibbles.at(nibbledBranchKeyLength);
                NodeHandleOption memory handle = nibbled.children[index];
                if (!Option.isSome(handle)) {
                    return ("", false);
                }
                keyNibbles = keyNibbles.mid(nibbledBranchKeyLength + 1);
                nextNode = handle.value;
            } else {
                // Empty trie.
                return ("", false);
            }

            node = PolkadotTrieDb.decodeNodeKind(_load(nodes, nextNode));
        }
    }

    function _get(TrieNode[] memory nodes, bytes32 hash) private pure returns (bytes memory) {
        for (uint256 i = 0; i < nodes.length; i++) {
            if (nodes[i].hash == hash) {
                return nodes[i].node;
            }
        }
        revert IncompleteProof();
    }

    function _load(TrieNode[] memory nodes, NodeHandle memory handle) private pure returns (bytes memory) {
        if (handle.isInline) {
            return handle.inLine;
        }
        if (handle.isHash) {
            return _get(nodes, handle.hash);
        }
        return "";
    }
}
