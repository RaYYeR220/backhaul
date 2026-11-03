// One chain's half of a deployment: deploys and calls that resume from deployments/<chain>.json.

import { encodeDeployData, encodeFunctionData, getAddress, type Abi, type Address, type Hex } from 'viem';
import { loadArtifact, runtimeSize } from '../artifacts.js';
import type { ChainName } from '../chains.js';
import { saveDeployment, type Deployment } from '../deployments.js';
import type { SendResult, TxSender } from '../evm.js';
import { stateDiff } from './anvil.js';

export interface TxLog {
  chain: ChainName;
  step: string;
  kind: 'deploy' | 'call';
  hash: Hex;
  to?: Address;
  data: Hex;
  value: bigint;
  gasUsed: bigint;
  gasPrice: bigint;
  codeBytes: number;
  /** Storage slots created (local nodes only, from the prestate diff). */
  newSlots?: number;
  /** Constructor depends on contracts that only exist in this run (no live dry-run possible). */
  dependsOnLocal?: boolean;
}

/** Thrown when a step needs the other chain, which this run does not deploy. */
export class NeedsOtherChain extends Error {}

export class Side {
  readonly txs: TxLog[] = [];

  constructor(
    readonly name: ChainName,
    readonly dep: Deployment,
    readonly dir: string,
    /** Undefined when this run does not touch this chain (it only reads the file). */
    readonly sender: TxSender | undefined,
    readonly opts: { trace?: boolean; log?: (m: string) => void } = {},
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

  private async record(step: string, kind: TxLog['kind'], r: SendResult, data: Hex, value: bigint, to?: Address, codeBytes = 0, dependsOnLocal = false) {
    const log: TxLog = {
      chain: this.name,
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
    if (this.opts.trace) log.newSlots = (await stateDiff(this.need().pub, r.hash)).newSlots;
    this.txs.push(log);
  }

  /**
   * Deploys `artifact` as `key` unless the file already has it (and the code is really there).
   * `args` may be a function, so expensive constructor inputs (checkpoints) are only built when needed.
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
    const a = loadArtifact(artifact);
    const resolved = typeof args === 'function' ? await args() : args;
    const data = encodeDeployData({ abi: a.abi as Abi, bytecode: a.bytecode, args: resolved as unknown[] });
    this.log(`deploying ${key} (${artifact}, ${runtimeSize(a)} B runtime)`);
    const r = await s.send({ data, value: opts.value, label: `deploy ${key}` });
    const address = r.receipt.contractAddress;
    if (!address) throw new Error(`deploy ${key}: receipt has no contract address (${r.hash})`);
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
    await this.record(`deploy ${key}`, 'deploy', r, data, opts.value ?? 0n, undefined, runtimeSize(a), opts.dependsOnLocal);
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
    this.log(`${id}`);
    const r = await s.write(to, abi, fn, args, opts.value, id);
    this.dep.steps[id] = { tx: r.hash, block: Number(r.receipt.blockNumber), at: new Date().toISOString() };
    this.save();
    await this.record(id, 'call', r, encodeFunctionData({ abi, functionName: fn, args }), opts.value ?? 0n, to);
  }

  /** Records a step that ran outside the EVM sender (substrate extrinsics, local setup). */
  mark(id: string, record: Record<string, unknown>): void {
    this.dep.steps[id] = { at: new Date().toISOString(), ...record };
    this.save();
  }
}
