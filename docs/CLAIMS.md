# Claims ledger

Every public statement Backhaul makes, tagged by how you can check it:

- **REPRODUCIBLE**: run the command or test named next to it and get the same result.
- **VERIFIED-LIVE**: observed on a live chain or a public record; the link or file says where.
- **MODELED**: computed from measured inputs, not observed end to end.
- **NOT-CLAIMED**: not shown yet, or out of scope. Listed so nobody reads it into the rest.

The table is rendered by `npm run docs`: a claim moves from REPRODUCIBLE (local) to VERIFIED-LIVE only when the testnet record that backs it exists in `deployments/*.json`, `results/live-transfers.json` or `results/attacks.json`.

<!-- render:claims -->
| Claim | Tier | Reproduce / evidence |
| --- | --- | --- |
| No contract has an owner, admin, pause or upgrade path; the only privileged call is a one-time `setRemote` wiring by the deployer | **REPRODUCIBLE** | `grep -rnE "onlyOwner\|Ownable\|whenNotPaused\|upgradeTo\|delegatecall\|selfdestruct" contracts/src` matches nothing; a second `setRemote` reverts (`Gateways.t.sol::test_setRemoteOnce`) |
| The test suites pass: 401 passing, 0 failing: Foundry 249 · SDK 86 (+2 live-only, skipped offline) · relayer 34 · ink! 32 | **REPRODUCIBLE** | `npm run test:counts` → `results/test-counts.json` |
| The BEEFY client accepts real Portaldot commitments, headers and a real validator-set rotation, and rejects forged ones | **REPRODUCIBLE** | `npm run rehearse:beefy` (BSC-testnet fork + live Portaldot) → `results/rehearsal-beefy.json`; fixtures in `contracts/test/bsc/` |
| The Parlia client finalizes real BSC windows from ⌈2N/3⌉ distinct trusted sealers, tolerating seals from validators outside the trusted set without counting them | **REPRODUCIBLE** | `npm run rehearse:parlia` → `results/rehearsal-parlia.json`; `contracts/test/portaldot/ParliaClient.t.sol` on real rotations |
| Forged proofs are rejected: 11 of 11 attacks fired in the rehearsals, each with a named reason | **REPRODUCIBLE** | both rehearsal files, `attacks` arrays; `packages/sdk/src/attacks.ts` |
| The attack lab rejects every forged proof against the deployed contracts | **NOT-CLAIMED** | not deployed yet |
| tPOT locked on Portaldot is minted as pPOT on BNB Chain only against a BEEFY + MMR + child-trie proof | **REPRODUCIBLE** | locally: `contracts/test/core/Gateways.t.sol`, `PortaldotVerifier.t.sol` on recorded Portaldot proofs; testnet: not deployed yet |
| tBNB locked on BNB Chain is released as BNB.b on Portaldot only against a Parlia window + receipt proof | **REPRODUCIBLE** | locally: `Gateways.t.sol::test_bnbRoundTrip`, `BscVerifier.t.sol` on recorded BSC receipts; testnet: not deployed yet |
| Supply invariants hold: pPOT supply equals locked tPOT, circulating BNB.b equals locked tBNB, no transfer finalizes twice | **REPRODUCIBLE** | `contracts/test/core/GatewaysInvariant.t.sol` (Foundry invariant runs) |
| Solvers fill ERC-7683 orders on the destination at once and are repaid only after a light-client proof of the fill | **REPRODUCIBLE** | locally: `contracts/test/intents/Settlers.t.sol`, `Routes.t.sol`, `LPVault.t.sol`; testnet: not deployed yet |
| The Chainlink BNB/USD feed of BNB Chain testnet is readable on Portaldot from storage proofs | **REPRODUCIBLE** | locally: `contracts/test/portaldot/BscFeed.t.sol` on recorded BSC storage proofs; testnet: not deployed yet |
| The same Parlia client runs as an ink! contract; 48 headers cost 12.32 ms refTime (1,827,194 gas on the EVM build) in the pallet-contracts sandbox | **REPRODUCIBLE** | `npm run test:ink`, `npm run benchmark` → `docs/BENCHMARK.md` |
| EVM vs WASM weight and fee for the same window, on Portaldot itself | **NOT-CLAIMED** | not deployed yet: needs both clients on chain |
| Portaldot accepts the ink! code: upload and instantiate dry-runs succeed (deposit 1,595.15 tPOT) | **VERIFIED-LIVE** | `ContractsApi_upload_code` / `ContractsApi_instantiate` dry-runs in `npm run benchmark` |
| Full deployment costs 3,030 tPOT + 0.0112 tBNB | **MODELED** | `npm run deploy:dry` → `results/deploy-cost-estimate.json`: live `eth_estimateGas` where the node can dry-run, a calibrated model for calls into contracts that do not exist yet |
| BNB Chain finality takes 42–44 headers, about 19–20 s | **MODELED** | header counts from `results/rehearsal-parlia.json` × 0.45 s block time |
| Time to funds both ways, canonical and fast | **NOT-CLAIMED** | not deployed yet |
| Bridges held by a handful of keys lost about $806M in three incidents: Ronin, Harmony Horizon, Orbit Chain | **VERIFIED-LIVE** | public post-mortems and analyses, linked in the README |
<!-- /render:claims -->

## Not claimed

- **Not audited.** No third party has reviewed the contracts. Do not put real value through them.
- **No mainnet.** Testnets only: Portaldot V3 testnet (chain id 420420777) and BNB Chain testnet (chain id 97).
- **BSC's BLS fast-finality votes are not verified.** Portaldot has no BLS12-381 precompile, so the Parlia client checks the validators' ECDSA seals with the same two-thirds threshold instead.
- **Portaldot's validators are trusted.** The testnet has 2 BEEFY validators. If both sign something false, the BEEFY client accepts it; that is what any light client of a 2-validator chain inherits.
- **Portaldot's sudo key is trusted.** It can change the runtime, and with it what the chain finalizes.
- **The checkpoints are trusted.** Each light client starts from the validator set it was deployed with.
- **BSC's validators are trusted for 7 days at a time.** Two thirds of the last proven set must stay honest for the trusting period after it was proven.
- **No censorship resistance beyond "anyone can relay".** If nobody runs a relayer, transfers wait. They cannot be stolen or forged while waiting.
- **No guaranteed fast fill.** Fast fills happen only when a solver or a vault has liquidity and accepts the fee.
- **No upgrade path.** If a light client halts, a new deployment replaces it. Funds already finalized are unaffected; funds locked after a halt stay in the old gateway.
