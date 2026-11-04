# What Backhaul trusts, and what it doesn't

Backhaul moves value between Portaldot V3 and BNB Chain. Each direction releases funds only against a proof of the other chain's finalized state, which a contract checks. No relayer, solver, operator, server or key held by us can release funds or forge a message. This page lists, for each direction, exactly what that proof rests on.

## Not trusted, in either direction

- **Relayers.** Anyone can carry proofs. A relayer that stops can delay delivery; it cannot change what a contract accepts.
- **Solvers.** A solver pays you first, with its own money, and is repaid only after the light client proves the fill. A solver that lies is never repaid.
- **The LP vaults.** A vault fills an order only with a proof that the order was opened on the origin chain. There is no operator key. Fees vest over 6 hours, so capital that joins just before a repayment lands, and leaves just after, gets none of it.
- **Us.** No contract has an owner, an admin, a pause switch or an upgrade path. The only privileged call is a one-time wiring step (`setRemote`), made once at deployment and then locked forever.

## BNB Chain → Portaldot: a Parlia light client on Portaldot

`ParliaClient` runs on Portaldot's EVM (pallet-revive) and follows BNB Chain's finality from the validators' own seals.

- Every BNB Chain header carries its sealer's ECDSA signature over the header. The client recovers it on-chain and checks it against the validator set it trusts.
- A block is final once a window of headers built on it carries seals from **at least ⌈2N/3⌉ distinct trusted validators** (6 of 9 on the testnet). This is the same two-thirds honesty threshold BNB Chain's own fast finality uses.
- Validator sets come from BNB Chain's epoch blocks. A new set takes effect at the height BNB Chain itself switches, `E + (⌊N/2⌋+1) · turnLength`, matching `consensus/parlia/snapshot.go`. When the client skips epochs it computes that height from the set it trusts, which matches BNB Chain as long as the set's size and turn length did not change in the skipped epochs. The relayer submits the epoch that changed them before any later one. Skipping past it anyway can make windows fail or record the wrong first height for the new set, but never makes a window pass that two thirds of the trusted set did not seal.
- Like IBC and Tendermint light clients, the client can skip epochs, within a **14-day trusting period** counted on both clocks. A window's first header must be stamped within 14 days of the trusted set's epoch block, and the window must land on Portaldot within 14 days of the moment the client installed that set (by Portaldot's own `block.timestamp`). Header timestamps are signed by the very validators being trusted, so it is Portaldot's clock that makes a stale set's keys worthless after two weeks.
- Messages and transfers are proven with Ethereum receipt proofs against the `receiptsRoot` of the block that emitted them, or with a storage proof of the same Outbox slot against the `stateRoot` of any later finalized block. The Outbox is write-once, so a commitment never stops being provable, whatever happens to the block it was emitted in. Refunds and data reads use account and storage proofs against `stateRoot`.

**Trusted:** that at least two thirds of each BNB Chain validator set the client installs stay honest for 14 days after it was installed, and the checkpoint the client was deployed with.

**Not checked:** BNB Chain's BLS fast-finality votes. Portaldot's EVM has no BLS12-381 precompile, so the client relies on the validators' ECDSA seals instead.

## Portaldot → BNB Chain: a BEEFY light client on BNB Chain

`PortaldotLightClient` runs on BNB Chain and follows BEEFY, Portaldot's finality gadget built for bridges.

- Portaldot's BEEFY authorities sign commitments to a Merkle Mountain Range (MMR) root of all block hashes. The client recovers each secp256k1 signature on-chain. It requires `n − ⌊(n−1)/3⌋` of them: 2 of 2 on the testnet.
- A Portaldot header is accepted with an MMR proof against a signed root. Its BLAKE2b-256 hash is checked against the MMR leaf, and its state root is then used.
- Contract storage on Portaldot is proven with Substrate trie proofs: first the main trie, then the contract's child trie, both BLAKE2b-256.
- Authority-set handoffs, which happen every session, are proven from `Beefy::ValidatorSetId` and `Beefy::NextAuthorities` storage. Every handed-over key is checked to lie on the secp256k1 curve.

**Trusted:** Portaldot V3's validator set (2 validators on the testnet), the chain's sudo key, which can change its runtime, and the checkpoint the client was deployed with.

## Shared limits

- **Testnet only.** The contracts are not audited.
- **Liveness has deadlines.** The Parlia client must be moved to a newer trusted epoch at least once every 14 days; after that it accepts no window again, by design. The relayer does it every 3 days and alerts in `/status` when less than 5 days are left. The BEEFY client hands over to each new Portaldot authority set with a commitment signed during the outgoing session; Portaldot nodes keep those for past sessions too (one every 8 blocks, at least about a day back when checked on `test-node-v3`), and the relayer archives every one it sees, so only an outage longer than that would halt the Portaldot → BNB Chain direction.
- **Immutable by design.** If a light client ever stops accepting updates, for example after a validator-set change it can't follow, the fix is a new deployment. Transfers whose blocks the old client already finalized can still be completed. A transfer locked after the halt stays in the old gateway, and no one can move it. That is the cost of having no admin key, and we chose it on purpose. The light clients are tested against real past validator rotations of both chains to make a halt unlikely.
- **Vendored code.** The trie node decoding is adapted from polytope-labs/solidity-merkle-trees (Apache-2.0), changed to BLAKE2b-256 node hashing. The rest is in this repository.

## Compared with the alternatives

| | Custodial bridge | Multisig / committee bridge | Backhaul |
|---|---|---|---|
| Who can release your funds | The custodian | Any k of n key holders | Nobody. Only a valid proof of the other chain's finalized state |
| What a stolen key does | Everything | Everything, once k keys are taken | Nothing |
| What a stopped operator does | Freezes transfers | Freezes transfers | Delays them until anyone else relays |

Bridges secured by a handful of keys have lost about $806M in three incidents alone: Ronin (5 of 9 validator keys, $625M), Harmony Horizon (2 of 5 multisig, ~$100M) and Orbit Chain (7 of 10 multisig, $81.5M).
