// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Key under which `app` commits `appKey`. Same formula on both chains.
function outboxKey(address app, bytes32 appKey) pure returns (bytes32) {
    return keccak256(abi.encode(app, appKey));
}

/// @title Outbox
/// @notice Write-once message commitments that the other chain proves.
/// - Portaldot -> BSC: BSC proves the storage slot `commitments[key]`, i.e. keccak256(abi.encode(key, 0)).
/// - BSC -> Portaldot: Portaldot proves the `Committed` log from a receipt of the emitting block, or
///   the same slot from storage at any later block (the slot is write-once).
/// Keys are namespaced by the calling contract, so no app can write under another app's key.
/// @dev `commitments` must stay storage slot 0: no inheritance, no state declared before it.
contract Outbox {
    mapping(bytes32 => bytes32) public commitments; // slot 0 - do not reorder

    event Committed(bytes32 indexed key, bytes32 value);

    error AlreadyCommitted(bytes32 key);
    error ZeroValue();

    function commit(bytes32 appKey, bytes32 value) external returns (bytes32 key) {
        // zero would read as "absent" in a storage proof
        if (value == bytes32(0)) revert ZeroValue();
        key = outboxKey(msg.sender, appKey);
        if (commitments[key] != bytes32(0)) revert AlreadyCommitted(key);
        commitments[key] = value;
        emit Committed(key, value);
    }

    function keyFor(address app, bytes32 appKey) public pure returns (bytes32) {
        return outboxKey(app, appKey);
    }
}
