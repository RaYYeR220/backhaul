import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { blake2_256, decodeHeader } from "../src/portaldot/header";
import { encodeCompact, ScaleReader, toHex } from "../src/portaldot/scale";

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../contracts/test/fixtures", name), "utf8"));

describe("SCALE compact", () => {
  it("round-trips across every width", () => {
    for (const v of [0n, 1n, 63n, 64n, 16383n, 16384n, (1n << 30n) - 1n, 1n << 30n, (1n << 32n) - 1n, 1n << 64n]) {
      const r = new ScaleReader(encodeCompact(v));
      expect(r.compact()).toBe(v);
      r.end();
    }
  });

  it("matches known encodings", () => {
    expect(toHex(encodeCompact(69))).toBe("0x1501");
    expect(toHex(encodeCompact(16384))).toBe("0x02000100");
    expect(toHex(encodeCompact(1n << 30n))).toBe("0x0300000040");
  });
});

describe("Substrate header", () => {
  it("decodes the live fixture headers", () => {
    const f = fixture("portaldot-header.json");
    for (const h of [f, ...f.more]) {
      const d = decodeHeader(h.headerScale);
      expect(d.hash).toBe(h.blockHash);
      expect(d.number).toBe(h.blockNumber);
      expect(d.stateRoot).toBe(h.stateRoot);
    }
  });

  it("blake2_256 matches the known vectors", () => {
    expect(blake2_256(new Uint8Array())).toBe("0x0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
    expect(blake2_256(new TextEncoder().encode("abc"))).toBe(
      "0xbddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319",
    );
  });
});
