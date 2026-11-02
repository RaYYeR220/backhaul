// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PortaldotLightClient} from "../../src/bsc/PortaldotLightClient.sol";
import {MmrLeafProof} from "../../src/lib/substrate/Mmr.sol";

/// @dev Loads the live Portaldot captures in test/fixtures/portaldot-beefy.json:
///      a checkpoint at the first block of session N, two commitments of set N, a header H of
///      session N with its MMR proof and its Beefy storage proof, the next set's keys, and the
///      first commitment of set N + 1 with the last header of session N.
abstract contract PortaldotFixtures is Test {
    struct Commitment {
        bytes scale;
        uint256[] indices;
        bytes[] signatures;
        uint32 blockNumber;
        bytes32 mmrRoot;
        uint64 setId;
    }

    struct Header {
        uint32 number;
        bytes32 hash;
        bytes32 stateRoot;
        bytes scale;
        MmrLeafProof proof;
    }

    string internal beefy;

    function _loadBeefy() internal {
        beefy = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/portaldot-beefy.json"));
    }

    function _commitment(string memory key) internal view returns (Commitment memory c) {
        string memory k = string.concat(".", key);
        c.scale = vm.parseJsonBytes(beefy, string.concat(k, ".commitmentScale"));
        c.indices = vm.parseJsonUintArray(beefy, string.concat(k, ".indices"));
        c.signatures = vm.parseJsonBytesArray(beefy, string.concat(k, ".signatures"));
        c.blockNumber = uint32(vm.parseJsonUint(beefy, string.concat(k, ".blockNumber")));
        c.mmrRoot = vm.parseJsonBytes32(beefy, string.concat(k, ".mmrRoot"));
        c.setId = uint64(vm.parseJsonUint(beefy, string.concat(k, ".validatorSetId")));
    }

    function _header(string memory key) internal view returns (Header memory h) {
        string memory k = string.concat(".", key);
        h.number = uint32(vm.parseJsonUint(beefy, string.concat(k, ".number")));
        h.hash = vm.parseJsonBytes32(beefy, string.concat(k, ".hash"));
        h.stateRoot = vm.parseJsonBytes32(beefy, string.concat(k, ".stateRoot"));
        h.scale = vm.parseJsonBytes(beefy, string.concat(k, ".headerScale"));
        h.proof.leafIndex = uint64(vm.parseJsonUint(beefy, string.concat(k, ".mmrProof.leafIndex")));
        h.proof.leafCount = uint64(vm.parseJsonUint(beefy, string.concat(k, ".mmrProof.leafCount")));
        h.proof.items = vm.parseJsonBytes32Array(beefy, string.concat(k, ".mmrProof.items"));
    }

    function _setId() internal view returns (uint64) {
        return uint64(vm.parseJsonUint(beefy, ".setId"));
    }

    function _signers() internal view returns (address[] memory) {
        return vm.parseJsonAddressArray(beefy, ".signers");
    }

    function _nextKeys() internal view returns (uint256[2][] memory keys) {
        uint256[] memory xs = vm.parseJsonUintArray(beefy, ".nextAuthorities.x");
        uint256[] memory ys = vm.parseJsonUintArray(beefy, ".nextAuthorities.y");
        keys = new uint256[2][](xs.length);
        for (uint256 i = 0; i < xs.length; i++) {
            keys[i] = [xs[i], ys[i]];
        }
    }

    function _rotationProof() internal view returns (bytes[] memory) {
        return vm.parseJsonBytesArray(beefy, ".storage.proof");
    }

    function _deployClient() internal returns (PortaldotLightClient) {
        return new PortaldotLightClient(
            _setId(),
            _signers(),
            uint32(vm.parseJsonUint(beefy, ".checkpoint.blockNumber")),
            vm.parseJsonBytes32(beefy, ".checkpoint.mmrRoot")
        );
    }

    function _submit(PortaldotLightClient lc, Commitment memory c) internal {
        lc.submitCommitment(c.scale, c.indices, c.signatures);
    }

    function _import(PortaldotLightClient lc, uint32 commitmentBlock, Header memory h) internal returns (uint32) {
        return lc.importHeader(commitmentBlock, h.scale, h.proof);
    }

    /// @dev A client that accepted commitment C and imported header H.
    function _clientWithHeader() internal returns (PortaldotLightClient lc, Commitment memory c, Header memory h) {
        lc = _deployClient();
        c = _commitment("commitment");
        h = _header("header");
        _submit(lc, c);
        _import(lc, c.blockNumber, h);
    }
}
