// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Proof that one leaf belongs to a Merkle Mountain Range of `leafCount` leaves.
/// @param leafIndex position of the leaf, counted from 0
/// @param leafCount number of leaves in the MMR the root commits to
/// @param items the siblings inside the leaf's mountain from the bottom up, then the peaks of every
///        other mountain from left to right
struct MmrLeafProof {
    uint64 leafIndex;
    uint64 leafCount;
    bytes32[] items;
}

/// @title Mmr
/// @notice Verifies single-leaf proofs against the keccak256 MMR of Substrate's `pallet-mmr`
///         (ckb-merkle-mountain-range layout) as configured on Portaldot.
/// @dev The mountain layout is derived from `leafIndex` and `leafCount` alone: mountain heights are
///      the set bits of `leafCount` from high to low, filled left to right. The prover only supplies
///      hashes, so it cannot move the leaf to another position or mountain.
///      Merge is `keccak256(left ‖ right)`; peaks are bagged right to left with
///      `acc = keccak256(acc ‖ peak)`, starting from the right-most peak.
library Mmr {
    /// @notice The MMR leaf for block `parentNumber`: keccak256 of SCALE `(u32 parentNumber, H256 parentHash)`.
    /// @dev Leaf `i` holds the hash of block `i`; it is appended while block `i + 1` executes, so the
    ///      root stored at block C covers leaves 0..C-1.
    function leafHash(uint32 parentNumber, bytes32 parentHash) internal pure returns (bytes32) {
        uint32 v = parentNumber;
        uint32 le = (v >> 24) | ((v >> 8) & 0xff00) | ((v << 8) & 0xff0000) | (v << 24);
        return keccak256(abi.encodePacked(bytes4(le), parentHash));
    }

    /// @notice True iff `leaf` sits at `p.leafIndex` in the MMR of `p.leafCount` leaves with root `root`.
    function verify(bytes32 root, bytes32 leaf, MmrLeafProof memory p) internal pure returns (bool) {
        uint256 count = p.leafCount;
        uint256 index = p.leafIndex;
        if (index >= count) return false;

        // Find the leaf's mountain: `k` is its position among the peaks, `first` its first leaf.
        uint256 peaks;
        uint256 k;
        uint256 first;
        uint256 height;
        bool found;
        for (uint256 h = 64; h > 0;) {
            unchecked {
                --h;
            }
            uint256 size = 1 << h;
            if (count & size == 0) continue;
            if (!found) {
                if (index < first + size) {
                    found = true;
                    height = h;
                    k = peaks;
                } else {
                    first += size;
                }
            }
            ++peaks;
        }
        bytes32[] memory items = p.items;
        if (items.length != height + peaks - 1) return false;

        bytes32 node = leaf;
        uint256 local = index - first;
        for (uint256 j = 0; j < height; ++j) {
            node = (local >> j) & 1 == 0 ? _merge(node, items[j]) : _merge(items[j], node);
        }

        // Peak i is `node` when i == k; the others come after the siblings, in order, skipping k.
        uint256 last = peaks - 1;
        bytes32 acc = k == last ? node : items[height + last - 1];
        for (uint256 i = last; i > 0;) {
            unchecked {
                --i;
            }
            bytes32 peak = i == k ? node : (i < k ? items[height + i] : items[height + i - 1]);
            acc = _merge(acc, peak);
        }
        return acc == root;
    }

    function _merge(bytes32 a, bytes32 b) private pure returns (bytes32 r) {
        assembly ("memory-safe") {
            mstore(0x00, a)
            mstore(0x20, b)
            r := keccak256(0x00, 0x40)
        }
    }
}
