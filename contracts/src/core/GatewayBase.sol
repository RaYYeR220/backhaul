// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Outbox, outboxKey} from "./Outbox.sol";
import {Transfer, Transfers} from "./Transfer.sol";
import {IRemoteVerifier} from "../interfaces/IRemoteVerifier.sol";

/// @notice Shared plumbing of the two canonical-bridge gateways: outbound commits, proof-checked
/// inbound finalization with one-shot nonces, and the write-once link to the twin gateway.
/// There is no owner. The deployer can call `setRemote` exactly once; after that nothing is privileged.
abstract contract GatewayBase {
    Outbox public immutable outbox;
    IRemoteVerifier public immutable verifier;
    address private immutable _deployer;

    /// the twin gateway on the other chain
    address public remote;
    uint64 public nextNonce;
    /// finalized remote nonces, 256 per word: one storage item per 256 transfers
    mapping(uint256 => uint256) private _finalized;

    event Locked(uint64 nonce, Transfer t);
    event Finalized(uint64 nonce, Transfer t, address recipient);
    event RemoteSet(address remote);

    error NotDeployer();
    error RemoteAlreadySet();
    error NotWired();
    error ZeroAddress();
    error ZeroAmount();
    error WrongKind(uint8 kind);
    error AlreadyFinalized(uint64 nonce);
    error InvalidProof();
    error NativeTransferFailed();

    constructor(Outbox outbox_, IRemoteVerifier verifier_) {
        outbox = outbox_;
        verifier = verifier_;
        _deployer = msg.sender;
    }

    /// @notice One-time wiring to the twin gateway. Locked forever once set.
    function setRemote(address remote_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (remote_ == address(0)) revert ZeroAddress();
        if (remote != address(0)) revert RemoteAlreadySet();
        remote = remote_;
        emit RemoteSet(remote_);
    }

    /// @notice Delivers a transfer the twin gateway committed. Anyone may call it with a proof.
    function finalize(Transfer calldata t, bytes calldata proof) external virtual;

    function isFinalized(uint64 nonce) public view returns (bool) {
        return _finalized[nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }

    function _commit(uint8 kind, address recipient, uint256 amount) internal returns (uint64 nonce) {
        if (remote == address(0)) revert NotWired();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        nonce = nextNonce++;
        Transfer memory t = Transfer(nonce, kind, recipient, amount);
        outbox.commit(Transfers.appKey(nonce), Transfers.hash(t));
        emit Locked(nonce, t);
    }

    /// @dev Checks the proof and burns the nonce. Callers check the kind first and pay out after.
    function _accept(Transfer calldata t, bytes calldata proof) internal {
        address r = remote;
        if (r == address(0)) revert NotWired();
        uint256 word = t.nonce >> 8;
        uint256 bit = 1 << (t.nonce & 0xff);
        uint256 bits = _finalized[word];
        if (bits & bit != 0) revert AlreadyFinalized(t.nonce);
        if (!verifier.verifyCommitment(outboxKey(r, Transfers.appKey(t.nonce)), Transfers.hash(t), proof)) {
            revert InvalidProof();
        }
        _finalized[word] = bits | bit;
        emit Finalized(t.nonce, t, t.recipient);
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }
}
