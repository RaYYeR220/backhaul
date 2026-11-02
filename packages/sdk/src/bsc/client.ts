// Minimal JSON-RPC client for BNB Smart Chain nodes.
//
// Public BSC endpoints rate-limit aggressively, so everything here is sequential:
// one request (or one batch) in flight at a time, with retries and a fallback URL.

import type { Hex } from 'viem';

export const BSC_TESTNET_CHAIN_ID = 97;
export const BSC_TESTNET_RPCS = [
  'https://bsc-testnet-rpc.publicnode.com',
  'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
] as const;

/** Block as returned by `eth_getBlockByNumber(n, false)` on a BSC node. */
export interface RpcBlock {
  hash: Hex;
  parentHash: Hex;
  sha3Uncles: Hex;
  miner: Hex;
  stateRoot: Hex;
  transactionsRoot: Hex;
  receiptsRoot: Hex;
  logsBloom: Hex;
  difficulty: Hex;
  number: Hex;
  gasLimit: Hex;
  gasUsed: Hex;
  timestamp: Hex;
  extraData: Hex;
  mixHash: Hex;
  nonce: Hex;
  baseFeePerGas?: Hex;
  withdrawalsRoot?: Hex;
  blobGasUsed?: Hex;
  excessBlobGas?: Hex;
  parentBeaconBlockRoot?: Hex;
  requestsHash?: Hex;
  [extra: string]: unknown;
}

export interface RpcLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  logIndex: Hex;
  transactionIndex: Hex;
  transactionHash: Hex;
  blockNumber: Hex;
}

export interface RpcReceipt {
  type: Hex;
  status?: Hex;
  root?: Hex;
  cumulativeGasUsed: Hex;
  logsBloom: Hex;
  logs: RpcLog[];
  transactionHash: Hex;
  transactionIndex: Hex;
  blockNumber: Hex;
  blockHash: Hex;
}

export interface RpcProof {
  address: Hex;
  accountProof: Hex[];
  balance: Hex;
  codeHash: Hex;
  nonce: Hex;
  storageHash: Hex;
  storageProof: { key: Hex; value: Hex; proof: Hex[] }[];
}

export interface ParliaSnapshot {
  number: number;
  hash: Hex;
  epoch_length: number;
  turn_length: number;
  validators: Record<string, unknown>;
  [extra: string]: unknown;
}

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`${method}: ${message}`);
  }
}

export interface BscClientOptions {
  urls?: readonly string[];
  /** Attempts per URL before moving to the next one. */
  retries?: number;
  /** Base delay between retries, in milliseconds (doubles each attempt). */
  backoffMs?: number;
  /** Minimum gap between two requests, in milliseconds. */
  minGapMs?: number;
}

type Call = readonly [method: string, params: readonly unknown[]];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class BscClient {
  readonly urls: readonly string[];
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly minGapMs: number;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private lastSent = 0;

  constructor(opts: BscClientOptions = {}) {
    this.urls = opts.urls ?? BSC_TESTNET_RPCS;
    this.retries = opts.retries ?? 3;
    this.backoffMs = opts.backoffMs ?? 500;
    this.minGapMs = opts.minGapMs ?? 120;
    if (this.urls.length === 0) throw new Error('BscClient needs at least one URL');
  }

  /** Sends one request. */
  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    const [result] = await this.batch<[T]>([[method, params]]);
    return result;
  }

  /** Sends several requests as one JSON-RPC batch and returns the results in order. */
  batch<T extends unknown[]>(calls: readonly Call[]): Promise<T> {
    const run = this.queue.then(() => this.send<T>(calls));
    // Keep the queue alive even if this call fails.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send<T extends unknown[]>(calls: readonly Call[]): Promise<T> {
    let lastError: unknown;
    for (const url of this.urls) {
      for (let attempt = 0; attempt < this.retries; attempt++) {
        const wait = this.lastSent + this.minGapMs - Date.now();
        if (wait > 0) await sleep(wait);
        this.lastSent = Date.now();
        try {
          return await this.post<T>(url, calls);
        } catch (err) {
          lastError = err;
          // A JSON-RPC error from the node is final; transport errors are retried.
          if (err instanceof RpcError && err.code !== undefined && !isTransient(err)) throw err;
          await sleep(this.backoffMs * 2 ** attempt);
        }
      }
    }
    throw lastError;
  }

  private async post<T extends unknown[]>(url: string, calls: readonly Call[]): Promise<T> {
    const body = calls.map(([method, params]) => ({ jsonrpc: '2.0', id: this.nextId++, method, params }));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new RpcError(calls[0][0], undefined, `HTTP ${res.status}`);
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) throw new RpcError(calls[0][0], undefined, 'batch response is not an array');
    const byId = new Map<number, { result?: unknown; error?: { code: number; message: string } }>();
    for (const item of json) byId.set(item.id, item);
    return body.map((req) => {
      const item = byId.get(req.id);
      if (!item) throw new RpcError(req.method, undefined, 'missing response');
      if (item.error) throw new RpcError(req.method, item.error.code, item.error.message);
      return item.result;
    }) as T;
  }

  // ---- typed helpers ----

  async blockNumber(): Promise<bigint> {
    return BigInt(await this.request<Hex>('eth_blockNumber'));
  }

  async block(number: bigint | 'latest'): Promise<RpcBlock> {
    const tag = number === 'latest' ? 'latest' : toQuantity(number);
    const block = await this.request<RpcBlock | null>('eth_getBlockByNumber', [tag, false]);
    if (!block) throw new Error(`block ${number} not found`);
    return block;
  }

  /** Fetches `count` consecutive blocks starting at `from`, in batches of `chunk`. */
  async blocks(from: bigint, count: number, chunk = 20): Promise<RpcBlock[]> {
    const out: RpcBlock[] = [];
    for (let i = 0; i < count; i += chunk) {
      const n = Math.min(chunk, count - i);
      const calls = Array.from({ length: n }, (_, j) => ['eth_getBlockByNumber', [toQuantity(from + BigInt(i + j)), false]] as const);
      const res = await this.batch<(RpcBlock | null)[]>(calls);
      res.forEach((b, j) => {
        if (!b) throw new Error(`block ${from + BigInt(i + j)} not found`);
        out.push(b);
      });
    }
    return out;
  }

  async blockReceipts(number: bigint): Promise<RpcReceipt[]> {
    return this.request<RpcReceipt[]>('eth_getBlockReceipts', [toQuantity(number)]);
  }

  async transactionReceipt(txHash: Hex): Promise<RpcReceipt> {
    const r = await this.request<RpcReceipt | null>('eth_getTransactionReceipt', [txHash]);
    if (!r) throw new Error(`receipt for ${txHash} not found`);
    return r;
  }

  async snapshot(number: bigint): Promise<ParliaSnapshot> {
    return this.request<ParliaSnapshot>('parlia_getSnapshot', [toQuantity(number)]);
  }
}

function isTransient(err: RpcError): boolean {
  // -32005 / -32029 style "limit exceeded" / "too many requests" responses.
  return err.code === -32005 || err.code === -32029 || /rate|limit|busy|timeout/i.test(err.message);
}

export function toQuantity(n: bigint | number): Hex {
  return `0x${BigInt(n).toString(16)}`;
}
