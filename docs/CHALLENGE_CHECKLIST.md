# Challenge checklist

The Portaldot Hacker House 2026 rubric, line by line, with the evidence for each. Cells with numbers or deployment state are rendered by `npm run docs`; they say "not deployed yet" until the testnet records exist.

<!-- render:status -->
**Status, 2026-11-04 00:02 UTC:** built, tested and rehearsed against live data from both chains; **not deployed yet** on the testnets (the deployer wallets are waiting for testnet funds). Every on-chain link in these docs comes from `deployments/*.json` and reads "not deployed yet" until those files exist.
<!-- /render:status -->

## Rubric

<!-- render:rubric -->
| Criterion | Line | Evidence |
| --- | --- | --- |
| Technical Feasibility 30% | Architecture | [README → How it works](../README.md#how-it-works), [TRUST.md](TRUST.md) |
|  | Code completeness | Both light clients, both gateways, ERC-7683 settlers, LP vaults, data feed, ink! twin, relayer, SDK, app. Tests: 434 passing, 0 failing: Foundry 263 · SDK 92 (+2 live-only, skipped offline) · relayer 44 · ink! 35 |
|  | Genuine, sustained development activity | At the last render: 88 commits from 2026-11-02 22:55 UTC to 2026-11-03 23:52 UTC, on 2 distinct days (UTC); 88 of them inside the event window (Oct 14 – Nov 6, 2026). History: [github.com/RaYYeR220/backhaul/commits](https://github.com/RaYYeR220/backhaul/commits/main). When each core module first landed: [below](#core-modules). |
|  | Testnet deployment with verifiable on-chain interactions | **not deployed yet** (testnet funds pending). Ready: `npm run deploy:dry` prices every step against the live chains (3,138 tPOT + 0.0112 tBNB); [PROOF.md](PROOF.md) fills itself from `deployments/*.json` |
|  | Proof the mechanisms work | 11 of 11 forged proofs rejected in the rehearsals; [JUDGES.md](JUDGES.md) step 6; `verify-onchain.ts` re-checks any transfer |
| Innovation 30% | V3: WASM | `ink/parlia_client`, the ink! twin of the Parlia client, and [BENCHMARK.md](BENCHMARK.md) (EVM vs WASM on identical inputs) |
|  | V3: EVM compatibility | Every Portaldot contract runs on pallet-revive; `PortaldotVerifier` reads revive contract storage from its child trie |
|  | V3: modular architecture | BEEFY + MMR pallets (consumed by the light client), pallet-assets + its ERC-20 precompile (BNB.b), Timestamp storage (refund proofs) |
|  | V3: multi-chain | The bridge itself, both directions, plus a data bridge (`BscFeed`) |
|  | Value beyond existing solutions | Custodial and committee bridges can release funds with keys; Backhaul has none and proves both directions: [TRUST.md → Compared with the alternatives](TRUST.md#compared-with-the-alternatives) |
| Ecosystem Contribution 20% | Infrastructure | A light client of BNB Chain on Portaldot and a BEEFY light client of Portaldot on BNB Chain; any Portaldot contract can read proven BNB Chain state through `BscVerifier` |
|  | Developer tools | `@backhaul/sdk`: BEEFY, MMR, Substrate trie, Parlia and MPT proof builders; `verify-onchain.ts`; relayer HTTP API ([API.md](../services/relayer/API.md)) |
|  | Node ecosystem | [FINDINGS.md](FINDINGS.md): what we hit on the public nodes, re-checked by `npm run findings`, and measured deploy costs for builders |
|  | Open-source value | MIT, public from the first commit; third-party code disclosed in the README |
|  | Sustained building | The relayer is permissionless: anyone can run it (`npm run relayer`); light clients stay current only while someone relays |
| Business Potential 20% | Real need | Bridges secured by a few keys lost about $806M in three incidents ([README → Sources](../README.md#sources)); Portaldot V3 holders need a route to BNB Chain liquidity that adds no such keys |
|  | Clear users | tPOT holders moving to BNB Chain liquidity; BNB Chain users entering Portaldot; Portaldot dApps that need a BNB/USD price without an oracle committee |
|  | Business model | Fees go to whoever provides the service: a 0.1% fee on tPOT locks funds the gas pool for BNB.b gas drops; solvers and LP vaults earn the fee on fast fills. No token |
|  | Growth path | Testnet → mainnet with the same contracts and a fresh checkpoint; more EVM chains reuse the Parlia/MPT code; BLS vote checking once a precompile exists |
<!-- /render:rubric -->

## Core modules

<!-- render:core-modules -->
From `git log --diff-filter=A` on each module's main file. Deadline for core modules: 2026-11-05 04:00 UTC.

| Module | File | First committed | Before the deadline |
| --- | --- | --- | --- |
| BEEFY light client of Portaldot (BNB Chain side) | `contracts/src/bsc/PortaldotLightClient.sol` | 2026-11-02 23:57 UTC | yes |
| Parlia light client of BNB Chain (Portaldot side) | `contracts/src/portaldot/ParliaClient.sol` | 2026-11-02 23:41 UTC | yes |
| Canonical bridge gateways | `contracts/src/core/GatewayBase.sol` | 2026-11-02 23:16 UTC | yes |
| ERC-7683 settlers | `contracts/src/intents/OriginSettler.sol` | 2026-11-02 23:31 UTC | yes |
| LP vaults | `contracts/src/intents/LPVault.sol` | 2026-11-02 23:31 UTC | yes |
| Relayer and solver | `services/relayer/src/index.ts` | 2026-11-03 17:12 UTC | yes |
| ink! twin | `ink/parlia_client/src/lib.rs` | 2026-11-03 18:36 UTC | yes |
| Data bridge (BscFeed) | `contracts/src/portaldot/BscFeed.sol` | 2026-11-03 19:13 UTC | yes |
<!-- /render:core-modules -->

## The track, noun by noun

Track 2, Multi-Chain & Cross-Chain Infra: *"Leverage Portaldot's cross-chain capabilities to build asset/data bridges and liquidity engines"*, *"optimizing secure bridge mechanisms"*, *"multi-chain liquidity solutions"*.

| The track asks for | What ships | Where |
| --- | --- | --- |
| Asset bridges | tPOT ⇄ pPOT and tBNB ⇄ BNB.b, both directions proven by light clients | `contracts/src/core/GatewayBase.sol`, `contracts/src/portaldot/PortaldotGateway.sol`, `contracts/src/bsc/BscGateway.sol` |
| Data bridges | Any Portaldot contract reads proven BNB Chain storage through `BscVerifier.storageAt`; `BscFeed` serves Chainlink BNB/USD from it | `contracts/src/portaldot/BscVerifier.sol`, `contracts/src/portaldot/BscFeed.sol` |
| Liquidity engines | ERC-7683 orders: solvers fill at once and are repaid after a proof of the fill; refunds after a proof of no fill | `contracts/src/intents/OriginSettler.sol`, `contracts/src/intents/DestinationSettler.sol`, `services/relayer/src/solver.ts` |
| Multi-chain liquidity solutions | LP vaults on both chains that fill only against a proof the order was opened, with no operator key, and send repayments home over the bridge | `contracts/src/intents/LPVault.sol`, `contracts/src/intents/RepayForwarder.sol` |
| Optimizing secure bridge mechanisms | No keys over funds in either direction: a BEEFY + MMR light client on BNB Chain and a Parlia light client on Portaldot, plus an attack lab that fires forged proofs at them | [TRUST.md](TRUST.md), `packages/sdk/src/attacks.ts`, [PROOF.md](PROOF.md) |
| Portaldot's cross-chain capabilities | BEEFY and MMR, the finality Portaldot runs for bridges, consumed by an on-chain light client; pallet-assets and its ERC-20 precompile for BNB.b | `contracts/src/bsc/PortaldotLightClient.sol`, `contracts/src/lib/substrate/` |
| A foundation for more chains | The relayer is permissionless and the SDK builds every proof; the Parlia and MPT code serves any BSC-style chain | `packages/sdk/`, `services/relayer/` |

## Submission requirements

| Requirement | Where |
| --- | --- |
| Public repository with README, deployment instructions and docs | [README](../README.md), [Run it yourself](../README.md#run-it-yourself), this folder |
| Reproducible, runnable code | `npm ci && npm run test:counts`; `npm run rehearse`; `npm run deploy:dry` |
| Testnet deployment info: addresses and transaction hashes | [PROOF.md](PROOF.md) |
| Runnable demo | [backhaul-bridge.vercel.app](https://backhaul-bridge.vercel.app) |
| Open-source and SDK sources disclosed | [README → Third-party code](../README.md#third-party-code) |
