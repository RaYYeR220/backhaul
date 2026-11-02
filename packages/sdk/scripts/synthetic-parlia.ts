// Synthetic Parlia chains for light-client tests: headers sealed with throwaway test keys under a
// test chain id, arranged to hit the exact edges of validator rotation, skipping and expiry.
//
//   npx tsx scripts/synthetic-parlia.ts
//
// Writes contracts/test/fixtures/bsc-synthetic.json. The output is deterministic.
//
// Every scenario uses 9 validators and turnLength 8, like BSC testnet today, so a set announced at
// epoch block E seals from E + (⌊9/2⌋+1)·8 = E + 40. Timestamps are T0 + number (one block per second).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RLP } from '@ethereumjs/rlp';
import { Trie } from '@ethereumjs/trie';
import { bigIntToUnpaddedBytes, bytesToHex, concatBytes, hexToBytes } from '@ethereumjs/util';
import { encodeAbiParameters, keccak256, stringToHex, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAddress, sign } from 'viem/accounts';
import { sealHash, switchOffset } from '../src/bsc/header.js';
import { encodeAbsenceProof, encodeCommitmentProof } from '../src/bsc/verifier.js';

export const CHAIN_ID = 9797n;
export const EPOCH_LENGTH = 1000n;
export const TURN_LENGTH = 8;
export const TRUSTING_PERIOD = 604800n;
export const T0 = 1_700_000_000n;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const EMPTY_TRIE = hexToBytes('0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421');
const EMPTY_UNCLES = hexToBytes('0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347');
const ZERO32 = new Uint8Array(32);

// ---- keys ----

const keyOf = (i: number): Hex => keccak256(stringToHex(`backhaul synthetic validator ${i}`));
const KEYS = Array.from({ length: 40 }, (_, i) => keyOf(i));
const ADDR = KEYS.map((k) => privateKeyToAddress(k));
const byAddress = (idx: number[]) => idx.map((i) => ADDR[i]).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

/** Trusted set at the checkpoints. */
const A = [0, 1, 2, 3, 4, 5, 6, 7, 8];
/** A with validator 8 replaced by 9. */
const B = [0, 1, 2, 3, 4, 5, 6, 7, 9];
/** A with four of nine replaced (5,6,7,8 → 10,11,12,13): more than a third. */
const C = [0, 1, 2, 3, 4, 10, 11, 12, 13];
/** A set nobody trusts. */
const X = [20, 21, 22, 23, 24, 25, 26, 27, 28];
const OUTSIDER = 30;

// ---- headers ----

interface HeaderSpec {
  number: bigint;
  parentHash: Hex;
  signer: number;
  coinbase?: number;
  announce?: number[];
  stateRoot?: Uint8Array;
  receiptsRoot?: Uint8Array;
  realistic?: boolean;
  highS?: boolean;
}

const timeOf = (n: bigint) => T0 + n;

function extraOf(spec: HeaderSpec): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array(32)];
  if (spec.announce) {
    parts.push(Uint8Array.of(spec.announce.length));
    for (const a of byAddress(spec.announce)) parts.push(hexToBytes(a), new Uint8Array(48));
    parts.push(Uint8Array.of(TURN_LENGTH));
  }
  // A vote attestation of the size BSC carries, so the gas windows are honest about calldata.
  if (spec.realistic) parts.push(new Uint8Array(180).fill(0xab));
  return concatBytes(...parts);
}

async function buildHeader(spec: HeaderSpec): Promise<{ rlp: Hex; hash: Hex }> {
  const q = (n: bigint) => bigIntToUnpaddedBytes(n);
  const body = extraOf(spec);
  const items: Uint8Array[] = [
    hexToBytes(spec.parentHash),
    EMPTY_UNCLES,
    hexToBytes(ADDR[spec.coinbase ?? spec.signer]),
    spec.stateRoot ?? hexToBytes(keccak256(toHex(`state ${spec.number}`))),
    EMPTY_TRIE,
    spec.receiptsRoot ?? hexToBytes(keccak256(toHex(`receipts ${spec.number}`))),
    spec.realistic ? new Uint8Array(256) : new Uint8Array(0),
    q(2n),
    q(spec.number),
    q(spec.realistic ? 70_000_000n : 0n),
    q(spec.realistic ? 1_234_567n : 0n),
    q(timeOf(spec.number)),
    concatBytes(body, new Uint8Array(65)),
    ZERO32,
    new Uint8Array(8),
  ];
  if (spec.realistic) {
    // baseFee, withdrawalsRoot, blobGasUsed, excessBlobGas, parentBeaconRoot, requestsHash
    items.push(q(0n), EMPTY_TRIE, q(0n), q(0n), ZERO32, hexToBytes(keccak256('0x')));
  }
  const digest = sealHash(items, CHAIN_ID);
  const sig = await sign({ hash: digest, privateKey: KEYS[spec.signer] });
  let s = BigInt(sig.s);
  let yParity = sig.yParity ?? Number(sig.v! - 27n);
  if (spec.highS) {
    s = SECP256K1_N - s;
    yParity ^= 1;
  }
  items[12] = concatBytes(body, hexToBytes(sig.r), hexToBytes(toHex(s, { size: 32 })), Uint8Array.of(yParity));
  const rlp = bytesToHex(RLP.encode(items)) as Hex;
  return { rlp, hash: keccak256(rlp) };
}

interface SegmentSpec {
  start: bigint;
  length: number;
  /** Validator index sealing the header at offset i from `start`. */
  sealer: (i: number) => number;
  announce?: number[];
  realistic?: boolean;
  tweak?: (i: number, spec: HeaderSpec) => void;
}

interface Segment {
  start: bigint;
  rlps: Hex[];
}

async function segment(s: SegmentSpec): Promise<Segment> {
  const rlps: Hex[] = [];
  let parent = keccak256(toHex(`parent of ${s.start}`));
  for (let i = 0; i < s.length; i++) {
    const spec: HeaderSpec = {
      number: s.start + BigInt(i),
      parentHash: parent,
      signer: s.sealer(i),
      announce: i === 0 ? s.announce : undefined,
      realistic: s.realistic,
    };
    s.tweak?.(i, spec);
    const h = await buildHeader(spec);
    rlps.push(h.rlp);
    parent = h.hash;
  }
  return { start: s.start, rlps };
}

/** Turn-based schedule: turn k (8 blocks) is sealed by turns[k]. */
const turns = (list: number[]) => (i: number) => list[Math.floor(i / TURN_LENGTH)];

// ---- verifier block (receipts and state tries for the BscVerifier tests) ----

const VERIFIER_BLOCK = 1200n;
const OUTBOX: Address = '0x00000000000000000000000000000000000B0B0B';
const IMPOSTOR: Address = '0x000000000000000000000000000000000000BAD0';
const COMMITTED = keccak256(toHex('Committed(bytes32,bytes32)'));
const k = (label: string) => keccak256(toHex(label));
const outboxSlot = (key: Hex) =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [key, 0n]));

async function verifierBlock() {
  const key1 = k('key one');
  const key2 = k('key two');
  const key3 = k('key three');
  const absentKey = k('nobody committed this');
  const value1 = k('value one');
  const value2 = k('value two');
  const value3 = k('value three');

  const log = (address: Address, topics: Hex[], data: Hex) => [hexToBytes(address), topics.map(hexToBytes), hexToBytes(data)];
  const receipt = (type: number, logs: unknown[]) => {
    const body = RLP.encode([Uint8Array.of(1), bigIntToUnpaddedBytes(21000n), new Uint8Array(256), logs as never]);
    return type === 0 ? body : concatBytes(Uint8Array.of(type), body);
  };
  const receipts = [
    // tx0, legacy: an unrelated log, then the commitment
    receipt(0, [log(IMPOSTOR, [k('Transfer(address,address,uint256)')], '0x'), log(OUTBOX, [COMMITTED, key1], value1)]),
    // tx1, EIP-1559: the commitment of key2
    receipt(2, [log(OUTBOX, [COMMITTED, key2], value2)]),
    // tx2, legacy: a Committed event from the wrong contract
    receipt(0, [log(IMPOSTOR, [COMMITTED, key3], value3)]),
  ];
  const receiptsTrie = new Trie();
  for (let i = 0; i < receipts.length; i++) await receiptsTrie.put(RLP.encode(bigIntToUnpaddedBytes(BigInt(i))), receipts[i]);

  const storageTrie = new Trie({ useKeyHashing: true });
  const putSlot = (slot: Hex, value: Hex) => storageTrie.put(hexToBytes(slot), RLP.encode(hexToBytes(trimHex(value))));
  await putSlot(outboxSlot(key1), value1);
  await putSlot(outboxSlot(key2), value2);
  const stateTrie = new Trie({ useKeyHashing: true });
  const account = (storageRoot: Uint8Array) => RLP.encode([bigIntToUnpaddedBytes(1n), bigIntToUnpaddedBytes(0n), storageRoot, hexToBytes(k('code'))]);
  await stateTrie.put(hexToBytes(OUTBOX), account(storageTrie.root()));
  await stateTrie.put(hexToBytes(IMPOSTOR), account(EMPTY_TRIE));

  const proof = async (t: Trie, key: Uint8Array) => (await t.createProof(key)).map((n) => bytesToHex(n) as Hex);
  const receiptProofs = await Promise.all(
    receipts.map(async (_r, i) => {
      const key = RLP.encode(bigIntToUnpaddedBytes(BigInt(i)));
      return { key: bytesToHex(key) as Hex, proof: await proof(receiptsTrie, key) };
    }),
  );
  const accountProof = await proof(stateTrie, hexToBytes(OUTBOX));
  const presentProof = await proof(storageTrie, hexToBytes(outboxSlot(key1)));
  const absentProof = await proof(storageTrie, hexToBytes(outboxSlot(absentKey)));
  const blockNumber = VERIFIER_BLOCK;
  return {
    trie: { stateRoot: stateTrie.root(), receiptsRoot: receiptsTrie.root() },
    json: {
      outbox: OUTBOX,
      impostor: IMPOSTOR,
      committedTopic: COMMITTED,
      key1,
      value1,
      key2,
      value2,
      key3,
      value3,
      absentKey,
      stateRoot: bytesToHex(stateTrie.root()),
      receiptsRoot: bytesToHex(receiptsTrie.root()),
      receipts: receiptProofs,
      accountProof,
      presentProof,
      absentProof,
      // The same proofs, encoded by the SDK the way BscVerifier takes them.
      encoded: {
        commitment1: encodeCommitmentProof({ blockNumber, ...receiptProofs[0], logIndex: 1 }),
        commitment2: encodeCommitmentProof({ blockNumber, ...receiptProofs[1], logIndex: 0 }),
        impostor: encodeCommitmentProof({ blockNumber, ...receiptProofs[2], logIndex: 0 }),
        absent: encodeAbsenceProof({ blockNumber, accountProof, storageProof: absentProof }),
        present: encodeAbsenceProof({ blockNumber, accountProof, storageProof: presentProof }),
      },
    },
  };
}

function trimHex(h: Hex): Hex {
  const t = h.replace(/^0x0*/, '');
  return (t.length % 2 ? `0x0${t}` : `0x${t}`) as Hex;
}

// ---- scenarios ----

async function main() {
  const offset = switchOffset(9, TURN_LENGTH);
  if (offset !== 40) throw new Error('unexpected switch offset');
  const v = await verifierBlock();

  const segments: Record<string, Segment> = {
    // Epoch 4000 announces B. The outgoing validator 8 seals the last old-set turn (4032..4039,
    // ending exactly at E + checkLen = 4039) and the incoming 9 the first new-set turn (from 4040).
    rotation: await segment({ start: 4000n, length: 56, announce: B, sealer: turns([0, 1, 2, 3, 8, 9, 4]) }),
    // Same, but the incoming validator seals 4039, one block before its set takes over.
    rotationIncomingEarly: await segment({
      start: 4000n,
      length: 40,
      announce: B,
      sealer: (i) => (i === 39 ? 9 : turns([0, 1, 2, 3, 5])(i)),
    }),
    // Same, but the outgoing validator seals 4040, the first block after its set is replaced.
    rotationOutgoingLate: await segment({ start: 4000n, length: 41, announce: B, sealer: turns([0, 1, 2, 3, 5, 8]) }),
    // Under B: the incoming validator's turn plus five more.
    afterRotation: await segment({ start: 4100n, length: 48, sealer: turns([9, 0, 1, 2, 3, 4]) }),
    // Under B: the outgoing validator seals again.
    afterRotationOutgoing: await segment({ start: 4200n, length: 8, sealer: () => 8 }),
    // Under A, no epoch block: three epochs after the checkpoint at 1000.
    skip: await segment({ start: 4500n, length: 48, sealer: turns([0, 1, 2, 3, 4, 5]) }),
    // Epoch 5000 re-announces A; submitted straight after the checkpoint at 1000.
    skipEpoch: await segment({ start: 5000n, length: 48, announce: A, sealer: turns([0, 1, 2, 3, 4, 5]) }),
    // headers[0] at exactly checkpoint time + trusting period (605800), and one block later.
    expiry: await segment({ start: 1000n + TRUSTING_PERIOD, length: 49, sealer: turns([0, 1, 2, 3, 4, 5, 6]) }),
    // Epoch 2000 replaces four of nine. Before the switch only A seals; after it, one of the
    // validators A and C share completes the quorum of A.
    tooMuchEpoch: await segment({ start: 2000n, length: 48, announce: C, sealer: turns([5, 6, 7, 8, 0, 1]) }),
    // Under C: the new validators seal half the turns.
    tooMuchAfter: await segment({ start: 2100n, length: 48, sealer: turns([10, 0, 11, 1, 12, 2]) }),
    // A forged epoch 2000 announcing an attacker set X, sealed by five of A (one short of quorum)
    // before the switch and by six members of X after it.
    selfCertified: await segment({
      start: 2000n,
      length: 46,
      announce: X,
      sealer: (i) => (i < 40 ? turns([0, 1, 2, 3, 4])(i) : X[i - 40]),
    }),
    // Under A: a header in the middle sealed by someone outside the set.
    outsider: await segment({
      start: 1100n,
      length: 21,
      sealer: (i) => (i === 20 ? OUTSIDER : turns([0, 1, 2, 3, 4, 5])(i)),
    }),
    // Under A: header 1110 sealed by validator 1 but naming validator 2 as coinbase.
    coinbaseMismatch: await segment({
      start: 1100n,
      length: 11,
      sealer: turns([0, 1]),
      tweak: (i, spec) => {
        if (i === 10) spec.coinbase = 2;
      },
    }),
    // Under A: a header whose seal is the high-s twin of a valid one.
    highS: await segment({ start: 1100n, length: 1, sealer: () => 0, tweak: (_i, spec) => (spec.highS = true) }),
    // Under A: realistic sizes (21 fields, full bloom, attestation-sized extra). The sealer changes
    // every two blocks so the 16-, 32- and 48-header prefixes all finalize.
    gas: await segment({ start: 1100n, length: 48, realistic: true, sealer: (i) => A[Math.floor(i / 2) % 9] }),
    // Under A: 1356 lands in the same ring slot as 1100 (1356 = 1100 + 256).
    ring: await segment({ start: 1356n, length: 48, sealer: turns([0, 1, 2, 3, 4, 5]) }),
    // Under A: block 1200 commits to the verifier tries.
    verifier: await segment({
      start: VERIFIER_BLOCK,
      length: 48,
      sealer: turns([0, 1, 2, 3, 4, 5]),
      tweak: (i, spec) => {
        if (i === 0) {
          spec.stateRoot = v.trie.stateRoot;
          spec.receiptsRoot = v.trie.receiptsRoot;
        }
      },
    }),
  };

  const checkpoint = (epoch: bigint, set: number[]) => ({
    epoch,
    timestamp: timeOf(epoch),
    activeFrom: epoch + BigInt(offset),
    turnLength: TURN_LENGTH,
    validators: byAddress(set),
  });

  const out = {
    description:
      'Synthetic Parlia headers sealed by test keys under a test chain id. 9 validators, turnLength 8, ' +
      'epoch 1000; a set announced at E seals from E+40. timestamp(n) = t0 + n.',
    chainId: CHAIN_ID,
    epochLength: EPOCH_LENGTH,
    trustingPeriod: TRUSTING_PERIOD,
    t0: T0,
    sets: { A: byAddress(A), B: byAddress(B), C: byAddress(C), X: byAddress(X) },
    outgoing: ADDR[8],
    incoming: ADDR[9],
    outsider: ADDR[OUTSIDER],
    checkpoints: {
      A1000: checkpoint(1000n, A),
      A3000: checkpoint(3000n, A),
    },
    segments,
    verifier: v.json,
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', '..', '..', 'contracts', 'test', 'fixtures');
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(out, (_k, x) => (typeof x === 'bigint' ? Number(x) : x), 2) + '\n';
  writeFileSync(join(dir, 'bsc-synthetic.json'), json);
  console.log(`wrote bsc-synthetic.json (${(json.length / 1024).toFixed(0)} KiB)`);
}

await main();
