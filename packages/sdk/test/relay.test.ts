import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { JustificationArchive, type EncodedCommitment } from '../src/portaldot/beefy.js';
import { BeefyHaltError, BeefyRelay, type BeefyClientPort, type BeefyEvent, type PortaldotSource } from '../src/relay/beefy.js';
import { ParliaRelay, type BscSource, type ParliaClientPort, type TrustedSetView } from '../src/relay/parlia.js';

const fixtures = join(__dirname, '..', '..', '..', 'contracts', 'test', 'fixtures');
const F = JSON.parse(readFileSync(join(fixtures, 'portaldot-beefy.json'), 'utf8'));
const S502 = F.checkpoint.blockNumber as number; // session of set 502 starts here
const S503 = F.next.blockNumber as number; // and set 503's here (its mandatory block)

/** Light client stand-in that enforces the contract's rules. */
class FakeLc implements BeefyClientPort {
  setId = 502n;
  latest = S502;
  roots = new Set<number>();
  calls: string[] = [];
  async currentSetId() {
    return this.setId;
  }
  async latestBlock() {
    return this.latest;
  }
  async stateRootOf(n: number) {
    return (this.roots.has(n) ? `0x${'11'.repeat(32)}` : `0x${'00'.repeat(32)}`) as Hex;
  }
  async submitCommitment(c: EncodedCommitment) {
    const b = Buffer.from(c.commitmentScale.slice(2), 'hex');
    const block = b.readUInt32LE(b.length - 12);
    const set = b.readBigUInt64LE(b.length - 8);
    if (set !== this.setId) throw new Error(`UnknownValidatorSet(${set}, ${this.setId})`);
    if (block <= this.latest) throw new Error('StaleCommitment');
    this.latest = block;
    this.calls.push(`commit ${block}`);
    return `0x${'01'.repeat(32)}` as Hex;
  }
  async importHeader(a: { commitmentBlock: number; proof: { leafIndex: number; leafCount: number } }) {
    if (a.proof.leafCount !== a.commitmentBlock || a.proof.leafIndex >= a.commitmentBlock) throw new Error('ProofLayoutMismatch');
    this.roots.add(a.proof.leafIndex);
    this.calls.push(`import ${a.proof.leafIndex}@${a.commitmentBlock}`);
    return `0x${'02'.repeat(32)}` as Hex;
  }
  async rotate(a: { headerNumber: number }) {
    if (!this.roots.has(a.headerNumber)) throw new Error('UnknownHeader');
    if (a.headerNumber < S502 || a.headerNumber >= S503) throw new Error('WrongSetId');
    this.setId++;
    this.calls.push(`rotate ${a.headerNumber}`);
    return `0x${'03'.repeat(32)}` as Hex;
  }
}

function source(over: Partial<PortaldotSource> = {}): PortaldotSource {
  return {
    beefyHead: async () => S503 + 10,
    setIdAt: async (n) => (n >= S503 ? 503n : 502n),
    sessionStart: async (setId) => (setId >= 503n ? S503 : S502),
    storedJustification: async (n) => (n === S503 ? (F.next.justification as Hex) : undefined),
    headerImport: async (n, c) => ({ commitmentBlock: c, headerScale: '0x00', proof: { leafIndex: n, leafCount: c, items: [] } }),
    rotation: async (n) => ({ headerNumber: n, proof: [], uncompressedKeys: [] }),
    ...over,
  };
}

const archive = (...justifications: Hex[]) => {
  const a = JustificationArchive.open(join(mkdtempSync(join(tmpdir(), 'beefy-')), 'a.jsonl'));
  for (const j of justifications) a.append(j, 'subscription');
  return a;
};

describe('BeefyRelay', () => {
  it('rotates with the last archived commitment of the outgoing set, then submits the new mandatory one', async () => {
    const lc = new FakeLc();
    const events: BeefyEvent[] = [];
    const relay = new BeefyRelay(lc, source(), archive(F.older.justification, F.commitment.justification), { onEvent: (e) => events.push(e) });
    expect(await relay.rotateIfNeeded()).toBe(1);
    const C = F.commitment.blockNumber;
    expect(lc.calls).toEqual([`commit ${C}`, `import ${C - 1}@${C}`, `rotate ${C - 1}`, `commit ${S503}`]);
    expect([lc.setId, lc.latest]).toEqual([503n, S503]);
    expect(events.map((e) => e.kind)).toEqual(['commitment', 'header', 'rotate', 'commitment']);
    expect(await relay.rotateIfNeeded()).toBe(0);
  });

  it('halts loudly when a whole session went unarchived', async () => {
    const relay = new BeefyRelay(new FakeLc(), source(), archive());
    await expect(relay.rotateIfNeeded()).rejects.toBeInstanceOf(BeefyHaltError);
  });

  it('imports the newest provable header at or above what a job needs', async () => {
    const lc = new FakeLc();
    const relay = new BeefyRelay(lc, source(), archive(F.older.justification, F.commitment.justification));
    const h = await relay.ensureHeader(S503 - 100);
    expect(h).toBe(S503 - 1);
    expect(lc.calls.at(-1)).toBe(`import ${S503 - 1}@${S503}`);
    // nothing newer than the client's latest commitment: it waits, then gives up
    await expect(relay.ensureHeader(S503 + 5, { timeoutMs: 20, pollMs: 5 })).rejects.toThrow(/no BEEFY commitment above/);
  });

  it('submits nothing when the archive has nothing newer', async () => {
    const lc = new FakeLc();
    const relay = new BeefyRelay(lc, source({ beefyHead: async () => S502 + 5, setIdAt: async () => 502n }), archive(F.older.justification));
    expect(await relay.submitLatest()).toBe(F.older.blockNumber);
    expect(await relay.submitLatest()).toBeUndefined();
  });
});

// ------------------------------------------------------------------ Parlia policy

const V = (n: number): Address => getAddress(`0x${(0x1000 + n).toString(16).padStart(40, '0')}`);

function epochExtra(validators: Address[], turnLength = 8): Hex {
  let h = '00'.repeat(32) + validators.length.toString(16).padStart(2, '0');
  for (const v of validators) h += v.slice(2).toLowerCase() + '00'.repeat(48);
  return `0x${h}${turnLength.toString(16).padStart(2, '0')}${'00'.repeat(65)}`;
}

function parlia(trusted: Address[], live: Address[], epochTimestamp: bigint, liveTurn = 8) {
  const set: TrustedSetView = { validators: trusted, turnLength: 8, epoch: 1000n, activeFrom: 1040n, epochTimestamp };
  const lc: ParliaClientPort = {
    validatorSet: async () => set,
    previousValidatorSet: async () => ({ ...set, validators: [] }),
    isFinalized: async () => false,
    submitWindow: async () => '0x',
  };
  const src: BscSource = {
    headerRlps: async () => [],
    headNumber: async () => 9100n,
    extraOf: async () => epochExtra(live, liveTurn),
    timestampOf: async () => 0n,
  };
  return new ParliaRelay(lc, src);
}

describe('ParliaRelay epoch policy', () => {
  const nine = Array.from({ length: 9 }, (_, i) => V(i));
  const now = 2_000_000_000n;

  it('keeps skipping while at least 7 live validators are trusted', async () => {
    const oneSwapped = [...nine.slice(0, 8), V(20)];
    expect(await parlia(nine, oneSwapped, now - 3600n).epochDue(now)).toBeUndefined();
    const twoSwapped = [...nine.slice(0, 7), V(20), V(21)];
    expect(await parlia(nine, twoSwapped, now - 3600n).epochDue(now)).toBeUndefined();
  });

  it('moves the trusted epoch once the overlap drops below 7', async () => {
    const threeSwapped = [...nine.slice(0, 6), V(20), V(21), V(22)];
    expect(await parlia(nine, threeSwapped, now - 3600n).epochDue(now)).toEqual({ epoch: 9000n, reason: 'overlap', overlap: 6 });
  });

  it('refreshes before the trusting period gets close, and on a turn-length change', async () => {
    expect(await parlia(nine, nine, now - 3n * 86_400n).epochDue(now)).toMatchObject({ reason: 'refresh' });
    expect(await parlia(nine, nine, now - 3600n, 4).epochDue(now)).toMatchObject({ reason: 'turn-length' });
  });
});
