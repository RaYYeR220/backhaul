// Keeps the BEEFY light client of Portaldot (on BSC) alive and current:
//  - archives every justification the node streams (the node forgets them after the session),
//    with a periodic scan of recent block bodies as a safety net,
//  - rotates to the next validator set as soon as a session starts,
//  - submits a fresh commitment at least every `commitEveryMs` (jobs import headers on demand).

import { BeefyHaltError, portaldot } from '@backhaul/sdk';
import type { Chains } from './chains.js';
import type { RelayerConfig } from './config.js';

export interface BeefyStatus {
  setId: string;
  latestBlock: number;
  beefyHead: number;
  finalized: number;
  lagBlocks: number;
  archived: number;
  halted: string | null;
  lastError: string | null;
}

export class BeefyLoop {
  private unsubscribe?: () => Promise<void>;
  private timer?: NodeJS.Timeout;
  private lastSubmit = 0;
  private running = false;
  halted: string | null = null;
  lastError: string | null = null;

  constructor(
    readonly ch: Chains,
    readonly cfg: RelayerConfig['beefy'],
    readonly log: (m: string) => void,
  ) {}

  async start(): Promise<void> {
    const lcSet = await this.ch.beefy.lc.currentSetId();
    this.unsubscribe = await this.ch.archive.subscribe(this.ch.pd.client.provider, (e) => {
      // a new session's first justification: rotate right away
      if (BigInt(e.validatorSetId) > lcSet) void this.tick();
    });
    this.timer = setInterval(() => void this.tick(), this.cfg.tickMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.unsubscribe?.().catch(() => undefined);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.ch.beefy.refreshArchive();
      await this.ch.beefy.rotateIfNeeded();
      if (Date.now() - this.lastSubmit >= this.cfg.commitEveryMs) {
        const b = await this.ch.beefy.submitLatest();
        if (b !== undefined) this.lastSubmit = Date.now();
      }
      this.lastError = null;
    } catch (e) {
      if (e instanceof BeefyHaltError) {
        this.halted = e.message;
        this.log(`BEEFY CLIENT HALTED: ${e.message}`);
      } else {
        this.lastError = (e as Error).message.split('\n')[0];
        this.log(`beefy tick: ${this.lastError}`);
      }
    } finally {
      this.running = false;
    }
  }

  async status(): Promise<BeefyStatus> {
    const lc = this.ch.beefy.lc;
    const [setId, latestBlock, beefyHead, finalized] = await Promise.all([
      lc.currentSetId(),
      lc.latestBlock(),
      this.ch.beefy.chain.beefyHead(),
      portaldot.finalizedNumber(this.ch.pd.client.api),
    ]);
    return {
      setId: setId.toString(),
      latestBlock,
      beefyHead,
      finalized,
      lagBlocks: finalized - latestBlock,
      archived: this.ch.archive.entries().length,
      halted: this.halted ?? null,
      lastError: this.lastError ?? null,
    };
  }
}
