// deployments/<chain>.json: every address and deploy transaction, written by scripts/deploy.ts and
// read by the relayer, the attack lab and the app.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getAddress, type Address, type Hex } from 'viem';
import { chainIdOf, type ChainName } from './chains.js';

export const DEFAULT_DEPLOYMENTS_DIR = resolve(import.meta.dirname, '../../../deployments');

export interface DeployedContract {
  /** Forge artifact the code came from. */
  artifact: string;
  address: Address;
  tx?: Hex;
  block?: number;
  /** Constructor arguments, JSON-friendly (bigints as decimal strings). */
  args?: unknown[];
  /** Runtime code size in bytes. */
  codeBytes?: number;
}

export interface StepRecord {
  tx?: Hex;
  block?: number;
  at: string;
  [extra: string]: unknown;
}

export interface Deployment {
  chain: ChainName;
  chainId: number;
  deployer?: Address;
  updatedAt?: string;
  contracts: Record<string, DeployedContract>;
  steps: Record<string, StepRecord>;
  meta: Record<string, unknown>;
}

/** Contract names on each chain, as keys of `Deployment.contracts`. */
export const PORTALDOT_CONTRACTS = [
  'Outbox',
  'ParliaClient',
  'BscVerifier',
  'PortaldotGateway',
  'OriginSettler',
  'DestinationSettler',
  'PotVault',
  'BnbbVault',
  'PotForwarder',
  'BnbbForwarder',
] as const;

export const BSC_CONTRACTS = [
  'Outbox',
  'PortaldotLightClient',
  'PortaldotVerifier',
  'PPOT',
  'BscGateway',
  'OriginSettler',
  'DestinationSettler',
  'PpotVault',
  'BnbVault',
  'PpotForwarder',
  'BnbForwarder',
] as const;

export type PortaldotContract = (typeof PORTALDOT_CONTRACTS)[number];
export type BscContract = (typeof BSC_CONTRACTS)[number];

export function emptyDeployment(chain: ChainName): Deployment {
  return { chain, chainId: chainIdOf(chain), contracts: {}, steps: {}, meta: {} };
}

export function deploymentPath(chain: ChainName, dir = DEFAULT_DEPLOYMENTS_DIR): string {
  return resolve(dir, `${chain}.json`);
}

export function loadDeployment(chain: ChainName, dir = DEFAULT_DEPLOYMENTS_DIR): Deployment {
  const path = deploymentPath(chain, dir);
  if (!existsSync(path)) return emptyDeployment(chain);
  const d = JSON.parse(readFileSync(path, 'utf8')) as Deployment;
  if (d.chainId !== chainIdOf(chain)) throw new Error(`${path} is for chain ${d.chainId}, not ${chain}`);
  d.contracts ??= {};
  d.steps ??= {};
  d.meta ??= {};
  return d;
}

/** Writes atomically (temp file + rename), so a crash never leaves half a JSON file. */
export function saveDeployment(d: Deployment, dir = DEFAULT_DEPLOYMENTS_DIR): string {
  const path = deploymentPath(d.chain, dir);
  mkdirSync(dirname(path), { recursive: true });
  d.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(d, jsonReplacer, 2) + '\n');
  renameSync(tmp, path);
  return path;
}

export function jsonReplacer(_: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

/** Addresses of both sides, as the relayer and the app use them. */
export interface BackhaulAddresses {
  portaldot: Partial<Record<PortaldotContract, Address>> & { bnbb?: Address; bnbbAssetId?: number };
  bsc: Partial<Record<BscContract, Address>>;
}

export function addressesOf(portaldot: Deployment, bsc: Deployment): BackhaulAddresses {
  const pick = (d: Deployment) =>
    Object.fromEntries(Object.entries(d.contracts).map(([k, v]) => [k, getAddress(v.address)])) as Record<string, Address>;
  const bnbb = portaldot.meta.bnbb as { assetId: number; precompile: Address } | undefined;
  return {
    portaldot: { ...pick(portaldot), bnbb: bnbb?.precompile, bnbbAssetId: bnbb?.assetId },
    bsc: pick(bsc),
  };
}

export function loadAddresses(dir = DEFAULT_DEPLOYMENTS_DIR): BackhaulAddresses {
  return addressesOf(loadDeployment('portaldot', dir), loadDeployment('bsc', dir));
}
