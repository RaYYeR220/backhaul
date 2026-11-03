// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BscVerifier} from "./BscVerifier.sol";

/// @title BscFeed
/// @notice A Chainlink price feed on BNB Smart Chain, read on Portaldot from proven BSC state:
///         the proxy's current aggregator and that aggregator's latest round, all from storage
///         proofs against a header the Parlia light client finalized. Anyone can update it; nobody
///         can set a price. Consumers read it like any Chainlink feed (AggregatorV3Interface).
/// @dev Storage layout of the BSC contracts (confirmed on BSC testnet by eth_getStorageAt against
///      their getters, and against libocr's OffchainAggregator.sol):
///      - EACAggregatorProxy: slot 2 = AggregatorProxy.currentPhase, Phase{uint16 id; address aggregator}.
///      - OCR1 OffchainAggregator ("AccessControlledOffchainAggregator 3.0.0"): slot 43 = s_hotVars,
///        with latestAggregatorRoundId (uint32) at bits 176..207; slot 44 = s_transmissions,
///        mapping(uint32 => Transmission{int192 answer; uint64 timestamp}).
///      Round ids follow the proxy: phaseId << 64 | aggregator round, so they keep rising across an
///      aggregator change. A proof must show a newer round than the stored one, at a later block.
///
///      Limits, fixed at deployment because the contract has no admin:
///      - The OCR1 layout above and `decimals` are immutable. A proxy phase change to another OCR1
///        aggregator keeps working (the aggregator is read from the proxy each time). A phase
///        change to an aggregator with another layout (OCR2, OCR3, data streams) makes {update}
///        revert with {NoData}, or read slots that mean something else: following that feed
///        needs a new BscFeed deployment.
///      - It enforces no freshness. {latestRoundData} returns the round as BSC stored it, with
///        `updatedAt` set to the time the aggregator recorded it there, not when it was proven
///        here, and anyone may prove any round newer than the stored one, not necessarily the
///        latest. Consumers check `updatedAt` against their own heartbeat;
///        {provenAtBscBlock} says which finalized BSC block the round was read from.
contract BscFeed {
    uint256 internal constant PROXY_PHASE_SLOT = 2;
    uint256 internal constant HOT_VARS_SLOT = 43;
    uint256 internal constant TRANSMISSIONS_SLOT = 44;

    /// @notice Reader of proven BSC storage.
    BscVerifier public immutable verifier;
    /// @notice The Chainlink proxy on BSC.
    address public immutable proxy;
    /// @notice Decimals of the answer (the BSC aggregator's, fixed at deployment).
    uint8 public immutable decimals;

    int192 private _answer;
    uint64 private _updatedAt;
    uint80 private _roundId;
    uint64 private _provenAt;

    /// @notice A round was proven from BSC block `bscBlock`.
    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt, uint64 bscBlock);

    error ZeroAddress();
    error NoData();
    error StaleBlock(uint64 blockNumber, uint64 provenAt);
    error StaleRound(uint80 roundId, uint80 latest);

    constructor(BscVerifier verifier_, address proxy_, uint8 decimals_) {
        if (address(verifier_) == address(0) || proxy_ == address(0)) revert ZeroAddress();
        verifier = verifier_;
        proxy = proxy_;
        decimals = decimals_;
    }

    /// @notice Proves the feed's latest round at finalized BSC block `blockNumber` and stores it.
    /// @param proxyAccountProof eth_getProof(proxy).accountProof.
    /// @param phaseProof Storage proof of the proxy's slot 2.
    /// @param aggregatorAccountProof eth_getProof(aggregator).accountProof.
    /// @param hotVarsProof Storage proof of the aggregator's slot 43.
    /// @param transmissionProof Storage proof of s_transmissions[latest round].
    /// @return roundId The proven round, in the proxy's numbering.
    function update(
        uint64 blockNumber,
        bytes[] calldata proxyAccountProof,
        bytes[] calldata phaseProof,
        bytes[] calldata aggregatorAccountProof,
        bytes[] calldata hotVarsProof,
        bytes[] calldata transmissionProof
    ) external returns (uint80 roundId) {
        if (blockNumber <= _provenAt) revert StaleBlock(blockNumber, _provenAt);

        uint256 phase = _read(blockNumber, proxy, proxyAccountProof, PROXY_PHASE_SLOT, phaseProof);
        address aggregator = address(uint160(phase >> 16));
        uint256 round = uint32(_read(blockNumber, aggregator, aggregatorAccountProof, HOT_VARS_SLOT, hotVarsProof) >> 176);
        uint256 t = _read(
            blockNumber,
            aggregator,
            aggregatorAccountProof,
            uint256(keccak256(abi.encode(round, TRANSMISSIONS_SLOT))),
            transmissionProof
        );

        roundId = uint80((uint256(uint16(phase)) << 64) | round);
        if (roundId <= _roundId) revert StaleRound(roundId, _roundId);
        int192 answer = int192(uint192(t));
        uint64 updatedAt = uint64(t >> 192);
        (_answer, _updatedAt, _roundId, _provenAt) = (answer, updatedAt, roundId, blockNumber);
        emit AnswerUpdated(answer, roundId, updatedAt, blockNumber);
    }

    /// @notice The latest proven round, as the BSC proxy reports it (startedAt = updatedAt, as on OCR1).
    ///         `updatedAt` is the round's own time on BSC; check it for staleness before use.
    function latestRoundData() public view returns (uint80, int256, uint256, uint256, uint80) {
        uint80 id = _roundId;
        if (id == 0) revert NoData();
        return (id, _answer, _updatedAt, _updatedAt, id);
    }

    /// @notice Only the latest round is kept.
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        if (roundId != _roundId) revert NoData();
        return latestRoundData();
    }

    /// @notice BSC block the latest round was proven at (0 before the first update).
    function provenAtBscBlock() external view returns (uint64) {
        return _provenAt;
    }

    function description() external pure returns (string memory) {
        return "BNB / USD, proven from BSC";
    }

    function version() external pure returns (uint256) {
        return 4;
    }

    /// @dev A slot that must exist at a finalized block.
    function _read(uint64 blockNumber, address account, bytes[] calldata accountProof, uint256 slot, bytes[] calldata proof)
        private
        view
        returns (uint256)
    {
        (bytes32 value, bool exists) = verifier.storageAt(blockNumber, account, accountProof, bytes32(slot), proof);
        if (!exists) revert NoData();
        return uint256(value);
    }
}
