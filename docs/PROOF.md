# Proof: every contract and transaction

Rendered by `npm run docs` from `deployments/portaldot.json`, `deployments/bsc.json`, `results/live-transfers.json` and `results/attacks.json`. Nothing here is typed by hand; where a file does not exist yet, the section says so.

BNB Chain links go to [testnet.bscscan.com](https://testnet.bscscan.com). The Portaldot testnet explorer ([scanner-testnet-v3.portaldot.dev](https://scanner-testnet-v3.portaldot.dev)) indexes Substrate blocks, not EVM transaction hashes, so a Portaldot transaction is shown with its hash and a link to its block.

To re-check any transfer below without trusting this page: `npx tsx packages/sdk/scripts/verify-onchain.ts <source tx>`.

<!-- render:status -->
**Status, 2026-11-05 22:22 UTC:** deployed, 2 contracts on Portaldot V3 testnet and 8 on BNB Chain testnet; 2 proven transfers and 0 fast fills recorded. Every address and transaction: [docs/PROOF.md](PROOF.md).
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

| Contract | Address | Deploy transaction | Code | Source |
| --- | --- | --- | --- | --- |
| Outbox | [`0x788eb8bd959A995EA980E0477d5CBAD650bd09d5`](https://testnet.bscscan.com/address/0x788eb8bd959A995EA980E0477d5CBAD650bd09d5) | [`0xf57cf0…d1deb0`](https://testnet.bscscan.com/tx/0xf57cf01218404e5fd4db24939aa830d380d28905f96c0912d5975a98cbd1deb0) | 454 B | [verified](https://repo.sourcify.dev/97/0x788eb8bd959A995EA980E0477d5CBAD650bd09d5) |
| PortaldotLightClient | [`0x4a832A5EC6045FdCF9Ef5B448128fE07d21723F3`](https://testnet.bscscan.com/address/0x4a832A5EC6045FdCF9Ef5B448128fE07d21723F3) | [`0xf23320…92b9c5`](https://testnet.bscscan.com/tx/0xf233204e6b8bc3eeed3d623aff00414604bb4b5a98a1b157833c53666e92b9c5) | 12,510 B | [verified](https://repo.sourcify.dev/97/0x4a832A5EC6045FdCF9Ef5B448128fE07d21723F3) |
| PortaldotVerifier | [`0x10012862AB2f1325Bb3667EC49fC35172d0F3a51`](https://testnet.bscscan.com/address/0x10012862AB2f1325Bb3667EC49fC35172d0F3a51) | [`0x5adcfd…c062e8`](https://testnet.bscscan.com/tx/0x5adcfd40fcbe749824d6e9acc8cbddbf44355d689a3a78ddf3e84469e5c062e8) | 9,316 B | [verified](https://repo.sourcify.dev/97/0x10012862AB2f1325Bb3667EC49fC35172d0F3a51) |
| PPOT | [`0x188b132f9b54008a2208552f38638EdE9DEa594D`](https://testnet.bscscan.com/address/0x188b132f9b54008a2208552f38638EdE9DEa594D) | [`0x45f09c…4b7502`](https://testnet.bscscan.com/tx/0x45f09ce6ae3fe849a5cfd12d4189bf86f56996c294d69e4a2b2975f2b64b7502) | 2,057 B | [verified](https://repo.sourcify.dev/97/0x188b132f9b54008a2208552f38638EdE9DEa594D) |
| BscGateway | [`0xb05f345f2FBFeb891985D729aFF6C09A13f5daeB`](https://testnet.bscscan.com/address/0xb05f345f2FBFeb891985D729aFF6C09A13f5daeB) | [`0x454b2b…20bbad`](https://testnet.bscscan.com/tx/0x454b2b065e1377771848f0ce79c82e524cae4ae3c5b38b9679db5dcd9220bbad) | 2,895 B | [verified](https://repo.sourcify.dev/97/0xb05f345f2FBFeb891985D729aFF6C09A13f5daeB) |
| OriginSettler | [`0x296DB40A17178d7ea1533fBeaC4D5EB4529519e2`](https://testnet.bscscan.com/address/0x296DB40A17178d7ea1533fBeaC4D5EB4529519e2) | [`0x2e3fdf…8abbef`](https://testnet.bscscan.com/tx/0x2e3fdf333051b07efe656ace1315ff388e56561af4b361918e00e5aca08abbef) | 5,036 B | [verified](https://repo.sourcify.dev/97/0x296DB40A17178d7ea1533fBeaC4D5EB4529519e2) |
| DestinationSettler | [`0x2cAeA09D2B2b8E8f5068aEF20cc92058ccf38f5f`](https://testnet.bscscan.com/address/0x2cAeA09D2B2b8E8f5068aEF20cc92058ccf38f5f) | [`0x6e5642…710ee9`](https://testnet.bscscan.com/tx/0x6e5642d76e3286f887ea23e67f75308c663fde04bfe86ddb9e175e278b710ee9) | 1,876 B | [verified](https://repo.sourcify.dev/97/0x2cAeA09D2B2b8E8f5068aEF20cc92058ccf38f5f) |
| PpotVault | [`0xe88790CF3a8c3669eE0D7a5c7F997b7D4CdD8838`](https://testnet.bscscan.com/address/0xe88790CF3a8c3669eE0D7a5c7F997b7D4CdD8838) | [`0x05b075…8b668b`](https://testnet.bscscan.com/tx/0x05b075cc06c8345351bec8e81bc13fe3852b06e8c610f1765b76259dfe8b668b) | 5,998 B | [verified](https://repo.sourcify.dev/97/0xe88790CF3a8c3669eE0D7a5c7F997b7D4CdD8838) |

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

`portaldot:1`: 0.9990 tPOT, 46 s from lock to payout.

| Step | Chain | Transaction | At | Detail |
| --- | --- | --- | --- | --- |
| locked | Portaldot V3 testnet | `0xddc0cafb8bba236cd4d62941c32024a037f00606587801c4b96a3ecfbbc6fb3d` ([block 319,008](https://scanner-testnet-v3.portaldot.dev/#/blocks/319008)) | 2026-11-04 10:18 UTC |  |
| beefy | BNB Chain testnet | [`0x9b9cdedfdbad2ec9e31dd1f0f90aab09408f18eb951b89ed7057adfd064ffb3c`](https://testnet.bscscan.com/tx/0x9b9cdedfdbad2ec9e31dd1f0f90aab09408f18eb951b89ed7057adfd064ffb3c) | 2026-11-04 10:19 UTC | Portaldot header 319009 proven on BSC |
| beefy | BNB Chain testnet | [`0x054d8d956b7430067aca3e8671eb06090bd5c5508e3c98da75096e89289f88d4`](https://testnet.bscscan.com/tx/0x054d8d956b7430067aca3e8671eb06090bd5c5508e3c98da75096e89289f88d4) | 2026-11-04 10:19 UTC | Portaldot header 319009 proven on BSC |
| beefy | BNB Chain testnet | [`0x123609deabb08047e22be88f8c6b4c7a3979506575ff419dacf1e4f4f22fc0c6`](https://testnet.bscscan.com/tx/0x123609deabb08047e22be88f8c6b4c7a3979506575ff419dacf1e4f4f22fc0c6) | 2026-11-04 10:19 UTC | Portaldot header 319009 proven on BSC |
| finalized | BNB Chain testnet | [`0xb7c177b293edfc0837696871a4f3f935cc52693c1fc349d5fd5cfdd30c2abcf2`](https://testnet.bscscan.com/tx/0xb7c177b293edfc0837696871a4f3f935cc52693c1fc349d5fd5cfdd30c2abcf2) | 2026-11-04 10:19 UTC |  |

### BNB Chain testnet → Portaldot V3 testnet

not measured yet: no finalized transfer in this direction yet.

2 more jobs in [results/live-transfers.json](../results/live-transfers.json), recorded 2026-11-05 22:22 UTC.
<!-- /render:proof-transfers -->

### BNB Chain → Portaldot (on a fork of the V3 testnet)

<!-- render:proof-fork-reverse -->
ParliaClient and BscVerifier are not on the live testnet yet: together they need ~948 tPOT of storage deposit the deployer does not have. So this direction ran against a [Chopsticks](https://github.com/AcalaNetwork/chopsticks) fork of the V3 testnet at block 340,402 (`0x647fee7aebe1dd0efa927b723c835b45d4106c83ef139d04be709eeeff4efdc8`, the same hash on the live chain): the deployed PortaldotGateway, its code and its escrow are the live ones, unmodified. The burn, the BSC headers, their seals and the receipt proof are real BNB Chain testnet data. The only state set by hand on the fork: the deployer's and the relayer's free balance (to pay that deposit), and the transaction-storage retention period (Chopsticks cannot supply that pallet's storage-proof inherent, so its blocks would not build otherwise). Recorded 2026-11-05 22:15 UTC; rerun with `npx tsx packages/sdk/scripts/fork-reverse.ts --env <file> --burn-tx 0x391e7436ec98e3ef2b71ccac1750c6d14019e3d298ac9a29e58677eb75c31e28` against a fresh fork.

| Step | Chain | Transaction | Detail |
| --- | --- | --- | --- |
| burn | BNB Chain testnet | [`0x391e7436ec98e3ef2b71ccac1750c6d14019e3d298ac9a29e58677eb75c31e28`](https://testnet.bscscan.com/tx/0x391e7436ec98e3ef2b71ccac1750c6d14019e3d298ac9a29e58677eb75c31e28) | `burnPPOT`: 0.50 pPOT to 0xaA3b93a16647e193C74200F9178378454fDc3876, transfer nonce 0, block 141,034,970 |
| deploy ParliaClient | fork of Portaldot V3 testnet | `0x4e80394db33d3ae40ce23bbd0f98324529fd9e896f5f9ad2284de05e786b59e6` (fork block 340,403) | deployer nonce 4 → 0xb05f345f2FBFeb891985D729aFF6C09A13f5daeB, checkpoint epoch 141,034,000 (9 validators) |
| deploy BscVerifier | fork of Portaldot V3 testnet | `0x1497ba78923183434ee09275446e74ab9a013f7f434ee430cc97c7423a639f49` (fork block 340,404) | deployer nonce 5 → 0x30cc25b79b28b7d482200C6e86c9b828E4958d53, the verifier PortaldotGateway was deployed with |
| window | fork of Portaldot V3 testnet | `0x4efdb186073d778c0d0cb9a064b0ee18ecc5016033a99cc340e14a26638521f1` (fork block 340,405) | `ParliaClient.submitWindow`: 39 real BSC headers from 141,034,970, 6 distinct trusted sealers (quorum 6 of 9) |
| tampered | fork of Portaldot V3 testnet | `0xc26f1ade061636069d2b2b30dbc61d579d799fc55eb2dd55dd1d4a8ba297588d` (fork block 340,406) | `PortaldotGateway.finalize` with one byte flipped in the receipt (leaf node of the receipts trie, byte 769 of 777): reverted with `IncompleteProof()`, transfer still open |
| finalize | fork of Portaldot V3 testnet | `0x87ee0564ab3aef5fa1f4771b62b8f5f39d57bdbc16c9c6fe55178ffb3d485cb0` (fork block 340,407) | `PortaldotGateway.finalize` with the genuine 2-node receipt proof: `Finalized` emitted, 0xaA3b93a16647e193C74200F9178378454fDc3876 +0.5000 tPOT, lockedPOT 1.998 → 1.498; a replay reverts with `AlreadyFinalized(0)` |
<!-- /render:proof-fork-reverse -->

## Forged proofs against the deployed contracts

<!-- render:proof-attacks -->
Recorded 2026-11-05 22:22 UTC from https://35-205-62-150.sslip.io: 7 of 7 rejected.

| Attack | Target | Rejected with | Reverted transaction |
| --- | --- | --- | --- |
| Forged BEEFY signature | `PortaldotLightClient.submitCommitment` | `InvalidSignature(0)` | eth_call only |
| Commitment signed by a stale validator set | `PortaldotLightClient.submitCommitment` | `UnknownValidatorSet(572, 573)` | eth_call only |
| MMR proof for the wrong leaf | `PortaldotLightClient.importHeader` | `HeaderNotInMmr` | eth_call only |
| Header that does not hash to its leaf | `PortaldotLightClient.importHeader` | `HeaderNotInMmr` | eth_call only |
| Tampered storage value | `PortaldotVerifier.verifyCommitment` | `false` | eth_call only |
| Replayed transfer | `BscGateway.finalize` | `AlreadyFinalized(1)` | eth_call only |
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
