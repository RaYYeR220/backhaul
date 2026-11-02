// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PortaldotLightClient} from "../../src/bsc/PortaldotLightClient.sol";
import {MmrLeafProof} from "../../src/lib/substrate/Mmr.sol";
import {Secp256k1} from "../../src/lib/Secp256k1.sol";
import {SubstrateTrie} from "../../src/lib/substrate/SubstrateTrie.sol";
import {PortaldotFixtures} from "./PortaldotFixtures.sol";

contract PortaldotLightClientTest is PortaldotFixtures {
    PortaldotLightClient internal lc;

    event CommitmentImported(uint32 blockNumber, bytes32 mmrRoot, uint64 setId);
    event HeaderImported(uint32 number, bytes32 hash, bytes32 stateRoot);
    event SetRotated(uint64 newSetId);

    function setUp() public {
        _loadBeefy();
        lc = _deployClient();
    }

    // ------------------------------------------------------------------ checkpoint

    function test_checkpoint() public view {
        assertEq(lc.currentSetId(), _setId());
        assertEq(lc.signers(), _signers());
        uint32 cp = uint32(vm.parseJsonUint(beefy, ".checkpoint.blockNumber"));
        assertEq(lc.latestBlock(), cp);
        assertEq(lc.mmrRootAt(cp), vm.parseJsonBytes32(beefy, ".checkpoint.mmrRoot"));
        assertEq(lc.threshold(), 2); // 2 of 2 on today's testnet
    }

    function test_rejectEmptyOrZeroSigners() public {
        vm.expectRevert(PortaldotLightClient.EmptyValidatorSet.selector);
        new PortaldotLightClient(1, new address[](0), 1, bytes32(uint256(1)));
        address[] memory s = new address[](2);
        s[0] = address(1);
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.ZeroSigner.selector, 1));
        new PortaldotLightClient(1, s, 1, bytes32(uint256(1)));
    }

    function test_thresholdFormula() public {
        uint256[8] memory n = [uint256(1), 2, 3, 4, 5, 7, 10, 100];
        uint256[8] memory t = [uint256(1), 2, 3, 3, 4, 5, 7, 67];
        for (uint256 i = 0; i < n.length; i++) {
            address[] memory s = new address[](n[i]);
            for (uint256 j = 0; j < s.length; j++) {
                s[j] = address(uint160(j + 1));
            }
            assertEq(new PortaldotLightClient(1, s, 1, bytes32(uint256(1))).threshold(), t[i]);
        }
    }

    // ------------------------------------------------------------------ commitments

    function test_decodeRealCommitment() public view {
        Commitment memory c = _commitment("commitment");
        (bytes32 root, uint32 blockNumber, uint64 setId) = lc.decodeCommitment(c.scale);
        assertEq(root, c.mmrRoot);
        assertEq(blockNumber, c.blockNumber);
        assertEq(setId, c.setId);
    }

    function test_submitRealCommitment() public {
        Commitment memory c = _commitment("commitment");
        vm.expectEmit(address(lc));
        emit CommitmentImported(c.blockNumber, c.mmrRoot, c.setId);
        _submit(lc, c);
        assertEq(lc.latestBlock(), c.blockNumber);
        assertEq(lc.mmrRootAt(c.blockNumber), c.mmrRoot);
    }

    function test_submitOlderThenNewer() public {
        Commitment memory older = _commitment("older");
        Commitment memory c = _commitment("commitment");
        assertLt(older.blockNumber, c.blockNumber);
        _submit(lc, older);
        _submit(lc, c);
        assertEq(lc.mmrRootAt(older.blockNumber), older.mmrRoot);
        assertEq(lc.latestBlock(), c.blockNumber);
    }

    function test_rejectForgedSignature() public {
        Commitment memory c = _commitment("commitment");
        // A flipped bit in r.
        c.signatures[1][5] = c.signatures[1][5] ^ 0x01;
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.InvalidSignature.selector, 1));
        _submit(lc, c);
    }

    function test_rejectSignatureFromOutsider() public {
        Commitment memory c = _commitment("commitment");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xA11CE, keccak256(c.scale));
        c.signatures[0] = abi.encodePacked(r, s, v);
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.InvalidSignature.selector, 0));
        _submit(lc, c);
    }

    function test_rejectSignatureUnderWrongIndex() public {
        Commitment memory c = _commitment("commitment");
        (c.signatures[0], c.signatures[1]) = (c.signatures[1], c.signatures[0]);
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.InvalidSignature.selector, 0));
        _submit(lc, c);
    }

    function test_rejectTamperedCommitment() public {
        Commitment memory c = _commitment("commitment");
        // Byte 4 is inside the MMR root: the signatures no longer cover the message.
        c.scale[4] = c.scale[4] ^ 0xff;
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.InvalidSignature.selector, 0));
        _submit(lc, c);
    }

    function test_rejectDuplicateIndex() public {
        Commitment memory c = _commitment("commitment");
        c.indices[1] = c.indices[0];
        c.signatures[1] = c.signatures[0];
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.IndicesNotAscending.selector, 1));
        _submit(lc, c);
    }

    function test_rejectIndexOutOfRange() public {
        Commitment memory c = _commitment("commitment");
        c.indices[1] = 2;
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.IndexOutOfRange.selector, 2));
        _submit(lc, c);
    }

    function test_rejectTooFewSignatures() public {
        Commitment memory c = _commitment("commitment");
        uint256[] memory idx = new uint256[](1);
        bytes[] memory sigs = new bytes[](1);
        idx[0] = c.indices[0];
        sigs[0] = c.signatures[0];
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.NotEnoughSignatures.selector, 1, 2));
        lc.submitCommitment(c.scale, idx, sigs);
    }

    function test_rejectLengthMismatch() public {
        Commitment memory c = _commitment("commitment");
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = c.signatures[0];
        vm.expectRevert(PortaldotLightClient.LengthMismatch.selector);
        lc.submitCommitment(c.scale, c.indices, sigs);
    }

    function test_rejectStaleBlock() public {
        Commitment memory older = _commitment("older");
        Commitment memory c = _commitment("commitment");
        _submit(lc, c);
        vm.expectRevert(
            abi.encodeWithSelector(PortaldotLightClient.StaleCommitment.selector, c.blockNumber, c.blockNumber)
        );
        _submit(lc, c);
        vm.expectRevert(
            abi.encodeWithSelector(PortaldotLightClient.StaleCommitment.selector, older.blockNumber, c.blockNumber)
        );
        _submit(lc, older);
    }

    function test_rejectMalformedCommitment() public {
        Commitment memory c = _commitment("commitment");
        vm.expectRevert(PortaldotLightClient.MalformedCommitment.selector);
        lc.submitCommitment(bytes.concat(c.scale, hex"00"), c.indices, c.signatures);

        // A payload without "mh": id "xx", 32 bytes, then block and set id.
        bytes memory noRoot = bytes.concat(hex"04", "xx", hex"80", bytes32(uint256(1)), hex"0100000001000000000000");
        vm.expectRevert(PortaldotLightClient.MissingMmrRoot.selector);
        lc.decodeCommitment(noRoot);

        // "mh" with a 31-byte value.
        bytes memory shortRoot = bytes.concat(hex"04", "mh", hex"7c", new bytes(31), hex"0100000001000000000000");
        vm.expectRevert(PortaldotLightClient.MalformedCommitment.selector);
        lc.decodeCommitment(shortRoot);
    }

    function test_decodeSkipsOtherPayloads() public view {
        bytes32 root = keccak256("root");
        bytes memory twoItems =
            bytes.concat(hex"08", "ab", hex"0c", hex"010203", "mh", hex"80", root, hex"39300000", hex"0700000000000000");
        (bytes32 r, uint32 b, uint64 s) = lc.decodeCommitment(twoItems);
        assertEq(r, root);
        assertEq(b, 12345);
        assertEq(s, 7);
    }

    // ------------------------------------------------------------------ headers

    function test_importHeader() public {
        Commitment memory c = _commitment("commitment");
        Header memory h = _header("header");
        _submit(lc, c);
        vm.expectEmit(address(lc));
        emit HeaderImported(h.number, h.hash, h.stateRoot);
        assertEq(_import(lc, c.blockNumber, h), h.number);
        assertEq(lc.stateRootOf(h.number), h.stateRoot);
    }

    function test_rejectHeaderNotInMmr() public {
        Commitment memory c = _commitment("commitment");
        Header memory h = _header("header");
        _submit(lc, c);

        // A header byte changed (inside the digest): it no longer hashes to the proven leaf.
        Header memory forged = _header("header");
        forged.scale[forged.scale.length - 1] = forged.scale[forged.scale.length - 1] ^ 0x01;
        vm.expectRevert(PortaldotLightClient.HeaderNotInMmr.selector);
        _import(lc, c.blockNumber, forged);

        // The right header with a tampered sibling.
        h.proof.items[0] = bytes32(uint256(h.proof.items[0]) ^ 1);
        vm.expectRevert(PortaldotLightClient.HeaderNotInMmr.selector);
        _import(lc, c.blockNumber, h);
    }

    function test_rejectHeaderAgainstUnknownCommitment() public {
        Commitment memory c = _commitment("commitment");
        Header memory h = _header("header");
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.UnknownCommitment.selector, c.blockNumber));
        _import(lc, c.blockNumber, h);
    }

    function test_rejectHeaderProofLayout() public {
        Commitment memory c = _commitment("commitment");
        Header memory h = _header("header");
        _submit(lc, c);
        h.proof.leafCount = c.blockNumber + 1;
        vm.expectRevert(PortaldotLightClient.ProofLayoutMismatch.selector);
        _import(lc, c.blockNumber, h);
        h.proof.leafCount = c.blockNumber;
        h.proof.leafIndex = h.number - 1;
        vm.expectRevert(PortaldotLightClient.ProofLayoutMismatch.selector);
        _import(lc, c.blockNumber, h);
    }

    // ------------------------------------------------------------------ session handoff

    function test_rejectsNextSetBeforeRotate() public {
        Commitment memory next = _commitment("next");
        assertEq(next.setId, _setId() + 1);
        vm.expectRevert(
            abi.encodeWithSelector(PortaldotLightClient.UnknownValidatorSet.selector, next.setId, _setId())
        );
        _submit(lc, next);
    }

    function test_rotateThenAccept() public {
        (PortaldotLightClient client,, Header memory h) = _clientWithHeader();
        vm.expectEmit(address(client));
        emit SetRotated(_setId() + 1);
        client.rotate(h.number, _rotationProof(), _nextKeys());
        assertEq(client.currentSetId(), _setId() + 1);
        assertEq(client.signers(), vm.parseJsonAddressArray(beefy, ".nextAuthorities.addresses"));

        // The first commitment of the next session, signed by the new set, now lands...
        Commitment memory next = _commitment("next");
        _submit(client, next);
        assertEq(client.latestBlock(), next.blockNumber);
        // ...and proves the last header of the previous session.
        Header memory last = _header("nextHeader");
        _import(client, next.blockNumber, last);
        assertEq(client.stateRootOf(last.number), last.stateRoot);

        // Set N can no longer sign.
        Commitment memory old = _commitment("commitment");
        vm.expectRevert(
            abi.encodeWithSelector(PortaldotLightClient.UnknownValidatorSet.selector, old.setId, _setId() + 1)
        );
        _submit(client, old);
    }

    function test_rejectOffCurveKey() public {
        (PortaldotLightClient client,, Header memory h) = _clientWithHeader();
        uint256[2][] memory keys = _nextKeys();
        // Same x and the same parity of y, so it still "compresses" to the stored key.
        uint256 y = keys[1][1];
        uint256 forgedY = y >= Secp256k1.P - 2 ? y - 2 : y + 2;
        assertFalse(Secp256k1.isOnCurve(keys[1][0], forgedY));
        keys[1][1] = forgedY;
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.OffCurveKey.selector, 1));
        client.rotate(h.number, _rotationProof(), keys);

        // Unreduced coordinates are rejected too: (1, y) is on the curve, (1 + p, y) is not accepted.
        uint256 y1 = 0x4218f20ae6c646b363db68605822fb14264ca8d2587fdd6fbc750d587e76a7ee;
        assertTrue(Secp256k1.isOnCurve(1, y1));
        assertFalse(Secp256k1.isOnCurve(1 + Secp256k1.P, y1));
        keys = _nextKeys();
        keys[0] = [1 + Secp256k1.P, y1];
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.OffCurveKey.selector, 0));
        client.rotate(h.number, _rotationProof(), keys);
    }

    function test_rejectKeyThatDoesNotMatch() public {
        (PortaldotLightClient client,, Header memory h) = _clientWithHeader();
        uint256[2][] memory keys = _nextKeys();
        // The negated point (x, p - y) is on the curve but has the other parity.
        keys[0][1] = Secp256k1.P - keys[0][1];
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.KeyMismatch.selector, 0));
        client.rotate(h.number, _rotationProof(), keys);

        // Keys in the wrong order.
        keys = _nextKeys();
        (keys[0], keys[1]) = (keys[1], keys[0]);
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.KeyMismatch.selector, 0));
        client.rotate(h.number, _rotationProof(), keys);

        // Too few keys.
        uint256[2][] memory one = new uint256[2][](1);
        one[0] = _nextKeys()[0];
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.KeyCountMismatch.selector, 1, 2));
        client.rotate(h.number, _rotationProof(), one);
    }

    function test_rotateWrongSetIdReverts() public {
        (PortaldotLightClient client,, Header memory h) = _clientWithHeader();
        client.rotate(h.number, _rotationProof(), _nextKeys());
        // The same session-N header proves ValidatorSetId == N, but the client is now at N + 1.
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.WrongSetId.selector, _setId(), _setId() + 1));
        client.rotate(h.number, _rotationProof(), _nextKeys());
    }

    function test_rotateRejectsUnknownHeader() public {
        Header memory h = _header("header");
        vm.expectRevert(abi.encodeWithSelector(PortaldotLightClient.UnknownHeader.selector, h.number));
        lc.rotate(h.number, _rotationProof(), _nextKeys());
    }

    function test_rotateRejectsTamperedProof() public {
        (PortaldotLightClient client,, Header memory h) = _clientWithHeader();
        bytes[] memory proof = _rotationProof();
        for (uint256 i = 0; i < proof.length; i++) {
            bytes[] memory p = _rotationProof();
            p[i][p[i].length - 1] = p[i][p[i].length - 1] ^ 0x01;
            vm.expectRevert(SubstrateTrie.IncompleteProof.selector);
            client.rotate(h.number, p, _nextKeys());
        }
        // A proof missing a node.
        bytes[] memory short = new bytes[](proof.length - 1);
        for (uint256 i = 0; i < short.length; i++) {
            short[i] = proof[i + 1];
        }
        vm.expectRevert(SubstrateTrie.IncompleteProof.selector);
        client.rotate(h.number, short, _nextKeys());
    }
}
