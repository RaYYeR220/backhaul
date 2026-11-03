// Connections to both chains, and the JobEnv / SolverEnv implementations over them.

import { resolve } from 'node:path';
import { getAddress, zeroAddress, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import {
  bsc,
  erc20Abi,
  portaldot,
  publicClientFor,
  senderFor,
  BeefyRelay,
  ParliaRelay,
  beefyClientPort,
  livePortaldotSource,
  loadAddresses,
  parliaClientPort,
  rpcBscSource,
  type BackhaulAddresses,
  type BeefyEvent,
  type ChainName,
  type ParliaEvent,
  type TxSender,
} from '@backhaul/sdk';
import type { RelayerConfig } from './config.js';
import type { JobEnv, WriteResult } from './jobs.js';
import type { SolverEnv } from './solver.js';
import type { JsonlStore } from './store.js';

export interface Side {
  pub: PublicClient;
  relayer: TxSender;
  solver?: TxSender;
  demo?: TxSender;
}

export interface Chains {
  cfg: RelayerConfig;
  addrs: BackhaulAddresses;
  pd: Side & { client: portaldot.PortaldotClient };
  bsc: Side & { rpc: bsc.BscClient };
  archive: portaldot.JustificationArchive;
  beefy: BeefyRelay;
  parlia: ParliaRelay;
  /** Recent light-client transactions, newest last. */
  events: { beefy: BeefyEvent[]; parlia: ParliaEvent[] };
  close(): Promise<void>;
}

export const archivePathOf = (cfg: RelayerConfig) => resolve(cfg.dataDir, 'portaldot-justifications.jsonl');
export const hashCachePathOf = (cfg: RelayerConfig) => resolve(cfg.dataDir, 'portaldot-block-hashes.bin');

export async function connectChains(cfg: RelayerConfig, store: JsonlStore, log: (m: string) => void): Promise<Chains> {
  const addrs = loadAddresses(cfg.deploymentsDir);
  if (!addrs.bsc.PortaldotLightClient || !addrs.portaldot.ParliaClient) {
    throw new Error(`no light clients in ${cfg.deploymentsDir}; deploy first`);
  }
  const client = await portaldot.connectPortaldot(cfg.portaldot.ws, cfg.portaldot.http);
  const rpc = new bsc.BscClient({ urls: cfg.bsc.rpcs });
  const mk = (chain: ChainName, key?: Hex) => (key ? senderFor(chain, key, chain === 'portaldot' ? cfg.portaldot.evmRpc : cfg.bsc.rpc) : undefined);
  const pd = {
    pub: publicClientFor('portaldot', cfg.portaldot.evmRpc),
    relayer: mk('portaldot', cfg.relayerKey)!,
    solver: mk('portaldot', cfg.solverKey),
    demo: mk('portaldot', cfg.demoKey),
    client,
  };
  const b = {
    pub: publicClientFor('bsc', cfg.bsc.rpc),
    relayer: mk('bsc', cfg.relayerKey)!,
    solver: mk('bsc', cfg.solverKey),
    demo: mk('bsc', cfg.demoKey),
    rpc,
  };

  const events: Chains['events'] = { beefy: store.getKv<BeefyEvent[]>('events:beefy') ?? [], parlia: store.getKv<ParliaEvent[]>('events:parlia') ?? [] };
  const keep = <T>(list: T[], e: T, key: string) => {
    list.push(e);
    if (list.length > 100) list.splice(0, list.length - 100);
    store.setKv(key, list);
  };

  const archive = portaldot.JustificationArchive.open(archivePathOf(cfg));
  log('syncing the Portaldot block-hash mirror');
  const mirror = await portaldot.MmrMirror.sync(client, hashCachePathOf(cfg), log);
  const beefy = new BeefyRelay(
    beefyClientPort(b.pub, b.relayer, addrs.bsc.PortaldotLightClient),
    livePortaldotSource(client, mirror, hashCachePathOf(cfg)),
    archive,
    { log: (m) => log(`beefy: ${m}`), onEvent: (e) => keep(events.beefy, e, 'events:beefy') },
  );
  const parlia = new ParliaRelay(parliaClientPort(pd.pub, pd.relayer, addrs.portaldot.ParliaClient), rpcBscSource(rpc), {
    tolerateUntrusted: cfg.parlia.tolerant,
    minOverlap: cfg.parlia.minOverlap,
    refreshAfter: cfg.parlia.refreshAfterSec,
    confirmations: cfg.parlia.confirmations,
    log: (m) => log(`parlia: ${m}`),
    onEvent: (e) => keep(events.parlia, e, 'events:parlia'),
  });
  return {
    cfg,
    addrs,
    pd,
    bsc: b,
    archive,
    beefy,
    parlia,
    events,
    close: () => portaldot.disconnectPortaldot(client),
  };
}

const sideOf = (ch: Chains, c: ChainName): Side => (c === 'portaldot' ? ch.pd : ch.bsc);

async function writeWith(s: TxSender, to: Address, abi: Abi, fn: string, args: readonly unknown[], value?: bigint): Promise<WriteResult> {
  const r = await s.write(to, abi, fn, args, value);
  return { hash: r.hash, block: r.receipt.blockNumber };
}

/** Rate guard for Parlia windows, which cost tPOT. */
class WindowBudget {
  private stamps: number[] = [];
  constructor(private readonly perHour: number) {}
  take(): void {
    const now = Date.now();
    this.stamps = this.stamps.filter((t) => now - t < 3_600_000);
    if (this.stamps.length >= this.perHour) throw new Error(`Parlia window budget (${this.perHour}/h) used up`);
    this.stamps.push(now);
  }
}

export function jobEnv(ch: Chains, log: (m: string) => void): JobEnv {
  const api = ch.pd.client.api;
  const outboxP = ch.addrs.portaldot.Outbox!;
  const outboxB = ch.addrs.bsc.Outbox!;
  const budget = new WindowBudget(ch.cfg.parlia.maxWindowsPerHour);
  return {
    addrs: ch.addrs,
    now: () => Math.floor(Date.now() / 1000),
    async portaldotHeader(minBlock) {
      const before = ch.events.beefy.length;
      const header = await ch.beefy.ensureHeader(minBlock);
      return { header, txs: ch.events.beefy.slice(before).map((e) => e.tx) };
    },
    portaldotCommitmentProof: (key, header) => portaldot.buildCommitmentProof(api, outboxP, key, header),
    portaldotAbsenceProof: (key, header) => portaldot.buildAbsenceProof(api, outboxP, key, header),
    portaldotFinalized: () => portaldot.finalizedNumber(api),
    async portaldotTimestamp(header) {
      const at = await api.at(await api.rpc.chain.getBlockHash(header));
      return BigInt((await at.query.timestamp.now()).toString()) / 1000n;
    },
    bscHead: () => ch.bsc.rpc.blockNumber(),
    async bscFinalize(block) {
      if (await ch.parlia.lc.isFinalized(block)) return {};
      budget.take();
      return { tx: await ch.parlia.finalize(block) };
    },
    bscCommitmentProof: (txHash, key) => bsc.buildCommitmentProof(ch.bsc.rpc, txHash, outboxB, key),
    bscAbsenceProof: (key) => bsc.grabAbsenceProof(ch.bsc.rpc, outboxB, key),
    read: <T>(c: ChainName, to: Address, abi: Abi, fn: string, args: readonly unknown[] = []) =>
      sideOf(ch, c).pub.readContract({ address: to, abi, functionName: fn, args }) as Promise<T>,
    write: (c, to, abi, fn, args, value) => writeWith(sideOf(ch, c).relayer, to, abi, fn, args, value),
    async chainTime(c) {
      return (await sideOf(ch, c).pub.getBlock({ blockTag: 'latest' })).timestamp;
    },
    log,
  };
}

export function solverEnv(ch: Chains, log: (m: string) => void): SolverEnv | undefined {
  if (!ch.pd.solver || !ch.bsc.solver) return undefined;
  const sender = (c: ChainName) => sideOf(ch, c).solver!;
  return {
    addrs: ch.addrs,
    address: ch.pd.solver.address,
    now: () => Math.floor(Date.now() / 1000),
    balanceOf: (c, token, who) => sideOf(ch, c).pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] }) as Promise<bigint>,
    nativeBalance: (c, who) => sideOf(ch, c).pub.getBalance({ address: who }),
    allowance: (c, token, owner, spender) =>
      sideOf(ch, c).pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }) as Promise<bigint>,
    write: (c, to, abi, fn, args, value) => writeWith(sender(c), to, abi, fn, args, value),
    async sendNative(c, to, value) {
      const r = await sender(c).send({ to: getAddress(to), data: '0x', value, label: 'prefund' });
      return { hash: r.hash, block: r.receipt.blockNumber };
    },
    log,
  };
}

