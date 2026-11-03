// Every attack in the lab, run against real contracts on a local anvil node that were set up
// from the forge fixtures (live Portaldot and BSC testnet data). Needs `anvil` and a
// `forge build`; skipped otherwise.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getContractAddress,
  http,
  keccak256,
  parseEther,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ARTIFACTS_DIR, loadArtifact } from '../src/artifacts.js';
import { ATTACKS, readiness, runAttack, type AttackContext, type AttackOutcome } from '../src/attacks.js';
import { encodeCommitmentProof } from '../src/bsc/verifier.js';
import { buildWindow, type HeaderSource } from '../src/bsc/window.js';
import { hasAnvil, startAnvil, type Anvil } from '../src/deploy/anvil.js';
import { outboxKey } from '../src/portaldot/storage.js';

const fixtures = join(__dirname, '..', '..', '..', 'contracts', 'test', 'fixtures');
const load = (n: string) => JSON.parse(readFileSync(join(fixtures, n), 'utf8'));
const F = load('portaldot-beefy.json');
const S = load('portaldot-storage.json');
const H = load('bsc-headers.json');
const R = load('bsc-receipt.json');

const runnable = hasAnvil() && existsSync(join(ARTIFACTS_DIR, 'MockRemoteVerifier.sol'));
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const me = privateKeyToAccount(KEY);

describe.skipIf(!runnable)('attack lab against fixture-backed contracts', () => {
  let anvil: Anvil;
  let pub: PublicClient;
  let ctx: AttackContext;
  const outcomes: AttackOutcome[] = [];

  beforeAll(async () => {
    anvil = await startAnvil({ port: 8711, chainId: 97 });
    pub = createPublicClient({ transport: http(anvil.url) }) as PublicClient;
    const wallet = createWalletClient({ account: me, transport: http(anvil.url) });
    const send = async (hash: Hex) => {
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error(`tx failed: ${hash}`);
      return r;
    };
    const deploy = async (name: string, args: unknown[] = []): Promise<Address> => {
      const a = loadArtifact(name);
      const r = await send(await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args, chain: null }));
      return r.contractAddress!;
    };
    const write = async (to: Address, name: string, fn: string, args: unknown[], value = 0n) =>
      send(await wallet.writeContract({ address: to, abi: loadArtifact(name).abi as Abi, functionName: fn, args, value, chain: null }));

    // BEEFY light client of Portaldot from the fixture checkpoint (set 502), then a real
    // commitment, a header, the real rotation to set 503 and its first commitment.
    const lc = await deploy('PortaldotLightClient', [BigInt(F.setId), F.signers, F.checkpoint.blockNumber, F.checkpoint.mmrRoot]);
    const submit = (c: any) => write(lc, 'PortaldotLightClient', 'submitCommitment', [c.commitmentScale, c.indices.map(BigInt), c.signatures]);
    const imp = (cb: number, h: any) => write(lc, 'PortaldotLightClient', 'importHeader', [cb, h.headerScale, { leafIndex: BigInt(h.mmrProof.leafIndex), leafCount: BigInt(h.mmrProof.leafCount), items: h.mmrProof.items }]);
    await submit(F.commitment);
    await imp(F.commitment.blockNumber, F.header);
    const verifier = await deploy('PortaldotVerifier', [lc, S.mapping.address]);
    await write(verifier, 'PortaldotVerifier', 'bindTrieId', [S.headerNumber, S.mapping.accountInfoProof]);
    const keys = F.nextAuthorities.x.map((x: Hex, i: number) => [BigInt(x), BigInt(F.nextAuthorities.y[i])]);
    await write(lc, 'PortaldotLightClient', 'rotate', [F.header.number, F.storage.proof, keys]);
    await submit(F.next);
    await imp(F.next.blockNumber, F.nextHeader);

    // Parlia light client of BSC from the fixture checkpoint, and the shortest real window above
    // the block with the fixture receipt.
    const cp = H.checkpoint;
    const parlia = await deploy('ParliaClient', [97n, 1000n, 604_800n, { epoch: BigInt(cp.epoch), timestamp: BigInt(cp.timestamp), activeFrom: BigInt(cp.activeFrom), turnLength: cp.turnLength, validators: cp.validators }]);
    const src: HeaderSource = {
      async headerRlps(from, count) {
        const i = Number(from - BigInt(H.epoch));
        return H.rlps.slice(i, i + count);
      },
    };
    const window = await buildWindow(src, BigInt(R.blockNumber), { validators: cp.validators, turnLength: cp.turnLength, epoch: BigInt(cp.epoch), activeFrom: BigInt(cp.activeFrom) });
    await write(parlia, 'ParliaClient', 'submitWindow', [window]);
    const bscVerifier = await deploy('BscVerifier', [parlia, R.legacy.emitter]);
    const bscReceipt = { proof: encodeCommitmentProof({ blockNumber: BigInt(R.blockNumber), key: R.legacy.key, proof: R.legacy.proof, logIndex: R.legacy.logIndex }) };

    // Portaldot side: gateway and origin settler over the real BscVerifier, one open order.
    const outboxP = await deploy('Outbox');
    const asset = await deploy('MockAssetPrecompile');
    const pGw = await deploy('PortaldotGateway', [outboxP, bscVerifier, asset]);
    await write(pGw, 'PortaldotGateway', 'setRemote', ['0x000000000000000000000000000000000000b5c0']);
    const originP = await deploy('OriginSettler', [bscVerifier, outboxP]);
    await write(originP, 'OriginSettler', 'setRemoteDestination', ['0x000000000000000000000000000000000000d570']);
    const block = await pub.getBlock();
    const order = { user: me.address, inputToken: zeroAddress, inputAmount: parseEther('1'), outputToken: zeroAddress, outputAmount: parseEther('0.99'), recipient: me.address, destinationChainId: 97n, nonce: 1n };
    const orderType = { type: 'tuple', components: ['user', 'inputToken', 'inputAmount', 'outputToken', 'outputAmount', 'recipient', 'destinationChainId', 'nonce'].map((name, i) => ({ name, type: ['address', 'address', 'uint256', 'address', 'uint256', 'address', 'uint64', 'uint64'][i] })) } as const;
    const deadline = Number(block.timestamp) + 3600;
    await write(originP, 'OriginSettler', 'open', [
      { fillDeadline: deadline, orderDataType: keccak256(new TextEncoder().encode('BackhaulOrder(address user,address inputToken,uint256 inputAmount,address outputToken,uint256 outputAmount,address recipient,uint64 destinationChainId,uint64 nonce)')), orderData: encodeAbiParameters([orderType], [order]) },
    ], parseEther('1'));
    const chainId = BigInt(await pub.getChainId());
    const originData = encodeAbiParameters([orderType, { type: 'uint64' }, { type: 'uint32' }], [order, chainId, deadline]);

    // BSC gateway whose replay protection is under test (its verifier is a stand-in that accepts
    // one transfer: what matters is that the second delivery is refused).
    const outboxB = await deploy('Outbox');
    const mock = await deploy('MockRemoteVerifier');
    const nonce = await pub.getTransactionCount({ address: me.address });
    const ppot = await deploy('PPOT', [getContractAddress({ from: me.address, nonce: BigInt(nonce + 1) })]);
    const bGw = await deploy('BscGateway', [outboxB, mock, ppot]);
    await write(bGw, 'BscGateway', 'setRemote', [pGw]);
    const t = { nonce: 0n, kind: 1, recipient: me.address, amount: parseEther('1') };
    const value = keccak256(encodeAbiParameters([{ type: 'uint64' }, { type: 'uint8' }, { type: 'address' }, { type: 'uint256' }], [t.nonce, t.kind, t.recipient, t.amount]));
    await write(mock, 'MockRemoteVerifier', 'setCommitment', [outboxKey(pGw, `0x${'0'.repeat(64)}`), value, true]);
    await write(bGw, 'BscGateway', 'finalize', [t, '0x']);

    ctx = {
      clients: { portaldot: pub, bsc: pub },
      targets: { portaldotLightClient: lc, portaldotVerifier: verifier, bscGateway: bGw, parliaClient: parlia, bscVerifier, portaldotGateway: pGw, originSettler: { portaldot: originP } },
      material: {
        beefy: F.next.justification,
        staleBeefy: F.commitment.justification,
        headerImport: { commitmentBlock: F.next.blockNumber, headerScale: F.nextHeader.headerScale, proof: F.nextHeader.mmrProof },
        portaldotCommitment: { key: S.mapping.key, value: S.mapping.value, proof: S.mapping.commitmentProof },
        presentAbsence: { key: S.mapping.key, proof: S.mapping.presentAbsenceProof },
        parliaWindow: window,
        parliaChainId: 97,
        bscReceipt,
        transferToBsc: { t, proof: '0x' },
        openOrder: { chain: 'portaldot', originData },
      },
    };
  }, 120_000);

  afterAll(() => {
    anvil?.stop();
    if (outcomes.length) console.table(outcomes.map((o) => ({ id: o.id, reason: o.reason, defended: o.defended })));
  });

  it('starts from material the contracts accept', async () => {
    const v = ctx.targets.portaldotVerifier!;
    const ok = await pub.readContract({ address: v, abi: loadArtifact('PortaldotVerifier').abi, functionName: 'verifyCommitment', args: [S.mapping.key, S.mapping.value, S.mapping.commitmentProof] });
    expect(ok).toBe(true);
  });

  it('has every attack ready', () => {
    for (const a of ATTACKS) expect(readiness(a, ctx), a.id).toEqual({ ready: true, missing: [] });
  });

  for (const a of ATTACKS) {
    it(`${a.id} is rejected (${a.expects.join(' | ')})`, async () => {
      const o = await runAttack(a, ctx);
      outcomes.push(o);
      expect(o.defended, `${a.id}: ${o.reason}`).toBe(true);
    });
  }

  it('covers every attack of the design list', () => {
    expect(ATTACKS.map((a) => a.id)).toEqual([
      'beefy-forged-signature',
      'beefy-stale-set',
      'mmr-wrong-leaf',
      'header-not-in-mmr',
      'tampered-storage-proof',
      'replayed-nonce',
      'parlia-forged-header',
      'parlia-too-few-sealers',
      'receipt-not-included',
      'settle-unfilled-order',
      'refund-filled-order',
      'bnbb-beyond-locked',
    ]);
  });
});
