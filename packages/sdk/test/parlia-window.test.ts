import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { decodeHeader, parseEpochExtra } from '../src/bsc/header.js';
import { buildWindow, trustedOverlap, UntrustedSealError, type HeaderSource, type TrustedSet } from '../src/bsc/window.js';

const fixtures = join(__dirname, '..', '..', '..', 'contracts', 'test', 'fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
const H = load('bsc-headers.json');
const S = load('bsc-synthetic.json');

/** Serves a run of RLPs that starts at `start`. */
function source(start: bigint, rlps: Hex[]): HeaderSource {
  return {
    async headerRlps(from, count) {
      const i = Number(from - start);
      return rlps.slice(Math.max(0, i), Math.max(0, i) + count);
    },
  };
}

const realSrc = source(BigInt(H.epoch), H.rlps);
const checkpoint: TrustedSet = {
  validators: H.checkpoint.validators,
  turnLength: H.checkpoint.turnLength,
  epoch: BigInt(H.checkpoint.epoch),
  activeFrom: BigInt(H.checkpoint.activeFrom),
};
const rotated: TrustedSet = {
  validators: H.epochValidators,
  turnLength: H.epochTurnLength,
  epoch: BigInt(H.epoch),
  activeFrom: BigInt(H.switchHeight),
};

describe('buildWindow on real BSC testnet headers', () => {
  it('builds the shortest epoch window across the switch', async () => {
    const w = await buildWindow(realSrc, BigInt(H.epoch), checkpoint);
    // Five turns of the old set (E..E+39), then 0x0826… at E+40, which both sets contain.
    expect(w).toHaveLength(41);
    expect(decodeHeader(w[40]).number).toBe(BigInt(H.switchHeight));
    expect(parseEpochExtra(decodeHeader(w[0]).extra).validators).toEqual(H.epochValidators);
  });

  it('counts the incoming validator once the rotation is known', async () => {
    const w = await buildWindow(realSrc, BigInt(H.epoch) + 48n, rotated);
    expect(decodeHeader(w[w.length - 1]).number).toBe(BigInt(H.firstIncomingSeal));
    expect(decodeHeader(w[w.length - 1]).coinbase).toBe(H.incoming[0]);
  });

  it('runs past a swapped-in validator the client does not trust, without counting it', async () => {
    // The checkpoint set lacks the validator that joined at E; its turn is E+88 .. E+95.
    const w = await buildWindow(realSrc, BigInt(H.epoch) + 48n, checkpoint);
    expect(w).toHaveLength(49);
    const sealers = w.map((r) => decodeHeader(r).coinbase);
    expect(sealers).toContain(H.incoming[0]);
    expect(decodeHeader(w[48]).number).toBe(BigInt(H.epoch) + 96n);
    const trusted = new Set(sealers.filter((s) => H.checkpoint.validators.includes(s)));
    expect(trusted.size).toBe(6);
    expect(trustedOverlap(H.checkpoint.validators, H.epochValidators)).toBe(8);
  });

  it('refuses the untrusted seal in strict mode', async () => {
    const err = await buildWindow(realSrc, BigInt(H.epoch) + 48n, checkpoint, { tolerateUntrusted: false }).catch((e) => e);
    expect(err).toBeInstanceOf(UntrustedSealError);
    expect(err.blockNumber).toBe(BigInt(H.firstIncomingSeal));
  });

  it('uses the previous set below the current one', async () => {
    const w = await buildWindow(realSrc, BigInt(H.epoch) + 2n, rotated, { previous: checkpoint });
    expect(w.length).toBeGreaterThanOrEqual(39);
    await expect(buildWindow(realSrc, BigInt(H.epoch) + 2n, rotated)).rejects.toThrow(/below every trusted set/);
  });
});

describe('buildWindow on synthetic chains', () => {
  const set = (name: string, epoch: number): TrustedSet => ({
    validators: S.sets[name] as Address[],
    turnLength: 8,
    epoch: BigInt(epoch),
    activeFrom: BigInt(epoch + 40),
  });
  const seg = (name: string) => source(BigInt(S.segments[name].start), S.segments[name].rlps);
  const opts = { chainId: S.chainId };

  it('never counts the keys a forged epoch block announces', async () => {
    await expect(buildWindow(seg('selfCertified'), 2000n, set('A', 1000), opts)).rejects.toThrow(/no quorum/);
  });

  it('rejects the outgoing validator one block after the switch', async () => {
    await expect(buildWindow(seg('rotationOutgoingLate'), 4000n, set('A', 3000), opts)).rejects.toThrow(/block 4040/);
  });

  it('counts only trusted sealers when untrusted turns are mixed in', async () => {
    // turns 0, 20, 1, 21, 2, 22, 3, 4, 5: five trusted + three untrusted in the first 64 headers
    const w = await buildWindow(seg('untrustedPadding'), 1500n, set('A', 1000), opts);
    expect(w).toHaveLength(65);
    await expect(buildWindow(seg('untrustedPadding'), 1500n, set('A', 1000), { ...opts, maxHeaders: 64 })).rejects.toThrow(/no quorum/);
  });

  it('never finalizes a branch sealed only by an attacker', async () => {
    await expect(buildWindow(seg('forgedBranch'), 1600n, set('A', 1000), opts)).rejects.toThrow(/no quorum/);
  });

  it('keeps per-height checks across a switch', async () => {
    // The outgoing validator one block after the switch inside an epoch window.
    const err = await buildWindow(seg('rotationOutgoingLate'), 4000n, set('A', 3000), opts).catch((e) => e);
    expect(err).toBeInstanceOf(UntrustedSealError);
  });

  it('accepts the rotation window', async () => {
    const w = await buildWindow(seg('rotation'), 4000n, set('A', 3000), opts);
    expect(w).toHaveLength(49);
  });

  it('passes over seals out of force below the current set, as the contract does', async () => {
    // After the rotation at 4000 (A → B from 4040), A checks windows below 4040.
    const rotated = { ...set('B', 4000), activeFrom: 4040n };
    const w = await buildWindow(seg('previousOutsider'), 4001n, rotated, { ...opts, previous: set('A', 1000) });
    expect(w).toHaveLength(31); // the sixth member of A seals 4031
    const strict = await buildWindow(seg('previousOutsider'), 4001n, rotated, { ...opts, previous: set('A', 1000), tolerateUntrusted: false }).catch((e) => e);
    expect(strict).toBeInstanceOf(UntrustedSealError);
    expect(strict.blockNumber).toBe(4006n);
    // The outgoing validator at 4040 is out of force there: it does not count, so no quorum.
    await expect(buildWindow(seg('rotationOutgoingLate'), 4000n, rotated, { ...opts, previous: set('A', 1000) })).rejects.toThrow(/no quorum/);
  });
});
