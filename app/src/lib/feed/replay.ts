import type { BeefyProof, BscHeader, ChainSets, Fixture, FeedSink, PdtBlock } from "./types";

const LANE_HEADERS = 48;
const LANE_BLOCKS = 7;

/** One choreographed round trip found in the recording: a deposit that reaches quorum, then a lock BEEFY covers. */
export interface ReplayCycle {
  /** Header the tBNB deposit lands in. */
  deposit: BscHeader;
  /** Portaldot block that carries the BNB.b lock on the way back. */
  lockBlock: PdtBlock;
  /** Replay time to seek to for the way in. */
  start: number;
  /** Replay time to seek to for the way back. */
  backStart: number;
}

/**
 * Plays the recorded headers, blocks and BEEFY justifications back at their real timestamps.
 * Nothing is synthesized: every event the rail sees is a row of the recording.
 */
export class Replay {
  readonly sets: ChainSets;
  readonly cycles: ReplayCycle[];
  private readonly blocks: PdtBlock[];
  private readonly proofs: BeefyProof[];
  private readonly count: number;
  private clock = 0;
  private ib = 0;
  private ip = 0;
  private ie = 0;

  constructor(private readonly fx: Fixture) {
    this.count = fx.bsc.miners.length;
    this.blocks = fx.pdt.blocks.map(([n, t]) => ({ n, t }));
    this.proofs = fx.pdt.beefy.map(([t, block]) => ({
      block,
      t,
      setId: fx.pdt.setId,
      signed: fx.pdt.authorities.map((_, i) => i),
    }));
    this.sets = { validators: fx.bsc.validators, authorities: fx.pdt.authorities, setId: fx.pdt.setId };
    this.cycles = this.plan();
  }

  /** First and last header and block numbers in the recording. */
  get span() {
    return {
      bsc: [this.fx.bsc.n0, this.fx.bsc.n0 + this.count - 1] as const,
      pdt: [this.blocks[0].n, this.blocks[this.blocks.length - 1].n] as const,
      recorded: this.fx.recorded,
    };
  }

  header(i: number): BscHeader {
    const { n0, t0, dt, miners } = this.fx.bsc;
    return { n: n0 + i, sealer: Number(miners[i]), t: t0 + i * dt };
  }

  get now() {
    return this.clock;
  }

  seek(t: number, sink: FeedSink) {
    const { t0, dt } = this.fx.bsc;
    this.clock = t;
    this.ib = Math.max(0, Math.min(this.count, Math.floor((t - t0) / dt) + 1));
    this.ip = firstAfter(this.blocks, t);
    this.ie = firstAfter(this.proofs, t);
    const take = Math.min(this.ib, LANE_HEADERS);
    sink.reset({
      sets: this.sets,
      headers: Array.from({ length: take }, (_, k) => this.header(this.ib - take + k)),
      blocks: this.blocks.slice(Math.max(0, this.ip - LANE_BLOCKS), this.ip),
      beefyBlock: this.proofs[Math.max(0, this.ie - 1)].block,
    });
  }

  /** Moves the replay clock forward, emitting every recorded event that falls inside the step. */
  advance(ms: number, sink: FeedSink) {
    this.clock += ms;
    while (this.ib < this.count && this.header(this.ib).t <= this.clock) sink.header(this.header(this.ib++));
    while (this.ip < this.blocks.length && this.blocks[this.ip].t <= this.clock) sink.block(this.blocks[this.ip++]);
    while (this.ie < this.proofs.length && this.proofs[this.ie].t <= this.clock) sink.beefy(this.proofs[this.ie++]);
  }

  /**
   * Finds round trips the recording can show end to end: a deposit whose header gathers a quorum of
   * distinct sealers and is released into a Portaldot block, followed by a lock in the block a
   * recorded BEEFY justification covers, released on a later recorded BNB Chain header.
   */
  private plan(): ReplayCycle[] {
    const { t0, dt } = this.fx.bsc;
    const need = Math.ceil((2 * this.sets.validators.length) / 3);
    const quorumAt = (i: number) => {
      const seen = new Set<number>();
      for (let j = i; j < this.count; j++) {
        seen.add(this.header(j).sealer);
        if (seen.size >= need) return j;
      }
      return -1;
    };
    const cycles: ReplayCycle[] = [];
    for (let k = 1; k < this.proofs.length; k++) {
      const proof = this.proofs[k];
      const lockBlock = this.blocks.find((b) => b.n === proof.block);
      if (!lockBlock || lockBlock.t - 30_000 < t0) continue;
      let deposit: BscHeader | null = null;
      for (let i = Math.floor((lockBlock.t - 16_000 - t0) / dt); i >= 0; i--) {
        const q = quorumAt(i);
        if (q < 0) continue;
        const release = this.blocks.find((b) => b.t >= this.header(q).t + 1750);
        if (!release || release.n >= lockBlock.n) continue;
        if (release.t + 3600 <= lockBlock.t) {
          deposit = this.header(i);
          break;
        }
      }
      if (!deposit) continue;
      if (Math.ceil((proof.t + 2300 - t0) / dt) >= this.count) continue;
      cycles.push({ deposit, lockBlock, start: deposit.t - 1700, backStart: lockBlock.t - 2200 });
    }
    return cycles;
  }
}

function firstAfter<T extends { t: number }>(rows: T[], t: number) {
  const i = rows.findIndex((r) => r.t > t);
  return i < 0 ? rows.length : i;
}
