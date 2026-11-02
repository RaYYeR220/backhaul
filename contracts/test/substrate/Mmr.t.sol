// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Mmr, MmrLeafProof} from "../../src/lib/substrate/Mmr.sol";

contract MmrTest is Test {
    string internal json;
    bytes32 internal root;
    uint64 internal leafCount;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/portaldot-mmr.json"));
        root = vm.parseJsonBytes32(json, ".mmrRoot");
        leafCount = uint64(vm.parseJsonUint(json, ".leafCount"));
    }

    function _load(string memory key) internal view returns (bytes32 leaf, MmrLeafProof memory p, bytes32 blockHash) {
        string memory k = string.concat(".", key);
        leaf = vm.parseJsonBytes32(json, string.concat(k, ".leaf"));
        blockHash = vm.parseJsonBytes32(json, string.concat(k, ".blockHash"));
        p.leafIndex = uint64(vm.parseJsonUint(json, string.concat(k, ".leafIndex")));
        p.leafCount = leafCount;
        p.items = vm.parseJsonBytes32Array(json, string.concat(k, ".items"));
    }

    // ---------------------------------------------------------------- live fixture

    function test_leafHashMatchesChain() public view {
        (bytes32 leaf, MmrLeafProof memory p, bytes32 blockHash) = _load("recent");
        assertEq(Mmr.leafHash(uint32(p.leafIndex), blockHash), leaf);
    }

    function test_verifyLeafRecent() public view {
        (bytes32 leaf, MmrLeafProof memory p,) = _load("recent");
        assertGe(p.leafIndex + 10, leafCount, "leaf is about 10 back from the commitment");
        assertTrue(Mmr.verify(root, leaf, p));
    }

    function test_verifyLeafDeepMountain() public view {
        (bytes32 leaf, MmrLeafProof memory p,) = _load("deep");
        // The first mountain of a ~300k-leaf MMR has 2^18 leaves.
        assertGe(p.items.length, 11);
        assertTrue(Mmr.verify(root, leaf, p));
    }

    function test_verifyLastLeaf() public view {
        (bytes32 leaf, MmrLeafProof memory p,) = _load("last");
        assertEq(p.leafIndex, leafCount - 1);
        assertTrue(Mmr.verify(root, leaf, p));
    }

    function test_rejectsWrongLeaf() public view {
        (bytes32 leaf, MmrLeafProof memory p, bytes32 blockHash) = _load("recent");
        assertFalse(Mmr.verify(root, keccak256(abi.encode(leaf)), p));
        // The right block hash under a neighbouring index is a different leaf.
        assertFalse(Mmr.verify(root, Mmr.leafHash(uint32(p.leafIndex + 1), blockHash), p));
        // The right leaf claimed at another index.
        p.leafIndex += 1;
        assertFalse(Mmr.verify(root, leaf, p));
    }

    function test_rejectsWrongLeafCount() public view {
        (bytes32 leaf, MmrLeafProof memory p,) = _load("recent");
        uint256[] memory wrong = vm.parseJsonUintArray(json, ".wrongLeafCounts");
        assertGt(wrong.length, 0);
        for (uint256 i = 0; i < wrong.length; i++) {
            p.leafCount = uint64(wrong[i]);
            assertFalse(Mmr.verify(root, leaf, p));
        }
        p.leafCount = p.leafIndex; // index must stay below the count
        assertFalse(Mmr.verify(root, leaf, p));
        p.leafCount = 0;
        assertFalse(Mmr.verify(root, leaf, p));
    }

    function test_rejectsTamperedItem() public view {
        (bytes32 leaf, MmrLeafProof memory p,) = _load("deep");
        for (uint256 i = 0; i < p.items.length; i++) {
            bytes32 saved = p.items[i];
            p.items[i] = bytes32(uint256(saved) ^ 1);
            assertFalse(Mmr.verify(root, leaf, p));
            p.items[i] = saved;
        }
    }

    function test_rejectsWrongItemCount() public view {
        (bytes32 leaf, MmrLeafProof memory p,) = _load("deep");
        bytes32[] memory longer = new bytes32[](p.items.length + 1);
        for (uint256 i = 0; i < p.items.length; i++) {
            longer[i] = p.items[i];
        }
        bytes32[] memory original = p.items;
        p.items = longer;
        assertFalse(Mmr.verify(root, leaf, p));
        bytes32[] memory shorter = new bytes32[](original.length - 1);
        for (uint256 i = 0; i < shorter.length; i++) {
            shorter[i] = original[i];
        }
        p.items = shorter;
        assertFalse(Mmr.verify(root, leaf, p));
    }

    // ---------------------------------------------------------------- reference model

    /// Random MMRs checked against a node-by-node (position-based) reference build.
    function testFuzz_matchesPositionalReference(uint256 seed, uint8 countSeed, uint8 indexSeed) public pure {
        uint256 count = uint256(countSeed) % 70 + 1;
        uint256 index = uint256(indexSeed) % count;
        bytes32[] memory leaves = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            leaves[i] = keccak256(abi.encode(seed, i));
        }
        bytes32 refRoot = _referenceRoot(leaves);
        MmrLeafProof memory p = _proof(leaves, index);
        assertTrue(Mmr.verify(refRoot, leaves[index], p));
        assertFalse(Mmr.verify(refRoot, keccak256(abi.encode(leaves[index])), p));
        if (count > 1) {
            p.leafIndex = uint64((index + 1) % count);
            assertFalse(Mmr.verify(refRoot, leaves[index], p));
        }
    }

    function _merge(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(a, b));
    }

    /// ckb-merkle-mountain-range: append nodes by position, then bag the peaks right to left.
    function _referenceRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory nodes = new bytes32[](2 * leaves.length);
        uint256 size;
        for (uint256 l = 0; l < leaves.length; l++) {
            uint256 pos = size;
            nodes[size++] = leaves[l];
            uint256 h;
            while (_posHeight(pos + 1) > h) {
                pos++;
                nodes[size++] = _merge(nodes[pos - (2 << h)], nodes[pos - 1]);
                h++;
            }
        }
        bytes32[] memory peaks = new bytes32[](64);
        uint256 n;
        uint256 at;
        uint256 remaining = size;
        for (uint256 h = 32; h > 0;) {
            h--;
            uint256 s = (2 << h) - 1;
            if (s <= remaining) {
                peaks[n++] = nodes[at + s - 1];
                at += s;
                remaining -= s;
            }
        }
        bytes32 acc = peaks[n - 1];
        for (uint256 i = n - 1; i > 0;) {
            i--;
            acc = _merge(acc, peaks[i]);
        }
        return acc;
    }

    function _posHeight(uint256 pos) internal pure returns (uint256) {
        uint256 p = pos + 1;
        while (p & (p + 1) != 0) {
            uint256 msb = 1;
            while (msb * 2 <= p) msb *= 2;
            p -= msb - 1;
        }
        uint256 h;
        while ((2 << h) - 1 < p) h++;
        return h;
    }

    function _subtree(bytes32[] memory leaves, uint256 first, uint256 h) internal pure returns (bytes32) {
        if (h == 0) return leaves[first];
        return _merge(_subtree(leaves, first, h - 1), _subtree(leaves, first + (1 << (h - 1)), h - 1));
    }

    function _proof(bytes32[] memory leaves, uint256 index) internal pure returns (MmrLeafProof memory p) {
        uint256 count = leaves.length;
        uint256[] memory firsts = new uint256[](8);
        uint256[] memory heights = new uint256[](8);
        uint256 m;
        uint256 first;
        for (uint256 h = 8; h > 0;) {
            h--;
            if (count & (1 << h) != 0) {
                firsts[m] = first;
                heights[m++] = h;
                first += 1 << h;
            }
        }
        uint256 k;
        for (uint256 i = 0; i < m; i++) {
            if (index >= firsts[i] && index < firsts[i] + (1 << heights[i])) k = i;
        }
        p.items = new bytes32[](heights[k] + m - 1);
        uint256 local = index - firsts[k];
        for (uint256 j = 0; j < heights[k]; j++) {
            uint256 sib = ((local >> j) ^ 1) << j;
            p.items[j] = _subtree(leaves, firsts[k] + sib, j);
        }
        uint256 next = heights[k];
        for (uint256 i = 0; i < m; i++) {
            if (i != k) p.items[next++] = _subtree(leaves, firsts[i], heights[i]);
        }
        p.leafIndex = uint64(index);
        p.leafCount = uint64(count);
    }
}
