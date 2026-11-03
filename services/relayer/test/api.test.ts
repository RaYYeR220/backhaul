import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEther, type Hex } from 'viem';
import { createApi, DemoGuard, type AttackLab, type DemoSigner } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { step, type TransferJob } from '../src/store.js';
import { A, tempStore } from './helpers.js';

const cfg = loadConfig({ RELAYER_PK: `0x${'11'.repeat(32)}` });
const TX = `0x${'ab'.repeat(32)}` as Hex;

const lab: AttackLab = {
  list: async () => [
    { id: 'beefy-forged-signature', title: 'Forged BEEFY signature', chain: 'bsc', target: 'PortaldotLightClient.submitCommitment', expects: ['InvalidSignature'], ready: true },
    { id: 'replayed-nonce', title: 'Replayed nonce', chain: 'bsc', target: 'BscGateway.finalize', expects: ['AlreadyFinalized'], ready: false, missing: ['transferToBsc'] },
  ],
  run: async (id) => ({
    id,
    title: 'Forged BEEFY signature',
    chain: 'bsc',
    target: 'PortaldotLightClient.submitCommitment',
    call: { to: A(1), data: '0x' },
    reverted: true,
    reason: 'InvalidSignature(0)',
    defended: true,
    ms: 3,
  }),
};

let servers: { close(): void }[] = [];
afterEach(() => {
  servers.forEach((s) => s.close());
  servers = [];
});

async function start(over: { demo?: DemoSigner; perIp?: number } = {}) {
  const store = tempStore();
  const job: TransferJob = {
    id: 'portaldot:1',
    type: 'transfer',
    src: 'portaldot',
    dst: 'bsc',
    nonce: '1',
    kind: 1,
    recipient: A(7),
    amount: '1000000000000000000',
    key: '0x00',
    value: '0x00',
    srcTx: TX,
    srcBlock: '123',
    state: 'finalized',
    createdAt: new Date().toISOString(),
    updatedAt: '',
    steps: [step('locked', { chain: 'portaldot', tx: TX, block: '123' }), step('finalized', { chain: 'bsc', tx: TX, block: '9' })],
    attempts: 0,
  };
  store.put(job);
  let statusCalls = 0;
  const guard = new DemoGuard({ ...cfg.demo, perIpPerHour: over.perIp ?? cfg.demo.perIpPerHour }, store);
  const server = createApi({ store, attacks: lab, guard, demo: over.demo, status: async () => ({ calls: ++statusCalls }) });
  await new Promise<void>((r) => server.listen(0, r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string) => {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.json() };
  };
  const post = async (p: string, b?: unknown) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, body: await r.json() };
  };
  return { get, post, base, store };
}

const demo: DemoSigner = {
  address: A(0xd),
  send: async () => ({ id: 'portaldot:2', tx: TX, chain: 'portaldot', block: 5n }),
};

describe('api', () => {
  it('serves cached status', async () => {
    const { get } = await start();
    const a = await get('/status');
    const b = await get('/status');
    expect(a.status).toBe(200);
    expect(a.body.calls).toBe(1);
    expect(b.body.calls).toBe(1);
    expect(a.body.at).toMatch(/Z$/);
  });

  it('serves a transfer timeline by id or source tx, with explorer links', async () => {
    const { get } = await start();
    const byId = await get('/transfers/portaldot%3A1');
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ id: 'portaldot:1', type: 'transfer', from: 'portaldot', to: 'bsc', kindName: 'POT_TO_BSC', state: 'finalized' });
    expect(byId.body.steps[1].link).toBe(`https://testnet.bscscan.com/tx/${TX}`);
    expect(byId.body.steps[0].link).toContain('polkadot.js.org/apps');
    expect((await get(`/transfers/${TX}`)).body.id).toBe('portaldot:1');
    expect((await get('/transfers/nope')).status).toBe(404);
    expect((await get('/transfers')).body.items).toHaveLength(1);
  });

  it('lists attacks and runs only the ready ones', async () => {
    const { get, post } = await start();
    const list = await get('/attacks');
    expect(list.body).toMatchObject({ total: 2, ready: 1 });
    const run = await post('/attacks/beefy-forged-signature');
    expect(run.body).toMatchObject({ reverted: true, defended: true, reason: 'InvalidSignature(0)' });
    const notReady = await post('/attacks/replayed-nonce');
    expect(notReady.status).toBe(409);
    expect(notReady.body.missing).toEqual(['transferToBsc']);
    expect((await post('/attacks/unknown')).status).toBe(404);
  });

  it('validates demo transfers and enforces the per-request cap', async () => {
    const { post } = await start({ demo });
    expect((await post('/demo/transfer', { route: 'x', amount: '1', recipient: A(1) })).status).toBe(400);
    expect((await post('/demo/transfer', { route: 'pot-to-bsc', amount: '1', recipient: 'nope' })).status).toBe(400);
    expect((await post('/demo/transfer', { route: 'pot-to-bsc', amount: '2.5', recipient: A(1) })).status).toBe(400);
    expect((await post('/demo/transfer', { route: 'bnb-to-portaldot', amount: '0.003', recipient: A(1) })).status).toBe(400);
    const ok = await post('/demo/transfer', { route: 'pot-to-bsc', amount: '1.5', recipient: A(1) });
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ id: 'portaldot:2', amount: parseEther('1.5').toString(), statusUrl: '/transfers/portaldot%3A2' });
  });

  it('rate-limits each client and caps the day', async () => {
    const { post } = await start({ demo, perIp: 2 });
    const send = () => post('/demo/transfer', { route: 'pot-to-bsc', amount: '1', recipient: A(1) });
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(202);
    const third = await send();
    expect(third.status).toBe(429);
    expect(third.body.retryAfterSec).toBeGreaterThan(0);
  });

  it('caps the demo signer per day', () => {
    const store = tempStore();
    const g = new DemoGuard({ ...cfg.demo, perIpPerHour: 1000 }, store);
    for (let i = 0; i < 20; i++) {
      g.check(`ip${i}`, 'tPOT', parseEther('2'));
      g.record(`ip${i}`, 'tPOT', parseEther('2'));
    }
    expect(() => g.check('another', 'tPOT', parseEther('1'))).toThrow(/daily/);
    expect(g.usedToday().tPOT).toBe(parseEther('40').toString());
  });

  it('answers CORS preflight and reports a missing demo signer', async () => {
    const { base, post } = await start();
    const r = await fetch(`${base}/demo/transfer`, { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect((await post('/demo/transfer', {})).status).toBe(503);
  });
});
