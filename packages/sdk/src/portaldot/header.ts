import type { ApiPromise } from "@polkadot/api";
import { blake2AsU8a } from "@polkadot/util-crypto";
import { ScaleReader, toHex, toU8a, type Hex } from "./scale";

export interface DecodedHeader {
  hash: Hex;
  parentHash: Hex;
  number: number;
  stateRoot: Hex;
  extrinsicsRoot: Hex;
}

export const blake2_256 = (data: Hex | Uint8Array): Hex => toHex(blake2AsU8a(toU8a(data), 256));

/**
 * Decodes the fixed prefix of a SCALE header:
 * `parentHash[32] | number Compact<u32> | stateRoot[32] | extrinsicsRoot[32] | digest`.
 */
export function decodeHeader(headerScale: Hex | Uint8Array): DecodedHeader {
  const bytes = toU8a(headerScale);
  const r = new ScaleReader(bytes);
  const parentHash = toHex(r.take(32));
  const number = r.compactNumber();
  const stateRoot = toHex(r.take(32));
  const extrinsicsRoot = toHex(r.take(32));
  return { hash: blake2_256(bytes), parentHash, number, stateRoot, extrinsicsRoot };
}

/** SCALE bytes of the canonical header at `blockNumber`; checks they hash to the block hash. */
export async function fetchHeaderScale(api: ApiPromise, blockNumber: number): Promise<Hex> {
  const hash = await api.rpc.chain.getBlockHash(blockNumber);
  const header = await api.rpc.chain.getHeader(hash);
  const bytes = header.toU8a();
  if (blake2_256(bytes) !== hash.toHex()) throw new Error(`header ${blockNumber} does not hash to its block hash`);
  return toHex(bytes);
}
