// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

/// @notice Loads the BSC testnet fixtures written by packages/sdk/scripts/fixtures-bsc.ts.
abstract contract BscFixtures is Test {
    struct HeaderFixture {
        uint256 chainId;
        uint64 epochLength;
        uint64 epoch;
        uint64 switchHeight;
        uint256 quorum;
        bytes[] rlps;
        bytes32[] hashes;
        address[] miners;
        uint256[] numbers;
        uint256[] timestamps;
        bytes32[] stateRoots;
        bytes32[] receiptsRoots;
        address[] epochValidators;
        uint8 epochTurnLength;
        address outgoing;
        address incoming;
        uint64 firstIncomingSeal;
        CheckpointFixture checkpoint;
    }

    struct CheckpointFixture {
        uint64 epoch;
        uint64 timestamp;
        uint64 activeFrom;
        uint8 turnLength;
        address[] validators;
    }

    function _fixture(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/", name));
    }

    function _checkpoint(string memory json, string memory at) internal pure returns (CheckpointFixture memory c) {
        c.epoch = uint64(vm.parseJsonUint(json, string.concat(at, ".epoch")));
        c.timestamp = uint64(vm.parseJsonUint(json, string.concat(at, ".timestamp")));
        c.activeFrom = uint64(vm.parseJsonUint(json, string.concat(at, ".activeFrom")));
        c.turnLength = uint8(vm.parseJsonUint(json, string.concat(at, ".turnLength")));
        c.validators = vm.parseJsonAddressArray(json, string.concat(at, ".validators"));
    }

    function _headers() internal view returns (HeaderFixture memory f) {
        string memory json = _fixture("bsc-headers.json");
        f.chainId = vm.parseJsonUint(json, ".chainId");
        f.epochLength = uint64(vm.parseJsonUint(json, ".epochLength"));
        f.epoch = uint64(vm.parseJsonUint(json, ".epoch"));
        f.switchHeight = uint64(vm.parseJsonUint(json, ".switchHeight"));
        f.quorum = vm.parseJsonUint(json, ".quorum");
        f.rlps = vm.parseJsonBytesArray(json, ".rlps");
        f.hashes = vm.parseJsonBytes32Array(json, ".hashes");
        f.miners = vm.parseJsonAddressArray(json, ".miners");
        f.numbers = vm.parseJsonUintArray(json, ".numbers");
        f.timestamps = vm.parseJsonUintArray(json, ".timestamps");
        f.stateRoots = vm.parseJsonBytes32Array(json, ".stateRoots");
        f.receiptsRoots = vm.parseJsonBytes32Array(json, ".receiptsRoots");
        f.epochValidators = vm.parseJsonAddressArray(json, ".epochValidators");
        f.epochTurnLength = uint8(vm.parseJsonUint(json, ".epochTurnLength"));
        f.outgoing = vm.parseJsonAddressArray(json, ".outgoing")[0];
        f.incoming = vm.parseJsonAddressArray(json, ".incoming")[0];
        f.firstIncomingSeal = uint64(vm.parseJsonUint(json, ".firstIncomingSeal"));
        f.checkpoint = _checkpoint(json, ".checkpoint");
    }

    /// @dev rlps[from .. from+count) as a fresh array.
    function _slice(bytes[] memory all, uint256 from, uint256 count) internal pure returns (bytes[] memory out) {
        out = new bytes[](count);
        for (uint256 i = 0; i < count; i++) {
            out[i] = all[from + i];
        }
    }
}
