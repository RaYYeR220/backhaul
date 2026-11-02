// Trusted checkpoints for the Parlia light client.

import { getAddress, type Address } from 'viem';
import type { BscClient } from './client.js';
import { parseEpochExtra, switchOffset } from './header.js';

/** Trusted epoch state, in the shape the ParliaClient constructor takes. */
export interface ParliaCheckpoint {
  /** Epoch block number (multiple of the epoch length). */
  epoch: bigint;
  /** Timestamp (seconds) of the epoch block; the trusting period counts from here. */
  timestamp: bigint;
  /** First height sealed by `validators`. */
  activeFrom: bigint;
  turnLength: number;
  validators: Address[];
}

/**
 * Reads the checkpoint for epoch block `epoch` from a node and cross-checks it against
 * `parlia_getSnapshot` on both sides of the switch.
 */
export async function checkpointAt(client: BscClient, epoch: bigint, epochLength = 1000n): Promise<ParliaCheckpoint> {
  if (epoch % epochLength !== 0n) throw new Error(`${epoch} is not an epoch block`);
  const block = await client.block(epoch);
  const { validators, turnLength } = parseEpochExtra(block.extraData);
  // The switch is decided by the set in force at the epoch block (the one about to be replaced).
  const before = await client.snapshot(epoch);
  const activeFrom = epoch + BigInt(switchOffset(Object.keys(before.validators).length, before.turn_length));
  const after = await client.snapshot(activeFrom - 1n);
  const live = Object.keys(after.validators).map((a) => getAddress(a)).sort();
  const announced = [...validators].sort();
  if (live.join() !== announced.join() || after.turn_length !== turnLength) {
    throw new Error(`snapshot at ${activeFrom - 1n} does not hold the set announced at ${epoch}`);
  }
  return { epoch, timestamp: BigInt(block.timestamp), activeFrom, turnLength, validators };
}
