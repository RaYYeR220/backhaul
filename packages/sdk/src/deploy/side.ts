// One chain's half of a deployment: deploys, calls and transfers that resume from
// deployments/<chain>.json and, with a nonce plan, only ever send at their reserved nonce.

import { encodeDeployData, encodeFunctionData, getAddress, keccak256, type Abi, type Address, type Hex } from 'viem';
import { loadArtifact, runtimeSize } from '../artifacts.js';
import type { ChainName } from '../chains.js';
import { saveDeployment, type Deployment } from '../deployments.js';
import type { SendResult, TxSender } from '../evm.js';
import { stateDiff } from './anvil.js';
import { checkNonce, NonceMismatch, reservationOf, type NoncePlan, type Phase, type Reservation } from './nonces.js';

export interface TxLog {
  chain: ChainName;
  phase: Phase;
  step: string;
  kind: 'deploy' | 'call' | 'transfer';
  hash: Hex;
  to?: Address;
  data: Hex;
  value: bigint;
  gasUsed: bigint;
  gasPrice: bigint;
  codeBytes: number;
  /** keccak256 of the runtime code a deploy left on a local node (revive stores code once per hash). */
  runtimeHash?: Hex;
  /** Storage slots created (local nodes only, from the prestate diff). */
  newSlots?: number;
  /** Constructor depends on contracts that only exist in this run (no live dry-run possible). */
  dependsOnLocal?: boolean;
}

/** Thrown when a step needs the other chain, which this run does not deploy. */
export class NeedsOtherChain extends Error {}

export interface SideOptions {
  trace?: boolean;
  log?: (m: string) => void;
  /** forge out dir to deploy from */
  artifactsDir?: string;
}

export class Side {
  readonly txs: TxLog[] = [];
  /** The deployer's reserved nonces on this chain; every send must match its reservation. */
  plan?: NoncePlan;
  /** Refuse any send that is not in the plan (Portaldot, where addresses are predicted). */
  strict = false;
  /** Phase the current steps belong to (for the cost report). */
  phase: Phase = 'A';

  constructor(
    readonly name: ChainName,
    readonly dep: Deployment,
    readonly dir: string,
    /** Undefined when this run does not touch this chain (it only reads the file). */
    readonly sender: TxSender | undefined,
    readonly opts: SideOptions = {},
  ) {}

  get active(): boolean {
    return this.sender !== undefined;
  }

  private log(m: string) {
    (this.opts.log ?? console.log)(`[${this.name}] ${m}`);
  }

  has(key: string): boolean {
    return this.dep.contracts[key] !== undefined;
  }

  addr(key: string): Address {
    const c = this.dep.contracts[key];
    if (!c) throw new NeedsOtherChain(`${this.name} has no ${key} yet`);
    return getAddress(c.address);
  }

  save(): void {
    saveDeployment(this.dep, this.dir);
  }

  private need(): TxSender {
    if (!this.sender) throw new NeedsOtherChain(`${this.name} is not part of this run`);
    return this.sender;
  }

  /** The reservation for `step`, after checking the deployer is exactly at its nonce. */
  private async guard(step: string): Promise<Reservation | undefined> {
    const s = this.need();
    if (!this.plan) {
      if (this.strict) throw new NonceMismatch(`${this.name}: no nonce plan; refusing to send ${step}`);
      return undefined;
    }
    if (!reservationOf(this.plan, step) && !this.strict) return undefined;
    if (getAddress(this.plan.deployer) !== getAddress(s.address)) {
      throw new NonceMismatch(`${this.name}: the plan is for ${this.plan.deployer}, this run sends from ${s.address}`);
    }
    const current = await s.pub.getTransactionCount({ address: s.address, blockTag: 'pending' });
    return checkNonce(this.plan, step, current);
  }

  private async record(step: string, kind: TxLog['kind'], r: SendResult, data: Hex, value: bigint, to?: Address, codeBytes = 0, dependsOnLocal = false) {
    const log: TxLog = {
      chain: this.name,
      phase: this.phase,
      step,
      kind,
      hash: r.hash,
      to,
      data,
      value,
      gasUsed: r.receipt.gasUsed,
      gasPrice: r.gasPrice,
      codeBytes,
      dependsOnLocal,
    };
    if (this.opts.trace) {
      log.newSlots = (await stateDiff(this.need().pub, r.hash)).newSlots;
      if (kind === 'deploy' && r.receipt.contractAddress) {
        const code = await this.need().pub.getCode({ address: r.receipt.contractAddress });
        if (code) log.runtimeHash = keccak256(code);
      }
    }
    this.txs.push(log);
  }

  /**
   * Deploys `artifact` as `key` unless the file already has it (and the code is really there).
   * `args` may be a function, so expensive constructor inputs (checkpoints) are only built when needed.
   * With a nonce plan the deploy must land at its reserved address; a deploy that landed before a
   * crash (code at the reserved address, nonce already past it) is adopted instead of repeated.
   */
  async deploy(
    key: string,
    artifact: string,
    args: readonly unknown[] | (() => Promise<readonly unknown[]>),
    opts: { value?: bigint; dependsOnLocal?: boolean; meta?: Record<string, unknown> } = {},
  ): Promise<Address> {
    const existing = this.dep.contracts[key];
    if (existing) {
      if (this.sender) {
        const code = await this.sender.pub.getCode({ address: existing.address });
        if (!code || code === '0x') throw new Error(`${this.name}.${key} at ${existing.address} has no code; stale deployments file?`);
      }
      return getAddress(existing.address);
    }
    const s = this.need();
    const a = loadArtifact(artifact, this.opts.artifactsDir);
    const step = `deploy ${key}`;
    const planned = reservationOf(this.plan, step);
    if (planned?.address) {
      const code = await s.pub.getCode({ address: planned.address });
      const nonce = await s.pub.getTransactionCount({ address: s.address, blockTag: 'pending' });
      if (code && code !== '0x' && nonce > planned.nonce) {
        this.dep.contracts[key] = { artifact, address: planned.address, codeBytes: runtimeSize(a), args: typeof args === 'function' ? undefined : (args as unknown[]) };
        this.save();
        this.log(`${key} found at its reserved address ${planned.address}; adopting it`);
        return planned.address;
      }
    }
    const resolved = typeof args === 'function' ? await args() : args;
    const data = encodeDeployData({ abi: a.abi as Abi, bytecode: a.bytecode, args: resolved as unknown[] });
    const r0 = await this.guard(step);
    this.log(`deploying ${key} (${artifact}, ${runtimeSize(a)} B runtime)${r0 ? ` at nonce ${r0.nonce} → ${r0.address}` : ''}`);
    const r = await s.send({ data, value: opts.value, label: step, nonce: r0?.nonce });
    const address = r.receipt.contractAddress;
    if (!address) throw new Error(`deploy ${key}: receipt has no contract address (${r.hash})`);
    if (r0?.address && getAddress(address) !== r0.address) {
      throw new NonceMismatch(`deploy ${key} landed at ${address}, the plan reserved ${r0.address}`);
    }
    this.dep.contracts[key] = {
      artifact,
      address: getAddress(address),
      tx: r.hash,
      block: Number(r.receipt.blockNumber),
      args: resolved as unknown[],
      codeBytes: runtimeSize(a),
    };
    if (opts.meta) Object.assign(this.dep.meta, opts.meta);
    this.dep.deployer ??= s.address;
    this.save();
    await this.record(step, 'deploy', r, data, opts.value ?? 0n, undefined, runtimeSize(a), opts.dependsOnLocal);
    this.log(`${key} = ${address} (${r.hash})`);
    return getAddress(address);
  }

  /**
   * Runs a call step once. `done` checks the chain (preferred) so a step that landed but was not
   * recorded is not repeated; otherwise the file's step record decides.
   */
  async call(
    id: string,
    to: Address,
    abi: Abi,
    fn: string,
    args: readonly unknown[],
    opts: { value?: bigint; done?: () => Promise<boolean> } = {},
  ): Promise<void> {
    if (this.dep.steps[id]) return;
    const s = this.need();
    if (opts.done && (await opts.done())) {
      this.dep.steps[id] = { at: new Date().toISOString(), note: 'found done on chain' };
      this.save();
      return;
    }
    const r0 = await this.guard(id);
    this.log(`${id}${r0 ? ` at nonce ${r0.nonce}` : ''}`);
    const data = encodeFunctionData({ abi, functionName: fn, args });
    const r = await s.send({ to, data, value: opts.value, label: id, nonce: r0?.nonce });
    this.dep.steps[id] = { tx: r.hash, block: Number(r.receipt.blockNumber), at: new Date().toISOString() };
    this.save();
    await this.record(id, 'call', r, data, opts.value ?? 0n, to);
  }

  /** Sends native value from the deployer once (e.g. funding the relayer's own key). */
  async transfer(id: string, to: Address, value: bigint): Promise<void> {
    if (this.dep.steps[id]) return;
    const s = this.need();
    const r0 = await this.guard(id);
    this.log(`${id}: ${value} to ${to}${r0 ? ` at nonce ${r0.nonce}` : ''}`);
    const r = await s.send({ to, data: '0x', value, label: id, nonce: r0?.nonce });
    this.dep.steps[id] = { tx: r.hash, block: Number(r.receipt.blockNumber), at: new Date().toISOString(), to, value: value.toString() };
    this.save();
    await this.record(id, 'transfer', r, '0x', value, to);
  }

  /** Records a step that ran outside the EVM sender (substrate extrinsics, local setup). */
  mark(id: string, record: Record<string, unknown>): void {
    this.dep.steps[id] = { at: new Date().toISOString(), ...record };
    this.save();
  }
}
