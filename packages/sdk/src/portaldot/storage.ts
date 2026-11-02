import type { ApiPromise } from "@polkadot/api";
import type { Option } from "@polkadot/types";
import type { StorageData } from "@polkadot/types/interfaces";
import { blake2AsU8a, keccakAsU8a, xxhashAsU8a } from "@polkadot/util-crypto";
import { stringToU8a } from "@polkadot/util";
import { encodeAbiParameters } from "viem";
import { concat, ScaleReader, toHex, toU8a, type Hex } from "./scale";

/** `twox128(pallet) ‖ twox128(item)`, the key of a plain storage value. */
export function storageValueKey(pallet: string, item: string): Hex {
  return toHex(concat(xxhashAsU8a(pallet, 128), xxhashAsU8a(item, 128)));
}

export const BEEFY_VALIDATOR_SET_ID_KEY = storageValueKey("Beefy", "ValidatorSetId");
export const BEEFY_NEXT_AUTHORITIES_KEY = storageValueKey("Beefy", "NextAuthorities");
export const BEEFY_AUTHORITIES_KEY = storageValueKey("Beefy", "Authorities");
export const TIMESTAMP_NOW_KEY = storageValueKey("Timestamp", "Now");
/** `Revive::AccountInfoOf` is a map with the Identity hasher over H160. */
export const REVIVE_ACCOUNT_INFO_PREFIX = storageValueKey("Revive", "AccountInfoOf");

export const CHILD_STORAGE_PREFIX = stringToU8a(":child_storage:default:");

export function accountInfoKey(h160: Hex): Hex {
  const a = toU8a(h160);
  if (a.length !== 20) throw new Error("expected a 20-byte address");
  return toHex(concat(toU8a(REVIVE_ACCOUNT_INFO_PREFIX), a));
}

/** Main-trie key holding the root of a revive contract's child trie. */
export function childInfoKey(trieId: Hex): Hex {
  return toHex(concat(CHILD_STORAGE_PREFIX, toU8a(trieId)));
}

/** revive stores EVM slot `s` under `blake2_256(s)` in the contract's child trie. */
export function reviveSlotKey(slot: Hex): Hex {
  const s = toU8a(slot);
  if (s.length !== 32) throw new Error("slot must be 32 bytes");
  return toHex(blake2AsU8a(s, 256));
}

/** Slot of `commitments[key]` in the Outbox: `commitments` is the mapping at slot 0. */
export function outboxSlot(key: Hex): Hex {
  return toHex(keccakAsU8a(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [key, 0n]) as Hex));
}

/** `keccak256(abi.encode(app, appKey))`, the same as `Outbox.keyFor`. */
export function outboxKey(app: Hex, appKey: Hex): Hex {
  return toHex(keccakAsU8a(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [app, appKey]) as Hex));
}

/**
 * Extracts `trieId` from a SCALE `pallet_revive::AccountInfo`:
 * `accountType: enum { Contract(ContractInfo { trie_id: Vec<u8>, .. }) = 0, EOA = 1 }, dust: u32`.
 */
export function trieIdFromAccountInfo(raw: Hex | Uint8Array): Hex {
  const r = new ScaleReader(toU8a(raw));
  const variant = r.u8();
  if (variant !== 0) throw new Error(`account is not a contract (variant ${variant})`);
  return toHex(r.bytesVec());
}

async function blockHashOf(api: ApiPromise, atBlock: number): Promise<Hex> {
  return (await api.rpc.chain.getBlockHash(atBlock)).toHex() as Hex;
}

/** Main-trie read proof (`state_getReadProof`) of `keys` at block `atBlock`. */
export async function readProof(api: ApiPromise, keys: Hex[], atBlock: number): Promise<Hex[]> {
  const p = await api.rpc.state.getReadProof(keys, await blockHashOf(api, atBlock));
  return p.proof.map((n) => n.toHex() as Hex);
}

/**
 * Child-trie read proof of `keys` at block `atBlock`. `state_getChildReadProof` also returns the
 * main-trie path to the child root; nodes already in `mainProof` are dropped, since the verifier
 * reads the child root from the main proof and only walks the child trie with this one.
 */
export async function childReadProof(
  api: ApiPromise,
  trieId: Hex,
  keys: Hex[],
  atBlock: number,
  mainProof: Hex[] = [],
): Promise<Hex[]> {
  const p = await api.rpc.state.getChildReadProof(childInfoKey(trieId), keys, await blockHashOf(api, atBlock));
  const known = new Set(mainProof);
  return p.proof.map((n) => n.toHex() as Hex).filter((n) => !known.has(n));
}

/** trieId of a revive contract at block `atBlock`, read from `Revive::AccountInfoOf`. */
export async function trieIdOf(api: ApiPromise, h160: Hex, atBlock: number): Promise<Hex> {
  const raw = await api.rpc.state.getStorage<Option<StorageData>>(accountInfoKey(h160), await blockHashOf(api, atBlock));
  if (raw.isNone) throw new Error(`no revive account at ${h160}`);
  return trieIdFromAccountInfo(raw.unwrap().toU8a(true));
}

/** Proof for `PortaldotVerifier.bindTrieId(atBlock, proof)`. */
export async function buildBindProof(api: ApiPromise, contractH160: Hex, atBlock: number): Promise<Hex[]> {
  return readProof(api, [accountInfoKey(contractH160)], atBlock);
}

const PROOF_ABI = [{ type: "uint32" }, { type: "bytes[]" }, { type: "bytes[]" }] as const;

/** `abi.encode(uint32 headerNumber, bytes[] mainProof, bytes[] childProof)` for an EVM slot of a revive contract. */
export async function buildSlotProof(
  api: ApiPromise,
  contractH160: Hex,
  slot: Hex,
  atBlock: number,
  withTimestamp = false,
): Promise<Hex> {
  const trieId = await trieIdOf(api, contractH160, atBlock);
  const mainKeys = withTimestamp ? [childInfoKey(trieId), TIMESTAMP_NOW_KEY] : [childInfoKey(trieId)];
  const mainProof = await readProof(api, mainKeys, atBlock);
  const childProof = await childReadProof(api, trieId, [reviveSlotKey(slot)], atBlock, mainProof);
  return encodeAbiParameters(PROOF_ABI, [atBlock, mainProof, childProof]);
}

/** Proof for `PortaldotVerifier.verifyCommitment(key, value, proof)`, against the Outbox state at `atBlock`. */
export function buildCommitmentProof(api: ApiPromise, outboxH160: Hex, key: Hex, atBlock: number): Promise<Hex> {
  return buildSlotProof(api, outboxH160, outboxSlot(key), atBlock);
}

/**
 * Proof for `PortaldotVerifier.verifyAbsence(key, notBefore, proof)`: the main-trie part also
 * covers `Timestamp::Now`, since Substrate headers carry no timestamp.
 */
export function buildAbsenceProof(api: ApiPromise, outboxH160: Hex, key: Hex, atBlock: number): Promise<Hex> {
  return buildSlotProof(api, outboxH160, outboxSlot(key), atBlock, true);
}
