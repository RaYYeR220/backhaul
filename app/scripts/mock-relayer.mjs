#!/usr/bin/env node
// DEVELOPMENT ONLY. A stand-in for services/relayer that serves API.md-shaped answers, so the app
// views can be worked on without deployed contracts or a funded relayer. Nothing in the app
// imports it and production builds never talk to it: point NEXT_PUBLIC_RELAYER_URL at the real
// relayer for that.
//
//   node scripts/mock-relayer.mjs            (port 8787, or MOCK_PORT)
//
// Block heights and BNB Chain validators are read from the live testnets at start-up, so the
// timeline's sealer and BEEFY reads hit real blocks. Transaction hashes, addresses and job
// histories are made up. Knobs: MOCK_DEMO_OFF=1, MOCK_HALT=1, MOCK_NOT_READY=id,id,
// MOCK_UNDEFENDED=id (that attack "succeeds"), MOCK_PER_IP=3.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT ?? 8787);
const BSC_RPC = "https://bsc-testnet-rpc.publicnode.com";
const PD_NODE = "https://test-node-v3.portaldot.dev";
const PD_WS = "wss://test-node-v3.portaldot.dev";
const E18 = 10n ** 18n;

const hex = (n) => "0x" + randomBytes(n).toString("hex");
const addr = () => hex(20);
const txh = () => hex(32);
const iso = (ms) => new Date(ms).toISOString();
const wei = (x) => ((BigInt(Math.round(x * 1e6)) * E18) / 1_000_000n).toString();

/* ---------- anchors from the live chains ---------- */

async function rpc(url, method, params = []) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const anchor = {
  bscHead: 72_000_000,
  validators: Array.from({ length: 9 }, addr),
  pdFinal: 1_500_000,
  pdBeefy: 1_499_997,
  setId: 500,
  live: false,
};

async function loadAnchors() {
  try {
    const head = parseInt(await rpc(BSC_RPC, "eth_blockNumber"), 16);
    let epoch = Math.floor(head / 1000) * 1000;
    if (head < epoch + 39) epoch -= 1000;
    const b = await rpc(BSC_RPC, "eth_getBlockByNumber", ["0x" + epoch.toString(16), false]);
    const extra = b.extraData.slice(2);
    const count = parseInt(extra.slice(64, 66), 16);
    const validators = Array.from({ length: count }, (_, i) => "0x" + extra.slice(66 + i * 136, 106 + i * 136));
    const fin = await rpc(PD_NODE, "chain_getFinalizedHead");
    const h = await rpc(PD_NODE, "chain_getHeader", [fin]);
    const bf = await rpc(PD_NODE, "beefy_getFinalizedHead");
    const bh = await rpc(PD_NODE, "chain_getHeader", [bf]);
    const vs = await rpc(PD_NODE, "state_call", ["BeefyApi_validator_set", "0x"]);
    const setHex = vs.slice(-16);
    const setId = Number(BigInt("0x" + setHex.match(/../g).reverse().join("")));
    Object.assign(anchor, {
      bscHead: head,
      epoch,
      validators,
      pdFinal: parseInt(h.number, 16),
      pdBeefy: parseInt(bh.number, 16),
      setId,
      live: true,
    });
    console.log(`anchored to BSC #${head} (epoch ${epoch}, ${count} validators), Portaldot #${anchor.pdFinal}, BEEFY set ${setId}`);
  } catch (e) {
    console.log(`could not read the live chains (${e.message}); using made-up heights`);
  }
  anchor.epoch ??= Math.floor(anchor.bscHead / 1000) * 1000;
}

const START = Date.now();
/** BNB Chain and Portaldot heights at wall time `ms`. */
const bscAt = (ms) => anchor.bscHead + Math.floor((ms - START) / 450);
const pdAt = (ms) => anchor.pdFinal + Math.floor((ms - START) / 6000);

const txLink = (chain, tx, block) =>
  chain === "bsc"
    ? `https://testnet.bscscan.com/tx/${tx}`
    : `https://polkadot.js.org/apps/?rpc=${encodeURIComponent(PD_WS)}#/explorer/query/${block ?? ""}`;

/* ---------- jobs ---------- */

const SOLVER = addr();
const RELAYER = addr();
const DEMO = addr();
const ADDR = {
  portaldot: Object.fromEntries(
    [
      "Outbox",
      "ParliaClient",
      "BscVerifier",
      "PortaldotGateway",
      "OriginSettler",
      "DestinationSettler",
      "PotVault",
      "BnbbVault",
      "PotForwarder",
      "BnbbForwarder",
    ].map((k) => [k, addr()]),
  ),
  bsc: Object.fromEntries(
    [
      "Outbox",
      "PortaldotLightClient",
      "PortaldotVerifier",
      "PPOT",
      "BscGateway",
      "OriginSettler",
      "DestinationSettler",
      "PpotVault",
      "BnbVault",
      "PpotForwarder",
      "BnbForwarder",
    ].map((k) => [k, addr()]),
  ),
};
ADDR.portaldot.bnbb = "0x0000264500000000000000000000000000010000";
ADDR.portaldot.bnbbAssetId = 9797;

const KIND = { POT_TO_BSC: 1, PPOT_TO_PORTALDOT: 2, BNB_TO_PORTALDOT: 3, BNBB_TO_BSC: 4 };
const jobs = new Map();
const nonces = { portaldot: 7, bsc: 12 };

/** A step `ms` after the job's start; heights follow the chain it lands on. */
const at = (ms, name, chain, extra = {}) => ({ ms, name, chain, ...extra });

function transfer({ kindName, amount, recipient, t0, plan, tx }) {
  const from = kindName === "POT_TO_BSC" || kindName === "BNBB_TO_BSC" ? "portaldot" : "bsc";
  const to = from === "bsc" ? "portaldot" : "bsc";
  const nonce = String(++nonces[from]);
  const id = `${from}:${nonce}`;
  const sourceTx = tx ?? txh();
  const j = {
    t0,
    plan: [at(0, "locked", from, { tx: sourceTx, state: "locked" }), ...plan],
    base: {
      id,
      type: "transfer",
      state: "locked",
      from,
      to,
      nonce,
      kind: KIND[kindName],
      kindName,
      recipient,
      amount,
      sourceTx,
      error: null,
    },
  };
  jobs.set(id, j);
  return j;
}

function order({ from, inputToken, inputAmount, outputToken, outputAmount, t0, plan, deadlineSec }) {
  const to = from === "bsc" ? "portaldot" : "bsc";
  const orderId = txh();
  const openTx = txh();
  const j = {
    t0,
    plan: [at(0, "opened", from, { tx: openTx, state: "open" }), ...plan],
    base: {
      id: orderId,
      type: "order",
      state: "open",
      from,
      to,
      orderId,
      user: addr(),
      inputToken,
      inputAmount,
      outputToken,
      outputAmount,
      recipient: addr(),
      fillDeadline: Math.floor((t0 + deadlineSec * 1000) / 1000),
      fill: null,
      sourceTx: openTx,
      error: null,
    },
  };
  jobs.set(orderId, j);
  return j;
}

function view(j, now = Date.now()) {
  const done = j.plan.filter((p) => j.t0 + p.ms <= now);
  const steps = done.map((p) => {
    const t = j.t0 + p.ms;
    const block = p.tx ? String(p.block ?? (p.chain === "bsc" ? bscAt(t) : pdAt(t))) : null;
    const detail = typeof p.detail === "function" ? p.detail(j, t) : (p.detail ?? null);
    return {
      name: p.name,
      at: iso(t),
      chain: p.chain ?? null,
      tx: p.tx ?? null,
      block,
      link: p.tx && p.chain ? txLink(p.chain, p.tx, block) : null,
      detail,
    };
  });
  const out = { ...j.base };
  for (const p of done) {
    if (p.state) out.state = p.state;
    if (p.fill) out.fill = p.fill;
    if (p.error) out.error = p.error;
  }
  out.createdAt = iso(j.t0);
  out.updatedAt = steps.length ? steps[steps.length - 1].at : iso(j.t0);
  out.steps = steps;
  return out;
}

const lockBlock = (j) => {
  const p = j.plan[0];
  return p.chain === "bsc" ? bscAt(j.t0) : pdAt(j.t0);
};

/** The proof and release plan of a canonical transfer, as the relayer would record it. */
function canonicalPlan(from, { proofMs, releaseMs, fail }) {
  if (from === "bsc") {
    const plan = [
      at(proofMs, "parlia", "portaldot", { tx: txh(), state: "proven", detail: (j) => `BSC block ${lockBlock(j)} finalized on Portaldot` }),
    ];
    if (fail) plan.push(at(releaseMs, "failed", null, { state: "failed", error: fail, detail: fail }));
    else plan.push(at(releaseMs, "finalized", "portaldot", { tx: txh(), state: "finalized" }));
    return plan;
  }
  const header = (j) => `Portaldot header ${lockBlock(j) + 1} proven on BSC`;
  const plan = [
    at(proofMs, "beefy", "bsc", { tx: txh(), state: "proven", detail: header }),
    at(proofMs + 4000, "beefy", "bsc", { tx: txh(), detail: header }),
  ];
  if (fail) plan.push(at(releaseMs, "failed", null, { state: "failed", error: fail, detail: fail }));
  else plan.push(at(releaseMs, "finalized", "bsc", { tx: txh(), state: "finalized" }));
  return plan;
}

function seed() {
  const now = Date.now();
  const H = 3_600_000;
  transfer({
    kindName: "BNB_TO_PORTALDOT",
    amount: wei(0.002),
    recipient: addr(),
    t0: now - 5.2 * H,
    plan: canonicalPlan("bsc", { proofMs: 31_000, releaseMs: 38_000 }),
  });
  transfer({
    kindName: "POT_TO_BSC",
    amount: wei(0.999),
    recipient: addr(),
    t0: now - 4.1 * H,
    plan: canonicalPlan("portaldot", { proofMs: 52_000, releaseMs: 61_000 }),
  });
  order({
    from: "portaldot",
    inputToken: "0x0000000000000000000000000000000000000000",
    inputAmount: wei(10),
    outputToken: ADDR.bsc.PPOT,
    outputAmount: wei(9.96),
    t0: now - 2.6 * H,
    deadlineSec: 1800,
    plan: [
      at(3_000, "solver fill sent", "bsc", { tx: txh(), detail: "spread 40 bps, within limits" }),
      at(5_000, "filled", "bsc", {
        tx: txh(),
        state: "filled",
        detail: `by ${SOLVER}, repay to ${SOLVER}`,
        fill: { tx: txh(), block: String(bscAt(now - 2.6 * H + 5000)), filler: SOLVER, repayTo: SOLVER },
      }),
      at(44_000, "parlia", "portaldot", { tx: txh(), detail: (j, t) => `BSC block ${bscAt(j.t0 + 5000)} finalized on Portaldot` }),
      at(51_000, "settled", "portaldot", { tx: txh(), state: "settled", detail: `escrow to ${SOLVER}` }),
    ],
  });
  transfer({
    kindName: "PPOT_TO_PORTALDOT",
    amount: wei(1.25),
    recipient: addr(),
    t0: now - 1.4 * H,
    plan: canonicalPlan("bsc", { proofMs: 33_000, releaseMs: 9 * 60_000, fail: "Portaldot eth-rpc did not answer after 8 attempts" }),
  });
  order({
    from: "bsc",
    inputToken: "0x0000000000000000000000000000000000000000",
    inputAmount: wei(0.004),
    outputToken: ADDR.portaldot.bnbb,
    outputAmount: wei(0.00398),
    t0: now - 0.9 * H,
    deadlineSec: 300,
    plan: [
      at(4_000, "solver passed", "portaldot", { detail: "less than 120 s of deadline left" }),
      at(6_000, "vault passed", "portaldot", { detail: "not enough idle liquidity" }),
      at(340_000, "beefy", "bsc", { tx: txh(), detail: (j) => `Portaldot header ${pdAt(j.t0 + 330_000)} proven on BSC` }),
      at(352_000, "refunded", "bsc", { tx: txh(), state: "refunded", detail: (j) => `escrow back to ${j.base.user}` }),
    ],
  });
  // two still crossing when the mock starts
  transfer({
    kindName: "POT_TO_BSC",
    amount: wei(0.4995),
    recipient: addr(),
    t0: now - 8_000,
    plan: canonicalPlan("portaldot", { proofMs: 46_000, releaseMs: 58_000 }),
  });
  transfer({
    kindName: "BNB_TO_PORTALDOT",
    amount: wei(0.0015),
    recipient: addr(),
    t0: now - 5_000,
    plan: canonicalPlan("bsc", { proofMs: 30_000, releaseMs: 37_000 }),
  });
}

/* ---------- attack lab ---------- */

const ATTACKS = [
  [
    "beefy-forged-signature",
    "Forged BEEFY signature",
    "bsc",
    "PortaldotLightClient.submitCommitment",
    ["InvalidSignature"],
    "A real commitment of the current validator set, moved to the next block number so it is new, with one byte of the first signature changed.",
    "InvalidSignature(0)",
  ],
  [
    "beefy-stale-set",
    "Commitment signed by a stale validator set",
    "bsc",
    "PortaldotLightClient.submitCommitment",
    ["UnknownValidatorSet"],
    "A real, correctly signed commitment from a validator set the light client has already rotated away from.",
    () => `UnknownValidatorSet(${anchor.setId - 1})`,
  ],
  [
    "mmr-wrong-leaf",
    "MMR proof for the wrong leaf",
    "bsc",
    "PortaldotLightClient.importHeader",
    ["HeaderNotInMmr"],
    "A real header with a real MMR proof whose first sibling hash is changed, so the path no longer leads to the committed root.",
    "HeaderNotInMmr()",
  ],
  [
    "header-not-in-mmr",
    "Header that does not hash to its leaf",
    "bsc",
    "PortaldotLightClient.importHeader",
    ["HeaderNotInMmr"],
    "A real header and its real MMR proof, but the header claims a different state root.",
    "HeaderNotInMmr()",
  ],
  [
    "tampered-storage-proof",
    "Tampered storage value",
    "bsc",
    "PortaldotVerifier.verifyCommitment",
    ["false"],
    "A real storage proof of a Portaldot Outbox slot, presented as proving a different value.",
    "false",
  ],
  [
    "replayed-nonce",
    "Replayed transfer",
    "bsc",
    "BscGateway.finalize",
    ["AlreadyFinalized"],
    "A transfer the gateway already delivered, submitted again with its genuine proof.",
    "AlreadyFinalized(7)",
  ],
  [
    "parlia-forged-header",
    "BSC header sealed by a non-validator",
    "portaldot",
    "ParliaClient.submitWindow",
    ["BrokenLink"],
    "A real finality window whose first header is replaced by a forgery sealed with an attacker key. The real validators sealed the real chain, whose headers do not link to it.",
    () => `BrokenLink(${bscAt(Date.now()) - 79})`,
  ],
  [
    "parlia-too-few-sealers",
    "Window with fewer than 2/3 distinct sealers",
    "portaldot",
    "ParliaClient.submitWindow",
    ["TooFewSigners"],
    "The shortest real window that finalizes a BSC block, minus its last header: one trusted validator short of ⌈2N/3⌉.",
    "TooFewSigners(5, 6)",
  ],
  [
    "receipt-not-included",
    "Receipt proof for a log that is not there",
    "portaldot",
    "BscVerifier.verifyCommitment",
    ["LogIndexOutOfRange", "false"],
    "A real receipt proof from a finalized BSC block, pointing at a log index the receipt does not have.",
    "LogIndexOutOfRange(64, 1)",
  ],
  [
    "settle-unfilled-order",
    "Solver claim for an unfilled order",
    "portaldot",
    "OriginSettler.settle",
    ["InvalidProof", "IncompleteProof"],
    "An open order nobody filled, settled to the attacker with a genuine proof of some other commitment.",
    "InvalidProof()",
  ],
  [
    "refund-filled-order",
    "Refund for a filled order",
    "bsc",
    "PortaldotVerifier.verifyAbsence",
    ["false"],
    "An absence proof for an Outbox slot that holds a commitment: proof that the order was filled, presented as proof that it was not.",
    "false",
  ],
  [
    "bnbb-beyond-locked",
    "BNB.b release beyond what was locked",
    "portaldot",
    "PortaldotGateway.finalize",
    ["InvalidProof"],
    "A release of the gateway's whole BNB.b supply to the attacker, backed by a genuine receipt proof of a real BSC block that locked nothing of the kind.",
    "InvalidProof()",
  ],
];
const MISSING = {
  "replayed-nonce": ["transferToBsc"],
  "refund-filled-order": ["presentAbsence"],
  "settle-unfilled-order": ["openOrder"],
  "tampered-storage-proof": ["portaldotCommitment"],
};
const notReady = new Set((process.env.MOCK_NOT_READY ?? "").split(",").filter(Boolean));
const undefended = new Set((process.env.MOCK_UNDEFENDED ?? "").split(",").filter(Boolean));

const targetAddress = (chain, target) => {
  const c = target.split(".")[0];
  return chain === "bsc" ? ADDR.bsc[c] : ADDR.portaldot[c];
};

const attackList = () =>
  ATTACKS.map(([id, title, chain, target, expects, description]) => ({
    id,
    title,
    description,
    chain,
    target,
    address: targetAddress(chain, target),
    expects,
    ready: !notReady.has(id),
    ...(notReady.has(id) ? { missing: MISSING[id] ?? ["bscReceipt"] } : {}),
  }));

/* ---------- status ---------- */

const demoLimits = {
  perRequest: { tPOT: wei(2), tBNB: wei(0.002), pPOT: wei(2), "BNB.b": wei(0.002) },
  perDay: { tPOT: wei(40), tBNB: wei(0.04), pPOT: wei(40), "BNB.b": wei(0.04) },
  perIpPerHour: Number(process.env.MOCK_PER_IP ?? 3),
};
const usedToday = { tPOT: wei(3), tBNB: wei(0.0035) };
const hits = new Map();
const lastBeefyTx = txh();
const lastWindowTx = txh();

function status() {
  const now = Date.now();
  const finalized = pdAt(now);
  const latestBlock = finalized - 14;
  const bscHead = bscAt(now);
  const window = bscHead - 121;
  const epochTs = Math.floor(START / 1000) - 2 * 86_400 - 3_600;
  const count = (type) => {
    const out = {};
    for (const j of jobs.values())
      if (j.base.type === type) {
        const s = view(j, now).state;
        out[s] = (out[s] ?? 0) + 1;
      }
    return out;
  };
  return {
    at: iso(now),
    portaldotToBsc: {
      client: ADDR.bsc.PortaldotLightClient,
      lastTx: { kind: "header", tx: lastBeefyTx, block: latestBlock, setId: String(anchor.setId), link: txLink("bsc", lastBeefyTx) },
      setId: String(anchor.setId),
      latestBlock,
      beefyHead: finalized - 3,
      finalized,
      lagBlocks: finalized - latestBlock,
      archived: 1312,
      halted: process.env.MOCK_HALT
        ? `missed the handoff from set ${anchor.setId} to ${anchor.setId + 1}: no archived commitment of set ${anchor.setId}`
        : null,
      lastError: null,
    },
    bscToPortaldot: {
      client: ADDR.portaldot.ParliaClient,
      trustedEpoch: String(anchor.epoch),
      activeFrom: String(anchor.epoch + 40),
      validators: anchor.validators,
      epochTimestamp: String(epochTs),
      trustRemainingSec: String(epochTs + 7 * 86_400 - Math.floor(now / 1000)),
      bscHead: String(bscHead),
      liveOverlap: 8,
      lastWindow: { block: String(window), tx: lastWindowTx, headers: 47 },
      lagBlocks: String(bscHead - window),
      lastError: null,
    },
    jobs: { transfers: count("transfer"), orders: count("order") },
    relayer: { address: RELAYER, balances: { portaldot: "812.5", bsc: "0.091" } },
    solver: {
      address: SOLVER,
      limits: {
        maxOutput: { tPOT: wei(20), tBNB: wei(0.02), pPOT: wei(20), "BNB.b": wei(0.02) },
        minFeeBps: 20,
        minDeadlineLeft: 120,
        prefund: wei(0.5),
      },
    },
    demo: process.env.MOCK_DEMO_OFF ? null : { address: DEMO, limits: demoLimits, usedToday },
    addresses: ADDR,
  };
}

/* ---------- http ---------- */

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const ROUTES = {
  "pot-to-bsc": { kindName: "POT_TO_BSC", asset: "tPOT" },
  "bnb-to-portaldot": { kindName: "BNB_TO_PORTALDOT", asset: "tBNB" },
  "ppot-to-portaldot": { kindName: "PPOT_TO_PORTALDOT", asset: "pPOT" },
  "bnbb-to-bsc": { kindName: "BNBB_TO_BSC", asset: "BNB.b" },
};

function parseAmount(s) {
  const [i, f = ""] = s.split(".");
  return BigInt(i) * E18 + BigInt((f + "0".repeat(18)).slice(0, 18));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;
  if (m === "GET" && path === "/status") return status();
  if (m === "GET" && path === "/transfers") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100);
    const type = url.searchParams.get("type");
    const items = [...jobs.values()]
      .filter((j) => !type || j.base.type === type)
      .sort((a, b) => b.t0 - a.t0)
      .slice(0, limit)
      .map((j) => view(j));
    return { items };
  }
  const t = /^\/transfers\/([^/]+)$/.exec(path);
  if (m === "GET" && t) {
    const id = decodeURIComponent(t[1]).toLowerCase();
    const j = jobs.get(id) ?? [...jobs.values()].find((x) => x.base.sourceTx.toLowerCase() === id || x.base.orderId?.toLowerCase() === id);
    if (!j || j.t0 > Date.now()) throw new HttpError(404, "no such transfer or order (it may not be indexed yet)");
    return view(j);
  }
  if (m === "GET" && path === "/attacks") {
    await sleep(300);
    const items = attackList();
    return { items, total: items.length, ready: items.filter((a) => a.ready).length };
  }
  const a = /^\/attacks\/([a-z0-9-]+)$/.exec(path);
  if (m === "POST" && a) {
    const row = ATTACKS.find((x) => x[0] === a[1]);
    if (!row) throw new HttpError(404, "no such attack");
    if (notReady.has(row[0]))
      throw new HttpError(409, "this attack needs real proof material that does not exist yet", {
        missing: MISSING[row[0]] ?? ["bscReceipt"],
      });
    const started = Date.now();
    await sleep(220 + Math.floor(Math.random() * 480));
    const [id, title, chain, target, expects, , reasonOf] = row;
    const ok = !undefended.has(id);
    const reason = ok ? (typeof reasonOf === "function" ? reasonOf() : reasonOf) : expects.includes("false") ? "true" : "succeeded";
    const reverted = ok && reason !== "false";
    return {
      id,
      title,
      chain,
      target,
      call: { to: targetAddress(chain, target), data: hex(196) },
      reverted,
      reason,
      defended: ok && expects.includes(reason.split("(")[0]),
      ms: Date.now() - started,
    };
  }
  if (m === "POST" && path === "/demo/transfer") {
    if (process.env.MOCK_DEMO_OFF) throw new HttpError(503, "the demo signer is not configured");
    const b = await readBody(req);
    const r = ROUTES[b.route];
    if (!r) throw new HttpError(400, `route must be one of ${Object.keys(ROUTES).join(", ")}`);
    if (typeof b.recipient !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(b.recipient))
      throw new HttpError(400, "recipient must be a 0x address");
    if (typeof b.amount !== "string" || !/^\d+(\.\d{1,18})?$/.test(b.amount))
      throw new HttpError(400, 'amount must be a decimal string, e.g. "0.5"');
    const amount = parseAmount(b.amount);
    if ((r.asset === "tPOT" || r.asset === "pPOT") && amount % 10_000n !== 0n) throw new HttpError(400, "tPOT has 14 decimals");
    if (amount <= 0n) throw new HttpError(400, "amount must be positive");
    const cap = BigInt(demoLimits.perRequest[r.asset]);
    if (amount > cap) throw new HttpError(400, `at most ${cap} wei of ${r.asset} per request`, { cap: cap.toString() });
    const used = BigInt(usedToday[r.asset] ?? "0");
    if (used + amount > BigInt(demoLimits.perDay[r.asset]))
      throw new HttpError(429, `daily ${r.asset} budget of the demo signer is used up`, { retryAfterSec: 3600 });
    const ip = req.socket.remoteAddress ?? "local";
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((x) => now - x < 3_600_000);
    if (recent.length >= demoLimits.perIpPerHour) {
      throw new HttpError(429, "too many demo transfers from this address, try again later", {
        retryAfterSec: Math.ceil((recent[0] + 3_600_000 - now) / 1000),
      });
    }
    hits.set(ip, [...recent, now]);
    usedToday[r.asset] = (used + amount).toString();
    await sleep(1200);
    const from = r.kindName === "POT_TO_BSC" || r.kindName === "BNBB_TO_BSC" ? "portaldot" : "bsc";
    const net = r.kindName === "POT_TO_BSC" ? amount - amount / 1000n : amount;
    const j = transfer({
      kindName: r.kindName,
      amount: net.toString(),
      recipient: b.recipient,
      t0: Date.now(),
      plan: canonicalPlan(from, from === "bsc" ? { proofMs: 28_000, releaseMs: 35_000 } : { proofMs: 44_000, releaseMs: 54_000 }),
    });
    res.statusCode = 202;
    const block = lockBlock(j);
    return {
      id: j.base.id,
      route: b.route,
      amount: amount.toString(),
      recipient: b.recipient,
      tx: j.base.sourceTx,
      link: txLink(from, j.base.sourceTx, block),
      statusUrl: `/transfers/${encodeURIComponent(j.base.id)}`,
    };
  }
  throw new HttpError(404, "not found");
}

await loadAnchors();
seed();

createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("content-type", "application/json");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  handle(req, res).then(
    (v) => {
      if (!res.statusCode) res.statusCode = 200;
      res.end(JSON.stringify(v));
    },
    (e) => {
      res.statusCode = e instanceof HttpError ? e.status : 500;
      res.end(JSON.stringify({ error: e.message, ...(e.extra ?? {}) }));
    },
  );
}).listen(PORT, () => console.log(`mock relayer (development only) on http://localhost:${PORT}`));
