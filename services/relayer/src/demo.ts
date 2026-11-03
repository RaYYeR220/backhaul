// The server-side demo signer behind POST /demo/transfer: a key with a small float that starts a
// canonical transfer for a visitor who has no wallet. The relayer then carries it like any other.

import { maxUint256, parseEventLogs, type Abi, type Address } from 'viem';
import { bscGatewayAbi, erc20Abi, portaldotGatewayAbi, type BackhaulAddresses } from '@backhaul/sdk';
import type { DemoRoute, DemoSigner } from './api.js';
import type { Chains } from './chains.js';
import type { JobRunner, TransferStruct } from './jobs.js';

export function demoSigner(ch: Chains, runner: JobRunner): DemoSigner | undefined {
  const pd = ch.pd.demo;
  const b = ch.bsc.demo;
  if (!pd || !b) return undefined;
  const a: BackhaulAddresses = ch.addrs;
  return {
    address: pd.address,
    async send(route: DemoRoute, amount: bigint, recipient: Address) {
      let r;
      let chain: 'portaldot' | 'bsc';
      if (route === 'pot-to-bsc') {
        chain = 'portaldot';
        r = await pd.write(a.portaldot.PortaldotGateway!, portaldotGatewayAbi as unknown as Abi, 'lockPOT', [recipient], amount);
      } else if (route === 'bnb-to-portaldot') {
        chain = 'bsc';
        r = await b.write(a.bsc.BscGateway!, bscGatewayAbi as unknown as Abi, 'lockBNB', [recipient], amount);
      } else if (route === 'ppot-to-portaldot') {
        chain = 'bsc';
        r = await b.write(a.bsc.BscGateway!, bscGatewayAbi as unknown as Abi, 'burnPPOT', [amount, recipient]);
      } else {
        chain = 'portaldot';
        const gw = a.portaldot.PortaldotGateway!;
        const allowance = (await ch.pd.pub.readContract({ address: a.portaldot.bnbb!, abi: erc20Abi, functionName: 'allowance', args: [pd.address, gw] })) as bigint;
        if (allowance < amount) await pd.write(a.portaldot.bnbb!, erc20Abi as unknown as Abi, 'approve', [gw, maxUint256]);
        r = await pd.write(gw, portaldotGatewayAbi as unknown as Abi, 'burnBNBb', [amount, recipient]);
      }
      const [ev] = parseEventLogs({ abi: bscGatewayAbi, logs: r.receipt.logs, eventName: 'Locked' }) as any[];
      if (!ev) throw new Error(`no Locked event in ${r.hash}`);
      const t = ev.args.t as TransferStruct;
      const job = runner.ingestLocked(chain, {
        nonce: BigInt(ev.args.nonce),
        t: { nonce: BigInt(t.nonce), kind: Number(t.kind), recipient: t.recipient, amount: BigInt(t.amount) },
        tx: r.hash,
        block: r.receipt.blockNumber,
      });
      return { id: job.id, tx: r.hash, chain, block: r.receipt.blockNumber };
    },
  };
}
