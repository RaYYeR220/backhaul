import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getContractAddress, parseEther, type Address, type Hex } from 'viem';
import { checkNonce, extendPlan, NonceMismatch, planNonces, plannedAddress, type PlannedTx } from '../src/deploy/nonces.js';
import { deploySteps, ensureBscPlan, ensurePortaldotPlan, plannedTxs, type PlanConfig } from '../src/deploy/plan.js';
import { Side } from '../src/deploy/side.js';
import { emptyDeployment } from '../src/deployments.js';
import type { TxSender } from '../src/evm.js';

const DEPLOYER = '0xaA3b93a16647e193C74200F9178378454fDc3876' as Address;
const RELAYER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;

const cfg = (over: Partial<PlanConfig> = {}): PlanConfig =>
  ({
    mode: 'local',
    assetId: 9797,
    bnbbSupply: 1n,
    minFeeBps: 30,
    bnbVaults: false,
    trustingPeriod: 1n,
    fundRelayer: { to: RELAYER, value: parseEther('100') },
    seeds: { gasPool: parseEther('5'), potVault: parseEther('20'), bnbVault: 0n, approvalFund: 0n },
    portaldot: undefined as never,
    bsc: undefined as never,
    archivePath: '',
    hashCachePath: '',
    log: () => {},
    ...over,
  }) as PlanConfig;

/** A sender that only answers nonce queries and records what it is asked to send. */
function fakeSender(address: Address, nonce: { n: number }): TxSender & { sent: { nonce?: number; label?: string }[] } {
  const sent: { nonce?: number; label?: string }[] = [];
  return {
    address,
    sent,
    pub: { getTransactionCount: async () => nonce.n, getCode: async () => '0x' },
    async send(req: { nonce?: number; label?: string }) {
      sent.push({ nonce: req.nonce, label: req.label });
      nonce.n++;
      return { hash: `0x${'00'.repeat(32)}` as Hex, receipt: { blockNumber: 1n, gasUsed: 21_000n, contractAddress: null }, gas: 0n, gasPrice: 0n };
    },
  } as never;
}

const sides = (pdSender?: TxSender, bscSender?: TxSender) => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-'));
  return {
    P: new Side('portaldot', emptyDeployment('portaldot'), dir, pdSender),
    B: new Side('bsc', emptyDeployment('bsc'), dir, bscSender),
  };
};

describe('nonce plans', () => {
  const txs: PlannedTx[] = [
    { step: 'deploy Outbox', phase: 'A', kind: 'deploy', contract: 'Outbox' },
    { step: 'Outbox.poke', phase: 'A', kind: 'call' },
    { step: 'deploy Gateway', phase: 'B', kind: 'deploy', contract: 'Gateway' },
  ];

  it('reserves consecutive nonces and the CREATE address of each deploy', () => {
    const p = planNonces('portaldot', DEPLOYER, 7, txs);
    expect(p.reserved.map((r) => r.nonce)).toEqual([7, 8, 9]);
    expect(p.reserved[0].address).toBe(getContractAddress({ from: DEPLOYER, nonce: 7n }));
    expect(p.reserved[1].address).toBeUndefined();
    expect(plannedAddress(p, 'Gateway')).toBe(getContractAddress({ from: DEPLOYER, nonce: 9n }));
  });

  it('accepts only the reserved nonce, and says which way it is off', () => {
    const p = planNonces('portaldot', DEPLOYER, 7, txs);
    expect(checkNonce(p, 'Outbox.poke', 8).nonce).toBe(8);
    const ahead = (() => {
      try {
        checkNonce(p, 'Outbox.poke', 9);
      } catch (e) {
        return e as NonceMismatch;
      }
    })()!;
    expect(ahead).toBeInstanceOf(NonceMismatch);
    expect([ahead.behind, ahead.message]).toEqual([false, expect.stringMatching(/something else was sent/)]);
    let behind: NonceMismatch | undefined;
    try {
      checkNonce(p, 'Outbox.poke', 7);
    } catch (e) {
      behind = e as NonceMismatch;
    }
    expect(behind?.behind).toBe(true);
    expect(() => checkNonce(p, 'deploy Stray', 9)).toThrow(/not in the nonce plan/);
  });

  it('extends a plan after its last nonce and refuses duplicates', () => {
    const p = extendPlan(planNonces('bsc', DEPLOYER, 0, txs.slice(0, 1)), [txs[2]], 5);
    expect(p.reserved.map((r) => [r.step, r.nonce])).toEqual([
      ['deploy Outbox', 0],
      ['deploy Gateway', 5],
    ]);
    expect(() => extendPlan(p, [txs[0]])).toThrow(/already reserved/);
    expect(() => planNonces('bsc', DEPLOYER, 0, [txs[0], txs[0]])).toThrow(/twice/);
  });
});

describe('the phased Backhaul plan', () => {
  it('puts BscVerifier where the phase-A gateway already points', () => {
    const { P, B } = sides();
    const steps = deploySteps(P, B, cfg());
    const pd = plannedTxs(steps, 'portaldot');
    expect(pd.map((t) => `${t.phase} ${t.step}`)).toEqual([
      'A deploy Outbox',
      'A deploy PortaldotGateway',
      'A PortaldotGateway.setRemote',
      'A fund.relayer',
      'B deploy ParliaClient',
      'B deploy BscVerifier',
      'B deploy OriginSettler',
      'B deploy DestinationSettler',
      'B deploy PotVault',
      'B deploy PotForwarder',
      'B OriginSettler.setRemoteDestination',
      'B PotVault.setRemote',
      'B seed.gasPool',
      'B seed.potVault',
    ]);
    const plan = planNonces('portaldot', DEPLOYER, 0, pd);
    expect(plannedAddress(plan, 'BscVerifier')).toBe(getContractAddress({ from: DEPLOYER, nonce: 5n }));
    expect(plannedAddress(plan, 'ParliaClient')).toBe(getContractAddress({ from: DEPLOYER, nonce: 4n }));
    // phase A on BSC: everything but the wiring that needs phase-B Portaldot addresses
    expect(plannedTxs(steps, 'bsc', ['A']).map((t) => t.step)).toEqual([
      'deploy Outbox',
      'deploy PortaldotLightClient',
      'deploy PortaldotVerifier',
      'deploy PPOT',
      'deploy BscGateway',
      'BscGateway.setRemote',
      'deploy OriginSettler',
      'deploy DestinationSettler',
      'deploy PpotVault',
    ]);
  });

  it('funds the relayer on BSC at the end of phase A without touching the Portaldot plan', () => {
    const { P, B } = sides();
    const withBnb = deploySteps(P, B, cfg({ fundRelayerBsc: { to: RELAYER, value: parseEther('0.02') } }));
    expect(plannedTxs(withBnb, 'bsc', ['A']).at(-1)).toMatchObject({ step: 'fund.relayer.bsc', kind: 'transfer' });
    expect(plannedTxs(withBnb, 'portaldot')).toEqual(plannedTxs(deploySteps(P, B, cfg()), 'portaldot'));
  });

  it('keeps the saved plan, re-plans only after BscVerifier, and refuses to move it', async () => {
    const nonce = { n: 3 };
    const s = fakeSender(DEPLOYER, nonce);
    const { P, B } = sides(s);
    const first = await ensurePortaldotPlan(P, deploySteps(P, B, cfg()), () => {});
    expect(first.startNonce).toBe(3);
    const verifier = plannedAddress(first, 'BscVerifier');
    expect(P.dep.meta.reserved).toContainEqual({ nonce: 8, name: 'BscVerifier', address: verifier, phase: 'B' });

    // later, with the account further along and the BNB vaults added: same reservation up to BscVerifier
    nonce.n = 7;
    const again = await ensurePortaldotPlan(P, deploySteps(P, B, cfg({ bnbVaults: true })), () => {});
    expect(plannedAddress(again, 'BscVerifier')).toBe(verifier);
    expect(again.reserved.some((r) => r.step === 'deploy BnbbVault')).toBe(true);

    // a change before BscVerifier would move it: refused
    await expect(ensurePortaldotPlan(P, deploySteps(P, B, cfg({ fundRelayer: undefined })), () => {})).rejects.toThrow(/differ from the saved nonce plan/);
  });

  it('sends only at the reserved nonce, and nothing unplanned on Portaldot', async () => {
    const nonce = { n: 0 };
    const s = fakeSender(DEPLOYER, nonce);
    const { P, B } = sides(s);
    await ensurePortaldotPlan(P, deploySteps(P, B, cfg()), () => {});
    // fund.relayer is reserved at nonce 3; the account is at 0: an earlier step has not run
    await expect(P.transfer('fund.relayer', RELAYER, 1n)).rejects.toMatchObject({ behind: true });
    nonce.n = 4; // one transaction too many
    await expect(P.transfer('fund.relayer', RELAYER, 1n)).rejects.toThrow(/something else was sent/);
    nonce.n = 3;
    await P.transfer('fund.relayer', RELAYER, 1n);
    expect(s.sent).toEqual([{ nonce: 3, label: 'fund.relayer' }]);
    await expect(P.transfer('fund.someone', RELAYER, 1n)).rejects.toThrow(/not in the nonce plan/);
    await expect(P.call('Stray.call', RELAYER, [], 'x', [])).rejects.toThrow(/not in the nonce plan/);
  });

  it('plans BSC per phase from the current nonce, skipping what is done', async () => {
    const nonce = { n: 12 };
    const { P, B } = sides(undefined, fakeSender(DEPLOYER, nonce));
    B.dep.contracts.Outbox = { artifact: 'Outbox', address: RELAYER };
    const plan = await ensureBscPlan(B, deploySteps(P, B, cfg()), 'A');
    expect(plan.reserved[0]).toMatchObject({ nonce: 12, step: 'deploy PortaldotLightClient' });
    expect(plannedAddress(plan, 'BscGateway')).toBe(getContractAddress({ from: DEPLOYER, nonce: 15n }));
    expect(plannedAddress(plan, 'PPOT')).toBe(getContractAddress({ from: DEPLOYER, nonce: 14n }));
  });
});
