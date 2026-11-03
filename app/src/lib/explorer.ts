import { EXPLORERS, type ChainName } from "./config";

/** Substrate AccountId32 of an EVM address on revive: the h160 followed by twelve 0xEE bytes. */
export const accountId32 = (h160: string) => `0x${h160.slice(2).toLowerCase()}${"ee".repeat(12)}`;

export function blockUrl(chain: ChainName, n: string | number): string {
  return chain === "bsc" ? `${EXPLORERS.bsc}/block/${n}` : `${EXPLORERS.portaldot}/blocks/${n}`;
}

/**
 * BscScan links every transaction. The Portaldot explorer indexes Substrate extrinsics, not EVM
 * hashes, so a Portaldot transaction links to the block that holds it.
 */
export function txUrl(chain: ChainName, tx: string, block?: string | number | null): string | null {
  if (chain === "bsc") return `${EXPLORERS.bsc}/tx/${tx}`;
  return block != null && block !== "" ? blockUrl("portaldot", block) : null;
}

export function addressUrl(chain: ChainName, address: string): string {
  return chain === "bsc" ? `${EXPLORERS.bsc}/address/${address}` : `${EXPLORERS.portaldot}/accounts/${accountId32(address)}`;
}

/** 0x1234…cdef */
export const shortHex = (h: string, head = 6, tail = 4) => (h.length <= head + tail + 2 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`);
