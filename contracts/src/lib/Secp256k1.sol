// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Secp256k1
/// @notice Affine-point checks for secp256k1 public keys.
library Secp256k1 {
    /// @notice The field prime p = 2^256 - 2^32 - 977.
    uint256 internal constant P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;

    /// @notice True iff (x, y) is a point of y² = x³ + 7 over F_p with both coordinates reduced.
    function isOnCurve(uint256 x, uint256 y) internal pure returns (bool) {
        if (x >= P || y >= P) return false;
        return mulmod(y, y, P) == addmod(mulmod(mulmod(x, x, P), x, P), 7, P);
    }

    /// @notice True iff the 33-byte SEC1 compressed key at `data[off:off+33]` encodes (x, y):
    ///         prefix 0x02 for even y, 0x03 for odd y, then x big-endian.
    /// @dev The caller must have checked that 33 bytes are available at `off`.
    function compressesTo(uint256 x, uint256 y, bytes memory data, uint256 off) internal pure returns (bool) {
        uint8 prefix;
        uint256 kx;
        assembly ("memory-safe") {
            let p := add(add(data, 32), off)
            prefix := byte(0, mload(p))
            kx := mload(add(p, 1))
        }
        return prefix == 2 + uint8(y & 1) && kx == x;
    }

    /// @notice Ethereum-style address of the key: the last 20 bytes of keccak256(x ‖ y).
    function toAddress(uint256 x, uint256 y) internal pure returns (address a) {
        assembly ("memory-safe") {
            mstore(0x00, x)
            mstore(0x20, y)
            a := and(keccak256(0x00, 0x40), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }
}
