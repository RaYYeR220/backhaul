/** A browser wallet over EIP-1193, and the gateway calls a visitor sends from it. */

import { decodeEventLog, encodeFunctionData, type Hex } from "viem";
import type { Route } from "./assets";
import { rpc } from "./chain";
import { CHAINS, EXPLORERS, RPCS, type ChainName } from "./config";
import { bscGatewayAbi, deployments, erc20Abi, portaldotGatewayAbi } from "./deployments";

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (...a: unknown[]) => void): void;
  removeListener?(event: string, fn: (...a: unknown[]) => void): void;
}

export const injected = (): Eip1193 | null =>
  typeof window !== "undefined" ? ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) : null;

const hexId = (id: number) => "0x" + id.toString(16);

/** Parameters for wallet_addEthereumChain. */
export const ADD_CHAIN: Record<ChainName, Record<string, unknown>> = {
  portaldot: {
    chainId: hexId(CHAINS.portaldot.id),
    chainName: CHAINS.portaldot.full,
    nativeCurrency: { name: "Portaldot", symbol: "tPOT", decimals: 18 },
    rpcUrls: [RPCS.portaldotEvm],
  },
  bsc: {
    chainId: hexId(CHAINS.bsc.id),
    chainName: "BNB Smart Chain Testnet",
    nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
    rpcUrls: [RPCS.bsc],
    blockExplorerUrls: [EXPLORERS.bsc],
  },
};

const code = (e: unknown): number | undefined => {
  const x = e as { code?: number; data?: { originalError?: { code?: number } } };
  return x?.data?.originalError?.code ?? x?.code;
};

/** Switches the wallet to `chain`, adding the network first if the wallet does not know it. */
export async function switchTo(eth: Eip1193, chain: ChainName) {
  const chainId = hexId(CHAINS[chain].id);
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    if (code(e) !== 4902) throw e;
    await eth.request({ method: "wallet_addEthereumChain", params: [ADD_CHAIN[chain]] });
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  }
}

/** A wallet error in one line: "rejected in the wallet" rather than an RPC stack. */
export function walletMessage(e: unknown): string {
  if (code(e) === 4001) return "You rejected the request in your wallet.";
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  return m.split("\n")[0];
}

const rpcOf = (chain: ChainName) => (chain === "bsc" ? RPCS.bsc : RPCS.portaldotEvm);

interface Receipt {
  status: string;
  blockNumber: string;
  logs: { address: string; topics: Hex[]; data: Hex }[];
}

/** Waits for `hash` on the chain's public RPC, which is what the relayer watches too. */
export async function waitReceipt(chain: ChainName, hash: string, timeoutMs = 240_000): Promise<Receipt> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await rpc<Receipt | null>(rpcOf(chain), "eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 2500));
  }
  throw new Error("The transaction was not included within 4 minutes. It may still land; check your wallet.");
}

export function gatewayFor(route: Route): `0x${string}` | null {
  return route.from === "bsc" ? (deployments.bsc?.gateway ?? null) : (deployments.portaldot?.gateway ?? null);
}

/** The call that starts `route`: lock or burn on the source chain's gateway. */
export function gatewayCall(route: Route, amount: bigint, recipient: `0x${string}`): { to: `0x${string}`; data: Hex; value: bigint } {
  const to = gatewayFor(route);
  if (!to) throw new Error(`no gateway on ${CHAINS[route.from].name} in this build`);
  switch (route.kind) {
    case "BNB_TO_PORTALDOT":
      return { to, data: encodeFunctionData({ abi: bscGatewayAbi, functionName: "lockBNB", args: [recipient] }), value: amount };
    case "PPOT_TO_PORTALDOT":
      return { to, data: encodeFunctionData({ abi: bscGatewayAbi, functionName: "burnPPOT", args: [amount, recipient] }), value: 0n };
    case "POT_TO_BSC":
      return { to, data: encodeFunctionData({ abi: portaldotGatewayAbi, functionName: "lockPOT", args: [recipient] }), value: amount };
    case "BNBB_TO_BSC":
      return { to, data: encodeFunctionData({ abi: portaldotGatewayAbi, functionName: "burnBNBb", args: [amount, recipient] }), value: 0n };
  }
}

/** BNB.b leaves through the gateway's allowance; the other routes need none. */
export async function allowance(owner: string): Promise<bigint | null> {
  const token = deployments.portaldot?.bnbb;
  const spender = deployments.portaldot?.gateway;
  if (!token || !spender) return null;
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner as `0x${string}`, spender] });
  return BigInt(await rpc<string>(RPCS.portaldotEvm, "eth_call", [{ to: token, data }, "latest"]));
}

export function approveCall(amount: bigint): { to: `0x${string}`; data: Hex } {
  const token = deployments.portaldot?.bnbb;
  const spender = deployments.portaldot?.gateway;
  if (!token || !spender) throw new Error("BNB.b is not deployed in this build");
  return { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) };
}

/** The transfer nonce from the gateway's Locked event, so the app can link `chain:nonce`. */
export function lockedNonce(route: Route, r: Receipt): string | null {
  const gw = gatewayFor(route)?.toLowerCase();
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== gw) continue;
    try {
      const ev = decodeEventLog({
        abi: route.from === "bsc" ? bscGatewayAbi : portaldotGatewayAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (ev.eventName === "Locked") return String((ev.args as { nonce: bigint }).nonce);
    } catch {
      // another event of the gateway
    }
  }
  return null;
}

/** Balance of `asset` held by `owner` on `chain`, read from the public RPC. */
export async function balanceOf(
  chain: ChainName,
  asset: string,
  owner: string,
  tokens: { ppot?: string; bnbb?: string },
): Promise<bigint | null> {
  if (asset === "tBNB" || asset === "tPOT") return BigInt(await rpc<string>(rpcOf(chain), "eth_getBalance", [owner, "latest"]));
  const token = asset === "pPOT" ? tokens.ppot : asset === "BNB.b" ? tokens.bnbb : undefined;
  if (!token) return null;
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner as `0x${string}`] });
  return BigInt(await rpc<string>(rpcOf(chain), "eth_call", [{ to: token, data }, "latest"]));
}
