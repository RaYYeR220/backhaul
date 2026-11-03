import { describe, expect, it } from 'vitest';
import { keccak256, maxUint256, parseEther, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import type { ChainName } from '@backhaul/sdk';
import { loadConfig } from '../src/config.js';
import { assetOf, Solver, type SolverEnv } from '../src/solver.js';
import type { OrderJob } from '../src/store.js';
import { A, ADDRS, originData } from './helpers.js';

const limits = loadConfig({ RELAYER_PK: `0x${'11'.repeat(32)}` }).solver;
const ME = A(0x5017);

class FakeSolverEnv implements SolverEnv {
  addrs = ADDRS;
  address = ME;
  clock = 1_800_000_000;
  native = new Map<string, bigint>();
  tokens = new Map<string, bigint>();
  allowances = new Map<string, bigint>();
  calls: { chain: ChainName; to: Address; fn: string; args: readonly unknown[]; value?: bigint }[] = [];
  now() {
    return this.clock;
  }
  async balanceOf(chain: ChainName, token: Address, who: Address) {
    return this.tokens.get(`${chain}:${token}:${who}`) ?? 0n;
  }
  async nativeBalance(chain: ChainName, who: Address) {
    return this.native.get(`${chain}:${who}`) ?? 0n;
  }
  async allowance(chain: ChainName, token: Address, owner: Address, spender: Address) {
    return this.allowances.get(`${chain}:${token}:${owner}:${spender}`) ?? 0n;
  }
  async write(chain: ChainName, to: Address, _abi: Abi, fn: string, args: readonly unknown[], value?: bigint) {
    this.calls.push({ chain, to, fn, args, value });
    return { hash: `0x${'ee'.repeat(32)}` as Hex, block: 1n };
  }
  async sendNative(chain: ChainName, to: Address, value: bigint) {
    this.calls.push({ chain, to, fn: '(native)', args: [], value });
    return { hash: `0x${'dd'.repeat(32)}` as Hex, block: 1n };
  }
  log() {}
}

function job(env: FakeSolverEnv, o: { origin: ChainName; inputToken: Address; outputToken: Address; inputAmount: bigint; outputAmount: bigint; deadline?: number; recipient?: Address }): OrderJob {
  const dest: ChainName = o.origin === 'portaldot' ? 'bsc' : 'portaldot';
  const d = originData({
    user: A(1),
    inputToken: o.inputToken,
    inputAmount: o.inputAmount,
    outputToken: o.outputToken,
    outputAmount: o.outputAmount,
    recipient: o.recipient ?? A(0xbee),
    destinationChainId: dest === 'bsc' ? 97n : 420420777n,
    nonce: 1n,
    originChainId: o.origin === 'bsc' ? 97n : 420420777n,
    fillDeadline: o.deadline ?? env.clock + 600,
  });
  return {
    id: keccak256(d),
    type: 'order',
    origin: o.origin,
    dest,
    orderId: keccak256(d),
    originData: d,
    user: A(1),
    inputToken: o.inputToken,
    inputAmount: o.inputAmount.toString(),
    outputToken: o.outputToken,
    outputAmount: o.outputAmount.toString(),
    recipient: o.recipient ?? A(0xbee),
    fillDeadline: o.deadline ?? env.clock + 600,
    openTx: `0x${'00'.repeat(32)}`,
    openBlock: '1',
    state: 'open',
    createdAt: '',
    updatedAt: '',
    steps: [],
    attempts: 0,
  };
}

const bnbb = ADDRS.portaldot.bnbb!;
const ppot = ADDRS.bsc.PPOT!;

describe('solver', () => {
  it('maps tokens to bridged assets', () => {
    expect(assetOf(ADDRS, 'portaldot', zeroAddress)).toBe('tPOT');
    expect(assetOf(ADDRS, 'portaldot', bnbb)).toBe('BNB.b');
    expect(assetOf(ADDRS, 'bsc', ppot)).toBe('pPOT');
    expect(assetOf(ADDRS, 'bsc', A(9))).toBeUndefined();
  });

  it('passes on anything outside its rules', async () => {
    const env = new FakeSolverEnv();
    const s = new Solver(env, limits);
    env.tokens.set(`bsc:${ppot}:${ME}`, parseEther('1000'));
    const base = { origin: 'portaldot' as const, inputToken: zeroAddress, outputToken: ppot, inputAmount: parseEther('10'), outputAmount: parseEther('9.97') };
    expect(await s.check(job(env, base))).toBeUndefined();
    expect(await s.check(job(env, { ...base, outputToken: zeroAddress }))).toMatch(/cross-asset/);
    expect(await s.check(job(env, { ...base, inputAmount: parseEther('100'), outputAmount: parseEther('99') }))).toMatch(/limit/);
    expect(await s.check(job(env, { ...base, outputAmount: parseEther('9.99') }))).toMatch(/spread/);
    expect(await s.check(job(env, { ...base, deadline: env.clock + 30 }))).toMatch(/deadline/);
    env.tokens.set(`bsc:${ppot}:${ME}`, parseEther('5'));
    expect(await s.check(job(env, base))).toMatch(/inventory/);
  });

  it('rejects native tPOT amounts finer than a planck', async () => {
    const env = new FakeSolverEnv();
    env.native.set(`portaldot:${ME}`, parseEther('100'));
    const s = new Solver(env, limits);
    const j = job(env, { origin: 'bsc', inputToken: ppot, outputToken: zeroAddress, inputAmount: parseEther('10'), outputAmount: parseEther('9.9') + 1n });
    expect(await s.check(j)).toMatch(/planck/);
  });

  it('fills native tPOT with value and repays itself', async () => {
    const env = new FakeSolverEnv();
    env.native.set(`portaldot:${ME}`, parseEther('100'));
    const s = new Solver(env, limits);
    const j = job(env, { origin: 'bsc', inputToken: ppot, outputToken: zeroAddress, inputAmount: parseEther('10'), outputAmount: parseEther('9.97') });
    const r = await s.consider(j);
    expect(r.filled).toBe(true);
    const fill = env.calls[0];
    expect([fill.chain, fill.to, fill.fn, fill.value]).toEqual(['portaldot', ADDRS.portaldot.DestinationSettler, 'fill', parseEther('9.97')]);
    expect(fill.args[2]).toBe(`0x${'0'.repeat(24)}${ME.slice(2).toLowerCase()}`);
  });

  it('pre-funds a fresh BNB.b recipient, approves once, then fills', async () => {
    const env = new FakeSolverEnv();
    env.tokens.set(`portaldot:${bnbb}:${ME}`, parseEther('1'));
    const s = new Solver(env, limits);
    const fresh = A(0xf00d);
    const j = job(env, { origin: 'bsc', inputToken: zeroAddress, outputToken: bnbb, inputAmount: parseEther('0.01'), outputAmount: parseEther('0.00997'), recipient: fresh });
    await s.consider(j);
    expect(env.calls.map((c) => c.fn)).toEqual(['(native)', 'approve', 'fill']);
    expect(env.calls[0]).toMatchObject({ to: fresh, value: limits.prefund });
    expect(env.calls[1].args).toEqual([ADDRS.portaldot.DestinationSettler, maxUint256]);
    expect(env.calls[2].value).toBe(0n);

    // a recipient that already holds tPOT gets no drop; a standing approval is reused
    env.calls = [];
    env.native.set(`portaldot:${fresh}`, 1n);
    env.allowances.set(`portaldot:${bnbb}:${ME}:${ADDRS.portaldot.DestinationSettler}`, maxUint256);
    await s.consider(j);
    expect(env.calls.map((c) => c.fn)).toEqual(['fill']);
  });
});
