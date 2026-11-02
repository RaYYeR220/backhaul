// Proof encodings for BscVerifier (IRemoteVerifier on Portaldot over Parlia-finalized BSC headers).

import { encodeAbiParameters, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import type { BscClient } from './client.js';
import { receiptProof } from './receipts.js';
import { grabStorageProof } from './storage.js';

/** Topic of `Committed(bytes32 indexed key, bytes32 value)`, emitted by the Outbox. */
export const COMMITTED_TOPIC = keccak256(toHex('Committed(bytes32,bytes32)'));

/** Storage slot of `commitments[key]` in the Outbox (mapping at slot 0). */
export function commitmentSlot(key: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [key, 0n]));
}

/** abi.encode(uint64 blockNumber, bytes receiptKey, bytes[] receiptProof, uint256 logIndex). */
export function encodeCommitmentProof(p: { blockNumber: bigint; key: Hex; proof: Hex[]; logIndex: number | bigint }): Hex {
  return encodeAbiParameters(
    [{ type: 'uint64' }, { type: 'bytes' }, { type: 'bytes[]' }, { type: 'uint256' }],
    [p.blockNumber, p.key, p.proof, BigInt(p.logIndex)],
  );
}

/** abi.encode(uint64 blockNumber, bytes[] accountProof, bytes[] storageProof). */
export function encodeAbsenceProof(p: { blockNumber: bigint; accountProof: Hex[]; storageProof: Hex[] }): Hex {
  return encodeAbiParameters(
    [{ type: 'uint64' }, { type: 'bytes[]' }, { type: 'bytes[]' }],
    [p.blockNumber, p.accountProof, p.storageProof],
  );
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
