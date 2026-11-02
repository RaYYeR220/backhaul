// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PortaldotLightClient} from "../../src/bsc/PortaldotLightClient.sol";
import {PortaldotVerifier} from "../../src/bsc/PortaldotVerifier.sol";
import {PortaldotFixtures} from "./PortaldotFixtures.sol";

/// @dev Measures the BEEFY path on the live fixtures and writes results/beefy-gas-local.json.
///      `execution` is the gas used inside the call (target account pre-warmed, storage cold);
///      `calldata` is the EIP-2028 calldata cost; `transaction` adds the 21000 base.
contract BeefyGasTest is PortaldotFixtures {
    string internal constant OUT = "/../results/beefy-gas-local.json";
    string internal report = "report";
    string internal json;

    function _calldataGas(bytes memory data) internal pure returns (uint256 g) {
        for (uint256 i = 0; i < data.length; i++) {
            g += data[i] == 0 ? 4 : 16;
        }
    }

    function _record(string memory name, bytes memory data, uint256 execution) internal {
        string memory obj = name;
        vm.serializeUint(obj, "execution", execution);
        vm.serializeUint(obj, "calldataBytes", data.length);
        vm.serializeUint(obj, "calldata", _calldataGas(data));
        string memory entry = vm.serializeUint(obj, "transaction", 21_000 + _calldataGas(data) + execution);
        json = vm.serializeString(report, name, entry);
    }

    function _measure(address target, bytes memory data) internal returns (uint256 used) {
        uint256 size = target.code.length; // warms the account like a transaction's `to`
        assertGt(size, 0);
        uint256 before = gasleft();
        (bool ok, bytes memory ret) = target.call(data);
        used = before - gasleft();
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function test_recordBeefyGas() public {
        _loadBeefy();
        PortaldotLightClient lc = _deployClient();
        Commitment memory c = _commitment("commitment");
        Header memory h = _header("header");

        bytes memory submit = abi.encodeCall(lc.submitCommitment, (c.scale, c.indices, c.signatures));
        _record("submitCommitment", submit, _measure(address(lc), submit));

        bytes memory imp = abi.encodeCall(lc.importHeader, (c.blockNumber, h.scale, h.proof));
        _record("importHeader", imp, _measure(address(lc), imp));

        bytes memory rot = abi.encodeCall(lc.rotate, (h.number, _rotationProof(), _nextKeys()));
        _record("rotate", rot, _measure(address(lc), rot));

        if (vm.keyExistsJson(beefy, ".next")) {
            Commitment memory next = _commitment("next");
            bytes memory submitNext = abi.encodeCall(lc.submitCommitment, (next.scale, next.indices, next.signatures));
            _record("submitCommitmentNewSet", submitNext, _measure(address(lc), submitNext));
        }

        string memory st = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/portaldot-storage.json"));
        PortaldotVerifier v = new PortaldotVerifier(lc, vm.parseJsonAddress(st, ".mapping.address"));
        bytes memory bind =
            abi.encodeCall(v.bindTrieId, (h.number, vm.parseJsonBytesArray(st, ".mapping.accountInfoProof")));
        _record("bindTrieId", bind, _measure(address(v), bind));

        bytes memory verify = abi.encodeCall(
            v.verifyCommitment,
            (
                vm.parseJsonBytes32(st, ".mapping.key"),
                vm.parseJsonBytes32(st, ".mapping.value"),
                vm.parseJsonBytes(st, ".mapping.commitmentProof")
            )
        );
        _record("verifyCommitment", verify, _measure(address(v), verify));
        assertTrue(abi.decode(_call(address(v), verify), (bool)));

        bytes memory absence = abi.encodeCall(
            v.verifyAbsence,
            (
                vm.parseJsonBytes32(st, ".mapping.absentKey"),
                uint64(vm.parseJsonUint(st, ".timestampMs") / 1000),
                vm.parseJsonBytes(st, ".mapping.absenceProof")
            )
        );
        _record("verifyAbsence", absence, _measure(address(v), absence));
        assertTrue(abi.decode(_call(address(v), absence), (bool)));

        vm.serializeString(report, "network", "local forge EVM (cancun), live Portaldot V3 testnet fixtures");
        vm.serializeUint(report, "commitmentBlock", c.blockNumber);
        vm.serializeUint(report, "headerNumber", h.number);
        json = vm.serializeUint(report, "validators", lc.signers().length);
        vm.writeJson(json, string.concat(vm.projectRoot(), OUT));
    }

    function _call(address target, bytes memory data) internal view returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.staticcall(data);
        assertTrue(ok);
    }
}
