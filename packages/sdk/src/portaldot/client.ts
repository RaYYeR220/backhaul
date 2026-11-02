import { ApiPromise, WsProvider } from "@polkadot/api";
import type { Hex } from "./scale";

export const PORTALDOT_WS = "wss://test-node-v3.portaldot.dev";
export const PORTALDOT_HTTP = "https://test-node-v3.portaldot.dev";

export interface PortaldotClient {
  api: ApiPromise;
  provider: WsProvider;
  /** HTTP JSON-RPC endpoint used for large batched reads. */
  http: string;
}

export async function connectPortaldot(ws = PORTALDOT_WS, http = PORTALDOT_HTTP): Promise<PortaldotClient> {
  const provider = new WsProvider(ws);
  const api = await ApiPromise.create({ provider, noInitWarn: true });
  return { api, provider, http };
}

export async function disconnectPortaldot(c: PortaldotClient): Promise<void> {
  await c.api.disconnect();
}

let rpcId = 0;

/** Plain JSON-RPC call over HTTP, with a few retries on transport errors. */
export async function httpRpc<T>(url: string, method: string, params: unknown[], retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      });
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: { message: string } };
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result as T;
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

/**
 * Block hashes for `[from, to)`. `chain_getBlockHash` accepts a list of numbers, so one request
 * covers `batch` blocks.
 */
export async function fetchBlockHashes(
  url: string,
  from: number,
  to: number,
  batch = 1000,
  onProgress?: (done: number) => void,
): Promise<Hex[]> {
  const out: Hex[] = [];
  for (let start = from; start < to; start += batch) {
    const nums: number[] = [];
    for (let n = start; n < Math.min(start + batch, to); n++) nums.push(n);
    const hashes = await httpRpc<(Hex | null)[]>(url, "chain_getBlockHash", [nums]);
    if (hashes.length !== nums.length) throw new Error("chain_getBlockHash returned a short batch");
    hashes.forEach((h, i) => {
      if (!h) throw new Error(`no hash for block ${nums[i]}`);
      out.push(h);
    });
    onProgress?.(out.length);
  }
  return out;
}

/** Number of the latest GRANDPA-finalized block. */
export async function finalizedNumber(api: ApiPromise): Promise<number> {
  const head = await api.rpc.chain.getFinalizedHead();
  return (await api.rpc.chain.getHeader(head)).number.toNumber();
}
