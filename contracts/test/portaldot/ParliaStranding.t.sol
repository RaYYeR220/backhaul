// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BscHeader} from "../../src/lib/bsc/BscHeader.sol";
import {ParliaClient} from "../../src/portaldot/ParliaClient.sol";

/// Rotations and ring evictions that anyone can trigger with real headers must not take a block
/// away from the jobs waiting on it.
///
/// Synthetic BSC chain built in the test: 9 validators, turnLength 8, epoch 1000, sealer of block n
/// = set[(n / 8) % 9] (BSC's in-turn order). On the live chain one validator was swapped at epoch
/// 2000 (v3 → X, sealing from 2040). Windows at different heights are independent segments: the
/// client never links one window to another.
contract ParliaStrandingTest is Test {
    uint256 internal constant CHAIN_ID = 97;
    uint64 internal constant EPOCH = 1000;
    uint64 internal constant TRUSTING_PERIOD = 7 days;
    uint64 internal constant T0 = 1_700_000_000;
    uint256 internal constant PK_X = 0xA11CE;

    address[] internal S; // checkpoint set
    address[] internal S2; // live set after epoch 2000: v3 swapped for X
    mapping(address => uint256) internal pkOf;
    /// Header number whose stateRoot is overridden, and the root (0 = none).
    uint64 internal rootAt;
    bytes32 internal rootOverride;

    function setUp() public virtual {
        for (uint256 i = 0; i < 9; i++) {
            S.push(vm.addr(1000 + i));
            pkOf[vm.addr(1000 + i)] = 1000 + i;
        }
        pkOf[vm.addr(PK_X)] = PK_X;
        S2 = S;
        S2[3] = vm.addr(PK_X);
    }

    /// A block below the current set that verified before a rotation still verifies after it,
    /// even though its window holds the seal of a validator the stale set does not know.
    function test_rotationDoesNotStrandBlockUnderPreviousSet() public {
        ParliaClient lc = _client();
        uint64 b = 2900; // after the live swap at 2000; the client still trusts S

        uint256 snap = vm.snapshotState();
        assertEq(lc.submitWindow(_segment(b, 56, false)), b, "plain window passes over X's seals");
        vm.revertToState(snap);

        // Anyone rotates straight to epoch 3000 (S still seals six distinct turns from 3000).
        lc.submitWindow(_segment(3000, 48, true));
        (,, uint64 epoch, uint64 activeFrom,) = lc.validatorSet();
        assertEq(epoch, 3000);
        assertEq(activeFrom, 3040);

        // b is now checked by the previous set (S), which passes over X's seal at 2904 as well.
        bytes[] memory w = _segment(b, 56, false);
        assertEq(BscHeader.parse(w[4], CHAIN_ID).signer, vm.addr(PK_X));
        assertEq(lc.submitWindow(w), b);
        assertEq(lc.finalized(b).hash, keccak256(w[0]));
    }

    // ================================================================== helpers

    function _client() internal returns (ParliaClient) {
        ParliaClient.Checkpoint memory cp =
            ParliaClient.Checkpoint({epoch: 1000, timestamp: T0, activeFrom: 1040, turnLength: 8, validators: S});
        return new ParliaClient(CHAIN_ID, EPOCH, TRUSTING_PERIOD, cp);
    }

    function _liveSet(uint64 n) internal view returns (address[] memory) {
        return n < 2040 ? S : S2;
    }

    function _sealer(uint64 n) internal view returns (address) {
        return _liveSet(n)[(n / 8) % 9];
    }

    /// `count` real headers from `from`; the first one announces the live set if `epochFirst`.
    function _segment(uint64 from, uint256 count, bool epochFirst) internal returns (bytes[] memory out) {
        out = new bytes[](count);
        bytes32 parent = keccak256(abi.encode("parent", from));
        for (uint256 i = 0; i < count; i++) {
            uint64 n = from + uint64(i);
            address[] memory announce = (i == 0 && epochFirst) ? _liveSet(n + 40) : new address[](0);
            bytes32 stateRoot = n == rootAt && rootOverride != 0 ? rootOverride : keccak256(abi.encode("state", n));
            out[i] = _header(parent, n, T0 + (n - 1000), _sealer(n), announce, stateRoot, keccak256(abi.encode("rr", n)));
            parent = keccak256(out[i]);
        }
    }

    function _header(
        bytes32 parent,
        uint64 n,
        uint64 t,
        address sealer,
        address[] memory announce,
        bytes32 stateRoot,
        bytes32 receiptsRoot
    ) internal returns (bytes memory) {
        bytes memory body = new bytes(32); // vanity
        if (announce.length != 0) {
            body = abi.encodePacked(body, uint8(announce.length));
            for (uint256 i = 0; i < announce.length; i++) {
                body = abi.encodePacked(body, announce[i], new bytes(48));
            }
            body = abi.encodePacked(body, uint8(8)); // turnLength
        }
        bytes memory unsealed = _encode(parent, sealer, stateRoot, receiptsRoot, n, t, abi.encodePacked(body, new bytes(65)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pkOf[sealer], BscHeader.sealHash(unsealed, CHAIN_ID));
        return _encode(parent, sealer, stateRoot, receiptsRoot, n, t, abi.encodePacked(body, r, s, uint8(v - 27)));
    }

    function _encode(
        bytes32 parent,
        address coinbase,
        bytes32 stateRoot,
        bytes32 receiptsRoot,
        uint64 n,
        uint64 t,
        bytes memory extra
    ) internal pure returns (bytes memory) {
        bytes memory p = abi.encodePacked(
            _str(abi.encodePacked(parent)),
            _str(abi.encodePacked(keccak256("uncles"))),
            _str(abi.encodePacked(coinbase)),
            _str(abi.encodePacked(stateRoot)),
            _str(abi.encodePacked(keccak256("tx"))),
            _str(abi.encodePacked(receiptsRoot)),
            _str(new bytes(256))
        );
        p = abi.encodePacked(
            p,
            _uint(2),
            _uint(n),
            _uint(140_000_000),
            _uint(0),
            _uint(t),
            _str(extra),
            _str(abi.encodePacked(bytes32(0))),
            _str(new bytes(8))
        );
        return abi.encodePacked(_prefix(p.length, 0xc0), p);
    }

    function _str(bytes memory b) internal pure returns (bytes memory) {
        if (b.length == 1 && uint8(b[0]) < 0x80) return b;
        return abi.encodePacked(_prefix(b.length, 0x80), b);
    }

    function _uint(uint256 x) internal pure returns (bytes memory) {
        if (x == 0) return hex"80";
        uint256 n;
        for (uint256 y = x; y != 0; y >>= 8) n++;
        bytes memory b = new bytes(n);
        for (uint256 i = 0; i < n; i++) b[n - 1 - i] = bytes1(uint8(x >> (8 * i)));
        return _str(b);
    }

    function _prefix(uint256 len, uint8 base) internal pure returns (bytes memory) {
        if (len < 56) return abi.encodePacked(uint8(base + len));
        uint256 n;
        for (uint256 y = len; y != 0; y >>= 8) n++;
        bytes memory b = new bytes(n);
        for (uint256 i = 0; i < n; i++) b[n - 1 - i] = bytes1(uint8(len >> (8 * i)));
        return abi.encodePacked(uint8(base + 55 + n), b);
    }
}
