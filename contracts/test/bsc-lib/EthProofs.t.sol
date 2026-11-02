// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BscFixtures} from "./BscFixtures.sol";
import {EthProofs} from "../../src/lib/bsc/EthProofs.sol";
import {EthereumTrie} from "@polytope-labs/solidity-merkle-trees/EthereumTrie.sol";
import {StorageValue} from "@polytope-labs/solidity-merkle-trees/trie/Node.sol";

/// @dev External wrapper so reverts inside the library can be asserted.
contract EthProofsHarness {
    function receiptLog(bytes32 root, bytes memory key, bytes[] memory proof, uint256 logIndex)
        external
        pure
        returns (address, bytes32[] memory, bytes memory)
    {
        return EthProofs.receiptLog(root, key, proof, logIndex);
    }

    function storageAt(bytes32 stateRoot, address account, bytes[] memory accountProof, bytes32 slot, bytes[] memory storageProof)
        external
        pure
        returns (bytes32, bool)
    {
        return EthProofs.storageAt(stateRoot, account, accountProof, slot, storageProof);
    }

    function get(bytes32 root, bytes[] memory proof, bytes memory key) external pure returns (bytes memory) {
        return EthProofs.get(root, proof, key);
    }
}

/// @dev Polytope Labs' verifier, kept as an independent reference for differential checks.
contract PolytopeOracle {
    function get(bytes32 root, bytes[] memory proof, bytes memory key) external pure returns (bytes memory) {
        bytes[] memory keys = new bytes[](1);
        keys[0] = key;
        StorageValue[] memory values = EthereumTrie.VerifyProof(root, proof, keys);
        return values[0].value;
    }
}

contract EthProofsTest is BscFixtures {
    EthProofsHarness internal lib;

    function setUp() public {
        lib = new EthProofsHarness();
    }

    // ---- receipts ----

    function test_receiptLogReal() public view {
        _checkReceipt(".typed");
        _checkReceipt(".legacy");
    }

    function test_typedReceiptIsTyped() public view {
        string memory receipts = _fixture("bsc-receipt.json");
        assertEq(vm.parseJsonUint(receipts, ".typed.txType"), 2);
        assertEq(vm.parseJsonUint(receipts, ".legacy.txType"), 0);
    }

    function test_receiptRejectsTampered() public {
        string memory receipts = _fixture("bsc-receipt.json");
        bytes32 root = vm.parseJsonBytes32(receipts, ".receiptsRoot");
        bytes memory key = vm.parseJsonBytes(receipts, ".legacy.key");
        bytes[] memory proof = vm.parseJsonBytesArray(receipts, ".legacy.proof");
        uint256 logIndex = vm.parseJsonUint(receipts, ".legacy.logIndex");

        // A flipped byte in the leaf (the receipt itself) breaks the hash link to its parent.
        bytes[] memory tampered = _copy(proof);
        bytes memory leaf = tampered[tampered.length - 1];
        leaf[leaf.length - 1] = bytes1(uint8(leaf[leaf.length - 1]) ^ 0x01);
        vm.expectRevert();
        lib.receiptLog(root, key, tampered, logIndex);

        // A different root.
        vm.expectRevert();
        lib.receiptLog(keccak256("another root"), key, proof, logIndex);

        // The proof for one transaction does not prove another index.
        vm.expectRevert();
        lib.receiptLog(root, hex"01", proof, logIndex);
    }

    function test_receiptRejectsMissingKey() public {
        string memory receipts = _fixture("bsc-receipt.json");
        bytes32 root = vm.parseJsonBytes32(receipts, ".receiptsRoot");
        bytes[] memory proof = vm.parseJsonBytesArray(receipts, ".typed.proof");
        // Index 0x7f is not in a five-transaction block; the path ends in an empty branch slot.
        vm.expectRevert(EthProofs.ReceiptNotFound.selector);
        lib.receiptLog(root, hex"7f", proof, 0);
    }

    function test_receiptRejectsLogIndexOutOfRange() public {
        string memory receipts = _fixture("bsc-receipt.json");
        bytes32 root = vm.parseJsonBytes32(receipts, ".receiptsRoot");
        bytes memory key = vm.parseJsonBytes(receipts, ".legacy.key");
        bytes[] memory proof = vm.parseJsonBytesArray(receipts, ".legacy.proof");
        uint256 count = vm.parseJsonUint(receipts, ".legacy.logCount");
        vm.expectRevert(abi.encodeWithSelector(EthProofs.LogIndexOutOfRange.selector, count, count));
        lib.receiptLog(root, key, proof, count);
    }

    // ---- storage ----

    function test_storageExistingAndAbsent() public view {
        string memory storage_ = _fixture("bsc-storage.json");
        bytes32 stateRoot = vm.parseJsonBytes32(storage_, ".stateRoot");
        address account = vm.parseJsonAddress(storage_, ".account");
        bytes[] memory accountProof = vm.parseJsonBytesArray(storage_, ".accountProof");

        (bytes32 value, bool exists) = lib.storageAt(
            stateRoot,
            account,
            accountProof,
            vm.parseJsonBytes32(storage_, ".existing.slot"),
            vm.parseJsonBytesArray(storage_, ".existing.proof")
        );
        assertTrue(exists, "existing slot");
        assertEq(value, vm.parseJsonBytes32(storage_, ".existing.value"));
        assertEq(value, bytes32(0x5772617070656420424e42000000000000000000000000000000000000000016)); // "Wrapped BNB"

        (value, exists) = lib.storageAt(
            stateRoot,
            account,
            accountProof,
            vm.parseJsonBytes32(storage_, ".absent.slot"),
            vm.parseJsonBytesArray(storage_, ".absent.proof")
        );
        assertFalse(exists, "absent slot");
        assertEq(value, bytes32(0));

        // The absent slot is the Outbox layout slot of the absent key: keccak256(abi.encode(key, 0)).
        bytes32 key = vm.parseJsonBytes32(storage_, ".absentKey");
        assertEq(keccak256(abi.encode(key, uint256(0))), vm.parseJsonBytes32(storage_, ".absent.slot"));
    }

    function test_storageOfAbsentAccount() public view {
        string memory storage_ = _fixture("bsc-storage.json");
        (bytes32 value, bool exists) = lib.storageAt(
            vm.parseJsonBytes32(storage_, ".stateRoot"),
            vm.parseJsonAddress(storage_, ".absentAccount.account"),
            vm.parseJsonBytesArray(storage_, ".absentAccount.accountProof"),
            bytes32(0),
            new bytes[](0)
        );
        assertFalse(exists);
        assertEq(value, bytes32(0));
    }

    function test_storageRejectsTampered() public {
        string memory storage_ = _fixture("bsc-storage.json");
        bytes32 stateRoot = vm.parseJsonBytes32(storage_, ".stateRoot");
        address account = vm.parseJsonAddress(storage_, ".account");
        bytes[] memory accountProof = vm.parseJsonBytesArray(storage_, ".accountProof");
        bytes32 slot = vm.parseJsonBytes32(storage_, ".existing.slot");
        bytes[] memory storageProof = vm.parseJsonBytesArray(storage_, ".existing.proof");

        // Tampered value in the storage leaf.
        bytes[] memory tampered = _copy(storageProof);
        bytes memory leaf = tampered[tampered.length - 1];
        leaf[leaf.length - 1] = bytes1(uint8(leaf[leaf.length - 1]) ^ 0x01);
        vm.expectRevert();
        lib.storageAt(stateRoot, account, accountProof, slot, tampered);

        // Proof against another state root.
        vm.expectRevert();
        lib.storageAt(keccak256("another root"), account, accountProof, slot, storageProof);

        // The account proof of one address does not prove another.
        vm.expectRevert();
        lib.storageAt(stateRoot, address(0xBEEF), accountProof, slot, storageProof);
    }

    // ---- trie walk ----

    function test_trieVectors() public view {
        string memory j = _fixture("bsc-mpt-vectors.json");
        uint256 n = vm.parseJsonUint(j, ".count");
        bytes32[] memory roots = vm.parseJsonBytes32Array(j, ".roots");
        bytes[] memory keys = vm.parseJsonBytesArray(j, ".keys");
        bytes[] memory values = vm.parseJsonBytesArray(j, ".values");
        uint256 present;
        for (uint256 i = 0; i < n; i++) {
            bytes[] memory proof = vm.parseJsonBytesArray(j, string.concat(".proofs[", vm.toString(i), "]"));
            assertEq(lib.get(roots[i], proof, keys[i]), values[i], vm.toString(i));
            if (values[i].length > 0) present++;
        }
        assertGt(present, 20);
        assertGt(n - present, 20);
    }

    function test_trieMissingNodeReverts() public {
        string memory j = _fixture("bsc-mpt-vectors.json");
        bytes32 root = vm.parseJsonBytes32Array(j, ".roots")[0];
        bytes memory key = vm.parseJsonBytesArray(j, ".keys")[0];
        bytes[] memory proof = vm.parseJsonBytesArray(j, ".proofs[0]");
        assertGt(lib.get(root, proof, key).length, 0);
        // Without its leaf, a proof for a present key must not read as "absent".
        bytes[] memory cut = new bytes[](proof.length - 1);
        for (uint256 i = 0; i < cut.length; i++) {
            cut[i] = proof[i];
        }
        vm.expectRevert(EthProofs.IncompleteProof.selector);
        lib.get(root, cut, key);
        // Nor without its root.
        vm.expectRevert(EthProofs.IncompleteProof.selector);
        lib.get(keccak256("not the root"), proof, key);
    }

    function test_trieEmptyRoot() public view {
        bytes32 empty = 0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421;
        assertEq(lib.get(empty, new bytes[](0), hex"80").length, 0);
    }

    /// @dev Flipping any bit of any node of a real proof must make the walk revert: it can never
    ///      read a different value, or "absent", for a key that is present.
    function testFuzz_tamperedNodeNeverReadsDifferently(uint256 nodeSeed, uint256 byteSeed, uint8 bit) public view {
        string memory s = _fixture("bsc-storage.json");
        bytes32 sr = vm.parseJsonBytes32(s, ".stateRoot");
        bytes[] memory proof = vm.parseJsonBytesArray(s, ".accountProof");
        bytes memory key = abi.encodePacked(keccak256(abi.encodePacked(vm.parseJsonAddress(s, ".account"))));
        bytes memory want = lib.get(sr, proof, key);
        assertGt(want.length, 0);

        uint256 n = nodeSeed % proof.length;
        bytes memory node = bytes.concat(proof[n]);
        uint256 at = byteSeed % node.length;
        node[at] = bytes1(uint8(node[at]) ^ uint8(1 << (bit % 8)));
        proof[n] = node;
        try lib.get(sr, proof, key) returns (bytes memory got) {
            assertEq(got, want, "a tampered proof read something else");
        } catch {}
    }

    function test_trieMatchesPolytopeOnRealProofs() public {
        PolytopeOracle oracle = new PolytopeOracle();
        string memory r = _fixture("bsc-receipt.json");
        bytes32 rr = vm.parseJsonBytes32(r, ".receiptsRoot");
        for (uint256 k = 0; k < 2; k++) {
            string memory at = k == 0 ? ".typed" : ".legacy";
            bytes memory key = vm.parseJsonBytes(r, string.concat(at, ".key"));
            bytes[] memory proof = vm.parseJsonBytesArray(r, string.concat(at, ".proof"));
            assertEq(lib.get(rr, proof, key), oracle.get(rr, proof, key));
        }
        string memory s = _fixture("bsc-storage.json");
        bytes32 sr = vm.parseJsonBytes32(s, ".stateRoot");
        bytes[] memory ap = vm.parseJsonBytesArray(s, ".accountProof");
        bytes memory accountKey = abi.encodePacked(keccak256(abi.encodePacked(vm.parseJsonAddress(s, ".account"))));
        assertEq(lib.get(sr, ap, accountKey), oracle.get(sr, ap, accountKey));
        bytes memory nobody = abi.encodePacked(keccak256(abi.encodePacked(vm.parseJsonAddress(s, ".absentAccount.account"))));
        bytes[] memory nap = vm.parseJsonBytesArray(s, ".absentAccount.accountProof");
        assertEq(lib.get(sr, nap, nobody), oracle.get(sr, nap, nobody));
        bytes32 storageRoot = vm.parseJsonBytes32(s, ".storageRoot");
        bytes memory slot = abi.encodePacked(keccak256(abi.encode(vm.parseJsonBytes32(s, ".existing.slot"))));
        bytes[] memory sp = vm.parseJsonBytesArray(s, ".existing.proof");
        assertEq(lib.get(storageRoot, sp, slot), oracle.get(storageRoot, sp, slot));
    }

    // ---- helpers ----

    function _checkReceipt(string memory at) internal view {
        string memory receipts = _fixture("bsc-receipt.json");
        (address emitter, bytes32[] memory topics, bytes memory data) = lib.receiptLog(
            vm.parseJsonBytes32(receipts, ".receiptsRoot"),
            vm.parseJsonBytes(receipts, string.concat(at, ".key")),
            vm.parseJsonBytesArray(receipts, string.concat(at, ".proof")),
            vm.parseJsonUint(receipts, string.concat(at, ".logIndex"))
        );
        assertEq(emitter, vm.parseJsonAddress(receipts, string.concat(at, ".emitter")));
        bytes32[] memory want = vm.parseJsonBytes32Array(receipts, string.concat(at, ".topics"));
        assertEq(topics.length, want.length);
        for (uint256 i = 0; i < want.length; i++) {
            assertEq(topics[i], want[i]);
        }
        assertEq(data, vm.parseJsonBytes(receipts, string.concat(at, ".data")));
    }

    function _copy(bytes[] memory a) internal pure returns (bytes[] memory b) {
        b = new bytes[](a.length);
        for (uint256 i = 0; i < a.length; i++) {
            b[i] = bytes.concat(a[i]);
        }
    }
}
