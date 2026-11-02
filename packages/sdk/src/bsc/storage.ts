// Account and storage proofs on BSC.
//
// Public BSC testnet nodes answer eth_getProof only at `latest` ("distance to target block exceeds
// maximum proof window" for anything older), so a proof is grabbed at the head and pinned to its
// block by matching the account proof's root against recent headers' stateRoot. The caller then
// holds it until that block can be finalized on the other chain.

import { keccak256, type Address, type Hex } from 'viem';
import type { BscClient, RpcBlock, RpcProof } from './client.js';

export interface StorageProof {
  blockNumber: bigint;
  blockHash: Hex;
  stateRoot: Hex;
  timestamp: bigint;
  account: Address;
  accountProof: Hex[];
  storageRoot: Hex;
  slots: { slot: Hex; value: Hex; proof: Hex[] }[];
}

export interface GrabOptions {
  /** How many blocks below the head to scan for the matching stateRoot. */
  lookback?: number;
  /** Attempts before giving up (the head can move while the batch is served). */
  attempts?: number;
}

export interface ProofRequest {
  account: Address;
  slots: Hex[];
}

/** Grabs an account + storage proof at `latest` and identifies the block it belongs to. */
export async function grabStorageProof(
  client: BscClient,
  account: Address,
  slots: Hex[],
  opts: GrabOptions = {},
): Promise<StorageProof> {
  const [proof] = await grabStorageProofs(client, [{ account, slots }], opts);
  return proof;
}

/**
 * Grabs proofs for several accounts in one batch, all pinned to the same block.
 * Retries when the node served them from different heads.
 */
export async function grabStorageProofs(
  client: BscClient,
  requests: ProofRequest[],
  opts: GrabOptions = {},
): Promise<StorageProof[]> {
  if (requests.length === 0) throw new Error('nothing to prove');
  const lookback = opts.lookback ?? 8;
  const attempts = opts.attempts ?? 4;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const calls = [
      ...requests.map((r) => ['eth_getProof', [r.account, r.slots, 'latest']] as const),
      ['eth_getBlockByNumber', ['latest', false]] as const,
    ];
    const res = await client.batch<unknown[]>(calls);
    const proofs = res.slice(0, requests.length) as RpcProof[];
    const head = res[requests.length] as RpcBlock;
    const root = stateRootOf(proofs[0]);
    if (proofs.some((p) => stateRootOf(p) !== root)) continue;
    const block = await findBlockByStateRoot(client, head, root, lookback);
    if (block) return proofs.map((p, i) => toStorageProof(p, block, requests[i]));
  }
  throw new Error('could not pin the eth_getProof results to a single block');
}

/** The state root an account proof hangs from: keccak256 of its first node. */
export function stateRootOf(proof: RpcProof): Hex {
  if (proof.accountProof.length === 0) throw new Error('empty account proof');
  return keccak256(proof.accountProof[0]);
}

async function findBlockByStateRoot(
  client: BscClient,
  head: RpcBlock,
  stateRoot: Hex,
  lookback: number,
): Promise<RpcBlock | undefined> {
  if (head.stateRoot.toLowerCase() === stateRoot) return head;
  const headNumber = BigInt(head.number);
  // The proof may come from a block just after the reported head.
  for (const candidate of [headNumber + 1n, headNumber + 2n]) {
    try {
      const b = await client.block(candidate);
      if (b.stateRoot.toLowerCase() === stateRoot) return b;
    } catch {
      // not produced yet
    }
  }
  const older = await client.blocks(headNumber - BigInt(lookback), lookback);
  return older.find((b) => b.stateRoot.toLowerCase() === stateRoot);
}

function toStorageProof(proof: RpcProof, block: RpcBlock, req: ProofRequest): StorageProof {
  return {
    blockNumber: BigInt(block.number),
    blockHash: block.hash,
    stateRoot: block.stateRoot,
    timestamp: BigInt(block.timestamp),
    account: req.account,
    accountProof: proof.accountProof,
    storageRoot: proof.storageHash,
    slots: req.slots.map((slot, i) => ({
      slot,
      value: proof.storageProof[i].value,
      proof: proof.storageProof[i].proof,
    })),
  };
}
