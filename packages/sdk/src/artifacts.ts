// Forge build artifacts (contracts/out/<File>.sol/<Contract>.json).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Abi, Hex } from 'viem';

export const CONTRACTS_DIR = resolve(import.meta.dirname, '../../../contracts');
export const ARTIFACTS_DIR = resolve(CONTRACTS_DIR, 'out');

export interface Artifact {
  contractName: string;
  sourceFile: string;
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
}

/** Source file of each contract we deploy or call, when it differs from `<Name>.sol`. */
const SOURCE_OF: Record<string, string> = {
  PortaldotRepayForwarder: 'RepayForwarder.sol',
  BscRepayForwarder: 'RepayForwarder.sol',
  ERC20: 'ERC20.sol',
};

export function artifactPath(name: string, dir = ARTIFACTS_DIR): string {
  return resolve(dir, SOURCE_OF[name] ?? `${name}.sol`, `${name}.json`);
}

export function loadArtifact(name: string, dir = ARTIFACTS_DIR): Artifact {
  const path = artifactPath(name, dir);
  if (!existsSync(path)) throw new Error(`no artifact for ${name} at ${path}; run \`forge build\` in contracts/`);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const linked = Object.keys(json.bytecode?.linkReferences ?? {});
  if (linked.length > 0) throw new Error(`${name} needs linked libraries (${linked.join(', ')})`);
  return {
    contractName: name,
    sourceFile: SOURCE_OF[name] ?? `${name}.sol`,
    abi: json.abi as Abi,
    bytecode: json.bytecode.object as Hex,
    deployedBytecode: json.deployedBytecode.object as Hex,
  };
}

/** Runtime code size in bytes, the figure Portaldot charges its code deposit on. */
export function runtimeSize(a: Artifact): number {
  return (a.deployedBytecode.length - 2) / 2;
}
