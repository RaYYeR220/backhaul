/**
 * BNB Chain → Portaldot, end to end, on a Chopsticks fork of the Portaldot V3 testnet.
 *
 * Deploying ParliaClient + BscVerifier on the live testnet costs ~948 tPOT of storage deposit
 * that the deployer does not have. Everything else in this run is real:
 *   - the Portaldot side is a fork of the live V3 testnet, so PortaldotGateway (its code, its
 *     immutable verifier address, its lockedPOT escrow) is the deployed contract, unmodified;
 *   - ParliaClient and BscVerifier are deployed on the fork by the real deployer key at its real
 *     reserved nonces 4 and 5, so they land at exactly the addresses the gateway already trusts;
 *   - the burn is a real BscGateway.burnPPOT transaction on BNB Chain testnet;
 *   - the Parlia checkpoint, the finality window (real BSC headers and seals) and the receipt
 *     proof come from BNB Chain testnet.
 * What the fork changes by hand (dev_setStorage), and nothing else: the deployer's and the
 * relayer's free balance (System.Account), to pay the storage deposit the live chain would
 * charge; and TransactionStorage.RetentionPeriod, because Chopsticks cannot supply the
 * storage-proof inherent the live block author does (the pallet's on_finalize would panic).
 *
 * Reproduce (one command once the fork is up; the env file holds PORTALDOT_DEPLOYER_PK and
 * BACKHAUL_RELAYER_PK):
 *
 *   npx @acala-network/chopsticks@latest --endpoint wss://test-node-v3.portaldot.dev --port 8000 \
 *     --build-block-mode Instant --allow-unresolved-imports [--block <n>]
 *   npx tsx packages/sdk/scripts/fork-reverse.ts --env <secrets.env> --burn-tx <0x…>
 *
 * `--burn-tx` reuses an existing burn (recorded in results/fork-reverse.json). `--burn` instead
 * sends a new BscGateway.burnPPOT(0.5 pPOT, deployer) on BNB Chain testnet first; it is the only
 * transaction this script ever sends outside the fork, and it refuses to run without the flag.
 * `--rehearse` sends nothing anywhere but the fork: it deploys, then finalizes a recent BSC
 * block and stops (no burn, no proof).
 * The fork must be fresh (its head is checked against the live chain). Contracts come from
 * contracts/out-portaldot (`FOUNDRY_PROFILE=portaldot forge build`), as in the live deploy.
 * `--allow-unresolved-imports` is needed because the runtime imports a statement-store host
 * function that Chopsticks' executor does not provide (it is never called on these paths).
 * On Windows, Chopsticks 1.5.2 loads its plugins from a `/C:/…` path and fails at start: patch
 * `location.pathname` → `require("url").fileURLToPath(location)` in its dist/cjs/plugins/index.js.
 * Writes results/fork-reverse.json (or --out). One run takes about 3 minutes.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiPromise, WsProvider } from '@polkadot/api';
import {
  concatHex,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  keccak256,
  formatEther,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { backhaulErrorsAbi, bscGatewayAbi, parliaClientAbi, portaldotGatewayAbi, ppotAbi } from '../src/abi.js';
import { CONTRACTS_DIR, loadArtifact } from '../src/artifacts.js';
import {
  BscClient,
  BSC_TESTNET_RPCS,
  buildCommitmentProof,
  buildWindow,
  checkpointAt,
  COMMITTED_TOPIC,
  decodeCommitmentProof,
  decodeHeader,
  encodeCommitmentProof,
  sealerOf,
  type ParliaCheckpoint,
  type TrustedSet,
} from '../src/bsc/index.js';
import { accountId32Of, BSC_CHAIN_ID, PORTALDOT_CHAIN_ID, PORTALDOT_SUBSTRATE_WS } from '../src/chains.js';
import { jsonReplacer, loadDeployment } from '../src/deployments.js';
import { loadEnvFromArgs, requireEnv } from '../src/env.js';
import { senderFor } from '../src/evm.js';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

loadEnvFromArgs(process.argv);
const FORK_WS = opt('fork', 'ws://127.0.0.1:8000')!;
const OUT = resolve(opt('out', resolve(import.meta.dirname, '../../../results/fork-reverse.json'))!);
const BURN_AMOUNT = BigInt(opt('amount-wei', '500000000000000000')!); // 0.5 pPOT
const TRUSTING_PERIOD = 1_209_600n; // 14 days, as the live deploy plan
const EPOCH_LENGTH = 1000n;
/** tPOT has 14 decimals on the substrate side. */
const PLANCK = 10n ** 14n;
const FUND_DEPLOYER = 5_000n * PLANCK;
const FUND_RELAYER = 1_000n * PLANCK;
const RETENTION = 2_000_000_000;

const deployerPk = requireEnv('PORTALDOT_DEPLOYER_PK') as Hex;
const relayerPk = requireEnv('BACKHAUL_RELAYER_PK') as Hex;
const deployer = privateKeyToAccount(deployerPk);
const relayer = privateKeyToAccount(relayerPk);

const pdDep = loadDeployment('portaldot');
const bscDep = loadDeployment('bsc');
const GATEWAY = getAddress(pdDep.contracts.PortaldotGateway!.address);
const BSC_OUTBOX = getAddress(bscDep.contracts.Outbox!.address);
const BSC_GATEWAY = getAddress(bscDep.contracts.BscGateway!.address);
const PPOT = getAddress(bscDep.contracts.PPOT!.address);
const reserved = (pdDep.meta.noncePlan as { reserved: { nonce: number; name?: string; address?: Address }[] }).reserved;
const reservedAt = (name: string) => {
  const r = reserved.find((x) => x.name === name);
  if (!r?.address) throw new Error(`no reserved address for ${name} in deployments/portaldot.json`);
  return { nonce: r.nonce, address: getAddress(r.address) };
};
const PARLIA = reservedAt('ParliaClient');
const VERIFIER = reservedAt('BscVerifier');
const PD_ARTIFACTS = resolve(CONTRACTS_DIR, 'out-portaldot');

const errorsAbi = backhaulErrorsAbi as unknown as Abi;

// ------------------------------------------------------------------------------------------------
// A minimal EVM front for the fork: reads and gas estimates through the ReviveApi runtime API,
// writes as signed Ethereum transactions inside revive.ethTransact (what eth-rpc submits).

interface ForkTx {
  ethHash: Hex;
  extrinsic: Hex;
  block: number;
  blockHash: Hex;
  ok: boolean;
  /** Module error of a reverted or failed transaction. */
  revert?: string;
  events: { section: string; method: string; data: unknown }[];
  logs: { address: Address; topics: Hex[]; data: Hex }[];
}

class ForkEvm {
  constructor(readonly api: ApiPromise) {}
  private get rv() {
    return (this.api.call as any).reviveApi;
  }

  private generic(from: Address, to: Address | null, data: Hex, value = 0n) {
    return {
      from,
      to,
      input: { input: data, data: null },
      value,
      authorizationList: [],
      blobVersionedHashes: [],
      blobs: [],
    };
  }

  async nonce(a: Address): Promise<number> {
    return Number((await this.rv.nonce(a)).toString());
  }
  async balance(a: Address): Promise<bigint> {
    return BigInt((await this.rv.balance(a)).toString());
  }

  /** Dry-runs a call; returns its output or throws with the decoded revert reason. */
  async dryRun(from: Address, to: Address | null, data: Hex, value = 0n): Promise<Hex> {
    const r = await this.rv.ethTransact(this.generic(from, to, data, value));
    if (r.isOk) return r.asOk.data.toHex() as Hex;
    throw new Error(revertText(r.asErr));
  }

  async read<T>(to: Address, abi: Abi, fn: string, args: readonly unknown[] = []): Promise<T> {
    const out = await this.dryRun(deployer.address, to, encodeFunctionData({ abi, functionName: fn, args }));
    return decodeFunctionResult({ abi, functionName: fn, data: out }) as T;
  }

  async estimate(from: Address, to: Address | null, data: Hex, value = 0n): Promise<bigint> {
    const r = await this.rv.ethEstimateGas(this.generic(from, to, data, value), { timestampOverride: null, performBalanceChecks: null, stateOverrides: null });
    if (r.isOk) return BigInt(r.asOk.toString());
    throw new Error(revertText(r.asErr));
  }

  /** Signs and submits an Ethereum transaction; resolves with its block and events. */
  async send(pk: Hex, to: Address | null, data: Hex, opts: { value?: bigint; nonce?: number; gas?: bigint } = {}): Promise<ForkTx> {
    const acct = privateKeyToAccount(pk);
    const nonce = opts.nonce ?? (await this.nonce(acct.address));
    const gasPrice = BigInt((await this.rv.gasPrice()).toString());
    const gas = opts.gas ?? ((await this.estimate(acct.address, to, data, opts.value ?? 0n)) * 13n) / 10n;
    const raw = await acct.signTransaction({
      chainId: PORTALDOT_CHAIN_ID,
      type: 'legacy',
      nonce,
      gasPrice,
      gas,
      to,
      data,
      value: opts.value ?? 0n,
    });
    const xt = this.api.tx.revive.ethTransact(raw);
    const { blockHash, events } = await new Promise<{ blockHash: Hex; events: any[] }>((res, rej) => {
      let unsub: (() => void) | undefined;
      setTimeout(() => rej(new Error('no block within 300 s')), 300_000).unref();
      xt.send((r: any) => {
        if (r.status.isInBlock || r.status.isFinalized) {
          unsub?.();
          res({ blockHash: (r.status.isInBlock ? r.status.asInBlock : r.status.asFinalized).toHex(), events: r.events });
        } else if (r.status.isInvalid || r.status.isDropped || r.status.isUsurped) {
          unsub?.();
          rej(new Error(`extrinsic ${r.status.type}`));
        }
      })
        .then((u: () => void) => (unsub = u))
        .catch(rej);
    });
    const header = await this.api.rpc.chain.getHeader(blockHash);
    const evs = events.map((e: any) => ({ section: e.event.section, method: e.event.method, data: e.event.data.toJSON() }));
    const logs = events
      .filter((e: any) => e.event.section === 'revive' && e.event.method === 'ContractEmitted')
      .map((e: any) => ({
        address: getAddress(e.event.data.contract.toHex()),
        topics: e.event.data.topics.map((t: any) => t.toHex() as Hex),
        data: e.event.data.data.toHex() as Hex,
      }));
    // A reverted Ethereum call is still a successful extrinsic: revive marks it with EthExtrinsicRevert.
    const failed = events.find(
      (e: any) => (e.event.section === 'system' && e.event.method === 'ExtrinsicFailed') || (e.event.section === 'revive' && e.event.method === 'EthExtrinsicRevert'),
    );
    let revert: string | undefined;
    if (failed) {
      const err = failed.event.data[0];
      revert = err.isModule ? (({ section, name }) => `${section}.${name}`)(this.api.registry.findMetaError(err.asModule)) : err.toString();
    }
    return { ethHash: keccak256(raw), extrinsic: xt.hash.toHex() as Hex, block: header.number.toNumber(), blockHash, ok: !failed, revert, events: evs, logs };
  }

  async codeOf(a: Address): Promise<{ codeHash: Hex; bytes: number } | undefined> {
    const info: any = await this.api.query.revive.accountInfoOf(a);
    if (info.isNone) return undefined;
    const t = info.unwrap().accountType;
    if (!t.isContract) return undefined;
    const codeHash = t.asContract.codeHash.toHex() as Hex;
    const code: any = await this.api.query.revive.pristineCode(codeHash);
    return { codeHash, bytes: code.isSome ? code.unwrap().length : 0 };
  }
}

function revertText(err: any): string {
  if (err.isData) {
    const data = err.asData.toHex() as Hex;
    try {
      const d = decodeErrorResult({ abi: errorsAbi, data });
      return `${d.errorName}(${(d.args ?? []).map(String).join(', ')})`;
    } catch {
      return `revert data ${data}`;
    }
  }
  return err.isMessage ? err.asMessage.toString() : JSON.stringify(err.toJSON());
}

// ------------------------------------------------------------------------------------------------

async function setFree(api: ApiPromise, who: Address, free: bigint): Promise<void> {
  const id = accountId32Of(who);
  const cur: any = await api.query.system.account(id);
  const next = api.createType('FrameSystemAccountInfo', {
    nonce: cur.nonce,
    consumers: cur.consumers,
    providers: cur.providers,
    sufficients: cur.sufficients,
    data: { free, reserved: cur.data.reserved, frozen: cur.data.frozen, flags: cur.data.flags },
  });
  await (api as any)._rpcCore.provider.send('dev_setStorage', [[[api.query.system.account.key(id), next.toHex()]]]);
}

/** The newest epoch whose set is already in force at `block`. */
async function checkpointFor(bsc: BscClient, block: bigint): Promise<ParliaCheckpoint> {
  let epoch = block - (block % EPOCH_LENGTH);
  for (let i = 0; i < 3; i++, epoch -= EPOCH_LENGTH) {
    const cp = await checkpointAt(bsc, epoch, EPOCH_LENGTH);
    if (cp.activeFrom <= block) return cp;
  }
  throw new Error(`no checkpoint covers BSC block ${block}`);
}

function setOf(t: readonly [readonly Address[], number, bigint, bigint, bigint, bigint]): TrustedSet & { epochTimestamp: bigint; installedAt: bigint } {
  return { validators: [...t[0]].map((a) => getAddress(a)), turnLength: Number(t[1]), epoch: BigInt(t[2]), activeFrom: BigInt(t[3]), epochTimestamp: BigInt(t[4]), installedAt: BigInt(t[5]) };
}

async function main() {
  const bsc = new BscClient({ urls: process.env.BSC_RPC ? [process.env.BSC_RPC, ...BSC_TESTNET_RPCS] : BSC_TESTNET_RPCS });
  const api = await ApiPromise.create({ provider: new WsProvider(FORK_WS), noInitWarn: true });
  const evm = new ForkEvm(api);

  // ---------------------------------------------------------------- 1. the fork is the live chain
  const chain = (await api.rpc.system.chain()).toString();
  const head = await api.rpc.chain.getHeader();
  const forkBlock = head.number.toNumber();
  const forkBlockHash = head.hash.toHex() as Hex;
  const live = await ApiPromise.create({ provider: new WsProvider(PORTALDOT_SUBSTRATE_WS), noInitWarn: true });
  const liveHash = (await live.rpc.chain.getBlockHash(forkBlock)).toHex();
  await live.disconnect();
  if (liveHash !== forkBlockHash) throw new Error(`fork head ${forkBlock} ${forkBlockHash} is not live block ${liveHash}: start a fresh fork`);
  log(`fork of ${chain} at block ${forkBlock} ${forkBlockHash} (same hash on the live chain)`);

  const gwCode = await evm.codeOf(GATEWAY);
  if (!gwCode) throw new Error(`no PortaldotGateway at ${GATEWAY} on the fork`);
  const trusted = getAddress(await evm.read<Address>(GATEWAY, portaldotGatewayAbi as Abi, 'verifier'));
  if (trusted !== VERIFIER.address) throw new Error(`gateway trusts ${trusted}, reserved BscVerifier is ${VERIFIER.address}`);
  const nonce0 = await evm.nonce(deployer.address);
  if (nonce0 !== PARLIA.nonce) throw new Error(`deployer nonce ${nonce0} on the fork, ParliaClient is reserved at ${PARLIA.nonce}`);
  for (const a of [PARLIA.address, VERIFIER.address]) if (await evm.codeOf(a)) throw new Error(`${a} already has code on the fork`);
  const lockedBefore = await evm.read<bigint>(GATEWAY, portaldotGatewayAbi as Abi, 'lockedPOT');
  log(`PortaldotGateway ${GATEWAY}: code ${gwCode.codeHash} (${gwCode.bytes} B), verifier ${trusted}, lockedPOT ${formatEther(lockedBefore)}; deployer nonce ${nonce0}`);

  // ---------------------------------------------------------------- 2. the real BSC burn
  const rehearse = flag('rehearse');
  let burnTx = opt('burn-tx') as Hex | undefined;
  if (!burnTx && !rehearse) {
    if (!flag('burn')) throw new Error('pass --burn-tx <hash> to reuse a burn, or --burn to send BscGateway.burnPPOT on BNB Chain testnet');
    const bscSender = senderFor('bsc', deployerPk);
    const held = (await bscSender.pub.readContract({ address: PPOT, abi: ppotAbi as Abi, functionName: 'balanceOf', args: [deployer.address] })) as bigint;
    if (held < BURN_AMOUNT) throw new Error(`deployer holds ${formatEther(held)} pPOT, burn needs ${formatEther(BURN_AMOUNT)}`);
    log(`BSC: burnPPOT(${formatEther(BURN_AMOUNT)} pPOT → ${deployer.address}) from ${deployer.address} (holds ${formatEther(held)})`);
    const r = await bscSender.write(BSC_GATEWAY, bscGatewayAbi as Abi, 'burnPPOT', [BURN_AMOUNT, deployer.address]);
    burnTx = r.hash;
    log(`BSC burn ${burnTx} in block ${r.receipt.blockNumber}`);
  }
  const burnReceipt = burnTx ? await bsc.transactionReceipt(burnTx) : undefined;
  if (burnReceipt && BigInt(burnReceipt.status ?? '0x0') !== 1n) throw new Error(`burn ${burnTx} failed on BSC`);
  // --rehearse: no burn; a recent BSC block stands in, and the run stops after the window
  const burnBlock = burnReceipt ? BigInt(burnReceipt.blockNumber) : (await bsc.blockNumber()) - 40n;
  let transfer: { nonce: bigint; kind: number; recipient: Address; amount: bigint } | undefined;
  let key: Hex | undefined;
  for (const l of burnReceipt?.logs ?? []) {
    if (getAddress(l.address) === BSC_GATEWAY) {
      try {
        const ev = decodeEventLog({ abi: bscGatewayAbi as Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as any;
        if (ev.eventName === 'Locked') transfer = ev.args.t;
      } catch {}
    }
    if (getAddress(l.address) === BSC_OUTBOX && l.topics[0] === COMMITTED_TOPIC) key = l.topics[1] as Hex;
  }
  if (burnReceipt && (!transfer || !key)) throw new Error(`burn ${burnTx} has no Locked/Committed logs`);
  if (transfer && transfer.kind !== 2) throw new Error(`transfer kind ${transfer.kind}, expected 2 (PPOT_TO_PORTALDOT)`);
  if (transfer) log(`burn: BSC block ${burnBlock}, transfer nonce ${transfer.nonce}, ${formatEther(transfer.amount)} → ${transfer.recipient}, outbox key ${key}`);

  // ---------------------------------------------------------------- 3. fund + deploy on the fork
  // Chopsticks has no transaction-storage proof inherent, and the live chain holds stored data
  // whose proof would fall due in the fork's blocks (on_finalize asserts it was checked): push
  // the retention period out so no proof falls due. Nothing on the bridge path reads this pallet.
  await (api as any)._rpcCore.provider.send('dev_setStorage', [[[api.query.transactionStorage.retentionPeriod.key(), api.createType('u32', RETENTION).toHex()]]]);
  await setFree(api, deployer.address, FUND_DEPLOYER);
  await setFree(api, relayer.address, FUND_RELAYER);
  log(`fork: deployer free set to ${FUND_DEPLOYER / PLANCK} tPOT, relayer to ${FUND_RELAYER / PLANCK} tPOT (dev_setStorage, System.Account)`);

  const cp = await checkpointFor(bsc, burnBlock);
  log(`Parlia checkpoint: epoch ${cp.epoch} (ts ${cp.timestamp}), ${cp.validators.length} validators, turn ${cp.turnLength}, active from ${cp.activeFrom}`);
  const pc = loadArtifact('ParliaClient', PD_ARTIFACTS);
  const pcData = encodeDeployData({ abi: pc.abi, bytecode: pc.bytecode, args: [BigInt(BSC_CHAIN_ID), EPOCH_LENGTH, TRUSTING_PERIOD, cp] });
  const balBeforeDeploy = await evm.balance(deployer.address);
  const d1 = await evm.send(deployerPk, null, pcData, { nonce: PARLIA.nonce });
  if (!d1.ok) throw new Error(`ParliaClient deploy failed: ${JSON.stringify(d1.events)}`);
  const bv = loadArtifact('BscVerifier', PD_ARTIFACTS);
  const bvData = encodeDeployData({ abi: bv.abi, bytecode: bv.bytecode, args: [PARLIA.address, BSC_OUTBOX] });
  const d2 = await evm.send(deployerPk, null, bvData, { nonce: VERIFIER.nonce });
  if (!d2.ok) throw new Error(`BscVerifier deploy failed: ${JSON.stringify(d2.events)}`);
  const deployCost = balBeforeDeploy - (await evm.balance(deployer.address));
  for (const [name, at, n] of [['ParliaClient', PARLIA.address, PARLIA.nonce], ['BscVerifier', VERIFIER.address, VERIFIER.nonce]] as const) {
    if (getContractAddress({ from: deployer.address, nonce: BigInt(n) }) !== at) throw new Error(`${name}: reserved address mismatch`);
    if (!(await evm.codeOf(at))) throw new Error(`${name} has no code at ${at} after deploy`);
  }
  const verifierNow = getAddress(await evm.read<Address>(GATEWAY, portaldotGatewayAbi as Abi, 'verifier'));
  const verifierClient = getAddress(await evm.read<Address>(VERIFIER.address, bv.abi, 'lightClient'));
  const verifierOutbox = getAddress(await evm.read<Address>(VERIFIER.address, bv.abi, 'remoteOutbox'));
  log(`deployed ParliaClient ${PARLIA.address} (eth tx ${d1.ethHash}, fork block ${d1.block}) and BscVerifier ${VERIFIER.address} (eth tx ${d2.ethHash}, fork block ${d2.block}); deposit+fees ${formatEther(deployCost)} tPOT`);
  if (verifierNow !== VERIFIER.address || verifierClient !== PARLIA.address || verifierOutbox !== BSC_OUTBOX) throw new Error('wiring check failed');

  // ---------------------------------------------------------------- 4. the Parlia window
  const set = setOf(await evm.read(PARLIA.address, parliaClientAbi as Abi, 'validatorSet'));
  let window: Hex[] | undefined;
  for (let i = 0; !window; i++) {
    const bscHead = await bsc.blockNumber();
    if (bscHead >= burnBlock + 32n) {
      try {
        window = await buildWindow(bsc, burnBlock, set, { tolerateUntrusted: true, epochLength: EPOCH_LENGTH });
        break;
      } catch (e) {
        if (i > 20) throw e;
        log(`window not ready: ${(e as Error).message}`);
      }
    }
    await sleep(3_000);
  }
  const trustedSet = new Set(set.validators);
  const sealers: { block: string; signer: Address; trusted: boolean }[] = [];
  for (const rlp of window) {
    const h = decodeHeader(rlp);
    const s = await sealerOf(rlp, BigInt(BSC_CHAIN_ID));
    sealers.push({ block: h.number.toString(), signer: s, trusted: trustedSet.has(getAddress(s)) });
  }
  const trustedSigners = [...new Set(sealers.filter((s) => s.trusted).map((s) => s.signer))];
  const windowBytes = window.reduce((n, h) => n + (h.length - 2) / 2, 0);
  log(`window: ${window.length} headers from ${burnBlock} (${windowBytes} B), ${trustedSigners.length} distinct trusted sealers, quorum ${Math.ceil((2 * set.validators.length) / 3)}`);
  const w = await evm.send(relayerPk, PARLIA.address, encodeFunctionData({ abi: parliaClientAbi as Abi, functionName: 'submitWindow', args: [window] }));
  if (!w.ok) throw new Error(`submitWindow failed: ${JSON.stringify(w.events)}`);
  const fin = (await evm.read<{ hash: Hex; receiptsRoot: Hex }>(PARLIA.address, parliaClientAbi as Abi, 'finalized', [burnBlock])) as any;
  const bscBlock = await bsc.block(burnBlock);
  if (fin.hash.toLowerCase() !== bscBlock.hash.toLowerCase()) throw new Error(`fork ParliaClient holds ${fin.hash} for ${burnBlock}, BSC has ${bscBlock.hash}`);
  log(`submitWindow eth tx ${w.ethHash} (fork block ${w.block}): BSC block ${burnBlock} finalized as ${fin.hash}`);
  if (rehearse || !transfer || !key || !burnTx) {
    log('rehearsal done (no burn: stopping after the window)');
    await api.disconnect();
    return;
  }

  // ---------------------------------------------------------------- 5. receipt proof + negative control
  const cproof = await buildCommitmentProof(bsc, burnTx, BSC_OUTBOX, key);
  const t = { nonce: transfer.nonce, kind: transfer.kind, recipient: getAddress(transfer.recipient), amount: transfer.amount };
  const dec = decodeCommitmentProof(cproof.proof);
  if (dec.type !== 'receipt') throw new Error('expected a receipt proof');
  // Flip one byte inside the receipt itself (the leaf node of the receipts trie, near its end:
  // the Committed log's data).
  const nodes = [...dec.proof];
  const leaf = nodes[nodes.length - 1];
  const pos = leaf.length - 2 * 8; // a byte 8 from the end
  const flipped = (Number.parseInt(leaf.slice(pos, pos + 2), 16) ^ 0x01).toString(16).padStart(2, '0');
  nodes[nodes.length - 1] = `${leaf.slice(0, pos)}${flipped}${leaf.slice(pos + 2)}` as Hex;
  const tampered = encodeCommitmentProof({ blockNumber: dec.blockNumber, key: dec.key, proof: nodes, logIndex: dec.logIndex });
  const finData = (proof: Hex) => encodeFunctionData({ abi: portaldotGatewayAbi as Abi, functionName: 'finalize', args: [t, proof] });
  let negReason = '';
  try {
    await evm.dryRun(relayer.address, GATEWAY, finData(tampered));
    throw new Error('tampered receipt was accepted');
  } catch (e) {
    negReason = (e as Error).message;
    if (negReason === 'tampered receipt was accepted') throw e;
  }
  const remote = getAddress(await evm.read<Address>(GATEWAY, portaldotGatewayAbi as Abi, 'remote'));
  if (remote !== BSC_GATEWAY) throw new Error(`gateway remote is ${remote}`);
  const verifyTampered = await evm
    .read<boolean>(VERIFIER.address, bv.abi, 'verifyCommitment', [keyFor(remote, t.nonce), transferHash(t), tampered])
    .then((v) => `returns ${v}`)
    .catch((e) => `reverts: ${(e as Error).message}`);
  const verifyGenuine = await evm.read<boolean>(VERIFIER.address, bv.abi, 'verifyCommitment', [keyFor(remote, t.nonce), transferHash(t), cproof.proof]);
  if (!verifyGenuine) throw new Error('genuine proof does not verify');
  // Also send it, so the rejection is a transaction on the fork, not only a dry run.
  // a reverting call cannot be estimated: give it the genuine finalize's gas
  const finGas = await evm.estimate(relayer.address, GATEWAY, finData(cproof.proof));
  const neg = await evm.send(relayerPk, GATEWAY, finData(tampered), { gas: (finGas * 13n) / 10n }).catch((e) => ({ error: (e as Error).message }) as const);
  const negTx = 'error' in neg ? { error: neg.error } : { ethTx: neg.ethHash, forkBlock: neg.block, forkBlockHash: neg.blockHash, included: true, reverted: !neg.ok, moduleError: neg.revert };
  const stillOpen = !(await evm.read<boolean>(GATEWAY, portaldotGatewayAbi as Abi, 'isFinalized', [t.nonce]));
  if (!stillOpen) throw new Error('tampered finalize consumed the nonce');
  log(`negative control: finalize with one receipt byte flipped (leaf node byte ${(pos - 2) / 2}) → ${negReason}; verifyCommitment → ${verifyTampered}; sent: ${JSON.stringify(negTx)}`);
  if (!('error' in neg) && neg.ok) throw new Error('tampered finalize succeeded on the fork');

  // ---------------------------------------------------------------- 6. finalize
  const before = await evm.balance(t.recipient);
  await evm.dryRun(relayer.address, GATEWAY, finData(cproof.proof));
  const f = await evm.send(relayerPk, GATEWAY, finData(cproof.proof));
  if (!f.ok) throw new Error(`finalize failed: ${JSON.stringify(f.events)}`);
  const after = await evm.balance(t.recipient);
  const released = after - before;
  const finalizedEv = f.logs
    .filter((l) => l.address === GATEWAY)
    .map((l) => {
      try {
        return decodeEventLog({ abi: portaldotGatewayAbi as Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as any;
      } catch {
        return undefined;
      }
    })
    .find((e) => e?.eventName === 'Finalized');
  const isFin = await evm.read<boolean>(GATEWAY, portaldotGatewayAbi as Abi, 'isFinalized', [t.nonce]);
  const lockedAfter = await evm.read<bigint>(GATEWAY, portaldotGatewayAbi as Abi, 'lockedPOT');
  log(`finalize eth tx ${f.ethHash} (fork block ${f.block}): Finalized ${finalizedEv ? `nonce ${finalizedEv.args.nonce}` : 'MISSING'}, recipient +${formatEther(released)} tPOT, lockedPOT ${formatEther(lockedBefore)} → ${formatEther(lockedAfter)}`);
  if (!finalizedEv || released !== t.amount || !isFin || lockedBefore - lockedAfter !== t.amount) throw new Error('finalize checks failed');

  // replay is refused too
  let replay = '';
  try {
    await evm.dryRun(relayer.address, GATEWAY, finData(cproof.proof));
  } catch (e) {
    replay = (e as Error).message;
  }

  const out = {
    forkOf: chain,
    forkEndpoint: 'wss://test-node-v3.portaldot.dev',
    forkBlock,
    forkBlockHash,
    forkTool: 'Chopsticks (Instant block mode, --allow-unresolved-imports)',
    recordedAt: new Date().toISOString(),
    onlyChangeToForkState: {
      method: 'dev_setStorage System.Account (free balance only; nonce kept)',
      deployerFree: `${FUND_DEPLOYER / PLANCK} tPOT`,
      relayerFree: `${FUND_RELAYER / PLANCK} tPOT`,
      why: 'the live deployer lacks the ~948 tPOT storage deposit for ParliaClient + BscVerifier',
      blockProduction: `TransactionStorage.RetentionPeriod set to ${RETENTION} (Chopsticks cannot supply the storage-proof inherent the live block author does; unrelated to the bridge)`,
    },
    deployer: deployer.address,
    relayer: relayer.address,
    portaldotGateway: { address: GATEWAY, codeHash: gwCode.codeHash, codeBytes: gwCode.bytes, verifier: verifierNow, lockedPOTBefore: lockedBefore.toString() },
    parliaClient: PARLIA.address,
    bscVerifier: VERIFIER.address,
    checkpoint: { epoch: cp.epoch.toString(), timestamp: cp.timestamp.toString(), activeFrom: cp.activeFrom.toString(), turnLength: cp.turnLength, validators: cp.validators },
    deployTxs: [
      { contract: 'ParliaClient', nonce: PARLIA.nonce, ethTx: d1.ethHash, extrinsic: d1.extrinsic, forkBlock: d1.block, forkBlockHash: d1.blockHash },
      { contract: 'BscVerifier', nonce: VERIFIER.nonce, ethTx: d2.ethHash, extrinsic: d2.extrinsic, forkBlock: d2.block, forkBlockHash: d2.blockHash },
    ],
    deployCostWei: deployCost.toString(),
    bscBurn: {
      tx: burnTx,
      block: burnBlock.toString(),
      blockHash: bscBlock.hash,
      link: `https://testnet.bscscan.com/tx/${burnTx}`,
      transfer: { nonce: t.nonce.toString(), kind: t.kind, recipient: t.recipient, amount: t.amount.toString() },
      outboxKey: key,
    },
    window: {
      firstBlock: burnBlock.toString(),
      headers: window.length,
      bytes: windowBytes,
      trustedSetSize: set.validators.length,
      quorum: Math.ceil((2 * set.validators.length) / 3),
      trustedSigners,
      sealers,
      submitTx: { ethTx: w.ethHash, forkBlock: w.block, forkBlockHash: w.blockHash },
      finalizedHash: fin.hash,
    },
    receiptProof: { nodes: dec.proof.length, logIndex: dec.logIndex.toString(), bytes: (cproof.proof.length - 2) / 2 },
    finalize: {
      forkTx: f.ethHash,
      extrinsic: f.extrinsic,
      forkBlock: f.block,
      forkBlockHash: f.blockHash,
      recipient: t.recipient,
      released: released.toString(),
      releasedTPOT: formatEther(released),
      finalizedEvent: { nonce: finalizedEv.args.nonce.toString(), recipient: finalizedEv.args.recipient },
      lockedPOTAfter: lockedAfter.toString(),
    },
    negative: {
      tamper: `one byte flipped in the receipt (leaf node of the receipts trie, byte ${(pos - 2) / 2} of ${(leaf.length - 2) / 2})`,
      reason: negReason,
      verifyCommitment: verifyTampered,
      sent: negTx,
      transferStillOpenAfter: stillOpen,
      replay,
    },
  };
  writeFileSync(OUT, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  log(`wrote ${OUT}`);
  await api.disconnect();
}

function keyFor(app: Address, nonce: bigint): Hex {
  return keccak256(concatHex([`0x${'00'.repeat(12)}${app.slice(2).toLowerCase()}` as Hex, `0x${nonce.toString(16).padStart(64, '0')}` as Hex]));
}

function transferHash(t: { nonce: bigint; kind: number; recipient: Address; amount: bigint }): Hex {
  const enc = concatHex([
    `0x${t.nonce.toString(16).padStart(64, '0')}`,
    `0x${t.kind.toString(16).padStart(64, '0')}`,
    `0x${'00'.repeat(12)}${t.recipient.slice(2).toLowerCase()}`,
    `0x${t.amount.toString(16).padStart(64, '0')}`,
  ]);
  return keccak256(enc);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
