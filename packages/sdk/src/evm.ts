// viem plumbing shared by the deploy script and the relayer: one serialized sender per chain
// (no nonce races between loops), legacy-priced transactions with the node's own gas estimate.
//
// On Portaldot, eth_estimateGas already includes the storage deposit, so the estimate is the only
// trustworthy gas figure: never simulate locally.

import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  BaseError,
  ContractFunctionRevertedError,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { backhaulErrorsAbi } from './abi.js';
import { bscTestnet, portaldotTestnet, type ChainName } from './chains.js';

export interface SendResult {
  hash: Hex;
  receipt: TransactionReceipt;
  gas: bigint;
  gasPrice: bigint;
}

export interface TxRequest {
  to?: Address;
  data: Hex;
  value?: bigint;
  /** Exact nonce to send at (planned deploys); default: the account's next one. */
  nonce?: number;
  /** Label for logs and errors. */
  label?: string;
}

export interface SenderOptions {
  /** Multiplier on eth_estimateGas, in percent (default 110). */
  gasBufferPct?: bigint;
  /** Fixed gas price; default is eth_gasPrice at send time. */
  gasPrice?: bigint;
  /** Receipt wait timeout in ms. */
  timeoutMs?: number;
}

export class TxSender {
  private queue: Promise<unknown> = Promise.resolve();
  readonly address: Address;

  constructor(
    readonly chain: ChainName,
    readonly pub: PublicClient,
    readonly wallet: WalletClient,
    readonly account: Account | Address,
    private readonly opts: SenderOptions = {},
  ) {
    this.address = typeof account === 'string' ? account : account.address;
  }

  /** Estimates, sends and waits for the receipt; throws if the tx reverted. Serialized per sender. */
  send(req: TxRequest): Promise<SendResult> {
    const run = this.queue.then(() => this.sendNow(req));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async estimate(req: TxRequest, from: Address = this.address): Promise<bigint> {
    try {
      return await this.pub.estimateGas({ account: from, to: req.to, data: req.data, value: req.value ?? 0n });
    } catch (e) {
      throw new Error(`${req.label ?? 'tx'}: estimate failed: ${revertReason(e)}`);
    }
  }

  private async sendNow(req: TxRequest): Promise<SendResult> {
    const est = await this.estimate(req);
    const gas = (est * (this.opts.gasBufferPct ?? 110n)) / 100n;
    const gasPrice = this.opts.gasPrice ?? (await this.pub.getGasPrice());
    const hash = await this.wallet.sendTransaction({
      account: this.account,
      chain: this.wallet.chain,
      to: req.to ?? null,
      data: req.data,
      value: req.value ?? 0n,
      gas,
      gasPrice,
      type: 'legacy',
      ...(req.nonce !== undefined ? { nonce: req.nonce } : {}),
    } as any);
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: this.opts.timeoutMs ?? 180_000 });
    if (receipt.status !== 'success') throw new Error(`${req.label ?? 'tx'} reverted on chain: ${hash}`);
    return { hash, receipt, gas, gasPrice };
  }

  /** Calls `fn` on `to` and waits for it. */
  write(to: Address, abi: Abi, fn: string, args: readonly unknown[] = [], value?: bigint, label?: string): Promise<SendResult> {
    return this.send({ to, data: encodeFunctionData({ abi, functionName: fn, args }), value, label: label ?? fn });
  }
}

export function viemChain(name: ChainName, rpc?: string): Chain {
  const base = name === 'portaldot' ? portaldotTestnet : bscTestnet;
  if (!rpc) return base;
  return { ...base, rpcUrls: { default: { http: [rpc] } } } as Chain;
}

export function publicClientFor(name: ChainName, rpc?: string): PublicClient {
  const chain = viemChain(name, rpc);
  return createPublicClient({ chain, transport: http(rpc ?? chain.rpcUrls.default.http[0], { retryCount: 3, timeout: 60_000 }) }) as PublicClient;
}

/** A sender from a hex private key, or (for local nodes) an unlocked/impersonated address. */
export function senderFor(name: ChainName, keyOrAddress: Hex | Address, rpc?: string, opts?: SenderOptions): TxSender {
  const chain = viemChain(name, rpc);
  const transport = http(rpc ?? chain.rpcUrls.default.http[0], { retryCount: 3, timeout: 60_000 });
  const account: Account | Address = keyOrAddress.length === 66 ? privateKeyToAccount(keyOrAddress as Hex) : (keyOrAddress as Address);
  const wallet = createWalletClient({ chain, transport, account: typeof account === 'string' ? undefined : account });
  return new TxSender(name, publicClientFor(name, rpc), wallet, account, opts);
}

/** Best-effort human reason for a failed call: custom error name + args, or the node's message. */
export function revertReason(e: unknown, abi: Abi = backhaulErrorsAbi as unknown as Abi): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted?.data?.errorName) return formatError(reverted.data.errorName, reverted.data.args);
    const data = findRevertData(e);
    if (data) {
      const decoded = decodeRevert(data, abi);
      if (decoded) return decoded;
    }
    return e.shortMessage || e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function decodeRevert(data: Hex, abi: Abi = backhaulErrorsAbi as unknown as Abi): string | undefined {
  if (!data || data === '0x') return 'reverted without a reason';
  try {
    const d = decodeErrorResult({ abi, data });
    return formatError(d.errorName, d.args);
  } catch {
    try {
      const d = decodeErrorResult({ data });
      return formatError(d.errorName, d.args);
    } catch {
      return `unknown error ${data.slice(0, 10)}`;
    }
  }
}

function formatError(name: string, args: readonly unknown[] | undefined): string {
  if (!args || args.length === 0) return name;
  return `${name}(${args.map((a) => (typeof a === 'bigint' ? a.toString() : String(a))).join(', ')})`;
}

function findRevertData(e: BaseError): Hex | undefined {
  let found: Hex | undefined;
  e.walk((x: any) => {
    const d = x?.data ?? x?.cause?.data;
    if (typeof d === 'string' && d.startsWith('0x')) found = d as Hex;
    else if (d && typeof d === 'object' && typeof d.data === 'string') found = d.data as Hex;
    return false;
  });
  // Some nodes put the revert bytes into the message.
  if (!found) {
    const m = /(0x[0-9a-fA-F]{8,})/.exec(e.message);
    if (m) found = m[1] as Hex;
  }
  return found;
}
