// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Blake2b256} from "../../src/lib/substrate/Blake2b256.sol";
import {Scale} from "../../src/lib/substrate/Scale.sol";
import {SubstrateHeader} from "../../src/lib/substrate/SubstrateHeader.sol";

/// @dev External wrappers so reverts surface as call reverts.
contract SubstrateLibHarness {
    function blake2b256(bytes memory data) external view returns (bytes32) {
        return Blake2b256.hash(data);
    }

    function decodeCompactU32(bytes memory b, uint256 off) external pure returns (uint32, uint256) {
        return Scale.decodeCompactU32(b, off);
    }

    function readU32LE(bytes memory b, uint256 off) external pure returns (uint32) {
        return Scale.readU32LE(b, off);
    }

    function readU64LE(bytes memory b, uint256 off) external pure returns (uint64) {
        return Scale.readU64LE(b, off);
    }

    function decodeHeader(bytes memory h) external view returns (bytes32, uint32, bytes32) {
        return SubstrateHeader.decode(h);
    }
}

contract HeaderTest is Test {
    SubstrateLibHarness internal h;
    string internal headerJson;
    string internal blakeJson;

    function setUp() public {
        h = new SubstrateLibHarness();
        headerJson = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/portaldot-header.json"));
        blakeJson = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/portaldot-blake2.json"));
    }

    // ---------------------------------------------------------------- blake2b

    function test_blake2bKnownVectors() public view {
        assertEq(h.blake2b256(""), 0x0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8);
        assertEq(h.blake2b256("abc"), 0xbddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319);
    }

    function test_blake2bMatchesPolkadotVectors() public view {
        uint256 n = vm.parseJsonUint(blakeJson, ".count");
        assertGt(n, 10);
        for (uint256 i = 0; i < n; i++) {
            string memory p = string.concat(".vectors[", vm.toString(i), "]");
            bytes memory input = vm.parseJsonBytes(blakeJson, string.concat(p, ".input"));
            bytes32 expected = vm.parseJsonBytes32(blakeJson, string.concat(p, ".hash"));
            assertEq(h.blake2b256(input), expected, string.concat("vector ", vm.toString(i)));
        }
    }

    // ---------------------------------------------------------------- header

    function test_headerHashMatchesChain() public view {
        bytes memory headerScale = vm.parseJsonBytes(headerJson, ".headerScale");
        bytes32 blockHash = vm.parseJsonBytes32(headerJson, ".blockHash");
        assertEq(h.blake2b256(headerScale), blockHash);
        (bytes32 hash,,) = h.decodeHeader(headerScale);
        assertEq(hash, blockHash);
    }

    function test_decodeNumberAndStateRoot() public view {
        bytes memory headerScale = vm.parseJsonBytes(headerJson, ".headerScale");
        (, uint32 number, bytes32 stateRoot) = h.decodeHeader(headerScale);
        assertEq(number, vm.parseJsonUint(headerJson, ".blockNumber"));
        assertEq(stateRoot, vm.parseJsonBytes32(headerJson, ".stateRoot"));
    }

    /// Headers whose numbers use each compact width (1, 2 and 4 bytes).
    function test_decodeHeadersOfEveryCompactWidth() public view {
        uint256 n = vm.parseJsonUint(headerJson, ".moreCount");
        assertGe(n, 3);
        for (uint256 i = 0; i < n; i++) {
            string memory p = string.concat(".more[", vm.toString(i), "]");
            bytes memory headerScale = vm.parseJsonBytes(headerJson, string.concat(p, ".headerScale"));
            (bytes32 hash, uint32 number, bytes32 stateRoot) = h.decodeHeader(headerScale);
            assertEq(hash, vm.parseJsonBytes32(headerJson, string.concat(p, ".blockHash")));
            assertEq(number, vm.parseJsonUint(headerJson, string.concat(p, ".blockNumber")));
            assertEq(stateRoot, vm.parseJsonBytes32(headerJson, string.concat(p, ".stateRoot")));
        }
    }

    function test_rejectsTruncatedHeader() public {
        bytes memory headerScale = vm.parseJsonBytes(headerJson, ".headerScale");
        bytes memory cut = new bytes(80);
        for (uint256 i = 0; i < cut.length; i++) {
            cut[i] = headerScale[i];
        }
        vm.expectRevert(Scale.ScaleOutOfBounds.selector);
        h.decodeHeader(cut);
    }

    // ---------------------------------------------------------------- SCALE

    function test_compactSingleByte() public view {
        (uint32 v, uint256 off) = h.decodeCompactU32(hex"fc", 0);
        assertEq(v, 63);
        assertEq(off, 1);
    }

    function test_compactTwoByte() public view {
        (uint32 v, uint256 off) = h.decodeCompactU32(hex"aa1501", 1); // 0x0115 >> 2 == 69
        assertEq(v, 69);
        assertEq(off, 3);
        (v,) = h.decodeCompactU32(hex"fdff", 0);
        assertEq(v, 16383);
    }

    function test_compactFourByte() public view {
        (uint32 v, uint256 off) = h.decodeCompactU32(hex"02000100", 0);
        assertEq(v, 16384);
        assertEq(off, 4);
        (v,) = h.decodeCompactU32(hex"feffffff", 0);
        assertEq(v, (1 << 30) - 1);
    }

    function test_compactBigIntegerMode() public view {
        (uint32 v, uint256 off) = h.decodeCompactU32(hex"0300000040", 0);
        assertEq(v, 1 << 30);
        assertEq(off, 5);
        (v,) = h.decodeCompactU32(hex"03ffffffff", 0);
        assertEq(v, type(uint32).max);
    }

    function test_compactRejectsNonCanonical() public {
        vm.expectRevert(Scale.ScaleNonCanonical.selector);
        h.decodeCompactU32(hex"0100", 0); // 0 in two-byte mode
        vm.expectRevert(Scale.ScaleNonCanonical.selector);
        h.decodeCompactU32(hex"02000000", 0); // 0 in four-byte mode
        vm.expectRevert(Scale.ScaleNonCanonical.selector);
        h.decodeCompactU32(hex"03ffffff3f", 0); // < 2^30 in big-integer mode
    }

    function test_compactRejectsWiderThanU32() public {
        vm.expectRevert(Scale.ScaleCompactTooLarge.selector);
        h.decodeCompactU32(hex"070000000001", 0);
    }

    function test_compactRejectsShortInput() public {
        vm.expectRevert(Scale.ScaleOutOfBounds.selector);
        h.decodeCompactU32(hex"01", 0);
        vm.expectRevert(Scale.ScaleOutOfBounds.selector);
        h.decodeCompactU32(hex"020000", 0);
        vm.expectRevert(Scale.ScaleOutOfBounds.selector);
        h.decodeCompactU32(hex"", 0);
    }

    function test_readLittleEndian() public view {
        assertEq(h.readU32LE(hex"ff78563412", 1), 0x12345678);
        assertEq(h.readU64LE(hex"efcdab8967452301", 0), 0x0123456789abcdef);
    }

    function testFuzz_compactRoundTrip(uint32 v) public view {
        bytes memory enc = _encodeCompact(v);
        (uint32 got, uint256 off) = h.decodeCompactU32(enc, 0);
        assertEq(got, v);
        assertEq(off, enc.length);
    }

    function _encodeCompact(uint32 v) internal pure returns (bytes memory) {
        if (v < 1 << 6) return abi.encodePacked(uint8(v << 2));
        if (v < 1 << 14) {
            uint16 x = uint16((v << 2) | 1);
            return abi.encodePacked(uint8(x), uint8(x >> 8));
        }
        if (v < 1 << 30) {
            uint32 x = (v << 2) | 2;
            return abi.encodePacked(uint8(x), uint8(x >> 8), uint8(x >> 16), uint8(x >> 24));
        }
        return abi.encodePacked(uint8(3), uint8(v), uint8(v >> 8), uint8(v >> 16), uint8(v >> 24));
    }
}
