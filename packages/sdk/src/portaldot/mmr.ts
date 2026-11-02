import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { cryptoWaitReady, keccakAsU8a } from "@polkadot/util-crypto";
import type { ApiPromise } from "@polkadot/api";
import { fetchBlockHashes, finalizedNumber, type PortaldotClient } from "./client";
import { decodeHeader, fetchHeaderScale } from "./header";
import { concat, le32, toHex, toU8a, type Hex } from "./scale";

/**
 * Single-leaf MMR proof in the layout `Mmr.sol` expects: the siblings inside the leaf's mountain
 * from the bottom up, then the peaks of every other mountain from left to right.
 */
export interface MmrLeafProof {
  leafIndex: number;
  leafCount: number;
  items: Hex[];
}

const merge = (left: Uint8Array, right: Uint8Array): Uint8Array => keccakAsU8a(concat(left, right));

/**
 * Leaf for leaf index `parentNumber`: Portaldot's MMR leaf data is `(u32 parentNumber, H256 parentHash)`,
 * so leaf `i` commits to the hash of block `i` and is appended while block `i + 1` executes.
 */
export function leafHash(parentNumber: number, parentHash: Hex | Uint8Array): Hex {
  return toHex(keccakAsU8a(concat(le32(parentNumber), toU8a(parentHash))));
}

/** Mountains of an MMR with `leafCount` leaves, left to right: `[firstLeaf, height]`. */
export function mountains(leafCount: number): [number, number][] {
  const out: [number, number][] = [];
  let first = 0;
  for (let h = 52; h >= 0; h--) {
    const size = 2 ** h;
    if (Math.floor(leafCount / size) % 2 === 1) {
      out.push([first, h]);
      first += size;
    }
  }
  return out;
}

/** Bags peaks right to left: `acc = last; acc = keccak(acc ‖ peaks[i])` going leftwards. */
export function bagPeaks(peaks: Uint8Array[]): Uint8Array {
  if (peaks.length === 0) throw new Error("empty MMR");
  let acc = peaks[peaks.length - 1];
  for (let i = peaks.length - 2; i >= 0; i--) acc = merge(acc, peaks[i]);
  return acc;
}

/** Off-chain twin of `Mmr.verify`. */
export function verifyLeafProof(root: Hex, leaf: Hex, p: MmrLeafProof): boolean {
  if (p.leafCount <= 0 || p.leafIndex < 0 || p.leafIndex >= p.leafCount) return false;
  const ms = mountains(p.leafCount);
  const k = ms.findIndex(([first, h]) => p.leafIndex >= first && p.leafIndex < first + 2 ** h);
  const [first, height] = ms[k];
  if (p.items.length !== height + ms.length - 1) return false;
  let node = toU8a(leaf);
  const local = p.leafIndex - first;
  for (let j = 0; j < height; j++) {
    const sib = toU8a(p.items[j]);
    node = Math.floor(local / 2 ** j) % 2 === 0 ? merge(node, sib) : merge(sib, node);
  }
  const peaks: Uint8Array[] = [];
  let next = height;
  for (let i = 0; i < ms.length; i++) peaks.push(i === k ? node : toU8a(p.items[next++]));
  return toHex(bagPeaks(peaks)) === root;
}

/**
 * Local copy of Portaldot's block-hash MMR. The public node has no offchain indexing, so
 * `mmr_generateProof` fails; every leaf derives from a block hash, so we rebuild the whole tree
 * from `chain_getBlockHash` and serve proofs ourselves.
 *
 * Level `h` holds the roots of the perfect subtrees over leaves `[i·2^h, (i+1)·2^h)`, packed as
 * 32-byte entries; every peak and every proof sibling is one of those.
 */
export class MmrMirror {
  private levels: Level[] = [];
  private hashes = new Level();

  /** Builds a mirror from block hashes `0..hashes.length-1`. */
  static fromHashes(hashes: (Hex | Uint8Array)[]): MmrMirror {
    const m = new MmrMirror();
    m.extend(hashes.map(toU8a));
    return m;
  }

  /**
   * Loads the on-disk hash cache, fetches the missing finalized block hashes (1000 per request)
   * and checks the mirror against the on-chain `Mmr::RootHash` at the finalized head.
   */
  static async sync(client: PortaldotClient, cachePath: string, log: (m: string) => void = () => {}): Promise<MmrMirror> {
    await cryptoWaitReady();
    const cached: Uint8Array[] = [];
    if (existsSync(cachePath)) {
      const buf = readFileSync(cachePath);
      const whole = buf.length - (buf.length % 32);
      for (let off = 0; off < whole; off += 32) cached.push(new Uint8Array(buf.subarray(off, off + 32)));
    } else {
      mkdirSync(dirname(cachePath), { recursive: true });
    }
    const head = await finalizedNumber(client.api);
    if (cached.length > 0) {
      // Spot-check the cache tail against the chain before extending it.
      const probe = cached.length - 1;
      const [h] = await fetchBlockHashes(client.http, probe, probe + 1);
      if (h !== toHex(cached[probe])) throw new Error(`hash cache diverges from chain at block ${probe}`);
    }
    if (cached.length < head) {
      log(`fetching block hashes ${cached.length}..${head - 1}`);
      const fresh = await fetchBlockHashes(client.http, cached.length, head, 1000, (n) => {
        if (n % 20000 === 0) log(`  ${cached.length + n}/${head}`);
      });
      const fd = openSync(cachePath, "a");
      try {
        // A truncated tail is ignored on load, so a crash here never corrupts the cache.
        for (const h of fresh) writeSync(fd, toU8a(h));
      } finally {
        closeSync(fd);
      }
      for (const h of fresh) cached.push(toU8a(h));
    }
    const mirror = new MmrMirror();
    mirror.extend(cached);
    await mirror.checkAgainstChain(client, head);
    log(`mirror holds ${mirror.size} leaves, root matches chain at block ${head}`);
    return mirror;
  }

  /** Asserts `root(n)` equals `Mmr::RootHash` (and `NumberOfLeaves == n`) in the state of block `n`. */
  async checkAgainstChain(client: PortaldotClient, n: number): Promise<void> {
    const at = await client.api.at(await client.api.rpc.chain.getBlockHash(n));
    const [count, root] = await Promise.all([at.query.mmr.numberOfLeaves(), at.query.mmr.rootHash()]);
    if (BigInt(count.toString()) !== BigInt(n)) throw new Error(`NumberOfLeaves at ${n} is ${count}, expected ${n}`);
    const mine = this.root(n);
    if (mine !== root.toHex()) throw new Error(`MMR root mismatch at block ${n}: mirror ${mine}, chain ${root.toHex()}`);
  }

  /** Number of block hashes held, i.e. the largest leaf count the mirror can serve. */
  get size(): number {
    return this.hashes.count;
  }

  blockHash(n: number): Hex {
    if (!Number.isInteger(n) || n < 0 || n >= this.hashes.count) throw new RangeError(`block ${n} not in mirror`);
    return toHex(this.hashes.get(n));
  }

  leaf(index: number): Hex {
    return toHex(this.node(0, index));
  }

  /** Root of the MMR holding leaves `0..leafCount-1`, as stored on chain at block `leafCount`. */
  root(leafCount: number): Hex {
    this.checkCount(leafCount);
    return toHex(bagPeaks(mountains(leafCount).map(([first, h]) => this.node(h, first / 2 ** h))));
  }

  proof(leafIndex: number, leafCount: number): MmrLeafProof {
    this.checkCount(leafCount);
    if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leafCount) {
      throw new RangeError(`leaf ${leafIndex} not below leaf count ${leafCount}`);
    }
    const ms = mountains(leafCount);
    const k = ms.findIndex(([first, h]) => leafIndex >= first && leafIndex < first + 2 ** h);
    const height = ms[k][1];
    const items: Hex[] = [];
    for (let j = 0; j < height; j++) {
      const pos = Math.floor(leafIndex / 2 ** j);
      items.push(toHex(this.node(j, pos % 2 === 0 ? pos + 1 : pos - 1)));
    }
    ms.forEach(([first, h], i) => {
      if (i !== k) items.push(toHex(this.node(h, first / 2 ** h)));
    });
    return { leafIndex, leafCount, items };
  }

  /** Appends the hashes of the next blocks and extends every level. */
  extend(newHashes: Uint8Array[]): void {
    const start = this.hashes.count;
    for (const h of newHashes) {
      if (h.length !== 32) throw new Error("block hash must be 32 bytes");
      this.hashes.push(h);
    }
    if (this.levels.length === 0) this.levels.push(new Level());
    const l0 = this.levels[0];
    const pre = new Uint8Array(36);
    for (let i = start; i < this.hashes.count; i++) {
      pre.set(le32(i), 0);
      pre.set(this.hashes.get(i), 4);
      l0.push(keccakAsU8a(pre));
    }
    for (let h = 1; this.levels[h - 1].count >= 2; h++) {
      if (!this.levels[h]) this.levels.push(new Level());
      const below = this.levels[h - 1];
      const level = this.levels[h];
      const pair = new Uint8Array(64);
      for (let i = level.count; 2 * i + 1 < below.count; i++) {
        pair.set(below.get(2 * i), 0);
        pair.set(below.get(2 * i + 1), 32);
        level.push(keccakAsU8a(pair));
      }
    }
  }

  private node(h: number, i: number): Uint8Array {
    const level = this.levels[h];
    if (!level || i < 0 || i >= level.count) throw new RangeError(`MMR node ${h}/${i} not available`);
    return level.get(i);
  }

  private checkCount(leafCount: number): void {
    if (!Number.isInteger(leafCount) || leafCount <= 0 || leafCount > this.hashes.count) {
      throw new RangeError(`leaf count ${leafCount} outside 1..${this.hashes.count}`);
    }
  }
}

/** Growable array of 32-byte entries in one buffer. */
class Level {
  private buf = new Uint8Array(32 * 1024);
  count = 0;

  push(v: Uint8Array): void {
    if ((this.count + 1) * 32 > this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf.set(v, this.count * 32);
    this.count++;
  }

  get(i: number): Uint8Array {
    return this.buf.subarray(i * 32, i * 32 + 32);
  }
}

/** Arguments of `PortaldotLightClient.importHeader`. */
export interface HeaderImportArgs {
  commitmentBlock: number;
  headerScale: Hex;
  proof: MmrLeafProof;
}

/**
 * Proof that header `headerNumber` is leaf `headerNumber` of the MMR committed at
 * `commitmentBlock` (which must be greater than `headerNumber`).
 */
export async function buildHeaderImport(
  api: ApiPromise,
  mirror: MmrMirror,
  headerNumber: number,
  commitmentBlock: number,
): Promise<HeaderImportArgs> {
  const headerScale = await fetchHeaderScale(api, headerNumber);
  const { hash } = decodeHeader(headerScale);
  if (hash !== mirror.blockHash(headerNumber)) throw new Error(`header ${headerNumber} is not the mirrored block`);
  const proof = mirror.proof(headerNumber, commitmentBlock);
  if (!verifyLeafProof(mirror.root(commitmentBlock), leafHash(headerNumber, hash), proof)) {
    throw new Error("header proof does not verify against the mirror");
  }
  return { commitmentBlock, headerScale, proof };
}
