// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BscFixtures} from "../bsc-lib/BscFixtures.sol";
import {EthProofsHarness} from "../bsc-lib/EthProofs.t.sol";
import {ParliaClient} from "../../src/portaldot/ParliaClient.sol";
import {BscVerifier} from "../../src/portaldot/BscVerifier.sol";

/// @dev Measures gas for the Parlia light client and its proofs, and writes results/parlia-gas-local.json.
contract ParliaGasTest is BscFixtures {
    struct Measured {
        uint256 headers;
        uint256 calldataBytes;
        uint256 intrinsicGas;
        uint256 executionGas;
    }

    string internal constant OUT = "../results/parlia-gas-local.json";

    function test_recordGas() public {
        string memory windows = "windows";
        string memory syn = _fixture("bsc-synthetic.json");
        bytes[] memory gas = vm.parseJsonBytesArray(syn, ".segments.gas.rlps");

        // Synthetic windows with realistic header sizes (21 fields, full bloom, attestation-sized
        // extra); the sealer changes every two blocks so each prefix finalizes.
        _record(windows, "synthetic16", _measure(_synthClient(syn), _slice(gas, 0, 16)));
        _record(windows, "synthetic32", _measure(_synthClient(syn), _slice(gas, 0, 32)));
        _record(windows, "synthetic48", _measure(_synthClient(syn), _slice(gas, 0, 48)));

        // Real BSC testnet windows.
        HeaderFixture memory real = _headers();
        _record(windows, "realEpochRotation41", _measure(_realClient(real), _slice(real.rlps, 0, 41)));
        _record(windows, "realEpochRotation48", _measure(_realClient(real), _slice(real.rlps, 0, 48)));
        string memory windowsJson =
            _record(windows, "realSkip48", _measure(_realClient(real), _slice(real.rlps, 2, 48)));

        string memory proofs = "proofs";
        _recordProofs(proofs);
        vm.serializeUint(proofs, "receiptLogLegacy", _receiptGas(".legacy"));
        string memory proofsJson = _recordVerifier(proofs, syn);

        string memory root = "root";
        vm.serializeString(
            root,
            "note",
            "Local forge measurements (solc 0.8.28, via-IR, optimizer 200). executionGas is the callee's gas "
            "(vm.lastCallGas) on a fresh client, so the finalized header goes to an empty ring slot; intrinsicGas = "
            "21000 + 16/4 gas per non-zero/zero calldata byte. proofs: library calls through an external harness. Real windows: BSC testnet epoch 140342000 (rotation) and blocks from E+2."
        );
        vm.serializeUint(root, "parliaClientCodeBytes", address(_realClient(real)).code.length);
        vm.serializeUint(root, "bscVerifierCodeBytes", address(new BscVerifier(_realClient(real), address(1))).code.length);
        vm.serializeString(root, "submitWindow", windowsJson);
        string memory out = vm.serializeString(root, "proofs", proofsJson);
        vm.writeJson(out, OUT);
    }

    // ---- measurement helpers ----

    function _measure(ParliaClient lc, bytes[] memory window) internal returns (Measured memory m) {
        bytes memory data = abi.encodeCall(ParliaClient.submitWindow, (window));
        m.headers = window.length;
        m.calldataBytes = data.length;
        m.intrinsicGas = 21000;
        for (uint256 i = 0; i < data.length; i++) {
            m.intrinsicGas += data[i] == 0 ? 4 : 16;
        }
        lc.submitWindow(window);
        m.executionGas = vm.lastCallGas().gasTotalUsed;
    }

    function _record(string memory obj, string memory key, Measured memory m) internal returns (string memory) {
        string memory k = string.concat("m_", key);
        vm.serializeUint(k, "headers", m.headers);
        vm.serializeUint(k, "calldataBytes", m.calldataBytes);
        vm.serializeUint(k, "intrinsicGas", m.intrinsicGas);
        string memory j = vm.serializeUint(k, "executionGas", m.executionGas);
        return vm.serializeString(obj, key, j);
    }

    function _recordProofs(string memory obj) internal {
        vm.serializeUint(obj, "receiptLogTyped", _receiptGas(".typed"));
        string memory s = _fixture("bsc-storage.json");
        bytes32 stateRoot = vm.parseJsonBytes32(s, ".stateRoot");
        address account = vm.parseJsonAddress(s, ".account");
        bytes[] memory accountProof = vm.parseJsonBytesArray(s, ".accountProof");
        vm.serializeUint(
            obj,
            "storageAtExisting",
            _storageGas(
                stateRoot,
                account,
                accountProof,
                vm.parseJsonBytes32(s, ".existing.slot"),
                vm.parseJsonBytesArray(s, ".existing.proof")
            )
        );
        vm.serializeUint(
            obj,
            "storageAtAbsent",
            _storageGas(
                stateRoot,
                account,
                accountProof,
                vm.parseJsonBytes32(s, ".absent.slot"),
                vm.parseJsonBytesArray(s, ".absent.proof")
            )
        );
    }

    /// @dev BscVerifier end to end (finalized-header lookup, proof decoding, trie walk).
    function _recordVerifier(string memory obj, string memory syn) internal returns (string memory) {
        ParliaClient lc = _synthClient(syn);
        lc.submitWindow(vm.parseJsonBytesArray(syn, ".segments.verifier.rlps"));
        BscVerifier v = new BscVerifier(lc, vm.parseJsonAddress(syn, ".verifier.outbox"));
        require(
            v.verifyCommitment(
                vm.parseJsonBytes32(syn, ".verifier.key1"),
                vm.parseJsonBytes32(syn, ".verifier.value1"),
                vm.parseJsonBytes(syn, ".verifier.encoded.commitment1")
            )
        );
        vm.serializeUint(obj, "verifyCommitmentSynthetic", vm.lastCallGas().gasTotalUsed);
        require(
            v.verifyAbsence(
                vm.parseJsonBytes32(syn, ".verifier.absentKey"), 0, vm.parseJsonBytes(syn, ".verifier.encoded.absent")
            )
        );
        vm.serializeUint(obj, "verifyAbsenceSynthetic", vm.lastCallGas().gasTotalUsed);

        // Real WBNB storage on BSC testnet: an absent slot behind an 11-node account proof.
        string memory s = _fixture("bsc-storage.json");
        CheckpointFixture memory c = _checkpoint(s, ".checkpoint");
        ParliaClient rlc = new ParliaClient(
            97, 1000, 7 days, ParliaClient.Checkpoint(c.epoch, c.timestamp, c.activeFrom, c.turnLength, c.validators)
        );
        rlc.submitWindow(_slice(vm.parseJsonBytesArray(s, ".rlps"), 0, 48));
        BscVerifier rv = new BscVerifier(rlc, vm.parseJsonAddress(s, ".account"));
        bytes memory proof = abi.encode(
            uint64(vm.parseJsonUint(s, ".blockNumber")),
            vm.parseJsonBytesArray(s, ".accountProof"),
            vm.parseJsonBytesArray(s, ".absent.proof")
        );
        require(rv.verifyAbsence(vm.parseJsonBytes32(s, ".absentKey"), 0, proof));
        return vm.serializeUint(obj, "verifyAbsenceReal", vm.lastCallGas().gasTotalUsed);
    }

    function _receiptGas(string memory at) internal returns (uint256 used) {
        string memory r = _fixture("bsc-receipt.json");
        bytes32 root = vm.parseJsonBytes32(r, ".receiptsRoot");
        bytes memory key = vm.parseJsonBytes(r, string.concat(at, ".key"));
        bytes[] memory proof = vm.parseJsonBytesArray(r, string.concat(at, ".proof"));
        uint256 logIndex = vm.parseJsonUint(r, string.concat(at, ".logIndex"));
        EthProofsHarness lib = new EthProofsHarness();
        lib.receiptLog(root, key, proof, logIndex);
        used = vm.lastCallGas().gasTotalUsed;
    }

    function _storageGas(bytes32 root, address account, bytes[] memory ap, bytes32 slot, bytes[] memory sp)
        internal
        returns (uint256 used)
    {
        EthProofsHarness lib = new EthProofsHarness();
        lib.storageAt(root, account, ap, slot, sp);
        used = vm.lastCallGas().gasTotalUsed;
    }

    function _realClient(HeaderFixture memory real) internal returns (ParliaClient) {
        CheckpointFixture memory c = real.checkpoint;
        return new ParliaClient(
            real.chainId,
            real.epochLength,
            7 days,
            ParliaClient.Checkpoint(c.epoch, c.timestamp, c.activeFrom, c.turnLength, c.validators)
        );
    }

    function _synthClient(string memory syn) internal returns (ParliaClient) {
        CheckpointFixture memory c = _checkpoint(syn, ".checkpoints.A1000");
        return new ParliaClient(
            vm.parseJsonUint(syn, ".chainId"),
            uint64(vm.parseJsonUint(syn, ".epochLength")),
            uint64(vm.parseJsonUint(syn, ".trustingPeriod")),
            ParliaClient.Checkpoint(c.epoch, c.timestamp, c.activeFrom, c.turnLength, c.validators)
        );
    }
}
