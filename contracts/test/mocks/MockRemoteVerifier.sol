// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRemoteVerifier} from "../../src/interfaces/IRemoteVerifier.sol";

interface ICommitments {
    function commitments(bytes32 key) external view returns (bytes32);
}

/// @notice Stand-in for a light-client verifier. Proof bytes are ignored.
/// Two ways to make it accept:
///  - explicit: `setCommitment(key, value, true)` / `setAbsence(key, true)`;
///  - mirror: point it at the "remote" Outbox deployed in the same test EVM, and it answers
///    exactly what a real verifier would prove (absence also needs block.timestamp >= notBefore).
contract MockRemoteVerifier is IRemoteVerifier {
    ICommitments public mirror;
    mapping(bytes32 => mapping(bytes32 => bool)) public accepted;
    mapping(bytes32 => bool) public absent;

    function setMirror(address outbox) external {
        mirror = ICommitments(outbox);
    }

    function setCommitment(bytes32 key, bytes32 value, bool ok) external {
        accepted[key][value] = ok;
    }

    function setAbsence(bytes32 key, bool ok) external {
        absent[key] = ok;
    }

    function verifyCommitment(bytes32 key, bytes32 value, bytes calldata) external view returns (bool) {
        if (accepted[key][value]) return true;
        if (address(mirror) == address(0)) return false;
        return value != bytes32(0) && mirror.commitments(key) == value;
    }

    function verifyAbsence(bytes32 key, uint64 notBefore, bytes calldata) external view returns (bool) {
        if (absent[key]) return true;
        if (address(mirror) == address(0)) return false;
        return mirror.commitments(key) == bytes32(0) && block.timestamp >= notBefore;
    }
}
