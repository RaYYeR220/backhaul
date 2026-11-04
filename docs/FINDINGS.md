# Findings on Portaldot V3

Things we ran into while building a bridge on Portaldot V3, written for the Portaldot team and for the next builder who needs BEEFY, MMR proofs or contract storage proofs. Each item says what we saw, how to check it, what Backhaul does about it and what would fix it.

<!-- render:findings -->
Last checked 2026-11-03 20:00 UTC with `npm run findings` → [results/findings.json](../results/findings.json):

- `mmr_generateProof` on `https://test-node-v3.portaldot.dev` for block 310,003: `Leaf was not found (LeafNotFound)`; `mmr_root` answers.
- `mmr_generateProof` on `https://live-v3-node.portaldot.dev` for block 922,096: `Leaf was not found (LeafNotFound)`; `mmr_root` answers.
- `eth_getBlockByNumber` on `https://test-evm-rpc-v3.portaldot.dev`: 6 of 6 recent blocks with transactions report `stateRoot == transactionsRoot` (blocks 310,394, 310,393, 310,392, 310,391, 310,390, 310,389).
<!-- /render:findings -->

## 1. The public nodes can't serve MMR proofs

**What we saw.** `mmr_generateProof` returns error 8011, `Leaf was not found (LeafNotFound)`, for every block we asked about, on both `test-node-v3.portaldot.dev` and `live-v3-node.portaldot.dev`. `mmr_root` answers normally.

**Why it matters.** pallet-mmr keeps its leaves and inner nodes in the node's offchain database, and only writes them there when the node runs with offchain indexing enabled. The RPC reads from that database. A BEEFY light client needs one MMR proof per header it imports, so with the public RPC alone, nobody can use BEEFY to bridge out of Portaldot.

**What Backhaul does.** Every leaf can be rebuilt from block hashes, so the SDK builds the proofs itself (`packages/sdk/src/portaldot/mmr.ts`):

- **Leaf format.** Portaldot's runtime uses `ParentNumberAndHash` as its MMR leaf data, not BEEFY's `MmrLeaf`. The leaf appended while block `n` executes is `keccak256(SCALE(u32 n − 1, H256 hash(n − 1)))`, with the number as 4 little-endian bytes. Leaf index `i` therefore commits to the hash of block `i`. The leaves carry no authority-set data, so validator-set handoffs are proven from `Beefy::NextAuthorities` storage instead.
- **Tree.** The ckb Merkle Mountain Range layout that pallet-mmr uses: two nodes merge as `keccak256(left ‖ right)`, and the mountains follow the set bits of the leaf count, highest first.
- **Root.** The peaks are bagged right to left: start from the right-most peak and fold leftwards with `acc = keccak256(acc ‖ peak)`. The right-hand side comes first in each hash, which is easy to get backwards.
- **Cross-check.** The SDK fetches block hashes 1,000 per `chain_getBlockHash` request, caches them on disk, and checks the root it computes against the chain's own `Mmr::RootHash` and `Mmr::NumberOfLeaves` before it uses a proof. The light client then checks each proof against the MMR root the BEEFY validators signed.

**What would fix it.** Run the public RPC nodes with `--enable-offchain-indexing true`. Blocks imported before the flag was set would stay missing until the node re-imports them.

**Justifications, for comparison, are kept for past sessions.** `test-node-v3` still serves non-mandatory BEEFY justifications, one every 8 blocks, for past sessions: at least about 23 sessions (a day) back when we checked. A relayer that missed a whole session can still fetch an in-session commitment afterwards and rotate the BEEFY client with it, for about that long; ours archives every justification it sees anyway.

## 2. pallet-revive's Ethereum blocks report `stateRoot` equal to `transactionsRoot`

**What we saw.** On the testnet EVM RPC, `eth_getBlockByNumber` returns the same value for `stateRoot` and `transactionsRoot` on every block with transactions we checked (the block numbers are listed above). On empty blocks, all three roots are the empty-trie root `0x56e8…b421`.

**Why it matters.** Tools that check `eth_getProof` results against a block's `stateRoot` (Ethereum light clients, bridges, storage-proof oracles) will reject every proof, or check against the wrong root without noticing. Portaldot's state is not an Ethereum Merkle-Patricia trie in the first place: revive keeps each contract's storage in a Substrate child trie.

**What Backhaul does.** It never reads the Ethereum block's `stateRoot`. Portaldot contract storage is proven with Substrate read proofs (`state_getReadProof`, then `state_getChildReadProof` for the contract's child trie) against the state root of a Substrate header the BEEFY light client imported.

**What would help.** Document that the field is not a state root, or return a value that cannot be mistaken for one, so that tools fail loudly instead of silently.

## 3. Reported privately

We reported an RPC configuration issue on the public nodes to the team privately.

## 4. What deploying on Portaldot costs, for builders

Storage deposits dominate everything else on Portaldot: code and every new storage slot are paid for up front, and execution weight hardly shows. We measured the prices before writing the Portaldot-side contracts, because they decide the design.

<!-- render:deploy-costs -->
Measured 2026-11-03 23:58 UTC on the Portaldot V3 testnet (gas price 22,870), by `calibratePortaldot` in `packages/sdk/src/deploy/cost.ts`: live `eth_estimateGas` of tiny probe deployments that differ in one thing (1 vs 1,001 bytes of code, 0 vs 1 storage slot, 0 vs 10,000 bytes of calldata). pallet-revive's estimate includes the storage deposit, so each difference is that item's full price.

| Item | Cost | Note |
| --- | --- | --- |
| Code, fresh code hash | 0.0836 tPOT per byte (83.6 tPOT per KB) | A deposit, returned when the code is removed. With the deploy base, a 515-byte contract costs 52.16 tPOT, about 0.1 tPOT per byte |
| Code already stored under the same hash | 0.0184 tPOT per byte | revive keeps code once per hash; immutables change the hash |
| Deploy base | 9.08 tPOT | Any deployment |
| One new storage slot | 3.90 tPOT | Each Outbox commitment, order status or ring slot pays this once |
| Transaction length | 0.0001 tPOT per byte (0.10 tPOT per KB) | A 46.0 kB Parlia window pays about 4.67 tPOT in length fees alone |
| Plain call | 0.0123 tPOT | Execution weight is small next to the deposits |

Chain constants read the same day: pallet-revive and pallet-contracts both charge DepositPerByte 0.06 tPOT and DepositPerItem 0.15 tPOT; pallet-contracts adds a code-hash lockup of 30.00%. The probe prices above are what transactions actually pay on top of those constants.

What that means for a full Backhaul deployment: 3,138 tPOT + 0.0112 tBNB (2,605 tPOT + 0.0011 tBNB without the BNB LP vaults, 4,940 tPOT + 0.0112 tBNB with the data feed and the ink! twin). Parlia windows cost 20.30 tPOT while they fill a fresh ring slot and 4.69 tPOT once the 256-slot ring is warm. That is why the Parlia client verifies windows on demand with a trusting period instead of following every BSC epoch.
<!-- /render:deploy-costs -->

How we designed around it, in case it helps:

- **Build for size.** The Portaldot contracts are compiled with a size profile (`optimizer_runs = 1`, no CBOR metadata; `[profile.portaldot]` in `contracts/foundry.toml`). Every byte of code is a deposit.
- **Write once, overwrite in place.** A new storage slot costs as much as tens of kilobytes of calldata. The Parlia client keeps its finalized headers in a fixed 256-slot ring, so after warm-up a new header overwrites a slot instead of adding one.
- **Verify on demand.** A finality window is tens of kilobytes, so its length fee adds up. The Parlia client skips epochs within a 14-day trusting period instead of following every BSC epoch, and windows are sent only when a transfer needs one.
- **Code is stored once per hash.** Two deployments of identical code share it at the lower rate, but different immutables make different code, so they don't.
- **Measure, then deploy.** `npm run deploy:dry` prices every transaction of the plan against the live chain before any money moves.
