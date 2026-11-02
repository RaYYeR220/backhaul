/**
 * Captures Portaldot V3 testnet data as Foundry fixtures (contracts/test/fixtures/portaldot-*.json).
 *
 *   npx tsx packages/sdk/scripts/fixtures-portaldot.ts header blake2
 *
 * Every value is read from the live chain and cross-checked before it is written.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { blake2AsU8a, keccakAsU8a } from "@polkadot/util-crypto";
import { connectPortaldot, disconnectPortaldot, finalizedNumber, type PortaldotClient } from "../src/portaldot/client";
import { blake2_256, decodeHeader, fetchHeaderScale } from "../src/portaldot/header";
import { toHex, type Hex } from "../src/portaldot/scale";

export const FIXTURES = resolve(import.meta.dirname, "../../../contracts/test/fixtures");

export function writeFixture(name: string, data: unknown): void {
  mkdirSync(FIXTURES, { recursive: true });
  const path = resolve(FIXTURES, name);
  writeFileSync(path, JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  console.log(`wrote ${path}`);
}

async function headerEntry(c: PortaldotClient, n: number) {
  const headerScale = await fetchHeaderScale(c.api, n);
  const d = decodeHeader(headerScale);
  if (d.number !== n) throw new Error(`header ${n} decodes to number ${d.number}`);
  return { blockNumber: n, blockHash: d.hash, headerScale, stateRoot: d.stateRoot };
}

async function header(c: PortaldotClient): Promise<void> {
  const n = (await finalizedNumber(c.api)) - 5;
  const primary = await headerEntry(c, n);
  // One header per compact width of the block number: 1, 2 and 4 bytes.
  const more = [];
  for (const m of [5, 1000, 20000]) more.push(await headerEntry(c, m));
  writeFixture("portaldot-header.json", { ...primary, moreCount: more.length, more });
}

function blake2(): void {
  // Deterministic pseudo-random inputs (a keccak chain), so the file regenerates byte for byte.
  const lengths = [0, 1, 2, 3, 31, 32, 33, 55, 56, 63, 64, 65, 111, 112, 127, 128, 129, 200, 255, 256, 257, 383, 384,
    385, 511, 512, 513, 1000, 1024, 2049];
  let seed = keccakAsU8a("backhaul blake2b vectors");
  const vectors: { input: Hex; hash: Hex }[] = [];
  for (const len of lengths) {
    const input = new Uint8Array(len);
    for (let i = 0; i < len; i += 32) {
      seed = keccakAsU8a(seed);
      input.set(seed.subarray(0, Math.min(32, len - i)), i);
    }
    const hash = toHex(blake2AsU8a(input, 256));
    if (hash !== blake2_256(input)) throw new Error("blake2 mismatch");
    vectors.push({ input: toHex(input), hash });
  }
  writeFixture("portaldot-blake2.json", { count: vectors.length, vectors });
}

const tasks = new Set(process.argv.slice(2));
if (tasks.size === 0) throw new Error("usage: fixtures-portaldot.ts <header|blake2|...>");

if (tasks.has("blake2")) blake2();
if (tasks.has("header")) {
  const c = await connectPortaldot();
  try {
    await header(c);
  } finally {
    await disconnectPortaldot(c);
  }
}
