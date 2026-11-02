// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PortaldotLightClient} from "../../src/bsc/PortaldotLightClient.sol";
import {PortaldotVerifier} from "../../src/bsc/PortaldotVerifier.sol";
import {SubstrateTrie} from "../../src/lib/substrate/SubstrateTrie.sol";
import {PortaldotFixtures} from "./PortaldotFixtures.sol";

/// @dev Exposes the internal slot read for the generic (non-Outbox) checks.
contract PortaldotVerifierHarness is PortaldotVerifier {
    constructor(PortaldotLightClient lc, address outbox) PortaldotVerifier(lc, outbox) {}

    function readSlot(uint32 headerNumber, bytes[] memory mainProof, bytes[] memory childProof, bytes32 slot)
        external
        view
        returns (bytes32, bool)
    {
        return _readSlot(headerNumber, mainProof, childProof, slot);
    }
}

/// @dev Uses two live revive contracts at header H: a generic one (slot 0 set, slot 0xff empty)
///      and an ERC-20 whose balances mapping is slot 0, the same layout as the Outbox's
///      `commitments`, so `verifyCommitment` runs end to end on real chain data.
contract PortaldotVerifierTest is PortaldotFixtures {
    PortaldotLightClient internal lc;
    PortaldotVerifierHarness internal generic;
    PortaldotVerifierHarness internal mapping_;
    string internal st;
    uint32 internal h;

    event TrieIdBound(bytes32 trieId, uint32 headerNumber);

    function setUp() public {
        _loadBeefy();
        st = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/portaldot-storage.json"));
        Header memory hdr;
        (lc,, hdr) = _clientWithHeader();
        h = hdr.number;
        assertEq(h, vm.parseJsonUint(st, ".headerNumber"), "storage fixture is for the imported header");
        assertEq(lc.stateRootOf(h), vm.parseJsonBytes32(st, ".stateRoot"));
        generic = new PortaldotVerifierHarness(lc, vm.parseJsonAddress(st, ".generic.address"));
        mapping_ = new PortaldotVerifierHarness(lc, vm.parseJsonAddress(st, ".mapping.address"));
    }

    function _bytesArr(string memory path) internal view returns (bytes[] memory) {
        return vm.parseJsonBytesArray(st, path);
    }

    function _bindBoth() internal {
        generic.bindTrieId(h, _bytesArr(".generic.accountInfoProof"));
        mapping_.bindTrieId(h, _bytesArr(".mapping.accountInfoProof"));
    }

    function _deadline() internal view returns (uint64) {
        return uint64(vm.parseJsonUint(st, ".timestampMs") / 1000);
    }

    // ------------------------------------------------------------------ binding

    function test_bindTrieIdFromProof() public {
        bytes32 expected = vm.parseJsonBytes32(st, ".generic.trieId");
        assertEq(expected, 0xf8244662038395131abadc58f715834defcb7df28233a1abefc887d4e7bc4253);
        vm.expectEmit(address(generic));
        emit TrieIdBound(expected, h);
        generic.bindTrieId(h, _bytesArr(".generic.accountInfoProof"));
        assertEq(generic.trieId(), expected);

        mapping_.bindTrieId(h, _bytesArr(".mapping.accountInfoProof"));
        assertEq(mapping_.trieId(), vm.parseJsonBytes32(st, ".mapping.trieId"));
    }

    function test_bindTrieIdOnlyOnce() public {
        _bindBoth();
        vm.expectRevert(PortaldotVerifier.AlreadyBound.selector);
        generic.bindTrieId(h, _bytesArr(".generic.accountInfoProof"));
    }

    function test_bindRejectsProofForAnotherAccount() public {
        // The verifier for the generic contract cannot be bound with the ERC-20's account proof.
        vm.expectRevert();
        generic.bindTrieId(h, _bytesArr(".mapping.accountInfoProof"));
        assertEq(generic.trieId(), bytes32(0));
    }

    function test_bindRejectsUnknownHeader() public {
        vm.expectRevert(abi.encodeWithSelector(PortaldotVerifier.UnknownHeader.selector, h + 1));
        generic.bindTrieId(h + 1, _bytesArr(".generic.accountInfoProof"));
    }

    // ------------------------------------------------------------------ generic slot reads

    function test_readsRealSlot() public {
        _bindBoth();
        (bytes32 v, bool present) = generic.readSlot(
            h,
            _bytesArr(".generic.mainProof"),
            _bytesArr(".generic.slot.childProof"),
            vm.parseJsonBytes32(st, ".generic.slot.slot")
        );
        assertTrue(present);
        assertEq(v, vm.parseJsonBytes32(st, ".generic.slot.value"));
        assertTrue(v != bytes32(0));
    }

    function test_readsEmptySlot() public {
        _bindBoth();
        (bytes32 v, bool present) = generic.readSlot(
            h,
            _bytesArr(".generic.mainProof"),
            _bytesArr(".generic.emptySlot.childProof"),
            vm.parseJsonBytes32(st, ".generic.emptySlot.slot")
        );
        assertFalse(present);
        assertEq(v, bytes32(0));
    }

    function test_rejectTamperedChildProof() public {
        _bindBoth();
        bytes[] memory main = _bytesArr(".generic.mainProof");
        bytes32 slot = vm.parseJsonBytes32(st, ".generic.slot.slot");
        uint256 n = _bytesArr(".generic.slot.childProof").length;
        for (uint256 i = 0; i < n; i++) {
            bytes[] memory child = _bytesArr(".generic.slot.childProof");
            child[i][child[i].length - 1] = child[i][child[i].length - 1] ^ 0x01;
            vm.expectRevert(SubstrateTrie.IncompleteProof.selector);
            generic.readSlot(h, main, child, slot);
        }
        // A value proven under another slot's proof.
        vm.expectRevert(SubstrateTrie.IncompleteProof.selector);
        generic.readSlot(h, main, _bytesArr(".generic.emptySlot.childProof"), slot);
    }

    function test_rejectTamperedMainProof() public {
        _bindBoth();
        bytes[] memory main = _bytesArr(".generic.mainProof");
        main[0][main[0].length - 1] = main[0][main[0].length - 1] ^ 0x01;
        vm.expectRevert(SubstrateTrie.IncompleteProof.selector);
        generic.readSlot(
            h, main, _bytesArr(".generic.slot.childProof"), vm.parseJsonBytes32(st, ".generic.slot.slot")
        );
    }

    // ------------------------------------------------------------------ Outbox semantics

    function test_outboxSlotLayout() public view {
        bytes32 key = vm.parseJsonBytes32(st, ".mapping.key");
        assertEq(mapping_.outboxSlot(key), vm.parseJsonBytes32(st, ".mapping.slot"));
        assertEq(mapping_.outboxSlot(key), keccak256(abi.encode(key, uint256(0))));
    }

    function test_verifyCommitmentOnLiveMapping() public {
        _bindBoth();
        bytes32 key = vm.parseJsonBytes32(st, ".mapping.key");
        bytes32 value = vm.parseJsonBytes32(st, ".mapping.value");
        bytes memory proof = vm.parseJsonBytes(st, ".mapping.commitmentProof");
        assertTrue(mapping_.verifyCommitment(key, value, proof));
        assertFalse(mapping_.verifyCommitment(key, bytes32(uint256(value) + 1), proof));
        assertFalse(mapping_.verifyCommitment(key, bytes32(0), proof));
    }

    function test_verifyCommitmentRejectsOtherKey() public {
        _bindBoth();
        bytes32 value = vm.parseJsonBytes32(st, ".mapping.value");
        bytes memory proof = vm.parseJsonBytes(st, ".mapping.commitmentProof");
        // The child proof covers the real key's path only: another key either needs nodes the proof
        // lacks (revert) or its path ends early (absent). It is never accepted.
        try mapping_.verifyCommitment(keccak256("another key"), value, proof) returns (bool ok) {
            assertFalse(ok);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), SubstrateTrie.IncompleteProof.selector);
        }
    }

    function test_verifyCommitmentWrongVerifier() public {
        _bindBoth();
        // The same proof checked by a verifier bound to another contract.
        bytes32 key = vm.parseJsonBytes32(st, ".mapping.key");
        bytes32 value = vm.parseJsonBytes32(st, ".mapping.value");
        vm.expectRevert(SubstrateTrie.IncompleteProof.selector);
        generic.verifyCommitment(key, value, vm.parseJsonBytes(st, ".mapping.commitmentProof"));
    }

    function test_absenceOfEmptySlot() public {
        _bindBoth();
        bytes32 absentKey = vm.parseJsonBytes32(st, ".mapping.absentKey");
        bytes memory proof = vm.parseJsonBytes(st, ".mapping.absenceProof");
        assertTrue(mapping_.verifyAbsence(absentKey, _deadline(), proof));
        assertTrue(mapping_.verifyAbsence(absentKey, 0, proof));
    }

    function test_absenceRejectsBeforeDeadline() public {
        _bindBoth();
        bytes32 absentKey = vm.parseJsonBytes32(st, ".mapping.absentKey");
        bytes memory proof = vm.parseJsonBytes(st, ".mapping.absenceProof");
        assertFalse(mapping_.verifyAbsence(absentKey, _deadline() + 1, proof));
    }

    function test_absenceFalseWhenCommitted() public {
        _bindBoth();
        bytes32 key = vm.parseJsonBytes32(st, ".mapping.key");
        assertFalse(mapping_.verifyAbsence(key, _deadline(), vm.parseJsonBytes(st, ".mapping.presentAbsenceProof")));
    }

    function test_absenceNeedsTimestampInProof() public {
        _bindBoth();
        // The commitment proof's main part does not cover Timestamp::Now.
        bytes32 key = vm.parseJsonBytes32(st, ".mapping.key");
        vm.expectRevert(SubstrateTrie.IncompleteProof.selector);
        mapping_.verifyAbsence(key, 0, vm.parseJsonBytes(st, ".mapping.commitmentProof"));
    }

    function test_unboundReverts() public {
        bytes32 key = vm.parseJsonBytes32(st, ".mapping.key");
        bytes32 value = vm.parseJsonBytes32(st, ".mapping.value");
        vm.expectRevert(PortaldotVerifier.NotBound.selector);
        mapping_.verifyCommitment(key, value, vm.parseJsonBytes(st, ".mapping.commitmentProof"));
        vm.expectRevert(PortaldotVerifier.NotBound.selector);
        mapping_.verifyAbsence(key, 0, vm.parseJsonBytes(st, ".mapping.absenceProof"));
    }

    function test_unknownHeaderReverts() public {
        _bindBoth();
        (, bytes[] memory main, bytes[] memory child) =
            abi.decode(vm.parseJsonBytes(st, ".mapping.commitmentProof"), (uint32, bytes[], bytes[]));
        bytes memory moved = abi.encode(h - 1, main, child);
        vm.expectRevert(abi.encodeWithSelector(PortaldotVerifier.UnknownHeader.selector, h - 1));
        mapping_.verifyCommitment(
            vm.parseJsonBytes32(st, ".mapping.key"), vm.parseJsonBytes32(st, ".mapping.value"), moved
        );
    }
}
