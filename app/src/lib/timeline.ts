/** Turns a job's recorded steps into the nodes of the transfer view's timeline. */

import { amount, chainLabel, jobAssets, routeOfKind } from "./assets";
import type { ChainName } from "./config";
import type { Rich } from "./rail/machine";
import type { Job, OrderJob, Step, TransferJob } from "./relayer";

/**
 * `done`: happened. `proven`: a light client accepted a proof, or value was released (the accent).
 * `active`: happening now. `pending`: not yet. `failed`: stopped here. `info`: a note on the way.
 */
export type Tone = "done" | "proven" | "active" | "pending" | "failed" | "info";

export interface Tx {
  chain: ChainName | null;
  tx: string | null;
  block: string | null;
}

export interface TNode {
  key: string;
  lane: "main" | "fast";
  title: Rich;
  body?: Rich;
  tone: Tone;
  at?: string;
  txs: Tx[];
  /** Draw the signer slots under this node. */
  signers?: boolean;
}

export interface SignerCount {
  have: number;
  need: number;
  of: number;
}

const m = (s: string | number) => ({ mono: String(s) });

/** "Portaldot header 299131 proven on BSC" → the numbers and addresses set in mono. */
export function richDetail(d: string): Rich {
  const out: (string | { mono: string })[] = [];
  const re = /(0x[0-9a-fA-F]{6,}|\b\d{4,}\b)/g;
  let last = 0;
  for (const hit of d.matchAll(re)) {
    if (hit.index! > last) out.push(d.slice(last, hit.index));
    const v = hit[0];
    out.push(m(v.startsWith("0x") ? `${v.slice(0, 6)}…${v.slice(-4)}` : "#" + Number(v).toLocaleString("en-US")));
    last = hit.index! + v.length;
  }
  if (last < d.length) out.push(d.slice(last));
  return out;
}

const tx = (s: Step | undefined): Tx[] =>
  s && s.tx ? [{ chain: s.chain, tx: s.tx, block: s.block }] : s && s.block ? [{ chain: s.chain, tx: null, block: s.block }] : [];

export function transferNodes(j: TransferJob, signers: SignerCount | null): TNode[] {
  const dirIn = j.from === "bsc";
  const route = routeOfKind(j.kindName);
  const find = (n: string) => j.steps.find((s) => s.name === n);
  const lock = find("locked");
  const lc = j.steps.filter((s) => s.name === (dirIn ? "parlia" : "beefy"));
  const fin = find("finalized");
  const vault = find("vault repaid");
  const failStep = find("failed");
  const proven = lc.length > 0 || !!fin;
  const amt = amount(j.amount);
  const send = route?.send ?? "";
  const receive = route?.receive ?? "";
  const verbed = route?.verb === "Burn" ? "burned" : route?.verb === "Return" ? "returned" : "locked";

  const nodes: TNode[] = [];
  nodes.push({
    key: "deposit",
    lane: "main",
    title: [`${send} ${verbed} on ${chainLabel(j.from)}`],
    body: dirIn
      ? ["The gateway logs the transfer. The receipt of that log is what Portaldot will check."]
      : ["The Outbox commits to the transfer in contract storage. That slot is what BNB Chain will check."],
    tone: lock ? "done" : "active",
    at: lock?.at,
    txs: tx(lock),
  });

  const have = signers?.have ?? 0;
  const need = signers?.need ?? (dirIn ? 6 : 2);
  const of = signers?.of ?? (dirIn ? 9 : 2);
  nodes.push({
    key: "signers",
    lane: "main",
    title: dirIn
      ? signers
        ? [`Sealed by ${Math.min(have, need)} of the ${need} distinct BNB Chain validators needed`]
        : [`Sealed by ${need} of ${of} BNB Chain validators`]
      : signers
        ? [`Signed by ${have} of ${of} BEEFY authorities`]
        : [`Signed by both BEEFY authorities`],
    body: dirIn
      ? [
          `Portaldot's Parlia light client finalizes a block once ${need} distinct validators of the set it trusts have sealed headers from it onward.`,
        ]
      : ["Both of Portaldot's BEEFY authorities have to sign a commitment that covers your block."],
    tone: proven ? "proven" : signers && have >= need ? "done" : "active",
    txs: [],
    signers: true,
  });

  const lcAt = lc[0]?.at;
  nodes.push(
    lc.length
      ? {
          key: "header",
          lane: "main",
          title: [dirIn ? "Header window accepted on Portaldot" : "Header imported on BNB Chain"],
          body: lc[0].detail ? richDetail(lc[0].detail) : undefined,
          tone: "proven",
          at: lcAt,
          txs: lc.flatMap((s) => tx(s)),
        }
      : fin
        ? {
            key: "header",
            lane: "main",
            title: ["Header already proven"],
            body: ["An earlier transfer had already made this block provable, so no new light-client transaction was needed."],
            tone: "proven",
            txs: [],
          }
        : {
            key: "header",
            lane: "main",
            title: [dirIn ? "Header window on Portaldot" : "Header import on BNB Chain"],
            body: [
              dirIn
                ? "The relayer submits the sealed headers to the Parlia light client, which checks every seal itself."
                : "The relayer submits the signed commitment and an MMR proof that ties your block to it.",
            ],
            tone: "pending",
            txs: [],
          },
  );

  nodes.push({
    key: "proof",
    lane: "main",
    title: [dirIn ? "Receipt proof verified" : "Storage proof verified"],
    body: dirIn
      ? ["BscVerifier checked the lock's receipt against the receipts root of the finalized block, in the release transaction."]
      : ["PortaldotVerifier checked the Outbox slot against the proven Portaldot state root, in the release transaction."],
    tone: fin ? "proven" : "pending",
    at: fin?.at,
    txs: [],
  });

  nodes.push({
    key: "release",
    lane: "main",
    title: fin ? [m(amt), ` ${receive} released on ${chainLabel(j.to)}`] : [`${receive} released on ${chainLabel(j.to)}`],
    body: fin?.detail ? richDetail(fin.detail) : route?.feeBps ? [`Net of the ${route.feeBps / 100} % bridge fee.`] : undefined,
    tone: fin ? "proven" : "pending",
    at: fin?.at,
    txs: tx(fin),
  });

  if (vault) nodes.push({ key: "vault", lane: "main", title: ["LP vault repaid"], tone: "info", at: vault.at, txs: tx(vault) });

  if (j.state === "failed" || failStep) {
    const reason = failStep?.detail ?? j.error ?? "The relayer stopped on this step.";
    const i = nodes.findIndex((n) => n.tone === "active" || n.tone === "pending");
    const at = i < 0 ? nodes.length - 1 : i;
    nodes[at] = { ...nodes[at], tone: "failed", body: richDetail(reason), at: failStep?.at ?? nodes[at].at };
    for (let k = at + 1; k < nodes.length; k++) if (nodes[k].tone === "active") nodes[k] = { ...nodes[k], tone: "pending" };
  }
  return nodes;
}

const FAST = new Set(["solver fill sent", "solver passed", "vault fill", "vault passed", "filled"]);

export function orderNodes(j: OrderJob, known: { ppot?: string; bnbb?: string }): TNode[] {
  const a = jobAssets(j, known);
  const t0 = Date.parse(j.steps[0]?.at ?? j.createdAt);
  const plus = (at: string) => `+${Math.max(0, Math.round((Date.parse(at) - t0) / 1000))} s`;
  const nodes: TNode[] = [];
  for (const [i, s] of j.steps.entries()) {
    const key = `${s.name}-${i}`;
    const base = { key, at: s.at, txs: tx(s), lane: FAST.has(s.name) ? ("fast" as const) : ("main" as const) };
    const body = s.detail ? richDetail(s.detail) : undefined;
    switch (s.name) {
      case "opened":
        nodes.push({
          ...base,
          title: [m(amount(a.amount)), ` ${a.sent} escrowed on ${chainLabel(j.from)}`],
          body: ["The order is open until its fill deadline."],
          tone: "done",
        });
        break;
      case "solver fill sent":
        nodes.push({ ...base, title: ["Solver sent a fill"], body, tone: "done" });
        break;
      case "solver passed":
        nodes.push({ ...base, title: ["Solver passed"], body, tone: "info" });
        break;
      case "vault fill":
        nodes.push({
          ...base,
          title: ["LP vault sent a fill"],
          body: ["The vault fills only against a proof that the order was opened."],
          tone: "done",
        });
        break;
      case "vault passed":
        nodes.push({ ...base, title: ["LP vault passed"], body, tone: "info" });
        break;
      case "filled":
        nodes.push({
          ...base,
          title: [`Filled at ${plus(s.at)}: `, m(amount(a.outAmount)), ` ${a.received} paid on ${chainLabel(j.to)}`],
          body,
          tone: "proven",
        });
        break;
      case "beefy":
      case "parlia":
        nodes.push({
          ...base,
          title: [`Proven on ${chainLabel(s.chain ?? (s.name === "beefy" ? "bsc" : "portaldot"))}`],
          body,
          tone: "proven",
        });
        break;
      case "settled":
        nodes.push({ ...base, title: ["Solver repaid after proof"], body, tone: "proven" });
        break;
      case "repayment bridged":
        nodes.push({ ...base, title: ["Repayment sent home over the canonical bridge"], body, tone: "info" });
        break;
      case "refunded":
        nodes.push({ ...base, title: [m(amount(a.amount)), ` ${a.sent} refunded`], body, tone: "proven" });
        break;
      case "failed":
        nodes.push({
          ...base,
          title: ["Stopped"],
          body: richDetail(s.detail ?? j.error ?? "The relayer stopped on this step."),
          tone: "failed",
        });
        break;
      default:
        nodes.push({ ...base, title: [s.name], body, tone: "info" });
    }
  }
  if (j.state === "open") {
    const filling = j.steps.some((s) => s.name === "filled");
    if (!filling)
      nodes.push({
        key: "wait-fill",
        lane: "fast",
        title: ["Waiting for a solver or a vault"],
        body: [`If nobody fills before the deadline, a proof that no fill happened refunds the escrow.`],
        tone: "active",
        txs: [],
      });
  }
  if (j.state === "filled") {
    nodes.push({
      key: "wait-proof",
      lane: "main",
      title: ["Solver repaid after proof"],
      body: ["The escrow moves to the solver once the light client has proven the fill."],
      tone: "active",
      txs: [],
    });
  }
  if (j.state === "failed" && !j.steps.some((s) => s.name === "failed")) {
    nodes.push({
      key: "failed",
      lane: "main",
      title: ["Stopped"],
      body: richDetail(j.error ?? "The relayer stopped on this step."),
      tone: "failed",
      txs: [],
    });
  }
  return nodes;
}

export function jobNodes(j: Job, signers: SignerCount | null, known: { ppot?: string; bnbb?: string } = {}) {
  return j.type === "transfer" ? transferNodes(j, signers) : orderNodes(j, known);
}

/** Whether a job will still change. */
export const settled = (j: Job) => ["finalized", "settled", "refunded", "failed"].includes(j.state);
