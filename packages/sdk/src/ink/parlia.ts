// The ink! twin of the Parlia light client (ink/parlia_client) on Portaldot's pallet-contracts:
// SCALE encoding of its messages, result decoding, dry-runs and deployment.
//
// Messages are `selector ‖ SCALE(args)`, with selector = blake2b-256(label)[0..4] (ink! 5 without
// explicit selectors). Results come back as Result<Result<T, Error>, LangError>.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ApiPromise } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { bnToU8a, compactToU8a, hexToU8a, u8aConcat, u8aToHex } from '@polkadot/util';
import { blake2AsHex, blake2AsU8a } from '@polkadot/util-crypto';
import { getAddress, type Address, type Hex } from 'viem';
import type { ParliaCheckpoint } from '../bsc/checkpoint.js';

export const INK_CRATE_DIR = resolve(import.meta.dirname, '../../../../ink/parlia_client');
export const INK_ARTIFACT_DIR = resolve(INK_CRATE_DIR, 'target/ink');

/** Variants of the contract's `Error`, in declaration order. */
export const INK_ERRORS = [
  'EmptyWindow',
  'BrokenLink',
  'CoinbaseMismatch',
  'UnauthorizedSigner',
  'TooFewSigners',
  'BeforeTrustedSet',
  'TrustingPeriodExpired',
  'AlreadyFinalized',
  'NotFinalized',
  'InvalidCheckpoint',
  'InvalidValidatorSet',
  'InvalidRlp',
  'InvalidHeader',
  'InvalidSignature',
  'InvalidEpochExtra',
  'IncompleteProof',
  'InvalidProof',
  'InvalidAccount',
] as const;

/** ink! 5 selector of a constructor or message without an explicit selector. */
export function inkSelector(label: string): Uint8Array {
  return blake2AsU8a(label, 256).slice(0, 4);
}

const u64 = (n: bigint | number) => bnToU8a(BigInt(n), { bitLength: 64, isLe: true });
const bytes = (b: Uint8Array) => u8aConcat(compactToU8a(b.length), b);
const vecBytes = (list: readonly (Hex | Uint8Array)[]) =>
  u8aConcat(compactToU8a(list.length), ...list.map((x) => bytes(typeof x === 'string' ? hexToU8a(x) : x)));
function fixed(hex: Hex, len: number): Uint8Array {
  const b = hexToU8a(hex);
  if (b.length !== len) throw new Error(`expected ${len} bytes, got ${b.length}`);
  return b;
}
const msg = (label: string, ...args: Uint8Array[]): Hex => u8aToHex(u8aConcat(inkSelector(label), ...args)) as Hex;

/** `new(chain_id, epoch_length, trusting_period, checkpoint)`: the ParliaClient.sol constructor's arguments. */
export function encodeInkConstructor(chainId: bigint | number, epochLength: bigint, trustingPeriod: bigint, cp: ParliaCheckpoint): Hex {
  return msg(
    'new',
    u64(chainId),
    u64(epochLength),
    u64(trustingPeriod),
    u64(cp.epoch),
    u64(cp.timestamp),
    u64(cp.activeFrom),
    Uint8Array.of(cp.turnLength),
    compactToU8a(cp.validators.length),
    ...cp.validators.map((v) => fixed(v, 20)),
  );
}

/** `submit_window(headers: Vec<Vec<u8>>)`. */
export function encodeInkSubmitWindow(headers: readonly Hex[]): Hex {
  return msg('submit_window', vecBytes(headers));
}

/** `storage_at(number, account, account_proof, slot, storage_proof)`. */
export function encodeInkStorageAt(number: bigint, account: Address, accountProof: readonly Hex[], slot: Hex, storageProof: readonly Hex[]): Hex {
  return msg('storage_at', u64(number), fixed(account, 20), vecBytes(accountProof), fixed(slot, 32), vecBytes(storageProof));
}

export const encodeInkFinalized = (number: bigint): Hex => msg('finalized', u64(number));
export const encodeInkValidatorSet = (): Hex => msg('validator_set');

// ---- results ----

export type InkResult<T> = { ok: true; value: T } | { ok: false; error: string };

class Reader {
  at = 0;
  constructor(readonly b: Uint8Array) {}
  u8() {
    return this.b[this.at++];
  }
  u32() {
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.at, 4).getUint32(0, true);
    this.at += 4;
    return v;
  }
  u64() {
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.at, 8).getBigUint64(0, true);
    this.at += 8;
    return v;
  }
  take(n: number): Hex {
    const v = u8aToHex(this.b.subarray(this.at, this.at + n)) as Hex;
    this.at += n;
    return v;
  }
  compact(): number {
    const b0 = this.b[this.at];
    const mode = b0 & 3;
    if (mode === 0) return (this.at++, b0 >> 2);
    if (mode === 1) {
      const v = (this.b[this.at] | (this.b[this.at + 1] << 8)) >> 2;
      this.at += 2;
      return v;
    }
    if (mode === 2) return this.u32() >>> 2;
    throw new Error('big compact not supported');
  }
}

function errorOf(r: Reader): string {
  const i = r.u8();
  const name = INK_ERRORS[i] ?? `Error#${i}`;
  switch (name) {
    case 'BrokenLink':
    case 'CoinbaseMismatch':
    case 'AlreadyFinalized':
    case 'NotFinalized':
      return `${name}(${r.u64()})`;
    case 'UnauthorizedSigner':
      return `${name}(${r.u64()}, ${getAddress(r.take(20))})`;
    case 'TooFewSigners':
      return `${name}(${r.u32()}, ${r.u32()})`;
    case 'BeforeTrustedSet':
    case 'TrustingPeriodExpired':
      return `${name}(${r.u64()}, ${r.u64()})`;
    default:
      return name;
  }
}

/** Unwraps the outer Result<_, LangError>. */
function lang(data: Uint8Array): Reader {
  const r = new Reader(data);
  if (r.u8() !== 0) throw new Error(`ink! LangError ${data[1]} (unknown selector or bad input)`);
  return r;
}

/** Result of `submit_window`: the finalized number, or the contract's error. */
export function decodeInkSubmitWindow(data: Uint8Array): InkResult<bigint> {
  const r = lang(data);
  return r.u8() === 0 ? { ok: true, value: r.u64() } : { ok: false, error: errorOf(r) };
}

/** Result of `storage_at`: the slot value (undefined when absent), or the contract's error. */
export function decodeInkStorageAt(data: Uint8Array): InkResult<Hex | undefined> {
  const r = lang(data);
  if (r.u8() !== 0) return { ok: false, error: errorOf(r) };
  return { ok: true, value: r.u8() === 0 ? undefined : r.take(32) };
}

export interface InkTrustedSet {
  validators: Address[];
  turnLength: number;
  epoch: bigint;
  activeFrom: bigint;
  epochTimestamp: bigint;
}

/** Result of `validator_set` / `previous_validator_set`. */
export function decodeInkTrustedSet(data: Uint8Array): InkTrustedSet {
  const r = lang(data);
  const n = r.compact();
  const validators = Array.from({ length: n }, () => getAddress(r.take(20)));
  return { validators, turnLength: r.u8(), epoch: r.u64(), activeFrom: r.u64(), epochTimestamp: r.u64() };
}

// ---- artifact ----

export interface InkArtifact {
  wasm: Uint8Array;
  codeHash: Hex;
  bytes: number;
  path: string;
}

/** Static input buffer the contract needs: a 48-header window is about 45 KB. */
export const INK_MIN_BUFFER = 65_536;

/**
 * Highest i32.const among the module's globals: on ink!'s layout, the end of data + bss
 * (the 64 KiB stack sits below it), which is where the static buffer lives.
 */
export function wasmDataEnd(wasm: Uint8Array): number {
  let at = 8;
  const leb = () => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = wasm[at++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (b < 0x80) return v;
    }
  };
  while (at < wasm.length) {
    const id = wasm[at++];
    const size = leb();
    const end = at + size;
    if (id === 6) {
      let max = 0;
      for (let n = leb(); n > 0; n--) {
        at += 2; // valtype, mutability
        if (wasm[at++] === 0x41) max = Math.max(max, leb()); // i32.const
        while (wasm[at] !== 0x0b) at++;
        at++;
      }
      return max;
    }
    at = end;
  }
  return 0;
}

/** The release build of ink/parlia_client (packages/sdk/scripts/build-ink.ts). */
export function loadInkArtifact(dir = INK_ARTIFACT_DIR): InkArtifact {
  const path = resolve(dir, 'parlia_client.wasm');
  if (!existsSync(path)) throw new Error(`no ${path}; run \`npx tsx packages/sdk/scripts/build-ink.ts\``);
  const wasm = new Uint8Array(readFileSync(path));
  if (wasmDataEnd(wasm) - 65_536 < INK_MIN_BUFFER) {
    throw new Error(`${path} has ink!'s default 16 KiB input buffer and would refuse real windows; rebuild with packages/sdk/scripts/build-ink.ts`);
  }
  // Cross-check the selector rule against the metadata cargo-contract wrote next to the code.
  const meta = resolve(dir, 'parlia_client.json');
  if (existsSync(meta)) {
    const spec = JSON.parse(readFileSync(meta, 'utf8')).spec;
    for (const m of [...spec.constructors, ...spec.messages]) {
      if (m.selector !== u8aToHex(inkSelector(m.label))) throw new Error(`selector of ${m.label} is ${m.selector}, not the blake2 rule`);
    }
  }
  return { wasm, codeHash: blake2AsHex(wasm, 256) as Hex, bytes: wasm.length, path };
}

// ---- dry-runs (ContractsApi) and deployment ----

/**
 * Code as a `Bytes` argument for polkadot.js: hex. A raw Uint8Array is taken as already
 * SCALE-encoded (compact length first), and since wasm starts with 0x00 it becomes empty code,
 * which pallet-contracts answers with CodeRejected ("Can't load the module into wasmi!").
 */
export const codeParam = (wasm: Uint8Array): Hex => u8aToHex(wasm) as Hex;

export interface Weight {
  refTime: bigint;
  proofSize: bigint;
}

export interface InkDryRun {
  gasConsumed: Weight;
  gasRequired: Weight;
  /** Positive: charged; negative: refunded (planck, 14 decimals). */
  storageDeposit: bigint;
  /** Return data (after the REVERT flag check, see `reverted`). */
  data: Uint8Array;
  reverted: boolean;
  /** Dispatch error (trap, out of gas, ...) when the call did not return at all. */
  dispatchError?: string;
  /** Instantiate only: the address it would get. */
  address?: string;
}

const weight = (w: any): Weight => ({ refTime: BigInt(w.refTime.toString()), proofSize: BigInt(w.proofSize.toString()) });
const deposit = (d: any): bigint => (d.isCharge ? BigInt(d.asCharge.toString()) : -BigInt(d.asRefund.toString()));
/** ReturnFlags { bits }: bit 0 is REVERT. */
const reverted = (flags: any): boolean => (Number((flags.bits ?? flags).toString()) & 1) === 1;

function dispatchErrorOf(api: ApiPromise, e: any): string {
  if (e.isModule) {
    const m = api.registry.findMetaError(e.asModule);
    return `${m.section}.${m.name}`;
  }
  return e.toString();
}

/** ContractsApi_instantiate: uploads `wasm` and runs the constructor, without a transaction. */
export async function inkDryRunInstantiate(api: ApiPromise, origin: string, wasm: Uint8Array, data: Hex, salt: Hex = '0x'): Promise<InkDryRun> {
  const r: any = await (api.call as any).contractsApi.instantiate(origin, 0, null, null, { Upload: codeParam(wasm) }, data, salt);
  const out: InkDryRun = {
    gasConsumed: weight(r.gasConsumed),
    gasRequired: weight(r.gasRequired),
    storageDeposit: deposit(r.storageDeposit),
    data: new Uint8Array(),
    reverted: false,
  };
  if (r.result.isErr) out.dispatchError = dispatchErrorOf(api, r.result.asErr);
  else {
    const ok = r.result.asOk;
    out.data = ok.result.data.toU8a(true);
    out.reverted = reverted(ok.result.flags);
    out.address = ok.accountId.toString();
  }
  return out;
}

/** ContractsApi_call: runs a message without a transaction. */
export async function inkDryRunCall(api: ApiPromise, origin: string, dest: string, data: Hex): Promise<InkDryRun> {
  const r: any = await (api.call as any).contractsApi.call(origin, dest, 0, null, null, data);
  const out: InkDryRun = {
    gasConsumed: weight(r.gasConsumed),
    gasRequired: weight(r.gasRequired),
    storageDeposit: deposit(r.storageDeposit),
    data: new Uint8Array(),
    reverted: false,
  };
  if (r.result.isErr) out.dispatchError = dispatchErrorOf(api, r.result.asErr);
  else {
    out.data = r.result.asOk.data.toU8a(true);
    out.reverted = reverted(r.result.asOk.flags);
  }
  return out;
}

/** The transaction fee (planck) of a contracts.call carrying `data` with `gasLimit`, for `origin`. */
export async function inkCallFee(api: ApiPromise, origin: string, dest: string, data: Hex, gasLimit: Weight): Promise<bigint> {
  const tx = api.tx.contracts.call(dest, 0, { refTime: gasLimit.refTime, proofSize: gasLimit.proofSize }, null, data);
  return BigInt((await tx.paymentInfo(origin)).partialFee.toString());
}

/**
 * contracts.instantiateWithCode signed by `signer`: uploads the code and instantiates it in one
 * extrinsic. Resolves with the new contract's address once it is in a block.
 */
export async function inkInstantiateWithCode(
  api: ApiPromise,
  signer: KeyringPair,
  wasm: Uint8Array,
  data: Hex,
  opts: { gasLimit: Weight; storageDepositLimit: bigint; salt?: Hex },
): Promise<{ address: string; hash: Hex; block: number }> {
  const tx = api.tx.contracts.instantiateWithCode(0, { refTime: opts.gasLimit.refTime, proofSize: opts.gasLimit.proofSize }, opts.storageDepositLimit, codeParam(wasm), data, opts.salt ?? '0x');
  return new Promise((resolvePromise, reject) => {
    let unsub: (() => void) | undefined;
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        unsub?.();
        return reject(new Error(dispatchErrorOf(api, dispatchError)));
      }
      if (!status.isInBlock) return;
      unsub?.();
      const inst = events.find(({ event }) => event.section === 'contracts' && event.method === 'Instantiated');
      if (!inst) return reject(new Error('no contracts.Instantiated event'));
      api.rpc.chain
        .getHeader(status.asInBlock)
        .then((h) => resolvePromise({ address: inst.event.data[1].toString(), hash: tx.hash.toHex() as Hex, block: h.number.toNumber() }))
        .catch(reject);
    })
      .then((u) => {
        unsub = u;
      })
      .catch(reject);
  });
}
