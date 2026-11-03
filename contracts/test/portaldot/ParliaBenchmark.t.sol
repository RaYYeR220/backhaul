// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BscFixtures} from "../bsc-lib/BscFixtures.sol";
import {ParliaClient} from "../../src/portaldot/ParliaClient.sol";
import {BscVerifier} from "../../src/portaldot/BscVerifier.sol";

/// @dev EVM side of the EVM-vs-WASM benchmark: the same inputs the ink! twin gets in
///      packages/sdk/scripts/benchmark.ts, measured with forge. Writes results/benchmark-evm-local.json.
///      Windows are 16, 32 and 48 real consecutive BSC testnet headers from E+2 (epoch 140342000). With
///      9 validators and turnLength 8 only the 48-header window reaches quorum; the shorter ones verify
///      every seal and then revert with TooFewSigners, so they price the per-header work alone.
contract ParliaBenchmarkTest is BscFixtures {
    string internal constant OUT = "../results/benchmark-evm-local.json";
    uint256 internal constant FIRST = 2;

    function test_recordBenchmarkInputs() public {
        HeaderFixture memory real = _headers();
        string memory windows = "windows";
        _window(windows, "window16", real, 16);
        _window(windows, "window32", real, 32);
        string memory windowsJson = _window(windows, "window48", real, 48);

        string memory root = "benchmark";
        vm.serializeString(
            root,
            "note",
            "forge, solc 0.8.28 via-IR optimizer 200 (the Portaldot size profile changes code size, not these counts). "
            "executionGas = vm.lastCallGas on a fresh client; intrinsicGas = 21000 + 16/4 per non-zero/zero calldata byte."
        );
        vm.serializeString(root, "windows", windowsJson);
        string memory out = vm.serializeString(root, "storageProof", _storageProof());
        vm.writeJson(out, OUT);
    }

    function _window(string memory obj, string memory key, HeaderFixture memory real, uint256 count)
        internal
        returns (string memory)
    {
        ParliaClient lc = _client(real.chainId, real.epochLength, real.checkpoint);
        bytes[] memory w = _slice(real.rlps, FIRST, count);
        bytes memory data = abi.encodeCall(ParliaClient.submitWindow, (w));
        (bool ok,) = address(lc).call(data);
        uint256 used = vm.lastCallGas().gasTotalUsed;

        string memory k = string.concat("w_", key);
        vm.serializeUint(k, "headers", count);
        vm.serializeUint(k, "firstBlock", real.numbers[FIRST]);
        vm.serializeUint(k, "rlpBytes", _rlpBytes(w));
        vm.serializeUint(k, "calldataBytes", data.length);
        vm.serializeUint(k, "intrinsicGas", _intrinsic(data));
        vm.serializeBool(k, "finalizes", ok);
        string memory j = vm.serializeUint(k, "executionGas", used);
        return vm.serializeString(obj, key, j);
    }

    /// @dev BscVerifier.storageAt on the real WBNB proof (slot 0, behind an 11-node account proof).
    function _storageProof() internal returns (string memory) {
        string memory s = _fixture("bsc-storage.json");
        CheckpointFixture memory c = _checkpoint(s, ".checkpoint");
        ParliaClient lc = _client(97, 1000, c);
        uint64 n = uint64(vm.parseJsonUint(s, ".blockNumber"));
        lc.submitWindow(_slice(vm.parseJsonBytesArray(s, ".rlps"), 0, 48));
        BscVerifier v = new BscVerifier(lc, address(1));
        bytes memory data = abi.encodeCall(
            BscVerifier.storageAt,
            (
                n,
                vm.parseJsonAddress(s, ".account"),
                vm.parseJsonBytesArray(s, ".accountProof"),
                vm.parseJsonBytes32(s, ".existing.slot"),
                vm.parseJsonBytesArray(s, ".existing.proof")
            )
        );
        (bool ok, bytes memory ret) = address(v).staticcall(data);
        require(ok, "storageAt");
        (bytes32 value, bool exists) = abi.decode(ret, (bytes32, bool));
        require(exists && value == vm.parseJsonBytes32(s, ".existing.value"), "proven value");
        uint256 used = vm.lastCallGas().gasTotalUsed;

        string memory k = "storage";
        vm.serializeUint(k, "blockNumber", n);
        vm.serializeUint(k, "calldataBytes", data.length);
        vm.serializeUint(k, "intrinsicGas", _intrinsic(data));
        return vm.serializeUint(k, "executionGas", used);
    }

    function _client(uint256 chainId, uint64 epochLength, CheckpointFixture memory c) internal returns (ParliaClient) {
        return new ParliaClient(
            chainId, epochLength, 7 days, ParliaClient.Checkpoint(c.epoch, c.timestamp, c.activeFrom, c.turnLength, c.validators)
        );
    }

    function _intrinsic(bytes memory data) internal pure returns (uint256 g) {
        g = 21000;
        for (uint256 i = 0; i < data.length; i++) {
            g += data[i] == 0 ? 4 : 16;
        }
    }

    function _rlpBytes(bytes[] memory w) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < w.length; i++) {
            n += w[i].length;
        }
    }
}
