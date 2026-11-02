import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  decodeAuthorities,
  decodeJustification,
  encodeCommitment,
  JustificationArchive,
  recoverSigners,
  uncompressKey,
} from "../src/portaldot/beefy";
import { concat, encodeCompact, le32, toHex, toU8a, type Hex } from "../src/portaldot/scale";

const beefy = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../contracts/test/fixtures/portaldot-beefy.json"), "utf8"),
);
const commitments = ["older", "commitment", "next"].filter((k) => beefy[k]?.justification);

describe("BEEFY justifications (live fixtures)", () => {
  it.each(commitments)("%s decodes to the submitCommitment arguments", (key) => {
    const f = beefy[key];
    const e = encodeCommitment(f.justification);
    expect(e.commitmentScale).toBe(f.commitmentScale);
    expect(e.indices.map(String)).toEqual(f.indices);
    expect(e.signatures).toEqual(f.signatures);
    const j = decodeJustification(f.justification);
    expect(j.commitment.blockNumber).toBe(f.blockNumber);
    expect(j.commitment.validatorSetId.toString()).toBe(f.validatorSetId);
    expect(j.mmrRoot).toBe(f.mmrRoot);
  });

  it.each(commitments)("%s is signed by the set it names", (key) => {
    const j = decodeJustification(beefy[key].justification);
    const set = key === "next" ? beefy.nextAuthorities.compressed : beefy.authorities;
    expect(recoverSigners(j)).toEqual(j.indices.map((i) => set[i]));
  });

  it("expands the next authorities to the fixture's coordinates", () => {
    beefy.nextAuthorities.compressed.forEach((c: Hex, i: number) => {
      const k = uncompressKey(c);
      expect(k.x).toBe(BigInt(beefy.nextAuthorities.x[i]));
      expect(k.y).toBe(BigInt(beefy.nextAuthorities.y[i]));
      expect(k.address).toBe(beefy.nextAuthorities.addresses[i]);
    });
    expect(beefy.authorities.map((a: Hex) => uncompressKey(a).address)).toEqual(beefy.signers);
  });

  it("decodes Vec<ecdsa::Public>", () => {
    const raw = toHex(concat(encodeCompact(2), ...beefy.authorities.map((a: Hex) => toU8a(a))));
    expect(decodeAuthorities(raw)).toEqual(beefy.authorities);
    expect(() => decodeAuthorities(`${raw}00`)).toThrow();
  });
});

describe("BEEFY bitfield", () => {
  // 9 validators, signed by 0, 3 and 8: MSB-first bits 1001 0000 | 1000 0000.
  const commitmentScale = concat(
    encodeCompact(1),
    toU8a("0x6d68"),
    encodeCompact(32),
    new Uint8Array(32).fill(7),
    le32(1234),
    new Uint8Array([5, 0, 0, 0, 0, 0, 0, 0]),
  );
  const sig = (b: number) => new Uint8Array(65).fill(b);
  const proof = toHex(
    concat(
      new Uint8Array([1]),
      commitmentScale,
      encodeCompact(2),
      new Uint8Array([0x90, 0x80]),
      le32(9),
      encodeCompact(3),
      sig(1),
      sig(2),
      sig(3),
    ),
  );

  it("maps set bits to validator indices", () => {
    const j = decodeJustification(proof);
    expect(j.indices).toEqual([0, 3, 8]);
    expect(j.validatorSetLen).toBe(9);
    expect(j.commitment.blockNumber).toBe(1234);
    expect(j.commitment.validatorSetId).toBe(5n);
    expect(j.commitmentScale).toBe(toHex(commitmentScale));
  });

  it("rejects a bitfield that disagrees with the signature count", () => {
    const bad = proof.replace("9080", "9000");
    expect(() => decodeJustification(bad as Hex)).toThrow(/bitfield/);
  });

  it("rejects other versions and trailing bytes", () => {
    expect(() => decodeJustification(`0x02${proof.slice(4)}`)).toThrow(/version/);
    expect(() => decodeJustification(`${proof}00`)).toThrow(/trailing/);
  });
});

describe("JustificationArchive", () => {
  const dir = mkdtempSync(join(tmpdir(), "backhaul-archive-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("appends, dedupes and reloads", () => {
    const path = join(dir, "j.jsonl");
    const a = JustificationArchive.open(path);
    const older = beefy.older.justification as Hex | undefined;
    const c = beefy.commitment.justification as Hex | undefined;
    if (!older || !c) return;
    expect(a.append(older, "subscription")?.blockNumber).toBe(beefy.older.blockNumber);
    expect(a.append(c, "block")?.blockNumber).toBe(beefy.commitment.blockNumber);
    expect(a.append(c, "subscription")).toBeUndefined();

    const b = JustificationArchive.open(path);
    expect(b.entries().map((e) => e.blockNumber)).toEqual([beefy.older.blockNumber, beefy.commitment.blockNumber]);
    expect(b.latest()?.blockNumber).toBe(beefy.commitment.blockNumber);
    expect(b.forSet(BigInt(beefy.setId))).toHaveLength(2);
    expect(b.forSet(BigInt(beefy.setId) + 1n)).toHaveLength(0);
    expect(b.get(beefy.commitment.blockNumber)?.mmrRoot).toBe(beefy.commitment.mmrRoot);
  });
});
