/** Where the app reads from. Every value can be set at build time with a NEXT_PUBLIC_ variable. */

const trim = (u: string) => u.replace(/\/+$/, "");

/** The relayer's HTTP API (services/relayer/API.md). */
export const RELAYER_URL = trim(process.env.NEXT_PUBLIC_RELAYER_URL || "http://localhost:8787");

export const EXPLORERS = {
  portaldot: trim(process.env.NEXT_PUBLIC_PORTALDOT_EXPLORER || "https://scanner-testnet-v3.portaldot.dev"),
  bsc: trim(process.env.NEXT_PUBLIC_BSC_EXPLORER || "https://testnet.bscscan.com"),
} as const;

export const RPCS = {
  /** Portaldot's eth-rpc in front of pallet-revive. */
  portaldotEvm: trim(process.env.NEXT_PUBLIC_PORTALDOT_EVM_RPC || "https://test-evm-rpc-v3.portaldot.dev"),
  /** Portaldot's Substrate node, for BEEFY and BABE reads. */
  portaldotNode: trim(process.env.NEXT_PUBLIC_PORTALDOT_NODE_RPC || "https://test-node-v3.portaldot.dev"),
  bsc: trim(process.env.NEXT_PUBLIC_BSC_RPC || "https://bsc-testnet-rpc.publicnode.com"),
} as const;

export type ChainName = "portaldot" | "bsc";

export const CHAINS = {
  portaldot: {
    id: 420420777,
    name: "Portaldot",
    full: "Portaldot V3 testnet",
    native: "tPOT",
    /** Seconds per block, as measured on the testnet. */
    blockSec: 6,
  },
  bsc: {
    id: 97,
    name: "BNB Chain",
    full: "BNB Chain testnet",
    native: "tBNB",
    blockSec: 0.45,
  },
} as const;

export const other = (c: ChainName): ChainName => (c === "bsc" ? "portaldot" : "bsc");
