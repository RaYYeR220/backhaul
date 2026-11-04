import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const DEPLOYER = `0x${'11'.repeat(32)}`;
const RELAYER = `0x${'22'.repeat(32)}`;

describe('relayer keys', () => {
  it('needs its own key', () => {
    expect(() => loadConfig({ PORTALDOT_DEPLOYER_PK: DEPLOYER })).toThrow(/never sends from the deployer key/);
    expect(loadConfig({ PORTALDOT_DEPLOYER_PK: DEPLOYER, BACKHAUL_RELAYER_PK: RELAYER }).relayerKey).toBe(RELAYER);
    expect(loadConfig({ PORTALDOT_DEPLOYER_PK: DEPLOYER, RELAYER_PK: RELAYER, BACKHAUL_RELAYER_PK: DEPLOYER }).relayerKey).toBe(RELAYER);
  });

  it('refuses the deployer key for the relayer, the demo signer and the solver', () => {
    expect(() => loadConfig({ PORTALDOT_DEPLOYER_PK: DEPLOYER, RELAYER_PK: DEPLOYER })).toThrow(/deployer key/);
    // the same key written without 0x is still the deployer
    expect(() => loadConfig({ PORTALDOT_DEPLOYER_PK: DEPLOYER, RELAYER_PK: DEPLOYER.slice(2) })).toThrow(/deployer key/);
    expect(() => loadConfig({ PORTALDOT_DEPLOYER_PK: DEPLOYER, RELAYER_PK: RELAYER, DEMO_PK: DEPLOYER })).toThrow(/DEMO_PK/);
    expect(() => loadConfig({ PORTALDOT_DEPLOYER_PK: DEPLOYER, RELAYER_PK: RELAYER, SOLVER_PK: DEPLOYER })).toThrow(/SOLVER_PK/);
  });

  it('lets the demo signer share the relayer key', () => {
    const c = loadConfig({ PORTALDOT_DEPLOYER_PK: DEPLOYER, BACKHAUL_RELAYER_PK: RELAYER, DEMO_PK: 'relayer' });
    expect(c.demoKey).toBe(RELAYER);
  });

  it('allows it only when asked to, for local runs', () => {
    expect(loadConfig({ PORTALDOT_DEPLOYER_PK: DEPLOYER, RELAYER_PK: DEPLOYER, ALLOW_DEPLOYER_KEY: '1' }).relayerKey).toBe(DEPLOYER);
  });
});
