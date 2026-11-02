// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title BLAKE2b-256
/// @notice BLAKE2b with a 32-byte digest and no key (Substrate's `blake2_256`), built on the
///         EIP-152 compression function precompile at address 0x09.
library Blake2b256 {
    /// @notice The F precompile call failed (missing precompile or out of gas).
    error Blake2fFailed();

    /// @dev Precompile input layout (213 bytes):
    ///      rounds u32 BE [0,4) | h 8×u64 LE [4,68) | m 16×u64 LE [68,196) | t 2×u64 LE [196,212) | f [212].
    ///      `h` starts as the BLAKE2b IV with the parameter block (digest 32, key 0, fanout 1, depth 1)
    ///      folded into word 0, written little-endian.
    bytes32 private constant H_LO = 0x28c9bdf267e6096a3ba7ca8485ae67bb2bf894fe72f36e3cf1361d5f3af54fa5;
    bytes32 private constant H_HI = 0xd182e6ad7f520e511f6c3e2b8c68059b6bbd41fbabd9831f79217e1319cde05b;

    /// @notice blake2b-256 of `data`.
    function hash(bytes memory data) internal view returns (bytes32 digest) {
        bytes4 failed = Blake2fFailed.selector;
        assembly ("memory-safe") {
            // Scratch buffer past the free memory pointer; it does not outlive this block.
            let buf := mload(0x40)
            mstore(buf, shl(224, 12))
            mstore(add(buf, 4), H_LO)
            mstore(add(buf, 36), H_HI)

            let len := mload(data)
            let src := add(data, 32)
            let m := add(buf, 68)
            let t := add(buf, 196)
            let offset := 0
            for {} 1 {} {
                let remaining := sub(len, offset)
                let last := iszero(gt(remaining, 128))
                switch last
                case 0 {
                    mcopy(m, add(src, offset), 128)
                    offset := add(offset, 128)
                }
                default {
                    mstore(m, 0)
                    mstore(add(m, 32), 0)
                    mstore(add(m, 64), 0)
                    mstore(add(m, 96), 0)
                    mcopy(m, add(src, offset), remaining)
                    offset := len
                }
                // Byte counter, little-endian; the high 64 bits stay zero. This also clears f.
                mstore(t, 0)
                for { let i := 0 } lt(i, 8) { i := add(i, 1) } {
                    mstore8(add(t, i), and(shr(shl(3, i), offset), 0xff))
                }
                mstore8(add(buf, 212), last)
                // A missing precompile would "succeed" with no output, so check the size too.
                let ok := staticcall(gas(), 0x09, buf, 213, add(buf, 4), 64)
                if iszero(and(ok, eq(returndatasize(), 64))) {
                    mstore(0, failed)
                    revert(0, 4)
                }
                if last { break }
            }
            digest := mload(add(buf, 4))
        }
    }
}
