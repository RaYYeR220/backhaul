//! Off-chain unit tests on the same fixtures as the Solidity tests (contracts/test/fixtures):
//! real BSC testnet headers around epoch 140342000, synthetic Parlia chains signed with test keys,
//! a real storage proof of WBNB on BSC testnet, and Merkle-Patricia vectors from @ethereumjs/trie.

use crate::{mpt, Address, Checkpoint, Error, ParliaClient, H256, RING_SIZE};
use serde_json::Value;
use std::sync::OnceLock;

const TRUSTING_PERIOD: u64 = 7 * 86_400;

fn load(name: &str) -> Value {
    let path = format!("{}/../../contracts/test/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

fn headers_json() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| load("bsc-headers.json"))
}

fn syn() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| load("bsc-synthetic.json"))
}

fn storage_json() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| load("bsc-storage.json"))
}

fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap().trim_start_matches("0x")).unwrap()
}

fn addr(v: &Value) -> Address {
    bytes(v).try_into().unwrap()
}

fn h256(v: &Value) -> H256 {
    bytes(v).try_into().unwrap()
}

fn u(v: &Value) -> u64 {
    v.as_u64().unwrap()
}

fn list(v: &Value) -> Vec<Vec<u8>> {
    v.as_array().unwrap().iter().map(bytes).collect()
}

fn addrs(v: &Value) -> Vec<Address> {
    v.as_array().unwrap().iter().map(addr).collect()
}

fn slice(all: &[Vec<u8>], from: usize, count: usize) -> Vec<Vec<u8>> {
    all[from..from + count].to_vec()
}

fn checkpoint(v: &Value) -> Checkpoint {
    Checkpoint {
        epoch: u(&v["epoch"]),
        timestamp: u(&v["timestamp"]),
        active_from: u(&v["activeFrom"]),
        turn_length: u(&v["turnLength"]) as u8,
        validators: addrs(&v["validators"]),
    }
}

/// bsc-headers.json, decoded.
struct Real {
    chain_id: u64,
    epoch_length: u64,
    epoch: u64,
    switch_height: u64,
    rlps: Vec<Vec<u8>>,
    hashes: Vec<H256>,
    miners: Vec<Address>,
    timestamps: Vec<u64>,
    state_roots: Vec<H256>,
    receipts_roots: Vec<H256>,
    epoch_validators: Vec<Address>,
    epoch_turn_length: u8,
    incoming: Address,
    first_incoming_seal: u64,
    checkpoint: Checkpoint,
}

fn real() -> Real {
    let j = headers_json();
    let col = |k: &str| j[k].as_array().unwrap().clone();
    Real {
        chain_id: u(&j["chainId"]),
        epoch_length: u(&j["epochLength"]),
        epoch: u(&j["epoch"]),
        switch_height: u(&j["switchHeight"]),
        rlps: list(&j["rlps"]),
        hashes: col("hashes").iter().map(h256).collect(),
        miners: addrs(&j["miners"]),
        timestamps: col("timestamps").iter().map(u).collect(),
        state_roots: col("stateRoots").iter().map(h256).collect(),
        receipts_roots: col("receiptsRoots").iter().map(h256).collect(),
        epoch_validators: addrs(&j["epochValidators"]),
        epoch_turn_length: u(&j["epochTurnLength"]) as u8,
        incoming: addrs(&j["incoming"])[0],
        first_incoming_seal: u(&j["firstIncomingSeal"]),
        checkpoint: checkpoint(&j["checkpoint"]),
    }
}

fn deploy(chain_id: u64, epoch_length: u64, cp: Checkpoint) -> ParliaClient {
    ParliaClient::new(chain_id, epoch_length, TRUSTING_PERIOD, cp).expect("valid checkpoint")
}

fn real_client(r: &Real) -> ParliaClient {
    deploy(r.chain_id, r.epoch_length, r.checkpoint.clone())
}

fn synth_client(name: &str) -> ParliaClient {
    let s = syn();
    ParliaClient::new(u(&s["chainId"]), u(&s["epochLength"]), u(&s["trustingPeriod"]), checkpoint(&s["checkpoints"][name]))
        .expect("valid checkpoint")
}

fn segment(name: &str) -> Vec<Vec<u8>> {
    list(&syn()["segments"][name]["rlps"])
}

fn set(name: &str) -> Vec<Address> {
    addrs(&syn()["sets"][name])
}

fn keccak(b: &[u8]) -> H256 {
    crate::keccak(b)
}

// ============================================================================================
// Real BSC testnet data: epoch 140342000, where 0x76d7… left the set and 0x9040… joined.
// ============================================================================================

#[ink::test]
fn finalize_real_epoch_window() {
    let r = real();
    let mut lc = real_client(&r);
    assert_eq!(lc.submit_window(slice(&r.rlps, 0, 48)), Ok(r.epoch));

    let h = lc.finalized(r.epoch).unwrap();
    assert_eq!(h.hash, r.hashes[0]);
    assert_eq!(h.number, r.epoch);
    assert_eq!(h.timestamp, r.timestamps[0]);
    assert_eq!(h.state_root, r.state_roots[0]);
    assert_eq!(h.receipts_root, r.receipts_roots[0]);

    let s = lc.validator_set();
    assert_eq!(s.validators, r.epoch_validators);
    assert_eq!(s.turn_length, r.epoch_turn_length);
    assert_eq!(s.epoch, r.epoch);
    assert_eq!(s.active_from, r.switch_height);
    assert_eq!(s.active_from, r.epoch + 40, "9 validators, turnLength 8: the new set seals from E+40");
    assert_eq!(s.epoch_timestamp, r.timestamps[0]);
    // constructor: ValidatorSetUpdated; window: Finalized + ValidatorSetUpdated
    assert_eq!(ink::env::test::recorded_events().count(), 3);
}

#[ink::test]
fn real_incoming_validator_after_rotation() {
    let r = real();
    let mut lc = real_client(&r);
    lc.submit_window(slice(&r.rlps, 0, 48)).unwrap();
    // E+48 .. E+95 includes the first turn of the incoming validator (E+88 .. E+95).
    let first = (r.first_incoming_seal - r.epoch) as usize;
    assert_eq!(first, 88);
    assert_eq!(r.miners[first], r.incoming);
    assert_eq!(lc.submit_window(slice(&r.rlps, 48, 48)), Ok(r.epoch + 48));
}

#[ink::test]
fn real_swapped_validator_tolerated_not_counted() {
    let r = real();
    // The client still trusts the checkpoint set, which does not hold the validator that joined
    // at E: its first turn (E+88 .. E+95) passes but does not count.
    let mut lc = real_client(&r);
    assert_eq!(lc.submit_window(slice(&r.rlps, 48, 48)), Err(Error::TooFewSigners(5, 6)));
    assert_eq!(lc.submit_window(slice(&r.rlps, 48, 49)), Ok(r.epoch + 48));
    assert_eq!(lc.finalized(r.epoch + 48).unwrap().hash, r.hashes[48]);
    assert_eq!(lc.validator_set().epoch, r.checkpoint.epoch);
}

#[ink::test]
fn real_skip_window_across_unprocessed_epoch() {
    let r = real();
    let mut lc = real_client(&r);
    assert_eq!(lc.submit_window(slice(&r.rlps, 2, 48)), Ok(r.epoch + 2));
    assert_eq!(lc.finalized(r.epoch + 2).unwrap().receipts_root, r.receipts_roots[2]);
    assert_eq!(lc.validator_set().epoch, r.checkpoint.epoch, "a window without an epoch block does not rotate");
}

#[ink::test]
fn rejects_too_few_signers() {
    let r = real();
    let mut lc = real_client(&r);
    // E+1 .. E+39: five turns, five distinct validators; six are needed.
    assert_eq!(lc.submit_window(slice(&r.rlps, 1, 39)), Err(Error::TooFewSigners(5, 6)));
    assert_eq!(lc.submit_window(slice(&r.rlps, 1, 40)), Ok(r.epoch + 1));
}

#[ink::test]
fn non_validator_seals_do_not_count() {
    let r = real();
    let mut cp = r.checkpoint.clone();
    let dropped = r.miners[8];
    for v in cp.validators.iter_mut() {
        if *v == dropped {
            *v = [0xde; 20];
        }
    }
    let mut lc = deploy(r.chain_id, r.epoch_length, cp);
    assert_eq!(lc.submit_window(slice(&r.rlps, 1, 40)), Err(Error::TooFewSigners(5, 6)));

    // A synthetic window ending with a header sealed by a key outside the set: three trusted.
    let mut lc = synth_client("A1000");
    assert_eq!(lc.submit_window(segment("outsider")), Err(Error::TooFewSigners(3, 6)));
}

#[ink::test]
fn untrusted_sealers_do_not_make_quorum() {
    let mut lc = synth_client("A1000");
    let w = segment("untrustedPadding");
    // Five trusted sealers and three untrusted ones: eight distinct, still short of six trusted.
    assert_eq!(lc.submit_window(slice(&w, 0, 64)), Err(Error::TooFewSigners(5, 6)));
    assert_eq!(lc.submit_window(slice(&w, 0, 65)), Ok(1500));
}

#[ink::test]
fn forged_branch_cannot_use_trusted_seals() {
    let mut lc = synth_client("A1000");
    let forged = segment("forgedBranch");
    let honest = segment("honestBranch");
    assert_eq!(lc.submit_window(forged.clone()), Err(Error::TooFewSigners(0, 6)));

    // A forged headers[0] followed by the trusted validators' real chain: no link.
    let mut w = slice(&honest, 0, 48);
    w[0] = forged[0].clone();
    assert_eq!(lc.submit_window(w.clone()), Err(Error::BrokenLink(1601)));
    w[..8].clone_from_slice(&forged[..8]);
    assert_eq!(lc.submit_window(w), Err(Error::BrokenLink(1608)));

    assert_eq!(lc.submit_window(honest.clone()), Ok(1600));
    assert_eq!(lc.finalized(1600).unwrap().hash, keccak(&honest[0]));
}

#[ink::test]
fn rejects_broken_parent_link() {
    let r = real();
    let mut lc = real_client(&r);
    let w = slice(&r.rlps, 0, 49);
    let gap: Vec<_> = (0..48).map(|i| w[if i < 10 { i } else { i + 1 }].clone()).collect();
    assert_eq!(lc.submit_window(gap), Err(Error::BrokenLink(r.epoch + 11)));

    let mut swapped = slice(&r.rlps, 0, 48);
    swapped.swap(5, 6);
    assert_eq!(lc.submit_window(swapped), Err(Error::BrokenLink(r.epoch + 6)));

    let mut foreign = slice(&r.rlps, 0, 48);
    foreign[20] = segment("outsider")[0].clone();
    assert_eq!(lc.submit_window(foreign), Err(Error::BrokenLink(1100)));
}

#[ink::test]
fn rejects_wrong_chain_id() {
    let r = real();
    let mut lc = deploy(56, r.epoch_length, r.checkpoint.clone());
    // Under chain id 56 the seal recovers to some unrelated address.
    assert_eq!(lc.submit_window(slice(&r.rlps, 0, 48)), Err(Error::CoinbaseMismatch(r.epoch)));
}

#[ink::test]
fn previous_set_proves_older_blocks() {
    let r = real();
    let mut lc = real_client(&r);
    lc.submit_window(slice(&r.rlps, 0, 48)).unwrap();
    // E+2 is below the new set's first height (E+40): the previous set still checks it.
    assert_eq!(lc.submit_window(slice(&r.rlps, 2, 48)), Ok(r.epoch + 2));
    let prev = lc.previous_validator_set();
    assert_eq!(prev.epoch, r.checkpoint.epoch);
    assert_eq!(prev.active_from, r.checkpoint.active_from);
    assert_eq!(prev.validators.len(), r.checkpoint.validators.len());
}

#[ink::test]
fn previous_set_still_rejects_outgoing_after_switch() {
    let mut lc = synth_client("A1000");
    lc.submit_window(segment("rotation")).unwrap();
    // The outgoing validator's seal at 4040 is out of force: it does not count, and five of the
    // previous set before the switch are one short.
    assert_eq!(lc.submit_window(segment("rotationOutgoingLate")), Err(Error::TooFewSigners(5, 6)));
    // A window entirely below 4040 is checked by the previous set alone.
    assert_eq!(lc.submit_window(slice(&segment("gas"), 0, 16)), Ok(1100));
}

#[ink::test]
fn previous_set_passes_over_outsider_seal() {
    let w = segment("previousOutsider");
    // A plain window under A before the rotation, and still accepted under A (now the previous
    // set) after it: the outsider's turn passes without counting.
    let mut lc = synth_client("A1000");
    lc.submit_window(segment("rotation")).unwrap();
    assert_eq!(lc.submit_window(slice(&w, 0, 30)), Err(Error::TooFewSigners(5, 6)));
    assert_eq!(lc.submit_window(w.clone()), Ok(4001));
    assert_eq!(lc.finalized(4001).map(|h| h.hash), Some(keccak(&w[0])));
}

#[ink::test]
fn rejects_before_trusted_set() {
    let mut lc = synth_client("A3000");
    assert_eq!(lc.submit_window(slice(&segment("gas"), 0, 16)), Err(Error::BeforeTrustedSet(1100, 3040)));

    // After two rotations the set trusted for 1100 is gone.
    let mut lc = synth_client("A1000");
    lc.submit_window(segment("rotation")).unwrap(); // 4000: A -> B
    lc.submit_window(segment("skipEpoch")).unwrap(); // 5000: B -> A
    let prev = lc.previous_validator_set();
    assert_eq!((prev.epoch, prev.active_from), (4000, 4040));
    assert_eq!(lc.submit_window(slice(&segment("gas"), 0, 16)), Err(Error::BeforeTrustedSet(1100, 4040)));
}

#[ink::test]
fn rejects_resubmission() {
    let r = real();
    let mut lc = real_client(&r);
    lc.submit_window(slice(&r.rlps, 2, 48)).unwrap();
    assert_eq!(lc.submit_window(slice(&r.rlps, 2, 48)), Err(Error::AlreadyFinalized(r.epoch + 2)));
}

#[ink::test]
fn rejects_empty_window_and_unknown_headers() {
    let r = real();
    let mut lc = real_client(&r);
    assert_eq!(lc.submit_window(vec![]), Err(Error::EmptyWindow));
    assert_eq!(lc.finalized(r.epoch), None);
    assert_eq!(lc.finalized(0), None);
}

#[ink::test]
fn rejects_malformed_headers() {
    let r = real();
    let mut lc = real_client(&r);
    let mut w = slice(&r.rlps, 0, 48);
    w[0].pop();
    assert_eq!(lc.submit_window(w), Err(Error::InvalidRlp));
    // A well-formed RLP list that is not a header.
    assert_eq!(lc.submit_window(vec![vec![0xc2, 0x80, 0x80]]), Err(Error::InvalidHeader));
}

// ============================================================================================
// Synthetic chains (test keys, chain id 9797): rotation edges, skipping and expiry.
// ============================================================================================

#[ink::test]
fn rotation_switch_height() {
    let s = syn();
    let mut lc = synth_client("A3000");
    let w = segment("rotation");
    let chain_id = u(&s["chainId"]);
    // E + checkLen = 4039 is still sealed by the old set (here by the outgoing validator) and
    // E + checkLen + 1 = 4040 already by the new one (here by the incoming validator).
    assert_eq!(crate::header::parse(&w[39], chain_id).unwrap().signer, addr(&s["outgoing"]));
    assert_eq!(crate::header::parse(&w[40], chain_id).unwrap().signer, addr(&s["incoming"]));

    assert_eq!(lc.submit_window(w), Ok(4000));
    let now = lc.validator_set();
    assert_eq!((now.epoch, now.active_from), (4000, 4040));
    assert_eq!(now.validators, set("B"));

    // The incoming validator one block early is rejected.
    let mut lc = synth_client("A3000");
    assert_eq!(
        lc.submit_window(segment("rotationIncomingEarly")),
        Err(Error::UnauthorizedSigner(4039, addr(&s["incoming"])))
    );
}

#[ink::test]
fn outgoing_validator_rejected_after_switch() {
    let outgoing = addr(&syn()["outgoing"]);
    let mut lc = synth_client("A3000");
    assert_eq!(lc.submit_window(segment("rotationOutgoingLate")), Err(Error::UnauthorizedSigner(4040, outgoing)));

    lc.submit_window(segment("rotation")).unwrap();
    assert_eq!(lc.submit_window(segment("afterRotationOutgoing")), Err(Error::TooFewSigners(0, 6)));
    assert_eq!(lc.submit_window(segment("afterRotation")), Ok(4100));
}

#[ink::test]
fn skip_epochs_within_trusting_period() {
    let mut lc = synth_client("A1000");
    // No epoch block in the window: epochs 2000, 3000 and 4000 are skipped.
    assert_eq!(lc.submit_window(segment("skip")), Ok(4500));
    assert_eq!(lc.validator_set().epoch, 1000);

    assert_eq!(lc.submit_window(segment("skipEpoch")), Ok(5000));
    let s = lc.validator_set();
    assert_eq!((s.epoch, s.active_from), (5000, 5040));
    assert_eq!(s.epoch_timestamp, u(&syn()["t0"]) + 5000);
    assert_eq!(s.validators, set("A"));
}

#[ink::test]
fn reject_after_trusting_period() {
    let mut lc = synth_client("A1000");
    let s = segment("expiry");
    let deadline = u(&syn()["t0"]) + 1000 + TRUSTING_PERIOD;
    assert_eq!(lc.submit_window(slice(&s, 1, 48)), Err(Error::TrustingPeriodExpired(deadline + 1, deadline)));
    // Exactly at the deadline is still accepted.
    assert_eq!(lc.submit_window(slice(&s, 0, 48)), Ok(1000 + TRUSTING_PERIOD));
}

/// Portaldot's clock, in seconds (pallet-contracts counts milliseconds).
fn set_now(secs: u64) {
    ink::env::test::set_block_timestamp::<ink::env::DefaultEnvironment>(secs * 1000);
}

#[ink::test]
fn trusted_set_expires_on_portaldot_clock() {
    let t = 1_800_000_000;
    set_now(t);
    let mut lc = synth_client("A1000");
    assert_eq!(lc.validator_set().installed_at, t);
    let w = slice(&segment("gas"), 0, 16);
    set_now(t + TRUSTING_PERIOD + 1);
    assert_eq!(lc.submit_window(w.clone()), Err(Error::TrustedSetExpired(t + TRUSTING_PERIOD + 1, t + TRUSTING_PERIOD)));
    set_now(t + TRUSTING_PERIOD);
    assert_eq!(lc.submit_window(w), Ok(1100));
}

#[ink::test]
fn rotation_restarts_the_trusting_period() {
    let (t, day) = (1_800_000_000, 86_400);
    set_now(t);
    let mut lc = synth_client("A1000");
    set_now(t + 6 * day);
    lc.submit_window(segment("rotation")).unwrap(); // 4000: A -> B, installed now
    assert_eq!(lc.validator_set().installed_at, t + 6 * day);
    assert_eq!(lc.previous_validator_set().installed_at, t);
    // Past A's deadline: B still finalizes above 4040, A no longer checks the heights below it.
    set_now(t + 10 * day);
    assert_eq!(lc.submit_window(segment("afterRotation")), Ok(4100));
    assert_eq!(
        lc.submit_window(slice(&segment("gas"), 0, 16)),
        Err(Error::TrustedSetExpired(t + 10 * day, t + TRUSTING_PERIOD))
    );
}

#[ink::test]
fn rotation_after_skipped_epochs() {
    let mut lc = synth_client("A1000");
    assert_eq!(lc.submit_window(segment("rotation")), Ok(4000));
    let s = lc.validator_set();
    assert_eq!((s.epoch, s.active_from), (4000, 4040));
    assert_eq!(s.validators, set("B"));
    assert_eq!(lc.submit_window(segment("afterRotation")), Ok(4100));
}

#[ink::test]
fn window_fails_when_set_changed_too_much() {
    let mut lc = synth_client("A1000");
    assert_eq!(lc.submit_window(segment("tooMuchAfter")), Err(Error::TooFewSigners(3, 6)));
    // The relayer submits the epoch that changed it, then the same window passes.
    assert_eq!(lc.submit_window(segment("tooMuchEpoch")), Ok(2000));
    assert_eq!(lc.validator_set().validators, set("C"));
    assert_eq!(lc.submit_window(segment("tooMuchAfter")), Ok(2100));
}

#[ink::test]
fn rejects_self_certified_epoch() {
    // A forged epoch block announcing an attacker set, sealed by five trusted validators (one
    // short of quorum) and then by six attacker keys. Only trusted signers count.
    let mut lc = synth_client("A1000");
    assert_eq!(lc.submit_window(segment("selfCertified")), Err(Error::TooFewSigners(5, 6)));
}

#[ink::test]
fn rejects_coinbase_mismatch() {
    let mut lc = synth_client("A1000");
    assert_eq!(lc.submit_window(segment("coinbaseMismatch")), Err(Error::CoinbaseMismatch(1110)));
}

#[ink::test]
fn rejects_malleated_seal() {
    let mut lc = synth_client("A1000");
    assert_eq!(lc.submit_window(segment("highS")), Err(Error::InvalidSignature));
}

#[ink::test]
fn ring_overwrite() {
    let mut lc = synth_client("A1000");
    assert_eq!(RING_SIZE, 256);
    let a = slice(&segment("gas"), 0, 16);
    let b = segment("ring");

    lc.submit_window(a.clone()).unwrap();
    assert_eq!(lc.finalized(1100).unwrap().hash, keccak(&a[0]));

    // 1356 = 1100 + 256 takes the same slot.
    lc.submit_window(b.clone()).unwrap();
    assert_eq!(lc.finalized(1356).unwrap().hash, keccak(&b[0]));
    assert_eq!(lc.finalized(1100), None);

    // An evicted header can be finalized again.
    lc.submit_window(a.clone()).unwrap();
    assert_eq!(lc.finalized(1100).unwrap().hash, keccak(&a[0]));
    assert_eq!(lc.finalized(1356), None);
}

#[ink::test]
fn constructor_rejects_bad_checkpoint() {
    let r = real();
    let new = |chain: u64, len: u64, period: u64, cp: Checkpoint| ParliaClient::new(chain, len, period, cp).err();

    let mut cp = r.checkpoint.clone();
    cp.epoch += 1;
    assert_eq!(new(97, 1000, TRUSTING_PERIOD, cp), Some(Error::InvalidCheckpoint));

    let mut cp = r.checkpoint.clone();
    cp.active_from = cp.epoch;
    assert_eq!(new(97, 1000, TRUSTING_PERIOD, cp.clone()), Some(Error::InvalidCheckpoint));
    cp.active_from = cp.epoch + 1000;
    assert_eq!(new(97, 1000, TRUSTING_PERIOD, cp), Some(Error::InvalidCheckpoint));

    let mut cp = r.checkpoint.clone();
    cp.turn_length = 0;
    assert_eq!(new(97, 1000, TRUSTING_PERIOD, cp), Some(Error::InvalidValidatorSet));

    let mut cp = r.checkpoint.clone();
    cp.validators = vec![];
    assert_eq!(new(97, 1000, TRUSTING_PERIOD, cp), Some(Error::InvalidValidatorSet));

    // A set whose switch would not fit inside an epoch (offset 40, epoch length 40).
    let mut cp = r.checkpoint.clone();
    cp.epoch = 40 * 1000;
    cp.active_from = cp.epoch + 1;
    assert_eq!(new(97, 40, TRUSTING_PERIOD, cp), Some(Error::InvalidValidatorSet));

    assert_eq!(new(97, 1000, 0, r.checkpoint.clone()), Some(Error::InvalidCheckpoint));
    assert_eq!(new(0, 1000, TRUSTING_PERIOD, r.checkpoint.clone()), Some(Error::InvalidCheckpoint));
    assert_eq!(new(97, 0, TRUSTING_PERIOD, r.checkpoint.clone()), Some(Error::InvalidCheckpoint));
}

// ============================================================================================
// Storage proofs (the data bridge), on a real eth_getProof result for WBNB on BSC testnet.
// ============================================================================================

/// A client that finalized the block bsc-storage.json's proofs were grabbed at.
fn storage_client() -> (ParliaClient, u64) {
    let s = storage_json();
    let mut lc = deploy(97, 1000, checkpoint(&s["checkpoint"]));
    let number = u(&s["blockNumber"]);
    assert_eq!(lc.submit_window(slice(&list(&s["rlps"]), 0, 48)), Ok(number));
    assert_eq!(lc.finalized(number).unwrap().state_root, h256(&s["stateRoot"]));
    (lc, number)
}

#[ink::test]
fn storage_at_existing_slot() {
    let s = storage_json();
    let (lc, n) = storage_client();
    let e = &s["existing"];
    let got = lc.storage_at(n, addr(&s["account"]), list(&s["accountProof"]), h256(&e["slot"]), list(&e["proof"]));
    assert_eq!(got, Ok(Some(h256(&e["value"]))), "WBNB slot 0 holds its name");
}

#[ink::test]
fn storage_at_absent_slot_and_account() {
    let s = storage_json();
    let (lc, n) = storage_client();
    let a = &s["absent"];
    let got = lc.storage_at(n, addr(&s["account"]), list(&s["accountProof"]), h256(&a["slot"]), list(&a["proof"]));
    assert_eq!(got, Ok(None));
    let a = &s["absentAccount"];
    let got = lc.storage_at(n, addr(&a["account"]), list(&a["accountProof"]), h256(&a["slot"]), list(&a["proof"]));
    assert_eq!(got, Ok(None));
}

#[ink::test]
fn storage_at_rejects_tampered_proofs() {
    let s = storage_json();
    let (lc, n) = storage_client();
    let account = addr(&s["account"]);
    let slot = h256(&s["existing"]["slot"]);
    let account_proof = || list(&s["accountProof"]);
    let storage_proof = || list(&s["existing"]["proof"]);

    // A changed byte in the storage leaf: its parent no longer points at it.
    let mut proof = storage_proof();
    let leaf = proof.last_mut().unwrap();
    let at = leaf.len() - 1;
    leaf[at] ^= 1;
    assert_eq!(lc.storage_at(n, account, account_proof(), slot, proof), Err(Error::IncompleteProof));

    // A changed account node: it no longer hangs from the state root.
    let mut ap = account_proof();
    ap[0][5] ^= 1;
    assert_eq!(lc.storage_at(n, account, ap, slot, storage_proof()), Err(Error::IncompleteProof));

    // A missing node.
    let mut short = storage_proof();
    short.pop();
    assert_eq!(lc.storage_at(n, account, account_proof(), slot, short), Err(Error::IncompleteProof));

    // A block the client has not finalized.
    assert_eq!(
        lc.storage_at(n + 1, account, account_proof(), slot, storage_proof()),
        Err(Error::NotFinalized(n + 1))
    );
}

#[ink::test]
fn storage_at_binds_the_account() {
    // WBNB's proofs, asked about another account: the walk follows that account's key, not
    // WBNB's, so the slot is never reached.
    let s = storage_json();
    let (lc, n) = storage_client();
    let other = addr(&s["absentAccount"]["account"]);
    let got = lc.storage_at(n, other, list(&s["accountProof"]), h256(&s["existing"]["slot"]), list(&s["existing"]["proof"]));
    assert!(matches!(got, Ok(None) | Err(Error::IncompleteProof)), "{got:?}");
    assert_ne!(got, Ok(Some(h256(&s["existing"]["value"]))));
}

#[ink::test]
fn mpt_vectors_from_ethereumjs() {
    let m = load("bsc-mpt-vectors.json");
    let n = u(&m["count"]) as usize;
    for i in 0..n {
        let root = h256(&m["roots"][i]);
        let key = bytes(&m["keys"][i]);
        let want = bytes(&m["values"][i]);
        let proof = list(&m["proofs"][i]);
        let got = mpt::get(&root, &proof, &key).unwrap_or_else(|e| panic!("vector {i} ({}): {e:?}", m["names"][i]));
        assert_eq!(got.map(|v| v.to_vec()).unwrap_or_default(), want, "vector {i} ({})", m["names"][i]);
    }
}
