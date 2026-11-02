// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Scale
/// @notice Minimal SCALE codec reads over `bytes memory`. Every read is bounds-checked and compact
///         integers must use their canonical (shortest) encoding, as the Substrate decoder demands.
library Scale {
    /// @notice A read ran past the end of the input.
    error ScaleOutOfBounds();
    /// @notice A compact integer was not in its shortest encoding.
    error ScaleNonCanonical();
    /// @notice A compact integer does not fit the requested width.
    error ScaleCompactTooLarge();

    /// @notice Decodes a `Compact<u32>` at `off`.
    /// @return v the value
    /// @return newOff the offset just past the encoding
    function decodeCompactU32(bytes memory b, uint256 off) internal pure returns (uint32 v, uint256 newOff) {
        uint8 b0 = readU8(b, off);
        uint8 mode = b0 & 3;
        if (mode == 0) {
            return (uint32(b0 >> 2), off + 1);
        }
        if (mode == 1) {
            uint256 x = (uint256(b0) | (uint256(readU8(b, off + 1)) << 8)) >> 2;
            if (x < 1 << 6) revert ScaleNonCanonical();
            return (uint32(x), off + 2);
        }
        if (mode == 2) {
            uint256 x = uint256(readU32LE(b, off)) >> 2;
            if (x < 1 << 14) revert ScaleNonCanonical();
            return (uint32(x), off + 4);
        }
        // Big-integer mode: (b0 >> 2) + 4 bytes follow. A u32 allows exactly 4.
        if (b0 >> 2 != 0) revert ScaleCompactTooLarge();
        uint32 y = readU32LE(b, off + 1);
        if (y < 1 << 30) revert ScaleNonCanonical();
        return (y, off + 5);
    }

    /// @notice Decodes a compact length prefix (a `Compact<u32>`) and checks that `len * elemSize`
    ///         bytes are available after it.
    /// @return len the element count
    /// @return newOff the offset of the first element
    function decodeLength(bytes memory b, uint256 off, uint256 elemSize)
        internal
        pure
        returns (uint256 len, uint256 newOff)
    {
        uint32 n;
        (n, newOff) = decodeCompactU32(b, off);
        len = n;
        if (newOff + len * elemSize > b.length) revert ScaleOutOfBounds();
    }

    function readU8(bytes memory b, uint256 off) internal pure returns (uint8 v) {
        if (off >= b.length) revert ScaleOutOfBounds();
        assembly ("memory-safe") {
            v := byte(0, mload(add(add(b, 32), off)))
        }
    }

    /// @notice Little-endian u32 at `off`.
    function readU32LE(bytes memory b, uint256 off) internal pure returns (uint32) {
        return uint32(_readLE(b, off, 4));
    }

    /// @notice Little-endian u64 at `off`.
    function readU64LE(bytes memory b, uint256 off) internal pure returns (uint64) {
        return uint64(_readLE(b, off, 8));
    }

    /// @notice 32 raw bytes at `off`.
    function readBytes32(bytes memory b, uint256 off) internal pure returns (bytes32 v) {
        if (off + 32 > b.length) revert ScaleOutOfBounds();
        assembly ("memory-safe") {
            v := mload(add(add(b, 32), off))
        }
    }

    function _readLE(bytes memory b, uint256 off, uint256 n) private pure returns (uint256 v) {
        if (off + n > b.length) revert ScaleOutOfBounds();
        uint256 word;
        assembly ("memory-safe") {
            word := mload(add(add(b, 32), off))
        }
        for (uint256 i = 0; i < n; i++) {
            v |= ((word >> (248 - 8 * i)) & 0xff) << (8 * i);
        }
    }
}
