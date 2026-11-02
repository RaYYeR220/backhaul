import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import type { RpcBlock } from '../src/bsc/client.js';
import { decodeHeader, headerRlp, parseEpochExtra, quorum, sealerOf, switchOffset } from '../src/bsc/header.js';

const fixtures = join(__dirname, '..', '..', '..', 'contracts', 'test', 'fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
const H = load('bsc-headers.json');

describe('BSC headers', () => {
  it('re-encodes RPC blocks to the exact consensus RLP', () => {
    for (const [i, block] of (H.rpcSamples as RpcBlock[]).entries()) {
      const rlp = headerRlp(block);
      expect(rlp).toBe(H.rlps[i]);
      expect(keccak256(rlp)).toBe(H.hashes[i]);
    }
  });

  it('refuses a block whose fields do not hash to its reported hash', () => {
    const block = { ...(H.rpcSamples[1] as RpcBlock), stateRoot: H.stateRoots[0] as Hex };
    expect(() => headerRlp(block)).toThrow(/keccak\(rlp\)/);
  });

  it('recovers the miner from the seal of every captured header', async () => {
    for (let i = 0; i < H.rlps.length; i++) {
      const h = decodeHeader(H.rlps[i]);
      expect(h.hash).toBe(H.hashes[i]);
      expect(h.number).toBe(BigInt(H.numbers[i]));
      if (i > 0) expect(h.parentHash).toBe(H.hashes[i - 1]);
      expect(await sealerOf(H.rlps[i], H.chainId)).toBe(H.miners[i]);
    }
  });

  it('does not recover the miner under another chain id', async () => {
    expect(await sealerOf(H.rlps[1], 56)).not.toBe(H.miners[1]);
  });

  it('parses the validator set and turn length out of an epoch block', () => {
    const { validators, turnLength } = parseEpochExtra(decodeHeader(H.rlps[0]).extra);
    expect(validators).toHaveLength(9);
    expect(turnLength).toBe(8);
    expect(validators).toEqual(H.epochValidators);
  });

  it('puts the switch where the node switched', () => {
    expect(switchOffset(9, 8)).toBe(40);
    expect(H.epoch + switchOffset(H.checkpoint.validators.length, H.checkpoint.turnLength)).toBe(H.switchHeight);
    expect(quorum(9)).toBe(6);
    expect(quorum(21)).toBe(14);
    // The outgoing validator never seals at or after the switch, the incoming one never before it.
    H.miners.forEach((m: string, i: number) => {
      if (H.numbers[i] >= H.switchHeight) expect(H.outgoing).not.toContain(m);
      else expect(H.incoming).not.toContain(m);
    });
  });
});
