import { formatUnits } from "viem";
import { type ChainName } from "./config";
import type { AssetSymbol, DemoRoute, Job, TransferKind } from "./relayer";

/** One canonical route of the bridge: what leaves, what arrives, and how. */
export interface Route {
  demo: DemoRoute;
  kind: TransferKind;
  from: ChainName;
  to: ChainName;
  send: AssetSymbol;
  receive: AssetSymbol;
  /** The verb for what happens to `send` on `from`. */
  verb: "Lock" | "Burn" | "Return";
  /** Fraction kept by the gateway, in basis points. */
  feeBps: number;
  /** Most decimals the amount may carry. */
  decimals: number;
}

export const ROUTES: Route[] = [
  { demo: "bnb-to-portaldot", kind: "BNB_TO_PORTALDOT", from: "bsc", to: "portaldot", send: "tBNB", receive: "BNB.b", verb: "Lock", feeBps: 0, decimals: 18 },
  { demo: "ppot-to-portaldot", kind: "PPOT_TO_PORTALDOT", from: "bsc", to: "portaldot", send: "pPOT", receive: "tPOT", verb: "Burn", feeBps: 0, decimals: 14 },
  { demo: "pot-to-bsc", kind: "POT_TO_BSC", from: "portaldot", to: "bsc", send: "tPOT", receive: "pPOT", verb: "Lock", feeBps: 10, decimals: 14 },
  { demo: "bnbb-to-bsc", kind: "BNBB_TO_BSC", from: "portaldot", to: "bsc", send: "BNB.b", receive: "tBNB", verb: "Return", feeBps: 0, decimals: 18 },
];

export const routeOfKind = (k: string | null | undefined) => ROUTES.find((r) => r.kind === k);

/** "1500000000000000000" → "1.5", at most `max` decimals, never rounded up. */
export function amount(wei: string | bigint, max = 6): string {
  let s: string;
  try {
    s = formatUnits(BigInt(wei), 18);
  } catch {
    return String(wei);
  }
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, max).replace(/0+$/, "");
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${int}.${frac}` : int;
}

/** What an order's token address stands for, given the addresses the relayer reports. */
export function tokenSymbol(chain: ChainName, token: string, known: { ppot?: string; bnbb?: string }): string {
  const t = token.toLowerCase();
  if (/^0x0{40}$/.test(t)) return chain === "portaldot" ? "tPOT" : "tBNB";
  if (known.ppot && t === known.ppot.toLowerCase()) return "pPOT";
  if (known.bnbb && t === known.bnbb.toLowerCase()) return "BNB.b";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/** The headline of a job: what was sent and what arrives. */
export function jobAssets(j: Job, known: { ppot?: string; bnbb?: string } = {}) {
  if (j.type === "transfer") {
    const r = routeOfKind(j.kindName);
    // a transfer carries one amount: what arrives (POT_TO_BSC is reported net of its 0.1 % fee)
    return { sent: r?.send ?? "", received: r?.receive ?? "", amount: j.amount, outAmount: j.amount };
  }
  return {
    sent: tokenSymbol(j.from, j.inputToken, known),
    received: tokenSymbol(j.to, j.outputToken, known),
    amount: j.inputAmount,
    outAmount: j.outputAmount,
  };
}

export const chainLabel = (c: ChainName) => (c === "bsc" ? "BNB Chain" : "Portaldot");
