# Proof: every contract and transaction

Rendered by `npm run docs` from `deployments/portaldot.json`, `deployments/bsc.json`, `results/live-transfers.json` and `results/attacks.json`. Nothing here is typed by hand; where a file does not exist yet, the section says so.

BNB Chain links go to [testnet.bscscan.com](https://testnet.bscscan.com). The Portaldot testnet explorer ([scanner-testnet-v3.portaldot.dev](https://scanner-testnet-v3.portaldot.dev)) indexes Substrate blocks, not EVM transaction hashes, so a Portaldot transaction is shown with its hash and a link to its block.

To re-check any transfer below without trusting this page: `npx tsx packages/sdk/scripts/verify-onchain.ts <source tx>`.

<!-- render:status -->
**Status, 2026-11-03 20:22 UTC:** built, tested and rehearsed against live data from both chains; **not deployed yet** on the testnets (the deployer wallets are waiting for testnet funds). Every on-chain link in these docs comes from `deployments/*.json` and reads "not deployed yet" until those files exist.
<!-- /render:status -->

## Contracts

<!-- render:proof-contracts -->
### Portaldot V3 testnet (chain id 420420777)

not deployed yet: `deployments/portaldot.json` does not exist yet.

### BNB Chain testnet (chain id 97)

not deployed yet: `deployments/bsc.json` does not exist yet.
<!-- /render:proof-contracts -->

## Transfers, both ways

<!-- render:proof-transfers -->
not deployed yet: no transfers recorded (`results/live-transfers.json` is written by `packages/sdk/scripts/record-live.ts` after the deploy).
<!-- /render:proof-transfers -->

## Forged proofs against the deployed contracts

<!-- render:proof-attacks -->
not deployed yet: the attack lab runs against the deployed contracts.
<!-- /render:proof-attacks -->

## Forged proofs in the rehearsals

<!-- render:proof-rehearsals -->
Local rehearsals on 2026-11-03 17:30 UTC (BEEFY: anvil fork of BSC testnet, live Portaldot V3 testnet data) and 2026-11-03 17:23 UTC (Parlia: local anvil node standing in for Portaldot, live BSC testnet data). These are local, not testnet transactions.

| Attack | Target | Result |
| --- | --- | --- |
| Forged BEEFY signature | `PortaldotLightClient.submitCommitment` | rejected: `InvalidSignature(0)` |
| Commitment signed by a stale validator set | `PortaldotLightClient.submitCommitment` | rejected: `UnknownValidatorSet(503, 520)` |
| MMR proof for the wrong leaf | `PortaldotLightClient.importHeader` | rejected: `HeaderNotInMmr` |
| Header that does not hash to its leaf | `PortaldotLightClient.importHeader` | rejected: `HeaderNotInMmr` |
| Tampered storage value | `PortaldotVerifier.verifyCommitment` | rejected: the verifier returned false |
| Replayed transfer | `BscGateway.finalize` | not fired: needs a finalized transfer on deployed gateways; covered by `contracts/test/core/Gateways.t.sol::test_finalizeTwiceReverts` |
| Refund for a filled order | `PortaldotVerifier.verifyAbsence` | rejected: the verifier returned false |
| BSC header sealed by a non-validator | `ParliaClient.submitWindow` | rejected: `BrokenLink(140612766)` |
| Window with fewer than 2/3 distinct sealers | `ParliaClient.submitWindow` | rejected: `TooFewSigners(5, 6)` |
| Receipt proof for a log that is not there | `BscVerifier.verifyCommitment` | rejected: `LogIndexOutOfRange(67, 8)` |
| Solver claim for an unfilled order | `OriginSettler.settle` | rejected: `InvalidProof` |
| BNB.b release beyond what was locked | `PortaldotGateway.finalize` | rejected: `InvalidProof` |
<!-- /render:proof-rehearsals -->
