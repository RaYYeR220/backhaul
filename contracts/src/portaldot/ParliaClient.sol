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
///      The trusting period is checked on both clocks. On BSC's: headers[0] must be stamped within
///      it of the trusted set's epoch block. On Portaldot's: the window must land within it of the
///      moment the client installed that set (deployment for the checkpoint, the rotating window's
///      block for any later set). Header timestamps are signed by the very validators whose trust
///      expires, so only Portaldot's clock bounds how long a stale set's keys stay useful: once a
///      set has been held for a trusting period, its seals are worthless. The cost is liveness: if
///      nobody rotates the client within a trusting period of the last rotation, it can never
///      accept a window again and a new deployment is needed. The relayer refreshes the trusted
///      epoch every few days.
///
///      `submitWindow(headers)` finalizes `headers[0]` when
///        - the headers are consecutive and linked by parentHash;
///        - every seal recovers (low-s) to the header's coinbase;
///        - at least ⌈2N/3⌉ distinct members of the trusted set for headers[0] (size N) sealed;
///        - headers[0].timestamp ≤ that set's epoch timestamp + trustingPeriod, and
///          block.timestamp ≤ the time the client installed that set + trustingPeriod;
///        - in an epoch window the client rotates on, every seal belongs to the set in force at
///          its height: the trusted set below the switch, the announced set from it.
///      In every other window a seal from a validator outside the set in force at its height is
///      accepted but never counted. In a plain window, above the trusted set's first height and
///      with no epoch block to rotate to, that is any seal from outside the trusted set. In a
///      window below the current set's first height, checked by the previous set, a seal counts
///      only if its sealer belongs to the previous set and, from the current set's first height
///      on, to the current set as well. BSC testnet swaps single validators in and out almost
///      every epoch, so a set trusted days ago still shares most members with the live one, and
///      skipping keeps working without an epoch window each time. This does not weaken the rule:
///      only seals of trusted validators count, and each of them signs a header that commits to
///      headers[0] through the parent links, so ⌈2N/3⌉ trusted validators have built on
///      headers[0] whatever else sits in between. An attacker's own keys can seal a forged
///      headers[0] and its children, but the trusted validators seal the real chain, whose
///      headers do not link to the forgery.
///      Epochs between the trusted one and the window may be skipped. When headers[0] is an epoch
///      block E later than the trusted epoch, the set E announces seals from
///      E + (⌊N/2⌋+1)·turnLength (see below) and becomes the trusted set once the window passes.
///      Seals from an announced set are checked against their heights but never count towards the
///      quorum, so a forged epoch block cannot certify itself with the keys it announces. If the
///      set changed too much in skipped epochs, a window fails for lack of trusted seals and the
///      relayer submits the intermediate epoch first. A relayer may also submit every epoch; the
///      contract allows both.
///
///      The client keeps the previous trusted set as well, so a block below the current set's
///      first height can still be finalized until a second rotation. Those windows follow the
///      plain-window rule above, so a rotation (which anyone can trigger with real headers) never
///      turns a block that verified a moment ago into one that cannot verify while the previous
///      set is held. Nothing that has to be proven depends on a given block staying finalizable:
///      BscVerifier proves a commitment from the Outbox's storage at any later finalized header.
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

    /// @dev A trusted validator set, the epoch block that announced it, and when (Portaldot time)
    ///      the client installed it. Packs into two storage slots.
    struct TrustedSet {
        address[] validators;
        uint8 turnLength;
        uint64 epoch;
        uint64 activeFrom;
        uint64 epochTimestamp;
        uint48 installedAt;
    }

    /// @dev Which sets a window is checked against: `pre` below `switchAt`, `post` from it.
    ///      Only members of `pre` in force at their height count towards the quorum. Only a
    ///      rotating window rejects a seal from outside the set in force.
    struct Plan {
        address[] pre;
        address[] post;
        uint64 switchAt;
        /// @dev Epoch timestamp (BSC time) and installation time (Portaldot time) of `pre`.
        uint64 trustedSince;
        uint64 installedAt;
        bool rotates;
        uint8 postTurnLength;
    }

    /// @notice Number of finalized headers kept; header n lives in slot n % RING_SIZE.
    uint256 public constant RING_SIZE = 256;

    /// @notice Chain id the seals are bound to (97 for BSC testnet).
    uint256 public immutable chainId;
    /// @notice Blocks per epoch (1000 on BSC since Maxwell).
    uint64 public immutable epochLength;
    /// @notice Seconds a trusted set is trusted for: a window it checks must start with a header
    ///         stamped within this long of the set's epoch block, and land on Portaldot within this
    ///         long of the set's installation.
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
    /// @notice The trusted set checking the window was installed more than a trusting period ago
    ///         (both values Portaldot time, seconds).
    error TrustedSetExpired(uint64 timestamp, uint64 deadline);
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
        uint64 expiry = plan.installedAt + trustingPeriod;
        if (block.timestamp > expiry) revert TrustedSetExpired(uint64(block.timestamp), expiry);

        uint256 seen; // bit i is set once pre[i] has sealed a header of the window
        uint256 distinct;
        for (uint256 i = 0;;) {
            if (h.signer != h.coinbase) revert CoinbaseMismatch(h.number);
            uint256 idx = _indexOf(plan.pre, h.signer);
            // A seal counts only if its sealer is in `pre` and in force at its height. A seal from
            // outside the set in force passes without counting, except in a rotating window.
            bool counts = idx != type(uint256).max;
            if (plan.switchAt != type(uint64).max) {
                bool inForce = h.number < plan.switchAt ? counts : _indexOf(plan.post, h.signer) != type(uint256).max;
                if (!inForce) {
                    if (plan.rotates) revert UnauthorizedSigner(h.number, h.signer);
                    counts = false;
                }
            }
            if (counts && seen & (1 << idx) == 0) {
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
    /// @return installedAt Portaldot time the client installed it; windows it checks must land by
    ///         installedAt + trustingPeriod.
    function validatorSet()
        external
        view
        returns (
            address[] memory validators,
            uint8 turnLength,
            uint64 epoch,
            uint64 activeFrom,
            uint64 epochTimestamp,
            uint64 installedAt
        )
    {
        return _view(_current);
    }

    /// @notice The set trusted before the last rotation; it still checks windows starting in
    ///         [activeFrom, current activeFrom), within its own trusting period. Empty until the
    ///         first rotation.
    function previousValidatorSet()
        external
        view
        returns (
            address[] memory validators,
            uint8 turnLength,
            uint64 epoch,
            uint64 activeFrom,
            uint64 epochTimestamp,
            uint64 installedAt
        )
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
            plan.installedAt = current.installedAt;
            (plan.post, plan.postTurnLength) = BscHeader.parseEpochValidators(h.extra);
            _checkSet(plan.post.length, plan.postTurnLength, epochLength);
            plan.switchAt = h.number + _switchOffset(plan.pre.length, current.turnLength);
            plan.rotates = true;
        } else if (h.number >= current.activeFrom) {
            plan.pre = current.validators;
            plan.trustedSince = current.epochTimestamp;
            plan.installedAt = current.installedAt;
            plan.switchAt = type(uint64).max;
        } else {
            TrustedSet storage previous = _sets[1 - cur];
            if (previous.validators.length == 0) revert BeforeTrustedSet(h.number, current.activeFrom);
            if (h.number < previous.activeFrom) revert BeforeTrustedSet(h.number, previous.activeFrom);
            plan.pre = previous.validators;
            plan.trustedSince = previous.epochTimestamp;
            plan.installedAt = previous.installedAt;
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
        // forge-lint: disable-next-line(unsafe-typecast)
        s.installedAt = uint48(block.timestamp); // seconds; 48 bits last millions of years
        emit ValidatorSetUpdated(epoch, activeFrom, validators.length);
    }

    function _view(uint8 index)
        private
        view
        returns (
            address[] memory validators,
            uint8 turnLength,
            uint64 epoch,
            uint64 activeFrom,
            uint64 epochTimestamp,
            uint64 installedAt
        )
    {
        TrustedSet storage s = _sets[index];
        return (s.validators, s.turnLength, s.epoch, s.activeFrom, s.epochTimestamp, s.installedAt);
    }
}
