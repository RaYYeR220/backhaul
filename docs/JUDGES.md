# Review Backhaul in 5 minutes

Backhaul is a bridge between the Portaldot V3 testnet and the BNB Chain testnet in which no key, relayer or server can release funds: each chain checks the other chain's consensus in a contract. This page is the shortest path to checking that for yourself. Every link and number below is rendered from `results/*.json` and `deployments/*.json` by `npm run docs`.

<!-- render:status -->
**Status, 2026-11-04 11:35 UTC:** deployed, 2 contracts on Portaldot V3 testnet and 8 on BNB Chain testnet; 2 proven transfers and 0 fast fills recorded. Every address and transaction: [docs/PROOF.md](PROOF.md).
<!-- /render:status -->

## The path

<!-- render:judges-path -->
1. **Landing, 30 s.** Open [backhaul-bridge.vercel.app](https://backhaul-bridge.vercel.app). The live strip at the top reads both chains directly.
2. **Bridge, 2 min.** Open [/app](https://backhaul-bridge.vercel.app/app), pick a direction and send with the demo wallet (no wallet or funds needed). The transfer page shows every proof step with its transaction.
3. **Attack lab, 1 min.** Open [/attacks](https://backhaul-bridge.vercel.app/attacks) and press **Fire all**. Each attack takes real proof material, changes one thing and sends it to the deployed contract as an `eth_call`; the scoreboard counts the reverts.
4. **Status, 30 s.** [/status](https://backhaul-bridge.vercel.app/status) shows both light clients facing each other: the BEEFY set on BNB Chain, the BSC epoch and trusting period left on Portaldot.
5. **The hero transfers on the explorers.**
   - Portaldot V3 testnet → BNB Chain testnet (`portaldot:1`, tPOT): source `0xddc0ca…c6fb3d` ([block 319,008](https://scanner-testnet-v3.portaldot.dev/#/blocks/319008)) → paid out [`0xb7c177…2abcf2`](https://testnet.bscscan.com/tx/0xb7c177b293edfc0837696871a4f3f935cc52693c1fc349d5fd5cfdd30c2abcf2), 46 s.
   - BNB Chain testnet → Portaldot V3 testnet: not deployed yet.
   - Reverted attack transactions: not deployed yet. Until then the rehearsal records name each revert: 11 of 11 fired attacks rejected, listed in [PROOF.md](PROOF.md#forged-proofs-in-the-rehearsals).
6. **The two rehearsals, 1 min.** [rehearsal-beefy.json](../results/rehearsal-beefy.json): BEEFY client on a BSC-testnet fork fed live Portaldot data, a live set rotation 520 → 521, a child-trie storage proof of a live contract accepted, and the same proof with another value rejected. [rehearsal-parlia.json](../results/rehearsal-parlia.json): a real 44-header BSC window finalized by 7 distinct sealers with 8 headers from a validator outside the trusted set, then a receipt proof and an absence proof. Re-run them with `npm run rehearse`.
7. **Re-verify a transfer yourself, 1 min.** `npx tsx packages/sdk/scripts/verify-onchain.ts 0xddc0cafb8bba236cd4d62941c32024a037f00606587801c4b96a3ecfbbc6fb3d` rebuilds the proof from the source chain and checks it against the deployed light client with `eth_call`, plus a tampered copy that must fail.
8. **Tests, 3 min.** `npm ci && npm run test:counts`: 434 passing, 0 failing: Foundry 263 · SDK 92 (+2 live-only, skipped offline) · relayer 44 · ink! 35.
<!-- /render:judges-path -->

## If you have more time

- **What is trusted, direction by direction:** [TRUST.md](TRUST.md).
- **Every claim with its evidence tier and the command that reproduces it:** [CLAIMS.md](CLAIMS.md).
- **Every address and transaction:** [PROOF.md](PROOF.md).
- **The rubric line by line, with evidence:** [CHALLENGE_CHECKLIST.md](CHALLENGE_CHECKLIST.md).
- **EVM vs WASM on identical inputs:** [BENCHMARK.md](BENCHMARK.md).
- **What we found about the public Portaldot nodes while building:** [FINDINGS.md](FINDINGS.md).
- **Where to start reading code:** `contracts/src/bsc/PortaldotLightClient.sol` (BEEFY), `contracts/src/portaldot/ParliaClient.sol` (Parlia), `contracts/src/core/GatewayBase.sol` (the bridge), `packages/sdk/src/attacks.ts` (the attack lab).
