//! Off-chain weight of the parlia_client wasm: runs the release build inside pallet-contracts
//! in-process (ink_sandbox, pallet-contracts 38 with the reference weights) on the same inputs the
//! EVM side gets in contracts/test/portaldot/ParliaBenchmark.t.sol, and writes
//! results/benchmark-wasm-local.json.
//!
//!   cargo run --release            (after `cargo contract build --release` in ../parlia_client)
//!
//! It is an estimate: the weights are pallet-contracts' reference benchmarks, not Portaldot's own
//! runtime, and the sandbox prices storage at 1 unit per byte plus 1 per item.

use ink_sandbox::{
    api::prelude::*,
    pallet_contracts::{Determinism, ExecReturnValue, StorageDeposit},
    DefaultSandbox, Sandbox, Weight,
};
use parity_scale_codec::Encode;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Encode, Clone)]
struct Checkpoint {
    epoch: u64,
    timestamp: u64,
    active_from: u64,
    turn_length: u8,
    validators: Vec<[u8; 20]>,
}

/// Portaldot's max extrinsic weight (1.7 s) and a generous proof size.
fn gas_limit() -> Weight {
    Weight::from_parts(1_700_000_000_000, 10 * 1024 * 1024)
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn load(rel: &str) -> Value {
    let p = root().join(rel);
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))).unwrap()
}

fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap().trim_start_matches("0x")).unwrap()
}

fn list(v: &Value) -> Vec<Vec<u8>> {
    v.as_array().unwrap().iter().map(bytes).collect()
}

fn checkpoint(v: &Value) -> Checkpoint {
    Checkpoint {
        epoch: v["epoch"].as_u64().unwrap(),
        timestamp: v["timestamp"].as_u64().unwrap(),
        active_from: v["activeFrom"].as_u64().unwrap(),
        turn_length: v["turnLength"].as_u64().unwrap() as u8,
        validators: v["validators"].as_array().unwrap().iter().map(|a| bytes(a).try_into().unwrap()).collect(),
    }
}

/// Selector of a constructor or message, from the metadata cargo-contract wrote.
fn selector(meta: &Value, label: &str) -> Vec<u8> {
    let spec = &meta["spec"];
    let mut all = spec["constructors"].as_array().unwrap().iter().chain(spec["messages"].as_array().unwrap());
    let m = all.find(|m| m["label"] == label).unwrap_or_else(|| panic!("no {label} in the metadata"));
    bytes(&m["selector"])
}

fn deposit_of(d: &StorageDeposit<u128>) -> i128 {
    match d {
        StorageDeposit::Charge(x) => *x as i128,
        StorageDeposit::Refund(x) => -(*x as i128),
    }
}

fn weight_json(consumed: Weight, required: Weight, deposit: i128, ret: &ExecReturnValue) -> Value {
    json!({
        "refTime": consumed.ref_time(),
        "proofSize": consumed.proof_size(),
        "refTimeRequired": required.ref_time(),
        "proofSizeRequired": required.proof_size(),
        "storageDepositUnits": deposit,
        "reverted": ret.did_revert(),
        "returnData": format!("0x{}", hex::encode(&ret.data)),
    })
}

fn main() {
    let artifacts = root().join("ink/parlia_client/target/ink");
    let wasm = std::fs::read(artifacts.join("parlia_client.wasm"))
        .expect("run `cargo contract build --release` in ink/parlia_client first");
    let meta: Value = serde_json::from_str(&std::fs::read_to_string(artifacts.join("parlia_client.json")).unwrap()).unwrap();
    let headers = load("contracts/test/fixtures/bsc-headers.json");
    let storage = load("contracts/test/fixtures/bsc-storage.json");
    let rlps = list(&headers["rlps"]);

    let mut sb = DefaultSandbox::default();
    let origin = DefaultSandbox::default_actor();

    let up = sb.upload_contract(wasm.clone(), origin.clone(), None, Determinism::Enforced).expect("upload");
    let code_hash = up.code_hash;

    let mut salt = 0u32;
    let mut instantiate = |sb: &mut DefaultSandbox, cp: Checkpoint| {
        salt += 1;
        let mut data = selector(&meta, "new");
        (97u64, 1000u64, 7u64 * 86_400, cp).encode_to(&mut data);
        let r = sb.instantiate_contract(code_hash.as_ref().to_vec(), 0, data, salt.encode(), origin.clone(), gas_limit(), None);
        let ok = r.result.expect("instantiate");
        assert!(!ok.result.did_revert(), "constructor reverted");
        (ok.account_id, r.gas_consumed, deposit_of(&r.storage_deposit))
    };

    let real_cp = checkpoint(&headers["checkpoint"]);
    let (_, ctor_gas, ctor_deposit) = instantiate(&mut sb, real_cp.clone());
    let mut windows = serde_json::Map::new();
    for count in [16usize, 32, 48] {
        let (addr, _, _) = instantiate(&mut sb, real_cp.clone());
        let w: Vec<Vec<u8>> = rlps[2..2 + count].to_vec();
        let mut data = selector(&meta, "submit_window");
        w.encode_to(&mut data);
        let input_bytes = data.len();
        let r = sb.call_contract(addr, 0, data, origin.clone(), gas_limit(), None, Determinism::Enforced);
        let ret = r.result.expect("call");
        let mut j = weight_json(r.gas_consumed, r.gas_required, deposit_of(&r.storage_deposit), &ret);
        j["headers"] = json!(count);
        j["inputBytes"] = json!(input_bytes);
        // Result<Result<u64, Error>, LangError>: 00 00 ‖ number = finalized
        j["finalizes"] = json!(ret.data.get(..2) == Some(&[0u8, 0][..]));
        windows.insert(format!("window{count}"), j);
    }

    // storage_at on the WBNB proof, after finalizing its block.
    let (addr, _, _) = instantiate(&mut sb, checkpoint(&storage["checkpoint"]));
    let mut data = selector(&meta, "submit_window");
    list(&storage["rlps"])[..48].to_vec().encode_to(&mut data);
    let r = sb.call_contract(addr.clone(), 0, data, origin.clone(), gas_limit(), None, Determinism::Enforced);
    assert_eq!(r.result.expect("window").data.get(..2), Some(&[0u8, 0][..]), "the storage window must finalize");
    let account: [u8; 20] = bytes(&storage["account"]).try_into().unwrap();
    let slot: [u8; 32] = bytes(&storage["existing"]["slot"]).try_into().unwrap();
    let mut data = selector(&meta, "storage_at");
    (storage["blockNumber"].as_u64().unwrap(), account, list(&storage["accountProof"]), slot, list(&storage["existing"]["proof"]))
        .encode_to(&mut data);
    let input_bytes = data.len();
    let r = sb.call_contract(addr, 0, data, origin.clone(), gas_limit(), None, Determinism::Enforced);
    let ret = r.result.expect("storage_at");
    assert_eq!(&ret.data[..3], &[0, 0, 1], "storage_at must return Ok(Some(value))");
    assert_eq!(ret.data[3..].to_vec(), bytes(&storage["existing"]["value"]), "proven value");
    let mut proof = weight_json(r.gas_consumed, r.gas_required, deposit_of(&r.storage_deposit), &ret);
    proof["inputBytes"] = json!(input_bytes);

    let out = json!({
        "note": "ink_sandbox 5.1.1: pallet-contracts 38 with its reference WeightInfo and default Schedule, running the release wasm in-process. \
                 refTime in picoseconds, proofSize in bytes. storageDepositUnits count 1 per byte plus 1 per item (the sandbox's deposit prices).",
        "wasmBytes": wasm.len(),
        "codeUploadDepositUnits": up.deposit,
        "constructor": { "refTime": ctor_gas.ref_time(), "proofSize": ctor_gas.proof_size(), "storageDepositUnits": ctor_deposit },
        "windows": Value::Object(windows),
        "storageProof": proof,
    });
    let path = root().join("results/benchmark-wasm-local.json");
    std::fs::write(&path, serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
    println!("wrote {}", path.display());
}
