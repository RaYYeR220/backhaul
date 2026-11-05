/**
 * Renders every number and every on-chain link in the reviewer docs from the files that hold
 * them, so nothing in the docs is typed by hand:
 *
 *   results/*.json              tests, gas, benchmark, rehearsals, deploy-cost estimates, findings
 *   deployments/<chain>.json    addresses and deploy transactions (written by deploy.ts)
 *   results/live-transfers.json transfers and orders on the testnets (written by record-live.ts)
 *   results/attacks.json        attack-lab runs against the deployed contracts (record-live.ts)
 *
 * It rewrites only what sits between `<!-- render:NAME -->` and `<!-- /render:NAME -->` in
 * README.md and docs/*.md. Where a source is missing it says "not deployed yet" or "not measured
 * yet"; it never fills in a value.
 *
 *   npm run docs              # rewrite the regions
 *   npm run docs -- --check   # exit 1 if any region is out of date
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ATTACKS } from '../src/attacks.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const CHECK = process.argv.includes('--check');

const NOT_DEPLOYED = 'not deployed yet';
const NOT_MEASURED = 'not measured yet';
const REPO = 'https://github.com/RaYYeR220/backhaul';
const SITE = 'https://backhaul-bridge.vercel.app';
const RELAYER = 'https://35-205-62-150.sslip.io';
const BSCSCAN = 'https://testnet.bscscan.com';
const PD_SCAN = 'https://scanner-testnet-v3.portaldot.dev';
/** BSC testnet block time, used only where a duration is modeled from a header count. */
const BSC_BLOCK_SEC = 0.45;

type Chain = 'portaldot' | 'bsc';
const CHAINS: Chain[] = ['portaldot', 'bsc'];
const CHAIN_NAME: Record<Chain, string> = { portaldot: 'Portaldot V3 testnet', bsc: 'BNB Chain testnet' };
const other = (c: Chain): Chain => (c === 'bsc' ? 'portaldot' : 'bsc');

// ------------------------------------------------------------------ sources

function read<T = any>(rel: string): T | undefined {
  const p = resolve(ROOT, rel);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined;
}

const tests = read('results/test-counts.json');
const beefyGas = read('results/beefy-gas-local.json');
const parliaGas = read('results/parlia-gas-local.json');
const bench = read('results/benchmark.json');
const rehB = read('results/rehearsal-beefy.json');
const rehP = read('results/rehearsal-parlia.json');
const cost = read('results/deploy-cost-estimate.json');
const costMin = read('results/deploy-cost-estimate-minimal.json');
const costAll = read('results/deploy-cost-estimate-with-feed-ink.json');
const findings = read('results/findings.json');

interface Contract {
  artifact?: string;
  address: string;
  tx?: string;
  block?: number;
  codeBytes?: number;
}
interface Deployment {
  chain: Chain;
  chainId: number;
  deployer?: string;
  updatedAt?: string;
  contracts: Record<string, Contract>;
  steps: Record<string, { tx?: string; block?: number; at?: string }>;
  meta: Record<string, any>;
}
const dep: Record<Chain, Deployment | undefined> = {
  portaldot: read('deployments/portaldot.json'),
  bsc: read('deployments/bsc.json'),
};
const contractsOf = (c: Chain) => Object.entries(dep[c]?.contracts ?? {});
const deployed: Record<Chain, boolean> = { portaldot: contractsOf('portaldot').length > 0, bsc: contractsOf('bsc').length > 0 };
const has = (c: Chain, name: string) => !!dep[c]?.contracts?.[name];

// ---------------------------------------------------------------- live records: the schema
//
// results/live-transfers.json and results/attacks.json are shared with the pitch deck
// (app/scripts/deck-facts.mjs), and this is their canonical shape. record-live.ts writes them
// from the relayer; anything else that writes them must keep to it.
//
// results/live-transfers.json
//   {
//     "at"?: ISO-8601,                          when it was recorded
//     "relayer"?: string,                       the relayer it was read from
//     "transfers": [{
//       "id": string,                           "portaldot:7", "bsc:3", or an order id (0x + 64 hex)
//       "direction": "portaldot-to-bsc" | "bsc-to-portaldot",
//       "kind": "canonical" | "order",          canonical bridge transfer, or ERC-7683 fast fill
//       "asset": string,                        what the user sent: tPOT, pPOT, tBNB or BNB.b
//       "amount": string,                       18-decimal wei-units, as the relayer reports them
//       "state"?: string,                       the relayer's job state (finalized, settled, …)
//       "hero"?: boolean,                       the transfer PROOF.md and JUDGES.md lead with
//       "steps": [{
//         "label": string,                      the relayer's step name, see below
//         "chain": "portaldot" | "bsc",
//         "tx"?: "0x…",                         absent for steps that sent no transaction
//         "block"?: number,
//         "at": ISO-8601,
//         "detail"?: string
//       }]
//     }],
//     "feed"?: { "tx": "0x…", "block"?: number, "at"?: ISO-8601 }   a BscFeed update on Portaldot
//   }
//   Step labels are the relayer's (services/relayer/API.md): canonical transfers go locked →
//   beefy | parlia → finalized (→ vault repaid); orders go opened → filled → settled | refunded,
//   with solver / vault steps in between.
//
// results/attacks.json
//   {
//     "at"?: ISO-8601, "relayer"?: string,
//     "attacks": [{
//       "id": string,                           an id from packages/sdk/src/attacks.ts
//       "title": string,
//       "chain": "portaldot" | "bsc",           where the attacked contract lives
//       "reason": string,                       the decoded revert, or "false" for a view verifier
//       "tx"?: "0x…", "block"?: number,         a reverted transaction with the same calldata
//       "target"?: string, "defended"?: boolean  filled in from attacks.ts when absent
//     }]
//   }

interface LiveStep {
  label: string;
  chain: Chain;
  tx?: string | null;
  block?: number | string | null;
  at?: string;
  detail?: string | null;
}
interface LiveTransfer {
  id: string;
  direction: 'portaldot-to-bsc' | 'bsc-to-portaldot';
  kind: 'canonical' | 'order';
  asset: string;
  amount: string;
  state?: string;
  hero?: boolean;
  steps: LiveStep[];
}
interface LiveAttack {
  id: string;
  title: string;
  chain: Chain;
  reason: string;
  tx?: string;
  block?: number;
  target?: string;
  defended?: boolean;
}

/** The renderer's view of one transfer or order. */
interface Step {
  name: string;
  at?: string;
  chain?: Chain;
  tx?: string | null;
  block?: string | number | null;
  detail?: string | null;
}
interface Job {
  id: string;
  type: 'transfer' | 'order';
  state: string;
  from: Chain;
  to: Chain;
  asset: string;
  amount?: string;
  steps: Step[];
  hero?: boolean;
}
const live = read<{ at?: string; relayer?: string; transfers?: LiveTransfer[]; feed?: { tx?: string; block?: number; at?: string } }>('results/live-transfers.json');
const jobs: Job[] = (live?.transfers ?? []).map((t) => {
  const from: Chain = t.direction === 'bsc-to-portaldot' ? 'bsc' : 'portaldot';
  return {
    id: t.id,
    type: t.kind === 'order' ? 'order' : 'transfer',
    state: t.state ?? '',
    from,
    to: other(from),
    asset: t.asset,
    amount: t.amount,
    hero: t.hero,
    steps: (t.steps ?? []).map((s) => ({ name: s.label, chain: s.chain, tx: s.tx, block: s.block, at: s.at, detail: s.detail })),
  };
});

interface AttackRun extends LiveAttack {
  target: string;
  defended: boolean;
}
const attacksLive = read<{ at?: string; relayer?: string; attacks?: LiveAttack[] }>('results/attacks.json');
/** Defended = the revert is one the attack expects (attacks.ts), unless the file says otherwise. */
const expected = (id: string, reason: string) => !!ATTACKS.find((a) => a.id === id)?.expects.includes(reason.split('(')[0]);

// ------------------------------------------------------------------ formatting

const isSet = (v: unknown) => v !== null && v !== undefined && v !== '';
const int = (v: unknown) => (isSet(v) ? Number(v).toLocaleString('en-US') : NOT_MEASURED);
/** 18-decimal wei-units (tPOT, tBNB, pPOT, BNB.b on the EVM side) to a grouped decimal. */
function units(v: unknown, dp = 2): string {
  if (!isSet(v)) return NOT_MEASURED;
  const x = BigInt(String(v));
  const scale = 10n ** BigInt(18 - dp);
  const rounded = (x + scale / 2n) / scale;
  const whole = rounded / 10n ** BigInt(dp);
  const frac = (rounded % 10n ** BigInt(dp)).toString().padStart(dp, '0');
  return dp ? `${whole.toLocaleString('en-US')}.${frac}` : whole.toLocaleString('en-US');
}
const sumWei = (...xs: unknown[]) => xs.reduce<bigint>((a, x) => a + BigInt(String(x ?? 0)), 0n);
const kb = (b: unknown) => (isSet(b) ? `${(Number(b) / 1000).toFixed(1)} kB` : NOT_MEASURED);
const ms = (ps: unknown) => (isSet(ps) ? `${(Number(ps) / 1e9).toFixed(2)} ms` : NOT_MEASURED);
const day = (iso?: string) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : NOT_MEASURED);
const short = (h: string) => (h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h);
const secs = (a?: string, b?: string) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 1000) : undefined);
const dur = (s?: number) => (s === undefined ? NOT_MEASURED : s < 120 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const row = (cells: unknown[]) => `| ${cells.map((c) => String(c).replace(/\n/g, ' ').replace(/\|/g, '\\|')).join(' | ')} |`;
const table = (head: string[], rows: unknown[][]) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');

const bscTx = (h: string) => `${BSCSCAN}/tx/${h}`;
const bscAddr = (a: string) => `${BSCSCAN}/address/${a}`;
const pdBlock = (n: string | number) => `${PD_SCAN}/#/blocks/${n}`;
const pdAccount = (a: string) => `${PD_SCAN}/#/accounts/0x${a.slice(2).toLowerCase()}${'ee'.repeat(12)}`;
const addrLink = (c: Chain, a: string) => `[\`${a}\`](${c === 'bsc' ? bscAddr(a) : pdAccount(a)})`;
/** BscScan links every transaction; the Portaldot explorer indexes blocks, so a tx links to its block. */
function txLink(c: Chain, tx?: string | null, block?: string | number | null, full = false): string {
  if (!tx) return '—';
  const label = full ? tx : short(tx);
  if (c === 'bsc') return `[\`${label}\`](${bscTx(tx)})`;
  return isSet(block) ? `\`${label}\` ([block ${int(block)}](${pdBlock(block!)}))` : `\`${label}\``;
}

// ------------------------------------------------------------------ derived facts

const rehAttacks = [...(rehB?.attacks ?? []).map((a: any) => ({ ...a, side: 'beefy' })), ...(rehP?.attacks ?? []).map((a: any) => ({ ...a, side: 'parlia' }))];
const rehFired = rehAttacks.filter((a) => a.defended !== undefined);
const rehDefended = rehFired.filter((a) => a.defended);
const rehSkipped = rehAttacks.filter((a) => a.skipped);
const attackTitle = (id: string) => ATTACKS.find((a) => a.id === id)?.title ?? id;
const attackTarget = (id: string) => ATTACKS.find((a) => a.id === id)?.target ?? '—';

const liveRuns: AttackRun[] = (attacksLive?.attacks ?? []).map((a) => ({ ...a, target: a.target ?? attackTarget(a.id), defended: a.defended ?? expected(a.id, a.reason) }));
const liveDefended = liveRuns.filter((a) => a.defended);
const liveAttackTxs = liveRuns.filter((a) => a.tx);

const stepOf = (j: Job, name: string) => j.steps.find((s) => s.name === name);
const transfersFrom = (c: Chain) => jobs.filter((j) => j.type === 'transfer' && j.from === c);
const finalizedFrom = (c: Chain) => transfersFrom(c).filter((j) => j.state === 'finalized' || stepOf(j, 'finalized'));
const ordersFrom = (c: Chain) => jobs.filter((j) => j.type === 'order' && j.from === c);
const filledFrom = (c: Chain) => ordersFrom(c).filter((j) => stepOf(j, 'filled'));
const settledFrom = (c: Chain) => ordersFrom(c).filter((j) => stepOf(j, 'settled'));
const hero = (c: Chain) => {
  const done = finalizedFrom(c);
  return done.find((j) => j.hero) ?? done[0];
};
const heroOrder = (c: Chain) => {
  const done = filledFrom(c);
  return done.find((j) => j.hero) ?? done[0];
};
/** Seconds from the source step to the step that paid the recipient. */
const canonicalSecs = (j?: Job) => (j ? secs(stepOf(j, 'locked')?.at, stepOf(j, 'finalized')?.at) : undefined);
const fastSecs = (j?: Job) => (j ? secs(stepOf(j, 'opened')?.at, stepOf(j, 'filled')?.at) : undefined);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);
const canonicalMedian = (c: Chain) => median(finalizedFrom(c).map(canonicalSecs).filter((x): x is number => x !== undefined));
const fastMedian = (c: Chain) => median(filledFrom(c).map(fastSecs).filter((x): x is number => x !== undefined));

/** What has actually happened on the testnets, edge by edge. */
const isLive = {
  // the deploy's bindTrieId step needs a BEEFY commitment and a header import on BSC testnet
  beefy: !!dep.bsc?.steps?.['PortaldotVerifier.bindTrieId']?.tx || finalizedFrom('portaldot').length > 0,
  parlia: finalizedFrom('bsc').length > 0 || transfersFrom('bsc').some((j) => stepOf(j, 'parlia')?.tx),
  lockPortaldot: transfersFrom('portaldot').length > 0,
  lockBsc: transfersFrom('bsc').length > 0,
  mintBsc: finalizedFrom('portaldot').length > 0,
  releasePortaldot: finalizedFrom('bsc').length > 0,
  ordersToBsc: filledFrom('portaldot').length > 0,
  ordersToPortaldot: filledFrom('bsc').length > 0,
  // an order opened on Portaldot is settled there against BscVerifier, and the other way round
  settleOnPortaldot: settledFrom('portaldot').length > 0,
  settleOnBsc: settledFrom('bsc').length > 0,
  feed: has('portaldot', 'BscFeed') && !!live?.feed?.tx,
  ink: !!dep.portaldot?.meta?.parliaClientInk && !!bench?.chain?.window,
};
const anyDeployed = deployed.portaldot || deployed.bsc;
const bothWays = isLive.mintBsc && isLive.releasePortaldot;

const testLine = () => {
  if (!tests || tests.passed === null) return NOT_MEASURED;
  const s = tests.suites;
  const part = (k: string, label: string) =>
    s[k] ? `${label} ${s[k].passed}${s[k].skipped ? ` (+${s[k].skipped} live-only, skipped offline)` : ''}` : `${label} ${NOT_MEASURED}`;
  return `${tests.passed} passing, ${tests.failed} failing: ${part('forge', 'Foundry')} · ${part('sdk', 'SDK')} · ${part('relayer', 'relayer')} · ${part('ink', 'ink!')}`;
};

const rehWindowHeaders = (rehP?.windows ?? []).map((w: any) => Number(w.headers));
const deployTotal = (c: any) => (c ? `${units(sumWei(c.portaldot.fee, c.portaldot.value), 0)} tPOT + ${units(sumWei(c.bsc.fee, c.bsc.value), 4)} tBNB` : NOT_MEASURED);
const seeds = (c: any) => (c ? `, of which ${units(c.portaldot.value, 0)} tPOT and ${units(c.bsc.value, 2)} tBNB seed the gas pool and vaults` : '');
const userOp = (step: string) => cost?.running?.userOps?.find((o: any) => o.step === step);

// ------------------------------------------------------------------ regions

/** Timestamp of the newest measurement in results/. */
function newestResult(): string | undefined {
  const ts = [tests?.at, cost?.at, bench?.generatedAt, rehB?.at, rehP?.at, findings?.at].filter(Boolean) as string[];
  return ts.sort().at(-1);
}

const regions: Record<string, () => string> = {};

regions.status = () => {
  if (!anyDeployed) {
    return [
      `**Status, ${day(newestResult())}:** built, tested and rehearsed against live data from both chains; **${NOT_DEPLOYED}** on the testnets (the deployer wallets are waiting for testnet funds).`,
      'Every on-chain link in these docs comes from `deployments/*.json` and reads "not deployed yet" until those files exist.',
    ].join(' ');
  }
  const n = (c: Chain) => contractsOf(c).length;
  const nT = finalizedFrom('portaldot').length + finalizedFrom('bsc').length;
  const nF = filledFrom('portaldot').length + filledFrom('bsc').length;
  const t = jobs.length ? `${plural(nT, 'proven transfer')} and ${plural(nF, 'fast fill')} recorded` : 'no transfers recorded yet';
  return `**Status, ${day(live?.at ?? dep.bsc?.updatedAt ?? dep.portaldot?.updatedAt)}:** deployed, ${n('portaldot')} contracts on ${CHAIN_NAME.portaldot} and ${n('bsc')} on ${CHAIN_NAME.bsc}; ${t}. Every address and transaction: [docs/PROOF.md](docs/PROOF.md).`;
};

regions['live-links'] = () => {
  const relayerState = anyDeployed ? 'live' : 'starts with the deploy';
  return table(
    ['What', 'Link', 'State'],
    [
      ['Landing', `[backhaul-bridge.vercel.app](${SITE})`, 'live; reads both chains directly'],
      ['Demo video (2:43)', '[youtu.be/4hP-T-AT-XU](https://youtu.be/4hP-T-AT-XU)', 'a live transfer, the status page and the attack lab'],
      ['Pitch deck', `[backhaul-deck.pdf](${SITE}/backhaul-deck.pdf)`, '11 slides, numbers from results/'],
      ['App: bridge', `[/app](${SITE}/app)`, anyDeployed ? (dep.portaldot?.contracts?.ParliaClient ? 'live, both ways' : 'live for Portaldot → BNB Chain; BNB Chain → Portaldot not deployed yet') : `page is up; contracts ${NOT_DEPLOYED}`],
      ['Attack lab', `[/attacks](${SITE}/attacks)`, anyDeployed ? 'live; Fire all runs every forged proof' : `page is up; contracts ${NOT_DEPLOYED}`],
      ['Light-client status', `[/status](${SITE}/status)`, anyDeployed ? 'live' : `page is up; contracts ${NOT_DEPLOYED}`],
      ['Relayer API', `[${RELAYER.replace('https://', '')}](${RELAYER}/status) ([API.md](services/relayer/API.md))`, relayerState],
    ],
  );
};

regions.architecture = () => {
  const L = (on: boolean, label: string) => (on ? `-->|"${label}"|` : `-.->|"${label}"|`);
  const node = (id: string, label: string, c: Chain, name: string | string[]) => {
    const names = Array.isArray(name) ? name : [name];
    const up = names.every((n) => (n === 'ink' ? !!dep.portaldot?.meta?.parliaClientInk : has(c, n)));
    return `    ${id}["${label}"]${up ? ':::live' : ':::pending'}`;
  };
  const lines = [
    '```mermaid',
    'flowchart LR',
    '  subgraph PD["Portaldot V3 testnet"]',
    '    direction TB',
    '    PVAL(["Portaldot validators<br/>BEEFY · MMR"])',
    node('PGW', 'PortaldotGateway<br/>locks tPOT · holds BNB.b', 'portaldot', 'PortaldotGateway'),
    node('POB', 'Outbox', 'portaldot', 'Outbox'),
    node('PLC', 'ParliaClient · EVM', 'portaldot', 'ParliaClient'),
    node('PINK', 'parlia_client · ink! WASM', 'portaldot', 'ink'),
    node('PVF', 'BscVerifier<br/>receipt + storage MPT', 'portaldot', 'BscVerifier'),
    node('PFD', 'BscFeed<br/>BNB/USD', 'portaldot', 'BscFeed'),
    node('PSET', 'ERC-7683 settlers<br/>+ LP vaults', 'portaldot', ['OriginSettler', 'DestinationSettler', 'PotVault']),
    '  end',
    '  subgraph BN["BNB Chain testnet"]',
    '    direction TB',
    '    BVAL(["BNB Chain validators<br/>Parlia seals"])',
    node('BGW', 'BscGateway · pPOT<br/>locks tBNB', 'bsc', ['BscGateway', 'PPOT']),
    node('BOB', 'Outbox', 'bsc', 'Outbox'),
    node('BLC', 'PortaldotLightClient<br/>BEEFY + MMR', 'bsc', 'PortaldotLightClient'),
    node('BVF', 'PortaldotVerifier<br/>Substrate child trie', 'bsc', 'PortaldotVerifier'),
    node('BSET', 'ERC-7683 settlers<br/>+ LP vaults', 'bsc', ['OriginSettler', 'DestinationSettler', 'PpotVault']),
    '  end',
    '  RL{{"Relayer · solver<br/>anyone can run one"}}',
    // reads from live chains: exercised by both rehearsals against live testnet data
    `  PVAL ${L(!!rehB, 'signed commitments,<br/>block hashes')} RL`,
    `  BVAL ${L(!!rehP, 'sealed headers')} RL`,
    `  POB ${L(isLive.mintBsc, 'child-trie proof')} RL`,
    `  BOB ${L(isLive.releasePortaldot, 'receipt / storage proof')} RL`,
    `  RL ${L(isLive.beefy, 'commitments · headers · rotations')} BLC`,
    `  RL ${L(isLive.parlia, 'finality windows')} PLC`,
    `  RL ${L(isLive.ink, 'same windows')} PINK`,
    `  PGW ${L(isLive.lockPortaldot, 'lock → commit')} POB`,
    `  BGW ${L(isLive.lockBsc, 'lock / burn → commit')} BOB`,
    `  BLC ${L(isLive.mintBsc, 'state root')} BVF`,
    `  BVF ${L(isLive.mintBsc, 'mint pPOT · release tBNB')} BGW`,
    `  PLC ${L(isLive.releasePortaldot, 'receipts root')} PVF`,
    `  PVF ${L(isLive.releasePortaldot, 'release tPOT · BNB.b')} PGW`,
    `  PVF ${L(isLive.feed, 'Chainlink storage')} PFD`,
    `  PVF ${L(isLive.settleOnPortaldot, 'repay / refund')} PSET`,
    `  BVF ${L(isLive.settleOnBsc, 'repay / refund')} BSET`,
    '  classDef live stroke-width:2px',
    '  classDef pending stroke-dasharray: 5 4',
    '```',
    '',
    `Solid: built and executed against the live testnets. Dotted: built and tested, not yet executed on a testnet. Dashed boxes: ${NOT_DEPLOYED}.` +
      (anyDeployed ? '' : ' Before the deploy only the reads from the two live chains are solid: both rehearsals pulled real BEEFY commitments, block hashes for the MMR, Substrate storage proofs, sealed BSC headers and receipts from them.'),
  ];
  return lines.join('\n');
};

regions.numbers = () => {
  const bg = beefyGas;
  const w = rehP?.window;
  const local48 = bench?.local?.window48;
  const ct = (c: Chain) => canonicalMedian(c);
  const ft = (c: Chain) => fastMedian(c);
  const rows: unknown[][] = [
    ['Keys that can release bridged funds', '0 on either chain', 'No owner, admin, pause or upgrade path in any contract: [TRUST.md](docs/TRUST.md)'],
    ['Tests', testLine(), `\`npm run test:counts\` → [results/test-counts.json](results/test-counts.json)${tests?.commit ? ` at \`${tests.commit}\`` : ''}`],
    [
      'Forged proofs rejected, local rehearsals',
      rehAttacks.length ? `${rehDefended.length} of ${rehFired.length} fired` + (rehSkipped.length ? `; ${rehSkipped.map((a) => `\`${a.id}\``).join(', ')} needs a live transfer (forge: \`test_finalizeTwiceReverts\`)` : '') : NOT_MEASURED,
      '[rehearsal-beefy.json](results/rehearsal-beefy.json) · [rehearsal-parlia.json](results/rehearsal-parlia.json)',
    ],
    [
      'Forged proofs rejected, testnet',
      liveRuns.length ? `${liveDefended.length} of ${liveRuns.length} (eth_call)${liveAttackTxs.length ? `, ${liveAttackTxs.length} as reverted transactions` : ''}` : NOT_DEPLOYED,
      '[results/attacks.json](results/attacks.json)',
    ],
    [
      'BEEFY on BNB Chain: commitment · header import · set rotation',
      bg ? `${int(bg.submitCommitment.transaction)} · ${int(bg.importHeader.transaction)} · ${int(bg.rotate.transaction)} gas` : NOT_MEASURED,
      `Foundry on recorded Portaldot data ([beefy-gas-local.json](results/beefy-gas-local.json))${rehB?.rotation ? `; the BSC-fork rehearsal rotated set ${rehB.checkpoint.setId} → ${rehB.rotation.setId} on live Portaldot data` : ''}`,
    ],
    [
      'Portaldot contract storage proven on BNB Chain',
      bg ? `${int(bg.verifyCommitment.transaction)} gas (main trie + child trie, ${int(bg.verifyCommitment.calldataBytes)} B calldata)` : NOT_MEASURED,
      '[beefy-gas-local.json](results/beefy-gas-local.json)',
    ],
    [
      'BNB Chain finality on Portaldot (EVM)',
      w ? `${w.headers} real headers, ${kb(w.bytes)}, ${w.distinctSealers} distinct sealers → final for ${int(w.gasUsed)} gas` : NOT_MEASURED,
      '[rehearsal-parlia.json](results/rehearsal-parlia.json)',
    ],
    [
      'EVM vs WASM, 48 real headers, same input',
      local48 ? `${int(local48.evm.executionGas)} execution gas vs ${ms(local48.wasm.refTime)} refTime, ${kb(local48.wasm.proofSize)} proofSize` : NOT_MEASURED,
      '[BENCHMARK.md](docs/BENCHMARK.md)',
    ],
    [
      'Wait for BNB Chain finality',
      rehWindowHeaders.length
        ? `${Math.min(...rehWindowHeaders)}–${Math.max(...rehWindowHeaders)} headers ≈ ${(Math.min(...rehWindowHeaders) * BSC_BLOCK_SEC).toFixed(0)}–${(Math.max(...rehWindowHeaders) * BSC_BLOCK_SEC).toFixed(0)} s`
        : NOT_MEASURED,
      `MODELED: header counts from the rehearsal windows × ${BSC_BLOCK_SEC} s blocks`,
    ],
    ['Time to funds, canonical (median)', jobs.length ? `Portaldot → BNB Chain ${dur(ct('portaldot'))} · BNB Chain → Portaldot ${dur(ct('bsc'))}` : NOT_DEPLOYED, '[live-transfers.json](results/live-transfers.json)'],
    ['Time to funds, fast fill (median)', jobs.length ? `Portaldot → BNB Chain ${dur(ft('portaldot'))} · BNB Chain → Portaldot ${dur(ft('bsc'))}` : NOT_DEPLOYED, '[live-transfers.json](results/live-transfers.json)'],
    [
      'Deploy cost, full',
      deployTotal(cost) + seeds(cost),
      'Dry-run: live `eth_estimateGas` on Portaldot, fork gas on BSC ([deploy-cost-estimate.json](results/deploy-cost-estimate.json))',
    ],
    [
      'User cost on Portaldot',
      userOp('lockPOT')
        ? `bridge tPOT ${units(userOp('lockPOT').fee)} tPOT · open an order ${units(userOp('OriginSettler.open (tPOT in)')?.fee)} tPOT`
        : NOT_MEASURED,
      'Fees plus storage deposit, same dry-run',
    ],
  ];
  return table(['', 'Number', 'Source'], rows);
};

regions['judges-path'] = () => {
  const h = (c: Chain) => hero(c);
  const heroLine = (c: Chain) => {
    const j = h(c);
    if (!j) return `${CHAIN_NAME[c]} → ${CHAIN_NAME[other(c)]}: ${NOT_DEPLOYED}.`;
    const src = stepOf(j, 'locked');
    const fin = stepOf(j, 'finalized');
    return `${CHAIN_NAME[c]} → ${CHAIN_NAME[other(c)]} (\`${j.id}\`, ${j.asset}): source ${txLink(c, src?.tx, src?.block)} → paid out ${txLink(other(c), fin?.tx, fin?.block)}, ${dur(canonicalSecs(j))}.`;
  };
  const attackLine = liveAttackTxs.length
    ? liveAttackTxs.map((a) => `${a.title ?? attackTitle(a.id)}: ${txLink(a.chain, a.tx, a.block)} (\`${a.reason}\`)`).join('; ')
    : `${NOT_DEPLOYED}. Until then the rehearsal records name each revert: ${rehDefended.length} of ${rehFired.length} fired attacks rejected, listed in [PROOF.md](PROOF.md#forged-proofs-in-the-rehearsals).`;
  const src = h('portaldot') ?? h('bsc');
  const verifyTx = src ? stepOf(src, 'locked')?.tx : undefined;
  return [
    `1. **Landing, 30 s.** Open [${SITE.replace('https://', '')}](${SITE}). The live strip at the top reads both chains directly.`,
    `2. **Bridge, 2 min.** Open [/app](${SITE}/app), pick a direction and send with the demo wallet (no wallet or funds needed). The transfer page shows every proof step with its transaction.${anyDeployed ? '' : ` _Contracts ${NOT_DEPLOYED}; until then the page is a placeholder._`}`,
    `3. **Attack lab, 1 min.** Open [/attacks](${SITE}/attacks) and press **Fire all**. Each attack takes real proof material, changes one thing and sends it to the deployed contract as an \`eth_call\`; the scoreboard counts the reverts.${anyDeployed ? '' : ` _Contracts ${NOT_DEPLOYED}; the rehearsal results are in step 6._`}`,
    `4. **Status, 30 s.** [/status](${SITE}/status) shows both light clients facing each other: the BEEFY set on BNB Chain, the BSC epoch and trusting period left on Portaldot.${anyDeployed ? '' : ` _Contracts ${NOT_DEPLOYED}._`}`,
    `5. **The hero transfers on the explorers.**`,
    `   - ${heroLine('portaldot')}`,
    `   - ${heroLine('bsc')}`,
    `   - Reverted attack transactions: ${attackLine}`,
    `6. **The two rehearsals, 1 min.** ${rehB ? `[rehearsal-beefy.json](../results/rehearsal-beefy.json): BEEFY client on a BSC-testnet fork fed live Portaldot data, a live set rotation ${rehB.checkpoint.setId} → ${rehB.rotation?.setId}, ${rehB.storage?.verifyCommitment && !rehB.storage?.verifyCommitmentOtherValue ? 'a child-trie storage proof of a live contract accepted, and the same proof with another value rejected' : 'storage proof check NOT as expected'}.` : NOT_MEASURED} ${rehP ? `[rehearsal-parlia.json](../results/rehearsal-parlia.json): a real ${rehP.window.headers}-header BSC window finalized by ${rehP.window.distinctSealers} distinct sealers with ${rehP.window.headersSealedByUntrusted} headers from a validator outside the trusted set, then a receipt proof and an absence proof.` : NOT_MEASURED} Re-run them with \`npm run rehearse\`.`,
    `7. **Re-verify a transfer yourself, 1 min.** \`npx tsx packages/sdk/scripts/verify-onchain.ts ${verifyTx ?? '<tx>'}\` rebuilds the proof from the source chain and checks it against the deployed light client with \`eth_call\`, plus a tampered copy that must fail.${anyDeployed ? '' : ` _Before the deploy it says there is nothing to check against yet._`}`,
    `8. **Tests, 3 min.** \`npm ci && npm run test:counts\`: ${testLine()}.`,
  ].join('\n');
};

regions['proof-contracts'] = () => {
  const out: string[] = [];
  for (const c of CHAINS) {
    out.push(`### ${CHAIN_NAME[c]} (chain id ${c === 'bsc' ? 97 : 420420777})`, '');
    const list = contractsOf(c);
    if (!list.length) {
      out.push(`${NOT_DEPLOYED}: \`deployments/${c}.json\` does not exist yet.`, '');
      continue;
    }
    out.push(
      table(
        c === 'bsc' ? ['Contract', 'Address', 'Deploy transaction', 'Code', 'Source'] : ['Contract', 'Address', 'Deploy transaction', 'Code'],
        list.map(([name, k]) => {
          const row = [name, addrLink(c, k.address), txLink(c, k.tx, k.block), k.codeBytes ? `${int(k.codeBytes)} B` : '—'];
          // BNB Chain sources are verified on Sourcify (exact match); Portaldot's explorer has no verification yet.
          if (c === 'bsc') row.push(`[verified](https://repo.sourcify.dev/97/${k.address})`);
          return row;
        }),
      ),
      '',
    );
    const m = dep[c]!.meta;
    if (c === 'portaldot' && m.bnbb) out.push(`BNB.b: pallet-assets asset ${m.bnbb.assetId}, ERC-20 precompile ${addrLink('portaldot', m.bnbb.precompile)}.`, '');
    if (c === 'portaldot' && m.parliaClientInk)
      out.push(`ink! ParliaClient: \`${m.parliaClientInk.address}\`, code hash \`${m.parliaClientInk.codeHash}\` (${int(m.parliaClientInk.wasmBytes)} B), ${txLink('portaldot', m.parliaClientInk.tx, m.parliaClientInk.block)}.`, '');
    const steps = Object.entries(dep[c]!.steps).filter(([, s]) => s.tx);
    if (steps.length) out.push('Wiring and seeding:', '', table(['Step', 'Transaction'], steps.map(([k, s]) => [k, txLink(c, s.tx, s.block)])), '');
  }
  return out.join('\n').trimEnd();
};

regions['proof-transfers'] = () => {
  if (!jobs.length) return `${NOT_DEPLOYED}: no transfers recorded (\`results/live-transfers.json\` is written by \`packages/sdk/scripts/record-live.ts\` after the deploy).`;
  const out: string[] = [];
  for (const c of CHAINS) {
    const j = hero(c);
    out.push(`### ${CHAIN_NAME[c]} → ${CHAIN_NAME[other(c)]}`, '');
    if (!j) {
      out.push(`${NOT_MEASURED}: no finalized transfer in this direction yet.`, '');
      continue;
    }
    out.push(
      `\`${j.id}\`: ${units(j.amount, 4)} ${j.asset}, ${dur(canonicalSecs(j))} from lock to payout.`,
      '',
      table(['Step', 'Chain', 'Transaction', 'At', 'Detail'], j.steps.map((s) => [s.name, s.chain ? CHAIN_NAME[s.chain] : '—', txLink(s.chain ?? c, s.tx, s.block, true), day(s.at), s.detail ?? ''])),
      '',
    );
  }
  for (const c of CHAINS) {
    const o = heroOrder(c);
    if (!o) continue;
    out.push(
      `### Fast fill, ${CHAIN_NAME[c]} → ${CHAIN_NAME[o.to]}`,
      '',
      `Order \`${short(o.id)}\`: ${dur(fastSecs(o))} from open to the recipient being paid; the solver is repaid after the proof.`,
      '',
      table(['Step', 'Chain', 'Transaction', 'At', 'Detail'], o.steps.map((s) => [s.name, s.chain ? CHAIN_NAME[s.chain] : '—', txLink(s.chain ?? c, s.tx, s.block, true), day(s.at), s.detail ?? ''])),
      '',
    );
  }
  const others = jobs.length - CHAINS.filter((c) => hero(c)).length - CHAINS.filter((c) => heroOrder(c)).length;
  if (others > 0) out.push(`${others} more jobs in [results/live-transfers.json](../results/live-transfers.json), recorded ${day(live?.at)}.`);
  return out.join('\n').trimEnd();
};

regions['proof-attacks'] = () => {
  if (!liveRuns.length) return `${NOT_DEPLOYED}: the attack lab runs against the deployed contracts.`;
  return [
    `Recorded ${day(attacksLive?.at)}${attacksLive?.relayer ? ` from ${attacksLive.relayer}` : ''}: ${liveDefended.length} of ${liveRuns.length} rejected.`,
    '',
    table(
      ['Attack', 'Target', 'Rejected with', 'Reverted transaction'],
      liveRuns.map((a) => [a.title ?? attackTitle(a.id), `\`${a.target}\``, `\`${a.reason}\`${a.defended ? '' : ' (NOT the expected reason)'}`, a.tx ? txLink(a.chain, a.tx, a.block, true) : 'eth_call only']),
    ),
  ].join('\n');
};

/** Forge tests that cover what a rehearsal could not fire. */
const COVERED_BY: Record<string, string> = { 'replayed-nonce': '`contracts/test/core/Gateways.t.sol::test_finalizeTwiceReverts`' };
function rehResult(a: any): string {
  if (a.skipped) return `not fired: needs a finalized transfer on deployed gateways${COVERED_BY[a.id] ? `; covered by ${COVERED_BY[a.id]}` : ''}`;
  if (!a.defended) return `**accepted** (\`${a.reason}\`)`;
  return a.reason === 'false' ? 'rejected: the verifier returned false' : `rejected: \`${a.reason}\``;
}

regions['proof-rehearsals'] = () => {
  if (!rehAttacks.length) return NOT_MEASURED;
  return [
    `Local rehearsals on ${day(rehB?.at)} (BEEFY: ${rehB?.network}) and ${day(rehP?.at)} (Parlia: ${rehP?.network}). These are local, not testnet transactions.`,
    '',
    table(
      ['Attack', 'Target', 'Result'],
      rehAttacks.map((a) => [attackTitle(a.id), `\`${attackTarget(a.id)}\``, rehResult(a)]),
    ),
  ].join('\n');
};

/** One claim and its evidence tier, which follows the data that backs it. */
interface Claim {
  claim: string;
  tier: 'REPRODUCIBLE' | 'VERIFIED-LIVE' | 'MODELED' | 'NOT-CLAIMED';
  how: string;
}

regions.claims = () => {
  const liveOr = (on: boolean, claim: string, liveHow: string, before: Omit<Claim, 'claim'>): Claim =>
    on ? { claim, tier: 'VERIFIED-LIVE', how: liveHow } : { claim, ...before };
  const claims: Claim[] = [
    {
      claim: 'No contract has an owner, admin, pause or upgrade path; the only privileged call is a one-time `setRemote` wiring by the deployer',
      tier: 'REPRODUCIBLE',
      how: '`grep -rnE "onlyOwner|Ownable|whenNotPaused|upgradeTo|delegatecall|selfdestruct" contracts/src` matches nothing; a second `setRemote` reverts (`Gateways.t.sol::test_setRemoteOnce`)',
    },
    { claim: `The test suites pass: ${testLine()}`, tier: tests ? 'REPRODUCIBLE' : 'NOT-CLAIMED', how: '`npm run test:counts` → `results/test-counts.json`' },
    {
      claim: 'The BEEFY client accepts real Portaldot commitments, headers and a real validator-set rotation, and rejects forged ones',
      tier: rehB ? 'REPRODUCIBLE' : 'NOT-CLAIMED',
      how: '`npm run rehearse:beefy` (BSC-testnet fork + live Portaldot) → `results/rehearsal-beefy.json`; fixtures in `contracts/test/bsc/`',
    },
    {
      claim: 'The Parlia client finalizes real BSC windows from ⌈2N/3⌉ distinct trusted sealers, tolerating seals from validators outside the trusted set without counting them',
      tier: rehP ? 'REPRODUCIBLE' : 'NOT-CLAIMED',
      how: '`npm run rehearse:parlia` → `results/rehearsal-parlia.json`; `contracts/test/portaldot/ParliaClient.t.sol` on real rotations',
    },
    {
      claim: `Forged proofs are rejected: ${rehDefended.length} of ${rehFired.length} attacks fired in the rehearsals, each with a named reason`,
      tier: rehFired.length ? 'REPRODUCIBLE' : 'NOT-CLAIMED',
      how: 'both rehearsal files, `attacks` arrays; `packages/sdk/src/attacks.ts`',
    },
    liveOr(
      liveRuns.length > 0,
      `The attack lab rejects every forged proof against the deployed contracts${liveRuns.length ? ` (${liveDefended.length} of ${liveRuns.length})` : ''}`,
      '`results/attacks.json`; /attacks on the site',
      { tier: 'NOT-CLAIMED', how: `${NOT_DEPLOYED}` },
    ),
    liveOr(
      isLive.mintBsc,
      'tPOT locked on Portaldot is minted as pPOT on BNB Chain only against a BEEFY + MMR + child-trie proof',
      '`docs/PROOF.md` (hero transfer) and `verify-onchain.ts <lock tx>`',
      { tier: 'REPRODUCIBLE', how: 'locally: `contracts/test/core/Gateways.t.sol`, `PortaldotVerifier.t.sol` on recorded Portaldot proofs; testnet: not deployed yet' },
    ),
    liveOr(
      isLive.releasePortaldot,
      'tBNB locked on BNB Chain is released as BNB.b on Portaldot only against a Parlia window + a receipt proof, or a storage proof of the same Outbox slot at a later block',
      '`docs/PROOF.md` (hero transfer) and `verify-onchain.ts <lock tx>`',
      { tier: 'REPRODUCIBLE', how: 'locally: `Gateways.t.sol::test_bnbRoundTrip`, `BscVerifier.t.sol` on recorded BSC receipts and synthetic Outbox storage, `ParliaStranding.t.sol`; testnet: not deployed yet' },
    ),
    {
      claim: 'Supply invariants hold: pPOT supply equals locked tPOT, circulating BNB.b equals locked tBNB, no transfer finalizes twice',
      tier: 'REPRODUCIBLE',
      how: '`contracts/test/core/GatewaysInvariant.t.sol` (Foundry invariant runs)',
    },
    liveOr(
      isLive.ordersToBsc || isLive.ordersToPortaldot,
      'Solvers fill ERC-7683 orders on the destination at once and are repaid only after a light-client proof of the fill',
      '`docs/PROOF.md` (fast fill)',
      { tier: 'REPRODUCIBLE', how: 'locally: `contracts/test/intents/Settlers.t.sol`, `Routes.t.sol`, `LPVault.t.sol`; testnet: not deployed yet' },
    ),
    liveOr(
      isLive.feed,
      'The Chainlink BNB/USD feed of BNB Chain testnet is readable on Portaldot from storage proofs',
      '`docs/PROOF.md`',
      { tier: 'REPRODUCIBLE', how: 'locally: `contracts/test/portaldot/BscFeed.t.sol` on recorded BSC storage proofs; testnet: not deployed yet' },
    ),
    {
      claim: `The same Parlia client runs as an ink! contract; 48 headers cost ${local48Text()} in the pallet-contracts sandbox`,
      tier: bench?.local ? 'REPRODUCIBLE' : 'NOT-CLAIMED',
      how: '`npm run test:ink`, `npm run benchmark` → `docs/BENCHMARK.md`',
    },
    liveOr(
      !!bench?.chain?.window,
      'EVM vs WASM weight and fee for the same window, on Portaldot itself',
      '`docs/BENCHMARK.md`, live dry-run section',
      { tier: 'NOT-CLAIMED', how: `${NOT_DEPLOYED}: needs both clients on chain` },
    ),
    {
      claim: `Portaldot accepts the ink! code: upload and instantiate dry-runs succeed${bench?.chain?.inkInstantiate?.ok ? ` (deposit ${Number(bench.chain.inkInstantiate.deposit).toLocaleString('en-US', { maximumFractionDigits: 2 })} tPOT)` : ''}`,
      tier: bench?.chain?.inkUpload?.ok ? 'VERIFIED-LIVE' : 'NOT-CLAIMED',
      how: '`ContractsApi_upload_code` / `ContractsApi_instantiate` dry-runs in `npm run benchmark`',
    },
    {
      claim: `Full deployment costs ${deployTotal(cost)}`,
      tier: cost ? 'MODELED' : 'NOT-CLAIMED',
      how: '`npm run deploy:dry` → `results/deploy-cost-estimate.json`: live `eth_estimateGas` where the node can dry-run, a calibrated model for calls into contracts that do not exist yet',
    },
    {
      claim: `BNB Chain finality takes ${rehWindowHeaders.length ? `${Math.min(...rehWindowHeaders)}–${Math.max(...rehWindowHeaders)} headers` : NOT_MEASURED}, about ${rehWindowHeaders.length ? `${(Math.min(...rehWindowHeaders) * BSC_BLOCK_SEC).toFixed(0)}–${(Math.max(...rehWindowHeaders) * BSC_BLOCK_SEC).toFixed(0)} s` : NOT_MEASURED}`,
      tier: 'MODELED',
      how: `header counts from \`results/rehearsal-parlia.json\` × ${BSC_BLOCK_SEC} s block time`,
    },
    liveOr(
      jobs.length > 0,
      `Time to funds both ways, canonical and fast`,
      '`results/live-transfers.json`, rendered in the README numbers',
      { tier: 'NOT-CLAIMED', how: `${NOT_DEPLOYED}` },
    ),
    {
      claim: 'Bridges held by a handful of keys lost about $806M in three incidents: Ronin, Harmony Horizon, Orbit Chain',
      tier: 'VERIFIED-LIVE',
      how: 'public post-mortems and analyses, linked in the README',
    },
  ];
  return table(
    ['Claim', 'Tier', 'Reproduce / evidence'],
    claims.map((c) => [c.claim, `**${c.tier}**`, c.how]),
  );
};

function local48Text(): string {
  const l = bench?.local?.window48;
  return l ? `${ms(l.wasm.refTime)} refTime (${int(l.evm.executionGas)} gas on the EVM build)` : NOT_MEASURED;
}

regions.activity = () => {
  let lines: string[];
  try {
    lines = execFileSync('git', ['log', '--format=%aI', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return NOT_MEASURED;
  }
  const dates = lines.map((d) => new Date(d));
  const days = new Set(dates.map((d) => d.toISOString().slice(0, 10)));
  const first = new Date(Math.min(...dates.map(Number))).toISOString();
  const last = new Date(Math.max(...dates.map(Number))).toISOString();
  const inWindow = dates.filter((d) => d >= new Date('2026-10-14T00:00:00Z') && d < new Date('2026-11-06T04:00:00Z')).length;
  return `At the last render: ${lines.length} commits from ${day(first)} to ${day(last)}, on ${days.size} distinct days (UTC); ${inWindow} of them inside the event window (Oct 14 – Nov 6, 2026). History: [${REPO.replace('https://', '')}/commits](${REPO}/commits/main).`;
};

const CORE_MODULES: [string, string][] = [
  ['BEEFY light client of Portaldot (BNB Chain side)', 'contracts/src/bsc/PortaldotLightClient.sol'],
  ['Parlia light client of BNB Chain (Portaldot side)', 'contracts/src/portaldot/ParliaClient.sol'],
  ['Canonical bridge gateways', 'contracts/src/core/GatewayBase.sol'],
  ['ERC-7683 settlers', 'contracts/src/intents/OriginSettler.sol'],
  ['LP vaults', 'contracts/src/intents/LPVault.sol'],
  ['Relayer and solver', 'services/relayer/src/index.ts'],
  ['ink! twin', 'ink/parlia_client/src/lib.rs'],
  ['Data bridge (BscFeed)', 'contracts/src/portaldot/BscFeed.sol'],
];
/** Rule: core modules committed before this, and not all in the last 24 hours. */
const CORE_DEADLINE = '2026-11-05T04:00:00Z';

function firstCommit(file: string): string | undefined {
  try {
    const out = execFileSync('git', ['log', '--diff-filter=A', '--format=%aI', '--', file], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
    return out.length ? new Date(out[out.length - 1]).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

regions['core-modules'] = () => {
  const rows = CORE_MODULES.map(([label, file]) => {
    const at = firstCommit(file);
    return [label, `\`${file}\``, at ? day(at) : 'not committed', at ? (at < CORE_DEADLINE ? 'yes' : 'no') : '—'];
  });
  return [
    `From \`git log --diff-filter=A\` on each module's main file. Deadline for core modules: ${day(CORE_DEADLINE)}.`,
    '',
    table(['Module', 'File', 'First committed', 'Before the deadline'], rows),
  ].join('\n');
};

regions.rubric = () => {
  const deployCell = anyDeployed
    ? `[PROOF.md](PROOF.md): ${contractsOf('portaldot').length} contracts on Portaldot, ${contractsOf('bsc').length} on BNB Chain${jobs.length ? `, ${jobs.length} recorded transfers and orders` : ''}`
    : `**${NOT_DEPLOYED}** (testnet funds pending). Ready: \`npm run deploy:dry\` prices every step against the live chains (${deployTotal(cost)}); [PROOF.md](PROOF.md) fills itself from \`deployments/*.json\``;
  const rows: unknown[][] = [
    ['Technical Feasibility 30%', 'Architecture', '[README → How it works](../README.md#how-it-works), [TRUST.md](TRUST.md)'],
    ['', 'Code completeness', `Both light clients, both gateways, ERC-7683 settlers, LP vaults, data feed, ink! twin, relayer, SDK, app. Tests: ${testLine()}`],
    ['', 'Genuine, sustained development activity', `${regions.activity()} When each core module first landed: [below](#core-modules).`],
    ['', 'Testnet deployment with verifiable on-chain interactions', deployCell],
    ['', 'Proof the mechanisms work', `${rehDefended.length} of ${rehFired.length} forged proofs rejected in the rehearsals; [JUDGES.md](JUDGES.md) step 6; \`verify-onchain.ts\` re-checks any transfer`],
    ['Innovation 30%', 'V3: WASM', '`ink/parlia_client`, the ink! twin of the Parlia client, and [BENCHMARK.md](BENCHMARK.md) (EVM vs WASM on identical inputs)'],
    ['', 'V3: EVM compatibility', 'Every Portaldot contract runs on pallet-revive; `PortaldotVerifier` reads revive contract storage from its child trie'],
    ['', 'V3: modular architecture', 'BEEFY + MMR pallets (consumed by the light client), pallet-assets + its ERC-20 precompile (BNB.b), Timestamp storage (refund proofs)'],
    ['', 'V3: multi-chain', 'The bridge itself, both directions, plus a data bridge (`BscFeed`)'],
    ['', 'Value beyond existing solutions', 'Custodial and committee bridges can release funds with keys; Backhaul has none and proves both directions: [TRUST.md → Compared with the alternatives](TRUST.md#compared-with-the-alternatives)'],
    ['Ecosystem Contribution 20%', 'Infrastructure', 'A light client of BNB Chain on Portaldot and a BEEFY light client of Portaldot on BNB Chain; any Portaldot contract can read proven BNB Chain state through `BscVerifier`'],
    ['', 'Developer tools', '`@backhaul/sdk`: BEEFY, MMR, Substrate trie, Parlia and MPT proof builders; `verify-onchain.ts`; relayer HTTP API ([API.md](../services/relayer/API.md))'],
    ['', 'Node ecosystem', '[FINDINGS.md](FINDINGS.md): what we hit on the public nodes, re-checked by `npm run findings`, and measured deploy costs for builders'],
    ['', 'Open-source value', 'MIT, public from the first commit; third-party code disclosed in the README'],
    ['', 'Sustained building', 'The relayer is permissionless: anyone can run it (`npm run relayer`); light clients stay current only while someone relays'],
    ['Business Potential 20%', 'Real need', 'Bridges secured by a few keys lost about $806M in three incidents ([README → Sources](../README.md#sources)); Portaldot V3 holders need a route to BNB Chain liquidity that adds no such keys'],
    ['', 'Clear users', 'tPOT holders moving to BNB Chain liquidity; BNB Chain users entering Portaldot; Portaldot dApps that need a BNB/USD price without an oracle committee'],
    ['', 'Business model', 'Fees go to whoever provides the service: a 0.1% fee on tPOT locks funds the gas pool for BNB.b gas drops; solvers and LP vaults earn the fee on fast fills. No token'],
    ['', 'Growth path', 'Testnet → mainnet with the same contracts and a fresh checkpoint; more EVM chains reuse the Parlia/MPT code; BLS vote checking once a precompile exists'],
  ];
  return table(['Criterion', 'Line', 'Evidence'], rows);
};

regions['deploy-costs'] = () => {
  if (!cost) return NOT_MEASURED;
  const r = cost.rates;
  const per = (v: string) => units(v, 4);
  const c = bench?.chain;
  const planck = (v: string) => (Number(v) / 1e14).toFixed(2);
  return [
    `Measured ${day(cost.at)} on the Portaldot V3 testnet (gas price ${int(r.gasPrice)}), by \`calibratePortaldot\` in \`packages/sdk/src/deploy/cost.ts\`: live \`eth_estimateGas\` of tiny probe deployments that differ in one thing (1 vs 1,001 bytes of code, 0 vs 1 storage slot, 0 vs 10,000 bytes of calldata). pallet-revive's estimate includes the storage deposit, so each difference is that item's full price.`,
    '',
    table(
      ['Item', 'Cost', 'Note'],
      [
        ['Code, fresh code hash', `${per(r.codeRate)} tPOT per byte (${units(BigInt(r.codeRate) * 1000n, 1)} tPOT per KB)`, `A deposit, returned when the code is removed. With the deploy base, a 515-byte contract costs ${units(BigInt(r.deployBase) + 515n * BigInt(r.codeRate))} tPOT, about 0.1 tPOT per byte`],
        ['Code already stored under the same hash', `${per(r.reuseCodeRate)} tPOT per byte`, 'revive keeps code once per hash; immutables change the hash'],
        ['Deploy base', `${units(r.deployBase)} tPOT`, 'Any deployment'],
        ['One new storage slot', `${units(r.slotRate)} tPOT`, 'Each Outbox commitment, order status or ring slot pays this once'],
        ['Transaction length', `${per(r.byteRate)} tPOT per byte (${units(BigInt(r.byteRate) * 1000n, 2)} tPOT per KB)`, `A ${kb(46_000)} Parlia window pays about ${units(BigInt(r.byteRate) * 46_000n)} tPOT in length fees alone`],
        ['Plain call', `${units(r.callBase, 4)} tPOT`, 'Execution weight is small next to the deposits'],
      ],
    ),
    '',
    c?.contracts
      ? `Chain constants read the same day: pallet-revive and pallet-contracts both charge DepositPerByte ${planck(c.contracts.depositPerByte)} tPOT and DepositPerItem ${planck(c.contracts.depositPerItem)} tPOT; pallet-contracts adds a code-hash lockup of ${c.contracts.codeHashLockupDepositPercent}. The probe prices above are what transactions actually pay on top of those constants.`
      : '',
    '',
    `What that means for a full Backhaul deployment: ${deployTotal(cost)} (${deployTotal(costMin)} without the BNB LP vaults, ${deployTotal(costAll)} with the data feed and the ink! twin). Parlia windows cost ${units(cost.running?.parliaWindowFresh)} tPOT while they fill a fresh ring slot and ${units(cost.running?.parliaWindowWarm)} tPOT once the 256-slot ring is warm. That is why the Parlia client verifies windows on demand with a trusting period instead of following every BSC epoch.`,
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
};

regions.findings = () => {
  if (!findings) return `${NOT_MEASURED}: run \`npm run findings\`.`;
  const f = findings;
  const out: string[] = [`Last checked ${day(f.at)} with \`npm run findings\` → [results/findings.json](../results/findings.json):`, ''];
  if (f.mmr) {
    for (const n of f.mmr.nodes)
      out.push(`- \`mmr_generateProof\` on \`${n.url}\` for block ${int(n.block)}: ${n.ok ? 'returned a proof' : `\`${n.error}\``}; \`mmr_root\` ${n.rootOk ? 'answers' : 'fails'}.`);
  }
  if (f.ethRoots) {
    const e = f.ethRoots;
    out.push(
      `- \`eth_getBlockByNumber\` on \`${e.url}\`: ${e.equal} of ${e.blocks.length} recent blocks with transactions report \`stateRoot == transactionsRoot\` (blocks ${e.blocks.map((b: any) => int(b.number)).join(', ')}).`,
    );
  }
  return out.join('\n');
};

// ------------------------------------------------------------------ apply

const FILES = ['README.md', 'docs/JUDGES.md', 'docs/PROOF.md', 'docs/CLAIMS.md', 'docs/CHALLENGE_CHECKLIST.md', 'docs/FINDINGS.md'];
const MARK = /<!-- render:([a-z0-9-]+) -->[\s\S]*?<!-- \/render:\1 -->/g;

let stale = 0;
const used = new Set<string>();
for (const rel of FILES) {
  const path = resolve(ROOT, rel);
  if (!existsSync(path)) {
    console.error(`missing ${rel}`);
    process.exitCode = 1;
    continue;
  }
  const before = readFileSync(path, 'utf8');
  const after = before.replace(MARK, (_m, name: string) => {
    const fn = regions[name];
    if (!fn) throw new Error(`${rel}: no renderer for region "${name}"`);
    used.add(name);
    let body = fn().trim();
    // Regions write repo-relative links (results/…, docs/…) or docs-relative ones (../results/…,
    // PROOF.md); each file gets them relative to where it sits.
    if (rel === 'README.md') body = body.replace(/\]\(\.\.\//g, '](');
    else body = body.replace(/\]\((results|services|packages|contracts|ink|app)\//g, '](../$1/').replace(/\]\(docs\//g, '](');
    return `<!-- render:${name} -->\n${body}\n<!-- /render:${name} -->`;
  });
  if (after !== before) {
    stale++;
    if (CHECK) console.log(`stale: ${rel}`);
    else {
      writeFileSync(path, after);
      console.log(`rendered ${rel}`);
    }
  } else console.log(`unchanged ${rel}`);
}
const unused = Object.keys(regions).filter((r) => !used.has(r));
if (unused.length) console.log(`regions with no marker: ${unused.join(', ')}`);
if (CHECK && stale) process.exitCode = 1;
