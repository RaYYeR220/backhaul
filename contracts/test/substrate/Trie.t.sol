// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SubstrateTrie} from "../../src/lib/substrate/SubstrateTrie.sol";

contract TrieHarness {
    function readMain(bytes32 root, bytes[] memory proof, bytes[] memory keys)
        external
        view
        returns (bytes[] memory, bool[] memory)
    {
        return SubstrateTrie.readMain(root, proof, keys);
    }

    function readChild(
        bytes32 root,
        bytes[] memory mainProof,
        bytes[] memory childProof,
        bytes memory childInfoKey,
        bytes[] memory keys
    ) external view returns (bytes[] memory, bool[] memory) {
        return SubstrateTrie.readChild(root, mainProof, childProof, childInfoKey, keys);
    }
}

/// @dev Real `state_getReadProof` / `state_getChildReadProof` output from Portaldot (blake2_256 nodes,
///      trie layout V1).
contract TrieTest is Test {
    TrieHarness internal t;
    string internal beefy;
    string internal st;
    bytes32 internal headerRoot;

    function setUp() public {
        t = new TrieHarness();
        beefy = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/portaldot-beefy.json"));
        st = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/portaldot-storage.json"));
        headerRoot = vm.parseJsonBytes32(beefy, ".header.stateRoot");
    }

    function _one(bytes memory key) internal pure returns (bytes[] memory k) {
        k = new bytes[](1);
        k[0] = key;
    }

    function test_readsInlineAndHashedValues() public view {
        bytes[] memory keys = new bytes[](2);
        keys[0] = vm.parseJsonBytes(beefy, ".storage.validatorSetIdKey");
        keys[1] = vm.parseJsonBytes(beefy, ".storage.nextAuthoritiesKey");
        (bytes[] memory v, bool[] memory p) = t.readMain(headerRoot, vm.parseJsonBytesArray(beefy, ".storage.proof"), keys);
        assertTrue(p[0] && p[1]);
        // ValidatorSetId: an 8-byte value stored inline.
        assertEq(v[0], abi.encodePacked(_le64(uint64(vm.parseJsonUint(beefy, ".setId")))));
        // NextAuthorities: 1 + 2 × 33 = 67 bytes, above the 32-byte inline limit, so stored by hash.
        bytes[] memory next = vm.parseJsonBytesArray(beefy, ".nextAuthorities.compressed");
        assertEq(v[1], bytes.concat(hex"08", next[0], next[1]));
    }

    function test_readsTimestampAndChildRoot() public view {
        (, bytes[] memory main,) = abi.decode(vm.parseJsonBytes(st, ".mapping.absenceProof"), (uint32, bytes[], bytes[]));
        bytes[] memory keys = new bytes[](2);
        keys[0] = vm.parseJsonBytes(st, ".timestampKey");
        keys[1] = bytes.concat(SubstrateTrie.CHILD_STORAGE_PREFIX, vm.parseJsonBytes32(st, ".mapping.trieId"));
        (bytes[] memory v, bool[] memory p) = t.readMain(headerRoot, main, keys);
        assertTrue(p[0] && p[1]);
        assertEq(v[0], abi.encodePacked(_le64(uint64(vm.parseJsonUint(st, ".timestampMs")))));
        assertEq(v[1].length, 32);
    }

    function test_readsChildSlot() public view {
        bytes[] memory keys = new bytes[](2);
        keys[0] = abi.encodePacked(vm.parseJsonBytes32(st, ".generic.slot.key"));
        keys[1] = abi.encodePacked(vm.parseJsonBytes32(st, ".generic.emptySlot.key"));
        // One child proof per key; merge them to read both in one call.
        bytes[] memory a = vm.parseJsonBytesArray(st, ".generic.slot.childProof");
        bytes[] memory b = vm.parseJsonBytesArray(st, ".generic.emptySlot.childProof");
        bytes[] memory child = new bytes[](a.length + b.length);
        for (uint256 i = 0; i < a.length; i++) {
            child[i] = a[i];
        }
        for (uint256 i = 0; i < b.length; i++) {
            child[a.length + i] = b[i];
        }
        (bytes[] memory v, bool[] memory p) = t.readChild(
            headerRoot,
            vm.parseJsonBytesArray(st, ".generic.mainProof"),
            child,
            vm.parseJsonBytes(st, ".generic.childInfoKey"),
            keys
        );
        assertTrue(p[0]);
        assertEq(bytes32(v[0]), vm.parseJsonBytes32(st, ".generic.slot.value"));
        assertFalse(p[1]);
        assertEq(v[1].length, 0);
    }

    function test_rejectsWrongRoot() public {
        vm.expectRevert(SubstrateTrie.IncompleteProof.selector);
        t.readMain(
            keccak256("not a root"),
            vm.parseJsonBytesArray(beefy, ".storage.proof"),
            _one(vm.parseJsonBytes(beefy, ".storage.validatorSetIdKey"))
        );
    }

    function test_rejectsMissingHashedValue() public {
        // Drop each node in turn: the walk to NextAuthorities (including its hashed value) breaks.
        bytes[] memory proof = vm.parseJsonBytesArray(beefy, ".storage.proof");
        bytes memory key = vm.parseJsonBytes(beefy, ".storage.nextAuthoritiesKey");
        for (uint256 skip = 0; skip < proof.length; skip++) {
            bytes[] memory p = new bytes[](proof.length - 1);
            uint256 j;
            for (uint256 i = 0; i < proof.length; i++) {
                if (i != skip) p[j++] = proof[i];
            }
            try t.readMain(headerRoot, p, _one(key)) returns (bytes[] memory, bool[] memory) {
                // The only node the walk may not need is the ValidatorSetId leaf.
                (bytes[] memory v,) = t.readMain(headerRoot, p, _one(key));
                assertEq(v[0].length, 67);
            } catch (bytes memory reason) {
                assertEq(bytes4(reason), SubstrateTrie.IncompleteProof.selector);
            }
        }
    }

    function test_rejectsBadChildRoot() public {
        // ValidatorSetId (8 bytes) read as if it were a child root.
        vm.expectRevert(SubstrateTrie.InvalidChildRoot.selector);
        t.readChild(
            headerRoot,
            vm.parseJsonBytesArray(beefy, ".storage.proof"),
            new bytes[](0),
            vm.parseJsonBytes(beefy, ".storage.validatorSetIdKey"),
            _one(hex"00")
        );
    }

    function _le64(uint64 v) internal pure returns (bytes8 r) {
        for (uint256 i = 0; i < 8; i++) {
            r |= bytes8(bytes1(uint8(v >> (8 * i)))) >> (8 * i);
        }
    }
}
