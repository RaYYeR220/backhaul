# Backhaul

A bridge between Portaldot V3 and BNB Chain that trusts no one in either direction.

Each chain runs a light client of the other: a BEEFY light client of Portaldot on BNB Chain, and a Parlia light client of BNB Chain on Portaldot. Transfers and messages are released only against proofs of the other chain's finalized state, never against a signature from a relayer or a committee.

Work in progress for the Portaldot Hacker House 2026 (Multi-Chain & Cross-Chain Infra).

## Layout

| Path | What |
|---|---|
| `contracts/` | Solidity contracts (Foundry): light clients, verifiers, gateways, ERC-7683 settlers |
| `ink/` | ink! version of the BNB Chain light client for Portaldot's WASM contracts |
| `packages/sdk/` | TypeScript proof builders and clients |
| `services/relayer/` | Permissionless relayer and solver |
| `app/` | Web app |

## Third-party code

- [polytope-labs/solidity-merkle-trees](https://github.com/polytope-labs/solidity-merkle-trees) (Apache-2.0): trie and RLP primitives; the Substrate trie verifier is adapted to BLAKE2b-256 node hashing.
- [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) v5.1.0 (MIT).

## License

MIT
