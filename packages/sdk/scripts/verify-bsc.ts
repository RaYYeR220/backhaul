/**
 * Verifies the BSC contracts from deployments/bsc.json on BscScan testnet with
 * `forge verify-contract` (same compiler settings as the build: foundry.toml).
 *
 *   npx tsx packages/sdk/scripts/verify-bsc.ts [--env <path>] [--run] [--deployments <dir>]
 *
 * Without an API key (ETHERSCAN_API_KEY, or BSCSCAN_API_KEY) or without --run it only prints the
 * commands. The Portaldot testnet has no explorer with verification: its sources and constructor
 * arguments are in deployments/portaldot.json and this repository.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, type AbiParameter, type Hex } from 'viem';
import { artifactPath, CONTRACTS_DIR } from '../src/artifacts.js';
import { BSC_CHAIN_ID } from '../src/chains.js';
import { DEFAULT_DEPLOYMENTS_DIR, loadDeployment } from '../src/deployments.js';
import { loadEnvFromArgs } from '../src/env.js';

const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
loadEnvFromArgs(process.argv);

/** JSON constructor arguments back into what the ABI encoder wants (uints as bigints). */
function coerce(p: AbiParameter, v: unknown): unknown {
  if (p.type.endsWith(']')) {
    const inner = { ...p, type: p.type.slice(0, p.type.lastIndexOf('[')) } as AbiParameter;
    return (v as unknown[]).map((x) => coerce(inner, x));
  }
  if (p.type === 'tuple') {
    const comps = (p as { components: readonly AbiParameter[] }).components;
    const obj = v as Record<string, unknown>;
    return Object.fromEntries(comps.map((c, i) => [c.name!, coerce(c, Array.isArray(v) ? v[i] : obj[c.name!])]));
  }
  if (/^u?int/.test(p.type)) return BigInt(v as string | number);
  return v;
}

const dep = loadDeployment('bsc', opt('deployments') ?? DEFAULT_DEPLOYMENTS_DIR);
const key = process.env.ETHERSCAN_API_KEY ?? process.env.BSCSCAN_API_KEY;
const run = argv.includes('--run') && !!key;
if (argv.includes('--run') && !key) console.log('no ETHERSCAN_API_KEY / BSCSCAN_API_KEY: printing the commands only');

let failed = 0;
for (const [name, c] of Object.entries(dep.contracts)) {
  const art = JSON.parse(readFileSync(artifactPath(c.artifact), 'utf8'));
  const target = Object.entries(art.metadata.settings.compilationTarget as Record<string, string>)[0];
  const ctor = (art.abi as { type: string; inputs: AbiParameter[] }[]).find((x) => x.type === 'constructor');
  const args: Hex = ctor && ctor.inputs.length > 0
    ? encodeAbiParameters(ctor.inputs, ctor.inputs.map((p, i) => coerce(p, c.args?.[i])) as never)
    : '0x';
  const cmd = [
    'verify-contract',
    c.address,
    `${target[0]}:${target[1]}`,
    '--chain',
    String(BSC_CHAIN_ID),
    '--watch',
    ...(args !== '0x' ? ['--constructor-args', args] : []),
    ...(key ? ['--etherscan-api-key', key] : []),
  ];
  const shown = cmd.map((a) => (a === key ? '$ETHERSCAN_API_KEY' : a)).join(' ');
  console.log(`\n# ${name}\nforge ${shown}`);
  if (run) {
    const r = spawnSync('forge', cmd, { cwd: CONTRACTS_DIR, stdio: 'inherit' });
    if (r.status !== 0) failed++;
  }
}
if (failed) {
  console.error(`${failed} verification(s) failed`);
  process.exit(1);
}
