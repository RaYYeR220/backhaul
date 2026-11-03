/**
 * Deploys Backhaul to the Portaldot V3 testnet and the BNB Chain testnet, resuming from
 * deployments/<chain>.json.
 *
 *   npx tsx packages/sdk/scripts/deploy.ts --env <path/to/.env> [--chain all|portaldot|bsc]
 *   npx tsx packages/sdk/scripts/deploy.ts --env <path> --dry-run     # cost estimate, nothing sent
 *   npx tsx packages/sdk/scripts/deploy.ts --env <path> --local       # full rehearsal on local nodes
 *
 * --dry-run and --local run the whole plan on two local anvil nodes (a fork of BSC testnet and a
 * plain EVM node standing in for Portaldot), with light-client checkpoints taken from the live
 * chains. --dry-run then prices every transaction: BSC from the fork's gas usage at the live gas
 * price, Portaldot from live eth_estimateGas (deposits included) where the node can dry-run the
 * transaction, and from a cost model calibrated live where it can't.
 *
 * Options: --out <dir>  --asset-id <n>  --seed-gas <tPOT>  --seed-pot-vault <tPOT>
 *          --seed-bnb-vault <tBNB>  --approval-fund <tPOT>  --min-fee-bps <n>
 *          --estimate-from <0x funded Portaldot address>  --keep (leave local nodes running)
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseEther,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { originSettlerAbi, portaldotGatewayAbi } from '../src/abi.js';
import { privateKeyToAccount } from 'viem/accounts';
import { BscClient, BSC_TESTNET_RPCS } from '../src/bsc/client.js';
import { BSC_CHAIN_ID, BSC_RPC, PORTALDOT_CHAIN_ID, PORTALDOT_EVM_RPC, PORTALDOT_SUBSTRATE_WS, type ChainName } from '../src/chains.js';
import { calibratePortaldot, fmtUnits, modelCost, type PortaldotRates } from '../src/deploy/cost.js';
import { impersonate, setBalance, startAnvil, stateDiff, type Anvil } from '../src/deploy/anvil.js';
import { runPlan, type PlanConfig } from '../src/deploy/plan.js';
import { Side, type TxLog } from '../src/deploy/side.js';
import { DEFAULT_DEPLOYMENTS_DIR, jsonReplacer, loadDeployment } from '../src/deployments.js';
import { loadEnvFromArgs } from '../src/env.js';
import { senderFor } from '../src/evm.js';
import { opsKeyFromMnemonic, freeBalance } from '../src/portaldot/assets.js';
import { connectPortaldot, disconnectPortaldot } from '../src/portaldot/client.js';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

loadEnvFromArgs(process.argv);

const ROOT = resolve(import.meta.dirname, '../../..');
const DATA = resolve(process.env.BACKHAUL_DATA ?? resolve(ROOT, 'services/relayer/data'));
const mode: 'live' | 'local' | 'dry' = flag('dry-run') ? 'dry' : flag('local') ? 'local' : 'live';
const only = (opt('chain', 'all') as 'all' | ChainName);
const outDir = resolve(opt('out') ?? (mode === 'live' ? DEFAULT_DEPLOYMENTS_DIR : resolve(DATA, mode === 'dry' ? 'dry-run' : 'rehearsal')));
const estimateFrom = getAddress(opt('estimate-from', '0x9234511ee6f98f944b846d19d4013a81f93bd5f9')!);
const assetId = Number(opt('asset-id', process.env.BNBB_ASSET_ID ?? '9797'));
const seeds = {
  gasPool: parseEther(opt('seed-gas', '5')!),
  potVault: parseEther(opt('seed-pot-vault', '20')!),
  bnbVault: parseEther(opt('seed-bnb-vault', '0.01')!),
  // planck: 14 decimals
  approvalFund: parseEther(opt('approval-fund', '0.5')!) / 10_000n,
};
const minFeeBps = Number(opt('min-fee-bps', '30'));
const TRUSTING_PERIOD = 7n * 86_400n;
const SUPPLY = 1_000_000n * 10n ** 18n;
const DUMMY_EOA = '0x000000000000000000000000000000000000dEaD' as Address;

const pdRpc = process.env.PORTALDOT_EVM_RPC ?? PORTALDOT_EVM_RPC;
const pdWs = process.env.PORTALDOT_WS ?? PORTALDOT_SUBSTRATE_WS;
const bscRpc = process.env.BSC_RPC ?? BSC_RPC;

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

function deployerKey(): { key?: Hex; address: Address } {
  const pk = process.env.PORTALDOT_DEPLOYER_PK as Hex | undefined;
  if (pk) {
    const key = (pk.startsWith('0x') ? pk : `0x${pk}`) as Hex;
    return { key, address: privateKeyToAccount(key).address };
  }
  const addr = process.env.PORTALDOT_DEPLOYER_EVM;
  if (addr) return { address: getAddress(addr) };
  // anvil's first default account, for keyless local rehearsals
  return {
    key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  };
}

async function main() {
  const dep = deployerKey();
  if (mode === 'live' && !dep.key) throw new Error('live deploy needs PORTALDOT_DEPLOYER_PK');
  let anvils: Anvil[] = [];
  let pdUrl = pdRpc;
  let bscUrl = bscRpc;

  if (mode !== 'live') {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    log(`starting local nodes (BSC testnet fork + Portaldot stand-in), output in ${outDir}`);
    const bscPort = Number(opt('bsc-port', '8645'));
    const pdPort = Number(opt('portaldot-port', '8646'));
    anvils = [
      await startAnvil({ port: bscPort, chainId: BSC_CHAIN_ID, forkUrl: bscRpc, detached: flag('keep') }),
      await startAnvil({ port: pdPort, chainId: PORTALDOT_CHAIN_ID, detached: flag('keep') }),
    ];
    [bscUrl, pdUrl] = anvils.map((a) => a.url);
    for (const url of [bscUrl, pdUrl]) {
      await setBalance(url, dep.address, 10n ** 27n);
      if (!dep.key) await impersonate(url, dep.address);
    }
  }

  const keyOrAddr = dep.key ?? dep.address;
  const want = (c: ChainName) => mode !== 'live' || only === 'all' || only === c;
  const pdSender = want('portaldot') ? senderFor('portaldot', keyOrAddr, pdUrl) : undefined;
  const bscSender = want('bsc') ? senderFor('bsc', keyOrAddr, bscUrl) : undefined;

  log(`deployer ${dep.address}; mode ${mode}; chains ${mode === 'live' ? only : 'all'}`);
  const portaldot = await connectPortaldot(pdWs);
  const bsc = new BscClient({ urls: process.env.BSC_RPC ? [process.env.BSC_RPC, ...BSC_TESTNET_RPCS] : BSC_TESTNET_RPCS });
  const ops = mode === 'live' && process.env.PORTALDOT_OPS_MNEMONIC ? await opsKeyFromMnemonic(process.env.PORTALDOT_OPS_MNEMONIC) : undefined;

  if (mode === 'live') await preflight(dep.address, ops?.address, portaldot.api);

  const P = new Side('portaldot', loadDeployment('portaldot', outDir), outDir, pdSender, { trace: mode !== 'live', log });
  const B = new Side('bsc', loadDeployment('bsc', outDir), outDir, bscSender, { trace: mode !== 'live', log });

  const cfg: PlanConfig = {
    mode: mode === 'live' ? 'live' : 'local',
    assetId,
    bnbbSupply: SUPPLY,
    minFeeBps,
    trustingPeriod: TRUSTING_PERIOD,
    seeds,
    portaldot,
    bsc,
    ops,
    localPortaldotUrl: mode === 'live' ? undefined : pdUrl,
    archivePath: resolve(DATA, 'portaldot-justifications.jsonl'),
    hashCachePath: resolve(DATA, 'portaldot-block-hashes.bin'),
    log,
  };

  try {
    await runPlan(P, B, cfg);
    const txs = [...P.txs, ...B.txs];
    writeFileSync(resolve(outDir, 'txs.json'), JSON.stringify(txs, jsonReplacer, 2) + '\n');
    if (mode === 'dry') await costReport(P.txs, B.txs, portaldot.api, await sampleOps(P, B));
    else summary(P, B);
  } finally {
    await disconnectPortaldot(portaldot);
    if (!flag('keep')) anvils.forEach((a) => a.stop());
    else if (anvils.length) log(`local nodes left running: bsc ${bscUrl}, portaldot ${pdUrl}`);
  }
}

async function preflight(deployer: Address, opsAddress: string | undefined, api: any) {
  const pd = createPublicClient({ transport: http(pdRpc) });
  const b = createPublicClient({ transport: http(bscRpc) });
  const [pdBal, bscBal] = await Promise.all([pd.getBalance({ address: deployer }), b.getBalance({ address: deployer })]);
  log(`deployer balance: ${formatEther(pdBal)} tPOT, ${formatEther(bscBal)} tBNB`);
  if (opsAddress) log(`ops ${opsAddress} balance: ${fmtUnits(await freeBalance(api, opsAddress), 14)} tPOT`);
  if ((only === 'all' || only === 'portaldot') && pdBal === 0n) throw new Error('deployer has no tPOT; run --dry-run for the amount needed');
  if ((only === 'all' || only === 'bsc') && bscBal === 0n) throw new Error('deployer has no tBNB');
}

function summary(P: Side, B: Side) {
  for (const s of [P, B]) {
    log(`${s.name}: ${Object.keys(s.dep.contracts).length} contracts, ${Object.keys(s.dep.steps).length} steps recorded`);
    for (const [k, c] of Object.entries(s.dep.contracts)) log(`  ${k.padEnd(22)} ${c.address}`);
  }
  const spent = (txs: TxLog[]) => txs.reduce((a, t) => a + t.gasUsed * t.gasPrice + t.value, 0n);
  if (P.txs.length || B.txs.length) log(`this run: ${P.txs.length + B.txs.length} txs; gas+value ${formatEther(spent(P.txs))} (portaldot), ${formatEther(spent(B.txs))} (bsc)`);
}

// ------------------------------------------------------------------ dry-run pricing

interface Line {
  step: string;
  method: string;
  fee: bigint;
  value: bigint;
}

interface SampleOp {
  step: string;
  dataBytes: number;
  newSlots: number;
  value: bigint;
}

/** User operations on the Portaldot stand-in, to price what a transfer or an order costs a user. */
async function sampleOps(P: Side, B: Side): Promise<SampleOp[]> {
  const s = P.sender!;
  const out: SampleOp[] = [];
  const run = async (step: string, to: Address, abi: any, fn: string, args: unknown[], value = 0n) => {
    const data = encodeFunctionData({ abi, functionName: fn, args });
    const r = await s.send({ to, data, value, label: step });
    out.push({ step, dataBytes: (data.length - 2) / 2, newSlots: (await stateDiff(s.pub, r.hash)).newSlots, value });
  };
  const gw = P.addr('PortaldotGateway');
  await run('lockPOT (first ever)', gw, portaldotGatewayAbi, 'lockPOT', [s.address], parseEther('1'));
  await run('lockPOT', gw, portaldotGatewayAbi, 'lockPOT', [s.address], parseEther('1'));
  const order = [s.address, zeroAddress, parseEther('1'), B.addr('PPOT'), parseEther('0.99'), s.address, 97n, 1n] as const;
  const orderData = encodeAbiParameters(
    [{ type: 'tuple', components: ['address', 'address', 'uint256', 'address', 'uint256', 'address', 'uint64', 'uint64'].map((type, i) => ({ type, name: `f${i}` })) }],
    [Object.fromEntries(order.map((v, i) => [`f${i}`, v]))],
  );
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const orderType = keccak256(
    toHex('BackhaulOrder(address user,address inputToken,uint256 inputAmount,address outputToken,uint256 outputAmount,address recipient,uint64 destinationChainId,uint64 nonce)'),
  );
  await run('OriginSettler.open (tPOT in)', P.addr('OriginSettler'), originSettlerAbi, 'open', [{ fillDeadline: deadline, orderDataType: orderType, orderData }], parseEther('1'));
  return out;
}

async function costReport(ptxs: TxLog[], btxs: TxLog[], api: any, ops: SampleOp[]) {
  const pdLive = createPublicClient({ transport: http(pdRpc, { timeout: 120_000 }) }) as PublicClient;
  const bscLive = createPublicClient({ transport: http(bscRpc) }) as PublicClient;
  log('calibrating the Portaldot cost model with live estimates');
  const rates = await calibratePortaldot(pdLive, estimateFrom, DUMMY_EOA);
  const r = (x: bigint) => fmtUnits(x, 18, 4);
  log(
    `rates: deploy base ${r(rates.deployBase)}, code ${r(rates.codeRate * 1000n)}/KB, storage item ${r(rates.slotRate)}, ` +
      `call base ${r(rates.callBase)}, calldata ${r(rates.byteRate * 1000n)}/KB (tPOT, gas price ${rates.gasPrice})`,
  );

  const pLines: Line[] = [];
  for (const t of ptxs) {
    // The local run mints BNB.b on a mock ERC-20; live, that is a substrate extrinsic (priced below).
    if (t.step.startsWith('bnbb.')) continue;
    let fee: bigint | undefined;
    let method = 'model';
    if (t.kind === 'deploy' && !t.dependsOnLocal) {
      try {
        fee = (await pdLive.estimateGas({ account: estimateFrom, data: t.data, value: t.value })) * rates.gasPrice;
        method = 'live estimate';
      } catch (e) {
        method = `model (live estimate failed: ${(e as Error).message.split('\n')[0].slice(0, 60)})`;
      }
    }
    fee ??= modelCost(rates, { kind: t.kind, dataBytes: (t.data.length - 2) / 2, codeBytes: t.codeBytes, newSlots: t.newSlots ?? 0 });
    if (method === 'model') method = `model: ${t.newSlots ?? 0} new items${t.codeBytes ? `, ${t.codeBytes} B code` : ''}`;
    pLines.push({ step: t.step, method, fee, value: t.value });
  }
  // Substrate-side steps (ops key): BNB.b and the approval-deposit top-ups.
  const sub = await substrateCosts(api);
  pLines.push(...sub);

  const bscPrice = await bscLive.getGasPrice();
  const bLines: Line[] = btxs.map((t) => ({ step: t.step, method: `fork gas ${t.gasUsed}`, fee: t.gasUsed * bscPrice, value: t.value }));
  if (!btxs.some((t) => t.step === 'PortaldotVerifier.bindTrieId')) {
    // Measured in forge on live fixtures (results/beefy-gas-local.json); needs the live Outbox.
    // The bind first needs a BEEFY commitment and a header import above the Outbox's block.
    bLines.push(
      { step: 'beefy submitCommitment (for the bind)', method: 'forge gas 103370', fee: 103_370n * bscPrice, value: 0n },
      { step: 'beefy importHeader (for the bind)', method: 'forge gas 109482', fee: 109_482n * bscPrice, value: 0n },
      { step: 'PortaldotVerifier.bindTrieId', method: 'forge gas 470638', fee: 470_638n * bscPrice, value: 0n },
    );
  }

  const table = (name: string, unit: string, lines: Line[]) => {
    console.log(`\n${name}`);
    console.log(`${'step'.padEnd(44)} ${'fee+deposit'.padStart(14)} ${'value'.padStart(10)}  method`);
    for (const l of lines) console.log(`${l.step.padEnd(44)} ${r(l.fee).padStart(14)} ${r(l.value).padStart(10)}  ${l.method}`);
    const fee = lines.reduce((a, l) => a + l.fee, 0n);
    const value = lines.reduce((a, l) => a + l.value, 0n);
    console.log(`${'TOTAL'.padEnd(44)} ${r(fee).padStart(14)} ${r(value).padStart(10)}  = ${r(fee + value)} ${unit}`);
    return { fee, value };
  };
  const pt = table('Portaldot (tPOT)', 'tPOT', pLines);
  const bt = table(`BSC (tBNB, gas price ${bscPrice} wei)`, 'tBNB', bLines);

  // Running costs: what the relayer and users pay per operation.
  const window = modelCost(rates, { kind: 'call', dataBytes: 46_000, codeBytes: 0, newSlots: 4 });
  const windowWarm = modelCost(rates, { kind: 'call', dataBytes: 46_000, codeBytes: 0, newSlots: 0 });
  console.log('\nRunning costs (model)');
  console.log(`  Parlia window (~46 KB), fresh ring slot: ${r(window)} tPOT; once the 256-slot ring is warm: ${r(windowWarm)} tPOT`);
  console.log(`  one new storage item on Portaldot: ${r(rates.slotRate)} tPOT (an Outbox commitment, an order status...)`);
  console.log(`  BEEFY per session on BSC (6 commitments + import + rotate): ~${r((6n * 103_370n + 109_482n + 420_353n) * bscPrice)} tBNB`);
  const userOps = ops.map((o) => ({ ...o, fee: modelCost(rates, { kind: 'call', dataBytes: o.dataBytes, codeBytes: 0, newSlots: o.newSlots }) }));
  for (const o of userOps) console.log(`  user: ${o.step}: ${r(o.fee)} tPOT fees+deposit (${o.newSlots} new items) + ${r(o.value)} value`);

  const out = {
    at: new Date().toISOString(),
    rates,
    portaldot: { lines: pLines, ...pt },
    bsc: { gasPrice: bscPrice, lines: bLines, ...bt },
    running: { parliaWindowFresh: window, parliaWindowWarm: windowWarm, storageItem: rates.slotRate, userOps },
  };
  const path = resolve(ROOT, 'results', 'deploy-cost-estimate.json');
  writeFileSync(path, JSON.stringify(out, jsonReplacer, 2) + '\n');
  log(`wrote ${path}`);
}

async function substrateCosts(api: any): Promise<Line[]> {
  const c = api.consts.assets;
  const planck = (x: any) => BigInt(x.toString()) * 10_000n; // 14 → 18 decimals
  const opsAddr = process.env.PORTALDOT_OPS_SS58 ?? '5GmxJdhriMLkZcsu2PU88mZnJJ3gx1AkjMAcNdiWyNCDEMj5';
  const gw = `0x${'11'.repeat(20)}${'ee'.repeat(12)}`;
  const fee = async (tx: any) => planck((await tx.paymentInfo(opsAddr)).partialFee);
  const name = 'Bridged BNB';
  const symbol = 'BNB.b';
  const lines: Line[] = [
    { step: 'bnbb.create (ops key)', method: 'paymentInfo + AssetDeposit', fee: (await fee(api.tx.assets.create(assetId, opsAddr, 1))) + planck(c.assetDeposit), value: 0n },
    {
      step: 'bnbb.setMetadata (ops key)',
      method: 'paymentInfo + metadata deposit',
      fee: (await fee(api.tx.assets.setMetadata(assetId, name, symbol, 18))) + planck(c.metadataDepositBase) + planck(c.metadataDepositPerByte) * BigInt(name.length + symbol.length),
      value: 0n,
    },
    { step: 'bnbb.mint (ops key)', method: 'paymentInfo', fee: await fee(api.tx.assets.mint(assetId, gw, SUPPLY)), value: 0n },
    { step: 'bnbb.setTeam (ops key)', method: 'paymentInfo', fee: await fee(api.tx.assets.setTeam(assetId, gw, gw, gw)), value: 0n },
    { step: 'bnbb.transferOwnership (ops key)', method: 'paymentInfo', fee: await fee(api.tx.assets.transferOwnership(assetId, gw)), value: 0n },
  ];
  for (const k of ['BnbbVault', 'BnbbForwarder']) {
    lines.push({
      step: `seed.approvalFund.${k} (ops key)`,
      method: 'paymentInfo',
      fee: await fee(api.tx.balances.transferKeepAlive(gw, seeds.approvalFund)),
      value: seeds.approvalFund * 10_000n,
    });
  }
  return lines;
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
