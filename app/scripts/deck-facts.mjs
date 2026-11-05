#!/usr/bin/env node
// Collects the numbers the pitch deck (/deck) shows from the repo's results/*.json and
// deployments/*.json into src/lib/deck/facts.json. It runs before every build, so the deck always
// shows the latest rehearsals, gas runs and deployments:
//
//   npm run sync:deck
//
// When the app is built on its own (no ../results next to it, as on Vercel) it keeps the
// committed facts.json. Every field is optional: a missing file leaves its field null and the
// slide says so instead of making up a number.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const APP = resolve(here, "..");
export const REPO = resolve(APP, "..");
export const OUT = resolve(APP, "src/lib/deck/facts.json");

/** Test suites when results/test-counts.json is not there yet: the latest full run. */
const LAST_RUN = [
  { name: "forge", count: 249 },
  { name: "sdk", count: 86 },
  { name: "relayer", count: 34 },
  { name: "ink", count: 32 },
];
const SUITES = ["forge", "sdk", "relayer", "ink"];

/** Deployed contracts in the order the proof slide lists them. */
const ORDER = {
  portaldot: ["ParliaClient", "BscVerifier", "PortaldotGateway", "OriginSettler", "DestinationSettler", "PotVault", "BnbbVault", "BscFeed", "Outbox"],
  bsc: ["PortaldotLightClient", "PortaldotVerifier", "BscGateway", "PPOT", "OriginSettler", "DestinationSettler", "PpotVault", "BnbVault", "Outbox"],
};

const num = (v) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const wei = (v) => (v === undefined || v === null ? null : Number(BigInt(v) / 10n ** 12n) / 1e6);

function reader(repo, used) {
  return (rel) => {
    const p = resolve(repo, rel);
    if (!existsSync(p)) return null;
    used.push(rel);
    return JSON.parse(readFileSync(p, "utf8"));
  };
}

function canonSuite(name) {
  const n = String(name).toLowerCase();
  if (/forge|foundry|contract|solidity/.test(n)) return "forge";
  if (/ink|wasm/.test(n)) return "ink";
  if (/relayer/.test(n)) return "relayer";
  if (/sdk/.test(n)) return "sdk";
  return n;
}

/** Accepts {forge: 249}, {suites: {forge: {passed: 249}}} or {suites: [{name, passed}]}. */
function testCounts(raw) {
  if (!raw) return null;
  const src = raw.suites ?? raw.counts ?? raw;
  const entries = Array.isArray(src) ? src.map((s) => [s?.name ?? s?.suite ?? s?.id, s]) : Object.entries(src);
  const found = new Map();
  for (const [name, v] of entries) {
    if (!name || /^(total|at|generatedAt|updatedAt|note|source|commit|ref)$/i.test(name)) continue;
    const n = typeof v === "number" ? v : num(v?.passed ?? v?.pass ?? v?.tests ?? v?.count ?? v?.total);
    if (n && n > 0) found.set(canonSuite(name), (found.get(canonSuite(name)) ?? 0) + n);
  }
  if (!found.size) return null;
  return [...found].map(([name, count]) => ({ name, count })).sort((a, b) => rank(a.name) - rank(b.name));
}
const rank = (n) => (SUITES.includes(n) ? SUITES.indexOf(n) : SUITES.length);

function beefy(r) {
  if (!r) return null;
  return {
    network: r.network ?? null,
    at: r.at ?? null,
    fromSet: num(r.checkpoint?.setId),
    toSet: num(r.rotation?.setId),
    rotations: num(r.rotation?.rotations),
    signers: r.checkpoint?.signers ?? [],
    commitmentBlock: num(r.commitment?.block),
    commitmentGas: num(r.commitment?.gasUsed),
    header: num(r.header?.number),
    headerGas: num(r.header?.gasUsed),
    mmrRoot: r.checkpoint?.checkpointMmrRoot ?? null,
    stateRoot: r.header?.stateRoot ?? null,
    trieId: r.bind?.trieId ?? null,
    storageProofBytes: num(r.storage?.proofBytes),
    storageProofGas: num(r.storage?.verifyCommitmentGas),
  };
}

function parlia(r) {
  if (!r) return null;
  const w = r.window ?? {};
  return {
    network: r.network ?? null,
    at: r.at ?? null,
    validators: r.checkpoint?.validators ?? [],
    turnLength: num(r.checkpoint?.turnLength),
    block: num(w.block),
    headers: num(w.headers),
    bytes: num(w.bytes),
    distinctSealers: num(w.distinctSealers),
    untrustedSealers: (w.untrustedSealers ?? []).length,
    untrustedSeals: num(w.headersSealedByUntrusted),
    gas: num(w.gasUsed),
    finalizedHashMatches: w.finalizedHashMatches ?? null,
    receiptProofNodes: num(r.receipt?.proofNodes),
    receiptProofBytes: num(r.receipt?.proofBytes),
  };
}

/** Every attack either rehearsal fired, in order, with the revert it got. */
function attacks(...rehearsals) {
  const items = [];
  for (const r of rehearsals) {
    for (const a of r?.attacks ?? []) {
      if (items.some((x) => x.id === a.id)) continue;
      items.push({ id: a.id, reason: a.reason ?? null, rejected: a.defended === true });
    }
  }
  return items.length ? { total: items.length, items } : null;
}

function gas(g) {
  if (!g) return null;
  return {
    network: g.network ?? null,
    beefyCommitment: num(g.submitCommitment?.execution),
    headerImport: num(g.importHeader?.execution),
    setHandoff: num(g.rotate?.execution),
    storageProof: num(g.verifyCommitment?.execution),
  };
}

function wasm(w, e) {
  if (!w && !e) return null;
  return {
    wasmBytes: num(w?.wasmBytes),
    window48Headers: num(w?.windows?.window48?.headers),
    window48RefTimeMs: w?.windows?.window48?.refTime ? Math.round(Number(w.windows.window48.refTime) / 1e7) / 100 : null,
    window48ProofSize: num(w?.windows?.window48?.proofSize),
    evmWindow48Gas: num(e?.windows?.window48?.executionGas),
  };
}

function deployCost(d) {
  if (!d?.portaldot) return null;
  return { portaldotTpot: wei(d.portaldot.fee), bscTbnb: wei(d.bsc?.fee) };
}

function deployment(read) {
  const side = (chain) => {
    const d = read(`deployments/${chain}.json`);
    if (!d?.contracts || !Object.keys(d.contracts).length) return null;
    const names = Object.keys(d.contracts);
    const order = [...ORDER[chain].filter((n) => names.includes(n)), ...names.filter((n) => !ORDER[chain].includes(n)).sort()];
    return {
      updatedAt: d.updatedAt ?? null,
      contracts: order.map((name) => ({
        name,
        address: d.contracts[name].address,
        tx: d.contracts[name].tx ?? null,
        block: num(d.contracts[name].block),
      })),
    };
  };
  const portaldot = side("portaldot");
  const bsc = side("bsc");
  return portaldot || bsc ? { portaldot, bsc } : null;
}

const TX = /^0x[0-9a-fA-F]{64}$/;

/** Pulls every {tx, chain} out of results/live-transfers.json, whatever its exact shape. */
function transfers(raw) {
  if (!raw) return [];
  const out = [];
  const walk = (v, ctx) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, ctx));
    if (!v || typeof v !== "object") return;
    const chain = /bsc|bnb/i.test(String(v.chain ?? "")) ? "bsc" : /portaldot|pdt/i.test(String(v.chain ?? "")) ? "portaldot" : ctx.chain;
    const own = v.label ?? v.title ?? v.step ?? v.kind ?? v.name;
    const label = own && ctx.label ? `${ctx.label} · ${own}` : (own ?? ctx.label);
    const tx = [v.tx, v.hash, v.txHash].find((x) => typeof x === "string" && TX.test(x));
    if (tx && chain) out.push({ label: label ? String(label) : "transaction", chain, tx, block: num(v.block ?? v.blockNumber) });
    for (const [k, x] of Object.entries(v)) {
      if (x && typeof x === "object") walk(x, { chain, label: /^(steps|txs|transactions|\d+)$/.test(k) ? label : label ? `${label} · ${k}` : k });
    }
  };
  walk(raw.transfers ?? raw, { chain: null, label: null });
  return out.filter((t, i) => out.findIndex((x) => x.tx === t.tx) === i).slice(0, 8);
}

export function collect(repo = REPO) {
  const used = [];
  const read = reader(repo, used);
  const rb = read("results/rehearsal-beefy.json");
  const rp = read("results/rehearsal-parlia.json");
  const counted = testCounts(read("results/test-counts.json"));
  const suites = counted ?? LAST_RUN;
  const facts = {
    tests: { suites, total: suites.reduce((a, s) => a + s.count, 0), source: counted ? "results/test-counts.json" : "last full suite run" },
    gas: gas(read("results/beefy-gas-local.json")),
    beefy: beefy(rb),
    parlia: parlia(rp),
    attacks: attacks(rb, rp),
    wasm: wasm(read("results/benchmark-wasm-local.json"), read("results/benchmark-evm-local.json")),
    deployCost: deployCost(read("results/deploy-cost-estimate.json")),
    deployment: deployment(read),
    transfers: transfers(read("results/live-transfers.json")),
    fork: forkReverse(read("results/fork-reverse.json")),
  };
  return { ...facts, sources: used };
}

/** The BNB Chain → Portaldot run on a fork of the V3 testnet: the real burn and the forked finalize. */
function forkReverse(r) {
  if (!r?.bscBurn?.tx) return null;
  return {
    burnTx: r.bscBurn.tx,
    burnBlock: Number(r.bscBurn.block),
    forkBlock: Number(r.forkBlock),
    finalizeTx: r.finalize?.forkTx ?? null,
    released: r.finalize?.released ?? null,
  };
}

/** Writes facts.json when the repo's results/ is reachable; otherwise keeps the committed one. */
export function writeFacts({ repo = REPO, out = OUT, log = console.log } = {}) {
  if (!existsSync(resolve(repo, "results"))) {
    log(`deck: no results/ at ${repo}, keeping ${out}`);
    return null;
  }
  const facts = collect(repo);
  const text = JSON.stringify(facts, null, 2) + "\n";
  // a Windows checkout may have CRLF; the content is what counts
  const old = existsSync(out) ? readFileSync(out, "utf8").replace(/\r\n/g, "\n") : "";
  if (old !== text) writeFileSync(out, text);
  log(`deck: ${old === text ? "facts unchanged" : "wrote"} ${out} from ${facts.sources.length} files`);
  return facts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeFacts();
