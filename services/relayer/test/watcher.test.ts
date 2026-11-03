import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseEther, zeroAddress, type Abi, type AbiEvent, type Hex, type Log } from 'viem';
import { bscGatewayAbi, destinationSettlerAbi, originSettlerAbi } from '@backhaul/sdk';
import { JobRunner } from '../src/jobs.js';
import type { OrderJob, TransferJob } from '../src/store.js';
import { Watcher } from '../src/watcher.js';
import { A, ADDRS, FakeEnv, originData, tempStore } from './helpers.js';

function log(abi: Abi, name: string, args: Record<string, unknown>, address: Hex, n: number): Log {
  const ev = abi.find((x) => x.type === 'event' && x.name === name) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName: name, args: Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]])) } as any);
  const data = encodeAbiParameters(ev.inputs.filter((i) => !i.indexed), ev.inputs.filter((i) => !i.indexed).map((i) => args[i.name!]) as never);
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: BigInt(1000 + n),
    transactionHash: `0x${n.toString(16).padStart(64, '0')}`,
    logIndex: 0,
    transactionIndex: 0,
    blockHash: `0x${'00'.repeat(32)}`,
    removed: false,
  } as Log;
}

describe('Watcher.dispatch', () => {
  it('turns Locked, Open and Filled logs into jobs', () => {
    const store = tempStore();
    const env = new FakeEnv();
    const runner = new JobRunner(store, env);
    const w = new Watcher(store, runner, [], () => {});

    const t = { nonce: 5n, kind: 3, recipient: A(0x42), amount: parseEther('0.001') };
    const d = originData({ user: A(1), inputToken: zeroAddress, inputAmount: parseEther('0.01'), outputToken: ADDRS.portaldot.bnbb!, outputAmount: parseEther('0.00996'), recipient: A(2), destinationChainId: 420420777n, nonce: 1n, originChainId: 97n, fillDeadline: 1_900_000_000 });
    const orderId = keccak256(d);
    const resolved = {
      user: A(1),
      originChainId: 97n,
      openDeadline: 2 ** 32 - 1,
      fillDeadline: 1_900_000_000,
      orderId,
      maxSpent: [{ token: `0x${'00'.repeat(32)}`, amount: 1n, recipient: `0x${'00'.repeat(32)}`, chainId: 420420777n }],
      minReceived: [{ token: `0x${'00'.repeat(32)}`, amount: 1n, recipient: `0x${'00'.repeat(32)}`, chainId: 97n }],
      fillInstructions: [{ destinationChainId: 420420777n, destinationSettler: `0x${'00'.repeat(32)}`, originData: d }],
    };

    w.dispatch('bsc', [
      log(bscGatewayAbi as unknown as Abi, 'Locked', { nonce: 5n, t }, ADDRS.bsc.BscGateway!, 1),
      log(originSettlerAbi as unknown as Abi, 'Open', { orderId, resolvedOrder: resolved }, ADDRS.bsc.OriginSettler!, 2),
    ]);
    w.dispatch('portaldot', [
      log(destinationSettlerAbi as unknown as Abi, 'Filled', { orderId, filler: A(9), repayTo: A(9) }, ADDRS.portaldot.DestinationSettler!, 3),
    ]);

    const tj = store.get<TransferJob>('bsc:5')!;
    expect([tj.kind, tj.amount, tj.recipient, tj.srcBlock, tj.dst]).toEqual([3, t.amount.toString(), A(0x42), '1001', 'portaldot']);
    const oj = store.get<OrderJob>(orderId)!;
    expect([oj.origin, oj.dest, oj.state, oj.originData, oj.fill!.repayTo]).toEqual(['bsc', 'portaldot', 'filled', d, A(9)]);
  });

  it('skips a log it cannot use instead of stopping the scan', () => {
    const store = tempStore();
    const runner = new JobRunner(store, new FakeEnv());
    const msgs: string[] = [];
    const w = new Watcher(store, runner, [], (m) => msgs.push(m));
    const orderId = `0x${'11'.repeat(32)}` as Hex;
    const bad = { user: A(1), originChainId: 97n, openDeadline: 0, fillDeadline: 0, orderId, maxSpent: [], minReceived: [], fillInstructions: [{ destinationChainId: 1n, destinationSettler: `0x${'00'.repeat(32)}`, originData: '0x1234' }] };
    w.dispatch('bsc', [log(originSettlerAbi as unknown as Abi, 'Open', { orderId, resolvedOrder: bad }, ADDRS.bsc.OriginSettler!, 4)]);
    expect(store.list()).toHaveLength(0);
    expect(msgs[0]).toMatch(/skipping Open/);
  });
});
