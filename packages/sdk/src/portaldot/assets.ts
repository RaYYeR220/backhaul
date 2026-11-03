// BNB.b: a pallet-assets asset on Portaldot whose whole fixed supply, and every role over it,
// belongs to the PortaldotGateway contract. Each step checks the chain first, so the setup can
// be re-run after a crash and only does what is missing.

import type { ApiPromise } from '@polkadot/api';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import type { KeyringPair } from '@polkadot/keyring/types';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import type { Address, Hex } from 'viem';
import { accountId32Of, assetPrecompile } from '../chains.js';

export interface BnbbParams {
  assetId: number;
  /** The PortaldotGateway's EVM address. */
  gateway: Address;
  /** Fixed supply in 18-decimal units. */
  supply: bigint;
  name?: string;
  symbol?: string;
  decimals?: number;
  minBalance?: bigint;
}

export interface BnbbStatus {
  exists: boolean;
  owner?: Hex;
  issuer?: Hex;
  admin?: Hex;
  freezer?: Hex;
  supply: bigint;
  isSufficient?: boolean;
  metadata?: { name: string; symbol: string; decimals: number };
  gatewayBalance: bigint;
  precompile: Address;
}

export interface StepResult {
  step: string;
  /** Extrinsic hash, or undefined if the step was already done. */
  hash?: Hex;
  block?: number;
  skipped?: boolean;
}

export async function opsKeyFromMnemonic(mnemonic: string): Promise<KeyringPair> {
  await cryptoWaitReady();
  return new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromMnemonic(mnemonic);
}

const hexOf = (v: { toU8a(): Uint8Array }): Hex => u8aToHex(v.toU8a()) as Hex;

export async function bnbbStatus(api: ApiPromise, assetId: number, gateway: Address): Promise<BnbbStatus> {
  const gw = accountId32Of(gateway);
  const details = (await api.query.assets.asset(assetId)) as any;
  const precompile = assetPrecompile(assetId);
  if (details.isNone) return { exists: false, supply: 0n, gatewayBalance: 0n, precompile };
  const d = details.unwrap();
  const meta = (await api.query.assets.metadata(assetId)) as any;
  const acct = (await api.query.assets.account(assetId, gw)) as any;
  const decode = (b: any) => new TextDecoder().decode(b.toU8a(true));
  return {
    exists: true,
    owner: hexOf(d.owner),
    issuer: hexOf(d.issuer),
    admin: hexOf(d.admin),
    freezer: hexOf(d.freezer),
    supply: BigInt(d.supply.toString()),
    isSufficient: d.isSufficient.isTrue,
    metadata: meta.deposit.isZero() && meta.name.length === 0
      ? undefined
      : { name: decode(meta.name), symbol: decode(meta.symbol), decimals: meta.decimals.toNumber() },
    gatewayBalance: acct.isSome ? BigInt(acct.unwrap().balance.toString()) : 0n,
    precompile,
  };
}

/** Signs and sends `tx`, resolving once it is in a block; rejects on a dispatch error. */
export function sendAndWait(api: ApiPromise, tx: SubmittableExtrinsic<'promise'>, signer: KeyringPair): Promise<{ hash: Hex; block: number }> {
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        unsub?.();
        if (dispatchError.isModule) {
          const m = api.registry.findMetaError(dispatchError.asModule);
          reject(new Error(`${m.section}.${m.name}: ${m.docs.join(' ')}`));
        } else reject(new Error(dispatchError.toString()));
        return;
      }
      if (status.isInBlock) {
        unsub?.();
        const failed = events.find(({ event }) => api.events.system.ExtrinsicFailed.is(event));
        if (failed) return reject(new Error(`extrinsic failed: ${failed.event.data.toString()}`));
        api.rpc.chain
          .getHeader(status.asInBlock)
          .then((h) => resolve({ hash: tx.hash.toHex() as Hex, block: h.number.toNumber() }))
          .catch(reject);
      }
    })
      .then((u) => {
        unsub = u;
      })
      .catch(reject);
  });
}

/**
 * Creates BNB.b and hands it to the gateway:
 * create → set_metadata → mint the whole supply to the gateway → set_team(gw, gw, gw) → transfer_ownership(gw).
 * The ops key ends with nothing over the asset.
 */
export async function setupBnbb(
  api: ApiPromise,
  ops: KeyringPair,
  p: BnbbParams,
  log: (m: string) => void = () => {},
): Promise<StepResult[]> {
  const gw = accountId32Of(p.gateway);
  const opsHex = u8aToHex(ops.publicKey) as Hex;
  const name = p.name ?? 'Bridged BNB';
  const symbol = p.symbol ?? 'BNB.b';
  const decimals = p.decimals ?? 18;
  const out: StepResult[] = [];
  const step = async (label: string, needed: boolean, make: () => SubmittableExtrinsic<'promise'>) => {
    if (!needed) {
      out.push({ step: label, skipped: true });
      log(`${label}: already done`);
      return;
    }
    log(`${label}: sending`);
    const r = await sendAndWait(api, make(), ops);
    out.push({ step: label, hash: r.hash, block: r.block });
    log(`${label}: in block ${r.block} (${r.hash})`);
  };

  let s = await bnbbStatus(api, p.assetId, p.gateway);
  if (s.exists && s.owner !== opsHex && s.owner !== gw) {
    throw new Error(`asset ${p.assetId} already exists and belongs to ${s.owner}`);
  }
  await step('create', !s.exists, () => api.tx.assets.create(p.assetId, ops.address, p.minBalance ?? 1n));
  s = await bnbbStatus(api, p.assetId, p.gateway);
  const ownedByOps = s.owner === opsHex;
  await step('setMetadata', ownedByOps && !s.metadata, () => api.tx.assets.setMetadata(p.assetId, name, symbol, decimals));
  await step('mint', ownedByOps && s.supply === 0n, () => api.tx.assets.mint(p.assetId, gw, p.supply));
  s = await bnbbStatus(api, p.assetId, p.gateway);
  const teamDone = s.issuer === gw && s.admin === gw && s.freezer === gw;
  await step('setTeam', s.owner === opsHex && !teamDone, () => api.tx.assets.setTeam(p.assetId, gw, gw, gw));
  await step('transferOwnership', s.owner === opsHex, () => api.tx.assets.transferOwnership(p.assetId, gw));

  s = await bnbbStatus(api, p.assetId, p.gateway);
  const ok = s.owner === gw && s.issuer === gw && s.admin === gw && s.freezer === gw && s.gatewayBalance === p.supply && s.supply === p.supply;
  if (!ok) throw new Error(`BNB.b setup incomplete: ${JSON.stringify(s, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  return out;
}

/**
 * Sends native tPOT to a contract's substrate account directly (balances.transfer_keep_alive), for
 * contracts whose `receive` rejects native value but that need free balance, e.g. for the
 * approval deposit the assets precompile reserves on `approve`. `amount` is in planck (14 decimals).
 */
export async function fundContractAccount(
  api: ApiPromise,
  ops: KeyringPair,
  contract: Address,
  planck: bigint,
): Promise<{ hash: Hex; block: number }> {
  return sendAndWait(api, api.tx.balances.transferKeepAlive(accountId32Of(contract), planck), ops);
}

export async function freeBalance(api: ApiPromise, account: string): Promise<bigint> {
  const a = (await api.query.system.account(account)) as any;
  return BigInt(a.data.free.toString());
}
