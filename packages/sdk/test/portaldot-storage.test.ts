import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeAbiParameters, encodeAbiParameters, keccak256, type Hex } from "viem";
import {
  accountInfoKey,
  BEEFY_NEXT_AUTHORITIES_KEY,
  BEEFY_VALIDATOR_SET_ID_KEY,
  childInfoKey,
  outboxKey,
  outboxSlot,
  REVIVE_ACCOUNT_INFO_PREFIX,
  reviveSlotKey,
  TIMESTAMP_NOW_KEY,
  trieIdFromAccountInfo,
} from "../src/portaldot/storage";

const st = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../contracts/test/fixtures/portaldot-storage.json"), "utf8"),
);

describe("Portaldot storage keys", () => {
  it("match the keys the runtime metadata gives", () => {
    // Read from the live runtime with api.query.<pallet>.<item>.key().
    expect(BEEFY_VALIDATOR_SET_ID_KEY).toBe("0x08c41974a97dbf15cfbec28365bea2da8f05bccc2f70ec66a32999c5761156be");
    expect(BEEFY_NEXT_AUTHORITIES_KEY).toBe("0x08c41974a97dbf15cfbec28365bea2daaacf00b9b41fda7a9268821c2a2b3e4c");
    expect(TIMESTAMP_NOW_KEY).toBe("0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb");
    expect(REVIVE_ACCOUNT_INFO_PREFIX).toBe("0x735f040a5d490f1107ad9c56f5ca00d2ae37ff0591fdbbcd9c2406df7147a9dc");
    expect(accountInfoKey("0x04570accab9f6fa3637ae0bbbedfb9d46440d297")).toBe(
      "0x735f040a5d490f1107ad9c56f5ca00d2ae37ff0591fdbbcd9c2406df7147a9dc04570accab9f6fa3637ae0bbbedfb9d46440d297",
    );
  });

  it("derive revive slot keys and the Outbox mapping slot", () => {
    expect(reviveSlotKey(st.generic.slot.slot)).toBe(st.generic.slot.key);
    expect(reviveSlotKey(`0x${"00".repeat(32)}`)).toBe(
      "0x89eb0d6a8a691dae2cd15ed0369931ce0a949ecafa5c3f93f8121833646e15c3",
    );
    expect(outboxSlot(st.mapping.key)).toBe(st.mapping.slot);
    expect(outboxSlot(st.mapping.key)).toBe(
      keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [st.mapping.key, 0n])),
    );
    expect(childInfoKey(st.generic.trieId)).toBe(st.generic.childInfoKey);
  });

  it("namespaces Outbox keys like Outbox.keyFor", () => {
    const app = "0x00000000000000000000000000000000000000aa" as Hex;
    const appKey = `0x${"00".repeat(31)}01` as Hex;
    expect(outboxKey(app, appKey)).toBe(
      keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [app, appKey])),
    );
  });

  it("reads the trieId out of a real AccountInfo value", () => {
    // Values over 32 bytes are stored by hash (trie V1), so the raw AccountInfo is a proof node.
    const raw = (st.generic.accountInfoProof as Hex[]).find((n) => n.startsWith(`0x0080${st.generic.trieId.slice(2)}`));
    expect(raw).toBeDefined();
    expect(trieIdFromAccountInfo(raw!)).toBe(st.generic.trieId);
    expect(() => trieIdFromAccountInfo("0x0100000000")).toThrow(/not a contract/);
  });

  it("encodes proofs as (uint32, bytes[], bytes[])", () => {
    const [n, main, child] = decodeAbiParameters(
      [{ type: "uint32" }, { type: "bytes[]" }, { type: "bytes[]" }],
      st.mapping.commitmentProof,
    );
    expect(n).toBe(st.headerNumber);
    expect(main.length).toBeGreaterThan(0);
    expect(child.length).toBeGreaterThan(0);
    // Child proofs carry only child-trie nodes; the main-trie path travels once.
    for (const node of child) expect(main).not.toContain(node);
  });
});
