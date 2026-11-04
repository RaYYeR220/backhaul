// Keeps the Parlia light client of BSC (on Portaldot) trusted: windows above job blocks are
// submitted on demand by the jobs; this loop only moves the trusted epoch, when fewer than
// `minOverlap` live validators are trusted or the trusted set gets old (every `refreshAfterSec`,
// 3 days by default, well inside the 14-day trusting period the client counts on both BSC's and
// Portaldot's clocks; once that runs out the client accepts nothing again). Job blocks still
// waiting are finalized first, so their receipts stay provable; a job whose block is out of reach
// anyway proves from the Outbox's storage at a later block (see jobs.ts).

import { bsc, trustDeadline } from '@backhaul/sdk';
import type { Chains } from './chains.js';
import type { RelayerConfig } from './config.js';
import type { JobEnv, JobRunner } from './jobs.js';

export interface ParliaStatus {
  trustedEpoch: string;
  activeFrom: string;
  validators: string[];
  epochTimestamp: string;
  /** Portaldot time the client installed the trusted set. */
  installedAt: string;
  trustingPeriodSec: string;
  /** Seconds before windows stop verifying, on the earlier of the two clocks. */
  trustRemainingSec: string;
  /** Set while less than `trustAlertSec` remains: refresh the trusted epoch now. */
  trustAlert: string | null;
  bscHead: string;
  liveOverlap: number | null;
  lastWindow: { block: string; tx: string; headers: number } | null;
  lagBlocks: string | null;
  lastError: string | null;
}

export class ParliaLoop {
  private timer?: NodeJS.Timeout;
  private running = false;
  lastError: string | null = null;

  constructor(
    readonly ch: Chains,
    readonly runner: JobRunner,
    readonly env: JobEnv,
    readonly cfg: RelayerConfig['parlia'],
    readonly log: (m: string) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.cfg.tickMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.ch.parlia!.epochDue();
      if (due) {
        this.log(`parlia: moving the trusted epoch to ${due.epoch} (${due.reason}, overlap ${due.overlap})`);
        const head = await this.env.bscHead();
        for (const b of this.runner.pendingBscBlocks()) {
          if (head >= b + 15n) await this.env.bscFinalize(b).catch((e) => this.log(`parlia: pending ${b}: ${(e as Error).message}`));
        }
        await this.ch.parlia!.advanceTo(due.epoch);
      }
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message.split('\n')[0];
      this.log(`parlia tick: ${this.lastError}`);
    } finally {
      this.running = false;
    }
  }

  async status(nowSec = BigInt(Math.floor(Date.now() / 1000))): Promise<ParliaStatus> {
    const set = await this.ch.parlia!.lc.validatorSet();
    const period = await this.ch.parlia!.lc.trustingPeriod();
    const remaining = trustDeadline(set, period) - nowSec;
    const head = await this.ch.bsc.rpc.blockNumber();
    let liveOverlap: number | null = null;
    try {
      const epoch = head - 64n - ((head - 64n) % 1000n);
      const ann = bsc.parseEpochExtra((await this.ch.bsc.rpc.block(epoch)).extraData);
      liveOverlap = bsc.trustedOverlap(set.validators, ann.validators);
    } catch {
      // status stays useful without it
    }
    const last = this.ch.events.parlia[this.ch.events.parlia.length - 1];
    return {
      trustedEpoch: set.epoch.toString(),
      activeFrom: set.activeFrom.toString(),
      validators: set.validators,
      epochTimestamp: set.epochTimestamp.toString(),
      installedAt: set.installedAt.toString(),
      trustingPeriodSec: period.toString(),
      trustRemainingSec: remaining.toString(),
      trustAlert: trustAlert(remaining, this.cfg.trustAlertSec),
      bscHead: head.toString(),
      liveOverlap,
      lastWindow: last ? { block: last.block.toString(), tx: last.tx, headers: last.headers } : null,
      lagBlocks: last ? (head - BigInt(last.block)).toString() : null,
      lastError: this.lastError ?? null,
    };
  }
}

/** The /status alert while the trusted set is close to expiring (or has expired). */
export function trustAlert(remainingSec: bigint, alertBelowSec: bigint): string | null {
  if (remainingSec >= alertBelowSec) return null;
  if (remainingSec <= 0n) return 'the trusted set has expired: the Parlia client accepts no window again and needs a new deployment';
  const days = Number(remainingSec) / 86_400;
  return `the trusted set expires in ${days.toFixed(1)} days: refresh the trusted epoch`;
}
