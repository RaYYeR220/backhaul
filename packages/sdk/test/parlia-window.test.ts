import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { decodeHeader, parseEpochExtra } from '../src/bsc/header.js';
import { buildWindow, WindowError, type HeaderSource, type TrustedSet } from '../src/bsc/window.js';

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

  it('refuses a window the contract would reject before the rotation', async () => {
    await expect(buildWindow(realSrc, BigInt(H.epoch) + 48n, checkpoint)).rejects.toThrow(WindowError);
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

  it('accepts the rotation window', async () => {
    const w = await buildWindow(seg('rotation'), 4000n, set('A', 3000), opts);
    expect(w).toHaveLength(49);
  });
});
