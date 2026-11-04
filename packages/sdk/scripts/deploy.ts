/**
 * Deploys Backhaul to the Portaldot V3 testnet and the BNB Chain testnet, resuming from
 * deployments/<chain>.json, in two budget phases (see src/deploy/plan.ts):
 *
 *   npx tsx packages/sdk/scripts/deploy.ts --env <path> --print-plan       # reserved nonces and addresses
 *   npx tsx packages/sdk/scripts/deploy.ts --env <path> --phase A [--minimal]
 *   npx tsx packages/sdk/scripts/deploy.ts --env <path> --phase B [--minimal]
 *   npx tsx packages/sdk/scripts/deploy.ts --env <path> --dry-run [--phase A|B] [--minimal]
 *   npx tsx packages/sdk/scripts/deploy.ts --env <path> --local       # full rehearsal on local nodes
 *
 * Phase A fits about 400 tPOT: Portaldot Outbox + PortaldotGateway (whose verifier is the address
 * BscVerifier is reserved at) + the whole BSC side, enough for a proven Portaldot → BSC transfer.
 * Phase B deploys the rest on Portaldot, BscVerifier landing exactly where the gateway expects it.
 * The deployer's Portaldot nonces are reserved in deployments/portaldot.json and every send checks
 * them: between the phases NOTHING else may send from the deployer key on Portaldot (the relayer
 * has its own key, BACKHAUL_RELAYER_PK).
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
 *          --minimal (= --no-bnb-vaults: no LP vaults on the BNB routes; BNB still bridges)
 *          --with-feed  also deploy BscFeed (Chainlink BNB/USD proven from BSC storage)
 *          --fund-relayer <tPOT>  phase A sends this to the relayer's key on Portaldot (default 100)
 *          --fund-relayer-bnb <tBNB>  and this on BSC (default 0.02)
 *          --with-ink   also upload the ink! ParliaClient to pallet-contracts with the ops key
 *                       (PORTALDOT_OPS_MNEMONIC), from the EVM client's checkpoint; the dry-run
 *                       prices it with ContractsApi_instantiate. Build it first with
 *                       packages/sdk/scripts/build-ink.ts.
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
import { CONTRACTS_DIR } from '../src/artifacts.js';
import { BscClient, BSC_TESTNET_RPCS } from '../src/bsc/client.js';
import { BSC_CHAIN_ID, BSC_RPC, PORTALDOT_CHAIN_ID, PORTALDOT_EVM_RPC, PORTALDOT_SUBSTRATE_WS, type ChainName } from '../src/chains.js';
import { calibratePortaldot, fmtUnits, modelCost, type PortaldotRates } from '../src/deploy/cost.js';
import { checkpointFromMeta, quoteInkDeploy } from '../src/deploy/ink.js';
import { impersonate, setBalance, startAnvil, stateDiff, type Anvil } from '../src/deploy/anvil.js';
import { formatPlan, planNonces, type NoncePlan, type Phase } from '../src/deploy/nonces.js';
import { deploySteps, plannedTxs, runPhases, type PlanConfig } from '../src/deploy/plan.js';
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
const phaseArg = opt('phase')?.toUpperCase();
if (phaseArg && phaseArg !== 'A' && phaseArg !== 'B') throw new Error('--phase is A or B');
/** Phases this run executes (a dry-run of B still runs A first on the local nodes). */
const phases: Phase[] = phaseArg === 'A' ? ['A'] : phaseArg === 'B' && mode === 'live' ? ['B'] : ['A', 'B'];
/** Phases the cost report prices. */
const pricedPhases: Phase[] = phaseArg ? [phaseArg as Phase] : ['A', 'B'];
const fundRelayerValue = parseEther(opt('fund-relayer', '100')!);
const fundRelayerBnb = parseEther(opt('fund-relayer-bnb', '0.02')!);
/** Parlia trusting period, on both clocks: the relayer refreshes every 3 days, 14 leaves room for a long outage. */
const TRUSTING_PERIOD = 14n * 86_400n;
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

/** The relayer's own key: never the deployer, whose Portaldot nonces are reserved. */
function relayerAddress(deployer: Address): Address | undefined {
  const pk = process.env.BACKHAUL_RELAYER_PK ?? process.env.RELAYER_PK;
  const addr = process.env.BACKHAUL_RELAYER_ADDRESS
    ? getAddress(process.env.BACKHAUL_RELAYER_ADDRESS)
    : pk
      ? privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as Hex).address
      : mode === 'live'
        ? undefined
        : getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'); // anvil's second account
  if (addr && addr === getAddress(deployer)) throw new Error('the relayer key must not be the deployer key (its Portaldot nonces are reserved)');
  return addr;
}

/** Prints the reserved nonces and addresses for both chains from the deployer's live nonces. */
async function printPlan(deployer: Address, cfg: PlanConfig) {
  const pd = createPublicClient({ transport: http(pdRpc) }) as PublicClient;
  const b = createPublicClient({ transport: http(bscRpc) }) as PublicClient;
  const P = new Side('portaldot', loadDeployment('portaldot', outDir), outDir, undefined, { log });
  const B = new Side('bsc', loadDeployment('bsc', outDir), outDir, undefined, { log });
  const steps = deploySteps(P, B, cfg);
  const saved = P.dep.meta.noncePlan as NoncePlan | undefined;
  const [pn, bn] = await Promise.all([pd.getTransactionCount({ address: deployer }), b.getTransactionCount({ address: deployer })]);
  const pPlan = saved ?? planNonces('portaldot', deployer, pn, plannedTxs(steps, 'portaldot'));
  // BSC phase B is planned when it starts; shown here as if phase A's relay transactions were none.
  const bPlan = planNonces('bsc', deployer, bn, plannedTxs(steps, 'bsc'));
  log(`deployer ${deployer}: Portaldot nonce ${pn}${saved ? ' (plan saved earlier)' : ''}, BSC nonce ${bn}`);
  for (const line of [...formatPlan(pPlan), ...formatPlan(bPlan)]) console.log(line);
  console.log('  (BSC phase B addresses shift by the number of BEEFY relay transactions bindTrieId sends at the end of phase A)');
}

async function main() {
  const dep = deployerKey();
  if (mode === 'live' && !dep.key && !flag('print-plan')) throw new Error('live deploy needs PORTALDOT_DEPLOYER_PK');
  let anvils: Anvil[] = [];
  let pdUrl = pdRpc;
  let bscUrl = bscRpc;
  const relayer = relayerAddress(dep.address);

  if (flag('print-plan')) {
    // the steps only need the options, not the chains
    const offline = { ...planOptions(relayer), mode: 'live', portaldot: undefined as never, bsc: undefined as never } as PlanConfig;
    await printPlan(dep.address, offline);
    return;
  }

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

  // Portaldot charges per byte of code: deploy its contracts from the size profile when built.
  const pdArtifacts = resolve(CONTRACTS_DIR, 'out-portaldot');
  const pdOut = existsSync(pdArtifacts) ? pdArtifacts : undefined;
  if (!pdOut) log('note: no contracts/out-portaldot; run FOUNDRY_PROFILE=portaldot forge build for smaller Portaldot code');
  const P = new Side('portaldot', loadDeployment('portaldot', outDir), outDir, pdSender, { trace: mode !== 'live', log, artifactsDir: pdOut });
  const B = new Side('bsc', loadDeployment('bsc', outDir), outDir, bscSender, { trace: mode !== 'live', log });

  // A plan saved in phase A that funds the relayer keeps that step, whatever this run's flags say.
  const savedPlan = P.dep.meta.noncePlan as NoncePlan | undefined;
  const plannedFunding = savedPlan?.reserved.some((r) => r.step === 'fund.relayer');
  const cfg: PlanConfig = {
    ...planOptions(relayer, plannedFunding ? ((P.dep.steps['fund.relayer']?.to as Address | undefined) ?? relayer) : undefined),
    mode: mode === 'live' ? 'live' : 'local',
    portaldot,
    bsc,
    ops,
    localPortaldotUrl: mode === 'live' ? undefined : pdUrl,
  };
  if (phases.includes('A') && !cfg.fundRelayer) log('note: no relayer key to fund (set BACKHAUL_RELAYER_PK); phase A plans no funding transfer');

  try {
    await runPhases(phases, P, B, cfg);
    const txs = [...P.txs, ...B.txs];
    writeFileSync(resolve(outDir, 'txs.json'), JSON.stringify(txs, jsonReplacer, 2) + '\n');
    const ink = mode === 'dry' && flag('with-ink') ? await inkLine(portaldot.api, P) : undefined;
    if (mode === 'dry') await costReport(P.txs, B.txs, portaldot.api, phases.includes('B') ? await sampleOps(P, B) : [], ink);
    else summary(P, B);
  } finally {
    await disconnectPortaldot(portaldot);
    if (!flag('keep')) anvils.forEach((a) => a.stop());
    else if (anvils.length) log(`local nodes left running: bsc ${bscUrl}, portaldot ${pdUrl}`);
  }
}

/** Plan options from the command line (everything but the chain connections). */
function planOptions(relayer: Address | undefined, forceFundTo?: Address) {
  const to = forceFundTo ?? relayer;
  return {
    assetId,
    bnbbSupply: SUPPLY,
    minFeeBps,
    bnbVaults: !flag('no-bnb-vaults') && !flag('minimal'),
    withFeed: flag('with-feed'),
    withInk: flag('with-ink'),
    fundRelayer: to && (fundRelayerValue > 0n || forceFundTo) ? { to, value: fundRelayerValue > 0n ? fundRelayerValue : 1n } : undefined,
    fundRelayerBsc: relayer && fundRelayerBnb > 0n ? { to: relayer, value: fundRelayerBnb } : undefined,
    trustingPeriod: TRUSTING_PERIOD,
    seeds,
    archivePath: resolve(DATA, 'portaldot-justifications.jsonl'),
    hashCachePath: resolve(DATA, 'portaldot-block-hashes.bin'),
    log,
  };
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
  if (mode === 'live' && B.has('PortaldotLightClient')) {
    log('next: start the relayer now (npm run relayer -- --env <path>). The BEEFY client rotates with');
    log('commitments archived during each session, so it must be running before the next session ends.');
  }
}

// ------------------------------------------------------------------ dry-run pricing

interface Line {
  phase: Phase;
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
  if (!P.has('OriginSettler')) return out;
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

/** The ink! ParliaClient upload, priced on the live chain from the checkpoint the plan used. */
async function inkLine(api: any, P: Side): Promise<Line> {
  const origin = (await api.call.reviveApi.accountId(estimateFrom)).toString();
  const q = await quoteInkDeploy(api, origin, checkpointFromMeta(P.dep.meta.parliaCheckpoint), TRUSTING_PERIOD);
  const wei = (planck: bigint) => planck * 10_000n; // 14 → 18 decimals, like every other line
  log(`ink! ParliaClient: ${q.wasmBytes} B wasm, ${q.ok ? 'accepted by the dry-run' : `refused by the dry-run: ${q.reason}`}`);
  return {
    phase: 'B',
    step: 'ParliaClient ink! (ops key, instantiateWithCode)',
    method: `${q.depositMethod}${q.ok ? '' : `; chain refuses it now: ${q.reason}`} + paymentInfo`,
    fee: wei(q.deposit + q.fee),
    value: 0n,
  };
}

async function costReport(ptxs: TxLog[], btxs: TxLog[], api: any, ops: SampleOp[], ink?: Line) {
  const pdLive = createPublicClient({ transport: http(pdRpc, { timeout: 120_000 }) }) as PublicClient;
  const bscLive = createPublicClient({ transport: http(bscRpc) }) as PublicClient;
  log('calibrating the Portaldot cost model with live estimates');
  // any live contract will do to measure what re-deploying identical code costs
  const rates = await calibratePortaldot(pdLive, estimateFrom, DUMMY_EOA, '0x1d0c17a0ee1dcf15bd05a45ae789058a0586aa68');
  const r = (x: bigint) => fmtUnits(x, 18, 4);
  log(
    `rates: deploy base ${r(rates.deployBase)}, code ${r(rates.codeRate * 1000n)}/KB, storage item ${r(rates.slotRate)}, ` +
      `call base ${r(rates.callBase)}, calldata ${r(rates.byteRate * 1000n)}/KB, reused code ${r(rates.reuseCodeRate * 1000n)}/KB (tPOT, gas price ${rates.gasPrice})`,
  );

  const pLines: Line[] = [];
  const seen = new Set<string>();
  for (const t of ptxs) {
    let fee: bigint | undefined;
    let method = 'model';
    const reused = t.kind === 'deploy' && !!t.runtimeHash && seen.has(t.runtimeHash);
    if (t.runtimeHash) seen.add(t.runtimeHash);
    if (reused) {
      fee = modelCost(rates, { kind: 'deploy', reused, dataBytes: (t.data.length - 2) / 2, codeBytes: t.codeBytes, newSlots: t.newSlots ?? 0 });
      method = 'model: code already stored under this hash';
    } else if (t.kind === 'deploy' && !t.dependsOnLocal) {
      try {
        fee = (await pdLive.estimateGas({ account: estimateFrom, data: t.data, value: t.value })) * rates.gasPrice;
        method = 'live estimate';
      } catch (e) {
        method = `model (live estimate failed: ${(e as Error).message.split('\n')[0].slice(0, 60)})`;
      }
    }
    fee ??= modelCost(rates, { kind: t.kind === 'deploy' ? 'deploy' : 'call', dataBytes: (t.data.length - 2) / 2, codeBytes: t.codeBytes, newSlots: t.newSlots ?? 0 });
    if (method === 'model') method = `model: ${t.newSlots ?? 0} new items${t.codeBytes ? `, ${t.codeBytes} B code` : ''}`;
    pLines.push({ phase: t.phase, step: t.step, method, fee, value: t.value });
  }
  // Substrate-side steps (ops key, phase B): BNB.b and the approval-deposit top-ups.
  if (pricedPhases.includes('B')) pLines.push(...(await substrateCosts(api)));
  if (ink) pLines.push(ink);

  const bscPrice = await bscLive.getGasPrice();
  const bLines: Line[] = btxs.map((t) => ({ phase: t.phase, step: t.step, method: `fork gas ${t.gasUsed}`, fee: t.gasUsed * bscPrice, value: t.value }));
  if (!btxs.some((t) => t.step === 'PortaldotVerifier.bindTrieId')) {
    // Measured in forge on live fixtures (results/beefy-gas-local.json); needs the live Outbox.
    // The bind first needs a BEEFY commitment and a header import above the Outbox's block.
    bLines.push(
      { phase: 'A', step: 'beefy submitCommitment (for the bind)', method: 'forge gas 103370', fee: 103_370n * bscPrice, value: 0n },
      { phase: 'A', step: 'beefy importHeader (for the bind)', method: 'forge gas 109482', fee: 109_482n * bscPrice, value: 0n },
      { phase: 'A', step: 'PortaldotVerifier.bindTrieId', method: 'forge gas 470638', fee: 470_638n * bscPrice, value: 0n },
    );
  }

  const table = (name: string, unit: string, all: Line[]) => {
    const lines = all.filter((l) => pricedPhases.includes(l.phase));
    console.log(`\n${name}`);
    console.log(`${'step'.padEnd(44)} ${'fee+deposit'.padStart(14)} ${'value'.padStart(10)}  method`);
    const phaseTotals: Record<string, { fee: bigint; value: bigint }> = {};
    for (const ph of pricedPhases) {
      const of = lines.filter((l) => l.phase === ph);
      console.log(`  phase ${ph}`);
      for (const l of of) console.log(`${l.step.padEnd(44)} ${r(l.fee).padStart(14)} ${r(l.value).padStart(10)}  ${l.method}`);
      const fee = of.reduce((a, l) => a + l.fee, 0n);
      const value = of.reduce((a, l) => a + l.value, 0n);
      phaseTotals[ph] = { fee, value };
      console.log(`${`phase ${ph} total`.padEnd(44)} ${r(fee).padStart(14)} ${r(value).padStart(10)}  = ${r(fee + value)} ${unit}`);
    }
    const fee = lines.reduce((a, l) => a + l.fee, 0n);
    const value = lines.reduce((a, l) => a + l.value, 0n);
    console.log(`${'TOTAL'.padEnd(44)} ${r(fee).padStart(14)} ${r(value).padStart(10)}  = ${r(fee + value)} ${unit}`);
    return { fee, value, phases: phaseTotals, lines };
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
    phases: pricedPhases,
    rates,
    portaldot: pt,
    bsc: { gasPrice: bscPrice, ...bt },
    running: { parliaWindowFresh: window, parliaWindowWarm: windowWarm, storageItem: rates.slotRate, userOps },
  };
  const minimal = flag('no-bnb-vaults') || flag('minimal');
  const extras = [flag('with-feed') && 'feed', flag('with-ink') && 'ink'].filter(Boolean).join('-');
  const phaseTag = phaseArg ? `-phase-${phaseArg.toLowerCase()}` : '';
  const name = `deploy-cost-estimate${minimal ? '-minimal' : ''}${extras ? `-with-${extras}` : ''}${phaseTag}.json`;
  const path = resolve(ROOT, 'results', name);
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
    { phase: 'B', step: 'bnbb.create (ops key)', method: 'paymentInfo + AssetDeposit', fee: (await fee(api.tx.assets.create(assetId, opsAddr, 1))) + planck(c.assetDeposit), value: 0n },
    {
      phase: 'B',
      step: 'bnbb.setMetadata (ops key)',
      method: 'paymentInfo + metadata deposit',
      fee: (await fee(api.tx.assets.setMetadata(assetId, name, symbol, 18))) + planck(c.metadataDepositBase) + planck(c.metadataDepositPerByte) * BigInt(name.length + symbol.length),
      value: 0n,
    },
    { phase: 'B', step: 'bnbb.mint (ops key)', method: 'paymentInfo', fee: await fee(api.tx.assets.mint(assetId, gw, SUPPLY)), value: 0n },
    { phase: 'B', step: 'bnbb.setTeam (ops key)', method: 'paymentInfo', fee: await fee(api.tx.assets.setTeam(assetId, gw, gw, gw)), value: 0n },
    { phase: 'B', step: 'bnbb.transferOwnership (ops key)', method: 'paymentInfo', fee: await fee(api.tx.assets.transferOwnership(assetId, gw)), value: 0n },
  ];
  for (const k of flag('minimal') || flag('no-bnb-vaults') ? [] : ['BnbbVault', 'BnbbForwarder']) {
    lines.push({
      phase: 'B',
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
