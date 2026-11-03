// Finality windows for the Parlia light client: the shortest run of consecutive headers starting
// at a given block that the ParliaClient contract will accept.

import { getAddress, type Address, type Hex } from 'viem';
import { BSC_TESTNET_CHAIN_ID, BscClient } from './client.js';
import { decodeHeader, headerRlp, parseEpochExtra, quorum, sealerOf, switchOffset } from './header.js';

/** A trusted validator set as the contract holds it (see ParliaClient.validatorSet()). */
export interface TrustedSet {
  validators: Address[];
  turnLength: number;
  /** Epoch block that announced the set. */
  epoch: bigint;
  /** First height the set seals. */
  activeFrom: bigint;
}

/** Anything that can hand out consecutive header RLPs. */
export interface HeaderSource {
  headerRlps(from: bigint, count: number): Promise<Hex[]>;
}

export interface WindowOptions {
  chainId?: bigint | number;
  epochLength?: bigint;
  /** The set trusted before the last rotation, if the contract still holds one. */
  previous?: TrustedSet;
  /** Give up after this many headers. */
  maxHeaders?: number;
  /** Headers fetched per request. */
  chunk?: number;
  /**
   * In a window that crosses no switch the client knows about, let seals from validators outside
   * the trusted set through without counting them, as ParliaClient does (default true). Set false
   * to refuse them instead, for a client that rejects such seals.
   */
  tolerateUntrusted?: boolean;
}

export class WindowError extends Error {}

/** A header in the window is sealed by a validator the client does not accept at that height. */
export class UntrustedSealError extends WindowError {
  constructor(
    readonly blockNumber: bigint,
    readonly signer: Address,
  ) {
    super(`block ${blockNumber} is sealed by ${signer}, outside the set the client holds for it`);
  }
}

/** How many members of `live` the client trusts. */
export function trustedOverlap(trusted: readonly Address[], live: readonly Address[]): number {
  const t = new Set(trusted.map((a) => getAddress(a)));
  return live.filter((a) => t.has(getAddress(a))).length;
}

/** Header source backed by a BSC node; every RLP is checked against the block hash. */
export function rpcHeaderSource(client: BscClient): HeaderSource {
  return {
    async headerRlps(from, count) {
      return (await client.blocks(from, count)).map(headerRlp);
    },
  };
}

interface Plan {
  pre: Set<string>;
  post: Set<string>;
  switchAt: bigint;
  need: number;
}

function plan(startNumber: bigint, startExtra: Hex, set: TrustedSet, opts: WindowOptions, epochLength: bigint): Plan {
  const norm = (vs: Address[]) => new Set(vs.map((v) => getAddress(v)));
  if (startNumber % epochLength === 0n && startNumber > set.epoch) {
    const announced = parseEpochExtra(startExtra);
    return {
      pre: norm(set.validators),
      post: norm(announced.validators),
      switchAt: startNumber + BigInt(switchOffset(set.validators.length, set.turnLength)),
      need: quorum(set.validators.length),
    };
  }
  if (startNumber >= set.activeFrom) {
    return { pre: norm(set.validators), post: new Set(), switchAt: 2n ** 64n, need: quorum(set.validators.length) };
  }
  const prev = opts.previous;
  if (prev && startNumber >= prev.activeFrom) {
    return {
      pre: norm(prev.validators),
      post: norm(set.validators),
      switchAt: set.activeFrom,
      need: quorum(prev.validators.length),
    };
  }
  throw new WindowError(`block ${startNumber} is below every trusted set`);
}

/**
 * Collects headers from `startNumber` until ⌈2N/3⌉ distinct members of the trusted set have
 * sealed. Only trusted signers count. In a plain window (no switch in it) other sealers are
 * passed over, as the contract does; in a window across a switch every seal must belong to the
 * set the contract holds for its height.
 * Throws {@link WindowError} when the contract would reject the window — typically because the
 * validator set changed in an epoch the contract has not seen yet, which must be submitted first.
 */
export async function buildWindow(
  source: BscClient | HeaderSource,
  startNumber: bigint,
  set: TrustedSet,
  opts: WindowOptions = {},
): Promise<Hex[]> {
  const src = source instanceof BscClient ? rpcHeaderSource(source) : source;
  const chainId = opts.chainId ?? BSC_TESTNET_CHAIN_ID;
  const epochLength = opts.epochLength ?? 1000n;
  const maxHeaders = opts.maxHeaders ?? 256;
  const chunk = opts.chunk ?? 16;
  const tolerate = opts.tolerateUntrusted ?? true;

  const window: Hex[] = [];
  const signers = new Set<string>();
  let p: Plan | undefined;
  let next = startNumber;
  while (window.length < maxHeaders) {
    const batch = await src.headerRlps(next, Math.min(chunk, maxHeaders - window.length));
    if (batch.length === 0) break;
    for (const rlp of batch) {
      const h = decodeHeader(rlp);
      if (h.number !== startNumber + BigInt(window.length)) throw new WindowError(`expected block ${next}, got ${h.number}`);
      p ??= plan(startNumber, h.extra, set, opts, epochLength);
      const signer = await sealerOf(rlp, chainId);
      if (signer !== h.coinbase) throw new WindowError(`block ${h.number}: sealer ${signer} is not the coinbase`);
      const allowed = h.number < p.switchAt ? p.pre : p.post;
      if (!allowed.has(signer) && !(tolerate && p.post.size === 0)) throw new UntrustedSealError(h.number, signer);
      window.push(rlp);
      if (p.pre.has(signer)) signers.add(signer);
      if (signers.size >= p.need) return window;
    }
    next = startNumber + BigInt(window.length);
  }
  throw new WindowError(`no quorum within ${window.length} headers from ${startNumber}`);
}
