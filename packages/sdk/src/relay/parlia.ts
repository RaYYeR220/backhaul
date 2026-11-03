// Driving the Parlia light client of BSC (ParliaClient on Portaldot).
//
// The client verifies by skipping (trusting period of 7 days), so the relay only submits:
//  - a window above each block a job has to prove (its receipt or storage),
//  - an epoch window once too few live validators are in the client's trusted set (BSC testnet
//    swaps one validator in and out almost every epoch, which plain windows pass over), and a
//    refresh before the trusted epoch gets old (every few days), so the trusting period never
//    runs out.
// Before an epoch rotation, jobs still waiting on older blocks should be finalized first: after
// two rotations the client no longer knows the set that sealed them. A job whose block is out of
// reach anyway proves its commitment from the BSC Outbox's storage at a later block instead
// (BscVerifier takes both proof types).

import type { Hex } from 'viem';
import type { BscClient } from '../bsc/client.js';
import { decodeHeader, parseEpochExtra } from '../bsc/header.js';
import { buildWindow, rpcHeaderSource, trustedOverlap, WindowError, type HeaderSource, type TrustedSet, type WindowOptions } from '../bsc/window.js';

export interface TrustedSetView extends TrustedSet {
  epochTimestamp: bigint;
}

export interface ParliaClientPort {
  validatorSet(): Promise<TrustedSetView>;
  /** Empty validators if the client has rotated less than once. */
  previousValidatorSet(): Promise<TrustedSetView>;
  isFinalized(n: bigint): Promise<boolean>;
  /** Resolves once the window is mined. */
  submitWindow(headers: Hex[]): Promise<Hex>;
}

export interface BscSource extends HeaderSource {
  headNumber(): Promise<bigint>;
  /** extraData of block `n`. */
  extraOf(n: bigint): Promise<Hex>;
  timestampOf(n: bigint): Promise<bigint>;
}

export interface ParliaEvent {
  kind: 'window' | 'epoch';
  tx: Hex;
  /** The block the window finalized. */
  block: bigint;
  headers: number;
  bytes: number;
}

export interface ParliaRelayOptions {
  epochLength?: bigint;
  /** Refresh the trusted epoch once it is older than this many seconds (default 3 days). */
  refreshAfter?: bigint;
  /** Blocks to stay behind the BSC head before treating an epoch block as settled. */
  confirmations?: bigint;
  /**
   * Submit an epoch once fewer than this many live validators are in the client's trusted set
   * (default 7 of 9: quorum is 6, so one more swap still leaves windows that finalize).
   */
  minOverlap?: number;
  /** Pass untrusted seals in plain windows, as ParliaClient does (default true). */
  tolerateUntrusted?: boolean;
  /** Most epoch windows tried when looking for a skip that still verifies. */
  maxEpochProbes?: number;
  log?: (m: string) => void;
  onEvent?: (e: ParliaEvent) => void;
}

export class ParliaRelay {
  readonly epochLength: bigint;
  private readonly refreshAfter: bigint;
  private readonly confirmations: bigint;
  private readonly minOverlap: number;
  private readonly tolerateUntrusted: boolean;
  private readonly maxEpochProbes: number;
  private readonly log: (m: string) => void;
  private readonly onEvent: (e: ParliaEvent) => void;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    readonly lc: ParliaClientPort,
    readonly bsc: BscSource,
    opts: ParliaRelayOptions = {},
  ) {
    this.epochLength = opts.epochLength ?? 1000n;
    this.refreshAfter = opts.refreshAfter ?? 3n * 86_400n;
    this.confirmations = opts.confirmations ?? 64n;
    this.minOverlap = opts.minOverlap ?? 7;
    this.tolerateUntrusted = opts.tolerateUntrusted ?? true;
    this.maxEpochProbes = opts.maxEpochProbes ?? 24;
    this.log = opts.log ?? (() => {});
    this.onEvent = opts.onEvent ?? (() => {});
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private windowOpts(previous?: TrustedSet): WindowOptions {
    return { previous, epochLength: this.epochLength, tolerateUntrusted: this.tolerateUntrusted };
  }

  /** The client's trusted sets, read from the contract (never from the live snapshot). */
  private async sets(): Promise<{ current: TrustedSetView; previous?: TrustedSetView }> {
    const current = await this.lc.validatorSet();
    const prev = await this.lc.previousValidatorSet();
    return { current, previous: prev.validators.length > 0 ? prev : undefined };
  }

  private async submit(kind: ParliaEvent['kind'], headers: Hex[]): Promise<Hex> {
    const first = headers.length > 0 ? decodeHeader(headers[0]).number : 0n;
    const tx = await this.lc.submitWindow(headers);
    const bytes = headers.reduce((s, h) => s + (h.length - 2) / 2, 0);
    this.log(`${kind} window at ${first} (${headers.length} headers, ${bytes} B): ${tx}`);
    this.onEvent({ kind, tx, block: first, headers: headers.length, bytes });
    return tx;
  }

  /** Finalizes block `n` (no-op if the client already holds it). */
  finalize(n: bigint): Promise<Hex | undefined> {
    return this.exclusive(() => this.finalizeLocked(n));
  }

  private async finalizeLocked(n: bigint): Promise<Hex | undefined> {
    if (await this.lc.isFinalized(n)) return undefined;
    for (let attempt = 0; ; attempt++) {
      const { current, previous } = await this.sets();
      try {
        const window = await buildWindow(this.bsc, n, current, this.windowOpts(previous));
        return await this.submit(n % this.epochLength === 0n && n > current.epoch ? 'epoch' : 'window', window);
      } catch (e) {
        if (!(e instanceof WindowError) || attempt > 0) throw e;
        // Most likely the set changed in an epoch the client has not seen: catch up and retry.
        const epoch = n - (n % this.epochLength);
        if (epoch <= current.epoch) throw e;
        this.log(`window at ${n} needs epoch ${epoch} first (${e.message})`);
        await this.advanceToLocked(epoch);
      }
    }
  }

  /**
   * Moves the trusted epoch to `epoch`. A skip only verifies while ⌈2N/3⌉ of the trusted set
   * still seals; when the direct skip fails, the newest intermediate epoch that does verify is
   * submitted first, then the target is tried again.
   */
  advanceTo(epoch: bigint): Promise<void> {
    return this.exclusive(() => this.advanceToLocked(epoch));
  }

  private async advanceToLocked(epoch: bigint): Promise<void> {
    if (epoch % this.epochLength !== 0n) throw new Error(`${epoch} is not an epoch block`);
    for (;;) {
      const { current, previous } = await this.sets();
      if (current.epoch >= epoch) return;
      try {
        const window = await buildWindow(this.bsc, epoch, current, this.windowOpts(previous));
        await this.submit('epoch', window);
        return;
      } catch (e) {
        if (!(e instanceof WindowError)) throw e;
        let stepped = false;
        let probes = 0;
        for (let x = epoch - this.epochLength; x > current.epoch && probes < this.maxEpochProbes; x -= this.epochLength, probes++) {
          try {
            const w = await buildWindow(this.bsc, x, current, this.windowOpts(previous));
            this.log(`skip to ${epoch} does not verify (${e.message}); stepping through epoch ${x}`);
            await this.submit('epoch', w);
            stepped = true;
            break;
          } catch (inner) {
            if (!(inner instanceof WindowError)) throw inner;
          }
        }
        if (!stepped) throw e;
      }
    }
  }

  /** The newest epoch block at least `confirmations` blocks deep. */
  async latestSettledEpoch(): Promise<bigint> {
    const head = await this.bsc.headNumber();
    const safe = head - this.confirmations;
    return safe - (safe % this.epochLength);
  }

  /**
   * Decides whether the trusted epoch should move: fewer than `minOverlap` live validators are
   * trusted, the turn length changed, or the trusted epoch is older than `refreshAfter` (the
   * trusting period must never run out). Returns the epoch to submit, or undefined.
   */
  async epochDue(
    nowSec = BigInt(Math.floor(Date.now() / 1000)),
  ): Promise<{ epoch: bigint; reason: 'overlap' | 'turn-length' | 'refresh'; overlap: number } | undefined> {
    const { current } = await this.sets();
    const latest = await this.latestSettledEpoch();
    if (latest <= current.epoch) return undefined;
    const ann = parseEpochExtra(await this.bsc.extraOf(latest));
    const overlap = trustedOverlap(current.validators, ann.validators);
    if (overlap < this.minOverlap) return { epoch: latest, reason: 'overlap', overlap };
    if (ann.turnLength !== current.turnLength) return { epoch: latest, reason: 'turn-length', overlap };
    if (nowSec - current.epochTimestamp >= this.refreshAfter) return { epoch: latest, reason: 'refresh', overlap };
    return undefined;
  }

  /** Seconds left before windows above the trusted set stop verifying. */
  async trustRemaining(trustingPeriod: bigint, nowSec = BigInt(Math.floor(Date.now() / 1000))): Promise<bigint> {
    const { current } = await this.sets();
    return current.epochTimestamp + trustingPeriod - nowSec;
  }
}

/** BscSource over the SDK's rate-limited JSON-RPC client. */
export function rpcBscSource(client: BscClient): BscSource {
  const headers = rpcHeaderSource(client);
  return {
    headerRlps: (from, count) => headers.headerRlps(from, count),
    headNumber: () => client.blockNumber(),
    async extraOf(n) {
      return (await client.block(n)).extraData;
    },
    async timestampOf(n) {
      return BigInt((await client.block(n)).timestamp);
    },
  };
}
