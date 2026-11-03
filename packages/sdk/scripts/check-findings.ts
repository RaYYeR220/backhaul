/**
 * Re-checks the public-node findings in docs/FINDINGS.md against the live Portaldot nodes and
 * writes results/findings.json, which the docs render. Read-only: it only calls public RPC methods.
 *
 *   npm run findings
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = resolve(ROOT, 'results/findings.json');

const NODES = ['https://test-node-v3.portaldot.dev', 'https://live-v3-node.portaldot.dev'];
const EVM_RPC = 'https://test-evm-rpc-v3.portaldot.dev';

let id = 0;
async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string; data?: string } };
  if (body.error) throw new Error(body.error.data ? `${body.error.message} (${body.error.data})` : body.error.message);
  return body.result as T;
}

/** (a) MMR proofs: `mmr_generateProof` for a finalized block a few hundred blocks back. */
async function mmr(url: string) {
  const head = await rpc<{ number: string }>(url, 'chain_getHeader', [await rpc<string>(url, 'chain_getFinalizedHead')]);
  const block = parseInt(head.number, 16) - 500;
  let ok = false;
  let error: string | undefined;
  try {
    await rpc(url, 'mmr_generateProof', [[block], null, null]);
    ok = true;
  } catch (e) {
    error = (e as Error).message;
  }
  let rootOk = false;
  try {
    await rpc(url, 'mmr_root', []);
    rootOk = true;
  } catch {
    rootOk = false;
  }
  return { url, block, ok, error, rootOk };
}

/** (c) pallet-revive's Ethereum blocks: stateRoot against transactionsRoot on recent blocks with transactions. */
async function ethRoots(want = 6, scan = 4000) {
  const head = parseInt(await rpc<string>(EVM_RPC, 'eth_blockNumber'), 16);
  const blocks: { number: number; txs: number; stateRoot: string; transactionsRoot: string; receiptsRoot: string }[] = [];
  for (let n = head; n > head - scan && blocks.length < want; n--) {
    const b = await rpc<any>(EVM_RPC, 'eth_getBlockByNumber', [`0x${n.toString(16)}`, false]);
    if (!b || !b.transactions?.length) continue;
    blocks.push({ number: n, txs: b.transactions.length, stateRoot: b.stateRoot, transactionsRoot: b.transactionsRoot, receiptsRoot: b.receiptsRoot });
  }
  return { url: EVM_RPC, head, equal: blocks.filter((b) => b.stateRoot === b.transactionsRoot).length, blocks };
}

const out = {
  at: new Date().toISOString(),
  mmr: { nodes: [] as Awaited<ReturnType<typeof mmr>>[] },
  ethRoots: undefined as Awaited<ReturnType<typeof ethRoots>> | undefined,
};
for (const url of NODES) {
  const r = await mmr(url);
  out.mmr.nodes.push(r);
  console.log(`mmr_generateProof on ${url} at ${r.block}: ${r.ok ? 'ok' : r.error}; mmr_root ${r.rootOk ? 'ok' : 'fails'}`);
}
out.ethRoots = await ethRoots();
console.log(`${out.ethRoots.equal} of ${out.ethRoots.blocks.length} recent blocks with transactions have stateRoot == transactionsRoot`);
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${OUT}`);
