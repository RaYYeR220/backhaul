import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, keccak256, toHex, type Hex } from 'viem';
import { commitmentSlot, COMMITTED_TOPIC, encodeAbsenceProof, encodeCommitmentProof } from '../src/bsc/verifier.js';

const fixtures = join(__dirname, '..', '..', '..', 'contracts', 'test', 'fixtures');
const V = JSON.parse(readFileSync(join(fixtures, 'bsc-synthetic.json'), 'utf8')).verifier;
const S = JSON.parse(readFileSync(join(fixtures, 'bsc-storage.json'), 'utf8'));

describe('BscVerifier proof encoding', () => {
  it('uses the Outbox event topic and slot layout', () => {
    expect(COMMITTED_TOPIC).toBe(keccak256(toHex('Committed(bytes32,bytes32)')));
    expect(COMMITTED_TOPIC).toBe(V.committedTopic);
    expect(commitmentSlot(S.absentKey)).toBe(S.absent.slot);
  });

  it('encodes a commitment proof as (uint64, bytes, bytes[], uint256)', () => {
    const enc = encodeCommitmentProof({ blockNumber: 1200n, key: V.receipts[0].key, proof: V.receipts[0].proof, logIndex: 1 });
    expect(enc).toBe(V.encoded.commitment1);
    const [n, key, nodes, logIndex] = decodeAbiParameters(
      [{ type: 'uint64' }, { type: 'bytes' }, { type: 'bytes[]' }, { type: 'uint256' }],
      enc,
    );
    expect([n, key, nodes, logIndex]).toEqual([1200n, V.receipts[0].key, V.receipts[0].proof, 1n]);
  });

  it('encodes an absence proof as (uint64, bytes[], bytes[])', () => {
    const enc = encodeAbsenceProof({ blockNumber: 1200n, accountProof: V.accountProof, storageProof: V.absentProof as Hex[] });
    expect(enc).toBe(V.encoded.absent);
  });
});
