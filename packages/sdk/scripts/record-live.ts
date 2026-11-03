/**
 * Saves what the relayer has seen on the testnets, so the docs and the deck can render it:
 *
 *   results/live-transfers.json   every transfer and order the relayer indexed (GET /transfers)
 *   results/attacks.json          one attack-lab run against the deployed contracts (POST /attacks/:id)
 *
 *   npx tsx packages/sdk/scripts/record-live.ts [--relayer <url>] [--hero <id>,<id>] [--no-attacks]
 *
 * Both files use the shape documented at the top of render-docs.ts. --hero marks the transfers
 * PROOF.md and JUDGES.md lead with (default: the first finalized one in each direction).
 * Reverted attack transactions are kept from the previous file: an attack whose `tx` is already
 * recorded keeps it. Then run `npm run docs`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress, zeroAddress } from 'viem';
import { loadAddresses } from '../src/deployments.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const relayer = (opt('relayer', process.env.RELAYER_URL ?? 'https://35-205-62-150.sslip.io') as string).replace(/\/+$/, '');
const heroes = new Set((opt('hero') ?? '').split(',').filter(Boolean));

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${relayer}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body as T;
}

type Chain = 'portaldot' | 'bsc';
const KIND_ASSET: Record<string, string> = { POT_TO_BSC: 'tPOT', PPOT_TO_PORTALDOT: 'pPOT', BNB_TO_PORTALDOT: 'tBNB', BNBB_TO_BSC: 'BNB.b' };
const addrs = loadAddresses();

/** Symbol of an order's input token on its origin chain. */
function tokenSymbol(chain: Chain, token: string): string {
  if (getAddress(token) === zeroAddress) return chain === 'portaldot' ? 'tPOT' : 'tBNB';
  const t = getAddress(token);
  if (chain === 'bsc' && addrs.bsc.PPOT && getAddress(addrs.bsc.PPOT) === t) return 'pPOT';
  if (chain === 'portaldot' && addrs.portaldot.bnbb && getAddress(addrs.portaldot.bnbb) === t) return 'BNB.b';
  return t;
}

/** A relayer job (API.md) in the shared live-transfers shape. */
function toRecord(j: any) {
  const from = j.from as Chain;
  const order = j.type === 'order';
  return {
    id: j.id,
    direction: from === 'bsc' ? 'bsc-to-portaldot' : 'portaldot-to-bsc',
    kind: order ? 'order' : 'canonical',
    asset: order ? tokenSymbol(from, j.inputToken) : (KIND_ASSET[j.kindName] ?? j.kindName),
    amount: String(order ? j.inputAmount : j.amount),
    state: j.state,
    ...(heroes.has(j.id) ? { hero: true } : {}),
    steps: (j.steps ?? []).map((s: any) => ({
      label: s.name,
      chain: s.chain,
      ...(s.tx ? { tx: s.tx } : {}),
      ...(s.block !== null && s.block !== undefined && s.block !== '' ? { block: Number(s.block) } : {}),
      at: s.at,
      ...(s.detail ? { detail: s.detail } : {}),
    })),
  };
}

const at = new Date().toISOString();
const { items } = await get<{ items: any[] }>('/transfers?limit=100');
const transfers = [];
for (const j of items) transfers.push(toRecord(await get<any>(`/transfers/${encodeURIComponent(j.id)}`)));
writeFileSync(resolve(ROOT, 'results/live-transfers.json'), JSON.stringify({ at, relayer, transfers }, null, 2) + '\n');
console.log(`results/live-transfers.json: ${transfers.length} transfers and orders`);

if (!argv.includes('--no-attacks')) {
  const path = resolve(ROOT, 'results/attacks.json');
  const prev = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const lab = await get<{ items: { id: string; ready: boolean }[] }>('/attacks');
  const attacks = [];
  for (const a of lab.items.filter((x) => x.ready)) {
    const r = await get<any>(`/attacks/${a.id}`, { method: 'POST' });
    const old = (prev.attacks ?? []).find((p: any) => p.id === a.id && p.tx);
    attacks.push({
      id: r.id,
      title: r.title,
      chain: r.chain,
      reason: r.reason,
      ...(old ? { tx: old.tx, ...(old.block !== undefined ? { block: old.block } : {}) } : {}),
      target: r.target,
      defended: r.defended,
    });
    console.log(`${a.id}: ${r.defended ? 'rejected' : 'NOT rejected'} (${r.reason})`);
  }
  const notReady = lab.items.filter((x) => !x.ready).map((x) => x.id);
  writeFileSync(path, JSON.stringify({ at, relayer, attacks, notReady }, null, 2) + '\n');
  console.log(`results/attacks.json: ${attacks.length} runs${notReady.length ? `, not ready: ${notReady.join(', ')}` : ''}`);
}
