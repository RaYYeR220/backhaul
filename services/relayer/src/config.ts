// Relayer configuration, all from the environment (load a file with --env <path>).

import { resolve } from 'node:path';
import { parseEther, type Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { BSC_RPC, BSC_RPC_FALLBACK, DEFAULT_DEPLOYMENTS_DIR, PORTALDOT_EVM_RPC, PORTALDOT_SUBSTRATE_WS } from '@backhaul/sdk';

export interface DemoLimits {
  /** Largest amount one request may move, per asset (wei-units). */
  perRequest: { tPOT: bigint; tBNB: bigint; pPOT: bigint; 'BNB.b': bigint };
  /** Total per UTC day, per asset. */
  perDay: { tPOT: bigint; tBNB: bigint; pPOT: bigint; 'BNB.b': bigint };
  /** Requests per IP per hour. */
  perIpPerHour: number;
}

export interface SolverLimits {
  /** Largest output the solver fronts per order, per output asset. */
  maxOutput: { tPOT: bigint; tBNB: bigint; pPOT: bigint; 'BNB.b': bigint };
  /** Spread the solver wants over the output, in bps. */
  minFeeBps: number;
  /** Seconds of deadline left below which the solver does not fill. */
  minDeadlineLeft: number;
  /** tPOT sent first to a BNB.b recipient that holds no tPOT (non-sufficient asset). */
  prefund: bigint;
}

export interface RelayerConfig {
  dataDir: string;
  deploymentsDir: string;
  portaldot: { evmRpc: string; ws: string; http: string };
  bsc: { rpc: string; rpcs: string[] };
  relayerKey: Hex;
  solverKey?: Hex;
  demoKey?: Hex;
  port: number;
  beefy: { commitEveryMs: number; tickMs: number };
  parlia: {
    tolerant: boolean;
    minOverlap: number;
    /** Move the trusted epoch once the trusted set is this old (the client's trusting period is 14 days). */
    refreshAfterSec: bigint;
    /** Alert in /status once less than this is left of the trusting period. */
    trustAlertSec: bigint;
    confirmations: bigint;
    tickMs: number;
    /** Budget guard: Parlia windows cost tPOT (length fee + ring deposits). */
    maxWindowsPerHour: number;
  };
  jobs: { tickMs: number; bscConfirmations: bigint; logChunk: { portaldot: bigint; bsc: bigint } };
  solver: SolverLimits;
  demo: DemoLimits;
}

const hexKey = (v: string | undefined): Hex | undefined => {
  if (!v) return undefined;
  return (v.startsWith('0x') ? v : `0x${v}`) as Hex;
};

const num = (v: string | undefined, d: number) => (v ? Number(v) : d);
const eth = (v: string | undefined, d: string) => parseEther(v ?? d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  // The relayer has its own key. The deployer's Portaldot nonces are reserved by the phased
  // deploy (src/deploy/nonces.ts in the SDK): one stray transaction from it would move the address
  // the PortaldotGateway trusts as its verifier.
  const relayerKey = hexKey(env.RELAYER_PK) ?? hexKey(env.BACKHAUL_RELAYER_PK);
  if (!relayerKey) throw new Error('set RELAYER_PK (or BACKHAUL_RELAYER_PK): the relayer never sends from the deployer key');
  const deployer = hexKey(env.PORTALDOT_DEPLOYER_PK);
  const same = (k?: Hex) => !!k && !!deployer && privateKeyToAddress(k) === privateKeyToAddress(deployer);
  if (env.ALLOW_DEPLOYER_KEY !== '1') {
    if (same(relayerKey)) throw new Error('RELAYER_PK is the deployer key; give the relayer its own key (BACKHAUL_RELAYER_PK)');
    if (same(hexKey(env.DEMO_PK)) || same(hexKey(env.SOLVER_PK))) throw new Error('DEMO_PK / SOLVER_PK must not be the deployer key');
  }
  const dataDir = resolve(env.BACKHAUL_DATA ?? resolve(import.meta.dirname, '../data'));
  const ws = env.PORTALDOT_WS ?? PORTALDOT_SUBSTRATE_WS;
  const bscRpc = env.BSC_RPC ?? BSC_RPC;
  return {
    dataDir,
    deploymentsDir: resolve(env.BACKHAUL_DEPLOYMENTS ?? DEFAULT_DEPLOYMENTS_DIR),
    portaldot: { evmRpc: env.PORTALDOT_EVM_RPC ?? PORTALDOT_EVM_RPC, ws, http: env.PORTALDOT_HTTP ?? ws.replace(/^ws/, 'http') },
    bsc: { rpc: bscRpc, rpcs: [bscRpc, BSC_RPC_FALLBACK].filter((x, i, a) => a.indexOf(x) === i) },
    relayerKey,
    solverKey: hexKey(env.SOLVER_PK),
    demoKey: hexKey(env.DEMO_PK),
    port: num(env.RELAYER_PORT, 8787),
    beefy: { commitEveryMs: num(env.BEEFY_COMMIT_EVERY_MS, 10 * 60_000), tickMs: num(env.BEEFY_TICK_MS, 60_000) },
    parlia: {
      tolerant: (env.BACKHAUL_PARLIA_TOLERANT ?? '1') !== '0',
      minOverlap: num(env.PARLIA_MIN_OVERLAP, 7),
      refreshAfterSec: BigInt(num(env.PARLIA_REFRESH_AFTER_SEC, 3 * 86_400)),
      trustAlertSec: BigInt(num(env.PARLIA_TRUST_ALERT_SEC, 5 * 86_400)),
      confirmations: BigInt(num(env.PARLIA_CONFIRMATIONS, 64)),
      tickMs: num(env.PARLIA_TICK_MS, 60_000),
      maxWindowsPerHour: num(env.PARLIA_MAX_WINDOWS_PER_HOUR, 12),
    },
    jobs: {
      tickMs: num(env.JOBS_TICK_MS, 10_000),
      bscConfirmations: BigInt(num(env.BSC_CONFIRMATIONS, 15)),
      logChunk: { portaldot: BigInt(num(env.PORTALDOT_LOG_CHUNK, 2000)), bsc: BigInt(num(env.BSC_LOG_CHUNK, 2000)) },
    },
    solver: {
      maxOutput: {
        tPOT: eth(env.SOLVER_MAX_TPOT, '20'),
        tBNB: eth(env.SOLVER_MAX_TBNB, '0.02'),
        pPOT: eth(env.SOLVER_MAX_PPOT, '20'),
        'BNB.b': eth(env.SOLVER_MAX_BNBB, '0.02'),
      },
      minFeeBps: num(env.SOLVER_MIN_FEE_BPS, 20),
      minDeadlineLeft: num(env.SOLVER_MIN_DEADLINE_LEFT, 120),
      prefund: eth(env.SOLVER_PREFUND_TPOT, '0.5'),
    },
    demo: {
      perRequest: { tPOT: eth(env.DEMO_MAX_TPOT, '2'), tBNB: eth(env.DEMO_MAX_TBNB, '0.002'), pPOT: eth(env.DEMO_MAX_PPOT, '2'), 'BNB.b': eth(env.DEMO_MAX_BNBB, '0.002') },
      perDay: { tPOT: eth(env.DEMO_DAY_TPOT, '40'), tBNB: eth(env.DEMO_DAY_TBNB, '0.04'), pPOT: eth(env.DEMO_DAY_PPOT, '40'), 'BNB.b': eth(env.DEMO_DAY_BNBB, '0.04') },
      perIpPerHour: num(env.DEMO_PER_IP_PER_HOUR, 3),
    },
  };
}
