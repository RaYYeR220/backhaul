import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, keccak256, sliceHex, toHex, type Hex } from 'viem';
import {
  commitmentSlot,
  COMMITTED_TOPIC,
  decodeCommitmentProof,
  encodeAbsenceProof,
  encodeCommitmentProof,
  encodeStorageCommitmentProof,
  RECEIPT_PROOF,
  STORAGE_PROOF,
} from '../src/bsc/verifier.js';

const fixtures = join(__dirname, '..', '..', '..', 'contracts', 'test', 'fixtures');
const V = JSON.parse(readFileSync(join(fixtures, 'bsc-synthetic.json'), 'utf8')).verifier;
const S = JSON.parse(readFileSync(join(fixtures, 'bsc-storage.json'), 'utf8'));

describe('BscVerifier proof encoding', () => {
  it('uses the Outbox event topic and slot layout', () => {
    expect(COMMITTED_TOPIC).toBe(keccak256(toHex('Committed(bytes32,bytes32)')));
    expect(COMMITTED_TOPIC).toBe(V.committedTopic);
    expect(commitmentSlot(S.absentKey)).toBe(S.absent.slot);
  });

  it('encodes a receipt commitment proof as 0x01 ‖ (uint64, bytes, bytes[], uint256)', () => {
    const enc = encodeCommitmentProof({ blockNumber: 1200n, key: V.receipts[0].key, proof: V.receipts[0].proof, logIndex: 1 });
    expect(enc).toBe(V.encoded.commitment1);
    expect(Number.parseInt(enc.slice(2, 4), 16)).toBe(RECEIPT_PROOF);
    const [n, key, nodes, logIndex] = decodeAbiParameters(
      [{ type: 'uint64' }, { type: 'bytes' }, { type: 'bytes[]' }, { type: 'uint256' }],
      sliceHex(enc, 1),
    );
    expect([n, key, nodes, logIndex]).toEqual([1200n, V.receipts[0].key, V.receipts[0].proof, 1n]);
    expect(decodeCommitmentProof(enc)).toEqual({ type: 'receipt', blockNumber: 1200n, key: V.receipts[0].key, proof: V.receipts[0].proof, logIndex: 1n });
  });

  it('encodes a storage commitment proof as 0x02 ‖ (uint64, bytes[], bytes[])', () => {
    const enc = encodeStorageCommitmentProof({ blockNumber: 1200n, accountProof: V.accountProof, storageProof: V.presentProof as Hex[] });
    expect(enc).toBe(V.encoded.storage1);
    expect(Number.parseInt(enc.slice(2, 4), 16)).toBe(STORAGE_PROOF);
    // the same fields as an absence proof, behind the type byte
    expect(sliceHex(enc, 1)).toBe(encodeAbsenceProof({ blockNumber: 1200n, accountProof: V.accountProof, storageProof: V.presentProof as Hex[] }));
    expect(decodeCommitmentProof(enc)).toEqual({ type: 'storage', blockNumber: 1200n, accountProof: V.accountProof, storageProof: V.presentProof });
  });

  it('refuses a commitment proof without a known type byte', () => {
    expect(() => decodeCommitmentProof(sliceHex(V.encoded.commitment1, 1))).toThrow(/unknown commitment proof type 0x00/);
    expect(() => decodeCommitmentProof('0x')).toThrow(/unknown/);
  });

  it('encodes an absence proof as (uint64, bytes[], bytes[])', () => {
    const enc = encodeAbsenceProof({ blockNumber: 1200n, accountProof: V.accountProof, storageProof: V.absentProof as Hex[] });
    expect(enc).toBe(V.encoded.absent);
  });
});
