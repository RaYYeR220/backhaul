/**
 * Captures Portaldot V3 testnet data as Foundry fixtures (contracts/test/fixtures/portaldot-*.json).
 *
 *   npx tsx packages/sdk/scripts/fixtures-portaldot.ts header blake2
 *   npx tsx packages/sdk/scripts/fixtures-portaldot.ts mmr storage beefy [--commitment N] [--wait-next]
 *
 * `mmr`, `storage` and `beefy` share one capture: an archived BEEFY commitment C of set N (see
 * archive-portaldot-justifications.ts) and the header H = C - 10. `--wait-next` waits for the
 * first justification of set N + 1 (the next session, at most about an hour away), so the
 * rotation fixture covers a real handoff.
 *
 * Every value is read from the live chain and cross-checked before it is written.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { blake2AsU8a, keccakAsU8a } from "@polkadot/util-crypto";
import {
  authoritiesAt,
  decodeJustification,
  encodeCommitment,
  fetchStoredJustification,
  JustificationArchive,
  recoverSigners,
  sessionStartOf,
  uncompressKey,
  validatorSetIdAt,
  type DecodedJustification,
} from "../src/portaldot/beefy";
import { connectPortaldot, disconnectPortaldot, finalizedNumber, type PortaldotClient } from "../src/portaldot/client";
import { blake2_256, decodeHeader, fetchHeaderScale } from "../src/portaldot/header";
import { leafHash, MmrMirror, verifyLeafProof } from "../src/portaldot/mmr";
import { toHex, type Hex } from "../src/portaldot/scale";
import {
  accountInfoKey,
  BEEFY_NEXT_AUTHORITIES_KEY,
  BEEFY_VALIDATOR_SET_ID_KEY,
  buildAbsenceProof,
  buildBindProof,
  buildCommitmentProof,
  childInfoKey,
  childReadProof,
  outboxSlot,
  readProof,
  reviveSlotKey,
  TIMESTAMP_NOW_KEY,
  trieIdOf,
} from "../src/portaldot/storage";

export const FIXTURES = resolve(import.meta.dirname, "../../../contracts/test/fixtures");
const ARCHIVE = resolve(import.meta.dirname, "../.cache/portaldot-justifications.jsonl");
const HASH_CACHE = resolve(import.meta.dirname, "../.cache/portaldot-block-hashes.bin");

export function writeFixture(name: string, data: unknown): void {
  mkdirSync(FIXTURES, { recursive: true });
  const path = resolve(FIXTURES, name);
  writeFileSync(path, JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  console.log(`wrote ${path}`);
}

function word(v: bigint): Hex {
  return `0x${v.toString(16).padStart(64, "0")}`;
}

// ------------------------------------------------------------------ header + blake2

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

// ------------------------------------------------------------------ shared capture

/** A commitment C of set N plus the header H = C - 10 it proves, both inside session N. */
interface Capture {
  setId: bigint;
  sessionStart: number;
  checkpoint: DecodedJustification;
  older: DecodedJustification;
  commitment: DecodedJustification;
  headerNumber: number;
}

async function at(c: PortaldotClient, n: number) {
  return c.api.at(await c.api.rpc.chain.getBlockHash(n));
}

async function capture(c: PortaldotClient, pinned?: number): Promise<Capture> {
  const archive = JustificationArchive.open(ARCHIVE);
  let entry = pinned !== undefined ? archive.get(pinned) : undefined;
  if (pinned !== undefined && !entry) throw new Error(`commitment ${pinned} is not in the archive`);
  if (!entry) {
    // The newest set with at least three archived commitments.
    const sets = [...new Set(archive.entries().map((e) => e.validatorSetId))].reverse();
    const set = sets.find((s) => archive.forSet(BigInt(s)).length >= 3);
    if (!set) throw new Error("archive holds no set with three commitments yet");
    const list = archive.forSet(BigInt(set));
    entry = list[list.length - 1];
  }
  const commitment = decodeJustification(entry.proof);
  const setId = commitment.commitment.validatorSetId;
  const sessionStart = await sessionStartOf(c.api, setId, commitment.commitment.blockNumber);
  const headerNumber = commitment.commitment.blockNumber - 10;
  if (headerNumber < sessionStart) throw new Error("commitment too close to the session start");
  const olderEntry = archive
    .forSet(setId)
    .find((e) => e.blockNumber > sessionStart && e.blockNumber < commitment.commitment.blockNumber);
  if (!olderEntry) throw new Error("no older commitment of the same set in the archive");
  const checkpointProof = archive.get(sessionStart)?.proof ?? (await fetchStoredJustification(c.api, sessionStart));
  if (!checkpointProof) throw new Error(`no justification at session start ${sessionStart}`);
  const checkpoint = decodeJustification(checkpointProof);
  if (checkpoint.commitment.validatorSetId !== setId) throw new Error("checkpoint signed by another set");
  console.log(
    `capture: set ${setId}, session start ${sessionStart}, C ${commitment.commitment.blockNumber}, H ${headerNumber}`,
  );
  return { setId, sessionStart, checkpoint, older: decodeJustification(olderEntry.proof), commitment, headerNumber };
}

function commitmentJson(j: DecodedJustification) {
  const e = encodeCommitment(j);
  return {
    blockNumber: j.commitment.blockNumber,
    validatorSetId: j.commitment.validatorSetId,
    mmrRoot: j.mmrRoot,
    commitmentScale: e.commitmentScale,
    indices: e.indices,
    signatures: e.signatures,
    justification: j.raw,
  };
}

/** Checks the signatures of `j` recover to `authorities` at the claimed indices. */
function checkSigners(j: DecodedJustification, authorities: Hex[]): void {
  const recovered = recoverSigners(j);
  j.indices.forEach((idx, i) => {
    if (recovered[i] !== authorities[idx]) {
      throw new Error(`signature ${i} of block ${j.commitment.blockNumber} is not authority ${idx}`);
    }
  });
}

// ------------------------------------------------------------------ MMR

function mmrFixture(mirror: MmrMirror, cap: Capture): void {
  const C = cap.commitment.commitment.blockNumber;
  const root = cap.commitment.mmrRoot;
  if (mirror.root(C) !== root) throw new Error("mirror root differs from the signed MMR root");
  const entry = (i: number) => {
    const p = mirror.proof(i, C);
    const leaf = mirror.leaf(i);
    if (!verifyLeafProof(root, leaf, p)) throw new Error(`proof for leaf ${i} does not verify`);
    return { leafIndex: i, blockHash: mirror.blockHash(i), leaf, items: p.items };
  };
  const recent = entry(cap.headerNumber);
  const wrongLeafCounts = [C - 1, C + 1, C - 9, C + 7, 2 * C].filter(
    (n) => !verifyLeafProof(root, recent.leaf, { leafIndex: recent.leafIndex, leafCount: n, items: recent.items }),
  );
  writeFixture("portaldot-mmr.json", {
    commitmentBlock: C,
    mmrRoot: root,
    leafCount: C,
    recent,
    deep: entry(1000),
    last: entry(C - 1),
    wrongLeafCounts,
  });
}

// ------------------------------------------------------------------ BEEFY

async function waitForNextSet(c: PortaldotClient, cap: Capture): Promise<{ start: number; j: DecodedJustification }> {
  const target = cap.setId + 1n;
  for (;;) {
    const head = await finalizedNumber(c.api);
    if ((await validatorSetIdAt(c.api, head)) >= target) {
      const start = await sessionStartOf(c.api, target, head);
      const archived = JustificationArchive.open(ARCHIVE).get(start)?.proof;
      const proof = archived ?? (await fetchStoredJustification(c.api, start));
      if (proof) return { start, j: decodeJustification(proof) };
      console.log(`session of set ${target} started at ${start}; waiting for its justification`);
    } else {
      console.log(`${new Date().toISOString()} finalized ${head}, waiting for set ${target}`);
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

async function beefyFixture(c: PortaldotClient, mirror: MmrMirror, cap: Capture, waitNext: boolean): Promise<void> {
  const C = cap.commitment.commitment.blockNumber;
  const H = cap.headerNumber;
  const authorities = await authoritiesAt(c.api, H);
  for (const j of [cap.checkpoint, cap.older, cap.commitment]) checkSigners(j, authorities);

  const headerScale = await fetchHeaderScale(c.api, H);
  const hdr = decodeHeader(headerScale);
  if (hdr.hash !== mirror.blockHash(H)) throw new Error("header hash differs from the mirror");
  const mmrProof = mirror.proof(H, C);
  if (!verifyLeafProof(cap.commitment.mmrRoot, leafHash(H, hdr.hash), mmrProof)) throw new Error("header proof fails");

  if ((await validatorSetIdAt(c.api, H)) !== cap.setId) throw new Error("header is outside the commitment's session");
  const storageProof = await readProof(c.api, [BEEFY_VALIDATOR_SET_ID_KEY, BEEFY_NEXT_AUTHORITIES_KEY], H);
  const next = await authoritiesAt(c.api, H, true);
  const nextKeys = next.map(uncompressKey);

  const fixture: Record<string, unknown> = {
    capturedAt: new Date().toISOString(),
    setId: cap.setId,
    authorities,
    signers: authorities.map((a) => uncompressKey(a).address),
    checkpoint: { blockNumber: cap.sessionStart, mmrRoot: cap.checkpoint.mmrRoot },
    older: commitmentJson(cap.older),
    commitment: commitmentJson(cap.commitment),
    header: {
      number: H,
      hash: hdr.hash,
      stateRoot: hdr.stateRoot,
      headerScale,
      mmrProof: { leafIndex: H, leafCount: C, items: mmrProof.items },
    },
    storage: {
      validatorSetIdKey: BEEFY_VALIDATOR_SET_ID_KEY,
      nextAuthoritiesKey: BEEFY_NEXT_AUTHORITIES_KEY,
      proof: storageProof,
    },
    nextAuthorities: {
      compressed: next,
      x: nextKeys.map((k) => word(k.x)),
      y: nextKeys.map((k) => word(k.y)),
      addresses: nextKeys.map((k) => k.address),
    },
  };

  if (waitNext) {
    const { start, j } = await waitForNextSet(c, cap);
    if (j.commitment.validatorSetId !== cap.setId + 1n) throw new Error("next session's justification has the wrong set");
    checkSigners(j, next);
    const synced = await MmrMirror.sync(c, HASH_CACHE, console.log);
    if (synced.root(start) !== j.mmrRoot) throw new Error("next commitment's MMR root differs from the mirror");
    // The last block of session N, provable only from the next set's commitment.
    const lastScale = await fetchHeaderScale(c.api, start - 1);
    const last = decodeHeader(lastScale);
    const lastProof = synced.proof(start - 1, start);
    fixture.next = commitmentJson(j);
    fixture.nextHeader = {
      number: start - 1,
      hash: last.hash,
      stateRoot: last.stateRoot,
      headerScale: lastScale,
      mmrProof: { leafIndex: start - 1, leafCount: start, items: lastProof.items },
    };
  }
  writeFixture("portaldot-beefy.json", fixture);
}

// ------------------------------------------------------------------ revive storage

const GENERIC_CONTRACT: Hex = "0x04570accab9f6fa3637ae0bbbedfb9d46440d297";
const GENERIC_TRIE_ID: Hex = "0xf8244662038395131abadc58f715834defcb7df28233a1abefc887d4e7bc4253";
/** A live ERC-20 on Portaldot whose `balanceOf` mapping is slot 0, the same layout as the Outbox. */
const SLOT0_MAPPING_CONTRACT: Hex = "0x1d0c17a0ee1dcf15bd05a45ae789058a0586aa68";
const SLOT0_MAPPING_HOLDER: Hex = "0xc3439de80429265793325a6b662232043ced04b6";

async function childValue(c: PortaldotClient, trieId: Hex, slot: Hex, n: number): Promise<Hex | null> {
  const v = await c.api.rpc.childstate.getStorage(
    childInfoKey(trieId),
    reviveSlotKey(slot),
    await c.api.rpc.chain.getBlockHash(n),
  );
  return v.isSome ? (v.unwrap().toHex() as Hex) : null;
}

async function storageFixture(c: PortaldotClient, cap: Capture): Promise<void> {
  const H = cap.headerNumber;
  const now = BigInt((await (await at(c, H)).query.timestamp.now()).toString());

  const contract = async (address: Hex) => {
    const trieId = await trieIdOf(c.api, address, H);
    return {
      address,
      trieId,
      accountInfoKey: accountInfoKey(address),
      accountInfoProof: await buildBindProof(c.api, address, H),
    };
  };

  // Generic slot reads on a live contract: slot 0 holds a value, slot 0x..ff does not.
  const generic = await contract(GENERIC_CONTRACT);
  if (generic.trieId !== GENERIC_TRIE_ID) throw new Error(`unexpected trieId ${generic.trieId}`);
  const slot0 = word(0n);
  const emptySlot = word(0xffn);
  const slot0Value = await childValue(c, generic.trieId, slot0, H);
  if (!slot0Value || BigInt(slot0Value) === 0n) throw new Error("slot 0 is empty");
  if ((await childValue(c, generic.trieId, emptySlot, H)) !== null) throw new Error("empty slot is set");
  const genericMain = await readProof(c.api, [childInfoKey(generic.trieId)], H);
  const slotEntry = async (slot: Hex, value: Hex | null) => ({
    slot,
    key: reviveSlotKey(slot),
    value: value ?? word(0n),
    present: value !== null,
    childProof: await childReadProof(c.api, generic.trieId, [reviveSlotKey(slot)], H, genericMain),
  });

  // Outbox semantics on a live mapping at slot 0: commitments[key] lives at keccak256(key ‖ 0).
  const mapping = await contract(SLOT0_MAPPING_CONTRACT);
  const key = word(BigInt(SLOT0_MAPPING_HOLDER));
  const value = await childValue(c, mapping.trieId, outboxSlot(key), H);
  if (!value || BigInt(value) === 0n) throw new Error("holder has no balance at H");
  const absentKey = toHex(keccakAsU8a("backhaul: never committed"));
  if ((await childValue(c, mapping.trieId, outboxSlot(absentKey), H)) !== null) throw new Error("absent key is set");

  writeFixture("portaldot-storage.json", {
    headerNumber: H,
    stateRoot: decodeHeader(await fetchHeaderScale(c.api, H)).stateRoot,
    timestampKey: TIMESTAMP_NOW_KEY,
    timestampMs: now,
    generic: {
      ...generic,
      childInfoKey: childInfoKey(generic.trieId),
      mainProof: genericMain,
      slot: await slotEntry(slot0, slot0Value),
      emptySlot: await slotEntry(emptySlot, null),
    },
    mapping: {
      ...mapping,
      key,
      value,
      slot: outboxSlot(key),
      commitmentProof: await buildCommitmentProof(c.api, mapping.address, key, H),
      absentKey,
      absenceProof: await buildAbsenceProof(c.api, mapping.address, absentKey, H),
      presentAbsenceProof: await buildAbsenceProof(c.api, mapping.address, key, H),
    },
  });
}

// ------------------------------------------------------------------ main

const args = process.argv.slice(2);
const pinIdx = args.indexOf("--commitment");
const pinned = pinIdx >= 0 ? Number(args[pinIdx + 1]) : undefined;
const tasks = new Set(args.filter((a, i) => !a.startsWith("--") && (pinIdx < 0 || i !== pinIdx + 1)));
if (tasks.size === 0) {
  throw new Error("usage: fixtures-portaldot.ts <header|blake2|mmr|beefy|storage> [--commitment N] [--wait-next]");
}

if (tasks.has("blake2")) blake2();
const needsChain = ["header", "mmr", "beefy", "storage"].some((t) => tasks.has(t));
if (needsChain) {
  const c = await connectPortaldot();
  try {
    if (tasks.has("header")) await header(c);
    if (tasks.has("mmr") || tasks.has("beefy") || tasks.has("storage")) {
      const cap = await capture(c, pinned);
      const mirror = await MmrMirror.sync(c, HASH_CACHE, console.log);
      if (tasks.has("mmr")) mmrFixture(mirror, cap);
      if (tasks.has("storage")) await storageFixture(c, cap);
      if (tasks.has("beefy")) await beefyFixture(c, mirror, cap, args.includes("--wait-next"));
    }
  } finally {
    await disconnectPortaldot(c);
  }
}
