// Jobs: every cross-chain message the relayer carries, as a small state machine.
//
//   transfer  locked → finalized            (Gateway.Locked on the source → Gateway.finalize on the other side)
//   order     open → filled → settled       (OriginSettler.Open → DestinationSettler.Filled → OriginSettler.settle)
//             open → refunded               (no fill by the deadline → OriginSettler.refund on an absence proof)
//
// Each step builds its proof with the SDK against the light client of the source chain, then
// calls the contract. A relayer can delay a job but never forge one: every call is checked on
// chain. Steps are idempotent; a failed step is retried with backoff.

import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  keccak256,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import {
  bscGatewayAbi,
  destinationSettlerAbi,
  lpVaultAbi,
  originSettlerAbi,
  portaldotGatewayAbi,
  bscRepayForwarderAbi,
  portaldotRepayForwarderAbi,
  type BackhaulAddresses,
  type ChainName,
} from '@backhaul/sdk';
import { step, type Job, type JsonlStore, type OrderJob, type TransferJob } from './store.js';

// ------------------------------------------------------------------ encodings

export const TRANSFER_KINDS = { POT_TO_BSC: 1, PPOT_TO_PORTALDOT: 2, BNB_TO_PORTALDOT: 3, BNBB_TO_BSC: 4 } as const;

export function outboxKeyOf(app: Address, appKey: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [app, appKey]));
}

export function nonceKey(nonce: bigint): Hex {
  return `0x${nonce.toString(16).padStart(64, '0')}`;
}

export interface TransferStruct {
  nonce: bigint;
  kind: number;
  recipient: Address;
  amount: bigint;
}

export function transferHash(t: TransferStruct): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint64' }, { type: 'uint8' }, { type: 'address' }, { type: 'uint256' }],
      [t.nonce, t.kind, t.recipient, t.amount],
    ),
  );
}

export function repayCommitment(repayTo: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }], [repayTo]));
}

export const BACKHAUL_ORDER = {
  type: 'tuple',
  components: [
    { name: 'user', type: 'address' },
    { name: 'inputToken', type: 'address' },
    { name: 'inputAmount', type: 'uint256' },
    { name: 'outputToken', type: 'address' },
    { name: 'outputAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'destinationChainId', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

export interface DecodedOrder {
  orderId: Hex;
  user: Address;
  inputToken: Address;
  inputAmount: bigint;
  outputToken: Address;
  outputAmount: bigint;
  recipient: Address;
  destinationChainId: bigint;
  nonce: bigint;
  originChainId: bigint;
  fillDeadline: number;
}

/** originData = abi.encode(BackhaulOrder, uint64 originChainId, uint32 fillDeadline); orderId = keccak256 of it. */
export function decodeOriginData(originData: Hex): DecodedOrder {
  const [o, originChainId, fillDeadline] = decodeAbiParameters([BACKHAUL_ORDER, { type: 'uint64' }, { type: 'uint32' }], originData);
  return {
    orderId: keccak256(encodeAbiParameters([BACKHAUL_ORDER, { type: 'uint64' }, { type: 'uint32' }], [o, originChainId, fillDeadline])),
    ...o,
    originChainId,
    fillDeadline: Number(fillDeadline),
  };
}

// ------------------------------------------------------------------ environment

export interface WriteResult {
  hash: Hex;
  block: bigint;
}

/** Everything a job needs from the outside world; the relayer wires it to the chains. */
export interface JobEnv {
  addrs: BackhaulAddresses;
  /** Unix seconds. */
  now(): number;
  /** An imported header ≥ minBlock in the BEEFY client on BSC; `txs` are relay txs it took. */
  portaldotHeader(minBlock: number): Promise<{ header: number; txs: Hex[] }>;
  portaldotCommitmentProof(key: Hex, header: number): Promise<Hex>;
  portaldotAbsenceProof(key: Hex, header: number): Promise<Hex>;
  /** Latest GRANDPA-finalized Portaldot block. */
  portaldotFinalized(): Promise<number>;
  /** `Timestamp::Now / 1000` in the state of `header`. */
  portaldotTimestamp(header: number): Promise<bigint>;
  bscHead(): Promise<bigint>;
  /** Finalizes `block` in the Parlia client on Portaldot (no-op if it already is). */
  bscFinalize(block: bigint): Promise<{ tx?: Hex }>;
  bscCommitmentProof(txHash: Hex, key: Hex): Promise<{ blockNumber: bigint; proof: Hex }>;
  bscAbsenceProof(key: Hex): Promise<{ blockNumber: bigint; timestamp: bigint; proof: Hex; empty: boolean }>;
  read<T>(chain: ChainName, to: Address, abi: Abi, fn: string, args?: readonly unknown[]): Promise<T>;
  write(chain: ChainName, to: Address, abi: Abi, fn: string, args: readonly unknown[], value?: bigint): Promise<WriteResult>;
  /** Timestamp of the latest block on `chain`. */
  chainTime(chain: ChainName): Promise<bigint>;
  log(m: string): void;
}

/** A fast-fill solver the runner offers each new order to (see solver.ts). */
export interface OrderSolver {
  consider(job: OrderJob): Promise<{ filled: boolean; reason: string; tx?: Hex }>;
}

export interface JobRunnerOptions {
  bscConfirmations?: bigint;
  /** Backoff after the n-th failed attempt: base · 2^n ms, capped. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Give up after this many attempts (the job stays visible as failed). */
  maxAttempts?: number;
  /** Let LP vaults fill (proof-gated) orders nobody else filled. */
  vaultFills?: boolean;
}

const other = (c: ChainName): ChainName => (c === 'portaldot' ? 'bsc' : 'portaldot');
const gatewayAbi = (c: ChainName) => (c === 'portaldot' ? portaldotGatewayAbi : bscGatewayAbi) as unknown as Abi;
const forwarderAbi = (c: ChainName) => (c === 'portaldot' ? portaldotRepayForwarderAbi : bscRepayForwarderAbi) as unknown as Abi;
const isTerminal = (j: Job) => j.state === 'finalized' || j.state === 'settled' || j.state === 'refunded' || j.state === 'failed';

export class JobRunner {
  private readonly opts: Required<JobRunnerOptions>;

  constructor(
    readonly store: JsonlStore,
    readonly env: JobEnv,
    readonly solver?: OrderSolver,
    opts: JobRunnerOptions = {},
  ) {
    this.opts = {
      bscConfirmations: opts.bscConfirmations ?? 15n,
      backoffBaseMs: opts.backoffBaseMs ?? 5_000,
      backoffMaxMs: opts.backoffMaxMs ?? 10 * 60_000,
      maxAttempts: opts.maxAttempts ?? 40,
      vaultFills: opts.vaultFills ?? true,
    };
  }

  private gateway(c: ChainName): Address {
    const a = c === 'portaldot' ? this.env.addrs.portaldot.PortaldotGateway : this.env.addrs.bsc.BscGateway;
    if (!a) throw new Error(`no gateway on ${c}`);
    return a;
  }

  private originSettler(c: ChainName): Address {
    const a = c === 'portaldot' ? this.env.addrs.portaldot.OriginSettler : this.env.addrs.bsc.OriginSettler;
    if (!a) throw new Error(`no OriginSettler on ${c}`);
    return a;
  }

  private destinationSettler(c: ChainName): Address {
    const a = c === 'portaldot' ? this.env.addrs.portaldot.DestinationSettler : this.env.addrs.bsc.DestinationSettler;
    if (!a) throw new Error(`no DestinationSettler on ${c}`);
    return a;
  }

  // ---------------------------------------------------------------- ingestion

  /** A `Locked(nonce, Transfer)` event on `src`'s gateway. */
  ingestLocked(src: ChainName, ev: { nonce: bigint; t: TransferStruct; tx: Hex; block: bigint }): TransferJob {
    const id = `${src}:${ev.nonce}`;
    const existing = this.store.get<TransferJob>(id);
    if (existing) return existing;
    const job: TransferJob = {
      id,
      type: 'transfer',
      src,
      dst: other(src),
      nonce: ev.nonce.toString(),
      kind: ev.t.kind,
      recipient: getAddress(ev.t.recipient),
      amount: ev.t.amount.toString(),
      key: outboxKeyOf(this.gateway(src), nonceKey(ev.nonce)),
      value: transferHash(ev.t),
      srcTx: ev.tx,
      srcBlock: ev.block.toString(),
      state: 'locked',
      createdAt: new Date().toISOString(),
      updatedAt: '',
      steps: [step('locked', { chain: src, tx: ev.tx, block: ev.block.toString() })],
      attempts: 0,
    };
    this.store.put(job);
    this.env.log(`transfer ${id}: kind ${job.kind}, ${job.amount} to ${job.recipient}`);
    return job;
  }

  /** An `Open(orderId, resolved)` event on `origin`'s OriginSettler. */
  ingestOpen(origin: ChainName, ev: { orderId: Hex; originData: Hex; tx: Hex; block: bigint }): OrderJob {
    const existing = this.store.get<OrderJob>(ev.orderId);
    if (existing) return existing;
    const o = decodeOriginData(ev.originData);
    if (o.orderId !== ev.orderId) throw new Error(`order ${ev.orderId}: originData hashes to ${o.orderId}`);
    const job: OrderJob = {
      id: ev.orderId,
      type: 'order',
      origin,
      dest: other(origin),
      orderId: ev.orderId,
      originData: ev.originData,
      user: o.user,
      inputToken: o.inputToken,
      inputAmount: o.inputAmount.toString(),
      outputToken: o.outputToken,
      outputAmount: o.outputAmount.toString(),
      recipient: o.recipient,
      fillDeadline: o.fillDeadline,
      openTx: ev.tx,
      openBlock: ev.block.toString(),
      state: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: '',
      steps: [step('opened', { chain: origin, tx: ev.tx, block: ev.block.toString() })],
      attempts: 0,
    };
    // a fill may have been seen before its order
    const early = this.store.getKv<OrderJob['fill']>(`fill:${ev.orderId}`);
    if (early) {
      job.fill = early;
      job.state = 'filled';
      job.steps.push(step('filled', { chain: job.dest, tx: early.tx, block: early.block, detail: `by ${early.filler}` }));
    }
    this.store.put(job);
    this.env.log(`order ${ev.orderId}: ${origin} → ${job.dest}, ${job.inputAmount} in, ${job.outputAmount} out`);
    return job;
  }

  /** A `Filled(orderId, filler, repayTo)` event on `dest`'s DestinationSettler. */
  ingestFilled(dest: ChainName, ev: { orderId: Hex; filler: Address; repayTo: Address; tx: Hex; block: bigint }): void {
    const fill = { tx: ev.tx, block: ev.block.toString(), filler: getAddress(ev.filler), repayTo: getAddress(ev.repayTo) };
    const job = this.store.get<OrderJob>(ev.orderId);
    if (!job) {
      this.store.setKv(`fill:${ev.orderId}`, fill);
      return;
    }
    if (job.fill) return;
    job.fill = fill;
    if (job.state === 'open') job.state = 'filled';
    job.steps.push(step('filled', { chain: dest, tx: ev.tx, block: fill.block, detail: `by ${fill.filler}, repay to ${fill.repayTo}` }));
    job.retryAt = undefined;
    this.store.put(job);
  }

  // ---------------------------------------------------------------- running

  /** Advances every live job by at most one step. */
  async tick(): Promise<void> {
    const now = Date.now();
    for (const job of this.store.list((j) => !isTerminal(j) && (j.retryAt ?? 0) <= now)) {
      await this.run(job);
    }
  }

  async run(job: Job): Promise<Job> {
    try {
      const next = job.type === 'transfer' ? await this.advanceTransfer(job) : await this.advanceOrder(job);
      next.error = undefined;
      return this.store.put(next);
    } catch (e) {
      job.attempts++;
      job.error = (e as Error).message.slice(0, 500);
      const delay = Math.min(this.opts.backoffBaseMs * 2 ** Math.min(job.attempts, 16), this.opts.backoffMaxMs);
      job.retryAt = Date.now() + delay;
      if (job.attempts >= this.opts.maxAttempts) {
        job.state = 'failed';
        job.steps.push(step('failed', { detail: job.error }));
      }
      this.env.log(`job ${job.id}: attempt ${job.attempts} failed: ${job.error}`);
      return this.store.put(job);
    }
  }

  /** Source blocks of BSC → Portaldot jobs still waiting for a Parlia window. */
  pendingBscBlocks(): bigint[] {
    const out = new Set<bigint>();
    for (const j of this.store.list((x) => !isTerminal(x))) {
      if (j.type === 'transfer' && j.src === 'bsc' && j.state === 'locked') out.add(BigInt(j.srcBlock));
      if (j.type === 'order' && j.origin === 'bsc' && j.state === 'open' && !j.vaultTried) out.add(BigInt(j.openBlock));
      if (j.type === 'order' && j.dest === 'bsc' && j.state === 'filled' && j.fill) out.add(BigInt(j.fill.block));
    }
    return [...out].sort((a, b) => (a < b ? -1 : 1));
  }

  // ---------------------------------------------------------------- transfers

  private async advanceTransfer(job: TransferJob): Promise<TransferJob> {
    const t: TransferStruct = { nonce: BigInt(job.nonce), kind: job.kind, recipient: job.recipient, amount: BigInt(job.amount) };
    const dstGw = this.gateway(job.dst);
    if (await this.env.read<boolean>(job.dst, dstGw, gatewayAbi(job.dst), 'isFinalized', [t.nonce])) {
      job.state = 'finalized';
      job.steps.push(step('finalized', { chain: job.dst, detail: 'already finalized on chain' }));
      await this.afterTransfer(job);
      return job;
    }

    let proof: Hex;
    if (job.src === 'portaldot') {
      const { header, txs } = await this.env.portaldotHeader(Number(job.srcBlock));
      for (const tx of txs) job.steps.push(step('beefy', { chain: 'bsc', tx, detail: `Portaldot header ${header} proven on BSC` }));
      proof = await this.env.portaldotCommitmentProof(job.key, header);
      job.proofHeader = String(header);
    } else {
      const head = await this.env.bscHead();
      if (head < BigInt(job.srcBlock) + this.opts.bscConfirmations) {
        job.retryAt = Date.now() + 3_000;
        return job;
      }
      const { tx } = await this.env.bscFinalize(BigInt(job.srcBlock));
      if (tx) job.steps.push(step('parlia', { chain: 'portaldot', tx, detail: `BSC block ${job.srcBlock} finalized on Portaldot` }));
      proof = (await this.env.bscCommitmentProof(job.srcTx, job.key)).proof;
      job.proofHeader = job.srcBlock;
    }
    job.proof = proof;
    job.state = 'proven';
    const r = await this.env.write(job.dst, dstGw, gatewayAbi(job.dst), 'finalize', [t, proof]);
    job.state = 'finalized';
    job.steps.push(step('finalized', { chain: job.dst, tx: r.hash, block: r.block.toString() }));
    this.env.log(`transfer ${job.id} finalized on ${job.dst}: ${r.hash}`);
    await this.afterTransfer(job);
    return job;
  }

  /** Vaults that hold an ERC-20 count a repayment only when told (the bridge can't call back). */
  private async afterTransfer(job: TransferJob): Promise<void> {
    const a = this.env.addrs;
    const vault =
      job.dst === 'bsc' && a.bsc.PpotVault && getAddress(job.recipient) === a.bsc.PpotVault
        ? a.bsc.PpotVault
        : job.dst === 'portaldot' && a.portaldot.BnbbVault && getAddress(job.recipient) === a.portaldot.BnbbVault
          ? a.portaldot.BnbbVault
          : undefined;
    if (!vault) return;
    const r = await this.env.write(job.dst, vault, lpVaultAbi as unknown as Abi, 'notifyRepaid', []);
    job.steps.push(step('vault repaid', { chain: job.dst, tx: r.hash, block: r.block.toString() }));
  }

  // ---------------------------------------------------------------- orders

  private vaultFor(job: OrderJob): Address | undefined {
    const a = this.env.addrs;
    const out = getAddress(job.outputToken);
    if (job.dest === 'bsc') {
      if (a.bsc.PpotVault && a.bsc.PPOT && out === a.bsc.PPOT) return a.bsc.PpotVault;
      if (a.bsc.BnbVault && out === zeroAddress) return a.bsc.BnbVault;
    } else {
      if (a.portaldot.PotVault && out === zeroAddress) return a.portaldot.PotVault;
      if (a.portaldot.BnbbVault && a.portaldot.bnbb && out === getAddress(a.portaldot.bnbb)) return a.portaldot.BnbbVault;
    }
    return undefined;
  }

  private forwarders(c: ChainName): Address[] {
    const a = this.env.addrs;
    const list = c === 'portaldot' ? [a.portaldot.PotForwarder, a.portaldot.BnbbForwarder] : [a.bsc.PpotForwarder, a.bsc.BnbForwarder];
    return list.filter((x): x is Address => !!x);
  }

  /** Proof that `originSettler` on the order's origin committed the order (what vaults check). */
  private async openProof(job: OrderJob): Promise<Hex> {
    const key = outboxKeyOf(this.originSettler(job.origin), job.orderId);
    if (job.origin === 'portaldot') {
      const { header, txs } = await this.env.portaldotHeader(Number(job.openBlock));
      for (const tx of txs) job.steps.push(step('beefy', { chain: 'bsc', tx, detail: `Portaldot header ${header} proven on BSC` }));
      return this.env.portaldotCommitmentProof(key, header);
    }
    const { tx } = await this.env.bscFinalize(BigInt(job.openBlock));
    if (tx) job.steps.push(step('parlia', { chain: 'portaldot', tx, detail: `BSC block ${job.openBlock} finalized on Portaldot` }));
    return (await this.env.bscCommitmentProof(job.openTx, key)).proof;
  }

  private async advanceOrder(job: OrderJob): Promise<OrderJob> {
    const origin = this.originSettler(job.origin);
    const status = Number(await this.env.read<number>(job.origin, origin, originSettlerAbi as unknown as Abi, 'statusOf', [job.orderId]));
    if (status === 2 || status === 3) {
      job.state = status === 2 ? 'settled' : 'refunded';
      job.steps.push(step(job.state, { chain: job.origin, detail: 'already done on chain' }));
      return job;
    }

    if (job.state === 'open') {
      // 1. an independent solver with its own inventory, instantly
      if (this.solver && !job.solverTried) {
        job.solverTried = true;
        const r = await this.solver.consider(job);
        job.steps.push(step(r.filled ? 'solver fill sent' : 'solver passed', { chain: job.dest, tx: r.tx, detail: r.reason }));
        if (r.filled) {
          job.retryAt = Date.now() + 3_000;
          return job; // the Filled event moves the job on
        }
      }
      const dst = this.destinationSettler(job.dest);
      if (await this.env.read<boolean>(job.dest, dst, destinationSettlerAbi as unknown as Abi, 'filled', [job.orderId])) {
        job.retryAt = Date.now() + 5_000; // wait for the Filled event
        return job;
      }
      // 2. past the deadline: refund
      if (this.env.now() > job.fillDeadline) return this.refund(job);
      // 3. an LP vault, gated on a proof that the order is open
      const vault = this.opts.vaultFills ? this.vaultFor(job) : undefined;
      if (vault && !job.vaultTried && (await this.vaultWants(job, vault))) {
        const proof = await this.openProof(job);
        job.vaultTried = true;
        const r = await this.env.write(job.dest, vault, lpVaultAbi as unknown as Abi, 'fill', [job.orderId, job.originData, proof]);
        job.steps.push(step('vault fill', { chain: job.dest, tx: r.hash, block: r.block.toString() }));
        return job;
      }
      job.retryAt = Date.now() + Math.min(30_000, Math.max(5_000, (job.fillDeadline - this.env.now()) * 250));
      return job;
    }

    if (job.state === 'filled' && job.fill) {
      const key = outboxKeyOf(this.destinationSettler(job.dest), job.orderId);
      let proof: Hex;
      if (job.dest === 'bsc') {
        const head = await this.env.bscHead();
        if (head < BigInt(job.fill.block) + this.opts.bscConfirmations) {
          job.retryAt = Date.now() + 3_000;
          return job;
        }
        const { tx } = await this.env.bscFinalize(BigInt(job.fill.block));
        if (tx) job.steps.push(step('parlia', { chain: 'portaldot', tx, detail: `BSC block ${job.fill.block} finalized on Portaldot` }));
        proof = (await this.env.bscCommitmentProof(job.fill.tx, key)).proof;
      } else {
        const { header, txs } = await this.env.portaldotHeader(Number(job.fill.block));
        for (const tx of txs) job.steps.push(step('beefy', { chain: 'bsc', tx, detail: `Portaldot header ${header} proven on BSC` }));
        proof = await this.env.portaldotCommitmentProof(key, header);
      }
      job.proof = proof;
      const r = await this.env.write(job.origin, origin, originSettlerAbi as unknown as Abi, 'settle', [job.originData, job.fill.repayTo, proof]);
      job.state = 'settled';
      job.steps.push(step('settled', { chain: job.origin, tx: r.hash, block: r.block.toString(), detail: `escrow to ${job.fill.repayTo}` }));
      // a vault's repayment lands in its forwarder: send it home over the canonical bridge
      if (this.forwarders(job.origin).includes(getAddress(job.fill.repayTo))) {
        const f = await this.env.write(job.origin, job.fill.repayTo, forwarderAbi(job.origin), 'flush', []);
        job.flushed = true;
        job.steps.push(step('repayment bridged', { chain: job.origin, tx: f.hash, block: f.block.toString() }));
      }
      return job;
    }
    return job;
  }

  private async vaultWants(job: OrderJob, vault: Address): Promise<boolean> {
    const fee = BigInt(await this.env.read<number>(job.dest, vault, lpVaultAbi as unknown as Abi, 'minFeeBps'));
    const idle = await this.env.read<bigint>(job.dest, vault, lpVaultAbi as unknown as Abi, 'idle');
    const out = BigInt(job.outputAmount);
    const profitable = BigInt(job.inputAmount) * 10_000n >= out * (10_000n + fee);
    if (!profitable || idle < out) {
      job.vaultTried = true;
      job.steps.push(step('vault passed', { chain: job.dest, detail: !profitable ? `spread below ${fee} bps` : 'not enough idle liquidity' }));
      return false;
    }
    return true;
  }

  private async refund(job: OrderJob): Promise<OrderJob> {
    // the origin checks block.timestamp > fillDeadline itself
    if ((await this.env.chainTime(job.origin)) <= BigInt(job.fillDeadline)) {
      job.retryAt = Date.now() + 10_000;
      return job;
    }
    const key = outboxKeyOf(this.destinationSettler(job.dest), job.orderId);
    let proof: Hex;
    if (job.dest === 'bsc') {
      const p = await this.env.bscAbsenceProof(key);
      if (!p.empty) {
        job.retryAt = Date.now() + 5_000; // filled after all: wait for its event
        return job;
      }
      if (p.timestamp < BigInt(job.fillDeadline) + 1n) {
        job.retryAt = Date.now() + 5_000;
        return job;
      }
      const { tx } = await this.env.bscFinalize(p.blockNumber);
      if (tx) job.steps.push(step('parlia', { chain: 'portaldot', tx, detail: `BSC block ${p.blockNumber} finalized on Portaldot` }));
      proof = p.proof;
    } else {
      // a header from now on, so its timestamp is past the deadline
      const { header, txs } = await this.env.portaldotHeader((await this.env.portaldotFinalized()) - 10);
      for (const tx of txs) job.steps.push(step('beefy', { chain: 'bsc', tx, detail: `Portaldot header ${header} proven on BSC` }));
      if ((await this.env.portaldotTimestamp(header)) < BigInt(job.fillDeadline) + 1n) {
        job.retryAt = Date.now() + 30_000; // wait for a header past the deadline
        return job;
      }
      proof = await this.env.portaldotAbsenceProof(key, header);
    }
    job.proof = proof;
    const r = await this.env.write(job.origin, this.originSettler(job.origin), originSettlerAbi as unknown as Abi, 'refund', [job.originData, proof]);
    job.state = 'refunded';
    job.steps.push(step('refunded', { chain: job.origin, tx: r.hash, block: r.block.toString(), detail: `escrow back to ${job.user}` }));
    return job;
  }
}
