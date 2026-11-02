// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BscHeader, ParsedHeader} from "../lib/bsc/BscHeader.sol";

/// @title ParliaClient
/// @notice Light client of BNB Smart Chain (Parlia consensus) for Portaldot's EVM. It finalizes BSC
///         headers from the validators' ECDSA seals and keeps the last {RING_SIZE} finalized headers
///         for proof verification. It has no owner, no pause and no upgrade path.
///
/// @dev Security model — skipping verification, as in IBC / Tendermint light clients:
///      a header is accepted if ≥ 2/3 of the last trusted validator set sealed a window above it,
///      within the trusting period.
///
///      `submitWindow(headers)` finalizes `headers[0]` when
///        - the headers are consecutive and linked by parentHash;
///        - every seal recovers to the header's coinbase and to a member of the set in force at
///          that height, as far as the client knows it;
///        - at least ⌈2N/3⌉ distinct members of the trusted set for headers[0] (size N) sealed;
///        - headers[0].timestamp ≤ that set's epoch timestamp + trustingPeriod.
///      Epochs between the trusted one and the window may be skipped. When headers[0] is an epoch
///      block E later than the trusted epoch, the set E announces seals from
///      E + (⌊N/2⌋+1)·turnLength (see below) and becomes the trusted set once the window passes.
///      Seals from an announced set are checked against their heights but never count towards the
///      quorum, so a forged epoch block cannot certify itself with the keys it announces. If the
///      set changed too much in skipped epochs, a window simply fails and the relayer submits the
///      intermediate epoch first. A relayer may also submit every epoch; the contract allows both.
///
///      The client keeps the previous trusted set as well, so a block below the current set's
///      first height stays provable until a second rotation: anyone can advance the trusted epoch
///      with real headers, and this leaves the relayer at least one epoch to finalize any block.
///
///      Not checked: BLS fast-finality votes (no BLS12-381 precompile on Portaldot), turn order,
///      difficulty, gas and timestamp rules. Those only matter if 2/3 of a trusted set misbehave,
///      which this model assumes they do not.
///
///      Validator switch. In bsc consensus/parlia/snapshot.go `Snapshot.apply`, the header at
///      E + minerHistoryCheckLen() is checked against the old set (lines 318–323) and only then is
///      the set from epoch block E installed (line 374:
///      `if number > 0 && number%epochLength == snap.minerHistoryCheckLen() {`), with
///      minerHistoryCheckLen() = (len(Validators)/2+1)*TurnLength - 1 (lines 243–245) over the set
///      in force before the switch. Headers are verified against their parent's snapshot
///      (consensus/parlia/parlia.go lines 706–713), so the new set and its turn length seal from
///      E + (⌊N_old/2⌋+1)·turnLength_old — E+40 on BSC testnet today (9 validators, turnLength 8).
///      Source: https://github.com/bnb-chain/bsc/blob/947ba1cb1ef05d4a5f71b738113a3d8b4c16f6b7/consensus/parlia/snapshot.go#L374
///      Confirmed on chain 97 at epoch 140342000: parlia_getSnapshot holds the old set after
///      140342038 and the new one after 140342039.
contract ParliaClient {
    /// @notice A finalized BSC header, reduced to what proof verifiers need.
    struct FinalizedHeader {
        bytes32 hash;
        uint64 number;
        uint64 timestamp;
        bytes32 stateRoot;
        bytes32 receiptsRoot;
    }

    /// @notice Trusted starting point: an epoch block and the validator set it announced.
    /// @param epoch Epoch block number (a multiple of the epoch length).
    /// @param timestamp That block's timestamp; the trusting period counts from here.
    /// @param activeFrom First height sealed by `validators` (epoch + (⌊N_prev/2⌋+1)·turnLength_prev).
    /// @param turnLength Turn length announced together with `validators`.
    struct Checkpoint {
        uint64 epoch;
        uint64 timestamp;
        uint64 activeFrom;
        uint8 turnLength;
        address[] validators;
    }

    /// @dev A trusted validator set and the epoch block that announced it.
    struct TrustedSet {
        address[] validators;
        uint8 turnLength;
        uint64 epoch;
        uint64 activeFrom;
        uint64 epochTimestamp;
    }

    /// @dev Which sets a window is checked against: `pre` below `switchAt`, `post` from it.
    ///      Only members of `pre` count towards the quorum.
    struct Plan {
        address[] pre;
        address[] post;
        uint64 switchAt;
        uint64 trustedSince;
        bool rotates;
        uint8 postTurnLength;
    }

    /// @notice Number of finalized headers kept; header n lives in slot n % RING_SIZE.
    uint256 public constant RING_SIZE = 256;

    /// @notice Chain id the seals are bound to (97 for BSC testnet).
    uint256 public immutable chainId;
    /// @notice Blocks per epoch (1000 on BSC since Maxwell).
    uint64 public immutable epochLength;
    /// @notice Seconds after a trusted epoch block during which its set is trusted.
    uint64 public immutable trustingPeriod;

    /// @dev Current and previous trusted sets; a rotation overwrites the previous one in place.
    TrustedSet[2] private _sets;
    uint8 private _current;

    FinalizedHeader[RING_SIZE] private _ring;

    /// @notice A header became final.
    event Finalized(uint64 number, bytes32 hash);
    /// @notice The trusted validator set changed to the one announced at `epoch`.
    event ValidatorSetUpdated(uint64 epoch, uint64 effectiveFrom, uint256 size);

    error EmptyWindow();
    error BrokenLink(uint64 number);
    error CoinbaseMismatch(uint64 number);
    error UnauthorizedSigner(uint64 number, address signer);
    error TooFewSigners(uint256 signers, uint256 quorum);
    error BeforeTrustedSet(uint64 number, uint64 lowest);
    error TrustingPeriodExpired(uint64 timestamp, uint64 deadline);
    error AlreadyFinalized(uint64 number);
    error NotFinalized(uint64 number);
    error InvalidCheckpoint();
    error InvalidValidatorSet();

    constructor(uint256 chainId_, uint64 epochLength_, uint64 trustingPeriod_, Checkpoint memory checkpoint) {
        if (chainId_ == 0 || epochLength_ == 0 || trustingPeriod_ == 0) revert InvalidCheckpoint();
        if (checkpoint.epoch % epochLength_ != 0) revert InvalidCheckpoint();
        if (checkpoint.activeFrom <= checkpoint.epoch || checkpoint.activeFrom >= checkpoint.epoch + epochLength_) {
            revert InvalidCheckpoint();
        }
        _checkSet(checkpoint.validators.length, checkpoint.turnLength, epochLength_);

        chainId = chainId_;
        epochLength = epochLength_;
        trustingPeriod = trustingPeriod_;
        _write(0, checkpoint.validators, checkpoint.turnLength, checkpoint.epoch, checkpoint.activeFrom, checkpoint.timestamp);
    }

    /// @notice Finalizes `headersRlp[0]` from the seals of the window above it.
    /// @param headersRlp Consecutive BSC headers, RLP-encoded, lowest first.
    /// @return finalizedNumber The number of `headersRlp[0]`.
    function submitWindow(bytes[] calldata headersRlp) external returns (uint64 finalizedNumber) {
        uint256 count = headersRlp.length;
        if (count == 0) revert EmptyWindow();

        ParsedHeader memory h = BscHeader.parse(headersRlp[0], chainId);
        ParsedHeader memory first = h;
        finalizedNumber = h.number;

        uint8 cur = _current;
        Plan memory plan = _plan(h, cur);
        uint64 deadline = plan.trustedSince + trustingPeriod;
        if (h.timestamp > deadline) revert TrustingPeriodExpired(h.timestamp, deadline);

        uint256 seen; // bit i is set once pre[i] has sealed a header of the window
        uint256 distinct;
        for (uint256 i = 0;;) {
            if (h.signer != h.coinbase) revert CoinbaseMismatch(h.number);
            uint256 idx = _indexOf(plan.pre, h.signer);
            if (h.number < plan.switchAt) {
                if (idx == type(uint256).max) revert UnauthorizedSigner(h.number, h.signer);
            } else if (_indexOf(plan.post, h.signer) == type(uint256).max) {
                revert UnauthorizedSigner(h.number, h.signer);
            }
            if (idx != type(uint256).max && seen & (1 << idx) == 0) {
                seen |= 1 << idx;
                ++distinct;
            }

            if (++i == count) break;
            ParsedHeader memory next = BscHeader.parse(headersRlp[i], chainId);
            if (next.number != h.number + 1 || next.parentHash != h.hash) revert BrokenLink(next.number);
            h = next;
        }

        uint256 quorum = (2 * plan.pre.length + 2) / 3;
        if (distinct < quorum) revert TooFewSigners(distinct, quorum);

        _store(first);
        if (plan.rotates) {
            uint8 next = 1 - cur;
            _write(next, plan.post, plan.postTurnLength, first.number, plan.switchAt, first.timestamp);
            _current = next;
        }
    }

    /// @notice A finalized header still held in the ring.
    /// @dev Reverts with {NotFinalized} if `number` was never finalized or has been overwritten.
    function finalized(uint64 number) external view returns (FinalizedHeader memory header) {
        header = _ring[number % RING_SIZE];
        if (header.number != number || number == 0) revert NotFinalized(number);
    }

    /// @notice The trusted validator set and the epoch block that announced it.
    /// @return validators Current trusted set.
    /// @return turnLength Its turn length.
    /// @return epoch Epoch block that announced it.
    /// @return activeFrom First height it seals.
    /// @return epochTimestamp Timestamp of `epoch`; windows it checks must start by epochTimestamp + trustingPeriod.
    function validatorSet()
        external
        view
        returns (address[] memory validators, uint8 turnLength, uint64 epoch, uint64 activeFrom, uint64 epochTimestamp)
    {
        return _view(_current);
    }

    /// @notice The set trusted before the last rotation; it still checks windows starting in
    ///         [activeFrom, current activeFrom). Empty until the first rotation.
    function previousValidatorSet()
        external
        view
        returns (address[] memory validators, uint8 turnLength, uint64 epoch, uint64 activeFrom, uint64 epochTimestamp)
    {
        return _view(1 - _current);
    }

    // ---------------------------------------------------------------------------------------------

    /// @dev Picks the sets that check a window starting with `h`.
    function _plan(ParsedHeader memory h, uint8 cur) private view returns (Plan memory plan) {
        TrustedSet storage current = _sets[cur];
        if (h.number % epochLength == 0 && h.number > current.epoch) {
            // A later epoch block: its own set takes over at its switch height.
            plan.pre = current.validators;
            plan.trustedSince = current.epochTimestamp;
            (plan.post, plan.postTurnLength) = BscHeader.parseEpochValidators(h.extra);
            _checkSet(plan.post.length, plan.postTurnLength, epochLength);
            plan.switchAt = h.number + _switchOffset(plan.pre.length, current.turnLength);
            plan.rotates = true;
        } else if (h.number >= current.activeFrom) {
            plan.pre = current.validators;
            plan.trustedSince = current.epochTimestamp;
            plan.switchAt = type(uint64).max;
        } else {
            TrustedSet storage previous = _sets[1 - cur];
            if (previous.validators.length == 0) revert BeforeTrustedSet(h.number, current.activeFrom);
            if (h.number < previous.activeFrom) revert BeforeTrustedSet(h.number, previous.activeFrom);
            plan.pre = previous.validators;
            plan.trustedSince = previous.epochTimestamp;
            plan.post = current.validators;
            plan.switchAt = current.activeFrom;
        }
    }

    /// @dev Blocks from an epoch block to the first block its set seals: minerHistoryCheckLen() + 1,
    ///      computed over the set in force before the switch.
    function _switchOffset(uint256 setSize, uint8 turnLength) private pure returns (uint64) {
        return uint64((setSize / 2 + 1) * turnLength);
    }

    /// @dev A set must fit the signer bitmap and switch inside its epoch.
    function _checkSet(uint256 size, uint8 turnLength, uint64 epochLength_) private pure {
        if (size == 0 || size > 255 || turnLength == 0) revert InvalidValidatorSet();
        if (_switchOffset(size, turnLength) >= epochLength_) revert InvalidValidatorSet();
    }

    function _indexOf(address[] memory set, address who) private pure returns (uint256) {
        for (uint256 i = 0; i < set.length; ++i) {
            if (set[i] == who) return i;
        }
        return type(uint256).max;
    }

    function _store(ParsedHeader memory h) private {
        FinalizedHeader storage slot = _ring[h.number % RING_SIZE];
        if (slot.number == h.number) revert AlreadyFinalized(h.number);
        slot.hash = h.hash;
        slot.number = h.number;
        slot.timestamp = h.timestamp;
        slot.stateRoot = h.stateRoot;
        slot.receiptsRoot = h.receiptsRoot;
        emit Finalized(h.number, h.hash);
    }

    function _write(
        uint8 index,
        address[] memory validators,
        uint8 turnLength,
        uint64 epoch,
        uint64 activeFrom,
        uint64 timestamp
    ) private {
        TrustedSet storage s = _sets[index];
        s.validators = validators;
        s.turnLength = turnLength;
        s.epoch = epoch;
        s.activeFrom = activeFrom;
        s.epochTimestamp = timestamp;
        emit ValidatorSetUpdated(epoch, activeFrom, validators.length);
    }

    function _view(uint8 index)
        private
        view
        returns (address[] memory validators, uint8 turnLength, uint64 epoch, uint64 activeFrom, uint64 epochTimestamp)
    {
        TrustedSet storage s = _sets[index];
        return (s.validators, s.turnLength, s.epoch, s.activeFrom, s.epochTimestamp);
    }
}
