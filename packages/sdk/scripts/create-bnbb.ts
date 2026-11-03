/**
 * Creates BNB.b on Portaldot and hands the asset to the PortaldotGateway, signed with the ops
 * sr25519 key (pallet-assets calls need a substrate signature):
 *   assets.create(id, ops, 1) → set_metadata("Bridged BNB", "BNB.b", 18)
 *   → mint(id, gateway, supply) → set_team(id, gw, gw, gw) → transfer_ownership(id, gw)
 * where gw is the gateway's AccountId32 (h160 ‖ 0xEE×12). The deploy script runs the same steps;
 * this is the standalone version. Every step checks the chain first, so it can be re-run.
 *
 *   npx tsx packages/sdk/scripts/create-bnbb.ts --env <path> [--asset-id N] [--gateway 0x…]
 *       [--supply <whole BNB>] [--deployments <dir>] [--status]
 *
 * --status only prints the asset's state.
 */
import { getAddress, type Address } from 'viem';
import { accountId32Of, assetPrecompile, PORTALDOT_SUBSTRATE_WS } from '../src/chains.js';
import { DEFAULT_DEPLOYMENTS_DIR, loadDeployment, saveDeployment } from '../src/deployments.js';
import { loadEnvFromArgs } from '../src/env.js';
import { bnbbStatus, opsKeyFromMnemonic, setupBnbb } from '../src/portaldot/assets.js';
import { connectPortaldot, disconnectPortaldot } from '../src/portaldot/client.js';

const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
loadEnvFromArgs(process.argv);

const dir = opt('deployments') ?? DEFAULT_DEPLOYMENTS_DIR;
const dep = loadDeployment('portaldot', dir);
const meta = dep.meta.bnbb as { assetId: number } | undefined;
const assetId = Number(opt('asset-id') ?? meta?.assetId ?? process.env.BNBB_ASSET_ID ?? 9797);
const gwArg = opt('gateway') ?? dep.contracts.PortaldotGateway?.address;
if (!gwArg) throw new Error('no gateway: pass --gateway or deploy PortaldotGateway first');
const gateway = getAddress(gwArg) as Address;
const supply = BigInt(opt('supply') ?? '1000000') * 10n ** 18n;

const client = await connectPortaldot(process.env.PORTALDOT_WS ?? PORTALDOT_SUBSTRATE_WS);
try {
  console.log(`asset ${assetId}, precompile ${assetPrecompile(assetId)}, gateway ${gateway} (${accountId32Of(gateway)})`);
  if (argv.includes('--status')) {
    console.log(JSON.stringify(await bnbbStatus(client.api, assetId, gateway), (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  } else {
    const mnemonic = process.env.PORTALDOT_OPS_MNEMONIC;
    if (!mnemonic) throw new Error('missing env PORTALDOT_OPS_MNEMONIC');
    const ops = await opsKeyFromMnemonic(mnemonic);
    console.log(`ops key ${ops.address}`);
    const steps = await setupBnbb(client.api, ops, { assetId, gateway, supply }, console.log);
    dep.meta.bnbb = { assetId, precompile: assetPrecompile(assetId) };
    for (const s of steps) dep.steps[`bnbb.${s.step}`] ??= { at: new Date().toISOString(), tx: s.hash, block: s.block, skipped: s.skipped ?? false };
    console.log(`saved ${saveDeployment(dep, dir)}`);
  }
} finally {
  await disconnectPortaldot(client);
}
