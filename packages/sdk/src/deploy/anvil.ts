// Local anvil nodes for rehearsals and dry runs.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Address, Hex, PublicClient } from 'viem';

export interface AnvilOptions {
  port: number;
  chainId: number;
  forkUrl?: string;
  forkBlock?: bigint;
  /** Block gas limit (Parlia windows and bindTrieId are heavy). */
  gasLimit?: bigint;
}

export interface Anvil {
  url: string;
  process: ChildProcess;
  stop(): void;
}

export function hasAnvil(): boolean {
  try {
    return spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

export async function startAnvil(o: AnvilOptions): Promise<Anvil> {
  const args = ['--port', String(o.port), '--chain-id', String(o.chainId), '--silent', '--gas-limit', String(o.gasLimit ?? 300_000_000n)];
  if (o.forkUrl) args.push('--fork-url', o.forkUrl, '--no-rate-limit', '--retries', '10');
  if (o.forkBlock !== undefined) args.push('--fork-block-number', o.forkBlock.toString());
  // Large proofs and initcodes; the chains we mirror have no EIP-170 problems for our contracts,
  // but keep anvil from rejecting anything a real node would accept.
  args.push('--disable-code-size-limit');
  const proc = spawn('anvil', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (d) => (stderr += d.toString()));
  const url = `http://127.0.0.1:${o.port}`;
  const started = Date.now();
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`anvil exited: ${stderr}`);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (r.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() - started > 60_000) {
      proc.kill();
      throw new Error(`anvil on ${o.port} did not start: ${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { url, process: proc, stop: () => proc.kill() };
}

export async function anvilRpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

export const setBalance = (url: string, who: Address, wei: bigint) => anvilRpc(url, 'anvil_setBalance', [who, `0x${wei.toString(16)}`]);
export const setCode = (url: string, at: Address, code: Hex) => anvilRpc(url, 'anvil_setCode', [at, code]);
export const impersonate = (url: string, who: Address) => anvilRpc(url, 'anvil_impersonateAccount', [who]);

interface PrestateAccount {
  storage?: Record<string, Hex>;
  code?: Hex;
}

export interface StateDiff {
  /** Storage slots that went from zero to non-zero, per contract. */
  newSlots: number;
  /** Slots cleared (non-zero to zero). */
  clearedSlots: number;
  /** Runtime code bytes created. */
  newCodeBytes: number;
}

/** Counts storage items and code a transaction created, from anvil's prestate diff tracer. */
export async function stateDiff(pub: PublicClient, hash: Hex): Promise<StateDiff> {
  const t = (await pub.request({
    method: 'debug_traceTransaction' as any,
    params: [hash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }] as any,
  })) as { pre: Record<string, PrestateAccount>; post: Record<string, PrestateAccount> };
  return countDiff(t.pre ?? {}, t.post ?? {});
}

export function countDiff(pre: Record<string, PrestateAccount>, post: Record<string, PrestateAccount>): StateDiff {
  let newSlots = 0;
  let clearedSlots = 0;
  let newCodeBytes = 0;
  const nonZero = (v: Hex | undefined) => v !== undefined && BigInt(v) !== 0n;
  for (const [addr, after] of Object.entries(post)) {
    const before = pre[addr] ?? {};
    for (const [slot, v] of Object.entries(after.storage ?? {})) {
      const old = before.storage?.[slot];
      if (nonZero(v) && !nonZero(old)) newSlots++;
      if (!nonZero(v) && nonZero(old)) clearedSlots++;
    }
    if (after.code && after.code !== '0x' && (!before.code || before.code === '0x')) newCodeBytes += (after.code.length - 2) / 2;
  }
  // diffMode omits slots that end up zero from `post`; they show only in `pre`.
  for (const [addr, before] of Object.entries(pre)) {
    for (const [slot, v] of Object.entries(before.storage ?? {})) {
      if (nonZero(v) && post[addr]?.storage?.[slot] === undefined && post[addr] !== undefined) clearedSlots++;
    }
  }
  return { newSlots, clearedSlots, newCodeBytes };
}
