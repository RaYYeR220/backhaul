//! Merkle-Patricia proofs against an Ethereum-style state root, the same walk as
//! `contracts/src/lib/bsc/EthProofs.sol`.
//!
//! The walk follows the key's nibbles from the root. Every node is found by its keccak256 among the
//! proof nodes (or embedded in its parent when shorter than 32 bytes), so everything read is
//! authenticated by the root, proof order does not matter and extra nodes are ignored. A key is
//! reported absent only when an authenticated node shows its path ends: an empty branch slot, or a
//! leaf or extension whose path diverges. A missing node is an error.
//!
//! Index arithmetic stays within the proof nodes and the key (bounded by `rlp::item`);
//! out-of-range slicing would trap the call.
#![allow(clippy::arithmetic_side_effects, clippy::cast_possible_truncation)]

use crate::{keccak, rlp, Address, Error, H256};
use ink::prelude::vec::Vec;

/// keccak256(rlp("")): root of an empty trie.
pub const EMPTY_TRIE_ROOT: H256 = [
    0x56, 0xe8, 0x1f, 0x17, 0x1b, 0xcc, 0x55, 0xa6, 0xff, 0x83, 0x45, 0xe6, 0x92, 0xc0, 0xf8, 0x6e, 0x5b, 0x48, 0xe0,
    0x1b, 0x99, 0x6c, 0xad, 0xc0, 0x01, 0x62, 0x2f, 0xb5, 0xe3, 0x63, 0xb4, 0x21,
];

/// Value of `slot` in `account`'s storage under `state_root` (EIP-1186 proofs), or `None` when the
/// account or the slot is absent from the state.
pub fn storage_at(
    state_root: &H256,
    account: &Address,
    account_proof: &[Vec<u8>],
    slot: &H256,
    storage_proof: &[Vec<u8>],
) -> Result<Option<H256>, Error> {
    let raw_account = get(state_root, account_proof, &keccak(account))?;
    let Some(raw_account) = raw_account else { return Ok(None) };
    let storage_root = storage_root(raw_account)?;

    let raw_value = get(&storage_root, storage_proof, &keccak(slot))?;
    let Some(raw_value) = raw_value else { return Ok(None) };
    // Storage leaves hold rlp(value) with the value's leading zeros stripped.
    let it = rlp::string(raw_value, 0, raw_value.len())?;
    if it.end() != raw_value.len() || it.len > 32 {
        return Err(Error::InvalidRlp);
    }
    let mut value = [0u8; 32];
    value[32 - it.len..].copy_from_slice(&raw_value[it.data..it.end()]);
    Ok(Some(value))
}

/// Value stored under `key` (the raw trie path) in the trie with root `root`, or `None` when the
/// proof shows the key is absent (or the value is empty).
pub fn get<'a>(root: &H256, proof: &'a [Vec<u8>], key: &[u8]) -> Result<Option<&'a [u8]>, Error> {
    if *root == EMPTY_TRIE_ROOT {
        return Ok(None);
    }
    let hashes: Vec<H256> = proof.iter().map(|n| keccak(n)).collect();
    let total = key.len() * 2;
    let mut at = 0; // nibbles of the key consumed so far

    let (mut buf, mut start, mut end) = lookup(proof, &hashes, root)?;
    loop {
        let (p, e) = rlp::list(buf, start, end)?;
        // One pass over the items: keep the first two (leaf / extension) and, assuming a branch,
        // the slot the key continues into (or the value slot once the key is used up).
        let want = if at == total { 16 } else { nibble(key, at) };
        let mut a = rlp::Item::default();
        let mut b = rlp::Item::default();
        let mut w = rlp::Item::default();
        let mut count = 0;
        let mut q = p;
        while q < e {
            if count == 17 {
                return Err(Error::InvalidProof);
            }
            let it = rlp::item(buf, q, e)?;
            if count == 0 {
                a = it;
            } else if count == 1 {
                b = it;
            }
            if count == want {
                w = it;
            }
            q = it.end();
            count += 1;
        }

        if count == 17 {
            if w.list {
                if at == total {
                    return Err(Error::InvalidProof);
                }
            } else if w.len == 0 || at == total {
                // Empty slot: the key is absent. Value slot: this is the value.
                return Ok(value(buf, &w));
            }
            at += 1;
            (buf, start, end) = child(proof, &hashes, buf, &w)?;
            continue;
        }
        if count != 2 || a.list || a.len == 0 {
            return Err(Error::InvalidProof);
        }

        // Leaf or extension: hex-prefix encoded path in `a`.
        let flag = buf[a.data] >> 4;
        if flag > 3 {
            return Err(Error::InvalidProof);
        }
        let skip = if flag & 1 == 1 { 1 } else { 2 };
        let path = &buf[a.data..a.end()];
        let path_len = a.len * 2 - skip;
        let remaining = total - at;
        if flag >= 2 {
            if path_len != remaining || !matches(path, skip, key, at, path_len) {
                return Ok(None);
            }
            if b.list {
                return Err(Error::InvalidProof);
            }
            return Ok(value(buf, &b));
        }
        if path_len > remaining || !matches(path, skip, key, at, path_len) {
            return Ok(None);
        }
        at += path_len;
        (buf, start, end) = child(proof, &hashes, buf, &b)?;
    }
}

fn value<'a>(buf: &'a [u8], it: &rlp::Item) -> Option<&'a [u8]> {
    if it.len == 0 {
        None
    } else {
        Some(&buf[it.data..it.end()])
    }
}

/// The node a branch slot or extension points at: embedded in `buf`, or found by hash.
fn child<'a>(
    proof: &'a [Vec<u8>],
    hashes: &[H256],
    buf: &'a [u8],
    r: &rlp::Item,
) -> Result<(&'a [u8], usize, usize), Error> {
    if r.list {
        return Ok((buf, r.start, r.end()));
    }
    let h: H256 = buf[r.data..r.end()].try_into().map_err(|_| Error::InvalidProof)?;
    lookup(proof, hashes, &h)
}

fn lookup<'a>(proof: &'a [Vec<u8>], hashes: &[H256], h: &H256) -> Result<(&'a [u8], usize, usize), Error> {
    match hashes.iter().position(|x| x == h) {
        Some(i) => Ok((&proof[i], 0, proof[i].len())),
        None => Err(Error::IncompleteProof),
    }
}

/// Nibble `i` of `bytes` (high nibble first).
fn nibble(bytes: &[u8], i: usize) -> usize {
    let b = bytes[i / 2];
    (if i & 1 == 0 { b >> 4 } else { b & 0x0f }) as usize
}

/// Whether `len` path nibbles (from nibble `skip` of `path`) equal the key's from nibble `at`.
fn matches(path: &[u8], skip: usize, key: &[u8], at: usize, len: usize) -> bool {
    (0..len).all(|j| nibble(path, skip + j) == nibble(key, at + j))
}

/// The storage root of an account leaf [nonce, balance, storageRoot, codeHash].
fn storage_root(raw: &[u8]) -> Result<H256, Error> {
    let (p, e) = rlp::list(raw, 0, raw.len())?;
    let p = rlp::skip(raw, p, e)?; // nonce
    let p = rlp::skip(raw, p, e)?; // balance
    let root = rlp::string(raw, p, e)?;
    if root.len != 32 {
        return Err(Error::InvalidAccount);
    }
    let code = rlp::string(raw, root.end(), e)?;
    if code.end() != e {
        return Err(Error::InvalidAccount);
    }
    raw[root.data..root.end()].try_into().map_err(|_| Error::InvalidAccount)
}
