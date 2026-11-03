// HTTP API for the app and for judges. JSON shapes are documented in ../API.md.
//
//   GET  /status              both light clients (heights, set ids, lag), job counts, addresses
//   GET  /transfers           recent transfers and orders
//   GET  /transfers/:id       one job's step timeline with explorer links (id, order id or source tx)
//   GET  /attacks             the attack lab: forged proofs the contracts must reject
//   POST /attacks/:id         runs one as an eth_call and returns the revert reason
//   POST /demo/transfer       moves a small amount with the server's demo key (capped, rate-limited)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getAddress, isAddress, parseEther, type Address, type Hex } from 'viem';
import { txLink, type ChainName } from '@backhaul/sdk';
import type { DemoLimits } from './config.js';
import type { Job, JsonlStore, OrderJob, TransferJob } from './store.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ attack lab interface

export interface AttackInfo {
  id: string;
  title: string;
  /** Chain whose contract is attacked. */
  chain: ChainName;
  /** Contract and function, e.g. "PortaldotLightClient.submitCommitment". */
  target: string;
  /** Error names that count as the contract defending itself (or "false" for a view returning false). */
  expects: string[];
  ready: boolean;
  /** What real material is still missing when not ready. */
  missing?: string[];
}

export interface AttackResult {
  id: string;
  title: string;
  chain: ChainName;
  target: string;
  call: { to: Address; data: Hex };
  reverted: boolean;
  /** Decoded revert reason, or the returned value of a view ("false"). */
  reason: string;
  defended: boolean;
  ms: number;
}

export interface AttackLab {
  list(): Promise<AttackInfo[]>;
  run(id: string): Promise<AttackResult>;
}

// ------------------------------------------------------------------ demo signer

export type DemoRoute = 'pot-to-bsc' | 'bnb-to-portaldot' | 'ppot-to-portaldot' | 'bnbb-to-bsc';
export const DEMO_ROUTES: Record<DemoRoute, { from: ChainName; asset: keyof DemoLimits['perRequest'] }> = {
  'pot-to-bsc': { from: 'portaldot', asset: 'tPOT' },
  'bnb-to-portaldot': { from: 'bsc', asset: 'tBNB' },
  'ppot-to-portaldot': { from: 'bsc', asset: 'pPOT' },
  'bnbb-to-bsc': { from: 'portaldot', asset: 'BNB.b' },
};

export interface DemoSigner {
  address: Address;
  /** Sends the route's lock/burn and returns the job id of the transfer it started. */
  send(route: DemoRoute, amount: bigint, recipient: Address): Promise<{ id: string; tx: Hex; chain: ChainName; block: bigint }>;
}

/** Per-request and per-day caps per asset, and a per-IP hourly rate limit. */
export class DemoGuard {
  private hits = new Map<string, number[]>();

  constructor(
    readonly limits: DemoLimits,
    readonly store: JsonlStore,
    readonly clock: () => number = Date.now,
  ) {}

  private dayKey(): string {
    return `demo:${new Date(this.clock()).toISOString().slice(0, 10)}`;
  }

  usedToday(): Record<string, string> {
    return this.store.getKv<Record<string, string>>(this.dayKey()) ?? {};
  }

  check(ip: string, asset: keyof DemoLimits['perRequest'], amount: bigint): void {
    if (amount <= 0n) throw new HttpError(400, 'amount must be positive');
    if (amount > this.limits.perRequest[asset]) {
      throw new HttpError(400, `at most ${this.limits.perRequest[asset]} wei of ${asset} per request`, { cap: this.limits.perRequest[asset].toString() });
    }
    const used = BigInt(this.usedToday()[asset] ?? '0');
    if (used + amount > this.limits.perDay[asset]) throw new HttpError(429, `daily ${asset} budget of the demo signer is used up`, { retryAfterSec: this.secondsToMidnight() });
    const now = this.clock();
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= this.limits.perIpPerHour) {
      throw new HttpError(429, 'too many demo transfers from this address, try again later', { retryAfterSec: Math.ceil((recent[0] + 3_600_000 - now) / 1000) });
    }
  }

  record(ip: string, asset: keyof DemoLimits['perRequest'], amount: bigint): void {
    const now = this.clock();
    this.hits.set(ip, [...(this.hits.get(ip) ?? []).filter((t) => now - t < 3_600_000), now]);
    const used = this.usedToday();
    used[asset] = (BigInt(used[asset] ?? '0') + amount).toString();
    this.store.setKv(this.dayKey(), used);
  }

  private secondsToMidnight(): number {
    const d = new Date(this.clock());
    return Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - d.getTime()) / 1000);
  }
}

// ------------------------------------------------------------------ views

const KIND_NAMES: Record<number, string> = { 1: 'POT_TO_BSC', 2: 'PPOT_TO_PORTALDOT', 3: 'BNB_TO_PORTALDOT', 4: 'BNBB_TO_BSC' };

export function jobView(j: Job) {
  const steps = j.steps.map((s) => ({
    name: s.name,
    at: s.at,
    chain: s.chain ?? null,
    tx: s.tx ?? null,
    block: s.block ?? null,
    link: s.tx && s.chain ? txLink(s.chain, s.tx, s.block) : null,
    detail: s.detail ?? null,
  }));
  const base = { id: j.id, type: j.type, state: j.state, createdAt: j.createdAt, updatedAt: j.updatedAt, error: j.error ?? null, steps };
  if (j.type === 'transfer') {
    const t = j as TransferJob;
    return { ...base, from: t.src, to: t.dst, nonce: t.nonce, kind: t.kind, kindName: KIND_NAMES[t.kind] ?? null, recipient: t.recipient, amount: t.amount, sourceTx: t.srcTx };
  }
  const o = j as OrderJob;
  return {
    ...base,
    from: o.origin,
    to: o.dest,
    orderId: o.orderId,
    user: o.user,
    inputToken: o.inputToken,
    inputAmount: o.inputAmount,
    outputToken: o.outputToken,
    outputAmount: o.outputAmount,
    recipient: o.recipient,
    fillDeadline: o.fillDeadline,
    fill: o.fill ?? null,
    sourceTx: o.openTx,
  };
}

// ------------------------------------------------------------------ server

export interface ApiDeps {
  store: JsonlStore;
  status(): Promise<Record<string, unknown>>;
  attacks: AttackLab;
  demo?: DemoSigner;
  guard: DemoGuard;
  /** Seconds to cache /status (chain reads). */
  statusCacheSec?: number;
  log?: (m: string) => void;
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

export function createApi(deps: ApiDeps): Server {
  let cached: { at: number; v: Record<string, unknown> } | undefined;
  const ttl = (deps.statusCacheSec ?? 5) * 1000;

  const findJob = (id: string): Job | undefined => {
    const direct = deps.store.get(id) ?? deps.store.get(id.toLowerCase());
    if (direct) return direct;
    const tx = id.toLowerCase();
    return deps.store.list((j) => (j.type === 'transfer' ? j.srcTx.toLowerCase() === tx : j.openTx.toLowerCase() === tx || j.orderId.toLowerCase() === tx))[0];
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<unknown> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method ?? 'GET';

    if (m === 'GET' && path === '/status') {
      if (!cached || Date.now() - cached.at > ttl) cached = { at: Date.now(), v: { at: new Date().toISOString(), ...(await deps.status()) } };
      return cached.v;
    }
    if (m === 'GET' && path === '/transfers') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 100);
      const type = url.searchParams.get('type');
      const items = deps.store.list((j) => !type || j.type === type).reverse().slice(0, limit).map(jobView);
      return { items };
    }
    const t = /^\/transfers\/([^/]+)$/.exec(path);
    if (m === 'GET' && t) {
      const job = findJob(decodeURIComponent(t[1]));
      if (!job) throw new HttpError(404, 'no such transfer or order (it may not be indexed yet)');
      return jobView(job);
    }
    if (m === 'GET' && path === '/attacks') {
      const items = await deps.attacks.list();
      return { items, total: items.length, ready: items.filter((a) => a.ready).length };
    }
    const a = /^\/attacks\/([a-z0-9-]+)$/.exec(path);
    if (m === 'POST' && a) {
      const known = (await deps.attacks.list()).find((x) => x.id === a[1]);
      if (!known) throw new HttpError(404, 'no such attack');
      if (!known.ready) throw new HttpError(409, 'this attack needs real proof material that does not exist yet', { missing: known.missing ?? [] });
      return deps.attacks.run(a[1]);
    }
    if (m === 'POST' && path === '/demo/transfer') {
      if (!deps.demo) throw new HttpError(503, 'the demo signer is not configured');
      const b = await body(req);
      const route = b.route as DemoRoute;
      if (!DEMO_ROUTES[route]) throw new HttpError(400, `route must be one of ${Object.keys(DEMO_ROUTES).join(', ')}`);
      if (typeof b.recipient !== 'string' || !isAddress(b.recipient)) throw new HttpError(400, 'recipient must be a 0x address');
      if (typeof b.amount !== 'string' || !/^\d+(\.\d{1,18})?$/.test(b.amount)) throw new HttpError(400, 'amount must be a decimal string, e.g. "0.5"');
      const amount = parseEther(b.amount);
      const { asset } = DEMO_ROUTES[route];
      if ((asset === 'tPOT' || asset === 'pPOT') && amount % 10_000n !== 0n) throw new HttpError(400, 'tPOT has 14 decimals');
      const ip = clientIp(req);
      deps.guard.check(ip, asset, amount);
      const r = await deps.demo.send(route, amount, getAddress(b.recipient));
      deps.guard.record(ip, asset, amount);
      res.statusCode = 202;
      return { id: r.id, route, amount: amount.toString(), recipient: getAddress(b.recipient), tx: r.tx, link: txLink(r.chain, r.tx, r.block), statusUrl: `/transfers/${encodeURIComponent(r.id)}` };
    }
    throw new HttpError(404, 'not found');
  };

  return createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    handle(req, res).then(
      (v) => {
        if (res.statusCode === 0 || !res.statusCode) res.statusCode = 200;
        res.end(json(v));
      },
      (e) => {
        const err = e instanceof HttpError ? e : new HttpError(500, (e as Error).message.split('\n')[0]);
        if (!(e instanceof HttpError)) deps.log?.(`api: ${req.method} ${req.url}: ${(e as Error).message}`);
        res.statusCode = err.status;
        res.end(json({ error: err.message, ...err.extra }));
      },
    );
  });
}
