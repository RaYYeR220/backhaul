// Cost model for the Portaldot side, calibrated against the live node.
//
// revive's eth_estimateGas returns gas that already covers the storage deposit, so a live estimate
// is exact for anything the node can dry-run. Calls into contracts that do not exist yet can't be
// dry-run, so those are priced from a model whose rates are themselves measured with live
// estimates of tiny probe transactions:
//   deploy  = deployBase + codeBytes·codeRate + newSlots·slotRate + initBytes·byteRate
//   call    = callBase   + calldataBytes·byteRate + newSlots·slotRate
// All figures are in wei-units (18 decimals) at the gas price of the moment.

import type { Address, Hex, PublicClient } from 'viem';

export interface PortaldotRates {
  gasPrice: bigint;
  deployBase: bigint;
  codeRate: bigint;
  slotRate: bigint;
  callBase: bigint;
  byteRate: bigint;
  /** Per byte of code that is already stored under the same hash (revive keeps code once per hash). */
  reuseCodeRate: bigint;
}

/** Init code whose constructor writes `slots` storage slots and returns `runtimeLen` bytes of code. */
export function probeInitcode(slots: number, runtimeLen: number): Hex {
  let ops = '';
  for (let i = 0; i < slots; i++) ops += `6001${'61'}${i.toString(16).padStart(4, '0')}55`; // SSTORE(i, 1)
  const tail = 15; // PUSH2 len, PUSH2 off, PUSH1 0, CODECOPY, PUSH2 len, PUSH1 0, RETURN
  const off = ops.length / 2 + tail;
  const l = runtimeLen.toString(16).padStart(4, '0');
  const o = off.toString(16).padStart(4, '0');
  return `0x${ops}61${l}61${o}600039${'61'}${l}6000f3${'00'.repeat(runtimeLen)}`;
}

/** Measures the model's rates with live eth_estimateGas calls from a funded account. */
/** Init code that returns `runtime` verbatim. */
export function wrapRuntime(runtime: Hex): Hex {
  const l = ((runtime.length - 2) / 2).toString(16).padStart(4, '0');
  return `0x61${l}61000f600039${'61'}${l}6000f3${runtime.slice(2)}`;
}

/**
 * Measures the model's rates with live eth_estimateGas calls from a funded account. `existing` is
 * any contract already on chain: deploying its exact runtime again prices reused code.
 */
export async function calibratePortaldot(pub: PublicClient, from: Address, eoa: Address, existing?: Address): Promise<PortaldotRates> {
  const gasPrice = await pub.getGasPrice();
  const est = async (p: { to?: Address; data: Hex }) => (await pub.estimateGas({ account: from, to: p.to, data: p.data, value: 0n })) * gasPrice;
  const base = await est({ data: probeInitcode(0, 1) });
  const code = await est({ data: probeInitcode(0, 1001) });
  const slot = await est({ data: probeInitcode(1, 1) });
  const callBase = await est({ to: eoa, data: '0x' });
  const call10k = await est({ to: eoa, data: `0x${'11'.repeat(10_000)}` });
  let reuseCodeRate = ((code - base) / 1000n) * 23n / 100n; // measured 2026-11-03: ~23% of a fresh upload
  if (existing) {
    const runtime = await pub.getCode({ address: existing });
    if (runtime && runtime !== '0x') {
      const again = await est({ data: wrapRuntime(runtime) });
      reuseCodeRate = (again - base) / BigInt((runtime.length - 2) / 2);
    }
  }
  return {
    reuseCodeRate,
    gasPrice,
    deployBase: base,
    codeRate: (code - base) / 1000n,
    slotRate: slot - base,
    callBase,
    byteRate: (call10k - callBase) / 10_000n,
  };
}

export interface ModelInput {
  kind: 'deploy' | 'call';
  /** The runtime code is already stored on chain under the same hash. */
  reused?: boolean;
  dataBytes: number;
  codeBytes: number;
  newSlots: number;
}

export function modelCost(r: PortaldotRates, x: ModelInput): bigint {
  const slots = BigInt(x.newSlots) * r.slotRate;
  const bytes = BigInt(x.dataBytes) * r.byteRate;
  if (x.kind === 'deploy') return r.deployBase + BigInt(x.codeBytes) * (x.reused ? r.reuseCodeRate : r.codeRate) + slots + bytes;
  return r.callBase + bytes + slots;
}

export const fmtUnits = (wei: bigint, decimals = 18, places = 4): string => {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const frac = ((v % unit) * 10n ** BigInt(places)) / unit;
  return `${neg ? '-' : ''}${whole}.${frac.toString().padStart(places, '0')}`;
};
