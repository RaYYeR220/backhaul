/**
 * Reads straight from the two testnets, independent of the relayer: who sealed the BNB Chain
 * headers above a deposit, which BEEFY authorities Portaldot runs, and when its set hands over.
 */

import { decodeFunctionData } from "viem";
import { RPCS } from "./config";

type RpcReq = { method: string; params?: unknown[] };

async function rpcBatch<T = unknown>(url: string, reqs: RpcReq[], signal?: AbortSignal): Promise<T[]> {
  const body = reqs.map((r, i) => ({ jsonrpc: "2.0", id: i + 1, method: r.method, params: r.params ?? [] }));
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  const out = (await res.json()) as { id: number; result?: T; error?: { message: string } }[];
  const byId = new Map(out.map((o) => [o.id, o]));
  return body.map((b) => {
    const o = byId.get(b.id);
    if (!o || o.error) throw new Error(o?.error?.message ?? `no answer to ${b.method}`);
    return o.result as T;
  });
}

export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = [], signal?: AbortSignal): Promise<T> {
  return (await rpcBatch<T>(url, [{ method, params }], signal))[0];
}

/* ---------- BNB Chain ---------- */

const BSC_EPOCH = 1000;
const BSC_TURN = 8;

export const bscHead = async (signal?: AbortSignal) => parseInt(await rpc<string>(RPCS.bsc, "eth_blockNumber", [], signal), 16);

/** The miner (sealer) of each block in [from, to], lowest first. */
export async function bscMiners(from: number, to: number, signal?: AbortSignal): Promise<{ n: number; miner: string }[]> {
  if (to < from) return [];
  const reqs: RpcReq[] = [];
  for (let n = from; n <= to; n++) reqs.push({ method: "eth_getBlockByNumber", params: ["0x" + n.toString(16), false] });
  const blocks = await rpcBatch<{ number: string; miner: string } | null>(RPCS.bsc, reqs, signal);
  return blocks.filter((b): b is { number: string; miner: string } => !!b).map((b) => ({ n: parseInt(b.number, 16), miner: b.miner.toLowerCase() }));
}

/**
 * BNB Chain's validator set in force at `n`, read from the epoch header that announced it. A set
 * announced at epoch E takes over at E + (⌊N/2⌋ + 1) · turnLength − 1, as BNB Chain applies it.
 */
export async function bscValidatorsAt(n: number, signal?: AbortSignal): Promise<{ epoch: number; validators: string[] }> {
  const delay = (Math.floor(9 / 2) + 1) * BSC_TURN - 1;
  let epoch = Math.floor(n / BSC_EPOCH) * BSC_EPOCH;
  if (n < epoch + delay) epoch -= BSC_EPOCH;
  const block = await rpc<{ extraData: string }>(RPCS.bsc, "eth_getBlockByNumber", ["0x" + epoch.toString(16), false], signal);
  const extra = block.extraData.slice(2);
  const count = parseInt(extra.slice(64, 66), 16);
  const validators: string[] = [];
  for (let i = 0; i < count; i++) validators.push("0x" + extra.slice(66 + i * 136, 106 + i * 136));
  if (!validators.length) throw new Error(`epoch header ${epoch} carries no validator set`);
  return { epoch, validators };
}

/** Distinct sealers needed to finalize a block under the Parlia light client: ⌈2N/3⌉. */
export const parliaQuorum = (n: number) => Math.ceil((2 * n) / 3);

const SUBMIT_COMMITMENT = [
  {
    type: "function",
    name: "submitCommitment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "commitmentScale", type: "bytes" },
      { name: "validatorIndices", type: "uint256[]" },
      { name: "signatures", type: "bytes[]" },
    ],
    outputs: [],
  },
] as const;

/** Indices of the BEEFY authorities whose signatures a submitCommitment transaction carried. */
export async function beefyCommitmentSigners(tx: string, signal?: AbortSignal): Promise<number[] | null> {
  const t = await rpc<{ input: string } | null>(RPCS.bsc, "eth_getTransactionByHash", [tx], signal);
  if (!t) return null;
  try {
    const d = decodeFunctionData({ abi: SUBMIT_COMMITMENT, data: t.input as `0x${string}` });
    return (d.args[1] as readonly bigint[]).map(Number);
  } catch {
    return null;
  }
}

/* ---------- Portaldot ---------- */

class Scale {
  private o = 0;
  constructor(private readonly b: Uint8Array) {}
  u8() {
    return this.b[this.o++];
  }
  u64() {
    let v = 0n;
    for (let i = 0; i < 8; i++) v |= BigInt(this.b[this.o + i]) << BigInt(8 * i);
    this.o += 8;
    return v;
  }
  compact() {
    const f = this.b[this.o];
    if ((f & 3) === 0) return this.u8() >> 2;
    if ((f & 3) === 1) {
      const v = (this.b[this.o] | (this.b[this.o + 1] << 8)) >> 2;
      this.o += 2;
      return v;
    }
    const v = (this.b[this.o] | (this.b[this.o + 1] << 8) | (this.b[this.o + 2] << 16) | (this.b[this.o + 3] << 24)) >>> 2;
    this.o += 4;
    return v;
  }
  take(n: number) {
    const out = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }
}

const bytes = (hex: string) => {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const toHex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Portaldot's current BEEFY authorities (33-byte compressed keys) and set id. */
export async function beefyValidatorSet(signal?: AbortSignal): Promise<{ setId: number; authorities: string[] }> {
  const raw = await rpc<string>(RPCS.portaldotNode, "state_call", ["BeefyApi_validator_set", "0x"], signal);
  const r = new Scale(bytes(raw));
  if (r.u8() !== 1) throw new Error("Portaldot reports no BEEFY validator set");
  const n = r.compact();
  const authorities = Array.from({ length: n }, () => toHex(r.take(33)));
  return { setId: Number(r.u64()), authorities };
}

/** The newest Portaldot block BEEFY has signed. */
export async function beefyFinalized(signal?: AbortSignal): Promise<number> {
  const hash = await rpc<string>(RPCS.portaldotNode, "beefy_getFinalizedHead", [], signal);
  const h = await rpc<{ number: string }>(RPCS.portaldotNode, "chain_getHeader", [hash], signal);
  return parseInt(h.number, 16);
}

/**
 * The current BABE epoch. BEEFY's validator set id moves on at every session boundary, which on
 * Portaldot is the end of this epoch. Slots are 6 s counted from the Unix epoch.
 */
export async function babeEpoch(signal?: AbortSignal): Promise<{ index: number; startSlot: number; duration: number; endsAt: number }> {
  const raw = await rpc<string>(RPCS.portaldotNode, "state_call", ["BabeApi_current_epoch", "0x"], signal);
  const r = new Scale(bytes(raw));
  const index = Number(r.u64());
  const startSlot = Number(r.u64());
  const duration = Number(r.u64());
  return { index, startSlot, duration, endsAt: (startSlot + duration) * 6000 };
}
