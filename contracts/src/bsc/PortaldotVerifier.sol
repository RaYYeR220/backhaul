// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRemoteVerifier} from "../interfaces/IRemoteVerifier.sol";
import {PortaldotLightClient} from "./PortaldotLightClient.sol";
import {Blake2b256} from "../lib/substrate/Blake2b256.sol";
import {Scale} from "../lib/substrate/Scale.sol";
import {SubstrateTrie} from "../lib/substrate/SubstrateTrie.sol";

/// @title PortaldotVerifier
/// @notice Verifies what the Outbox on Portaldot committed, from its contract storage under a
///         header imported into the BEEFY light client.
///
///         pallet-revive keeps each contract's storage in a child trie at
///         `":child_storage:default:" ‖ trieId`, with EVM slot `s` stored under `blake2_256(s)` as
///         a raw 32-byte value (an all-zero value is a cleared slot). `commitments` is the
///         Outbox's mapping at slot 0, so `commitments[key]` lives at `keccak256(key ‖ 0)`.
///
///         The Outbox's trieId is read once, by anyone, from a proof of `Revive::AccountInfoOf`.
///         There is no owner and nothing can be changed afterwards.
contract PortaldotVerifier is IRemoteVerifier {
    /// @dev twox128("Timestamp") ‖ twox128("Now")
    bytes internal constant TIMESTAMP_NOW_KEY = hex"f0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";
    /// @dev twox128("Revive") ‖ twox128("AccountInfoOf"); the map key (H160) uses the Identity hasher.
    bytes internal constant ACCOUNT_INFO_PREFIX = hex"735f040a5d490f1107ad9c56f5ca00d2ae37ff0591fdbbcd9c2406df7147a9dc";

    /// @notice The light client whose imported headers anchor every proof.
    PortaldotLightClient public immutable lightClient;
    /// @notice The Outbox contract on Portaldot (its H160 address).
    address public immutable remoteOutbox;
    /// @notice The Outbox's child-trie id; zero until `bindTrieId` runs.
    bytes32 public trieId;

    /// @notice The Outbox's trieId was bound from a header's state.
    event TrieIdBound(bytes32 trieId, uint32 headerNumber);

    /// @notice `bindTrieId` already ran.
    error AlreadyBound();
    /// @notice `bindTrieId` has not run yet.
    error NotBound();
    /// @notice The light client has no state root for that header.
    error UnknownHeader(uint32 number);
    /// @notice The proof shows no revive account for the Outbox.
    error AccountNotFound();
    /// @notice The Outbox's revive account is not a contract.
    error NotAContract();
    /// @notice The trieId is not 32 non-zero bytes.
    error UnsupportedTrieId();
    /// @notice A storage value is not 32 bytes.
    error MalformedValue();
    /// @notice The proof does not show an 8-byte `Timestamp::Now`.
    error MissingTimestamp();

    /// @param lc the BEEFY light client of Portaldot
    /// @param outbox H160 address of the Outbox contract on Portaldot
    constructor(PortaldotLightClient lc, address outbox) {
        lightClient = lc;
        remoteOutbox = outbox;
    }

    /// @notice Binds the Outbox's trieId from `Revive::AccountInfoOf(remoteOutbox)`. Callable once.
    /// @param headerNumber an imported header
    /// @param proof main-trie read proof of the account-info key under that header's state root
    function bindTrieId(uint32 headerNumber, bytes[] calldata proof) external {
        if (trieId != bytes32(0)) revert AlreadyBound();
        bytes32 root = _stateRoot(headerNumber);
        bytes[] memory keys = new bytes[](1);
        keys[0] = abi.encodePacked(ACCOUNT_INFO_PREFIX, remoteOutbox);
        (bytes[] memory values, bool[] memory present) = SubstrateTrie.readMain(root, proof, keys);
        if (!present[0]) revert AccountNotFound();

        // AccountInfo { account_type: enum { Contract(ContractInfo { trie_id: Vec<u8>, .. }) = 0, EOA = 1 }, dust }
        bytes memory info = values[0];
        if (Scale.readU8(info, 0) != 0) revert NotAContract();
        (uint32 len, uint256 off) = Scale.decodeCompactU32(info, 1);
        if (len != 32) revert UnsupportedTrieId();
        bytes32 id = Scale.readBytes32(info, off);
        if (id == bytes32(0)) revert UnsupportedTrieId();
        trieId = id;
        emit TrieIdBound(id, headerNumber);
    }

    /// @inheritdoc IRemoteVerifier
    /// @dev `proof` = `abi.encode(uint32 headerNumber, bytes[] mainProof, bytes[] childProof)`, where
    ///      `mainProof` covers the child-trie root key and `childProof` the slot. Reverts if the
    ///      header is not imported, the trieId is unbound or a proof is incomplete or tampered.
    function verifyCommitment(bytes32 key, bytes32 value, bytes calldata proof) external view returns (bool) {
        (uint32 headerNumber, bytes[] memory mainProof, bytes[] memory childProof) =
            abi.decode(proof, (uint32, bytes[], bytes[]));
        (bytes32 stored,) = _readSlot(headerNumber, mainProof, childProof, outboxSlot(key));
        return value != bytes32(0) && stored == value;
    }

    /// @inheritdoc IRemoteVerifier
    /// @dev `proof` = `abi.encode(uint32 headerNumber, bytes[] mainProof, bytes[] childProof)`, where
    ///      `mainProof` covers both the child-trie root key and `Timestamp::Now` (headers carry no
    ///      timestamp). True iff the slot is empty and `Timestamp::Now / 1000 >= notBefore`.
    function verifyAbsence(bytes32 key, uint64 notBefore, bytes calldata proof) external view returns (bool) {
        (uint32 headerNumber, bytes[] memory mainProof, bytes[] memory childProof) =
            abi.decode(proof, (uint32, bytes[], bytes[]));
        bytes32 id = _bound();
        bytes32 root = _stateRoot(headerNumber);
        bytes[] memory keys = new bytes[](2);
        keys[0] = _childInfoKey(id);
        keys[1] = TIMESTAMP_NOW_KEY;
        (bytes[] memory values, bool[] memory present) = SubstrateTrie.readMain(root, mainProof, keys);
        if (!present[1] || values[1].length != 8) revert MissingTimestamp();
        if (Scale.readU64LE(values[1], 0) / 1000 < notBefore) return false;
        // No child trie at all means the Outbox has no storage.
        if (!present[0]) return true;

        bytes[] memory slotKey = new bytes[](1);
        slotKey[0] = _slotKey(outboxSlot(key));
        (bytes[] memory v, bool[] memory p) =
            SubstrateTrie.readMain(SubstrateTrie.childRoot(values[0]), childProof, slotKey);
        return !p[0] || _word(v[0]) == bytes32(0);
    }

    /// @notice Slot of `commitments[key]` in the Outbox (the mapping at slot 0).
    function outboxSlot(bytes32 key) public pure returns (bytes32) {
        return keccak256(abi.encode(key, uint256(0)));
    }

    /// @dev Reads EVM slot `slot` of the Outbox under an imported header. A cleared (all-zero)
    ///      slot reads as absent.
    function _readSlot(uint32 headerNumber, bytes[] memory mainProof, bytes[] memory childProof, bytes32 slot)
        internal
        view
        returns (bytes32 value, bool present)
    {
        bytes32 id = _bound();
        bytes32 root = _stateRoot(headerNumber);
        bytes[] memory keys = new bytes[](1);
        keys[0] = _slotKey(slot);
        (bytes[] memory v, bool[] memory p) = SubstrateTrie.readChild(root, mainProof, childProof, _childInfoKey(id), keys);
        if (!p[0]) return (bytes32(0), false);
        value = _word(v[0]);
        present = value != bytes32(0);
    }

    function _stateRoot(uint32 headerNumber) private view returns (bytes32 root) {
        root = lightClient.stateRootOf(headerNumber);
        if (root == bytes32(0)) revert UnknownHeader(headerNumber);
    }

    function _bound() private view returns (bytes32 id) {
        id = trieId;
        if (id == bytes32(0)) revert NotBound();
    }

    function _childInfoKey(bytes32 id) private pure returns (bytes memory) {
        return abi.encodePacked(SubstrateTrie.CHILD_STORAGE_PREFIX, id);
    }

    function _slotKey(bytes32 slot) private view returns (bytes memory) {
        return abi.encodePacked(Blake2b256.hash(abi.encodePacked(slot)));
    }

    function _word(bytes memory v) private pure returns (bytes32 w) {
        if (v.length != 32) revert MalformedValue();
        assembly ("memory-safe") {
            w := mload(add(v, 32))
        }
    }
}
