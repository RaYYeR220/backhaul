//! Errors of the light client, one for one with ParliaClient.sol / BscHeader.sol / EthProofs.sol.

// The SCALE derive casts variant indices; there are fewer than 256 variants.
#![allow(clippy::cast_possible_truncation)]

use crate::Address;

/// Why a window, a checkpoint or a proof was refused.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
#[ink::scale_derive(Encode, Decode, TypeInfo)]
pub enum Error {
    EmptyWindow,
    BrokenLink(u64),
    CoinbaseMismatch(u64),
    UnauthorizedSigner(u64, Address),
    /// (distinct trusted signers, quorum)
    TooFewSigners(u32, u32),
    /// (number, lowest provable height)
    BeforeTrustedSet(u64, u64),
    /// (headers[0] timestamp, deadline)
    TrustingPeriodExpired(u64, u64),
    AlreadyFinalized(u64),
    NotFinalized(u64),
    InvalidCheckpoint,
    InvalidValidatorSet,
    InvalidRlp,
    InvalidHeader,
    InvalidSignature,
    InvalidEpochExtra,
    IncompleteProof,
    InvalidProof,
    InvalidAccount,
}
