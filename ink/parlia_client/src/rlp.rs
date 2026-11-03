//! Bounds-checked RLP item decoding over a byte slice, the same rules as `contracts/src/lib/bsc/Rlp.sol`.
//!
//! Positions are offsets into one buffer, so nested structures are walked without copying.
//! Lengths are limited to 4 bytes, like the Solidity decoder.
//!
//! Offsets never exceed the input's length (every item is bounds-checked against it), so the
//! index arithmetic below cannot overflow; out-of-range slicing would trap the call.
#![allow(clippy::arithmetic_side_effects, clippy::cast_possible_truncation)]

/// An RLP item: where it starts, where its payload is, and whether it is a list.
#[derive(Clone, Copy, Default)]
pub struct Item {
    pub start: usize,
    pub data: usize,
    pub len: usize,
    pub list: bool,
}

impl Item {
    /// Position right after the item.
    pub fn end(&self) -> usize {
        self.data + self.len
    }
}

/// Malformed RLP within the given bounds.
pub struct InvalidRlp;

/// Decodes the prefix of the item at `ptr`, which must end by `end`.
pub fn item(buf: &[u8], ptr: usize, end: usize) -> Result<Item, InvalidRlp> {
    if ptr >= end || end > buf.len() {
        return Err(InvalidRlp);
    }
    let b0 = buf[ptr] as usize;
    let (data, len, list) = if b0 < 0x80 {
        (ptr, 1, false)
    } else if b0 < 0xb8 {
        (ptr + 1, b0 - 0x80, false)
    } else if b0 < 0xc0 {
        let (d, l) = long(buf, ptr, end, b0 - 0xb7)?;
        (d, l, false)
    } else if b0 < 0xf8 {
        (ptr + 1, b0 - 0xc0, true)
    } else {
        let (d, l) = long(buf, ptr, end, b0 - 0xf7)?;
        (d, l, true)
    };
    match data.checked_add(len) {
        Some(e) if e <= end => Ok(Item { start: ptr, data, len, list }),
        _ => Err(InvalidRlp),
    }
}

/// Decodes a list that must span exactly `[ptr, end)` and returns its payload bounds.
pub fn list(buf: &[u8], ptr: usize, end: usize) -> Result<(usize, usize), InvalidRlp> {
    let it = item(buf, ptr, end)?;
    if !it.list || it.end() != end {
        return Err(InvalidRlp);
    }
    Ok((it.data, it.end()))
}

/// Decodes a string item at `ptr`.
pub fn string(buf: &[u8], ptr: usize, end: usize) -> Result<Item, InvalidRlp> {
    let it = item(buf, ptr, end)?;
    if it.list {
        return Err(InvalidRlp);
    }
    Ok(it)
}

/// Position right after the item at `ptr`.
pub fn skip(buf: &[u8], ptr: usize, end: usize) -> Result<usize, InvalidRlp> {
    Ok(item(buf, ptr, end)?.end())
}

/// Big-endian unsigned integer of the bytes (callers keep them to 8 or fewer).
pub fn be_uint(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0u64, |acc, b| (acc << 8) | *b as u64)
}

fn long(buf: &[u8], ptr: usize, end: usize, len_of_len: usize) -> Result<(usize, usize), InvalidRlp> {
    if len_of_len > 4 || ptr + 1 + len_of_len > end {
        return Err(InvalidRlp);
    }
    let len = be_uint(&buf[ptr + 1..ptr + 1 + len_of_len]) as usize;
    Ok((ptr + 1 + len_of_len, len))
}
