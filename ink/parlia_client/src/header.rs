//! BSC header decoding and Parlia seal recovery, the same rules as `contracts/src/lib/bsc/BscHeader.sol`.
//!
//! The decoder is strict: the outer list must cover the input exactly, every item must be a string,
//! and every length is bounds-checked. The seal hash is rebuilt by splicing the original RLP:
//!   keccak256( listPrefix ‖ rlp(chainId) ‖ items[0..11] ‖ rlp(extra[:-65]) ‖ items[13..] )
//! where items[13..] is mixHash and nonce, followed by every later item only when the header carries
//! parentBeaconRoot (item 19), as bsc `types.EncodeSigHeader` does.
//!
//! Index arithmetic stays within the header's RLP (bounded by `rlp::item`); out-of-range
//! slicing would trap the call.
#![allow(clippy::arithmetic_side_effects, clippy::cast_possible_truncation)]

use crate::{keccak, recover, rlp, Address, Error, H256};
use ink::prelude::vec::Vec;

/// Vanity prefix of `extra`.
pub const EXTRA_VANITY: usize = 32;
/// Seal suffix of `extra`: r (32) ‖ s (32) ‖ v (1, 0 or 1).
pub const EXTRA_SEAL: usize = 65;
/// One validator in an epoch block: consensus address (20) ‖ BLS vote key (48).
pub const VALIDATOR_BYTES: usize = 68;

/// parentHash … nonce.
const BASE_ITEMS: usize = 15;
/// Headers with parentBeaconRoot (index 19) have at least this many items.
const BEACON_ITEMS: usize = 20;
/// Upper bound on header items.
const MAX_ITEMS: usize = 32;

/// A decoded header with its seal recovered. `extra` is kept as offsets into the RLP.
pub struct Parsed {
    pub hash: H256,
    pub parent_hash: H256,
    pub number: u64,
    pub timestamp: u64,
    pub coinbase: Address,
    pub state_root: H256,
    pub receipts_root: H256,
    pub signer: Address,
    pub extra_data: usize,
    pub extra_len: usize,
}

impl Parsed {
    pub fn extra<'a>(&self, rlp: &'a [u8]) -> &'a [u8] {
        &rlp[self.extra_data..self.extra_data + self.extra_len]
    }
}

/// Positions the seal hash is spliced from.
#[derive(Default)]
struct Layout {
    first: usize,
    extra_item: usize,
    extra_data: usize,
    extra_len: usize,
    after_extra: usize,
    tail_end: usize,
}

impl From<rlp::InvalidRlp> for Error {
    fn from(_: rlp::InvalidRlp) -> Self {
        Error::InvalidRlp
    }
}

/// Decodes a header and recovers the address that sealed it under `chain_id`.
/// Does not check `signer == coinbase`.
pub fn parse(rlp: &[u8], chain_id: u64) -> Result<Parsed, Error> {
    let mut h = Parsed {
        hash: keccak(rlp),
        parent_hash: [0; 32],
        number: 0,
        timestamp: 0,
        coinbase: [0; 20],
        state_root: [0; 32],
        receipts_root: [0; 32],
        signer: [0; 20],
        extra_data: 0,
        extra_len: 0,
    };
    let l = walk(rlp, &mut h)?;
    h.extra_data = l.extra_data;
    h.extra_len = l.extra_len;
    let digest = seal_hash(rlp, &l, chain_id);
    let sig = &rlp[l.extra_data + l.extra_len - EXTRA_SEAL..l.extra_data + l.extra_len];
    h.signer = recover(sig, &digest).ok_or(Error::InvalidSignature)?;
    Ok(h)
}

/// Validator set and turn length announced in the extra data of an epoch block:
/// vanity32 | count u8 | count × (address20 ‖ bls48) | turnLength u8 | attestation… | seal65.
pub fn epoch_validators(extra: &[u8]) -> Result<(Vec<Address>, u8), Error> {
    let n = extra.len();
    if n <= EXTRA_VANITY + EXTRA_SEAL {
        return Err(Error::InvalidEpochExtra);
    }
    let count = extra[EXTRA_VANITY] as usize;
    let end = EXTRA_VANITY + 1 + count * VALIDATOR_BYTES;
    if count == 0 || end + 1 + EXTRA_SEAL > n {
        return Err(Error::InvalidEpochExtra);
    }
    let mut validators = Vec::with_capacity(count);
    for i in 0..count {
        let at = EXTRA_VANITY + 1 + i * VALIDATOR_BYTES;
        let mut v = [0u8; 20];
        v.copy_from_slice(&extra[at..at + 20]);
        validators.push(v);
    }
    let turn_length = extra[end];
    if turn_length == 0 {
        return Err(Error::InvalidEpochExtra);
    }
    Ok((validators, turn_length))
}

fn walk(rlp: &[u8], h: &mut Parsed) -> Result<Layout, Error> {
    let end = rlp.len();
    let outer = rlp::item(rlp, 0, end)?;
    if !outer.list || outer.end() != end {
        return Err(Error::InvalidRlp);
    }
    let mut l = Layout { first: outer.data, ..Default::default() };
    let mut ptr = outer.data;
    let mut i = 0;
    while ptr < end {
        if i == MAX_ITEMS {
            return Err(Error::InvalidHeader);
        }
        let it = rlp::item(rlp, ptr, end)?;
        if it.list {
            return Err(Error::InvalidHeader);
        }
        let v = &rlp[it.data..it.end()];
        match i {
            0 => h.parent_hash = bytes32(v)?,
            2 => h.coinbase = address(v)?,
            3 => h.state_root = bytes32(v)?,
            5 => h.receipts_root = bytes32(v)?,
            8 => h.number = uint64(v)?,
            11 => h.timestamp = uint64(v)?,
            12 => {
                l.extra_item = ptr;
                l.extra_data = it.data;
                l.extra_len = it.len;
                l.after_extra = it.end();
            }
            14 => l.tail_end = it.end(),
            _ => {}
        }
        ptr = it.end();
        i += 1;
    }
    if i < BASE_ITEMS {
        return Err(Error::InvalidHeader);
    }
    if i >= BEACON_ITEMS {
        l.tail_end = end;
    }
    if l.extra_len < EXTRA_VANITY + EXTRA_SEAL {
        return Err(Error::InvalidHeader);
    }
    Ok(l)
}

fn bytes32(v: &[u8]) -> Result<H256, Error> {
    v.try_into().map_err(|_| Error::InvalidHeader)
}

fn address(v: &[u8]) -> Result<Address, Error> {
    v.try_into().map_err(|_| Error::InvalidHeader)
}

fn uint64(v: &[u8]) -> Result<u64, Error> {
    if v.len() > 8 {
        return Err(Error::InvalidHeader);
    }
    Ok(rlp::be_uint(v))
}

/// Minimal big-endian bytes of `x` (empty for zero).
fn be_bytes(x: u64) -> ([u8; 8], usize) {
    let b = x.to_be_bytes();
    let skip = (x.leading_zeros() / 8) as usize;
    (b, skip)
}

/// RLP prefix of a string or list payload of `len` bytes (`offset` 0x80 or 0xc0).
fn prefix(out: &mut Vec<u8>, len: usize, offset: u8) {
    if len < 56 {
        out.push(offset + len as u8);
    } else {
        let (b, skip) = be_bytes(len as u64);
        out.push(offset + 55 + (8 - skip) as u8);
        out.extend_from_slice(&b[skip..]);
    }
}

/// Length of the RLP prefix for a payload of `len` bytes.
fn prefix_len(len: usize) -> usize {
    if len < 56 {
        1
    } else {
        1 + 8 - be_bytes(len as u64).1
    }
}

fn seal_hash(rlp: &[u8], l: &Layout, chain_id: u64) -> H256 {
    let head = &rlp[l.first..l.extra_item];
    let body = &rlp[l.extra_data..l.extra_data + l.extra_len - EXTRA_SEAL];
    let tail = &rlp[l.after_extra..l.tail_end];

    let (cid, cid_skip) = be_bytes(chain_id);
    let cid = &cid[cid_skip..];
    let cid_len = if chain_id < 0x80 { 1 } else { 1 + cid.len() };
    let payload = cid_len + head.len() + prefix_len(body.len()) + body.len() + tail.len();

    let mut out = Vec::with_capacity(payload + 9);
    prefix(&mut out, payload, 0xc0);
    // rlp(chainId)
    if chain_id == 0 {
        out.push(0x80);
    } else if chain_id < 0x80 {
        out.push(chain_id as u8);
    } else {
        out.push(0x80 + cid.len() as u8);
        out.extend_from_slice(cid);
    }
    out.extend_from_slice(head);
    prefix(&mut out, body.len(), 0x80);
    out.extend_from_slice(body);
    out.extend_from_slice(tail);
    keccak(&out)
}
