// BSC (Parlia) header encoding, seal hashes and epoch extra parsing.

import { RLP } from '@ethereumjs/rlp';
import { bigIntToUnpaddedBytes, bytesToHex, hexToBytes } from '@ethereumjs/util';
import { getAddress, keccak256, recoverAddress, type Address, type Hex } from 'viem';
import type { RpcBlock } from './client.js';

/** Fixed prefix of `extra` reserved for the proposer's vanity data. */
export const EXTRA_VANITY = 32;
/** Fixed suffix of `extra` holding the 65-byte seal (r ‖ s ‖ v, v ∈ {0,1}). */
export const EXTRA_SEAL = 65;
/** Each validator in an epoch block: consensus address (20) ‖ BLS vote key (48). */
export const VALIDATOR_BYTES = 68;

/** Index of each field in the header RLP list. */
export const F = {
  parentHash: 0,
  uncleHash: 1,
  coinbase: 2,
  stateRoot: 3,
  txRoot: 4,
  receiptsRoot: 5,
  bloom: 6,
  difficulty: 7,
  number: 8,
  gasLimit: 9,
  gasUsed: 10,
  time: 11,
  extra: 12,
  mixHash: 13,
  nonce: 14,
  baseFee: 15,
  parentBeaconRoot: 19,
} as const;

export interface DecodedHeader {
  hash: Hex;
  parentHash: Hex;
  number: bigint;
  timestamp: bigint;
  coinbase: Address;
  stateRoot: Hex;
  receiptsRoot: Hex;
  extra: Hex;
  items: Uint8Array[];
}

export interface EpochExtra {
  validators: Address[];
  turnLength: number;
}

const quantity = (h: Hex | undefined): Uint8Array => bigIntToUnpaddedBytes(BigInt(h ?? '0x0'));
const raw = (h: Hex): Uint8Array => hexToBytes(h);

/** The header's RLP items, in consensus order, from an RPC block. Optional fields appear only if present. */
export function headerItems(block: RpcBlock): Uint8Array[] {
  const items: Uint8Array[] = [
    raw(block.parentHash),
    raw(block.sha3Uncles),
    raw(block.miner),
    raw(block.stateRoot),
    raw(block.transactionsRoot),
    raw(block.receiptsRoot),
    raw(block.logsBloom),
    quantity(block.difficulty),
    quantity(block.number),
    quantity(block.gasLimit),
    quantity(block.gasUsed),
    quantity(block.timestamp),
    raw(block.extraData),
    raw(block.mixHash),
    raw(block.nonce),
  ];
  // Same order and presence rules as go-ethereum's Header encoding.
  if (block.baseFeePerGas !== undefined) items.push(quantity(block.baseFeePerGas));
  if (block.withdrawalsRoot !== undefined) items.push(raw(block.withdrawalsRoot));
  if (block.blobGasUsed !== undefined) items.push(quantity(block.blobGasUsed));
  if (block.excessBlobGas !== undefined) items.push(quantity(block.excessBlobGas));
  if (block.parentBeaconBlockRoot !== undefined) items.push(raw(block.parentBeaconBlockRoot));
  if (block.requestsHash !== undefined) items.push(raw(block.requestsHash));
  return items;
}

/** RLP of a block header. Throws unless keccak256(rlp) equals the block hash the node reported. */
export function headerRlp(block: RpcBlock): Hex {
  const rlp = bytesToHex(RLP.encode(headerItems(block))) as Hex;
  const hash = keccak256(rlp);
  if (hash !== block.hash.toLowerCase()) {
    throw new Error(`header ${BigInt(block.number)}: keccak(rlp) ${hash} != block hash ${block.hash}`);
  }
  return rlp;
}

/** Decodes a header RLP into the fields the light client uses. */
export function decodeHeader(rlp: Hex): DecodedHeader {
  const decoded = RLP.decode(hexToBytes(rlp));
  if (!Array.isArray(decoded) || decoded.length < 15) throw new Error('not a header RLP list');
  const items = decoded as Uint8Array[];
  return {
    hash: keccak256(rlp),
    parentHash: bytesToHex(items[F.parentHash]) as Hex,
    number: bytesToBig(items[F.number]),
    timestamp: bytesToBig(items[F.time]),
    coinbase: getAddress(bytesToHex(items[F.coinbase])),
    stateRoot: bytesToHex(items[F.stateRoot]) as Hex,
    receiptsRoot: bytesToHex(items[F.receiptsRoot]) as Hex,
    extra: bytesToHex(items[F.extra]) as Hex,
    items,
  };
}

/**
 * Parlia seal hash: keccak256(RLP([chainId, parentHash … time, extra[:-65], mixHash, nonce, …])).
 * The post-Cancun fields (baseFee … parentBeaconRoot, then requestsHash) are included only when
 * parentBeaconRoot is present, exactly like bsc `types.EncodeSigHeader`.
 */
export function sealHash(items: Uint8Array[], chainId: bigint | number): Hex {
  const extra = items[F.extra];
  if (extra.length < EXTRA_SEAL) throw new Error('extra shorter than a seal');
  const fields: Uint8Array[] = [
    bigIntToUnpaddedBytes(BigInt(chainId)),
    ...items.slice(0, F.extra),
    extra.subarray(0, extra.length - EXTRA_SEAL),
    items[F.mixHash],
    items[F.nonce],
  ];
  if (items.length > F.parentBeaconRoot) fields.push(...items.slice(F.baseFee));
  return keccak256(RLP.encode(fields));
}

/** The 65-byte seal at the end of `extra`, split into r, s and yParity. */
export function sealOf(extra: Uint8Array): { r: Hex; s: Hex; yParity: number } {
  const sig = extra.subarray(extra.length - EXTRA_SEAL);
  return { r: bytesToHex(sig.subarray(0, 32)) as Hex, s: bytesToHex(sig.subarray(32, 64)) as Hex, yParity: sig[64] };
}

/** Address that sealed a header (given as RLP), under `chainId`. */
export async function sealerOf(rlp: Hex, chainId: bigint | number): Promise<Address> {
  const { items } = decodeHeader(rlp);
  return recoverAddress({ hash: sealHash(items, chainId), signature: sealOf(items[F.extra]) });
}

/**
 * Validators and turn length announced by an epoch block:
 * extra = vanity32 | count u8 | count × (address20 ‖ bls48) | turnLength u8 | attestation… | seal65.
 */
export function parseEpochExtra(extraHex: Hex): EpochExtra {
  const extra = hexToBytes(extraHex);
  if (extra.length <= EXTRA_VANITY + EXTRA_SEAL) throw new Error('epoch extra too short');
  const count = extra[EXTRA_VANITY];
  const end = EXTRA_VANITY + 1 + count * VALIDATOR_BYTES;
  if (count === 0 || end + 1 + EXTRA_SEAL > extra.length) throw new Error('bad validator count in epoch extra');
  const validators: Address[] = [];
  for (let i = 0; i < count; i++) {
    const at = EXTRA_VANITY + 1 + i * VALIDATOR_BYTES;
    validators.push(getAddress(bytesToHex(extra.subarray(at, at + 20))));
  }
  const turnLength = extra[end];
  if (turnLength === 0) throw new Error('zero turn length in epoch extra');
  return { validators, turnLength };
}

/**
 * Blocks between an epoch block E and the first block sealed by the set E announces:
 * the new set seals from E + (⌊N/2⌋+1)·turnLength, where N and turnLength belong to the set
 * in force before the switch (bsc consensus/parlia/snapshot.go, minerHistoryCheckLen() + 1).
 */
export function switchOffset(setSize: number, turnLength: number): number {
  return (Math.floor(setSize / 2) + 1) * turnLength;
}

/** Distinct sealers needed to finalize: ⌈2N/3⌉. */
export function quorum(setSize: number): number {
  return Math.ceil((2 * setSize) / 3);
}

function bytesToBig(b: Uint8Array): bigint {
  return b.length === 0 ? 0n : BigInt(bytesToHex(b));
}
