// Captures real BSC testnet fixtures for the Solidity and SDK tests.
//
//   npx tsx scripts/fixtures-bsc.ts [epoch] [--only headers,receipt,storage]
//
// Writes to contracts/test/fixtures/:
//   bsc-headers.json  100 consecutive headers from an epoch block where the validator set changed,
//                     plus the checkpoint of the epoch before it (so the rotation can be replayed).
//   bsc-receipt.json  a typed and a legacy receipt proof from a block inside that header range.
//   bsc-storage.json  account/storage proofs grabbed at `latest` (existing slot, absent slot,
//                     absent account), the headers needed to finalize that block, and its checkpoint.
//
// Default epoch 140342000: validator 0x76d7… left and 0x9040… joined (switch after +39, so the
// incoming validator may seal from +40; it first sealed at +88).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, getAddress, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { BscClient, BSC_TESTNET_CHAIN_ID, type RpcBlock } from '../src/bsc/client.js';
import { checkpointAt, type ParliaCheckpoint } from '../src/bsc/checkpoint.js';
import { headerRlp, parseEpochExtra, quorum, sealerOf, switchOffset } from '../src/bsc/header.js';
import { proveReceipt } from '../src/bsc/receipts.js';
import { grabStorageProofs } from '../src/bsc/storage.js';

const EPOCH_LENGTH = 1000n;
const HEADER_COUNT = 100;
const STORAGE_WINDOW = 64;
/** WBNB on BSC testnet: slot 0 holds the token name, so it is a known non-empty slot. */
const WBNB: Address = '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd';
/** An address with no account in BSC testnet state. */
const NOBODY: Address = getAddress(`0x${keccak256(stringToHex('backhaul:nobody')).slice(26)}`);
/** A commitment key nobody wrote: the slot keccak256(abi.encode(key, 0)) is empty in any contract. */
const ABSENT_KEY = keccak256(stringToHex('backhaul:absent-key'));

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', '..', '..', 'contracts', 'test', 'fixtures');

const args = process.argv.slice(2);
const onlyArg = args.indexOf('--only');
const only = onlyArg >= 0 ? new Set(args[onlyArg + 1].split(',')) : new Set(['headers', 'receipt', 'storage']);
const epochArg = args.find((a) => /^\d+$/.test(a));
const EPOCH = BigInt(epochArg ?? '140342000');

const client = new BscClient();

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x), 2) + '\n';

function write(name: string, data: unknown) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, name), json(data));
  console.log(`wrote ${name}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sealedBy(rlps: Hex[], blocks: RpcBlock[]) {
  for (let i = 0; i < rlps.length; i++) {
    const signer = await sealerOf(rlps[i], BSC_TESTNET_CHAIN_ID);
    if (signer !== getAddress(blocks[i].miner)) throw new Error(`block ${blocks[i].number}: sealer ${signer} != miner`);
  }
}

function checkpointJson(cp: ParliaCheckpoint) {
  return {
    epoch: cp.epoch,
    timestamp: cp.timestamp,
    activeFrom: cp.activeFrom,
    turnLength: cp.turnLength,
    validators: cp.validators,
  };
}

async function headers() {
  if (EPOCH % EPOCH_LENGTH !== 0n) throw new Error(`${EPOCH} is not an epoch block`);
  const blocks = await client.blocks(EPOCH, HEADER_COUNT);
  const rlps = blocks.map(headerRlp);
  await sealedBy(rlps, blocks);

  const checkpoint = await checkpointAt(client, EPOCH - EPOCH_LENGTH, EPOCH_LENGTH);
  const announced = parseEpochExtra(blocks[0].extraData);
  const outgoing = checkpoint.validators.filter((v) => !announced.validators.includes(v));
  const incoming = announced.validators.filter((v) => !checkpoint.validators.includes(v));
  const switchHeight = EPOCH + BigInt(switchOffset(checkpoint.validators.length, checkpoint.turnLength));
  const firstIncoming = blocks.find((b) => incoming.includes(getAddress(b.miner)));

  // Cross-check the switch height against the node's own snapshots.
  const [lastOld, firstNew] = await client.batch<[{ validators: object }, { validators: object }]>([
    ['parlia_getSnapshot', [`0x${(switchHeight - 2n).toString(16)}`]],
    ['parlia_getSnapshot', [`0x${(switchHeight - 1n).toString(16)}`]],
  ]);
  const sorted = (o: object) => Object.keys(o).map((a) => getAddress(a)).sort().join();
  if (sorted(lastOld.validators) !== [...checkpoint.validators].sort().join()) throw new Error('old set mismatch');
  if (sorted(firstNew.validators) !== [...announced.validators].sort().join()) throw new Error('new set mismatch');

  write('bsc-headers.json', {
    description:
      'BSC testnet headers from an epoch block whose validator set differs from the previous epoch. ' +
      'checkpoint = the epoch before; switchHeight = first height sealed by the announced set.',
    chainId: BSC_TESTNET_CHAIN_ID,
    epochLength: EPOCH_LENGTH,
    epoch: EPOCH,
    checkpoint: checkpointJson(checkpoint),
    epochValidators: announced.validators,
    epochTurnLength: announced.turnLength,
    switchHeight,
    quorum: quorum(checkpoint.validators.length),
    outgoing,
    incoming,
    firstIncomingSeal: firstIncoming ? BigInt(firstIncoming.number) : null,
    numbers: blocks.map((b) => BigInt(b.number)),
    hashes: blocks.map((b) => b.hash),
    miners: blocks.map((b) => getAddress(b.miner)),
    timestamps: blocks.map((b) => BigInt(b.timestamp)),
    stateRoots: blocks.map((b) => b.stateRoot),
    receiptsRoots: blocks.map((b) => b.receiptsRoot),
    rlps,
    rpcSamples: blocks.slice(0, 2),
  });
}

async function receipt() {
  // A small block inside the header range with both a typed and a legacy receipt carrying logs.
  const number = EPOCH + 2n;
  const [block, receipts] = await Promise.all([client.block(number), client.blockReceipts(number)]);
  const typedIndex = receipts.findIndex((r) => BigInt(r.type) > 0n && r.logs.length > 0);
  const isCommittedShape = (l: { topics: Hex[]; data: Hex }) => l.topics.length === 2 && l.data.length === 66;
  const legacyIndex = receipts.findIndex((r) => BigInt(r.type) === 0n && r.logs.some(isCommittedShape));
  if (typedIndex < 0 || legacyIndex < 0) throw new Error(`block ${number} lacks a typed or a legacy receipt with logs`);
  const typed = await proveReceipt(receipts, block.receiptsRoot, typedIndex);
  const legacy = await proveReceipt(receipts, block.receiptsRoot, legacyIndex, isCommittedShape);

  const strip = (p: Awaited<ReturnType<typeof proveReceipt>>) => ({
    txHash: p.txHash,
    txIndex: p.txIndex,
    txType: Number(BigInt(receipts[p.txIndex].type)),
    key: p.key,
    proof: p.proof,
    logIndex: p.logIndex,
    logCount: receipts[p.txIndex].logs.length,
    emitter: getAddress(p.log.address),
    topics: p.log.topics,
    data: p.log.data,
  });

  write('bsc-receipt.json', {
    description:
      'Receipt proofs from a BSC testnet block inside bsc-headers.json. legacy points at a log with the ' +
      'same shape as Committed(bytes32 indexed,bytes32): two topics and 32 bytes of data.',
    chainId: BSC_TESTNET_CHAIN_ID,
    blockNumber: number,
    blockHash: block.hash,
    receiptsRoot: block.receiptsRoot,
    typed: strip(typed),
    legacy: strip(legacy),
    rawReceipts: receipts,
  });
}

async function storage() {
  const absentSlot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [ABSENT_KEY, 0n]));
  const [wbnb, nobody] = await grabStorageProofs(client, [
    { account: WBNB, slots: ['0x0000000000000000000000000000000000000000000000000000000000000000', absentSlot] },
    { account: NOBODY, slots: ['0x0000000000000000000000000000000000000000000000000000000000000000'] },
  ]);
  const x = wbnb.blockNumber;
  console.log(`storage proof pinned to block ${x}; waiting for ${STORAGE_WINDOW} headers on top`);
  if (BigInt(wbnb.slots[0].value) === 0n || BigInt(wbnb.slots[1].value) !== 0n) throw new Error('unexpected slot values');

  while ((await client.blockNumber()) < x + BigInt(STORAGE_WINDOW)) await sleep(5000);
  const blocks = await client.blocks(x, STORAGE_WINDOW);
  const rlps = blocks.map(headerRlp);
  await sealedBy(rlps, blocks);
  if (blocks[0].stateRoot !== wbnb.stateRoot) throw new Error('stateRoot moved');

  // The trusted set for this window: the latest epoch whose set already seals at x.
  let epoch = x - (x % EPOCH_LENGTH);
  let cp = await checkpointAt(client, epoch, EPOCH_LENGTH);
  if (x < cp.activeFrom) {
    epoch -= EPOCH_LENGTH;
    cp = await checkpointAt(client, epoch, EPOCH_LENGTH);
  }
  const outsiders = blocks.filter((b) => !cp.validators.includes(getAddress(b.miner)));
  if (outsiders.length > 0) throw new Error(`window sealed outside the checkpoint set at ${outsiders[0].number}`);

  write('bsc-storage.json', {
    description:
      'eth_getProof results grabbed at latest and pinned to blockNumber by stateRoot, with the headers ' +
      'that finalize that block and the checkpoint whose set sealed them.',
    chainId: BSC_TESTNET_CHAIN_ID,
    epochLength: EPOCH_LENGTH,
    blockNumber: x,
    blockHash: wbnb.blockHash,
    stateRoot: wbnb.stateRoot,
    timestamp: wbnb.timestamp,
    account: WBNB,
    storageRoot: wbnb.storageRoot,
    accountProof: wbnb.accountProof,
    existing: { slot: wbnb.slots[0].slot, value: wbnb.slots[0].value, proof: wbnb.slots[0].proof },
    absentKey: ABSENT_KEY,
    absent: { slot: wbnb.slots[1].slot, proof: wbnb.slots[1].proof },
    absentAccount: { account: NOBODY, accountProof: nobody.accountProof, slot: nobody.slots[0].slot, proof: nobody.slots[0].proof },
    checkpoint: checkpointJson(cp),
    numbers: blocks.map((b) => BigInt(b.number)),
    hashes: blocks.map((b) => b.hash),
    miners: blocks.map((b) => getAddress(b.miner)),
    rlps,
  });
}

if (only.has('headers')) await headers();
if (only.has('receipt')) await receipt();
if (only.has('storage')) await storage();
