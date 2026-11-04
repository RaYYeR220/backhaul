// Nonce plans: the deployer's transactions on a chain, in a fixed order, from a known starting nonce,
// so every contract address is known before anything is sent. The phased deploy relies on it:
// PortaldotGateway (phase A) is built with the address BscVerifier will get in phase B, so between
// the phases nothing else may send from the deployer key on Portaldot.

import { getAddress, getContractAddress, type Address } from 'viem';
import type { ChainName } from '../chains.js';

export type Phase = 'A' | 'B';

export interface PlannedTx {
  /** Step id, the same key deployments/<chain>.json records the step under. */
  step: string;
  phase: Phase;
  kind: 'deploy' | 'call' | 'transfer';
  /** Contract key for deploys. */
  contract?: string;
}

export interface Reservation {
  nonce: number;
  phase: Phase;
  step: string;
  kind: PlannedTx['kind'];
  /** Contract key and its CREATE address, for deploys. */
  name?: string;
  address?: Address;
}

export interface NoncePlan {
  chain: ChainName;
  deployer: Address;
  startNonce: number;
  reserved: Reservation[];
}

/** CREATE addresses for `txs` sent in order from `deployer` starting at `startNonce`. */
export function planNonces(chain: ChainName, deployer: Address, startNonce: number, txs: PlannedTx[]): NoncePlan {
  if (!Number.isInteger(startNonce) || startNonce < 0) throw new RangeError(`bad start nonce ${startNonce}`);
  const seen = new Set<string>();
  const reserved = txs.map((t, i): Reservation => {
    if (seen.has(t.step)) throw new Error(`step ${t.step} appears twice in the plan`);
    seen.add(t.step);
    const nonce = startNonce + i;
    const r: Reservation = { nonce, phase: t.phase, step: t.step, kind: t.kind };
    if (t.kind === 'deploy') {
      if (!t.contract) throw new Error(`deploy step ${t.step} has no contract name`);
      r.name = t.contract;
      r.address = getContractAddress({ from: getAddress(deployer), nonce: BigInt(nonce) });
    }
    return r;
  });
  return { chain, deployer: getAddress(deployer), startNonce, reserved };
}

/** Appends `txs` to a plan, numbered from the plan's next nonce or from `fromNonce` if later. */
export function extendPlan(plan: NoncePlan, txs: PlannedTx[], fromNonce?: number): NoncePlan {
  const next = plan.reserved.length ? plan.reserved[plan.reserved.length - 1].nonce + 1 : plan.startNonce;
  const start = fromNonce !== undefined && fromNonce > next ? fromNonce : next;
  const more = planNonces(plan.chain, plan.deployer, start, txs).reserved;
  const steps = new Set(plan.reserved.map((r) => r.step));
  for (const r of more) if (steps.has(r.step)) throw new Error(`step ${r.step} is already reserved`);
  return { ...plan, reserved: [...plan.reserved, ...more] };
}

export function reservationOf(plan: NoncePlan | undefined, step: string): Reservation | undefined {
  return plan?.reserved.find((r) => r.step === step);
}

/** The address reserved for contract `name`. */
export function plannedAddress(plan: NoncePlan | undefined, name: string): Address | undefined {
  return plan?.reserved.find((r) => r.kind === 'deploy' && r.name === name)?.address;
}

export class NonceMismatch extends Error {
  /** True when the account is behind the reservation: an earlier planned step has not run yet. */
  constructor(message: string, readonly behind = false) {
    super(message);
  }
}

/**
 * Throws unless the account's next nonce is the one reserved for `step`. A stray transaction from
 * the deployer between the reservation and now would move every later address.
 */
export function checkNonce(plan: NoncePlan, step: string, current: number): Reservation {
  const r = reservationOf(plan, step);
  if (!r) throw new NonceMismatch(`${plan.chain}: step ${step} is not in the nonce plan; the deployer may only send planned transactions`);
  if (current !== r.nonce) {
    const why = current > r.nonce ? 'something else was sent from the deployer key' : 'an earlier planned transaction is missing';
    throw new NonceMismatch(`${plan.chain}: ${step} is planned at nonce ${r.nonce} but the deployer is at ${current} (${why}); aborting before the addresses drift`, current < r.nonce);
  }
  return r;
}

export function formatPlan(plan: NoncePlan): string[] {
  return plan.reserved.map((r) => `  ${plan.chain.padEnd(9)} ${r.phase}  nonce ${String(r.nonce).padStart(3)}  ${r.step.padEnd(42)} ${r.address ?? ''}`);
}
