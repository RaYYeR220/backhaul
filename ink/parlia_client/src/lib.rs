//! # parlia_client
//!
//! Light client of BNB Smart Chain (Parlia consensus) for Portaldot's pallet-contracts: the WASM
//! twin of `contracts/src/portaldot/ParliaClient.sol`, with the same checkpoint, the same rules and
//! the same errors. It finalizes BSC headers from the validators' ECDSA seals, keeps the last
//! [`RING_SIZE`] finalized headers, and proves BSC account storage against them for ink! contracts.
//! No owner, no pause, no upgrade.
//!
//! Security model (skipping verification with a trusting period, as in IBC / Tendermint light
//! clients): `submit_window(headers)` finalizes `headers[0]` when
//! - the headers are consecutive and linked by parentHash;
//! - every seal recovers (low-s) to the header's coinbase;
//! - at least ⌈2N/3⌉ distinct members of the trusted set for `headers[0]` (size N) sealed;
//! - `headers[0].timestamp ≤` that set's epoch timestamp + trusting period;
//! - in a window that crosses a switch the client knows about (an epoch block it rotates to, or the
//!   boundary between its previous and current set), every seal belongs to the set in force at its
//!   height.
//!
//! In a plain window, seals from validators outside the trusted set pass but never count. An epoch
//! block later than the trusted epoch announces a set that seals from E + (⌊N/2⌋+1)·turnLength
//! (bsc consensus/parlia/snapshot.go `Snapshot.apply`, minerHistoryCheckLen() + 1) and becomes the
//! trusted set once the window passes; its own seals never count towards the quorum, so a forged
//! epoch block cannot certify itself. The previous set is kept, so blocks below the current set's
//! first height stay provable until the next rotation. See ParliaClient.sol for the full argument.
//!
//! Not checked: BLS fast-finality votes, turn order, difficulty, gas and timestamp rules.

#![cfg_attr(not(feature = "std"), no_std, no_main)]

mod error;
mod header;
mod mpt;
mod rlp;

#[cfg(test)]
mod tests;

/// A 20-byte account (consensus address, contract address).
pub type Address = [u8; 20];
/// A 32-byte hash or word.
pub type H256 = [u8; 32];

/// Number of finalized headers kept; header n lives in slot n % RING_SIZE.
pub const RING_SIZE: u64 = 256;

/// secp256k1n / 2, big-endian: seals with a larger s are malleated copies.
const HALF_ORDER: H256 = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x5d, 0x57, 0x6e,
    0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];
/// secp256k1n, big-endian.
const ORDER: H256 = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xba, 0xae, 0xdc,
    0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

/// keccak256 through the `hash_keccak_256` host function.
pub(crate) fn keccak(data: &[u8]) -> H256 {
    let mut out = [0u8; 32];
    ink::env::hash_bytes::<ink::env::hash::Keccak256>(data, &mut out);
    out
}

/// The Ethereum address that signed `digest`, from a 65-byte r ‖ s ‖ v seal (v ∈ {0, 1}).
/// Like the EVM precompile it refuses r or s outside [1, n), and like ParliaClient it refuses
/// s > n/2, so a seal recovers here exactly when it recovers there.
pub(crate) fn recover(sig: &[u8], digest: &H256) -> Option<Address> {
    let sig: &[u8; 65] = sig.try_into().ok()?;
    let (r, s) = (&sig[..32], &sig[32..64]);
    let zero = [0u8; 32];
    if sig[64] > 1 || s > &HALF_ORDER[..] || s == &zero[..] || r == &zero[..] || r >= &ORDER[..] {
        return None;
    }
    let mut pubkey = [0u8; 33];
    ink::env::ecdsa_recover(sig, digest, &mut pubkey).ok()?;
    let mut address = [0u8; 20];
    ink::env::ecdsa_to_eth_address(&pubkey, &mut address).ok()?;
    Some(address)
}

pub use error::Error;

#[ink::contract]
mod parlia_client {
    use crate::{header, mpt, Address, Error, H256, RING_SIZE};
    use ink::prelude::vec::Vec;
    use ink::storage::Mapping;

    /// A finalized BSC header, reduced to what proof verifiers need.
    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    #[ink::scale_derive(Encode, Decode, TypeInfo)]
    #[cfg_attr(feature = "std", derive(ink::storage::traits::StorageLayout))]
    pub struct FinalizedHeader {
        pub hash: H256,
        pub number: u64,
        pub timestamp: u64,
        pub state_root: H256,
        pub receipts_root: H256,
    }

    /// Trusted starting point: an epoch block and the validator set it announced.
    /// `active_from` is the first height sealed by `validators`; the trusting period counts from
    /// `timestamp`.
    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    #[ink::scale_derive(Encode, Decode, TypeInfo)]
    pub struct Checkpoint {
        pub epoch: u64,
        pub timestamp: u64,
        pub active_from: u64,
        pub turn_length: u8,
        pub validators: Vec<Address>,
    }

    /// A trusted validator set and the epoch block that announced it.
    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    #[ink::scale_derive(Encode, Decode, TypeInfo)]
    #[cfg_attr(feature = "std", derive(ink::storage::traits::StorageLayout))]
    pub struct TrustedSet {
        pub validators: Vec<Address>,
        pub turn_length: u8,
        pub epoch: u64,
        pub active_from: u64,
        pub epoch_timestamp: u64,
    }

    /// A header became final.
    #[ink(event)]
    pub struct Finalized {
        pub number: u64,
        pub hash: H256,
    }

    /// The trusted validator set changed to the one announced at `epoch`.
    #[ink(event)]
    pub struct ValidatorSetUpdated {
        pub epoch: u64,
        pub effective_from: u64,
        pub size: u32,
    }

    #[ink(storage)]
    pub struct ParliaClient {
        chain_id: u64,
        epoch_length: u64,
        trusting_period: u64,
        /// Current and previous trusted sets; a rotation overwrites the previous one.
        sets: [TrustedSet; 2],
        current: u8,
        /// Finalized headers by `number % RING_SIZE`.
        ring: Mapping<u64, FinalizedHeader>,
    }

    /// Which sets a window is checked against: `pre` below `switch_at`, `post` from it.
    /// Only members of `pre` count towards the quorum.
    struct Plan {
        pre: Vec<Address>,
        post: Vec<Address>,
        switch_at: u64,
        trusted_since: u64,
        rotates: bool,
        post_turn_length: u8,
    }

    impl ParliaClient {
        /// A client trusting `checkpoint`, for seals bound to `chain_id` (97 for BSC testnet).
        #[ink(constructor)]
        pub fn new(chain_id: u64, epoch_length: u64, trusting_period: u64, checkpoint: Checkpoint) -> Result<Self, Error> {
            if chain_id == 0 || trusting_period == 0 || checkpoint.epoch.checked_rem(epoch_length) != Some(0) {
                return Err(Error::InvalidCheckpoint);
            }
            if checkpoint.active_from <= checkpoint.epoch
                || checkpoint.active_from >= checkpoint.epoch.saturating_add(epoch_length)
            {
                return Err(Error::InvalidCheckpoint);
            }
            check_set(checkpoint.validators.len(), checkpoint.turn_length, epoch_length)?;
            let mut lc = Self {
                chain_id,
                epoch_length,
                trusting_period,
                sets: Default::default(),
                current: 0,
                ring: Mapping::new(),
            };
            lc.write(
                0,
                checkpoint.validators,
                checkpoint.turn_length,
                checkpoint.epoch,
                checkpoint.active_from,
                checkpoint.timestamp,
            );
            Ok(lc)
        }

        /// Finalizes `headers[0]` from the seals of the window above it.
        /// `headers`: consecutive BSC headers, RLP-encoded, lowest first. Returns the number of `headers[0]`.
        #[ink(message)]
        pub fn submit_window(&mut self, headers: Vec<Vec<u8>>) -> Result<u64, Error> {
            let count = headers.len();
            if count == 0 {
                return Err(Error::EmptyWindow);
            }
            let mut h = header::parse(&headers[0], self.chain_id)?;
            let cur = self.current;
            let plan = self.plan(&h, &headers[0], cur)?;
            let deadline = plan.trusted_since.saturating_add(self.trusting_period);
            if h.timestamp > deadline {
                return Err(Error::TrustingPeriodExpired(h.timestamp, deadline));
            }
            let first = FinalizedHeader {
                hash: h.hash,
                number: h.number,
                timestamp: h.timestamp,
                state_root: h.state_root,
                receipts_root: h.receipts_root,
            };

            let mut seen = [false; 256]; // seen[i] once pre[i] has sealed a header of the window
            let mut distinct = 0u32;
            let mut rest = headers.iter().skip(1);
            loop {
                if h.signer != h.coinbase {
                    return Err(Error::CoinbaseMismatch(h.number));
                }
                let idx = plan.pre.iter().position(|v| *v == h.signer);
                // A plain window passes over untrusted seals (they never count). Across a switch,
                // every seal must come from the set in force at its height.
                if plan.switch_at != u64::MAX {
                    let allowed = if h.number < plan.switch_at { idx.is_some() } else { plan.post.contains(&h.signer) };
                    if !allowed {
                        return Err(Error::UnauthorizedSigner(h.number, h.signer));
                    }
                }
                if let Some(idx) = idx {
                    if !seen[idx] {
                        seen[idx] = true;
                        distinct = distinct.saturating_add(1);
                    }
                }

                let Some(raw) = rest.next() else { break };
                let next = header::parse(raw, self.chain_id)?;
                if Some(next.number) != h.number.checked_add(1) || next.parent_hash != h.hash {
                    return Err(Error::BrokenLink(next.number));
                }
                h = next;
            }

            // ⌈2N/3⌉, N ≤ 255
            let quorum = u32::try_from(plan.pre.len().saturating_mul(2).saturating_add(2) / 3).unwrap_or(u32::MAX);
            if distinct < quorum {
                return Err(Error::TooFewSigners(distinct, quorum));
            }

            let (number, timestamp) = (first.number, first.timestamp);
            self.store(first)?;
            if plan.rotates {
                let next = cur ^ 1;
                self.write(next, plan.post, plan.post_turn_length, number, plan.switch_at, timestamp);
                self.current = next;
            }
            Ok(number)
        }

        /// A finalized header still held in the ring, or `None` if `number` was never finalized or
        /// has been overwritten.
        #[ink(message)]
        pub fn finalized(&self, number: u64) -> Option<FinalizedHeader> {
            self.ring.get(number % RING_SIZE).filter(|h| h.number == number && number != 0)
        }

        /// The trusted validator set and the epoch block that announced it.
        #[ink(message)]
        pub fn validator_set(&self) -> TrustedSet {
            self.sets[self.current as usize].clone()
        }

        /// The set trusted before the last rotation; it still checks windows starting in
        /// [active_from, current active_from). Empty until the first rotation.
        #[ink(message)]
        pub fn previous_validator_set(&self) -> TrustedSet {
            self.sets[(self.current ^ 1) as usize].clone()
        }

        /// Value of `slot` in the storage of BSC account `account` at finalized block `number`, or
        /// `None` when the account or the slot is absent. Proofs are `eth_getProof`'s accountProof
        /// and storageProof[i].proof. The data bridge for ink! contracts.
        #[ink(message)]
        pub fn storage_at(
            &self,
            number: u64,
            account: Address,
            account_proof: Vec<Vec<u8>>,
            slot: H256,
            storage_proof: Vec<Vec<u8>>,
        ) -> Result<Option<H256>, Error> {
            let h = self.finalized(number).ok_or(Error::NotFinalized(number))?;
            mpt::storage_at(&h.state_root, &account, &account_proof, &slot, &storage_proof)
        }

        /// Chain id, epoch length and trusting period the client was built with.
        #[ink(message)]
        pub fn config(&self) -> (u64, u64, u64) {
            (self.chain_id, self.epoch_length, self.trusting_period)
        }

        // -----------------------------------------------------------------------------------------

        /// Picks the sets that check a window starting with `h`.
        fn plan(&self, h: &header::Parsed, rlp: &[u8], cur: u8) -> Result<Plan, Error> {
            let current = &self.sets[cur as usize];
            if h.number.checked_rem(self.epoch_length) == Some(0) && h.number > current.epoch {
                // A later epoch block: its own set takes over at its switch height.
                let (post, post_turn_length) = header::epoch_validators(h.extra(rlp))?;
                check_set(post.len(), post_turn_length, self.epoch_length)?;
                let switch_at = h
                    .number
                    .checked_add(switch_offset(current.validators.len(), current.turn_length))
                    .ok_or(Error::InvalidHeader)?;
                Ok(Plan {
                    switch_at,
                    pre: current.validators.clone(),
                    post,
                    trusted_since: current.epoch_timestamp,
                    rotates: true,
                    post_turn_length,
                })
            } else if h.number >= current.active_from {
                Ok(Plan {
                    pre: current.validators.clone(),
                    post: Vec::new(),
                    switch_at: u64::MAX,
                    trusted_since: current.epoch_timestamp,
                    rotates: false,
                    post_turn_length: 0,
                })
            } else {
                let previous = &self.sets[(cur ^ 1) as usize];
                if previous.validators.is_empty() {
                    return Err(Error::BeforeTrustedSet(h.number, current.active_from));
                }
                if h.number < previous.active_from {
                    return Err(Error::BeforeTrustedSet(h.number, previous.active_from));
                }
                Ok(Plan {
                    pre: previous.validators.clone(),
                    post: current.validators.clone(),
                    switch_at: current.active_from,
                    trusted_since: previous.epoch_timestamp,
                    rotates: false,
                    post_turn_length: 0,
                })
            }
        }

        fn store(&mut self, h: FinalizedHeader) -> Result<(), Error> {
            let key = h.number % RING_SIZE;
            if self.ring.get(key).is_some_and(|old| old.number == h.number) {
                return Err(Error::AlreadyFinalized(h.number));
            }
            self.env().emit_event(Finalized { number: h.number, hash: h.hash });
            self.ring.insert(key, &h);
            Ok(())
        }

        fn write(&mut self, index: u8, validators: Vec<Address>, turn_length: u8, epoch: u64, active_from: u64, timestamp: u64) {
            self.env().emit_event(ValidatorSetUpdated {
                epoch,
                effective_from: active_from,
                size: u32::try_from(validators.len()).unwrap_or(u32::MAX),
            });
            self.sets[index as usize] =
                TrustedSet { validators, turn_length, epoch, active_from, epoch_timestamp: timestamp };
        }
    }

    /// Blocks from an epoch block to the first block its set seals: minerHistoryCheckLen() + 1,
    /// computed over the set in force before the switch.
    fn switch_offset(size: usize, turn_length: u8) -> u64 {
        (size / 2).saturating_add(1).saturating_mul(turn_length as usize) as u64
    }

    /// A set must fit the signer bitmap and switch inside its epoch.
    fn check_set(size: usize, turn_length: u8, epoch_length: u64) -> Result<(), Error> {
        if size == 0 || size > 255 || turn_length == 0 || switch_offset(size, turn_length) >= epoch_length {
            return Err(Error::InvalidValidatorSet);
        }
        Ok(())
    }
}

pub use crate::parlia_client::{Checkpoint, FinalizedHeader, ParliaClient, TrustedSet};
