// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BscFixtures} from "./BscFixtures.sol";
import {BscHeader, ParsedHeader} from "../../src/lib/bsc/BscHeader.sol";

/// @dev External wrapper so reverts inside the library can be asserted.
contract BscHeaderHarness {
    function parse(bytes memory rlp, uint256 chainId) external pure returns (ParsedHeader memory) {
        return BscHeader.parse(rlp, chainId);
    }

    function sealHash(bytes memory rlp, uint256 chainId) external pure returns (bytes32) {
        return BscHeader.sealHash(rlp, chainId);
    }

    function parseEpochValidators(bytes memory extra) external pure returns (address[] memory, uint8) {
        return BscHeader.parseEpochValidators(extra);
    }
}

contract BscHeaderTest is BscFixtures {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    BscHeaderHarness internal lib;
    HeaderFixture internal f;

    function setUp() public {
        lib = new BscHeaderHarness();
        f = _headers();
    }

    function test_hashAndSignerMatch60Headers() public view {
        assertGe(f.rlps.length, 60);
        for (uint256 i = 0; i < f.rlps.length; i++) {
            ParsedHeader memory h = lib.parse(f.rlps[i], f.chainId);
            assertEq(h.hash, f.hashes[i], "hash");
            assertEq(h.number, f.numbers[i], "number");
            assertEq(h.timestamp, f.timestamps[i], "timestamp");
            assertEq(h.coinbase, f.miners[i], "coinbase");
            assertEq(h.signer, f.miners[i], "signer");
            assertEq(h.stateRoot, f.stateRoots[i], "stateRoot");
            assertEq(h.receiptsRoot, f.receiptsRoots[i], "receiptsRoot");
            if (i > 0) assertEq(h.parentHash, f.hashes[i - 1], "parentHash");
        }
    }

    function test_parseEpochValidators() public view {
        ParsedHeader memory epoch = lib.parse(f.rlps[0], f.chainId);
        assertEq(epoch.number % f.epochLength, 0);
        (address[] memory validators, uint8 turnLength) = lib.parseEpochValidators(epoch.extra);
        assertEq(validators.length, 9);
        assertEq(turnLength, 8);
        for (uint256 i = 0; i < validators.length; i++) {
            assertEq(validators[i], f.epochValidators[i]);
        }
    }

    function test_otherChainIdRecoversSomeoneElse() public view {
        ParsedHeader memory h = lib.parse(f.rlps[1], 56);
        assertEq(h.hash, f.hashes[1], "the block hash does not depend on the chain id");
        assertTrue(h.signer != f.miners[1], "seal must commit to the chain id");
    }

    function test_tamperedFieldChangesSigner() public view {
        bytes memory rlp = bytes.concat(f.rlps[1]);
        // stateRoot sits right after parentHash (33), uncleHash (33) and coinbase (21) in the list payload.
        uint256 at = _payloadOffset(rlp) + 33 + 33 + 21 + 1;
        rlp[at] = bytes1(uint8(rlp[at]) ^ 0x01);
        ParsedHeader memory h = lib.parse(rlp, f.chainId);
        assertTrue(h.hash != f.hashes[1]);
        assertTrue(h.signer != f.miners[1]);
    }

    function test_sealHashIgnoresSeal() public view {
        bytes memory rlp = bytes.concat(f.rlps[2]);
        bytes32 before = lib.sealHash(rlp, f.chainId);
        // Flip a byte of r inside the seal: the seal hash must not move.
        uint256 sig = _sealOffset(rlp);
        rlp[sig] = bytes1(uint8(rlp[sig]) ^ 0x01);
        assertEq(lib.sealHash(rlp, f.chainId), before);
    }

    function test_rejectsHighS() public {
        bytes memory rlp = bytes.concat(f.rlps[3]);
        uint256 sig = _sealOffset(rlp);
        uint256 s;
        assembly {
            s := mload(add(add(rlp, 32), add(sig, 32)))
        }
        // (r, n - s, v ^ 1) recovers the same key; only the canonical low-s form is accepted.
        uint256 flipped = SECP256K1_N - s;
        assembly {
            mstore(add(add(rlp, 32), add(sig, 32)), flipped)
        }
        rlp[sig + 64] = bytes1(uint8(rlp[sig + 64]) ^ 0x01);
        vm.expectRevert(BscHeader.InvalidSignature.selector);
        lib.parse(rlp, f.chainId);
    }

    function test_rejectsBadRecoveryId() public {
        bytes memory rlp = bytes.concat(f.rlps[3]);
        uint256 sig = _sealOffset(rlp);
        rlp[sig + 64] = bytes1(uint8(27));
        vm.expectRevert(BscHeader.InvalidSignature.selector);
        lib.parse(rlp, f.chainId);
    }

    function test_rejectsTrailingBytes() public {
        vm.expectRevert(BscHeader.InvalidRlp.selector);
        lib.parse(bytes.concat(f.rlps[1], hex"00"), f.chainId);
    }

    function test_rejectsTruncated() public {
        bytes memory rlp = f.rlps[1];
        bytes memory cut = new bytes(rlp.length - 1);
        for (uint256 i = 0; i < cut.length; i++) {
            cut[i] = rlp[i];
        }
        vm.expectRevert(BscHeader.InvalidRlp.selector);
        lib.parse(cut, f.chainId);
    }

    function test_rejectsNotAList() public {
        vm.expectRevert(BscHeader.InvalidRlp.selector);
        lib.parse(hex"8401020304", f.chainId);
        vm.expectRevert(BscHeader.InvalidRlp.selector);
        lib.parse(hex"", f.chainId);
    }

    function test_rejectsTooFewFields() public {
        // A list of 14 empty strings.
        vm.expectRevert(BscHeader.InvalidHeader.selector);
        lib.parse(hex"ce8080808080808080808080808080", f.chainId);
    }

    function test_rejectsEpochExtraWithoutRoom() public {
        bytes memory extra = new bytes(32 + 1 + 65);
        extra[32] = bytes1(uint8(1)); // claims one validator but carries none
        vm.expectRevert(BscHeader.InvalidEpochExtra.selector);
        lib.parseEpochValidators(extra);
    }

    function test_rejectsEpochExtraWithZeroValidators() public {
        bytes memory extra = new bytes(32 + 1 + 1 + 65);
        extra[33] = bytes1(uint8(8));
        vm.expectRevert(BscHeader.InvalidEpochExtra.selector);
        lib.parseEpochValidators(extra);
    }

    function test_rejectsEpochExtraWithZeroTurnLength() public {
        ParsedHeader memory epoch = lib.parse(f.rlps[0], f.chainId);
        bytes memory extra = epoch.extra;
        extra[32 + 1 + 9 * 68] = 0x00;
        vm.expectRevert(BscHeader.InvalidEpochExtra.selector);
        lib.parseEpochValidators(extra);
    }

    // ---- helpers ----

    /// @dev Offset of the first item inside the outer list.
    function _payloadOffset(bytes memory rlp) internal pure returns (uint256) {
        uint8 b0 = uint8(rlp[0]);
        return b0 < 0xf8 ? 1 : 1 + (b0 - 0xf7);
    }

    /// @dev Offset of the 65-byte seal: the last 65 bytes of `extra`, located by content.
    function _sealOffset(bytes memory rlp) internal view returns (uint256) {
        bytes memory extra = lib.parse(rlp, f.chainId).extra;
        uint256 n = extra.length;
        for (uint256 at = 0; at + 65 <= rlp.length; at++) {
            bool same = true;
            for (uint256 j = 0; j < 65 && same; j++) {
                same = rlp[at + j] == extra[n - 65 + j];
            }
            if (same) return at;
        }
        revert("seal not found");
    }
}
