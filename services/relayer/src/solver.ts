// A fast-fill solver: pays an order's recipient on the destination chain from its own inventory
// right away, and is repaid from the origin escrow once the fill is proven there (the job
// runner settles it). It only takes same-asset routes, within its limits and at its spread.

import { encodeAbiParameters, getAddress, maxUint256, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { destinationSettlerAbi, erc20Abi, NATIVE_UNIT, type BackhaulAddresses, type ChainName } from '@backhaul/sdk';
import type { SolverLimits } from './config.js';
import type { OrderSolver, WriteResult } from './jobs.js';
import type { OrderJob } from './store.js';

export type Asset = 'tPOT' | 'tBNB' | 'pPOT' | 'BNB.b';

export interface SolverEnv {
  addrs: BackhaulAddresses;
  /** The solver's own address (the same key on both chains). */
  address: Address;
  now(): number;
  balanceOf(chain: ChainName, token: Address, who: Address): Promise<bigint>;
  nativeBalance(chain: ChainName, who: Address): Promise<bigint>;
  allowance(chain: ChainName, token: Address, owner: Address, spender: Address): Promise<bigint>;
  write(chain: ChainName, to: Address, abi: Abi, fn: string, args: readonly unknown[], value?: bigint): Promise<WriteResult>;
  sendNative(chain: ChainName, to: Address, value: bigint): Promise<WriteResult>;
  log(m: string): void;
}

/** Which asset a token address is on a chain, if it is one the bridge carries. */
export function assetOf(addrs: BackhaulAddresses, chain: ChainName, token: Address): Asset | undefined {
  const t = getAddress(token);
  if (chain === 'portaldot') {
    if (t === zeroAddress) return 'tPOT';
    if (addrs.portaldot.bnbb && t === getAddress(addrs.portaldot.bnbb)) return 'BNB.b';
  } else {
    if (t === zeroAddress) return 'tBNB';
    if (addrs.bsc.PPOT && t === getAddress(addrs.bsc.PPOT)) return 'pPOT';
  }
  return undefined;
}

/** The asset that pays for `out` on the other side of a same-asset route. */
const PAIR: Record<Asset, Asset> = { pPOT: 'tPOT', tPOT: 'pPOT', 'BNB.b': 'tBNB', tBNB: 'BNB.b' };

export class Solver implements OrderSolver {
  constructor(
    readonly env: SolverEnv,
    readonly limits: SolverLimits,
  ) {}

  /** Why the solver will not fill `job`, or undefined if it will. */
  async check(job: OrderJob): Promise<string | undefined> {
    const out = assetOf(this.env.addrs, job.dest, job.outputToken);
    const inp = assetOf(this.env.addrs, job.origin, job.inputToken);
    if (!out || !inp) return 'not a bridged asset';
    if (PAIR[out] !== inp) return `cross-asset route ${inp} → ${out}`;
    const amount = BigInt(job.outputAmount);
    if (amount > this.limits.maxOutput[out]) return `above the ${out} limit`;
    if (BigInt(job.inputAmount) * 10_000n < amount * (10_000n + BigInt(this.limits.minFeeBps))) return `spread below ${this.limits.minFeeBps} bps`;
    if (job.fillDeadline - this.env.now() < this.limits.minDeadlineLeft) return 'deadline too close';
    if (out === 'tPOT' && amount % NATIVE_UNIT !== 0n) return 'tPOT amount below planck precision';
    const have = out === 'tPOT' || out === 'tBNB'
      ? await this.env.nativeBalance(job.dest, this.env.address)
      : await this.env.balanceOf(job.dest, job.outputToken, this.env.address);
    if (have < amount) return `not enough ${out} inventory`;
    return undefined;
  }

  async consider(job: OrderJob): Promise<{ filled: boolean; reason: string; tx?: Hex }> {
    const why = await this.check(job);
    if (why) return { filled: false, reason: why };
    const out = assetOf(this.env.addrs, job.dest, job.outputToken)!;
    const amount = BigInt(job.outputAmount);
    const dst = job.dest === 'portaldot' ? this.env.addrs.portaldot.DestinationSettler! : this.env.addrs.bsc.DestinationSettler!;

    if (out === 'BNB.b') {
      // BNB.b is a non-sufficient asset: a recipient with no tPOT can't receive it at all.
      if ((await this.env.nativeBalance('portaldot', job.recipient)) === 0n) {
        const pre = this.limits.prefund - (this.limits.prefund % NATIVE_UNIT);
        const r = await this.env.sendNative('portaldot', job.recipient, pre);
        this.env.log(`solver: pre-funded ${job.recipient} with ${pre} for BNB.b (${r.hash})`);
      }
    }
    if (out === 'BNB.b' || out === 'pPOT') {
      if ((await this.env.allowance(job.dest, job.outputToken, this.env.address, dst)) < amount) {
        await this.env.write(job.dest, job.outputToken, erc20Abi as unknown as Abi, 'approve', [dst, maxUint256]);
      }
    }
    const repay = encodeAbiParameters([{ type: 'address' }], [this.env.address]);
    const value = out === 'tPOT' || out === 'tBNB' ? amount : 0n;
    const r = await this.env.write(job.dest, dst, destinationSettlerAbi as unknown as Abi, 'fill', [job.orderId, job.originData, repay], value);
    this.env.log(`solver: filled ${job.orderId} on ${job.dest} (${r.hash})`);
    return { filled: true, reason: `fronted ${amount} ${out}`, tx: r.hash };
  }
}
