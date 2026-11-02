// Receipt proofs: rebuild a block's receipts trie from eth_getBlockReceipts and prove one receipt.

import { RLP } from '@ethereumjs/rlp';
import { Trie } from '@ethereumjs/trie';
import { bigIntToUnpaddedBytes, bytesToHex, concatBytes, hexToBytes } from '@ethereumjs/util';
import type { Hex } from 'viem';
import type { BscClient, RpcLog, RpcReceipt } from './client.js';

export interface ReceiptProof {
  blockNumber: bigint;
  blockHash: Hex;
  receiptsRoot: Hex;
  txHash: Hex;
  txIndex: number;
  /** Trie key: RLP(txIndex). */
  key: Hex;
  /** Trie nodes from the root down to the receipt. */
  proof: Hex[];
  /** Position of the chosen log inside the receipt (not the block-wide log index). */
  logIndex: number;
  log: { address: Hex; topics: Hex[]; data: Hex };
}

/** Consensus encoding of a receipt: RLP([status, cumulativeGasUsed, bloom, logs]), prefixed by the type byte if typed. */
export function encodeReceipt(r: RpcReceipt): Uint8Array {
  const statusOrRoot =
    r.root !== undefined && r.root !== null
      ? hexToBytes(r.root)
      : bigIntToUnpaddedBytes(BigInt(r.status ?? '0x0'));
  const body = RLP.encode([
    statusOrRoot,
    bigIntToUnpaddedBytes(BigInt(r.cumulativeGasUsed)),
    hexToBytes(r.logsBloom),
    r.logs.map((l: RpcLog) => [hexToBytes(l.address), l.topics.map((t) => hexToBytes(t)), hexToBytes(l.data)]),
  ]);
  const type = Number(BigInt(r.type ?? '0x0'));
  return type === 0 ? body : concatBytes(Uint8Array.of(type), body);
}

/** Trie key of the receipt at `index`: RLP(index). */
export function receiptKey(index: number): Uint8Array {
  return RLP.encode(bigIntToUnpaddedBytes(BigInt(index)));
}

/** Builds the receipts trie of one block. Receipts must be in transaction order. */
export async function buildReceiptsTrie(receipts: RpcReceipt[]): Promise<Trie> {
  const trie = new Trie();
  for (let i = 0; i < receipts.length; i++) {
    if (Number(BigInt(receipts[i].transactionIndex)) !== i) throw new Error(`receipt ${i} is out of order`);
    await trie.put(receiptKey(i), encodeReceipt(receipts[i]));
  }
  return trie;
}

/**
 * Proves the receipt of `txHash` against its block's receiptsRoot.
 * `pickLog` selects the log to point at (default: the first one); the proof covers the whole receipt.
 */
export async function receiptProof(
  client: BscClient,
  txHash: Hex,
  pickLog: (log: RpcLog, index: number) => boolean = () => true,
): Promise<ReceiptProof> {
  const receipt = await client.transactionReceipt(txHash);
  const blockNumber = BigInt(receipt.blockNumber);
  const [block, receipts] = await Promise.all([client.block(blockNumber), client.blockReceipts(blockNumber)]);
  return proveReceipt(receipts, block.receiptsRoot, Number(BigInt(receipt.transactionIndex)), pickLog);
}

/** Offline core of {@link receiptProof}: proves receipt `txIndex` out of a block's receipts. */
export async function proveReceipt(
  receipts: RpcReceipt[],
  receiptsRoot: Hex,
  txIndex: number,
  pickLog: (log: RpcLog, index: number) => boolean = () => true,
): Promise<ReceiptProof> {
  const trie = await buildReceiptsTrie(receipts);
  const root = bytesToHex(trie.root());
  if (root !== receiptsRoot.toLowerCase()) {
    throw new Error(`rebuilt receipts root ${root} != header receiptsRoot ${receiptsRoot}`);
  }
  const r = receipts[txIndex];
  if (!r) throw new Error(`no receipt at index ${txIndex}`);
  const logIndex = r.logs.findIndex(pickLog);
  if (logIndex < 0) throw new Error(`no matching log in receipt ${r.transactionHash}`);
  const key = receiptKey(txIndex);
  const proof = (await trie.createProof(key)).map((n) => bytesToHex(n) as Hex);
  const log = r.logs[logIndex];
  return {
    blockNumber: BigInt(r.blockNumber),
    blockHash: r.blockHash,
    receiptsRoot,
    txHash: r.transactionHash,
    txIndex,
    key: bytesToHex(key) as Hex,
    proof,
    logIndex,
    log: { address: log.address, topics: log.topics, data: log.data },
  };
}
