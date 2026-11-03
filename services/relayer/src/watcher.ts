// Scans both chains for the events that start or move jobs, from a persisted cursor up to a safe
// head: Portaldot's GRANDPA-finalized block, and BSC's head minus a few confirmations.

import { parseEventLogs, type Abi, type Address, type Hex, type Log, type PublicClient } from 'viem';
import { bscGatewayAbi, destinationSettlerAbi, originSettlerAbi, portaldot, type ChainName } from '@backhaul/sdk';
import type { Chains } from './chains.js';
import type { JobRunner, TransferStruct } from './jobs.js';
import type { JsonlStore } from './store.js';

/** Gateway events (same layout on both chains), settlers' Open and Filled. */
const WATCH_ABI = [
  ...(bscGatewayAbi as unknown as Abi).filter((x) => x.type === 'event' && x.name === 'Locked'),
  ...(originSettlerAbi as unknown as Abi).filter((x) => x.type === 'event' && x.name === 'Open'),
  ...(destinationSettlerAbi as unknown as Abi).filter((x) => x.type === 'event' && x.name === 'Filled'),
] as Abi;

export interface ChainScan {
  chain: ChainName;
  pub: PublicClient;
  addresses: Address[];
  /** First block to scan when there is no cursor yet (the earliest deploy block). */
  startBlock: bigint;
  safeHead(): Promise<bigint>;
  chunk: bigint;
}

export class Watcher {
  constructor(
    readonly store: JsonlStore,
    readonly runner: JobRunner,
    readonly scans: ChainScan[],
    readonly log: (m: string) => void,
  ) {}

  async tick(): Promise<void> {
    for (const s of this.scans) {
      try {
        await this.scan(s);
      } catch (e) {
        this.log(`watch ${s.chain}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
  }

  cursor(chain: ChainName): bigint | undefined {
    const c = this.store.getKv<string>(`cursor:${chain}`);
    return c === undefined ? undefined : BigInt(c);
  }

  private async scan(s: ChainScan): Promise<void> {
    const head = await s.safeHead();
    let from = this.cursor(s.chain) ?? s.startBlock;
    while (from <= head) {
      const to = from + s.chunk - 1n < head ? from + s.chunk - 1n : head;
      const logs = await s.pub.getLogs({ address: s.addresses, fromBlock: from, toBlock: to });
      this.dispatch(s.chain, logs);
      this.store.setKv(`cursor:${s.chain}`, (to + 1n).toString());
      from = to + 1n;
    }
  }

  dispatch(chain: ChainName, logs: Log[]): void {
    const parsed = parseEventLogs({ abi: WATCH_ABI, logs, strict: false });
    for (const l of parsed as any[]) {
      const tx = l.transactionHash as Hex;
      const block = l.blockNumber as bigint;
      try {
        if (l.eventName === 'Locked') {
          const t = l.args.t as TransferStruct;
          this.runner.ingestLocked(chain, { nonce: BigInt(l.args.nonce), t: { ...t, nonce: BigInt(t.nonce), amount: BigInt(t.amount), kind: Number(t.kind) }, tx, block });
        } else if (l.eventName === 'Open') {
          const r = l.args.resolvedOrder;
          this.runner.ingestOpen(chain, { orderId: l.args.orderId, originData: r.fillInstructions[0].originData, tx, block });
        } else if (l.eventName === 'Filled') {
          this.runner.ingestFilled(chain, { orderId: l.args.orderId, filler: l.args.filler, repayTo: l.args.repayTo, tx, block });
        }
      } catch (e) {
        this.log(`watch ${chain}: skipping ${l.eventName} in ${tx}: ${(e as Error).message}`);
      }
    }
  }
}

export function chainScans(ch: Chains, deployBlocks: { portaldot: bigint; bsc: bigint }): ChainScan[] {
  const a = ch.addrs;
  const pick = (xs: (Address | undefined)[]) => xs.filter((x): x is Address => !!x);
  return [
    {
      chain: 'portaldot',
      pub: ch.pd.pub,
      addresses: pick([a.portaldot.PortaldotGateway, a.portaldot.OriginSettler, a.portaldot.DestinationSettler]),
      startBlock: deployBlocks.portaldot,
      // GRANDPA-finalized, and never past what the eth-rpc node itself has indexed
      safeHead: async () => {
        const [fin, evm] = await Promise.all([portaldot.finalizedNumber(ch.pd.client.api), ch.pd.pub.getBlockNumber()]);
        return BigInt(fin) < evm ? BigInt(fin) : evm;
      },
      chunk: ch.cfg.jobs.logChunk.portaldot,
    },
    {
      chain: 'bsc',
      pub: ch.bsc.pub,
      addresses: pick([a.bsc.BscGateway, a.bsc.OriginSettler, a.bsc.DestinationSettler]),
      startBlock: deployBlocks.bsc,
      safeHead: async () => (await ch.bsc.rpc.blockNumber()) - ch.cfg.jobs.bscConfirmations,
      chunk: ch.cfg.jobs.logChunk.bsc,
    },
  ];
}
