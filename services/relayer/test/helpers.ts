import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, getAddress, type Abi, type Address, type Hex } from 'viem';
import type { BackhaulAddresses, ChainName } from '@backhaul/sdk';
import { BACKHAUL_ORDER, type JobEnv } from '../src/jobs.js';
import { JsonlStore } from '../src/store.js';

export const A = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);

export const ADDRS: BackhaulAddresses = {
  portaldot: {
    Outbox: A(0x101),
    ParliaClient: A(0x102),
    BscVerifier: A(0x103),
    PortaldotGateway: A(0x104),
    OriginSettler: A(0x105),
    DestinationSettler: A(0x106),
    PotVault: A(0x107),
    BnbbVault: A(0x108),
    PotForwarder: A(0x109),
    BnbbForwarder: A(0x10a),
    bnbb: '0x0000264500000000000000000000000000010000',
    bnbbAssetId: 9797,
  },
  bsc: {
    Outbox: A(0x201),
    PortaldotLightClient: A(0x202),
    PortaldotVerifier: A(0x203),
    PPOT: A(0x204),
    BscGateway: A(0x205),
    OriginSettler: A(0x206),
    DestinationSettler: A(0x207),
    PpotVault: A(0x208),
    BnbVault: A(0x209),
    PpotForwarder: A(0x20a),
    BnbForwarder: A(0x20b),
  },
};

export function tempStore(): JsonlStore {
  return JsonlStore.open(join(mkdtempSync(join(tmpdir(), 'backhaul-')), 'jobs.jsonl'));
}

export interface Call {
  chain: ChainName;
  to: Address;
  fn: string;
  args: readonly unknown[];
  value?: bigint;
}

/** A JobEnv over in-memory chain state that records every call. */
export class FakeEnv implements JobEnv {
  addrs = ADDRS;
  clock = 1_800_000_000;
  bscHeadNumber = 1_000_000n;
  finalizedNonces = new Set<string>();
  status = new Map<Hex, number>();
  filled = new Set<Hex>();
  vaultFee = 30;
  vaultIdle = 10n ** 24n;
  writes: Call[] = [];
  finalizedBsc: bigint[] = [];
  headersAsked: number[] = [];
  absence = { blockNumber: 2_000_000n, timestamp: 0n, empty: true };
  /** Value of the BSC Outbox slot a storage proof shows (zero = not committed). */
  slotValue: Hex = `0x${'11'.repeat(32)}`;
  provableFrom = 0n;
  /** BSC blocks whose window fails. */
  unfinalizable = new Set<bigint>();
  storageGrabs: bigint[] = [];
  portaldotTime = 0n;
  failWrites = 0;
  private n = 0;

  now() {
    return this.clock;
  }
  async portaldotHeader(minBlock: number) {
    this.headersAsked.push(minBlock);
    return { header: minBlock + 5, txs: ['0x00000000000000000000000000000000000000000000000000000000000000b1' as Hex] };
  }
  async portaldotCommitmentProof(key: Hex, header: number) {
    return encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }, { type: 'string' }], [key, header, 'portaldot']);
  }
  async portaldotAbsenceProof(key: Hex, header: number) {
    return encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }, { type: 'string' }], [key, header, 'absent']);
  }
  async portaldotFinalized() {
    return 500_000;
  }
  async portaldotTimestamp() {
    return this.portaldotTime;
  }
  async bscHead() {
    return this.bscHeadNumber;
  }
  async bscFinalize(block: bigint) {
    if (this.unfinalizable.has(block)) throw new Error(`window at ${block} does not verify`);
    this.finalizedBsc.push(block);
    return { tx: '0x00000000000000000000000000000000000000000000000000000000000000c1' as Hex };
  }
  async bscCommitmentProof(txHash: Hex, key: Hex) {
    return { blockNumber: 0n, proof: encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [txHash, key]) };
  }
  async bscStorageCommitmentProof(key: Hex) {
    this.storageGrabs.push(this.bscHeadNumber);
    return { blockNumber: this.bscHeadNumber, timestamp: BigInt(this.clock), value: this.slotValue, proof: storageProofOf(key, this.bscHeadNumber) };
  }
  async bscAbsenceProof(key: Hex) {
    return { ...this.absence, proof: encodeAbiParameters([{ type: 'bytes32' }], [key]) };
  }
  async bscProvableFrom() {
    return this.provableFrom;
  }
  async read<T>(chain: ChainName, to: Address, _abi: Abi, fn: string, args: readonly unknown[] = []): Promise<T> {
    switch (fn) {
      case 'isFinalized':
        return this.finalizedNonces.has(`${chain}:${args[0]}`) as T;
      case 'statusOf':
        return (this.status.get(args[0] as Hex) ?? 1) as T;
      case 'filled':
        return this.filled.has(args[0] as Hex) as T;
      case 'minFeeBps':
        return this.vaultFee as T;
      case 'idle':
        return this.vaultIdle as T;
    }
    throw new Error(`unexpected read ${chain} ${to} ${fn}`);
  }
  async write(chain: ChainName, to: Address, _abi: Abi, fn: string, args: readonly unknown[], value?: bigint) {
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error('node said no');
    }
    this.writes.push({ chain, to, fn, args, value });
    return { hash: `0x${(++this.n).toString(16).padStart(64, '0')}` as Hex, block: BigInt(100 + this.n) };
  }
  async chainTime() {
    return BigInt(this.clock);
  }
  log() {}
}

/** What FakeEnv hands out as a storage commitment proof grabbed at `block`. */
export function storageProofOf(key: Hex, block: bigint): Hex {
  return encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint64' }, { type: 'string' }], [key, block, 'storage']);
}

export function originData(o: {
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
}): Hex {
  const { originChainId, fillDeadline, ...order } = o;
  return encodeAbiParameters([BACKHAUL_ORDER, { type: 'uint64' }, { type: 'uint32' }], [order, originChainId, fillDeadline]);
}
