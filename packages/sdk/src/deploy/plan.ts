// The Backhaul deployment, in dependency order across both chains:
//   Outboxes → light clients (fresh checkpoints) → verifiers → pPOT + gateways → setRemote both ways
//   → BNB.b → settlers → vaults → repay forwarders → vault wiring → bindTrieId → seeds.
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
import type { BscClient } from '../bsc/client.js';
import { u8aToHex } from '@polkadot/util';
import { accountId32Of, assetPrecompile, BSC_CHAIN_ID, PORTALDOT_CHAIN_ID } from '../chains.js';
import { bnbbStatus, fundContractAccount, setupBnbb } from '../portaldot/assets.js';
import { fetchCheckpoint, JustificationArchive } from '../portaldot/beefy.js';
import type { PortaldotClient } from '../portaldot/client.js';
import { MmrMirror } from '../portaldot/mmr.js';
import { buildBindProof, trieIdOf } from '../portaldot/storage.js';
import { BeefyRelay, livePortaldotSource } from '../relay/beefy.js';
import { beefyClientPort } from '../relay/ports.js';
import { setCode } from './anvil.js';
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
  trustingPeriod: bigint;
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

/** Runs `fn`; a step that needs the other chain is reported and skipped. */
async function step(cfg: PlanConfig, name: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    if (e instanceof NeedsOtherChain) {
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

export async function runPlan(P: Side, B: Side, cfg: PlanConfig): Promise<void> {
  const { log } = cfg;
  const precompile = assetPrecompile(cfg.assetId);
  P.dep.meta.bnbb = { assetId: cfg.assetId, precompile };

  // 1. Outboxes
  await step(cfg, 'Outbox (portaldot)', () => P.deploy('Outbox', 'Outbox', []));
  await step(cfg, 'Outbox (bsc)', () => B.deploy('Outbox', 'Outbox', []));

  // 2. Light clients from fresh checkpoints
  await step(cfg, 'PortaldotLightClient', () =>
    B.deploy('PortaldotLightClient', 'PortaldotLightClient', async () => {
      const cp = await fetchCheckpoint(cfg.portaldot.api);
      log(`BEEFY checkpoint: set ${cp.setId}, block ${cp.checkpointBlock}, ${cp.signers.length} signers`);
      B.dep.meta.beefyCheckpoint = cp;
      return [cp.setId, cp.signers, cp.checkpointBlock, cp.checkpointMmrRoot];
    }),
  );
  await step(cfg, 'ParliaClient', () =>
    P.deploy('ParliaClient', 'ParliaClient', async () => {
      const epoch = await freshEpoch(cfg.bsc);
      const cp = await checkpointAt(cfg.bsc, epoch);
      log(`Parlia checkpoint: epoch ${cp.epoch}, ${cp.validators.length} validators, active from ${cp.activeFrom}`);
      P.dep.meta.parliaCheckpoint = cp;
      return [BigInt(BSC_CHAIN_ID), 1000n, cfg.trustingPeriod, cp];
    }),
  );

  // 3. Verifiers
  await step(cfg, 'PortaldotVerifier', () =>
    B.deploy('PortaldotVerifier', 'PortaldotVerifier', () => Promise.resolve([B.addr('PortaldotLightClient'), P.addr('Outbox')])),
  );
  await step(cfg, 'BscVerifier', () =>
    P.deploy('BscVerifier', 'BscVerifier', () => Promise.resolve([P.addr('ParliaClient'), B.addr('Outbox')])),
  );

  // 4. pPOT + gateways. PPOT fixes its gateway at construction, so the gateway must be the
  //    deployer's very next contract.
  if (cfg.mode === 'live' && P.active) {
    // The gateway binds the precompile address for good, so the asset id must be free (or ours).
    const gw = P.has('PortaldotGateway') ? P.addr('PortaldotGateway') : zeroAddress;
    const s = await bnbbStatus(cfg.portaldot.api, cfg.assetId, gw);
    const opsHex = cfg.ops ? (u8aToHex(cfg.ops.publicKey) as Hex) : undefined;
    if (s.exists && s.owner !== opsHex && s.owner !== accountId32Of(gw)) {
      throw new Error(`asset id ${cfg.assetId} is taken by ${s.owner}; pick another --asset-id`);
    }
  }
  await step(cfg, 'PortaldotGateway', () =>
    P.deploy('PortaldotGateway', 'PortaldotGateway', () => Promise.resolve([P.addr('Outbox'), P.addr('BscVerifier'), precompile])),
  );
  await step(cfg, 'PPOT + BscGateway', async () => {
    if (!B.has('PPOT')) {
      if (!B.sender) throw new NeedsOtherChain('bsc is not part of this run');
      // check the gateway's inputs exist before spending the nonce slot
      B.addr('Outbox');
      B.addr('PortaldotVerifier');
      const nonce = await B.sender.pub.getTransactionCount({ address: B.sender.address, blockTag: 'pending' });
      const predicted = getContractAddress({ from: B.sender.address, nonce: BigInt(nonce + 1) });
      await B.deploy('PPOT', 'PPOT', [predicted]);
    }
    if (!B.has('BscGateway')) {
      if (!B.sender) throw new NeedsOtherChain('bsc is not part of this run');
      const bound = getAddress(await read<Address>(B, B.addr('PPOT'), ppotAbi as Abi, 'gateway'));
      const nonce = await B.sender.pub.getTransactionCount({ address: B.sender.address, blockTag: 'pending' });
      const next = getContractAddress({ from: B.sender.address, nonce: BigInt(nonce) });
      if (bound !== next) {
        throw new Error(`PPOT is bound to ${bound} but the deployer's next contract is ${next}; remove PPOT from deployments/bsc.json and re-run`);
      }
      const gw = await B.deploy('BscGateway', 'BscGateway', [B.addr('Outbox'), B.addr('PortaldotVerifier'), B.addr('PPOT')]);
      if (gw !== bound) throw new Error(`BscGateway landed at ${gw}, PPOT expects ${bound}`);
    }
  });

  // 5. setRemote both ways (write-once, deployer only)
  await step(cfg, 'PortaldotGateway.setRemote', () =>
    P.call('PortaldotGateway.setRemote', P.addr('PortaldotGateway'), portaldotGatewayAbi as Abi, 'setRemote', [B.addr('BscGateway')], {
      done: async () => nonZero(await read<Address>(P, P.addr('PortaldotGateway'), portaldotGatewayAbi as Abi, 'remote')),
    }),
  );
  await step(cfg, 'BscGateway.setRemote', () =>
    B.call('BscGateway.setRemote', B.addr('BscGateway'), bscGatewayAbi as Abi, 'setRemote', [P.addr('PortaldotGateway')], {
      done: async () => nonZero(await read<Address>(B, B.addr('BscGateway'), bscGatewayAbi as Abi, 'remote')),
    }),
  );

  // 6. BNB.b: the whole supply and every role to the gateway
  await step(cfg, 'BNB.b', async () => {
    const gw = P.addr('PortaldotGateway');
    if (!P.active) throw new NeedsOtherChain('portaldot is not part of this run');
    if (cfg.mode === 'local') {
      if (P.dep.steps['bnbb.mint']) return;
      if (!cfg.localPortaldotUrl) throw new Error('local mode needs the Portaldot stand-in URL');
      // The assets precompile does not exist on a plain EVM node: put the mock ERC-20 there.
      await setCode(cfg.localPortaldotUrl, precompile, loadArtifact('MockAssetPrecompile').deployedBytecode);
      await P.call('bnbb.mint', precompile, loadArtifact('MockAssetPrecompile').abi, 'mint', [gw, cfg.bnbbSupply]);
      return;
    }
    if (P.dep.steps['bnbb.transferOwnership']) return;
    if (!cfg.ops) throw new Error('BNB.b needs PORTALDOT_OPS_MNEMONIC');
    const results = await setupBnbb(cfg.portaldot.api, cfg.ops, { assetId: cfg.assetId, gateway: gw, supply: cfg.bnbbSupply }, log);
    for (const r of results) P.mark(`bnbb.${r.step}`, { tx: r.hash, block: r.block, skipped: r.skipped ?? false });
  });

  // 7. Settlers
  await step(cfg, 'OriginSettler (portaldot)', () =>
    P.deploy('OriginSettler', 'OriginSettler', () => Promise.resolve([P.addr('BscVerifier'), P.addr('Outbox')])),
  );
  await step(cfg, 'OriginSettler (bsc)', () =>
    B.deploy('OriginSettler', 'OriginSettler', () => Promise.resolve([B.addr('PortaldotVerifier'), B.addr('Outbox')])),
  );
  await step(cfg, 'DestinationSettler (portaldot)', () =>
    P.deploy('DestinationSettler', 'DestinationSettler', () => Promise.resolve([P.addr('Outbox'), BigInt(PORTALDOT_CHAIN_ID)])),
  );
  await step(cfg, 'DestinationSettler (bsc)', () =>
    B.deploy('DestinationSettler', 'DestinationSettler', () => Promise.resolve([B.addr('Outbox'), BigInt(BSC_CHAIN_ID)])),
  );
  await step(cfg, 'OriginSettler.setRemoteDestination (portaldot)', () =>
    P.call('OriginSettler.setRemoteDestination', P.addr('OriginSettler'), originSettlerAbi as Abi, 'setRemoteDestination', [B.addr('DestinationSettler')], {
      done: async () => nonZero(await read<Address>(P, P.addr('OriginSettler'), originSettlerAbi as Abi, 'remoteDestination')),
    }),
  );
  await step(cfg, 'OriginSettler.setRemoteDestination (bsc)', () =>
    B.call('OriginSettler.setRemoteDestination', B.addr('OriginSettler'), originSettlerAbi as Abi, 'setRemoteDestination', [P.addr('DestinationSettler')], {
      done: async () => nonZero(await read<Address>(B, B.addr('OriginSettler'), originSettlerAbi as Abi, 'remoteDestination')),
    }),
  );

  // 8. LP vaults: each fills one route into its chain, proof-gated on the origin's Open
  const fee = cfg.minFeeBps;
  await step(cfg, 'PotVault', () =>
    P.deploy('PotVault', 'LPVault', () => Promise.resolve([zeroAddress, P.addr('DestinationSettler'), P.addr('BscVerifier'), fee])),
  );
  await step(cfg, 'BnbbVault', () =>
    P.deploy('BnbbVault', 'LPVault', () => Promise.resolve([precompile, P.addr('DestinationSettler'), P.addr('BscVerifier'), fee])),
  );
  await step(cfg, 'PpotVault', () =>
    B.deploy('PpotVault', 'LPVault', () => Promise.resolve([B.addr('PPOT'), B.addr('DestinationSettler'), B.addr('PortaldotVerifier'), fee])),
  );
  await step(cfg, 'BnbVault', () =>
    B.deploy('BnbVault', 'LPVault', () => Promise.resolve([zeroAddress, B.addr('DestinationSettler'), B.addr('PortaldotVerifier'), fee])),
  );

  // 9. Repay forwarders: on each origin chain, bridging a vault's repayment home
  await step(cfg, 'PotForwarder', () =>
    P.deploy('PotForwarder', 'PortaldotRepayForwarder', () => Promise.resolve([P.addr('PortaldotGateway'), zeroAddress, B.addr('PpotVault')])),
  );
  await step(cfg, 'BnbbForwarder', () =>
    P.deploy('BnbbForwarder', 'PortaldotRepayForwarder', () => Promise.resolve([P.addr('PortaldotGateway'), precompile, B.addr('BnbVault')]), {
      dependsOnLocal: true,
    }),
  );
  await step(cfg, 'PpotForwarder', () =>
    B.deploy('PpotForwarder', 'BscRepayForwarder', () => Promise.resolve([B.addr('BscGateway'), B.addr('PPOT'), P.addr('PotVault')])),
  );
  await step(cfg, 'BnbForwarder', () =>
    B.deploy('BnbForwarder', 'BscRepayForwarder', () => Promise.resolve([B.addr('BscGateway'), zeroAddress, P.addr('BnbbVault')])),
  );

  // 10. Vault wiring (write-once): where repayments land, which settler opens, which token pays
  const vaultDone = (side: Side, key: string) => async () => nonZero(await read<Address>(side, side.addr(key), lpVaultAbi as Abi, 'remoteVault'));
  await step(cfg, 'PpotVault.setRemote', () =>
    B.call('PpotVault.setRemote', B.addr('PpotVault'), lpVaultAbi as Abi, 'setRemote',
      [P.addr('PotForwarder'), P.addr('OriginSettler'), zeroAddress, BigInt(PORTALDOT_CHAIN_ID)], { done: vaultDone(B, 'PpotVault') }),
  );
  await step(cfg, 'BnbVault.setRemote', () =>
    B.call('BnbVault.setRemote', B.addr('BnbVault'), lpVaultAbi as Abi, 'setRemote',
      [P.addr('BnbbForwarder'), P.addr('OriginSettler'), precompile, BigInt(PORTALDOT_CHAIN_ID)], { done: vaultDone(B, 'BnbVault') }),
  );
  await step(cfg, 'PotVault.setRemote', () =>
    P.call('PotVault.setRemote', P.addr('PotVault'), lpVaultAbi as Abi, 'setRemote',
      [B.addr('PpotForwarder'), B.addr('OriginSettler'), B.addr('PPOT'), BigInt(BSC_CHAIN_ID)], { done: vaultDone(P, 'PotVault') }),
  );
  await step(cfg, 'BnbbVault.setRemote', () =>
    P.call('BnbbVault.setRemote', P.addr('BnbbVault'), lpVaultAbi as Abi, 'setRemote',
      [B.addr('BnbForwarder'), B.addr('OriginSettler'), zeroAddress, BigInt(BSC_CHAIN_ID)], { done: vaultDone(P, 'BnbbVault') }),
  );

  // 11. Bind the Portaldot Outbox's child-trie id on BSC (needs a BEEFY-proven header after it)
  await step(cfg, 'PortaldotVerifier.bindTrieId', async () => {
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
  });

  // 12. Seeds: gas pool, approval deposits, native vault liquidity
  if (cfg.seeds.gasPool > 0n) {
    await step(cfg, 'gas pool', () =>
      P.call('seed.gasPool', P.addr('PortaldotGateway'), portaldotGatewayAbi as Abi, 'donateGas', [], { value: cfg.seeds.gasPool }),
    );
  }
  if (cfg.mode === 'live' && cfg.seeds.approvalFund > 0n) {
    for (const key of ['BnbbVault', 'BnbbForwarder']) {
      await step(cfg, `approval deposit ${key}`, async () => {
        const id = `seed.approvalFund.${key}`;
        if (P.dep.steps[id]) return;
        if (!cfg.ops) throw new Error('approval funding needs PORTALDOT_OPS_MNEMONIC');
        const r = await fundContractAccount(cfg.portaldot.api, cfg.ops, P.addr(key), cfg.seeds.approvalFund);
        P.mark(id, { tx: r.hash, block: r.block, planck: cfg.seeds.approvalFund.toString() });
      });
    }
  }
  if (cfg.seeds.potVault > 0n) {
    await step(cfg, 'tPOT vault liquidity', () =>
      P.call('seed.potVault', P.addr('PotVault'), lpVaultAbi as Abi, 'deposit', [cfg.seeds.potVault], { value: cfg.seeds.potVault }),
    );
  }
  if (cfg.seeds.bnbVault > 0n) {
    await step(cfg, 'tBNB vault liquidity', () =>
      B.call('seed.bnbVault', B.addr('BnbVault'), lpVaultAbi as Abi, 'deposit', [cfg.seeds.bnbVault], { value: cfg.seeds.bnbVault }),
    );
  }
}

async function beefyRelayFor(B: Side, cfg: PlanConfig): Promise<BeefyRelay> {
  const s = B.sender!;
  const archive = JustificationArchive.open(cfg.archivePath);
  const mirror = await MmrMirror.sync(cfg.portaldot, cfg.hashCachePath, cfg.log);
  const port = beefyClientPort(s.pub, s, B.addr('PortaldotLightClient'));
  return new BeefyRelay(port, livePortaldotSource(cfg.portaldot, mirror, cfg.hashCachePath), archive, { log: cfg.log });
}
