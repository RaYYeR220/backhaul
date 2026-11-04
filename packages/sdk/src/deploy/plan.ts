// The Backhaul deployment, in two phases so it fits the tPOT at hand:
//
//   A  Portaldot: Outbox, PortaldotGateway (its immutable verifier = the address BscVerifier will
//      get in phase B), setRemote, funding of the relayer's own key.
//      BSC: the whole BSC side (Outbox, BEEFY light client, PortaldotVerifier + bindTrieId, pPOT,
//      gateway, settlers, vaults) and setRemote. Enough for a proven Portaldot → BSC transfer.
//   B  Portaldot: ParliaClient and BscVerifier at their reserved addresses (which makes the gateway's
//      verifier live), settlers, vault, forwarder, wiring, optional BscFeed, BNB.b (ops key), seeds.
//      BSC: the wiring that needs phase-B Portaldot addresses.
//
// The deployer's Portaldot transactions are planned up front from its current nonce, and each send
// asserts it is at its reserved nonce: anything else sent from the deployer key in between would
// move BscVerifier away from the address the gateway already trusts.
// Every step is idempotent: re-running resumes from deployments/<chain>.json and the chain itself.

import { getAddress, getContractAddress, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import type { KeyringPair } from '@polkadot/keyring/types';
import {
  bscGatewayAbi,
  lpVaultAbi,
  originSettlerAbi,
  portaldotGatewayAbi,
  portaldotVerifierAbi,
  ppotAbi,
} from '../abi.js';
import { loadArtifact } from '../artifacts.js';
import { checkpointAt } from '../bsc/checkpoint.js';
import { BNB_USD_DECIMALS, BNB_USD_PROXY } from '../bsc/feed.js';
import type { BscClient } from '../bsc/client.js';
import { u8aToHex } from '@polkadot/util';
import { accountId32Of, assetPrecompile, BSC_CHAIN_ID, PORTALDOT_CHAIN_ID, type ChainName } from '../chains.js';
import { bnbbStatus, fundContractAccount, setupBnbb } from '../portaldot/assets.js';
import { fetchCheckpoint, JustificationArchive } from '../portaldot/beefy.js';
import type { PortaldotClient } from '../portaldot/client.js';
import { MmrMirror } from '../portaldot/mmr.js';
import { buildBindProof, trieIdOf } from '../portaldot/storage.js';
import { BeefyRelay, livePortaldotSource } from '../relay/beefy.js';
import { beefyClientPort } from '../relay/ports.js';
import { setCode } from './anvil.js';
import { checkpointFromMeta, deployInk } from './ink.js';
import { formatPlan, NonceMismatch, planNonces, plannedAddress, type NoncePlan, type Phase, type PlannedTx } from './nonces.js';
import { NeedsOtherChain, type Side } from './side.js';

export interface Seeds {
  /** tPOT donated to the PortaldotGateway gas pool (wei-units). */
  gasPool: bigint;
  /** tPOT deposited into the tPOT vault on Portaldot. */
  potVault: bigint;
  /** tBNB deposited into the tBNB vault on BSC. */
  bnbVault: bigint;
  /** tPOT (planck) sent to each contract that approves through the assets precompile. */
  approvalFund: bigint;
}

export interface PlanConfig {
  mode: 'live' | 'local';
  assetId: number;
  bnbbSupply: bigint;
  minFeeBps: number;
  /**
   * Deploy the BNB route vaults (BNB.b vault + forwarder on Portaldot, tBNB vault + forwarder on
   * BSC). Without them BNB still bridges canonically and independent solvers can still fill.
   */
  bnbVaults?: boolean;
  trustingPeriod: bigint;
  /** Deploy BscFeed, the proven Chainlink BNB/USD feed (data bridge). */
  withFeed?: boolean;
  /**
   * Deploy the ink! twin of ParliaClient on pallet-contracts (ops key, same checkpoint). Live only:
   * a local run has no pallet-contracts, and the dry-run prices it from ContractsApi_instantiate.
   */
  withInk?: boolean;
  /** Phase A sends this much tPOT from the deployer to the relayer's own key (planned nonce). */
  fundRelayer?: { to: Address; value: bigint };
  seeds: Seeds;
  /** Live Portaldot substrate client (BEEFY checkpoint, BNB.b, bindTrieId). */
  portaldot: PortaldotClient;
  /** Live BSC client (Parlia checkpoint). */
  bsc: BscClient;
  /** sr25519 key for pallet-assets calls (live only). */
  ops?: KeyringPair;
  /** Local mode: the Portaldot stand-in node, where a mock ERC-20 replaces the assets precompile. */
  localPortaldotUrl?: string;
  /** Archive and block-hash cache shared with the relayer. */
  archivePath: string;
  hashCachePath: string;
  log: (m: string) => void;
}

/** One step of the deployment. `tx` is the deployer transaction it sends, if any. */
export interface StepDef {
  id: string;
  phase: Phase;
  /** Where it acts: a chain's EVM, the Portaldot runtime (ops key), or BSC via the BEEFY relay. */
  on: ChainName | 'substrate';
  tx?: PlannedTx;
  run(): Promise<unknown>;
}

/** Runs `fn`; a step that needs the other chain is reported and skipped. */
async function guarded(cfg: PlanConfig, name: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    if (e instanceof NeedsOtherChain) {
      cfg.log(`skip ${name}: ${e.message}`);
      return false;
    }
    // an earlier planned transaction did not run (e.g. it needs the other chain): wait for it
    if (e instanceof NonceMismatch && e.behind) {
      cfg.log(`skip ${name}: ${e.message}`);
      return false;
    }
    throw e;
  }
}

const nonZero = (a: Address) => getAddress(a) !== zeroAddress;

async function read<T>(side: Side, address: Address, abi: Abi, fn: string, args: readonly unknown[] = []): Promise<T> {
  if (!side.sender) throw new NeedsOtherChain(`${side.name} is not part of this run`);
  return (await side.sender.pub.readContract({ address, abi, functionName: fn, args })) as T;
}

/** The newest BSC epoch block whose validator switch is safely behind the head. */
async function freshEpoch(bsc: BscClient): Promise<bigint> {
  const head = await bsc.blockNumber();
  const safe = head - 200n;
  return safe - (safe % 1000n);
}

/** The address a contract will have: deployed, or reserved in the plan. */
function addrOrPlanned(side: Side, key: string): Address {
  if (side.has(key)) return side.addr(key);
  const p = plannedAddress(side.plan, key);
  if (!p) throw new NeedsOtherChain(`${side.name} has no ${key} and no reserved address for it`);
  return p;
}

/** Every step, in execution order. */
export function deploySteps(P: Side, B: Side, cfg: PlanConfig): StepDef[] {
  const { log } = cfg;
  const precompile = assetPrecompile(cfg.assetId);
  const fee = cfg.minFeeBps;
  const bnb = cfg.bnbVaults !== false;
  const S: StepDef[] = [];
  const deploy = (phase: Phase, side: Side, key: string, artifact: string, args: () => Promise<readonly unknown[]> | readonly unknown[], opts: { dependsOnLocal?: boolean } = {}) =>
    S.push({
      id: `${side.name}: deploy ${key}`,
      phase,
      on: side.name,
      tx: { step: `deploy ${key}`, phase, kind: 'deploy', contract: key },
      run: () => side.deploy(key, artifact, async () => await args(), opts),
    });
  const call = (phase: Phase, side: Side, id: string, run: () => Promise<unknown>) =>
    S.push({ id: `${side.name}: ${id}`, phase, on: side.name, tx: { step: id, phase, kind: 'call' }, run });
  const vaultDone = (side: Side, key: string) => async () => nonZero(await read<Address>(side, side.addr(key), lpVaultAbi as Abi, 'remoteVault'));

  // ================================================================ phase A
  deploy('A', P, 'Outbox', 'Outbox', () => []);
  S.push({
    id: 'portaldot: BNB.b asset id is free',
    phase: 'A',
    on: 'substrate',
    async run() {
      if (cfg.mode !== 'live' || !P.active || P.has('PortaldotGateway')) return;
      // The gateway binds the precompile address for good, so the asset id must be free (or ours).
      const s = await bnbbStatus(cfg.portaldot.api, cfg.assetId, zeroAddress);
      const opsHex = cfg.ops ? (u8aToHex(cfg.ops.publicKey) as Hex) : undefined;
      if (s.exists && s.owner !== opsHex) throw new Error(`asset id ${cfg.assetId} is taken by ${s.owner}; pick another --asset-id`);
    },
  });
  // The verifier is the address BscVerifier is reserved at: it starts working once phase B deploys it.
  deploy('A', P, 'PortaldotGateway', 'PortaldotGateway', () => [P.addr('Outbox'), addrOrPlanned(P, 'BscVerifier'), precompile]);

  deploy('A', B, 'Outbox', 'Outbox', () => []);
  deploy('A', B, 'PortaldotLightClient', 'PortaldotLightClient', async () => {
    const cp = await fetchCheckpoint(cfg.portaldot.api);
    log(`BEEFY checkpoint: set ${cp.setId}, block ${cp.checkpointBlock}, ${cp.signers.length} signers`);
    B.dep.meta.beefyCheckpoint = cp;
    return [cp.setId, cp.signers, cp.checkpointBlock, cp.checkpointMmrRoot];
  });
  deploy('A', B, 'PortaldotVerifier', 'PortaldotVerifier', () => [B.addr('PortaldotLightClient'), P.addr('Outbox')]);
  // PPOT fixes its gateway at construction: the gateway is the deployer's very next contract.
  deploy('A', B, 'PPOT', 'PPOT', () => [addrOrPlanned(B, 'BscGateway')]);
  deploy('A', B, 'BscGateway', 'BscGateway', async () => {
    const bound = getAddress(await read<Address>(B, B.addr('PPOT'), ppotAbi as Abi, 'gateway'));
    const next = getContractAddress({ from: B.sender!.address, nonce: BigInt(await B.sender!.pub.getTransactionCount({ address: B.sender!.address, blockTag: 'pending' })) });
    if (bound !== next) throw new Error(`PPOT is bound to ${bound} but the deployer's next contract is ${next}`);
    return [B.addr('Outbox'), B.addr('PortaldotVerifier'), B.addr('PPOT')];
  });
  call('A', B, 'BscGateway.setRemote', () =>
    B.call('BscGateway.setRemote', B.addr('BscGateway'), bscGatewayAbi as Abi, 'setRemote', [P.addr('PortaldotGateway')], {
      done: async () => nonZero(await read<Address>(B, B.addr('BscGateway'), bscGatewayAbi as Abi, 'remote')),
    }),
  );
  deploy('A', B, 'OriginSettler', 'OriginSettler', () => [B.addr('PortaldotVerifier'), B.addr('Outbox')]);
  deploy('A', B, 'DestinationSettler', 'DestinationSettler', () => [B.addr('Outbox'), BigInt(BSC_CHAIN_ID)]);
  deploy('A', B, 'PpotVault', 'LPVault', () => [B.addr('PPOT'), B.addr('DestinationSettler'), B.addr('PortaldotVerifier'), fee]);
  if (bnb) deploy('A', B, 'BnbVault', 'LPVault', () => [zeroAddress, B.addr('DestinationSettler'), B.addr('PortaldotVerifier'), fee]);

  call('A', P, 'PortaldotGateway.setRemote', () =>
    P.call('PortaldotGateway.setRemote', P.addr('PortaldotGateway'), portaldotGatewayAbi as Abi, 'setRemote', [B.addr('BscGateway')], {
      done: async () => nonZero(await read<Address>(P, P.addr('PortaldotGateway'), portaldotGatewayAbi as Abi, 'remote')),
    }),
  );
  if (cfg.fundRelayer && cfg.fundRelayer.value > 0n) {
    const f = cfg.fundRelayer;
    S.push({ id: 'portaldot: fund the relayer key', phase: 'A', on: 'portaldot', tx: { step: 'fund.relayer', phase: 'A', kind: 'transfer' }, run: () => P.transfer('fund.relayer', f.to, f.value) });
  }

  // Bind the Portaldot Outbox's child-trie id on BSC: needs a BEEFY-proven header after it. Last on
  // BSC in phase A, since the relay sends a variable number of transactions.
  S.push({
    id: 'bsc: PortaldotVerifier.bindTrieId',
    phase: 'A',
    on: 'bsc',
    async run() {
      const verifier = B.addr('PortaldotVerifier');
      const outbox = P.addr('Outbox');
      const outboxBlock = P.dep.contracts.Outbox.block ?? 0;
      if (!B.sender) throw new NeedsOtherChain('bsc is not part of this run');
      const bound = BigInt(await read<Hex>(B, verifier, portaldotVerifierAbi as Abi, 'trieId')) !== 0n;
      if (bound || B.dep.steps['PortaldotVerifier.bindTrieId']) return;
      const relay = await beefyRelayFor(B, cfg);
      if (cfg.mode === 'local') {
        // The local Portaldot stand-in is not the chain BEEFY finalizes, so only the BEEFY part runs:
        // a live commitment and header import on the BSC fork.
        const head = await relay.ensureHeader(await relay.lc.latestBlock());
        B.mark('beefy.rehearsal', { header: head, note: 'bindTrieId needs the Outbox on live Portaldot' });
        log(`BEEFY rehearsal: imported Portaldot header ${head} on the fork; bindTrieId skipped`);
        return;
      }
      const h = await relay.ensureHeader(outboxBlock);
      await trieIdOf(cfg.portaldot.api, outbox, h); // throws if the Outbox is not in that state
      const proof = await buildBindProof(cfg.portaldot.api, outbox, h);
      await B.call('PortaldotVerifier.bindTrieId', verifier, portaldotVerifierAbi as Abi, 'bindTrieId', [h, proof]);
    },
  });

  // ================================================================ phase B
  deploy('B', P, 'ParliaClient', 'ParliaClient', async () => {
    const epoch = await freshEpoch(cfg.bsc);
    const cp = await checkpointAt(cfg.bsc, epoch);
    log(`Parlia checkpoint: epoch ${cp.epoch}, ${cp.validators.length} validators, active from ${cp.activeFrom}`);
    P.dep.meta.parliaCheckpoint = cp;
    return [BigInt(BSC_CHAIN_ID), 1000n, cfg.trustingPeriod, cp];
  });
  deploy('B', P, 'BscVerifier', 'BscVerifier', () => [addrOrPlanned(P, 'ParliaClient'), B.addr('Outbox')]);
  S.push({
    id: 'portaldot: the gateway trusts this BscVerifier',
    phase: 'B',
    on: 'portaldot',
    async run() {
      const want = getAddress(await read<Address>(P, P.addr('PortaldotGateway'), portaldotGatewayAbi as Abi, 'verifier'));
      if (want !== P.addr('BscVerifier')) throw new NonceMismatch(`PortaldotGateway trusts ${want}, but BscVerifier is at ${P.addr('BscVerifier')}`);
    },
  });
  deploy('B', P, 'OriginSettler', 'OriginSettler', () => [P.addr('BscVerifier'), P.addr('Outbox')]);
  deploy('B', P, 'DestinationSettler', 'DestinationSettler', () => [P.addr('Outbox'), BigInt(PORTALDOT_CHAIN_ID)]);
  deploy('B', P, 'PotVault', 'LPVault', () => [zeroAddress, P.addr('DestinationSettler'), P.addr('BscVerifier'), fee]);
  if (bnb) deploy('B', P, 'BnbbVault', 'LPVault', () => [precompile, P.addr('DestinationSettler'), P.addr('BscVerifier'), fee]);
  deploy('B', P, 'PotForwarder', 'PortaldotRepayForwarder', () => [P.addr('PortaldotGateway'), zeroAddress, B.addr('PpotVault')]);
  if (bnb) deploy('B', P, 'BnbbForwarder', 'PortaldotRepayForwarder', () => [P.addr('PortaldotGateway'), precompile, B.addr('BnbVault')], { dependsOnLocal: true });

  call('B', B, 'OriginSettler.setRemoteDestination', () =>
    B.call('OriginSettler.setRemoteDestination', B.addr('OriginSettler'), originSettlerAbi as Abi, 'setRemoteDestination', [P.addr('DestinationSettler')], {
      done: async () => nonZero(await read<Address>(B, B.addr('OriginSettler'), originSettlerAbi as Abi, 'remoteDestination')),
    }),
  );
  deploy('B', B, 'PpotForwarder', 'BscRepayForwarder', () => [B.addr('BscGateway'), B.addr('PPOT'), P.addr('PotVault')]);
  if (bnb) deploy('B', B, 'BnbForwarder', 'BscRepayForwarder', () => [B.addr('BscGateway'), zeroAddress, P.addr('BnbbVault')]);
  call('B', B, 'PpotVault.setRemote', () =>
    B.call('PpotVault.setRemote', B.addr('PpotVault'), lpVaultAbi as Abi, 'setRemote', [P.addr('PotForwarder'), P.addr('OriginSettler'), zeroAddress, BigInt(PORTALDOT_CHAIN_ID)], {
      done: vaultDone(B, 'PpotVault'),
    }),
  );
  if (bnb) {
    call('B', B, 'BnbVault.setRemote', () =>
      B.call('BnbVault.setRemote', B.addr('BnbVault'), lpVaultAbi as Abi, 'setRemote', [P.addr('BnbbForwarder'), P.addr('OriginSettler'), precompile, BigInt(PORTALDOT_CHAIN_ID)], {
        done: vaultDone(B, 'BnbVault'),
      }),
    );
  }

  call('B', P, 'OriginSettler.setRemoteDestination', () =>
    P.call('OriginSettler.setRemoteDestination', P.addr('OriginSettler'), originSettlerAbi as Abi, 'setRemoteDestination', [B.addr('DestinationSettler')], {
      done: async () => nonZero(await read<Address>(P, P.addr('OriginSettler'), originSettlerAbi as Abi, 'remoteDestination')),
    }),
  );
  call('B', P, 'PotVault.setRemote', () =>
    P.call('PotVault.setRemote', P.addr('PotVault'), lpVaultAbi as Abi, 'setRemote', [B.addr('PpotForwarder'), B.addr('OriginSettler'), B.addr('PPOT'), BigInt(BSC_CHAIN_ID)], {
      done: vaultDone(P, 'PotVault'),
    }),
  );
  if (bnb) {
    call('B', P, 'BnbbVault.setRemote', () =>
      P.call('BnbbVault.setRemote', P.addr('BnbbVault'), lpVaultAbi as Abi, 'setRemote', [B.addr('BnbForwarder'), B.addr('OriginSettler'), zeroAddress, BigInt(BSC_CHAIN_ID)], {
        done: vaultDone(P, 'BnbbVault'),
      }),
    );
  }
  if (cfg.withFeed) deploy('B', P, 'BscFeed', 'BscFeed', () => [P.addr('BscVerifier'), BNB_USD_PROXY, BNB_USD_DECIMALS]);

  // BNB.b: the whole supply and every role to the gateway (ops key on Portaldot's runtime).
  S.push({
    id: 'portaldot: BNB.b',
    phase: 'B',
    on: 'substrate',
    async run() {
      const gw = P.addr('PortaldotGateway');
      if (!P.active) throw new NeedsOtherChain('portaldot is not part of this run');
      if (cfg.mode === 'local') {
        if (P.dep.steps['bnbb.mint']) return;
        if (!cfg.localPortaldotUrl) throw new Error('local mode needs the Portaldot stand-in URL');
        // The assets precompile does not exist on a plain EVM node: put the mock ERC-20 there,
        // minted directly in its storage (no deployer transaction, like the real ops-key setup).
        await setCode(cfg.localPortaldotUrl, precompile, loadArtifact('MockAssetPrecompile').deployedBytecode);
        await mintOnMock(cfg.localPortaldotUrl, precompile, gw, cfg.bnbbSupply);
        P.mark('bnbb.mint', { note: 'local mock asset' });
        return;
      }
      if (P.dep.steps['bnbb.transferOwnership']) return;
      if (!cfg.ops) throw new Error('BNB.b needs PORTALDOT_OPS_MNEMONIC');
      const results = await setupBnbb(cfg.portaldot.api, cfg.ops, { assetId: cfg.assetId, gateway: gw, supply: cfg.bnbbSupply }, log);
      for (const r of results) P.mark(`bnbb.${r.step}`, { tx: r.hash, block: r.block, skipped: r.skipped ?? false });
    },
  });
  if (cfg.mode === 'live' && bnb && cfg.seeds.approvalFund > 0n) {
    for (const key of ['BnbbVault', 'BnbbForwarder']) {
      S.push({
        id: `portaldot: approval deposit for ${key}`,
        phase: 'B',
        on: 'substrate',
        async run() {
          const id = `seed.approvalFund.${key}`;
          if (P.dep.steps[id]) return;
          if (!cfg.ops) throw new Error('approval funding needs PORTALDOT_OPS_MNEMONIC');
          const r = await fundContractAccount(cfg.portaldot.api, cfg.ops, P.addr(key), cfg.seeds.approvalFund);
          P.mark(id, { tx: r.hash, block: r.block, planck: cfg.seeds.approvalFund.toString() });
        },
      });
    }
  }
  if (cfg.seeds.gasPool > 0n) {
    call('B', P, 'seed.gasPool', () => P.call('seed.gasPool', P.addr('PortaldotGateway'), portaldotGatewayAbi as Abi, 'donateGas', [], { value: cfg.seeds.gasPool }));
  }
  if (cfg.seeds.potVault > 0n) {
    call('B', P, 'seed.potVault', () => P.call('seed.potVault', P.addr('PotVault'), lpVaultAbi as Abi, 'deposit', [cfg.seeds.potVault], { value: cfg.seeds.potVault }));
  }
  if (bnb && cfg.seeds.bnbVault > 0n) {
    call('B', B, 'seed.bnbVault', () => B.call('seed.bnbVault', B.addr('BnbVault'), lpVaultAbi as Abi, 'deposit', [cfg.seeds.bnbVault], { value: cfg.seeds.bnbVault }));
  }

  if (cfg.withInk) {
    S.push({
      id: 'portaldot: ParliaClient (ink!)',
      phase: 'B',
      on: 'substrate',
      async run() {
        if (P.dep.meta.parliaClientInk) return;
        if (!P.active) throw new NeedsOtherChain('portaldot is not part of this run');
        const cp = checkpointFromMeta(P.dep.meta.parliaCheckpoint);
        if (cfg.mode === 'local') {
          log('ink! ParliaClient: the local stand-in has no pallet-contracts; the dry-run prices it with ContractsApi_instantiate');
          return;
        }
        if (!cfg.ops) throw new Error('the ink! client is uploaded with the ops key: set PORTALDOT_OPS_MNEMONIC');
        const r = await deployInk(cfg.portaldot.api, cfg.ops, cp, cfg.trustingPeriod, log);
        P.dep.meta.parliaClientInk = {
          address: r.address,
          codeHash: r.quote.codeHash,
          wasmBytes: r.quote.wasmBytes,
          tx: r.hash,
          block: r.block,
          deployer: cfg.ops.address,
          args: [BSC_CHAIN_ID, 1000, cfg.trustingPeriod, cp],
        };
        P.save();
        log(`ink! ParliaClient = ${r.address} (${r.hash})`);
      },
    });
  }
  return S;
}

/** Deployer transactions of `chain` among `steps`, in order. */
export function plannedTxs(steps: StepDef[], chain: ChainName, phases?: Phase[]): PlannedTx[] {
  return steps.filter((s) => s.on === chain && s.tx && (!phases || phases.includes(s.phase))).map((s) => s.tx!);
}

const samePrefix = (a: PlannedTx[], b: { step: string }[]) => a.length <= b.length && a.every((t, i) => t.step === b[i].step);

/**
 * The Portaldot plan covers both phases and is fixed the first time: it is what makes BscVerifier's
 * address known in phase A. Later runs keep it, re-planning only the steps after BscVerifier if the
 * options changed (e.g. --minimal); a change before it is refused.
 */
export async function ensurePortaldotPlan(P: Side, steps: StepDef[], log: (m: string) => void): Promise<NoncePlan> {
  const s = P.sender!;
  const want = plannedTxs(steps, 'portaldot');
  const saved = P.dep.meta.noncePlan as NoncePlan | undefined;
  let plan: NoncePlan;
  if (!saved) {
    const nonce = await s.pub.getTransactionCount({ address: s.address, blockTag: 'pending' });
    plan = planNonces('portaldot', s.address, nonce, want);
    log(`portaldot: new nonce plan from the deployer's nonce ${nonce}`);
  } else {
    if (getAddress(saved.deployer) !== getAddress(s.address)) throw new NonceMismatch(`the Portaldot plan belongs to ${saved.deployer}, not ${s.address}`);
    const pivot = saved.reserved.findIndex((r) => r.step === 'deploy BscVerifier');
    const fixed = saved.reserved.slice(0, pivot + 1);
    if (pivot < 0 || want.length < fixed.length || !samePrefix(want.slice(0, fixed.length), fixed)) {
      throw new NonceMismatch('the Portaldot steps up to BscVerifier differ from the saved nonce plan; refusing to move reserved addresses');
    }
    const same = want.length === saved.reserved.length && samePrefix(want, saved.reserved);
    plan = same
      ? saved
      : { ...saved, reserved: [...fixed, ...planNonces('portaldot', saved.deployer, fixed[fixed.length - 1].nonce + 1, want.slice(fixed.length)).reserved] };
    if (!same) log('portaldot: options changed after BscVerifier; re-planned the steps after it');
  }
  P.plan = plan;
  P.strict = true;
  P.dep.meta.noncePlan = plan;
  P.dep.meta.reserved = plan.reserved.map((r) => ({ nonce: r.nonce, name: r.name ?? r.step, address: r.address ?? null, phase: r.phase }));
  P.save();
  return plan;
}

/**
 * The BSC plan is made per phase from the current nonce: bindTrieId sends a variable number of
 * relay transactions at the end of phase A, and nothing on BSC is predicted across the phases
 * (only PPOT → BscGateway, which are adjacent in phase A).
 */
export async function ensureBscPlan(B: Side, steps: StepDef[], phase: Phase): Promise<NoncePlan> {
  const s = B.sender!;
  const nonce = await s.pub.getTransactionCount({ address: s.address, blockTag: 'pending' });
  const plan = planNonces('bsc', s.address, nonce, plannedTxs(steps, 'bsc', [phase]).filter((t) => !isDone(B, t)));
  B.plan = plan;
  B.dep.meta.noncePlan = plan;
  B.save();
  return plan;
}

/** Whether a planned transaction already happened (recorded in the deployments file). */
function isDone(side: Side, t: PlannedTx): boolean {
  return t.kind === 'deploy' ? side.has(t.contract!) : side.dep.steps[t.step] !== undefined;
}

export function describePlans(P: Side, B: Side): string[] {
  return [...(P.plan ? formatPlan(P.plan) : []), ...(B.plan ? formatPlan(B.plan) : [])];
}

/** Runs the given phases. Without a Portaldot sender (BSC-only run) the gateway's verifier must already be reserved. */
export async function runPhases(phases: Phase[], P: Side, B: Side, cfg: PlanConfig): Promise<void> {
  P.dep.meta.bnbb = { assetId: cfg.assetId, precompile: assetPrecompile(cfg.assetId) };
  const steps = deploySteps(P, B, cfg);
  if (P.active) await ensurePortaldotPlan(P, steps, cfg.log);
  for (const phase of phases) {
    // BSC transactions are planned when their phase starts (after phase A's relay transactions).
    if (B.active) await ensureBscPlan(B, steps, phase);
    for (const line of describePlans(P, B).filter((l) => l.includes(` ${phase}  nonce`))) cfg.log(line);
    for (const s of steps.filter((x) => x.phase === phase)) {
      P.phase = phase;
      B.phase = phase;
      await guarded(cfg, s.id, () => s.run());
    }
  }
}

/** Both phases (the full deployment). */
export function runPlan(P: Side, B: Side, cfg: PlanConfig): Promise<void> {
  return runPhases(['A', 'B'], P, B, cfg);
}

/** Mints on the local mock asset by writing its storage, so no transaction is sent. */
async function mintOnMock(url: string, asset: Address, to: Address, amount: bigint): Promise<void> {
  const { anvilRpc } = await import('./anvil.js');
  const { encodeAbiParameters, keccak256, toHex } = await import('viem');
  // MockAssetPrecompile: balanceOf at slot 0, allowance at 1, totalSupply at 2
  const balSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [to, 0n]));
  await anvilRpc(url, 'anvil_setStorageAt', [asset, balSlot, toHex(amount, { size: 32 })]);
  await anvilRpc(url, 'anvil_setStorageAt', [asset, toHex(2n, { size: 32 }), toHex(amount, { size: 32 })]);
}

async function beefyRelayFor(B: Side, cfg: PlanConfig): Promise<BeefyRelay> {
  const s = B.sender!;
  const archive = JustificationArchive.open(cfg.archivePath);
  const mirror = await MmrMirror.sync(cfg.portaldot, cfg.hashCachePath, cfg.log);
  const port = beefyClientPort(s.pub, s, B.addr('PortaldotLightClient'));
  return new BeefyRelay(port, livePortaldotSource(cfg.portaldot, mirror, cfg.hashCachePath), archive, { log: cfg.log });
}
