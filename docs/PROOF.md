# Proof: every contract and transaction

Rendered by `npm run docs` from `deployments/portaldot.json`, `deployments/bsc.json`, `results/live-transfers.json` and `results/attacks.json`. Nothing here is typed by hand; where a file does not exist yet, the section says so.

BNB Chain links go to [testnet.bscscan.com](https://testnet.bscscan.com). The Portaldot testnet explorer ([scanner-testnet-v3.portaldot.dev](https://scanner-testnet-v3.portaldot.dev)) indexes Substrate blocks, not EVM transaction hashes, so a Portaldot transaction is shown with its hash and a link to its block.

To re-check any transfer below without trusting this page: `npx tsx packages/sdk/scripts/verify-onchain.ts <source tx>`.

<!-- render:status -->
**Status, 2026-11-04 09:39 UTC:** deployed, 2 contracts on Portaldot V3 testnet and 8 on BNB Chain testnet; 1 proven transfer and 0 fast fills recorded. Every address and transaction: [docs/PROOF.md](PROOF.md).
<!-- /render:status -->

## Contracts

<!-- render:proof-contracts -->
### Portaldot V3 testnet (chain id 420420777)

| Contract | Address | Deploy transaction | Code |
| --- | --- | --- | --- |
| Outbox | [`0x788eb8bd959A995EA980E0477d5CBAD650bd09d5`](https://scanner-testnet-v3.portaldot.dev/#/accounts/0x788eb8bd959a995ea980e0477d5cbad650bd09d5eeeeeeeeeeeeeeeeeeeeeeee) | `0x63be19…807e96` ([block 318,529](https://scanner-testnet-v3.portaldot.dev/#/blocks/318529)) | 399 B |
| PortaldotGateway | [`0x4a832A5EC6045FdCF9Ef5B448128fE07d21723F3`](https://scanner-testnet-v3.portaldot.dev/#/accounts/0x4a832a5ec6045fdcf9ef5b448128fe07d21723f3eeeeeeeeeeeeeeeeeeeeeeee) | `0x5ca6bd…3044ae` ([block 318,530](https://scanner-testnet-v3.portaldot.dev/#/blocks/318530)) | 3,218 B |

BNB.b: pallet-assets asset 9797, ERC-20 precompile [`0x0000264500000000000000000000000000010000`](https://scanner-testnet-v3.portaldot.dev/#/accounts/0x0000264500000000000000000000000000010000eeeeeeeeeeeeeeeeeeeeeeee).

Wiring and seeding:

| Step | Transaction |
| --- | --- |
| PortaldotGateway.setRemote | `0x5f9ca7…618f39` ([block 318,542](https://scanner-testnet-v3.portaldot.dev/#/blocks/318542)) |
| fund.relayer | `0xd9ab98…513751` ([block 318,543](https://scanner-testnet-v3.portaldot.dev/#/blocks/318543)) |

### BNB Chain testnet (chain id 97)

| Contract | Address | Deploy transaction | Code |
| --- | --- | --- | --- |
| Outbox | [`0x788eb8bd959A995EA980E0477d5CBAD650bd09d5`](https://testnet.bscscan.com/address/0x788eb8bd959A995EA980E0477d5CBAD650bd09d5) | [`0xf57cf0…d1deb0`](https://testnet.bscscan.com/tx/0xf57cf01218404e5fd4db24939aa830d380d28905f96c0912d5975a98cbd1deb0) | 454 B |
| PortaldotLightClient | [`0x4a832A5EC6045FdCF9Ef5B448128fE07d21723F3`](https://testnet.bscscan.com/address/0x4a832A5EC6045FdCF9Ef5B448128fE07d21723F3) | [`0xf23320…92b9c5`](https://testnet.bscscan.com/tx/0xf233204e6b8bc3eeed3d623aff00414604bb4b5a98a1b157833c53666e92b9c5) | 12,510 B |
| PortaldotVerifier | [`0x10012862AB2f1325Bb3667EC49fC35172d0F3a51`](https://testnet.bscscan.com/address/0x10012862AB2f1325Bb3667EC49fC35172d0F3a51) | [`0x5adcfd…c062e8`](https://testnet.bscscan.com/tx/0x5adcfd40fcbe749824d6e9acc8cbddbf44355d689a3a78ddf3e84469e5c062e8) | 9,316 B |
| PPOT | [`0x188b132f9b54008a2208552f38638EdE9DEa594D`](https://testnet.bscscan.com/address/0x188b132f9b54008a2208552f38638EdE9DEa594D) | [`0x45f09c…4b7502`](https://testnet.bscscan.com/tx/0x45f09ce6ae3fe849a5cfd12d4189bf86f56996c294d69e4a2b2975f2b64b7502) | 2,057 B |
| BscGateway | [`0xb05f345f2FBFeb891985D729aFF6C09A13f5daeB`](https://testnet.bscscan.com/address/0xb05f345f2FBFeb891985D729aFF6C09A13f5daeB) | [`0x454b2b…20bbad`](https://testnet.bscscan.com/tx/0x454b2b065e1377771848f0ce79c82e524cae4ae3c5b38b9679db5dcd9220bbad) | 2,895 B |
| OriginSettler | [`0x296DB40A17178d7ea1533fBeaC4D5EB4529519e2`](https://testnet.bscscan.com/address/0x296DB40A17178d7ea1533fBeaC4D5EB4529519e2) | [`0x2e3fdf…8abbef`](https://testnet.bscscan.com/tx/0x2e3fdf333051b07efe656ace1315ff388e56561af4b361918e00e5aca08abbef) | 5,036 B |
| DestinationSettler | [`0x2cAeA09D2B2b8E8f5068aEF20cc92058ccf38f5f`](https://testnet.bscscan.com/address/0x2cAeA09D2B2b8E8f5068aEF20cc92058ccf38f5f) | [`0x6e5642…710ee9`](https://testnet.bscscan.com/tx/0x6e5642d76e3286f887ea23e67f75308c663fde04bfe86ddb9e175e278b710ee9) | 1,876 B |
| PpotVault | [`0xe88790CF3a8c3669eE0D7a5c7F997b7D4CdD8838`](https://testnet.bscscan.com/address/0xe88790CF3a8c3669eE0D7a5c7F997b7D4CdD8838) | [`0x05b075…8b668b`](https://testnet.bscscan.com/tx/0x05b075cc06c8345351bec8e81bc13fe3852b06e8c610f1765b76259dfe8b668b) | 5,998 B |

Wiring and seeding:

| Step | Transaction |
| --- | --- |
| BscGateway.setRemote | [`0x06f137…8d0f0d`](https://testnet.bscscan.com/tx/0x06f13713dc20fc5349eef715257b095f8931537e8c485e59416905f5158d0f0d) |
| fund.relayer.bsc | [`0x23b4e8…6536c3`](https://testnet.bscscan.com/tx/0x23b4e8665624ccdb469cc8031c92e8efb4c35c38abec3ae34a220144c26536c3) |
| PortaldotVerifier.bindTrieId | [`0xe6e9f7…60060b`](https://testnet.bscscan.com/tx/0xe6e9f7de6f197d7567598cb42e68968b70bf2ef1350923dfba150d0b5260060b) |
<!-- /render:proof-contracts -->

## Transfers, both ways

<!-- render:proof-transfers -->
### Portaldot V3 testnet → BNB Chain testnet

`portaldot:0`: 0.9990 tPOT, 40 s from lock to payout.

| Step | Chain | Transaction | At | Detail |
| --- | --- | --- | --- | --- |
| locked | Portaldot V3 testnet | `0xe91cf0dd49c50deae2f9db19f0d46d87e0a4be8cd29e101bb8b34100a0bacf30` ([block 318,574](https://scanner-testnet-v3.portaldot.dev/#/blocks/318574)) | 2026-11-04 09:35 UTC |  |
| beefy | BNB Chain testnet | [`0x532abe5c375b32482cfcede49fad2c2e6cf4608142eabcf1033d35a87a10eb78`](https://testnet.bscscan.com/tx/0x532abe5c375b32482cfcede49fad2c2e6cf4608142eabcf1033d35a87a10eb78) | 2026-11-04 09:35 UTC | Portaldot header 318574 proven on BSC |
| beefy | BNB Chain testnet | [`0x178a6fd65f855628225cbcc0011b88020710089e2eaa98b29ee4e04b947a8d51`](https://testnet.bscscan.com/tx/0x178a6fd65f855628225cbcc0011b88020710089e2eaa98b29ee4e04b947a8d51) | 2026-11-04 09:35 UTC | Portaldot header 318574 proven on BSC |
| finalized | BNB Chain testnet | [`0xea9874bdeb4b6d1cb4b22faa99e887d28156e20ce14897b8dc58e1ff6c6a3f78`](https://testnet.bscscan.com/tx/0xea9874bdeb4b6d1cb4b22faa99e887d28156e20ce14897b8dc58e1ff6c6a3f78) | 2026-11-04 09:35 UTC |  |

### BNB Chain testnet → Portaldot V3 testnet

not measured yet: no finalized transfer in this direction yet.
<!-- /render:proof-transfers -->

## Forged proofs against the deployed contracts

<!-- render:proof-attacks -->
Recorded 2026-11-04 09:39 UTC from https://35-205-62-150.sslip.io: 6 of 6 rejected.

| Attack | Target | Rejected with | Reverted transaction |
| --- | --- | --- | --- |
| Forged BEEFY signature | `PortaldotLightClient.submitCommitment` | `InvalidSignature(0)` | eth_call only |
| MMR proof for the wrong leaf | `PortaldotLightClient.importHeader` | `HeaderNotInMmr` | eth_call only |
| Header that does not hash to its leaf | `PortaldotLightClient.importHeader` | `HeaderNotInMmr` | eth_call only |
| Tampered storage value | `PortaldotVerifier.verifyCommitment` | `false` | eth_call only |
| Replayed transfer | `BscGateway.finalize` | `AlreadyFinalized(0)` | eth_call only |
| Refund for a filled order | `PortaldotVerifier.verifyAbsence` | `false` | eth_call only |
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
