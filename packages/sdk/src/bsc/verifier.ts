// Proof encodings for BscVerifier (IRemoteVerifier on Portaldot over Parlia-finalized BSC headers).
//
// A commitment proof starts with one type byte: RECEIPT_PROOF proves the Outbox's `Committed` log
// in the block that emitted it, STORAGE_PROOF proves `commitments[key]` from the Outbox's storage
// at any finalized block from then on. The receipt path is cheaper (the window above the emitting
// block is often already there), the storage path never expires: the Outbox is write-once.

import { concatHex, decodeAbiParameters, encodeAbiParameters, getAddress, keccak256, sliceHex, toHex, type Address, type Hex } from 'viem';
import type { BscClient } from './client.js';
import { receiptProof } from './receipts.js';
import { grabStorageProof } from './storage.js';

/** Topic of `Committed(bytes32 indexed key, bytes32 value)`, emitted by the Outbox. */
export const COMMITTED_TOPIC = keccak256(toHex('Committed(bytes32,bytes32)'));

/** First byte of a commitment proof (BscVerifier.RECEIPT_PROOF / STORAGE_PROOF). */
export const RECEIPT_PROOF = 0x01;
export const STORAGE_PROOF = 0x02;

const RECEIPT_PARAMS = [{ type: 'uint64' }, { type: 'bytes' }, { type: 'bytes[]' }, { type: 'uint256' }] as const;
const STORAGE_PARAMS = [{ type: 'uint64' }, { type: 'bytes[]' }, { type: 'bytes[]' }] as const;

/** Storage slot of `commitments[key]` in the Outbox (mapping at slot 0). */
export function commitmentSlot(key: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [key, 0n]));
}

/** 0x01 ‖ abi.encode(uint64 blockNumber, bytes receiptKey, bytes[] receiptProof, uint256 logIndex). */
export function encodeCommitmentProof(p: { blockNumber: bigint; key: Hex; proof: Hex[]; logIndex: number | bigint }): Hex {
  return concatHex([toHex(RECEIPT_PROOF, { size: 1 }), encodeAbiParameters(RECEIPT_PARAMS, [p.blockNumber, p.key, p.proof, BigInt(p.logIndex)])]);
}

/** 0x02 ‖ abi.encode(uint64 blockNumber, bytes[] accountProof, bytes[] storageProof). */
export function encodeStorageCommitmentProof(p: { blockNumber: bigint; accountProof: Hex[]; storageProof: Hex[] }): Hex {
  return concatHex([toHex(STORAGE_PROOF, { size: 1 }), encodeAbiParameters(STORAGE_PARAMS, [p.blockNumber, p.accountProof, p.storageProof])]);
}

export type DecodedCommitmentProof =
  | { type: 'receipt'; blockNumber: bigint; key: Hex; proof: readonly Hex[]; logIndex: bigint }
  | { type: 'storage'; blockNumber: bigint; accountProof: readonly Hex[]; storageProof: readonly Hex[] };

/** Splits a commitment proof into its type and fields. */
export function decodeCommitmentProof(proof: Hex): DecodedCommitmentProof {
  const type = proof.length >= 4 ? Number.parseInt(proof.slice(2, 4), 16) : 0;
  const body = proof.length > 4 ? sliceHex(proof, 1) : '0x';
  if (type === RECEIPT_PROOF) {
    const [blockNumber, key, nodes, logIndex] = decodeAbiParameters(RECEIPT_PARAMS, body);
    return { type: 'receipt', blockNumber, key, proof: nodes, logIndex };
  }
  if (type === STORAGE_PROOF) {
    const [blockNumber, accountProof, storageProof] = decodeAbiParameters(STORAGE_PARAMS, body);
    return { type: 'storage', blockNumber, accountProof, storageProof };
  }
  throw new Error(`unknown commitment proof type 0x${type.toString(16).padStart(2, '0')}`);
}

/** abi.encode(uint64 blockNumber, bytes[] accountProof, bytes[] storageProof). */
export function encodeAbsenceProof(p: { blockNumber: bigint; accountProof: Hex[]; storageProof: Hex[] }): Hex {
  return encodeAbiParameters(STORAGE_PARAMS, [p.blockNumber, p.accountProof, p.storageProof]);
}

/**
 * Proof that the Outbox at `outbox` emitted `Committed(key, …)` in transaction `txHash`.
 * The block must be finalized on the ParliaClient before the proof is used.
 */
export async function buildCommitmentProof(
  client: BscClient,
  txHash: Hex,
  outbox: Address,
  key: Hex,
): Promise<{ blockNumber: bigint; proof: Hex; value: Hex }> {
  const want = getAddress(outbox);
  const p = await receiptProof(
    client,
    txHash,
    (l) => getAddress(l.address) === want && l.topics[0] === COMMITTED_TOPIC && l.topics[1]?.toLowerCase() === key.toLowerCase(),
  );
  return { blockNumber: p.blockNumber, proof: encodeCommitmentProof(p), value: p.log.data };
}

/** A storage proof of `commitments[key]` grabbed at the BSC head. */
export interface GrabbedSlotProof {
  blockNumber: bigint;
  timestamp: bigint;
  proof: Hex;
  /** The slot value at that block (zero when absent). */
  value: Hex;
}

/**
 * Grabs a proof that `commitments[key]` holds its value in the Outbox at the current BSC head:
 * the commitment proof that works from any block, for when the emitting block can no longer be
 * finalized. Public nodes only prove `latest`, so the caller holds it until `blockNumber` is
 * finalized. `value` is zero if nothing is committed under `key` yet.
 */
export async function grabCommitmentProof(client: BscClient, outbox: Address, key: Hex): Promise<GrabbedSlotProof> {
  const p = await grabStorageProof(client, outbox, [commitmentSlot(key)]);
  return {
    blockNumber: p.blockNumber,
    timestamp: p.timestamp,
    proof: encodeStorageCommitmentProof({ blockNumber: p.blockNumber, accountProof: p.accountProof, storageProof: p.slots[0].proof }),
    value: toHex(BigInt(p.slots[0].value), { size: 32 }),
  };
}

/**
 * Grabs a proof that `commitments[key]` is empty in the Outbox at the current BSC head.
 * Public nodes only prove `latest`, so the caller holds it until `blockNumber` is finalized.
 */
export async function grabAbsenceProof(
  client: BscClient,
  outbox: Address,
  key: Hex,
): Promise<{ blockNumber: bigint; timestamp: bigint; proof: Hex; empty: boolean }> {
  const p = await grabStorageProof(client, outbox, [commitmentSlot(key)]);
  return {
    blockNumber: p.blockNumber,
    timestamp: p.timestamp,
    proof: encodeAbsenceProof({ blockNumber: p.blockNumber, accountProof: p.accountProof, storageProof: p.slots[0].proof }),
    empty: BigInt(p.slots[0].value) === 0n,
  };
}
