// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Checks what the Outbox on the other chain committed, against that chain's finalized state.
/// @dev `key` is already namespaced by the remote application: keccak256(abi.encode(remoteApp, appKey)),
///      the same value `Outbox.keyFor` returns on the remote chain. Proof formats are verifier-specific.
interface IRemoteVerifier {
    /// @return true if the remote Outbox holds `value` under `key` in a finalized remote state.
    function verifyCommitment(bytes32 key, bytes32 value, bytes calldata proof) external view returns (bool);

    /// @return true if the remote Outbox holds nothing under `key` in a finalized remote state
    ///         whose timestamp (unix seconds) is at least `notBefore`.
    function verifyAbsence(bytes32 key, uint64 notBefore, bytes calldata proof) external view returns (bool);
}
