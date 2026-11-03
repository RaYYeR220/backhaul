# Benchmark: the Parlia light client on EVM and on WASM

Generated from `results/benchmark.json` (2026-11-03T19:22:49.017Z) by `packages/sdk/scripts/render-benchmark.ts`. Do not edit by hand.

The same BSC light client runs twice on Portaldot: `ParliaClient.sol` on pallet-revive (EVM) and its ink! twin
`ink/parlia_client` on pallet-contracts (WASM). Both get byte-identical inputs: real BSC testnet headers and a real
storage proof. `packages/sdk/scripts/benchmark.ts` builds the inputs, collects the local measurements and dry-runs
the deployed contracts; it never sends a transaction.

## Inputs

Source: bsc-headers.json (BSC testnet, epoch 140342000, from E+2) and bsc-storage.json (WBNB slot 0).

| input | headers | first BSC block | header RLP / proof | EVM calldata | ink! input (SCALE) |
| --- | --- | --- | --- | --- | --- |
| window16 | 16 | 140,342,002 | 14.3 kB | 15.5 kB | 14.3 kB |
| window32 | 32 | 140,342,002 | 28.6 kB | 30.9 kB | 28.7 kB |
| window48 | 48 | 140,342,002 | 42.9 kB | 46.3 kB | 43.0 kB |
| storageProof | — | 140,468,572 | 11 + 6 nodes | 7.6 kB | 6.2 kB |

With 9 validators and a turn length of 8, a window needs about 41–48 headers to hold seals from 6 distinct validators,
so only the 48-header window finalizes; the 16- and 32-header ones verify every seal and then stop at the quorum
check. Portaldot charges a length fee per byte of the extrinsic, which the input sizes above drive.

## Live on Portaldot (dry-runs of the deployed contracts)

No live dry-run yet: both clients must be deployed first (`npm run deploy -- --env <secrets> --chain portaldot --with-ink`).

| input | EVM refTime | EVM proofSize (B) | EVM gas (revive) | EVM fee | EVM finalizes | WASM refTime | WASM proofSize (B) | WASM fee | WASM finalizes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| window16 | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet |
| window32 | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet |
| window48 | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet |
| storageProof | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet |

Fee = the transaction fee (weight + length) from `paymentInfo` plus any storage deposit the call charges. EVM gas is
pallet-revive's `gasConsumed` from the same dry-run.

**Can the chain take the ink! code?** `ContractsApi_upload_code` dry-run of the 20,088-byte build at 2026-11-03T19:22:48.056Z: `contracts.CodeRejected` ("Can't load the module into wasmi!"). Control, a minimal valid module (one memory import, empty `call` and `deploy`): `contracts.CodeRejected`.

## Local measurements (same inputs)

| input | EVM gas (forge) | EVM execution gas | EVM finalizes | WASM refTime (sandbox) | WASM proofSize (B) | WASM finalizes |
| --- | --- | --- | --- | --- | --- | --- |
| window16 | 811,732 | 610,060 | no | 4.441 ms | 22,859 | no |
| window32 | 1,555,098 | 1,177,358 | no | 8.156 ms | 25,019 | no |
| window48 | 2,379,410 | 1,827,194 | yes | 12.323 ms | 30,837 | yes |
| storageProof | 413,570 | 288,914 | — | 1.375 ms | 21,260 | — |

Per extra header (48 vs 16): 38,035 EVM gas; 0.246 ms of WASM refTime.

- EVM: forge, solc 0.8.28 via-IR optimizer 200 (the Portaldot size profile changes code size, not these counts). executionGas = vm.lastCallGas on a fresh client; intrinsicGas = 21000 + 16/4 per non-zero/zero calldata byte.
- WASM: ink_sandbox 5.1.1: pallet-contracts 38 with its reference WeightInfo and default Schedule, running the release wasm in-process. refTime in picoseconds, proofSize in bytes. storageDepositUnits count 1 per byte plus 1 per item (the sandbox's deposit prices).
- EVM gas and WASM weight are different units: the local numbers compare each VM with itself across window sizes; the live dry-runs above compare the two in Portaldot weight and tPOT.

## Code size and deposit

| build | code bytes | code deposit at the chain's DepositPerByte |
| --- | --- | --- |
| ParliaClient.sol (portaldot (optimizer_runs 1, no metadata)) | 5,672 | 340.32 tPOT |
| ink/parlia_client | 20,088 | 1205.28 tPOT |

DepositPerByte 0.06 tPOT, DepositPerItem 0.15 tPOT, code-hash lockup 30.00% (read from the chain 2026-11-03T19:22:48.056Z). The instantiating account also locks that share of the code deposit.

## Notes

- Live dry-runs need both clients deployed; ParliaClient and the ink! client (meta.parliaClientInk) missing at 2026-11-03T19:22:48.056Z.
