// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Mmr, MmrLeafProof} from "../lib/substrate/Mmr.sol";
import {Scale} from "../lib/substrate/Scale.sol";
import {SubstrateHeader} from "../lib/substrate/SubstrateHeader.sol";
import {SubstrateTrie} from "../lib/substrate/SubstrateTrie.sol";
import {Secp256k1} from "../lib/Secp256k1.sol";

/// @title PortaldotLightClient
/// @notice BEEFY light client of Portaldot V3, for BNB Chain.
///
///         1. `submitCommitment` accepts a BEEFY commitment signed by more than two thirds of the
///            current validator set and stores the MMR root it carries.
///         2. `importHeader` proves a block hash against a stored MMR root, then checks a header
///            hashes to it and stores the header's state root.
///         3. `rotate` reads `Beefy::ValidatorSetId` and `Beefy::NextAuthorities` from an imported
///            header of the current session and installs the next validator set.
///
///         There is no owner, no pause and no upgrade: the client is defined by its checkpoint.
///         Relayers can delay it but cannot make it accept anything the validators did not sign.
contract PortaldotLightClient {
    /// @notice BEEFY payload id of the MMR root ("mh").
    bytes2 public constant MMR_ROOT_PAYLOAD_ID = 0x6d68;

    /// @dev twox128("Beefy") ‖ twox128("ValidatorSetId")
    bytes internal constant VALIDATOR_SET_ID_KEY = hex"08c41974a97dbf15cfbec28365bea2da8f05bccc2f70ec66a32999c5761156be";
    /// @dev twox128("Beefy") ‖ twox128("NextAuthorities")
    bytes internal constant NEXT_AUTHORITIES_KEY = hex"08c41974a97dbf15cfbec28365bea2daaacf00b9b41fda7a9268821c2a2b3e4c";

    /// @notice Id of the validator set whose signatures are accepted.
    uint64 public currentSetId;
    /// @notice Highest block number of an accepted commitment.
    uint32 public latestBlock;
    /// @notice MMR root committed at a BEEFY-finalized block (zero if unknown).
    mapping(uint32 blockNumber => bytes32) public mmrRootAt;
    /// @notice State root of an imported header (zero if not imported).
    mapping(uint32 blockNumber => bytes32) public stateRootOf;

    address[] private _signers;

    /// @notice A commitment (or the checkpoint) was accepted.
    event CommitmentImported(uint32 blockNumber, bytes32 mmrRoot, uint64 setId);
    /// @notice A header was proven and its state root stored.
    event HeaderImported(uint32 number, bytes32 hash, bytes32 stateRoot);
    /// @notice Validator set `newSetId` is now the only one accepted.
    event SetRotated(uint64 newSetId);

    /// @notice The checkpoint has no signers.
    error EmptyValidatorSet();
    /// @notice A checkpoint signer is the zero address.
    error ZeroSigner(uint256 index);
    /// @notice The commitment bytes are not a well-formed SCALE commitment.
    error MalformedCommitment();
    /// @notice The commitment has no "mh" payload.
    error MissingMmrRoot();
    /// @notice The commitment was signed by a set other than the current one.
    error UnknownValidatorSet(uint64 setId, uint64 currentSetId);
    /// @notice The commitment is not newer than the latest accepted one.
    error StaleCommitment(uint32 blockNumber, uint32 latestBlock);
    /// @notice Indices and signatures differ in length.
    error LengthMismatch();
    /// @notice Fewer signatures than the BEEFY threshold.
    error NotEnoughSignatures(uint256 provided, uint256 required);
    /// @notice Validator indices repeat or are out of order.
    error IndicesNotAscending(uint256 position);
    /// @notice A validator index is outside the current set.
    error IndexOutOfRange(uint256 index);
    /// @notice A signature does not recover to the validator at its index.
    error InvalidSignature(uint256 position);
    /// @notice No accepted commitment at that block.
    error UnknownCommitment(uint32 commitmentBlock);
    /// @notice The MMR proof is not for leaf `number` of a `commitmentBlock`-leaf MMR.
    error ProofLayoutMismatch();
    /// @notice The header's leaf is not in the committed MMR.
    error HeaderNotInMmr();
    /// @notice No imported header at that number.
    error UnknownHeader(uint32 number);
    /// @notice The proof does not show ValidatorSetId and NextAuthorities.
    error MissingStorage();
    /// @notice The header belongs to another session than the current set's.
    error WrongSetId(uint64 provenSetId, uint64 currentSetId);
    /// @notice NextAuthorities is not a non-empty `Vec<[u8; 33]>`.
    error MalformedAuthorities();
    /// @notice The number of uncompressed keys differs from NextAuthorities.
    error KeyCountMismatch(uint256 provided, uint256 expected);
    /// @notice An uncompressed key is not a point on secp256k1.
    error OffCurveKey(uint256 index);
    /// @notice An uncompressed key does not compress to the stored authority key.
    error KeyMismatch(uint256 index);

    /// @param setId id of the validator set in force at the checkpoint
    /// @param initialSigners Ethereum-style addresses of that set's BEEFY keys, in authority order
    /// @param checkpointBlock a BEEFY-finalized block
    /// @param checkpointMmrRoot the MMR root committed at `checkpointBlock`
    constructor(uint64 setId, address[] memory initialSigners, uint32 checkpointBlock, bytes32 checkpointMmrRoot) {
        if (initialSigners.length == 0) revert EmptyValidatorSet();
        for (uint256 i = 0; i < initialSigners.length; i++) {
            if (initialSigners[i] == address(0)) revert ZeroSigner(i);
        }
        currentSetId = setId;
        _signers = initialSigners;
        latestBlock = checkpointBlock;
        mmrRootAt[checkpointBlock] = checkpointMmrRoot;
        emit CommitmentImported(checkpointBlock, checkpointMmrRoot, setId);
    }

    // ------------------------------------------------------------------ views

    /// @notice Signer addresses of the current validator set, in authority order.
    function signers() external view returns (address[] memory) {
        return _signers;
    }

    /// @notice Signatures a commitment needs: n - floor((n - 1) / 3), BEEFY's threshold.
    function threshold() public view returns (uint256) {
        uint256 n = _signers.length;
        return n - (n - 1) / 3;
    }

    // ------------------------------------------------------------------ commitments

    /// @notice Accepts a signed BEEFY commitment and stores its MMR root.
    /// @param commitmentScale SCALE `Commitment { payload, blockNumber: u32, validatorSetId: u64 }`
    /// @param validatorIndices strictly ascending authority indices of the signers
    /// @param signatures 65-byte `r ‖ s ‖ v` signatures over keccak256(commitmentScale), one per index
    function submitCommitment(
        bytes calldata commitmentScale,
        uint256[] calldata validatorIndices,
        bytes[] calldata signatures
    ) external {
        (bytes32 mmrRoot, uint32 blockNumber, uint64 setId) = decodeCommitment(commitmentScale);
        if (setId != currentSetId) revert UnknownValidatorSet(setId, currentSetId);
        if (blockNumber <= latestBlock) revert StaleCommitment(blockNumber, latestBlock);
        if (validatorIndices.length != signatures.length) revert LengthMismatch();
        uint256 required = threshold();
        if (signatures.length < required) revert NotEnoughSignatures(signatures.length, required);

        bytes32 digest = keccak256(commitmentScale);
        uint256 n = _signers.length;
        for (uint256 i = 0; i < signatures.length; i++) {
            uint256 idx = validatorIndices[i];
            if (i > 0 && idx <= validatorIndices[i - 1]) revert IndicesNotAscending(i);
            if (idx >= n) revert IndexOutOfRange(idx);
            if (_recover(digest, signatures[i]) != _signers[idx]) revert InvalidSignature(i);
        }

        latestBlock = blockNumber;
        mmrRootAt[blockNumber] = mmrRoot;
        emit CommitmentImported(blockNumber, mmrRoot, setId);
    }

    /// @notice Decodes a SCALE BEEFY commitment.
    /// @return mmrRoot the 32-byte payload under id "mh"
    /// @return blockNumber the committed block
    /// @return setId the id of the validator set that signed it
    function decodeCommitment(bytes calldata commitmentScale)
        public
        pure
        returns (bytes32 mmrRoot, uint32 blockNumber, uint64 setId)
    {
        bytes memory c = commitmentScale;
        (uint32 items, uint256 off) = Scale.decodeCompactU32(c, 0);
        bool found;
        for (uint256 i = 0; i < items; i++) {
            bytes2 id = bytes2((uint16(Scale.readU8(c, off)) << 8) | Scale.readU8(c, off + 1));
            uint32 len;
            (len, off) = Scale.decodeCompactU32(c, off + 2);
            if (off + len > c.length) revert MalformedCommitment();
            if (id == MMR_ROOT_PAYLOAD_ID) {
                if (found || len != 32) revert MalformedCommitment();
                mmrRoot = Scale.readBytes32(c, off);
                found = true;
            }
            off += len;
        }
        if (!found) revert MissingMmrRoot();
        if (off + 12 != c.length) revert MalformedCommitment();
        blockNumber = Scale.readU32LE(c, off);
        setId = Scale.readU64LE(c, off + 4);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, v, r, s);
        return err == ECDSA.RecoverError.NoError ? signer : address(0);
    }

    // ------------------------------------------------------------------ headers

    /// @notice Proves a Portaldot header against the MMR root of an accepted commitment and stores
    ///         its state root.
    /// @dev Leaf `n` of the MMR at block C holds `(n, hash(n))` and C has C leaves, so the proof must
    ///      be for leaf index `number` in an MMR of `commitmentBlock` leaves.
    /// @param commitmentBlock block number of an accepted commitment
    /// @param headerScale SCALE header bytes
    /// @param p MMR proof of the header's leaf
    /// @return number the header's block number
    function importHeader(uint32 commitmentBlock, bytes calldata headerScale, MmrLeafProof calldata p)
        external
        returns (uint32 number)
    {
        bytes32 root = mmrRootAt[commitmentBlock];
        if (root == bytes32(0)) revert UnknownCommitment(commitmentBlock);
        bytes32 hash;
        bytes32 stateRoot;
        (hash, number, stateRoot) = SubstrateHeader.decode(headerScale);
        if (p.leafIndex != number || p.leafCount != commitmentBlock) revert ProofLayoutMismatch();
        if (!Mmr.verify(root, Mmr.leafHash(number, hash), p)) revert HeaderNotInMmr();
        stateRootOf[number] = stateRoot;
        emit HeaderImported(number, hash, stateRoot);
    }

    // ------------------------------------------------------------------ set handoff

    /// @notice Installs validator set `currentSetId + 1` from the state of an imported header of
    ///         the current session.
    /// @dev After this call only the new set's commitments are accepted. A relayer keeps latency
    ///      lowest by rotating once the next session has begun, proving a header with the last
    ///      commitment it archived from the outgoing set, then submitting the new session's first
    ///      (mandatory) commitment straight away.
    /// @param headerNumber an imported header whose state has `Beefy::ValidatorSetId == currentSetId`
    /// @param proof main-trie read proof of `Beefy::ValidatorSetId` and `Beefy::NextAuthorities`
    /// @param uncompressedKeys `[x, y]` of each next authority, in order; each must lie on the
    ///        curve and compress to the stored 33-byte key
    function rotate(uint32 headerNumber, bytes[] calldata proof, uint256[2][] calldata uncompressedKeys) external {
        bytes32 root = stateRootOf[headerNumber];
        if (root == bytes32(0)) revert UnknownHeader(headerNumber);

        bytes[] memory keys = new bytes[](2);
        keys[0] = VALIDATOR_SET_ID_KEY;
        keys[1] = NEXT_AUTHORITIES_KEY;
        (bytes[] memory values, bool[] memory present) = SubstrateTrie.readMain(root, proof, keys);
        if (!present[0] || !present[1]) revert MissingStorage();
        if (values[0].length != 8) revert MissingStorage();
        uint64 proven = Scale.readU64LE(values[0], 0);
        if (proven != currentSetId) revert WrongSetId(proven, currentSetId);

        bytes memory auth = values[1];
        (uint256 n, uint256 off) = Scale.decodeLength(auth, 0, 33);
        if (n == 0 || off + n * 33 != auth.length) revert MalformedAuthorities();
        if (uncompressedKeys.length != n) revert KeyCountMismatch(uncompressedKeys.length, n);

        address[] memory next = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 x = uncompressedKeys[i][0];
            uint256 y = uncompressedKeys[i][1];
            if (!Secp256k1.isOnCurve(x, y)) revert OffCurveKey(i);
            if (!Secp256k1.compressesTo(x, y, auth, off + i * 33)) revert KeyMismatch(i);
            next[i] = Secp256k1.toAddress(x, y);
        }

        uint64 newSetId = proven + 1;
        currentSetId = newSetId;
        _signers = next;
        emit SetRotated(newSetId);
    }
}
