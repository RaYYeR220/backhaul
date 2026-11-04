// Driving the BEEFY light client of Portaldot (PortaldotLightClient on BSC).
//
// The node keeps BEEFY justifications for past sessions as well (non-mandatory ones every 8
// blocks, at least about a day back on test-node-v3), but not forever, so the relay archives
// every one it sees. Rotation follows PortaldotLightClient.rotate: once session k+1 has begun, prove a
// header of session k with the last archived set-k commitment, rotate, then submit session
// k+1's mandatory commitment straight away so headers stay provable without a gap.

import { closeSync, existsSync, openSync, writeSync } from 'node:fs';
import type { ApiPromise } from '@polkadot/api';
import {
  buildRotation,
  decodeJustification,
  encodeCommitment,
  fetchStoredJustification,
  sessionStartOf,
  validatorSetIdAt,
  type ArchiveEntry,
  type EncodedCommitment,
  type JustificationArchive,
  type RotationArgs,
} from '../portaldot/beefy.js';
import { fetchBlockHashes, finalizedNumber, type PortaldotClient } from '../portaldot/client.js';
import { buildHeaderImport, type HeaderImportArgs, type MmrMirror } from '../portaldot/mmr.js';
import { toU8a, type Hex } from '../portaldot/scale.js';

/** What the relay needs from the light client contract. Writes resolve once the tx is mined. */
export interface BeefyClientPort {
  currentSetId(): Promise<bigint>;
  latestBlock(): Promise<number>;
  stateRootOf(n: number): Promise<Hex>;
  submitCommitment(c: EncodedCommitment): Promise<Hex>;
  importHeader(a: HeaderImportArgs): Promise<Hex>;
  rotate(a: RotationArgs): Promise<Hex>;
}

/** What the relay needs from Portaldot. */
export interface PortaldotSource {
  /** Number of the latest BEEFY-finalized block. */
  beefyHead(): Promise<number>;
  setIdAt(n: number): Promise<bigint>;
  /** First block of the session of `setId` (`hint` must be a block where that set is active). */
  sessionStart(setId: bigint, hint: number): Promise<number>;
  /** The BEEFY justification stored in block `n`'s body, if the node still has it. */
  storedJustification(n: number): Promise<Hex | undefined>;
  headerImport(n: number, commitmentBlock: number): Promise<HeaderImportArgs>;
  rotation(n: number): Promise<RotationArgs>;
}

export class BeefyHaltError extends Error {}

export interface BeefyEvent {
  kind: 'commitment' | 'header' | 'rotate';
  tx: Hex;
  block: number;
  setId: bigint;
}

export interface BeefyRelayOptions {
  /** How far back from the BEEFY head to look for a stored justification. */
  scanBack?: number;
  log?: (m: string) => void;
  onEvent?: (e: BeefyEvent) => void;
}

export class BeefyRelay {
  private readonly scanBack: number;
  private readonly log: (m: string) => void;
  private readonly onEvent: (e: BeefyEvent) => void;
  /** Serializes every write, so overlapping callers never race on the client. */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    readonly lc: BeefyClientPort,
    readonly chain: PortaldotSource,
    readonly archive: JustificationArchive,
    opts: BeefyRelayOptions = {},
  ) {
    this.scanBack = opts.scanBack ?? 64;
    this.log = opts.log ?? (() => {});
    this.onEvent = opts.onEvent ?? (() => {});
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Archives the justifications the node holds in the last `scanBack` blocks up to the BEEFY head. */
  async refreshArchive(): Promise<ArchiveEntry | undefined> {
    const head = await this.chain.beefyHead();
    let newest: ArchiveEntry | undefined;
    for (let n = head; n > Math.max(0, head - this.scanBack); n--) {
      if (this.archive.get(n)) {
        newest ??= this.archive.get(n);
        break;
      }
      const proof = await this.chain.storedJustification(n);
      if (!proof) continue;
      const e = this.archive.append(proof, 'block') ?? this.archive.get(n);
      newest ??= e;
    }
    return newest;
  }

  /** The newest archived commitment of `setId` above `above` (and below `below`, if given). */
  newest(setId: bigint, above: number, below = Infinity): ArchiveEntry | undefined {
    const list = this.archive.forSet(setId).filter((e) => e.blockNumber > above && e.blockNumber < below);
    return list[list.length - 1];
  }

  private async submit(e: ArchiveEntry): Promise<Hex> {
    const tx = await this.lc.submitCommitment(encodeCommitment(e.proof));
    this.log(`commitment ${e.blockNumber} (set ${e.validatorSetId}) submitted: ${tx}`);
    this.onEvent({ kind: 'commitment', tx, block: e.blockNumber, setId: BigInt(e.validatorSetId) });
    return tx;
  }

  /** Imports header `n` against the client's latest commitment, unless it is already there. */
  private async importAt(n: number): Promise<Hex | undefined> {
    const root = await this.lc.stateRootOf(n);
    if (BigInt(root) !== 0n) return undefined;
    const latest = await this.lc.latestBlock();
    if (n >= latest) throw new Error(`header ${n} is not below the latest commitment ${latest}`);
    const args = await this.chain.headerImport(n, latest);
    const tx = await this.lc.importHeader(args);
    this.log(`header ${n} imported against commitment ${latest}: ${tx}`);
    this.onEvent({ kind: 'header', tx, block: n, setId: await this.lc.currentSetId() });
    return tx;
  }

  /**
   * Rotates the client until it trusts the set signing at the BEEFY head. Throws
   * {@link BeefyHaltError} if a session was missed entirely: no commitment of the outgoing set
   * inside its own session is archived, and the node no longer has one.
   */
  rotateIfNeeded(): Promise<number> {
    return this.exclusive(() => this.rotateLocked());
  }

  private async rotateLocked(): Promise<number> {
    let rotations = 0;
    for (;;) {
      const head = await this.chain.beefyHead();
      const chainSet = await this.chain.setIdAt(head);
      const k = await this.lc.currentSetId();
      if (k >= chainSet) return rotations;

      const nextStart = await this.chain.sessionStart(k + 1n, head);
      const thisStart = await this.chain.sessionStart(k, nextStart - 1);
      let last = this.newest(k, thisStart, nextStart);
      if (!last) {
        // The node may still hold one if session k only just ended.
        for (let n = nextStart - 1; n > Math.max(thisStart, nextStart - 1 - this.scanBack); n--) {
          const p = await this.chain.storedJustification(n);
          if (p && decodeJustification(p).commitment.validatorSetId === k) {
            last = this.archive.append(p, 'block') ?? this.archive.get(n);
            break;
          }
        }
      }
      if (!last) {
        throw new BeefyHaltError(
          `no commitment of set ${k} inside its session [${thisStart}, ${nextStart}) is archived; the client cannot rotate`,
        );
      }
      if (last.blockNumber > (await this.lc.latestBlock())) await this.submit(last);
      const h = last.blockNumber - 1;
      await this.importAt(h);
      const rot = await this.chain.rotation(h);
      const tx = await this.lc.rotate(rot);
      rotations++;
      this.log(`rotated to set ${k + 1n} with header ${h}: ${tx}`);
      this.onEvent({ kind: 'rotate', tx, block: h, setId: k + 1n });

      // Session k+1's mandatory commitment keeps the client current from the very first block.
      let mandatory = this.archive.get(nextStart);
      if (!mandatory) {
        const p = await this.chain.storedJustification(nextStart);
        if (p) mandatory = this.archive.append(p, 'block') ?? this.archive.get(nextStart);
      }
      if (mandatory && mandatory.blockNumber > (await this.lc.latestBlock())) await this.submit(mandatory);
    }
  }

  /**
   * Submits the newest archived commitment of the client's set if it is newer than what the
   * client holds. Returns the block it submitted, or undefined if nothing newer exists.
   */
  submitLatest(): Promise<number | undefined> {
    return this.exclusive(async () => {
      await this.rotateLocked();
      await this.refreshArchive();
      const k = await this.lc.currentSetId();
      const e = this.newest(k, await this.lc.latestBlock());
      if (!e) return undefined;
      await this.submit(e);
      return e.blockNumber;
    });
  }

  /**
   * Makes sure the client holds the state root of some header `h >= minBlock` and returns `h`.
   * The header picked is the newest one the latest commitment can prove, so one import serves
   * every job up to it. Waits (polling every `pollMs`) until a commitment above `minBlock` exists.
   */
  ensureHeader(minBlock: number, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<number> {
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    const poll = opts.pollMs ?? 6_000;
    return this.exclusive(async () => {
      for (;;) {
        await this.rotateLocked();
        let latest = await this.lc.latestBlock();
        if (latest <= minBlock) {
          await this.refreshArchive();
          const e = this.newest(await this.lc.currentSetId(), minBlock);
          if (e) {
            await this.submit(e);
            latest = e.blockNumber;
          }
        }
        if (latest > minBlock) {
          const h = latest - 1;
          await this.importAt(h);
          return h;
        }
        if (Date.now() > deadline) throw new Error(`no BEEFY commitment above block ${minBlock} yet`);
        await new Promise((r) => setTimeout(r, poll));
      }
    });
  }
}

// ------------------------------------------------------------------ live PortaldotSource

/** Grows an in-memory mirror up to `upTo` leaves, appending the new hashes to the cache file. */
export async function extendMirror(client: PortaldotClient, mirror: MmrMirror, upTo: number, cachePath?: string): Promise<void> {
  if (mirror.size >= upTo) return;
  const head = await finalizedNumber(client.api);
  const to = Math.max(upTo, Math.min(head, upTo + 1000));
  const fresh = await fetchBlockHashes(client.http, mirror.size, to);
  if (cachePath && existsSync(cachePath)) {
    const fd = openSync(cachePath, 'a');
    try {
      for (const h of fresh) writeSync(fd, toU8a(h));
    } finally {
      closeSync(fd);
    }
  }
  mirror.extend(fresh.map((h) => toU8a(h)));
}

export function livePortaldotSource(client: PortaldotClient, mirror: MmrMirror, cachePath?: string): PortaldotSource {
  const api: ApiPromise = client.api;
  return {
    async beefyHead() {
      return (await api.rpc.chain.getHeader(await api.rpc.beefy.getFinalizedHead())).number.toNumber();
    },
    setIdAt: (n) => validatorSetIdAt(api, n),
    sessionStart: (setId, hint) => sessionStartOf(api, setId, hint),
    storedJustification: (n) => fetchStoredJustification(api, n),
    async headerImport(n, commitmentBlock) {
      await extendMirror(client, mirror, commitmentBlock, cachePath);
      return buildHeaderImport(api, mirror, n, commitmentBlock);
    },
    rotation: (n) => buildRotation(api, n),
  };
}
