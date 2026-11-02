import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { keccakAsU8a } from "@polkadot/util-crypto";
import { connectPortaldot, disconnectPortaldot, finalizedNumber } from "../src/portaldot/client";
import { leafHash, MmrMirror, mountains, verifyLeafProof } from "../src/portaldot/mmr";
import { concat, toHex, toU8a, type Hex } from "../src/portaldot/scale";

const LIVE = process.env.PORTALDOT_LIVE === "1";

/**
 * Independent reference: the position-based MMR of ckb-merkle-mountain-range (which pallet-mmr
 * uses), appending node by node and bagging peaks right to left.
 */
function referenceRoot(leaves: Uint8Array[]): Hex {
  const nodes: Uint8Array[] = [];
  const heightAt = (pos: number): number => {
    let p = pos + 1;
    const allOnes = (n: number) => n !== 0 && (n & (n + 1)) === 0;
    while (!allOnes(p)) p -= 2 ** Math.floor(Math.log2(p)) - 1;
    return Math.floor(Math.log2(p + 1)) - 1;
  };
  for (const leaf of leaves) {
    let pos = nodes.length;
    nodes.push(leaf);
    let h = 0;
    while (heightAt(pos + 1) > h) {
      pos++;
      const left = nodes[pos - 2 ** (h + 1)];
      const right = nodes[pos - 1];
      nodes.push(keccakAsU8a(concat(left, right)));
      h++;
    }
  }
  // Peaks of an MMR of `nodes.length` positions.
  const peaks: Uint8Array[] = [];
  let pos = 0;
  let remaining = nodes.length;
  for (let h = 40; h >= 0; h--) {
    const size = 2 ** (h + 1) - 1;
    if (size <= remaining) {
      peaks.push(nodes[pos + size - 1]);
      pos += size;
      remaining -= size;
    }
  }
  let acc = peaks[peaks.length - 1];
  for (let i = peaks.length - 2; i >= 0; i--) acc = keccakAsU8a(concat(acc, peaks[i]));
  return toHex(acc);
}

const fakeHashes = (n: number): Uint8Array[] =>
  Array.from({ length: n }, (_, i) => keccakAsU8a(new TextEncoder().encode(`block ${i}`)));

describe("MMR mirror (offline)", () => {
  const hashes = fakeHashes(130);
  const mirror = MmrMirror.fromHashes(hashes);

  it("mountains follow the set bits of the leaf count", () => {
    expect(mountains(1)).toEqual([[0, 0]]);
    expect(mountains(7)).toEqual([
      [0, 2],
      [4, 1],
      [6, 0],
    ]);
    expect(mountains(1024)).toEqual([[0, 10]]);
  });

  it("roots match the position-based reference for every size", () => {
    for (let n = 1; n <= hashes.length; n++) {
      const leaves = hashes.slice(0, n).map((h, i) => toU8a(leafHash(i, h)));
      expect(mirror.root(n), `size ${n}`).toBe(referenceRoot(leaves));
    }
  });

  it("every proof verifies and binds index, leaf and count", () => {
    // The root does not commit to the leaf count by itself: a proof checked under another count
    // can only pass when that count gives the leaf the same mountain, slot and peak count. The
    // light client never lets the prover pick the count, so this is about catching layout bugs.
    const layout = (i: number, n: number) => {
      const ms = mountains(n);
      return JSON.stringify([ms.find(([f, h]) => i >= f && i < f + 2 ** h), ms.length]);
    };
    for (let n = 1; n <= 40; n++) {
      const root = mirror.root(n);
      for (let i = 0; i < n; i++) {
        const p = mirror.proof(i, n);
        const leaf = mirror.leaf(i);
        expect(verifyLeafProof(root, leaf, p), `leaf ${i} of ${n}`).toBe(true);
        expect(verifyLeafProof(root, mirror.leaf((i + 1) % 130), p)).toBe(false);
        expect(verifyLeafProof(root, leaf, { ...p, leafIndex: i ^ 1 })).toBe(false);
        for (const other of [n - 1, n + 1, n + 2, 2 * n]) {
          if (other < 1 || layout(i, other) === layout(i, n)) continue;
          expect(verifyLeafProof(root, leaf, { ...p, leafCount: other }), `leaf ${i} of ${n} as ${other}`).toBe(false);
        }
      }
    }
  });

  it("leaf i commits to (i, hash(i))", () => {
    expect(mirror.leaf(7)).toBe(toHex(keccakAsU8a(concat(new Uint8Array([7, 0, 0, 0]), hashes[7]))));
  });

  it("refuses counts it cannot serve", () => {
    expect(() => mirror.root(0)).toThrow(RangeError);
    expect(() => mirror.root(131)).toThrow(RangeError);
    expect(() => mirror.proof(5, 5)).toThrow(RangeError);
  });

  it("extends incrementally to the same tree", () => {
    const a = MmrMirror.fromHashes(hashes.slice(0, 37));
    a.extend(hashes.slice(37));
    for (const n of [37, 64, 100, 130]) expect(a.root(n)).toBe(mirror.root(n));
  });
});

describe.skipIf(!LIVE)("MMR mirror (live Portaldot)", () => {
  it(
    "mirror root equals on-chain RootHash at 3 recent blocks",
    async () => {
      const client = await connectPortaldot();
      try {
        const mirror = await MmrMirror.sync(
          client,
          resolve(import.meta.dirname, "../.cache/portaldot-block-hashes.bin"),
          console.log,
        );
        const head = await finalizedNumber(client.api);
        for (const n of [mirror.size - 1, mirror.size - 17, mirror.size - 600]) {
          expect(n).toBeLessThanOrEqual(head);
          await mirror.checkAgainstChain(client, n);
        }
      } finally {
        await disconnectPortaldot(client);
      }
    },
    20 * 60_000,
  );
});
