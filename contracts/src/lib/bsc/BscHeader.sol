// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Rlp} from "./Rlp.sol";

/// @notice A BNB Smart Chain block header, decoded and with its seal recovered.
/// @param hash keccak256 of the header RLP (the block hash).
/// @param signer Address recovered from the Parlia seal in the last 65 bytes of `extra`.
struct ParsedHeader {
    bytes32 hash;
    bytes32 parentHash;
    uint64 number;
    uint64 timestamp;
    address coinbase;
    bytes32 stateRoot;
    bytes32 receiptsRoot;
    bytes extra;
    address signer;
}

/// @title BscHeader
/// @notice Decodes BSC headers and recovers the Parlia seal.
/// @dev The header RLP comes from whoever submits it, so the decoder is strict: every length is
///      bounds-checked, the outer list must cover the input exactly, and all items must be strings.
///
///      The seal hash is rebuilt by splicing the original RLP instead of re-encoding each field:
///        keccak256( listPrefix ‖ rlp(chainId) ‖ items[0..11] ‖ rlp(extra[:-65]) ‖ items[13..] )
///      where items[13..] is mixHash and nonce, followed by every later item only when the header
///      carries parentBeaconRoot (item 19). This mirrors bsc `types.EncodeSigHeader`
///      (core/types/block.go, `if header.ParentBeaconRoot != nil { … }`), which leaves
///      baseFee/withdrawalsRoot/blob fields out of the seal of headers without a beacon root.
library BscHeader {
    /// @notice The bytes are not a well-formed RLP list that covers the whole input.
    error InvalidRlp();
    /// @notice The list does not have the shape of a BSC header.
    error InvalidHeader();
    /// @notice The seal is malformed, not in canonical low-s form, or recovers to nobody.
    error InvalidSignature();
    /// @notice The extra data of an epoch block does not hold a validator set.
    error InvalidEpochExtra();

    /// @dev Vanity prefix of `extra`.
    uint256 internal constant EXTRA_VANITY = 32;
    /// @dev Seal suffix of `extra`: r (32) ‖ s (32) ‖ v (1, 0 or 1).
    uint256 internal constant EXTRA_SEAL = 65;
    /// @dev One validator in an epoch block: consensus address (20) ‖ BLS vote key (48).
    uint256 internal constant VALIDATOR_BYTES = 68;

    /// @dev parentHash … nonce.
    uint256 private constant BASE_ITEMS = 15;
    /// @dev Headers with parentBeaconRoot (index 19) have at least this many items.
    uint256 private constant BEACON_ITEMS = 20;
    /// @dev Upper bound on header items; anything longer is not a header.
    uint256 private constant MAX_ITEMS = 32;
    /// @dev secp256k1n / 2: seals with a larger s are malleated copies.
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @dev Absolute memory positions of the pieces the seal hash is spliced from.
    struct Layout {
        uint256 first; // first item of the list payload
        uint256 extraItem; // item 12 (extra), including its RLP prefix
        uint256 extraData; // extra's payload
        uint256 extraLen;
        uint256 afterExtra; // item 13 (mixHash)
        uint256 tailEnd; // end of the last item the seal covers
    }

    /// @notice Decodes a header and recovers the address that sealed it under `chainId`.
    /// @dev Reverts on malformed input or an invalid seal. Does not check `signer == coinbase`.
    function parse(bytes memory rlp, uint256 chainId) internal pure returns (ParsedHeader memory h) {
        Layout memory l;
        (h, l) = _walk(rlp);
        h.hash = keccak256(rlp);
        h.extra = Rlp.copy(l.extraData, l.extraLen);
        h.signer = _recover(_sealHash(l, chainId), l.extraData + l.extraLen - EXTRA_SEAL);
    }

    /// @notice The hash a Parlia validator signs for this header under `chainId`.
    function sealHash(bytes memory rlp, uint256 chainId) internal pure returns (bytes32) {
        (, Layout memory l) = _walk(rlp);
        return _sealHash(l, chainId);
    }

    /// @notice Validator set and turn length announced in the extra data of an epoch block.
    /// @dev extra = vanity32 | count u8 | count × (address20 ‖ bls48) | turnLength u8 | attestation… | seal65,
    ///      as read by bsc `getValidatorBytesFromHeader` / `parseTurnLength` (consensus/parlia).
    function parseEpochValidators(bytes memory extra)
        internal
        pure
        returns (address[] memory validators, uint8 turnLength)
    {
        uint256 n = extra.length;
        if (n <= EXTRA_VANITY + EXTRA_SEAL) revert InvalidEpochExtra();
        uint256 count = uint8(extra[EXTRA_VANITY]);
        uint256 end = EXTRA_VANITY + 1 + count * VALIDATOR_BYTES;
        if (count == 0 || end + 1 + EXTRA_SEAL > n) revert InvalidEpochExtra();
        validators = new address[](count);
        for (uint256 i = 0; i < count; ++i) {
            uint256 at = EXTRA_VANITY + 1 + i * VALIDATOR_BYTES;
            address v;
            assembly ("memory-safe") {
                v := shr(96, mload(add(add(extra, 32), at)))
            }
            validators[i] = v;
        }
        turnLength = uint8(extra[end]);
        if (turnLength == 0) revert InvalidEpochExtra();
    }

    // ---------------------------------------------------------------------------------------------

    function _walk(bytes memory rlp) private pure returns (ParsedHeader memory h, Layout memory l) {
        uint256 start;
        assembly ("memory-safe") {
            start := add(rlp, 32)
        }
        uint256 end = start + rlp.length;
        (uint256 ptr, uint256 len, bool isList) = Rlp.item(start, end);
        if (!isList || ptr + len != end) revert InvalidRlp();
        l.first = ptr;

        uint256 i = 0;
        while (ptr < end) {
            if (i == MAX_ITEMS) revert InvalidHeader();
            (uint256 data, uint256 size, bool list) = Rlp.item(ptr, end);
            if (list) revert InvalidHeader();
            uint256 next = data + size;
            if (i == 0) h.parentHash = _bytes32(data, size);
            else if (i == 2) h.coinbase = _address(data, size);
            else if (i == 3) h.stateRoot = _bytes32(data, size);
            else if (i == 5) h.receiptsRoot = _bytes32(data, size);
            else if (i == 8) h.number = _uint64(data, size);
            else if (i == 11) h.timestamp = _uint64(data, size);
            else if (i == 12) {
                l.extraItem = ptr;
                l.extraData = data;
                l.extraLen = size;
                l.afterExtra = next;
            } else if (i == 14) {
                l.tailEnd = next;
            }
            ptr = next;
            unchecked {
                ++i;
            }
        }
        if (i < BASE_ITEMS) revert InvalidHeader();
        if (i >= BEACON_ITEMS) l.tailEnd = end;
        if (l.extraLen < EXTRA_VANITY + EXTRA_SEAL) revert InvalidHeader();
    }

    function _bytes32(uint256 data, uint256 size) private pure returns (bytes32 v) {
        if (size != 32) revert InvalidHeader();
        assembly ("memory-safe") {
            v := mload(data)
        }
    }

    function _address(uint256 data, uint256 size) private pure returns (address v) {
        if (size != 20) revert InvalidHeader();
        assembly ("memory-safe") {
            v := shr(96, mload(data))
        }
    }

    function _uint64(uint256 data, uint256 size) private pure returns (uint64 v) {
        if (size > 8) revert InvalidHeader();
        if (size == 0) return 0;
        assembly ("memory-safe") {
            v := shr(sub(256, mul(8, size)), mload(data))
        }
    }

    /// @dev Builds the seal preimage after the free memory pointer (without claiming it) and hashes it.
    function _sealHash(Layout memory l, uint256 chainId) private pure returns (bytes32 digest) {
        uint256 headLen = l.extraItem - l.first;
        uint256 bodyLen = l.extraLen - EXTRA_SEAL;
        uint256 tailLen = l.tailEnd - l.afterExtra;
        uint256 first = l.first;
        uint256 extraData = l.extraData;
        uint256 afterExtra = l.afterExtra;
        assembly ("memory-safe") {
            // Payload starts 5 bytes in; the list prefix (at most 5 bytes) is written right before it.
            let base := mload(0x40)
            let p := add(base, 5)

            // rlp(chainId)
            switch lt(chainId, 0x80)
            case 1 {
                switch chainId
                case 0 { mstore8(p, 0x80) }
                default { mstore8(p, chainId) }
                p := add(p, 1)
            }
            default {
                let n := 0
                for { let x := chainId } x { x := shr(8, x) } { n := add(n, 1) }
                mstore8(p, add(0x80, n))
                mstore(add(p, 1), shl(sub(256, mul(8, n)), chainId))
                p := add(p, add(1, n))
            }

            // parentHash … time, copied as encoded
            mcopy(p, first, headLen)
            p := add(p, headLen)

            // rlp(extra[:-65]); the body is at least the 32-byte vanity, so it always has a prefix
            switch lt(bodyLen, 56)
            case 1 {
                mstore8(p, add(0x80, bodyLen))
                p := add(p, 1)
            }
            default {
                let n := 0
                for { let x := bodyLen } x { x := shr(8, x) } { n := add(n, 1) }
                mstore8(p, add(0xb7, n))
                mstore(add(p, 1), shl(sub(256, mul(8, n)), bodyLen))
                p := add(p, add(1, n))
            }
            mcopy(p, extraData, bodyLen)
            p := add(p, bodyLen)

            // mixHash, nonce and the post-Cancun items, copied as encoded
            mcopy(p, afterExtra, tailLen)
            p := add(p, tailLen)

            // list prefix, right-aligned against the payload
            let payloadLen := sub(p, add(base, 5))
            let from := add(base, 4)
            switch lt(payloadLen, 56)
            case 1 { mstore8(from, add(0xc0, payloadLen)) }
            default {
                let n := 0
                for { let x := payloadLen } x { x := shr(8, x) } { n := add(n, 1) }
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    mstore8(sub(add(base, 4), i), and(shr(mul(8, i), payloadLen), 0xff))
                }
                from := sub(add(base, 4), n)
                mstore8(from, add(0xf7, n))
            }
            digest := keccak256(from, sub(p, from))
        }
    }

    function _recover(bytes32 digest, uint256 sig) private pure returns (address signer) {
        bytes32 r;
        bytes32 s;
        uint256 v;
        assembly ("memory-safe") {
            r := mload(sig)
            s := mload(add(sig, 32))
            v := byte(0, mload(add(sig, 64)))
        }
        if (v > 1 || uint256(s) > HALF_ORDER) revert InvalidSignature();
        signer = ecrecover(digest, uint8(v + 27), r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
