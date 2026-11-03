/**
 * Saves what the relayer has seen on the testnets, so the docs can render it:
 *
 *   results/live-transfers.json   every transfer and order the relayer indexed (GET /transfers)
 *   results/attacks.json          one attack-lab run against the deployed contracts (POST /attacks/:id)
 *
 *   npx tsx packages/sdk/scripts/record-live.ts [--relayer <url>] [--hero <id>,<id>] [--no-attacks]
 *
 * --hero marks the transfers PROOF.md and JUDGES.md lead with (default: the first finalized one
 * in each direction). Reverted attack transactions are kept from the previous file: an attack
 * whose `tx` is already recorded keeps it. Then run `npm run docs`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const at = new Date().toISOString();
const { items } = await get<{ items: any[] }>('/transfers?limit=100');
// the list may be summaries: fetch each job in full
const transfers = [];
for (const j of items) {
  const full = await get<any>(`/transfers/${encodeURIComponent(j.id)}`);
  transfers.push(heroes.has(full.id) ? { ...full, hero: true } : full);
}
writeFileSync(resolve(ROOT, 'results/live-transfers.json'), JSON.stringify({ at, relayer, transfers }, null, 2) + '\n');
console.log(`results/live-transfers.json: ${transfers.length} jobs`);

if (!argv.includes('--no-attacks')) {
  const prevPath = resolve(ROOT, 'results/attacks.json');
  const prev = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, 'utf8')) : { items: [] };
  const lab = await get<{ items: { id: string; ready: boolean }[] }>('/attacks');
  const runs = [];
  for (const a of lab.items.filter((x) => x.ready)) {
    const r = await get<any>(`/attacks/${a.id}`, { method: 'POST' });
    const old = prev.items?.find((p: any) => p.id === a.id && p.tx);
    runs.push({ ...r, at: new Date().toISOString(), ...(old ? { tx: old.tx, block: old.block } : {}) });
    console.log(`${a.id}: ${r.defended ? 'rejected' : 'NOT rejected'} (${r.reason})`);
  }
  const skipped = lab.items.filter((x) => !x.ready).map((x) => x.id);
  writeFileSync(prevPath, JSON.stringify({ at, relayer, items: runs, notReady: skipped }, null, 2) + '\n');
  console.log(`results/attacks.json: ${runs.length} runs${skipped.length ? `, not ready: ${skipped.join(', ')}` : ''}`);
}
