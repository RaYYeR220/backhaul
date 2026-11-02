// Merkle-Patricia proof vectors for the EthProofs trie walker, generated with @ethereumjs/trie.
//
//   npx tsx scripts/fixtures-bsc-mpt.ts
//
// Writes contracts/test/fixtures/bsc-mpt-vectors.json: tries shaped to hit every node kind the
// walker handles (branch, extension, leaf, inline children, branch values, a single-leaf root),
// each with proofs for keys that are present and keys that are not. Deterministic.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RLP } from '@ethereumjs/rlp';
import { Trie } from '@ethereumjs/trie';
import { bigIntToUnpaddedBytes, bytesToHex, hexToBytes } from '@ethereumjs/util';
import { keccak256, toHex, type Hex } from 'viem';

interface Vector {
  name: string;
  root: Hex;
  /** Path through the trie (already hashed for secure tries). */
  key: Hex;
  proof: Hex[];
  /** Value stored at `key`, or 0x when absent. */
  value: Hex;
}

let counter = 0;
/** Deterministic pseudo-random bytes. */
function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 32) {
    out.set(hexToBytes(keccak256(toHex(`mpt vector ${counter++}`))).subarray(0, Math.min(32, n - i)), i);
  }
  return out;
}

async function vectors(name: string, entries: [Uint8Array, Uint8Array][], probes: Uint8Array[]): Promise<Vector[]> {
  // Keys are given as trie paths: no key hashing, so the walker sees exactly these nibbles.
  const trie = new Trie();
  for (const [k, v] of entries) await trie.put(k, v);
  const root = bytesToHex(trie.root()) as Hex;
  const out: Vector[] = [];
  for (const key of probes) {
    const proof = (await trie.createProof(key)).map((n) => bytesToHex(n) as Hex);
    const value = await trie.verifyProof(trie.root(), key, proof.map((n) => hexToBytes(n)));
    out.push({ name, root, key: bytesToHex(key) as Hex, proof, value: (value ? bytesToHex(value) : '0x') as Hex });
  }
  return out;
}

async function main() {
  const all: Vector[] = [];

  // 1. A storage-like trie: 300 hashed 32-byte paths with RLP values of 1..33 bytes.
  const secure: [Uint8Array, Uint8Array][] = Array.from({ length: 300 }, (_, i) => [
    hexToBytes(keccak256(toHex(`slot ${i}`))),
    RLP.encode(bytes(1 + (i % 33))),
  ]);
  all.push(
    ...(await vectors(
      'secure',
      secure,
      [...secure.slice(0, 12).map(([k]) => k), ...Array.from({ length: 12 }, (_, i) => hexToBytes(keccak256(toHex(`missing ${i}`))))],
    )),
  );

  // 2. Short keys and one-byte values: children small enough to be embedded in their parent.
  const tiny: [Uint8Array, Uint8Array][] = Array.from({ length: 40 }, (_, i) => [
    RLP.encode(bigIntToUnpaddedBytes(BigInt(i))),
    Uint8Array.of(1 + i),
  ]);
  all.push(
    ...(await vectors('inline', tiny, [
      ...[0, 1, 5, 16, 17, 39].map((i) => RLP.encode(bigIntToUnpaddedBytes(BigInt(i)))),
      ...[40, 127, 128, 300, 70000].map((i) => RLP.encode(bigIntToUnpaddedBytes(BigInt(i)))),
    ])),
  );

  // 3. Keys that are prefixes of each other: values held in branch nodes, and extensions.
  const prefixes: [Uint8Array, Uint8Array][] = [
    [hexToBytes('0x01'), bytes(40)],
    [hexToBytes('0x0102'), bytes(40)],
    [hexToBytes('0x010203'), bytes(40)],
    [hexToBytes('0x01020304'), bytes(3)],
    [hexToBytes('0xabcdef0011'), bytes(50)],
    [hexToBytes('0xabcdef0022'), bytes(50)],
  ];
  all.push(
    ...(await vectors('prefix', prefixes, [
      ...prefixes.map(([k]) => k),
      hexToBytes('0x010204'),
      hexToBytes('0x0101'),
      hexToBytes('0xabcdef00'),
      hexToBytes('0xabcdef0033'),
      hexToBytes('0xabcdee0011'),
      hexToBytes('0x'),
    ])),
  );

  // 4. One entry: the root itself is a leaf.
  const single: [Uint8Array, Uint8Array][] = [[hexToBytes(keccak256(toHex('only'))), bytes(70)]];
  all.push(...(await vectors('single', single, [single[0][0], hexToBytes(keccak256(toHex('other')))])));

  // 5. Receipt-like: 300 indices with large values (two-byte and three-byte RLP keys).
  const receipts: [Uint8Array, Uint8Array][] = Array.from({ length: 300 }, (_, i) => [
    RLP.encode(bigIntToUnpaddedBytes(BigInt(i))),
    bytes(120 + (i % 7)),
  ]);
  all.push(
    ...(await vectors('receipts', receipts, [0, 1, 127, 128, 255, 256, 299, 300, 1000].map((i) => RLP.encode(bigIntToUnpaddedBytes(BigInt(i)))))),
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', '..', '..', 'contracts', 'test', 'fixtures');
  mkdirSync(dir, { recursive: true });
  const present = all.filter((v) => v.value !== '0x').length;
  writeFileSync(
    join(dir, 'bsc-mpt-vectors.json'),
    JSON.stringify(
      {
        description: 'Merkle-Patricia proofs from @ethereumjs/trie (keys are raw trie paths). value 0x = absent.',
        count: all.length,
        roots: all.map((v) => v.root),
        keys: all.map((v) => v.key),
        values: all.map((v) => v.value),
        proofs: all.map((v) => v.proof),
        names: all.map((v) => v.name),
      },
      null,
      1,
    ) + '\n',
  );
  console.log(`wrote bsc-mpt-vectors.json: ${all.length} vectors, ${present} present`);
}

await main();
