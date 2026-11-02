// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Outbox} from "../../src/core/Outbox.sol";

contract OutboxTest is Test {
    Outbox internal outbox;
    address internal app = makeAddr("app");

    function setUp() public {
        outbox = new Outbox();
    }

    function test_commitWritesNamespacedKey() public {
        vm.prank(app);
        bytes32 key = outbox.commit(bytes32(uint256(7)), bytes32(uint256(0xbeef)));
        assertEq(key, keccak256(abi.encode(app, bytes32(uint256(7)))));
        assertEq(key, outbox.keyFor(app, bytes32(uint256(7))));
        assertEq(outbox.commitments(key), bytes32(uint256(0xbeef)));
    }

    /// Other chains prove `commitments[key]` at keccak256(abi.encode(key, uint256(0))).
    function test_commitmentsLiveAtSlot0() public {
        vm.prank(app);
        bytes32 key = outbox.commit(bytes32(uint256(1)), bytes32(uint256(0x1234)));
        bytes32 slot = keccak256(abi.encode(key, uint256(0)));
        assertEq(vm.load(address(outbox), slot), bytes32(uint256(0x1234)));
    }

    function testFuzz_commitmentsLiveAtSlot0(address who, bytes32 appKey, bytes32 value) public {
        vm.assume(value != bytes32(0));
        vm.prank(who);
        bytes32 key = outbox.commit(appKey, value);
        assertEq(vm.load(address(outbox), keccak256(abi.encode(key, uint256(0)))), value);
    }

    /// The BSC-side verifier matches topics[0], topics[1] = key and data = abi.encode(value).
    function test_committedEventShape() public {
        vm.recordLogs();
        vm.prank(app);
        bytes32 key = outbox.commit(bytes32(uint256(3)), bytes32(uint256(0xcafe)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(outbox));
        assertEq(logs[0].topics.length, 2);
        assertEq(logs[0].topics[0], keccak256("Committed(bytes32,bytes32)"));
        assertEq(logs[0].topics[1], key);
        assertEq(logs[0].data, abi.encode(bytes32(uint256(0xcafe))));
    }

    function test_commitTwiceReverts() public {
        vm.startPrank(app);
        bytes32 key = outbox.commit(bytes32(uint256(1)), bytes32(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(Outbox.AlreadyCommitted.selector, key));
        outbox.commit(bytes32(uint256(1)), bytes32(uint256(2)));
        vm.stopPrank();
    }

    /// A zero value is indistinguishable from "never committed" in a storage proof.
    function test_commitZeroReverts() public {
        vm.prank(app);
        vm.expectRevert(Outbox.ZeroValue.selector);
        outbox.commit(bytes32(uint256(1)), bytes32(0));
    }

    function test_sameAppKeyDifferentAppsDontCollide() public {
        address other = makeAddr("other");
        vm.prank(app);
        bytes32 k1 = outbox.commit(bytes32(uint256(9)), bytes32(uint256(1)));
        vm.prank(other);
        bytes32 k2 = outbox.commit(bytes32(uint256(9)), bytes32(uint256(2)));
        assertTrue(k1 != k2);
        assertEq(outbox.commitments(k1), bytes32(uint256(1)));
        assertEq(outbox.commitments(k2), bytes32(uint256(2)));
    }
}
