import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ApiPromise } from "@polkadot/api";
import type { ProviderInterface } from "@polkadot/rpc-provider/types";
import { keccakAsU8a, secp256k1Compress, secp256k1Expand, secp256k1Recover } from "@polkadot/util-crypto";
import { u8aConcat, u8aEq } from "@polkadot/util";
import { ScaleReader, toHex, toU8a, type Hex } from "./scale";

/** Payload id of the MMR root inside a BEEFY commitment ("mh"). */
export const MMR_ROOT_PAYLOAD_ID: Hex = "0x6d68";
/** Consensus engine id of BEEFY justifications stored in block bodies ("BEEF"). */
export const BEEFY_ENGINE_ID: Hex = "0x42454546";

export interface BeefyCommitment {
  payload: { id: Hex; data: Hex }[];
  blockNumber: number;
  validatorSetId: bigint;
}

export interface DecodedJustification {
  commitment: BeefyCommitment;
  /** Exact SCALE bytes of the commitment; keccak256 of these is what the validators signed. */
  commitmentScale: Hex;
  mmrRoot: Hex;
  validatorSetLen: number;
  /** Validator indices that signed, ascending. */
  indices: number[];
  /** 65-byte signatures (r ‖ s ‖ v) in the same order as `indices`. */
  signatures: Hex[];
}

/** Arguments for `PortaldotLightClient.submitCommitment`. */
export interface EncodedCommitment {
  commitmentScale: Hex;
  indices: bigint[];
  signatures: Hex[];
}

function decodeCommitment(r: ScaleReader): BeefyCommitment {
  const n = r.compactNumber();
  const payload: { id: Hex; data: Hex }[] = [];
  for (let i = 0; i < n; i++) {
    const id = toHex(r.take(2));
    payload.push({ id, data: toHex(r.bytesVec()) });
  }
  const blockNumber = r.u32();
  const validatorSetId = r.u64();
  return { payload, blockNumber, validatorSetId };
}

/**
 * Decodes a BEEFY justification as served by `beefy_subscribeJustifications` and stored in block
 * bodies: `0x01 ‖ CompactSignedCommitment`. The bitfield `signaturesFrom` is MSB-first: validator 0
 * is bit 7 of byte 0.
 */
export function decodeJustification(raw: Hex | Uint8Array): DecodedJustification {
  const bytes = toU8a(raw);
  const r = new ScaleReader(bytes);
  const version = r.u8();
  if (version !== 1) throw new Error(`unsupported BEEFY finality proof version ${version}`);
  const start = r.offset;
  const commitment = decodeCommitment(r);
  const commitmentScale = toHex(bytes.subarray(start, r.offset));
  const bitfield = r.bytesVec();
  const validatorSetLen = r.u32();
  const sigCount = r.compactNumber();
  const signatures: Hex[] = [];
  for (let i = 0; i < sigCount; i++) signatures.push(toHex(r.take(65)));
  r.end();

  const indices: number[] = [];
  for (let i = 0; i < validatorSetLen; i++) {
    const byte = bitfield[i >> 3];
    if (byte === undefined) throw new Error("bitfield shorter than validator set");
    if ((byte >> (7 - (i & 7))) & 1) indices.push(i);
  }
  if (indices.length !== signatures.length) {
    throw new Error(`bitfield marks ${indices.length} signers but ${signatures.length} signatures present`);
  }
  const mh = commitment.payload.find((p) => p.id === MMR_ROOT_PAYLOAD_ID);
  if (!mh || toU8a(mh.data).length !== 32) throw new Error("commitment has no 32-byte MMR root payload");
  return { commitment, commitmentScale, mmrRoot: mh.data, validatorSetLen, indices, signatures };
}

/** Turns a justification into the calldata of `submitCommitment`. */
export function encodeCommitment(justification: Hex | Uint8Array | DecodedJustification): EncodedCommitment {
  const j = typeof justification === "object" && "commitmentScale" in justification
    ? justification
    : decodeJustification(justification);
  return {
    commitmentScale: j.commitmentScale,
    indices: j.indices.map((i) => BigInt(i)),
    signatures: j.signatures,
  };
}

/** keccak256(SCALE(commitment)), the message every BEEFY validator signs. */
export function commitmentHash(j: DecodedJustification): Uint8Array {
  return keccakAsU8a(toU8a(j.commitmentScale));
}

/** Recovers the 33-byte compressed key of each signature. */
export function recoverSigners(j: DecodedJustification): Hex[] {
  const msg = commitmentHash(j);
  return j.signatures.map((s) => {
    const sig = toU8a(s);
    const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
    return toHex(secp256k1Compress(secp256k1Recover(msg, sig.subarray(0, 64), v)));
  });
}

export interface UncompressedKey {
  compressed: Hex;
  x: bigint;
  y: bigint;
  /** Ethereum-style address: keccak256(x ‖ y)[12:]. */
  address: Hex;
}

/** Expands a 33-byte compressed secp256k1 key into its affine coordinates and address. */
export function uncompressKey(compressed: Hex | Uint8Array): UncompressedKey {
  const c = toU8a(compressed);
  if (c.length !== 33) throw new Error("expected a 33-byte compressed key");
  const xy = secp256k1Expand(c);
  if (!u8aEq(secp256k1Compress(u8aConcat(new Uint8Array([4]), xy)), c)) throw new Error("key does not round-trip");
  const x = BigInt(toHex(xy.subarray(0, 32)));
  const y = BigInt(toHex(xy.subarray(32, 64)));
  const address = toHex(keccakAsU8a(xy).subarray(12));
  return { compressed: toHex(c), x, y, address };
}

/** Decodes a SCALE `Vec<ecdsa::Public>` (Beefy::Authorities / Beefy::NextAuthorities). */
export function decodeAuthorities(raw: Hex | Uint8Array): Hex[] {
  const r = new ScaleReader(toU8a(raw));
  const n = r.compactNumber();
  const out: Hex[] = [];
  for (let i = 0; i < n; i++) out.push(toHex(r.take(33)));
  r.end();
  return out;
}

export interface ArchiveEntry {
  blockNumber: number;
  validatorSetId: string;
  mmrRoot: Hex;
  proof: Hex;
  source: "subscription" | "block";
  receivedAt: string;
}

/**
 * Append-only JSONL archive of BEEFY justifications.
 *
 * The node keeps non-mandatory justifications only for the current session, so a relayer that
 * wants to prove headers from a past session must have recorded a commitment while it was fresh.
 * Mandatory justifications (first block of each session) stay in block bodies and can be
 * backfilled with `recordFromBlock`.
 */
export class JustificationArchive {
  private readonly byBlock = new Map<number, ArchiveEntry>();

  private constructor(readonly path: string) {}

  static open(path: string): JustificationArchive {
    const a = new JustificationArchive(path);
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as ArchiveEntry;
        if (!a.byBlock.has(e.blockNumber)) a.byBlock.set(e.blockNumber, e);
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
    return a;
  }

  /** Records a justification; returns the entry, or undefined if that block was already archived. */
  append(proof: Hex, source: ArchiveEntry["source"]): ArchiveEntry | undefined {
    const j = decodeJustification(proof);
    if (this.byBlock.has(j.commitment.blockNumber)) return undefined;
    const e: ArchiveEntry = {
      blockNumber: j.commitment.blockNumber,
      validatorSetId: j.commitment.validatorSetId.toString(),
      mmrRoot: j.mmrRoot,
      proof,
      source,
      receivedAt: new Date().toISOString(),
    };
    appendFileSync(this.path, JSON.stringify(e) + "\n");
    this.byBlock.set(e.blockNumber, e);
    return e;
  }

  /** Fetches the justification stored in a block body (mandatory blocks keep theirs) and archives it. */
  async recordFromBlock(api: ApiPromise, blockNumber: number): Promise<ArchiveEntry | undefined> {
    const proof = await fetchStoredJustification(api, blockNumber);
    return proof ? (this.append(proof, "block") ?? this.byBlock.get(blockNumber)) : undefined;
  }

  /** Streams justifications from the node into the archive until the returned function is called. */
  async subscribe(provider: ProviderInterface, onEntry?: (e: ArchiveEntry) => void): Promise<() => Promise<void>> {
    const id = await provider.subscribe(
      "beefy_justifications",
      "beefy_subscribeJustifications",
      [],
      (err: Error | null, result: unknown) => {
        if (err || typeof result !== "string") return;
        const e = this.append(result as Hex, "subscription");
        if (e && onEntry) onEntry(e);
      },
    );
    return async () => {
      await provider.unsubscribe("beefy_justifications", "beefy_unsubscribeJustifications", id);
    };
  }

  get(blockNumber: number): ArchiveEntry | undefined {
    return this.byBlock.get(blockNumber);
  }

  entries(): ArchiveEntry[] {
    return [...this.byBlock.values()].sort((a, b) => a.blockNumber - b.blockNumber);
  }

  forSet(validatorSetId: bigint | number): ArchiveEntry[] {
    const id = BigInt(validatorSetId).toString();
    return this.entries().filter((e) => e.validatorSetId === id);
  }

  latest(): ArchiveEntry | undefined {
    const all = this.entries();
    return all[all.length - 1];
  }
}

/** The BEEFY justification stored in a block body, if any. */
export async function fetchStoredJustification(api: ApiPromise, blockNumber: number): Promise<Hex | undefined> {
  const hash = await api.rpc.chain.getBlockHash(blockNumber);
  const block = await api.rpc.chain.getBlock(hash);
  if (block.justifications.isNone) return undefined;
  const j = block.justifications.unwrap().find(([engine]) => engine.toHex() === BEEFY_ENGINE_ID);
  return j ? (j[1].toHex() as Hex) : undefined;
}
