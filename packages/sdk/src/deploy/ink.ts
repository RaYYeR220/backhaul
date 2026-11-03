// Optional deploy step: the ink! twin of the Parlia light client on pallet-contracts, uploaded and
// instantiated in one contracts.instantiateWithCode signed by the ops sr25519 key, from the same
// checkpoint as the EVM ParliaClient.

import type { ApiPromise } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { getAddress, type Hex } from 'viem';
import type { ParliaCheckpoint } from '../bsc/checkpoint.js';
import { BSC_CHAIN_ID } from '../chains.js';
import { codeParam, encodeInkConstructor, inkDryRunInstantiate, inkInstantiateWithCode, loadInkArtifact, type Weight } from '../ink/parlia.js';

/** The checkpoint as deployments/portaldot.json keeps it (bigints may come back as strings). */
export function checkpointFromMeta(m: unknown): ParliaCheckpoint {
  const c = m as Record<string, unknown> | undefined;
  if (!c || c.epoch === undefined) throw new Error('no Parlia checkpoint recorded; deploy ParliaClient first');
  return {
    epoch: BigInt(c.epoch as string),
    timestamp: BigInt(c.timestamp as string),
    activeFrom: BigInt(c.activeFrom as string),
    turnLength: Number(c.turnLength),
    validators: (c.validators as string[]).map((v) => getAddress(v)),
  };
}

export interface InkQuote {
  wasmBytes: number;
  codeHash: Hex;
  data: Hex;
  /** ContractsApi_instantiate accepted the code and the constructor. */
  ok: boolean;
  /** Why not, with the node's debug message when it gave one. */
  reason?: string;
  gasRequired?: Weight;
  /** planck (14 decimals): from the dry-run when ok, else from the model. */
  deposit: bigint;
  depositMethod: string;
  /** Transaction fee of the instantiateWithCode extrinsic (planck), from paymentInfo. */
  fee: bigint;
}

/** Fallback gas limit when the dry-run cannot tell (the constructor writes one set). */
const DEFAULT_GAS: Weight = { refTime: 50_000_000_000n, proofSize: 1_000_000n };

/**
 * Prices the ink! deploy without sending anything: a ContractsApi_instantiate dry-run, and
 * paymentInfo for the extrinsic. If the chain refuses the code, the deposit falls back to the
 * chain's own constants: code bytes × DepositPerByte plus the code-hash lockup, and four items.
 */
export async function quoteInkDeploy(api: ApiPromise, origin: string, cp: ParliaCheckpoint, trustingPeriod: bigint): Promise<InkQuote> {
  const art = loadInkArtifact();
  const data = encodeInkConstructor(BSC_CHAIN_ID, 1000n, trustingPeriod, cp);
  const dry = await inkDryRunInstantiate(api, origin, art.wasm, data);
  const ok = !dry.dispatchError && !dry.reverted;
  const gas = ok ? dry.gasRequired : DEFAULT_GAS;
  const tx = (api.tx as any).contracts.instantiateWithCode(0, { refTime: gas.refTime, proofSize: gas.proofSize }, null, codeParam(art.wasm), data, '0x');
  const fee = BigInt((await tx.paymentInfo(origin)).partialFee.toString());
  const quote: InkQuote = { wasmBytes: art.bytes, codeHash: art.codeHash, data, ok, gasRequired: ok ? dry.gasRequired : undefined, deposit: 0n, depositMethod: '', fee };
  if (ok) {
    quote.deposit = dry.storageDeposit;
    quote.depositMethod = 'ContractsApi_instantiate dry-run';
    return quote;
  }
  if (dry.dispatchError) {
    const r: any = await (api.call as any).contractsApi.instantiate(origin, 0, null, null, { Upload: codeParam(art.wasm) }, data, '0x');
    const debug = new TextDecoder().decode(r.debugMessage.toU8a(true));
    quote.reason = `${dry.dispatchError}${debug ? ` ("${debug}")` : ''}`;
  } else quote.reason = 'the constructor reverted';
  const c = (api.consts as any).contracts;
  const perByte = BigInt(c.depositPerByte.toString());
  const perItem = BigInt(c.depositPerItem.toString());
  const lockup = BigInt(Math.round(Number(c.codeHashLockupDepositPercent.toString()) / 1e7)); // Perbill → %
  const code = BigInt(art.bytes) * perByte;
  quote.deposit = code + (code * lockup) / 100n + 4n * perItem;
  quote.depositMethod = `model: ${art.bytes} B × DepositPerByte + ${lockup}% lockup + 4 items`;
  return quote;
}

/**
 * Uploads and instantiates the ink! client. Prices it first and refuses to send when the chain
 * would reject it, so a refused upload costs nothing.
 */
export async function deployInk(
  api: ApiPromise,
  ops: KeyringPair,
  cp: ParliaCheckpoint,
  trustingPeriod: bigint,
  log: (m: string) => void,
): Promise<{ address: string; hash: Hex; block: number; quote: InkQuote }> {
  const quote = await quoteInkDeploy(api, ops.address, cp, trustingPeriod);
  if (!quote.ok) throw new Error(`pallet-contracts would refuse the ink! client: ${quote.reason}. Nothing was sent.`);
  log(`ink! client: ${quote.wasmBytes} B wasm, deposit ${quote.deposit} planck, fee ${quote.fee} planck`);
  const gas = quote.gasRequired!;
  const r = await inkInstantiateWithCode(api, ops, loadInkArtifact().wasm, quote.data, {
    gasLimit: { refTime: (gas.refTime * 12n) / 10n, proofSize: (gas.proofSize * 12n) / 10n },
    storageDepositLimit: (quote.deposit * 11n) / 10n,
  });
  return { ...r, quote };
}
