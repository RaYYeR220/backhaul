// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BscFixtures} from "./BscFixtures.sol";
import {EthProofs} from "../../src/lib/bsc/EthProofs.sol";

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
