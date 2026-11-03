/**
 * EVM vs WASM: the same Parlia verification through ParliaClient.sol (pallet-revive) and its ink!
 * twin (pallet-contracts) on Portaldot. Nothing is ever sent: every live number is a dry-run.
 *
 *   npx tsx packages/sdk/scripts/benchmark.ts [--offline] [--deployments <dir>] [--from <0x funded address>]
 *   npx tsx packages/sdk/scripts/render-benchmark.ts        # docs/BENCHMARK.md from the result
 *
 * 1. Inputs, identical for both VMs: windows of 16, 32 and 48 consecutive real BSC testnet headers
 *    and one real storage proof, as EVM calldata and as an ink! (SCALE) message.
 * 2. Local measurements, made beforehand from the same inputs:
 *    results/benchmark-evm-local.json   forge test --match-contract ParliaBenchmarkTest (contracts/)
 *    results/benchmark-wasm-local.json  cargo run --release (ink/bench, in-process pallet-contracts)
 * 3. Live dry-runs against the deployed clients in deployments/portaldot.json: ReviveApi_call and
 *    eth_estimateGas for ParliaClient, ContractsApi_call for the ink! client, each on a fresh window
 *    of live BSC headers. Without deployed clients this step says what to deploy and is skipped.
 *    Also dry-runs the upload of the ink! code (ContractsApi_upload_code) and its instantiation
 *    from a fresh checkpoint (ContractsApi_instantiate), which price the deploy.
 *
 * Writes results/benchmark.json. Missing values are null; the renderer prints "not measured yet".
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, encodeFunctionData, getAddress, http, keccak256, concat, type Address, type Hex, type PublicClient } from 'viem';
import { bscVerifierAbi, parliaClientAbi } from '../src/abi.js';
import { checkpointAt } from '../src/bsc/checkpoint.js';
import { BscClient } from '../src/bsc/client.js';
import { headerRlp } from '../src/bsc/header.js';
import { buildWindow, type HeaderSource, type TrustedSet } from '../src/bsc/window.js';
import { PORTALDOT_EVM_RPC, PORTALDOT_SUBSTRATE_WS } from '../src/chains.js';
import { fmtUnits } from '../src/deploy/cost.js';
import { DEFAULT_DEPLOYMENTS_DIR, loadDeployment } from '../src/deployments.js';
import { quoteInkDeploy } from '../src/deploy/ink.js';
import {
  codeParam,
  decodeInkSubmitWindow,
  decodeInkTrustedSet,
  encodeInkFinalized,
  encodeInkStorageAt,
  encodeInkSubmitWindow,
  encodeInkValidatorSet,
  inkCallFee,
  inkDryRunCall,
  loadInkArtifact,
} from '../src/ink/parlia.js';
import { connectPortaldot, disconnectPortaldot } from '../src/portaldot/client.js';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

const ROOT = resolve(import.meta.dirname, '../../..');
const FIXTURES = resolve(ROOT, 'contracts/test/fixtures');
const RESULTS = resolve(ROOT, 'results');
const SIZES = [16, 32, 48] as const;
/** First header of the fixture windows: E+2 of epoch 140342000 (no epoch block inside). */
const FIRST = 2;
/** A funded Portaldot EVM account, only used as the origin of dry-runs. */
const FROM = getAddress(opt('from', '0x9234511ee6f98f944b846d19d4013a81f93bd5f9')!);
const PLANCK = 14;
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const readJson = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined);
const tpot = (planck: bigint | undefined) => (planck === undefined ? null : fmtUnits(planck, PLANCK, 6));

type Side = {
  refTime: number | null;
  proofSize: number | null;
  /** EVM only: pallet-revive's gasConsumed from the dry-run. */
  gas: number | null;
  /** EVM only: eth_estimateGas (it fails on calls that revert). */
  ethEstimateGas?: number | null;
  fee: string | null;
  storageDeposit: string | null;
  finalizes: boolean | null;
  error?: string;
};
const empty = (): Side => ({ refTime: null, proofSize: null, gas: null, fee: null, storageDeposit: null, finalizes: null });

// ------------------------------------------------------------------ 1. identical inputs

const headersFx = readJson(resolve(FIXTURES, 'bsc-headers.json'));
const storageFx = readJson(resolve(FIXTURES, 'bsc-storage.json'));

function inputsFor(rlps: Hex[]) {
  const evm = encodeFunctionData({ abi: parliaClientAbi, functionName: 'submitWindow', args: [rlps] });
  const ink = encodeInkSubmitWindow(rlps);
  return { evm, ink, rlpBytes: rlps.reduce((n, r) => n + (r.length - 2) / 2, 0), digest: keccak256(concat(rlps)) };
}

const fixtureInputs = Object.fromEntries(
  SIZES.map((n) => {
    const rlps = (headersFx.rlps as Hex[]).slice(FIRST, FIRST + n);
    const x = inputsFor(rlps);
    return [
      `window${n}`,
      { headers: n, firstBlock: headersFx.numbers[FIRST], rlpBytes: x.rlpBytes, headersKeccak: x.digest, evmCalldataBytes: (x.evm.length - 2) / 2, inkInputBytes: (x.ink.length - 2) / 2 },
    ];
  }),
);
const storageArgs = [
  BigInt(storageFx.blockNumber),
  storageFx.account as Address,
  storageFx.accountProof as Hex[],
  storageFx.existing.slot as Hex,
  storageFx.existing.proof as Hex[],
] as const;
const storageEvm = encodeFunctionData({ abi: bscVerifierAbi, functionName: 'storageAt', args: storageArgs });
const storageInk = encodeInkStorageAt(...storageArgs);
const storageInput = {
  blockNumber: storageFx.blockNumber,
  account: storageFx.account,
  slot: storageFx.existing.slot,
  accountProofNodes: storageFx.accountProof.length,
  storageProofNodes: storageFx.existing.proof.length,
  evmCalldataBytes: (storageEvm.length - 2) / 2,
  inkInputBytes: (storageInk.length - 2) / 2,
};

// ------------------------------------------------------------------ 2. local measurements

const evmLocal = readJson(resolve(RESULTS, 'benchmark-evm-local.json'));
const wasmLocal = readJson(resolve(RESULTS, 'benchmark-wasm-local.json'));
if (!evmLocal) log('no results/benchmark-evm-local.json: run `forge test --match-contract ParliaBenchmarkTest` in contracts/');
if (!wasmLocal) log('no results/benchmark-wasm-local.json: run `cargo run --release` in ink/bench');

const local: Record<string, { evm: Record<string, unknown> | null; wasm: Record<string, unknown> | null }> = {};
for (const n of SIZES) {
  const k = `window${n}`;
  const e = evmLocal?.windows?.[k];
  const w = wasmLocal?.windows?.[k];
  local[k] = {
    evm: e ? { gas: e.executionGas + e.intrinsicGas, executionGas: e.executionGas, intrinsicGas: e.intrinsicGas, calldataBytes: e.calldataBytes, finalizes: e.finalizes } : null,
    wasm: w ? { refTime: w.refTime, proofSize: w.proofSize, storageDepositUnits: w.storageDepositUnits, inputBytes: w.inputBytes, finalizes: w.finalizes } : null,
  };
}
{
  const e = evmLocal?.storageProof;
  const w = wasmLocal?.storageProof;
  local.storageProof = {
    evm: e ? { gas: e.executionGas + e.intrinsicGas, executionGas: e.executionGas, intrinsicGas: e.intrinsicGas, calldataBytes: e.calldataBytes } : null,
    wasm: w ? { refTime: w.refTime, proofSize: w.proofSize, inputBytes: w.inputBytes } : null,
  };
}

// ------------------------------------------------------------------ 3. live dry-runs

const live: Record<string, { evm: Side; wasm: Side }> = Object.fromEntries(
  [...SIZES.map((n) => `window${n}`), 'storageProof'].map((k) => [k, { evm: empty(), wasm: empty() }]),
);
const chain: Record<string, unknown> = {};
const notes: string[] = [];

const weightOf = (w: any) => ({ refTime: Number(w.refTime.toString()), proofSize: Number(w.proofSize.toString()) });
const depositOf = (d: any): bigint => (d.isCharge ? BigInt(d.asCharge.toString()) : -BigInt(d.asRefund.toString()));

async function measureLive() {
  const portaldot = await connectPortaldot(process.env.PORTALDOT_WS ?? PORTALDOT_SUBSTRATE_WS);
  const api = portaldot.api as any;
  try {
    const origin = (await api.call.reviveApi.accountId(FROM)).toString();
    const c = api.consts.contracts;
    chain.at = new Date().toISOString();
    chain.runtime = `${api.runtimeVersion.specName.toString()} ${api.runtimeVersion.specVersion.toNumber()}`;
    chain.contracts = { depositPerByte: c.depositPerByte.toString(), depositPerItem: c.depositPerItem.toString(), codeHashLockupDepositPercent: c.codeHashLockupDepositPercent.toHuman(), apiVersion: c.apiVersion?.toString() };
    chain.revive = { depositPerByte: api.consts.revive.depositPerByte.toString(), depositPerItem: api.consts.revive.depositPerItem.toString() };

    // Can the chain take the ink! code? Dry-run the upload, and the instantiation from a fresh
    // checkpoint (the same constructor arguments the deploy would send).
    const art = loadInkArtifact();
    const up = await api.call.contractsApi.uploadCode(origin, codeParam(art.wasm), null, 'Enforced');
    const upErr = up.isErr ? (up.asErr.isModule ? (({ section, name }: any) => `${section}.${name}`)(api.registry.findMetaError(up.asErr.asModule)) : up.asErr.toString()) : undefined;
    chain.inkUpload = { wasmBytes: art.bytes, codeHash: art.codeHash, ok: up.isOk, deposit: up.isOk ? up.asOk.deposit.toString() : undefined, error: upErr };
    log(`ink! upload dry-run: ${up.isOk ? `ok, code deposit ${tpot(BigInt(up.asOk.deposit.toString()))} tPOT` : upErr}`);
    const bscForCp = new BscClient();
    const head0 = await bscForCp.blockNumber();
    const cpEpoch = head0 - 200n - ((head0 - 200n) % 1000n);
    const cp = await checkpointAt(bscForCp, cpEpoch);
    const q = await quoteInkDeploy(portaldot.api, origin, cp, 7n * 86_400n);
    chain.inkInstantiate = {
      checkpointEpoch: Number(cp.epoch),
      ok: q.ok,
      reason: q.reason,
      refTime: q.gasRequired ? Number(q.gasRequired.refTime) : null,
      proofSize: q.gasRequired ? Number(q.gasRequired.proofSize) : null,
      deposit: tpot(q.deposit),
      depositMethod: q.depositMethod,
      fee: tpot(q.fee),
    };
    log(`ink! instantiate dry-run (checkpoint ${cp.epoch}): ${q.ok ? `ok, deposit ${tpot(q.deposit)} tPOT + fee ${tpot(q.fee)} tPOT` : q.reason}`);

    const dep = loadDeployment('portaldot', opt('deployments', DEFAULT_DEPLOYMENTS_DIR));
    const evmClient = dep.contracts.ParliaClient?.address;
    const verifier = dep.contracts.BscVerifier?.address;
    const ink = (dep.meta.parliaClientInk as { address?: string } | undefined)?.address;
    if (!evmClient || !ink) {
      const missing = [!evmClient && 'ParliaClient', !ink && 'the ink! client (meta.parliaClientInk)'].filter(Boolean).join(' and ');
      log(`deploy first: deployments/portaldot.json has no ${missing}.`);
      log('  npm run deploy -- --env <secrets.env> --chain portaldot --with-ink');
      log('live dry-runs skipped; local measurements and inputs are still written.');
      notes.push(`Live dry-runs need both clients deployed; ${missing} missing at ${chain.at}.`);
      return;
    }

    // A fresh live window: above both clients' trusted set, not finalized by either.
    const pub = createPublicClient({ transport: http(process.env.PORTALDOT_EVM_RPC ?? PORTALDOT_EVM_RPC, { timeout: 120_000 }) }) as PublicClient;
    const [vals, turnLength, epoch, activeFrom] = (await pub.readContract({ address: evmClient, abi: parliaClientAbi, functionName: 'validatorSet' })) as readonly [Address[], number, bigint, bigint, bigint];
    const set: TrustedSet = { validators: [...vals], turnLength, epoch, activeFrom };
    const inkSet = decodeInkTrustedSet((await inkDryRunCall(api, origin, ink, encodeInkValidatorSet())).data);
    if (inkSet.epoch !== set.epoch) notes.push(`The clients trust different epochs (EVM ${set.epoch}, ink! ${inkSet.epoch}); the window is built for the EVM client's set.`);
    const bsc = new BscClient();
    const head = await bsc.blockNumber();
    const start = head - 120n;
    const source: HeaderSource = { headerRlps: async (from, count) => (await bsc.blocks(from, count)).map(headerRlp) };
    const minimal48 = await buildWindow(source, start, set, { maxHeaders: 48 });
    const rlps = await source.headerRlps(start, 48);
    log(`live window from BSC block ${start}: quorum after ${minimal48.length} headers`);
    chain.window = { firstBlock: Number(start), quorumAfter: minimal48.length, evmClient, inkClient: ink, origin: FROM };
    const inkFinal = await inkDryRunCall(api, origin, ink, encodeInkFinalized(start));
    if (inkFinal.data[1] === 1) notes.push(`Block ${start} is already finalized on the ink! client; its dry-run reverts with AlreadyFinalized.`);

    const gasPrice = await pub.getGasPrice();
    for (const n of SIZES) {
      const k = `window${n}`;
      const x = inputsFor(rlps.slice(0, n));
      // EVM: ReviveApi_call, then eth_estimateGas when the call goes through.
      const r = await api.call.reviveApi.call(origin, evmClient, 0, null, null, x.evm);
      const e = live[k].evm;
      const used = weightOf(r.weightConsumed);
      e.refTime = used.refTime;
      e.proofSize = used.proofSize;
      const dep = depositOf(r.storageDeposit);
      e.storageDeposit = tpot(dep);
      const reverted = r.result.isOk && (Number(r.result.asOk.flags.bits?.toString() ?? 0) & 1) === 1;
      e.finalizes = r.result.isOk && !reverted;
      if (r.result.isErr) e.error = r.result.asErr.toString();
      if (r.gasConsumed !== undefined) e.gas = Number(r.gasConsumed.toString());
      e.ethEstimateGas = null;
      if (e.finalizes) {
        try {
          e.ethEstimateGas = Number(await pub.estimateGas({ account: FROM, to: evmClient, data: x.evm }));
        } catch (err) {
          e.error = `eth_estimateGas: ${(err as Error).message.split('\n')[0]}`;
        }
      }
      const req = r.weightRequired;
      const fee = BigInt((await api.tx.revive.call(evmClient, 0, req, dep > 0n ? dep : 0n, x.evm).paymentInfo(origin)).partialFee.toString());
      e.fee = tpot(fee + (dep > 0n ? dep : 0n));

      // WASM: ContractsApi_call.
      const w = live[k].wasm;
      const d = await inkDryRunCall(api, origin, ink, x.ink);
      w.refTime = Number(d.gasConsumed.refTime);
      w.proofSize = Number(d.gasConsumed.proofSize);
      w.storageDeposit = tpot(d.storageDeposit);
      w.finalizes = !d.dispatchError && !d.reverted;
      if (d.dispatchError) w.error = d.dispatchError;
      else if (d.reverted) w.error = (decodeInkSubmitWindow(d.data) as { error?: string }).error;
      const inkFee = await inkCallFee(api, origin, ink, x.ink, d.gasRequired);
      w.fee = tpot(inkFee + (d.storageDeposit > 0n ? d.storageDeposit : 0n));
      log(`${k}: evm ${e.refTime} ps / ${e.proofSize} B, fee ${e.fee}; wasm ${w.refTime} ps / ${w.proofSize} B, fee ${w.fee}`);
    }
    if (gasPrice) chain.evmGasPrice = gasPrice.toString();
    notes.push(
      'storageProof is not dry-run live: it needs a BSC block finalized on both clients while its eth_getProof result is still held, ' +
        'which only a real window submission provides (BSC nodes prove `latest` only).',
    );
    if (verifier) chain.window = { ...(chain.window as object), verifier };
  } finally {
    await disconnectPortaldot(portaldot);
  }
}

async function main() {
  if (!flag('offline')) {
    try {
      await measureLive();
    } catch (e) {
      log(`live measurement failed: ${(e as Error).message}`);
      notes.push(`Live measurement failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  const evmArt = readJson(resolve(ROOT, 'contracts/out-portaldot/ParliaClient.sol/ParliaClient.json')) ?? readJson(resolve(ROOT, 'contracts/out/ParliaClient.sol/ParliaClient.json'));
  let wasmBytes: number | null = null;
  try {
    wasmBytes = loadInkArtifact().bytes;
  } catch {
    wasmBytes = wasmLocal?.wasmBytes ?? null;
  }
  const out = {
    generatedAt: new Date().toISOString(),
    inputs: { source: 'bsc-headers.json (BSC testnet, epoch 140342000, from E+2) and bsc-storage.json (WBNB slot 0)', ...fixtureInputs, storageProof: storageInput },
    ...live,
    local: { ...local, evmNote: evmLocal?.note ?? null, wasmNote: wasmLocal?.note ?? null },
    code: {
      evm: { contract: 'ParliaClient.sol', bytes: evmArt ? (evmArt.deployedBytecode.object.length - 2) / 2 : null, profile: existsSync(resolve(ROOT, 'contracts/out-portaldot')) ? 'portaldot (optimizer_runs 1, no metadata)' : 'default' },
      wasm: { contract: 'ink/parlia_client', bytes: wasmBytes },
    },
    chain: Object.keys(chain).length ? chain : null,
    notes,
  };
  const path = resolve(RESULTS, 'benchmark.json');
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  log(`wrote ${path}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
