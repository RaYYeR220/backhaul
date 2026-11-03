/** Typed client for the relayer API. Shapes follow services/relayer/API.md. */

import { RELAYER_URL, type ChainName } from "./config";

/* ---------- shapes ---------- */

export interface Step {
  name: string;
  at: string;
  chain: ChainName | null;
  tx: string | null;
  block: string | null;
  link: string | null;
  detail: string | null;
}

interface JobBase {
  id: string;
  from: ChainName;
  to: ChainName;
  recipient: string;
  sourceTx: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  steps: Step[];
}

export type TransferKind = "POT_TO_BSC" | "PPOT_TO_PORTALDOT" | "BNB_TO_PORTALDOT" | "BNBB_TO_BSC";

export interface TransferJob extends JobBase {
  type: "transfer";
  state: "locked" | "proven" | "finalized" | "failed";
  nonce: string;
  kind: number;
  kindName: TransferKind | null;
  amount: string;
}

export interface OrderJob extends JobBase {
  type: "order";
  state: "open" | "filled" | "settled" | "refunded" | "failed";
  orderId: string;
  user: string;
  inputToken: string;
  inputAmount: string;
  outputToken: string;
  outputAmount: string;
  fillDeadline: number;
  fill: { tx: string; block: string; filler: string; repayTo: string } | null;
}

export type Job = TransferJob | OrderJob;

export type AssetSymbol = "tPOT" | "tBNB" | "pPOT" | "BNB.b";
type PerAsset = Partial<Record<AssetSymbol, string>>;

export interface BeefySide {
  client: string;
  error?: string;
  setId?: string;
  latestBlock?: number;
  beefyHead?: number;
  finalized?: number;
  lagBlocks?: number;
  archived?: number;
  halted?: string | null;
  lastError?: string | null;
  lastTx?: { kind: "commitment" | "header" | "rotate"; tx: string; block: number; setId: string; link: string } | null;
}

export interface ParliaSide {
  client: string;
  error?: string;
  trustedEpoch?: string;
  activeFrom?: string;
  validators?: string[];
  epochTimestamp?: string;
  installedAt?: string;
  trustingPeriodSec?: string;
  trustRemainingSec?: string;
  trustAlert?: string | null;
  bscHead?: string;
  liveOverlap?: number | null;
  lastWindow?: { block: string; tx: string; headers: number } | null;
  lagBlocks?: string | null;
  lastError?: string | null;
}

export interface DemoLimits {
  perRequest: PerAsset;
  perDay: PerAsset;
  perIpPerHour: number;
}

export interface Status {
  at: string;
  portaldotToBsc: BeefySide;
  bscToPortaldot: ParliaSide;
  jobs: { transfers: Record<string, number>; orders: Record<string, number> };
  relayer: { address: string; balances: { portaldot: string; bsc: string } };
  solver: { address: string; limits: { maxOutput: PerAsset; minFeeBps: number; minDeadlineLeft: number; prefund: string } } | null;
  demo: { address: string; limits: DemoLimits; usedToday: PerAsset } | null;
  addresses: { portaldot: Record<string, string | number | undefined>; bsc: Record<string, string | undefined> };
}

export interface AttackInfo {
  id: string;
  title: string;
  chain: ChainName;
  description?: string;
  target: string;
  address?: string | null;
  expects: string[];
  ready: boolean;
  missing?: string[];
}

export interface AttackList {
  total: number;
  ready: number;
  items: AttackInfo[];
}

export interface AttackResult {
  id: string;
  title: string;
  chain: ChainName;
  target: string;
  call: { to: string; data: string };
  reverted: boolean;
  reason: string;
  defended: boolean;
  ms: number;
}

export type DemoRoute = "pot-to-bsc" | "bnb-to-portaldot" | "ppot-to-portaldot" | "bnbb-to-bsc";

export interface DemoSent {
  id: string;
  route: DemoRoute;
  amount: string;
  recipient: string;
  tx: string;
  link: string;
  statusUrl: string;
}

/* ---------- transport ---------- */

/** `unreachable`: no answer at all. `http`: the relayer answered with an error status. */
export class RelayerError extends Error {
  constructor(
    readonly kind: "unreachable" | "http",
    message: string,
    readonly status = 0,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const isUnreachable = (e: unknown) => e instanceof RelayerError && e.kind === "unreachable";

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const outer = init.signal;
  outer?.addEventListener("abort", () => ctl.abort(), { once: true });
  let res: Response;
  try {
    res = await fetch(`${RELAYER_URL}${path}`, { ...init, signal: ctl.signal, cache: "no-store" });
  } catch (e) {
    if (outer?.aborted) throw e;
    throw new RelayerError("unreachable", `the relayer at ${RELAYER_URL} did not answer`);
  } finally {
    clearTimeout(timer);
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    if (res.ok) throw new RelayerError("http", "the relayer answered with something that is not JSON", res.status);
  }
  if (!res.ok) throw new RelayerError("http", typeof body.error === "string" ? body.error : `HTTP ${res.status}`, res.status, body);
  return body as T;
}

export const relayer = {
  status: (signal?: AbortSignal) => call<Status>("/status", { signal }),
  transfers: (opts: { limit?: number; type?: "transfer" | "order" } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams({ limit: String(opts.limit ?? 50) });
    if (opts.type) q.set("type", opts.type);
    return call<{ items: Job[] }>(`/transfers?${q}`, { signal });
  },
  job: (id: string, signal?: AbortSignal) => call<Job>(`/transfers/${encodeURIComponent(id)}`, { signal }),
  attacks: (signal?: AbortSignal) => call<AttackList>("/attacks", { signal }, 45_000),
  fire: (id: string) => call<AttackResult>(`/attacks/${encodeURIComponent(id)}`, { method: "POST" }, 60_000),
  demo: (route: DemoRoute, amount: string, recipient: string) =>
    call<DemoSent>(
      "/demo/transfer",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ route, amount, recipient }) },
      90_000,
    ),
};
