/**
 * Backhaul relayer and solver: one process, both directions.
 *
 *   npm start -w services/relayer -- --env <path/to/.env> [--no-solver] [--no-api] [--once]
 *
 * Reads addresses from deployments/{portaldot,bsc}.json. Anyone can run it: every message it
 * carries is checked by the light clients on chain, so it can delay delivery but never forge it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatEther } from 'viem';
import { loadDeployment, loadEnvFromArgs, txLink } from '@backhaul/sdk';
import { createApi, DemoGuard, type AttackLab } from './api.js';
import { BeefyLoop } from './beefyLoop.js';
import { connectChains, jobEnv, solverEnv } from './chains.js';
import { loadConfig } from './config.js';
import { demoSigner } from './demo.js';
import { JobRunner } from './jobs.js';
import { ParliaLoop } from './parliaLoop.js';
import { Solver } from './solver.js';
import { JsonlStore } from './store.js';
import { chainScans, Watcher } from './watcher.js';
import { createAttackLab } from './attackLab.js';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

/**
 * One relayer per data directory: the block-hash cache is positional and the justification
 * archive append-only, so two writers would corrupt them.
 */
function lockDataDir(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'relayer.lock');
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      // stale lock
    }
    if (alive && pid !== process.pid) throw new Error(`another relayer (pid ${pid}) uses ${dir}`);
  }
  writeFileSync(path, String(process.pid));
  return () => rmSync(path, { force: true });
}

async function main() {
  loadEnvFromArgs(process.argv);
  const cfg = loadConfig();
  const unlock = lockDataDir(cfg.dataDir);
  process.on('exit', unlock);
  // A dropped node connection must not take the process down; the loops retry.
  process.on('unhandledRejection', (e) => log(`unhandled rejection: ${(e as Error)?.message ?? e}`));
  const store = JsonlStore.open(resolve(cfg.dataDir, 'jobs.jsonl'));
  const ch = await connectChains(cfg, store, log);
  const env = jobEnv(ch, log);
  const sEnv = flag('no-solver') ? undefined : solverEnv(ch, log);
  const solver = sEnv ? new Solver(sEnv, cfg.solver) : undefined;
  const runner = new JobRunner(store, env, solver, { bscConfirmations: cfg.jobs.bscConfirmations });

  const deployBlock = (chain: 'portaldot' | 'bsc') => {
    const d = loadDeployment(chain, cfg.deploymentsDir);
    const blocks = Object.values(d.contracts).map((c) => c.block ?? 0).filter((b) => b > 0);
    return BigInt(blocks.length ? Math.min(...blocks) : 0);
  };
  const watcher = new Watcher(store, runner, chainScans(ch, { portaldot: deployBlock('portaldot'), bsc: deployBlock('bsc') }), log);
  const beefy = new BeefyLoop(ch, cfg.beefy, log);
  const parlia = new ParliaLoop(ch, runner, env, cfg.parlia, log);

  log(`relayer ${ch.pd.relayer.address}; solver ${solver ? sEnv!.address : 'off'}; demo ${ch.pd.demo?.address ?? 'off'}`);

  if (flag('once')) {
    await beefy.tick();
    await parlia.tick();
    await watcher.tick();
    await runner.tick();
    log(JSON.stringify(await beefy.status()));
    log(JSON.stringify(await parlia.status(), (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    await ch.close();
    return;
  }

  await beefy.start();
  parlia.start();
  let jobsBusy = false;
  const jobsTimer = setInterval(async () => {
    if (jobsBusy) return;
    jobsBusy = true;
    try {
      await watcher.tick();
      await runner.tick();
    } finally {
      jobsBusy = false;
    }
  }, cfg.jobs.tickMs);

  const attacks: AttackLab = createAttackLab(ch, store);
  const guard = new DemoGuard(cfg.demo, store);
  const demo = demoSigner(ch, runner);
  const status = async () => {
    const count = (type: string) => {
      const out: Record<string, number> = {};
      for (const j of store.list((x) => x.type === type)) out[j.state] = (out[j.state] ?? 0) + 1;
      return out;
    };
    const [b, p, pdBal, bscBal] = await Promise.all([
      beefy.status().catch((e) => ({ error: (e as Error).message })),
      parlia.status().catch((e) => ({ error: (e as Error).message })),
      ch.pd.pub.getBalance({ address: ch.pd.relayer.address }),
      ch.bsc.pub.getBalance({ address: ch.bsc.relayer.address }),
    ]);
    const lastBeefy = ch.events.beefy.at(-1);
    return {
      portaldotToBsc: { client: ch.addrs.bsc.PortaldotLightClient, lastTx: lastBeefy ? { ...lastBeefy, link: txLink('bsc', lastBeefy.tx) } : null, ...b },
      bscToPortaldot: { client: ch.addrs.portaldot.ParliaClient, ...p },
      jobs: { transfers: count('transfer'), orders: count('order') },
      relayer: { address: ch.pd.relayer.address, balances: { portaldot: formatEther(pdBal), bsc: formatEther(bscBal) } },
      solver: sEnv ? { address: sEnv.address, limits: cfg.solver } : null,
      demo: demo ? { address: demo.address, limits: cfg.demo, usedToday: guard.usedToday() } : null,
      addresses: ch.addrs,
    };
  };
  const server = flag('no-api') ? undefined : createApi({ store, status, attacks, demo, guard, log });
  server?.listen(cfg.port, () => log(`api on :${cfg.port}`));

  const shutdown = async () => {
    log('shutting down');
    clearInterval(jobsTimer);
    parlia.stop();
    await beefy.stop();
    server?.close();
    await ch.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
