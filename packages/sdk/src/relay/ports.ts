// viem-backed implementations of the light-client ports.

import { getAddress, type Address, type Hex, type PublicClient } from 'viem';
import { parliaClientAbi, portaldotLightClientAbi } from '../abi.js';
import { revertReason, type TxSender } from '../evm.js';
import type { BeefyClientPort } from './beefy.js';
import type { ParliaClientPort, TrustedSetView } from './parlia.js';

export function beefyClientPort(pub: PublicClient, sender: TxSender | undefined, lc: Address): BeefyClientPort {
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    pub.readContract({ address: lc, abi: portaldotLightClientAbi, functionName: functionName as any, args: args as any }) as Promise<T>;
  const need = () => {
    if (!sender) throw new Error('read-only BEEFY client port');
    return sender;
  };
  return {
    currentSetId: () => read<bigint>('currentSetId'),
    latestBlock: async () => Number(await read<number>('latestBlock')),
    stateRootOf: (n) => read<Hex>('stateRootOf', [n]),
    async submitCommitment(c) {
      const r = await need().write(lc, portaldotLightClientAbi, 'submitCommitment', [c.commitmentScale, c.indices, c.signatures]);
      return r.hash;
    },
    async importHeader(a) {
      const p = { leafIndex: BigInt(a.proof.leafIndex), leafCount: BigInt(a.proof.leafCount), items: a.proof.items };
      const r = await need().write(lc, portaldotLightClientAbi, 'importHeader', [a.commitmentBlock, a.headerScale, p]);
      return r.hash;
    },
    async rotate(a) {
      const r = await need().write(lc, portaldotLightClientAbi, 'rotate', [a.headerNumber, a.proof, a.uncompressedKeys]);
      return r.hash;
    },
  };
}

type SetTuple = readonly [readonly Address[], number, bigint, bigint, bigint, bigint];

const toView = ([validators, turnLength, epoch, activeFrom, epochTimestamp, installedAt]: SetTuple): TrustedSetView => ({
  validators: validators.map((v) => getAddress(v)),
  turnLength: Number(turnLength),
  epoch: BigInt(epoch),
  activeFrom: BigInt(activeFrom),
  epochTimestamp: BigInt(epochTimestamp),
  installedAt: BigInt(installedAt),
});

export function parliaClientPort(pub: PublicClient, sender: TxSender | undefined, lc: Address): ParliaClientPort {
  let period: Promise<bigint> | undefined;
  return {
    trustingPeriod() {
      period ??= pub.readContract({ address: lc, abi: parliaClientAbi, functionName: 'trustingPeriod' }).then((p) => BigInt(p as bigint));
      return period;
    },
    async validatorSet() {
      return toView((await pub.readContract({ address: lc, abi: parliaClientAbi, functionName: 'validatorSet' })) as SetTuple);
    },
    async previousValidatorSet() {
      return toView((await pub.readContract({ address: lc, abi: parliaClientAbi, functionName: 'previousValidatorSet' })) as SetTuple);
    },
    async isFinalized(n) {
      try {
        await pub.readContract({ address: lc, abi: parliaClientAbi, functionName: 'finalized', args: [n] });
        return true;
      } catch (e) {
        if (revertReason(e).startsWith('NotFinalized')) return false;
        throw e;
      }
    },
    async submitWindow(headers) {
      if (!sender) throw new Error('read-only Parlia client port');
      const r = await sender.write(lc, parliaClientAbi, 'submitWindow', [headers]);
      return r.hash;
    },
  };
}
