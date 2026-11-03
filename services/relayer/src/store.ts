// Append-only JSON-lines store: every write appends the record's full new version, the last
// line for an id wins on load, and the file is compacted on open once it has grown. A crash
// mid-write leaves at most one torn last line, which is skipped.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address, Hex } from 'viem';
import type { ChainName } from '@backhaul/sdk';

export interface Step {
  name: string;
  at: string;
  chain?: ChainName;
  tx?: Hex;
  block?: string;
  detail?: string;
}

/** A storage proof of the BSC Outbox grabbed at the head, held until its block is finalized. */
export interface HeldBscProof {
  key: Hex;
  kind: 'commitment' | 'absence';
  block: string;
  timestamp: string;
  proof: Hex;
}

interface JobBase {
  id: string;
  createdAt: string;
  updatedAt: string;
  steps: Step[];
  attempts: number;
  /** Do not retry before this time (ms since epoch). */
  retryAt?: number;
  error?: string;
  /** Receipt-path attempts for a BSC commitment, once its window headers were there. */
  bscReceipt?: { key: Hex; tries: number };
  bscHeld?: HeldBscProof;
}

export type TransferState = 'locked' | 'proven' | 'finalized' | 'failed';

export interface TransferJob extends JobBase {
  type: 'transfer';
  src: ChainName;
  dst: ChainName;
  nonce: string;
  kind: number;
  recipient: Address;
  amount: string;
  /** Outbox key and committed value on the source chain. */
  key: Hex;
  value: Hex;
  srcTx: Hex;
  srcBlock: string;
  state: TransferState;
  /** The proof that was accepted (kept for the attack lab). */
  proof?: Hex;
  proofHeader?: string;
}

export type OrderState = 'open' | 'filled' | 'settled' | 'refunded' | 'failed';

export interface OrderJob extends JobBase {
  type: 'order';
  origin: ChainName;
  dest: ChainName;
  orderId: Hex;
  originData: Hex;
  user: Address;
  inputToken: Address;
  inputAmount: string;
  outputToken: Address;
  outputAmount: string;
  recipient: Address;
  fillDeadline: number;
  openTx: Hex;
  openBlock: string;
  state: OrderState;
  fill?: { tx: Hex; block: string; filler: Address; repayTo: Address };
  /** A vault fill was sent (or found unnecessary). */
  vaultTried?: boolean;
  solverTried?: boolean;
  flushed?: boolean;
  proof?: Hex;
}

export type Job = TransferJob | OrderJob;

type Line = { t: 'job'; v: Job } | { t: 'kv'; k: string; v: unknown };

export class JsonlStore {
  private readonly jobs = new Map<string, Job>();
  private readonly kv = new Map<string, unknown>();
  private lines = 0;

  private constructor(readonly path: string) {}

  static open(path: string, compactAbove = 5_000): JsonlStore {
    const s = new JsonlStore(path);
    if (existsSync(path)) {
      for (const raw of readFileSync(path, 'utf8').split('\n')) {
        if (!raw.trim()) continue;
        let line: Line;
        try {
          line = JSON.parse(raw) as Line;
        } catch {
          continue; // torn tail
        }
        s.lines++;
        if (line.t === 'job') s.jobs.set(line.v.id, line.v);
        else s.kv.set(line.k, line.v);
      }
      if (s.lines > compactAbove && s.lines > 2 * (s.jobs.size + s.kv.size)) s.compact();
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
    return s;
  }

  private append(line: Line) {
    appendFileSync(this.path, JSON.stringify(line, bigintSafe) + '\n');
    this.lines++;
  }

  compact(): void {
    const tmp = `${this.path}.tmp`;
    const out: string[] = [];
    for (const [k, v] of this.kv) out.push(JSON.stringify({ t: 'kv', k, v }, bigintSafe));
    for (const v of this.jobs.values()) out.push(JSON.stringify({ t: 'job', v }, bigintSafe));
    writeFileSync(tmp, out.join('\n') + (out.length ? '\n' : ''));
    renameSync(tmp, this.path);
    this.lines = out.length;
  }

  get<T extends Job = Job>(id: string): T | undefined {
    const j = this.jobs.get(id);
    return j ? (structuredClone(j) as T) : undefined;
  }

  put(job: Job): Job {
    job.updatedAt = new Date().toISOString();
    this.jobs.set(job.id, structuredClone(job));
    this.append({ t: 'job', v: job });
    return job;
  }

  list(filter: (j: Job) => boolean = () => true): Job[] {
    return [...this.jobs.values()].filter(filter).map((j) => structuredClone(j)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getKv<T>(k: string): T | undefined {
    return this.kv.get(k) as T | undefined;
  }

  setKv(k: string, v: unknown): void {
    const safe = JSON.parse(JSON.stringify(v, bigintSafe)) as unknown;
    if (JSON.stringify(this.kv.get(k)) === JSON.stringify(safe)) return;
    this.kv.set(k, safe);
    this.append({ t: 'kv', k, v: safe });
  }
}

/** JSON replacer: bigints as decimal strings. */
export const bigintSafe = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export function step(name: string, extra: Omit<Step, 'name' | 'at'> = {}): Step {
  return { name, at: new Date().toISOString(), ...extra };
}
