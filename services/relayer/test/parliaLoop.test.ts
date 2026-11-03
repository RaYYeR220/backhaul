import { describe, expect, it } from 'vitest';
import type { TrustedSetView } from '@backhaul/sdk';
import type { Chains } from '../src/chains.js';
import { loadConfig } from '../src/config.js';
import type { JobEnv, JobRunner } from '../src/jobs.js';
import { ParliaLoop, trustAlert } from '../src/parliaLoop.js';
import { A } from './helpers.js';

const DAY = 86_400n;
const NOW = 2_000_000_000n;

/** A ParliaLoop over a client whose trusted set came from `epochTimestamp` and was installed at `installedAt`. */
function loop(epochTimestamp: bigint, installedAt: bigint) {
  const set: TrustedSetView = { validators: [A(1)], turnLength: 8, epoch: 9000n, activeFrom: 9040n, epochTimestamp, installedAt };
  const ch = {
    parlia: { lc: { validatorSet: async () => set, trustingPeriod: async () => 14n * DAY } },
    bsc: { rpc: { blockNumber: async () => 9500n, block: async () => { throw new Error('offline'); } } },
    events: { parlia: [] },
  } as unknown as Chains;
  const cfg = loadConfig({ RELAYER_PK: '0x01' }).parlia;
  return new ParliaLoop(ch, {} as JobRunner, {} as JobEnv, cfg, () => {});
}

describe('Parlia trust in /status', () => {
  it('defaults to a refresh every 3 days and an alert below 5 days left', () => {
    const cfg = loadConfig({ RELAYER_PK: '0x01' }).parlia;
    expect([cfg.refreshAfterSec, cfg.trustAlertSec]).toEqual([3n * DAY, 5n * DAY]);
    expect(loadConfig({ RELAYER_PK: '0x01', PARLIA_REFRESH_AFTER_SEC: '86400', PARLIA_TRUST_ALERT_SEC: '3600' }).parlia).toMatchObject({ refreshAfterSec: DAY, trustAlertSec: 3600n });
  });

  it('counts the period from the earlier clock and stays quiet with time to spare', async () => {
    const st = await loop(NOW - 3n * DAY, NOW - 2n * DAY).status(NOW);
    expect(st.trustingPeriodSec).toBe(String(14n * DAY));
    expect(st.installedAt).toBe(String(NOW - 2n * DAY));
    expect(st.trustRemainingSec).toBe(String(11n * DAY));
    expect(st.trustAlert).toBeNull();
  });

  it('alerts once less than 5 days remain, and once it has expired', async () => {
    const soon = await loop(NOW - 10n * DAY, NOW - 9n * DAY - 3600n).status(NOW);
    expect(soon.trustRemainingSec).toBe(String(4n * DAY));
    expect(soon.trustAlert).toMatch(/expires in 4\.0 days: refresh the trusted epoch/);
    // Installed on Portaldot well before the epoch block's BSC time: that clock decides.
    const skewed = await loop(NOW - DAY, NOW - 13n * DAY).status(NOW);
    expect(skewed.trustRemainingSec).toBe(String(DAY));
    expect(skewed.trustAlert).toMatch(/expires in 1\.0 days/);
    expect(trustAlert(0n, 5n * DAY)).toMatch(/has expired/);
    expect(trustAlert(5n * DAY, 5n * DAY)).toBeNull();
  });
});
