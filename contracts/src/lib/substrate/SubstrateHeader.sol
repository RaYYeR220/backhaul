// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Blake2b256} from "./Blake2b256.sol";
import {Scale} from "./Scale.sol";

/// @title SubstrateHeader
/// @notice Reads a SCALE-encoded Substrate header:
///         `parentHash[32] | number Compact<u32> | stateRoot[32] | extrinsicsRoot[32] | digest`.
/// @dev The digest is not parsed. The block hash is blake2_256 over all the bytes, so once the
///      caller matches `hash` against a trusted value, every field read here is authentic.
library SubstrateHeader {
    /// @return hash blake2_256 of the header bytes (the block hash)
    /// @return number the block number
    /// @return stateRoot the state trie root after the block
    function decode(bytes memory headerScale) internal view returns (bytes32 hash, uint32 number, bytes32 stateRoot) {
        uint256 off;
        (number, off) = Scale.decodeCompactU32(headerScale, 32);
        // stateRoot, extrinsicsRoot and at least the digest's length prefix must follow.
        if (off + 65 > headerScale.length) revert Scale.ScaleOutOfBounds();
        stateRoot = Scale.readBytes32(headerScale, off);
        hash = Blake2b256.hash(headerScale);
    }
}
