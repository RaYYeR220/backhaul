// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Rlp
/// @notice Bounds-checked RLP item decoding over raw memory pointers.
/// @dev Works on absolute memory positions so callers can walk nested structures without copying.
///      Lengths are limited to 4 bytes (4 GiB), far above anything that fits in memory.
library Rlp {
    /// @notice The bytes are not well-formed RLP within the given bounds.
    error InvalidRlp();

    /// @notice Decodes the RLP prefix of the item at `ptr`, which must end by `end`.
    /// @return data Position of the item's payload.
    /// @return size Length of the payload.
    /// @return isList Whether the item is a list.
    function item(uint256 ptr, uint256 end) internal pure returns (uint256 data, uint256 size, bool isList) {
        if (ptr >= end) revert InvalidRlp();
        uint256 b0;
        assembly ("memory-safe") {
            b0 := byte(0, mload(ptr))
        }
        if (b0 < 0x80) return (ptr, 1, false);
        if (b0 < 0xb8) {
            (data, size) = (ptr + 1, b0 - 0x80);
        } else if (b0 < 0xc0) {
            (data, size) = _long(ptr, end, b0 - 0xb7);
        } else if (b0 < 0xf8) {
            (data, size, isList) = (ptr + 1, b0 - 0xc0, true);
        } else {
            (data, size) = _long(ptr, end, b0 - 0xf7);
            isList = true;
        }
        if (data + size > end) revert InvalidRlp();
    }

    /// @notice Decodes a list that must span exactly [ptr, end) and returns its payload bounds.
    function list(uint256 ptr, uint256 end) internal pure returns (uint256 data, uint256 dataEnd) {
        (uint256 d, uint256 size, bool isList) = item(ptr, end);
        if (!isList || d + size != end) revert InvalidRlp();
        return (d, d + size);
    }

    /// @notice Decodes a string item at `ptr` and returns its payload bounds and the next item's position.
    function str(uint256 ptr, uint256 end) internal pure returns (uint256 data, uint256 size, uint256 next) {
        bool isList;
        (data, size, isList) = item(ptr, end);
        if (isList) revert InvalidRlp();
        next = data + size;
    }

    /// @notice Position right after the item at `ptr`.
    function skip(uint256 ptr, uint256 end) internal pure returns (uint256) {
        (uint256 data, uint256 size,) = item(ptr, end);
        return data + size;
    }

    /// @notice Big-endian unsigned integer of a payload of at most 32 bytes.
    function toUint(uint256 data, uint256 size) internal pure returns (uint256 v) {
        if (size > 32) revert InvalidRlp();
        if (size == 0) return 0;
        assembly ("memory-safe") {
            v := shr(sub(256, mul(8, size)), mload(data))
        }
    }

    /// @notice Copies `size` bytes at `data` into a new `bytes`.
    function copy(uint256 data, uint256 size) internal pure returns (bytes memory out) {
        out = new bytes(size);
        assembly ("memory-safe") {
            mcopy(add(out, 32), data, size)
        }
    }

    function _long(uint256 ptr, uint256 end, uint256 lenOfLen) private pure returns (uint256 data, uint256 size) {
        if (lenOfLen > 4 || ptr + 1 + lenOfLen > end) revert InvalidRlp();
        assembly ("memory-safe") {
            size := shr(sub(256, mul(8, lenOfLen)), mload(add(ptr, 1)))
        }
        data = ptr + 1 + lenOfLen;
    }
}
