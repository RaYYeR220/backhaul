/**
 * Writes docs/BENCHMARK.md from results/benchmark.json (packages/sdk/scripts/benchmark.ts).
 * Every number comes from the JSON; a value that is missing there prints as "not measured yet".
 *
 *   npx tsx packages/sdk/scripts/render-benchmark.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const IN = resolve(ROOT, 'results/benchmark.json');
const OUT = resolve(ROOT, 'docs/BENCHMARK.md');
const NM = 'not measured yet';

if (!existsSync(IN)) {
  console.error(`no ${IN}; run packages/sdk/scripts/benchmark.ts first`);
  process.exit(1);
}
const B = JSON.parse(readFileSync(IN, 'utf8'));
const WINDOWS = ['window16', 'window32', 'window48'] as const;

const has = (v: unknown) => v !== null && v !== undefined;
const int = (v: unknown) => (has(v) ? Number(v).toLocaleString('en-US') : NM);
const ms = (ps: unknown) => (has(ps) ? `${(Number(ps) / 1e9).toFixed(3)} ms` : NM);
const kb = (b: unknown) => (has(b) ? `${(Number(b) / 1000).toFixed(1)} kB` : NM);
const tpot = (v: unknown) => (has(v) ? `${v} tPOT` : NM);
const yesNo = (v: unknown) => (has(v) ? (v ? 'yes' : 'no') : NM);
const planckToTpot = (planck: bigint) => (Number(planck) / 1e14).toFixed(2);
const row = (cells: unknown[]) => `| ${cells.map(String).join(' | ')} |`;
const table = (head: string[], rows: unknown[][]) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');

/** Weight per extra header between the 16- and 48-header windows. */
function perHeader(get: (k: string) => unknown): string {
  const a = get('window16');
  const b = get('window48');
  return has(a) && has(b) ? String((Number(b) - Number(a)) / 32) : '';
}

const lines: string[] = [];
const p = (...xs: string[]) => lines.push(...xs);

p(
  '# Benchmark: the Parlia light client on EVM and on WASM',
  '',
  `Generated from \`results/benchmark.json\` (${B.generatedAt}) by \`packages/sdk/scripts/render-benchmark.ts\`. Do not edit by hand.`,
  '',
  'The same BSC light client runs twice on Portaldot: `ParliaClient.sol` on pallet-revive (EVM) and its ink! twin',
  '`ink/parlia_client` on pallet-contracts (WASM). Both get byte-identical inputs: real BSC testnet headers and a real',
  'storage proof. `packages/sdk/scripts/benchmark.ts` builds the inputs, collects the local measurements and dry-runs',
  'the deployed contracts; it never sends a transaction.',
  '',
  '## Inputs',
  '',
  `Source: ${B.inputs.source}.`,
  '',
  table(
    ['input', 'headers', 'first BSC block', 'header RLP / proof', 'EVM calldata', 'ink! input (SCALE)'],
    [
      ...WINDOWS.map((k) => {
        const i = B.inputs[k];
        return [k, i.headers, int(i.firstBlock), kb(i.rlpBytes), kb(i.evmCalldataBytes), kb(i.inkInputBytes)];
      }),
      ['storageProof', '—', int(B.inputs.storageProof.blockNumber), `${B.inputs.storageProof.accountProofNodes} + ${B.inputs.storageProof.storageProofNodes} nodes`, kb(B.inputs.storageProof.evmCalldataBytes), kb(B.inputs.storageProof.inkInputBytes)],
    ],
  ),
  '',
  'With 9 validators and a turn length of 8, a window needs about 41–48 headers to hold seals from 6 distinct validators,',
  'so only the 48-header window finalizes; the 16- and 32-header ones verify every seal and then stop at the quorum',
  'check. Portaldot charges a length fee per byte of the extrinsic, which the input sizes above drive.',
  '',
);

p('## Live on Portaldot (dry-runs of the deployed contracts)', '');
const c = B.chain;
if (c?.window) {
  p(
    `Fresh window from BSC block ${int(c.window.firstBlock)} (quorum after ${c.window.quorumAfter} headers), dry-run ${c.at} on ${c.runtime}.`,
    `EVM client \`${c.window.evmClient}\`, ink! client \`${c.window.inkClient}\`.`,
    '',
  );
} else {
  p('No live dry-run yet: both clients must be deployed first (`npm run deploy -- --env <secrets> --chain portaldot --with-ink`).', '');
}
const side = (s: any) => [ms(s?.refTime), int(s?.proofSize), has(s?.gas) ? int(s.gas) : NM, tpot(s?.fee), yesNo(s?.finalizes)];
p(
  table(
    ['input', 'EVM refTime', 'EVM proofSize (B)', 'EVM gas (revive)', 'EVM fee', 'EVM finalizes', 'WASM refTime', 'WASM proofSize (B)', 'WASM fee', 'WASM finalizes'],
    [...WINDOWS, 'storageProof'].map((k) => {
      const e = side(B[k]?.evm);
      const w = side(B[k]?.wasm);
      return [k, ...e, w[0], w[1], w[3], w[4]];
    }),
  ),
  '',
  'Fee = the transaction fee (weight + length) from `paymentInfo` plus any storage deposit the call charges. EVM gas is',
  "pallet-revive's `gasConsumed` from the same dry-run.",
  '',
);
if (c?.inkUpload) {
  const u = c.inkUpload;
  p(
    `**Can the chain take the ink! code?** \`ContractsApi_upload_code\` dry-run of the ${int(u.wasmBytes)}-byte build at ${c.at}: ` +
      (u.ok ? `accepted, code deposit ${planckToTpot(BigInt(u.deposit))} tPOT.` : `\`${u.error}\`${u.debugMessage ? ` ("${u.debugMessage}")` : ''}.`) +
      ` Control, a minimal valid module (one memory import, empty \`call\` and \`deploy\`): ${u.minimalModule?.ok ? 'accepted' : `\`${u.minimalModule?.error}\``}.`,
    '',
  );
}

p('## Local measurements (same inputs)', '');
p(
  table(
    ['input', 'EVM gas (forge)', 'EVM execution gas', 'EVM finalizes', 'WASM refTime (sandbox)', 'WASM proofSize (B)', 'WASM finalizes'],
    [...WINDOWS, 'storageProof'].map((k) => {
      const e = B.local?.[k]?.evm;
      const w = B.local?.[k]?.wasm;
      return [k, int(e?.gas), int(e?.executionGas), k === 'storageProof' ? '—' : yesNo(e?.finalizes), ms(w?.refTime), int(w?.proofSize), k === 'storageProof' ? '—' : yesNo(w?.finalizes)];
    }),
  ),
  '',
);
const evmPer = perHeader((k) => B.local?.[k]?.evm?.executionGas);
const wasmPer = perHeader((k) => B.local?.[k]?.wasm?.refTime);
if (evmPer || wasmPer) {
  p(
    `Per extra header (48 vs 16): ${evmPer ? `${int(Math.round(Number(evmPer)))} EVM gas` : NM}; ${wasmPer ? `${ms(Number(wasmPer))} of WASM refTime` : NM}.`,
    '',
  );
}
p(
  `- EVM: ${B.local?.evmNote ?? NM}`,
  `- WASM: ${B.local?.wasmNote ?? NM}`,
  '- EVM gas and WASM weight are different units: the local numbers compare each VM with itself across window sizes; the live dry-runs above compare the two in Portaldot weight and tPOT.',
  '',
);

p('## Code size and deposit', '');
const perByte = c?.contracts ? BigInt(c.contracts.depositPerByte) : undefined;
const revivePerByte = c?.revive ? BigInt(c.revive.depositPerByte) : undefined;
p(
  table(
    ['build', 'code bytes', 'code deposit at the chain\'s DepositPerByte'],
    [
      [`${B.code.evm.contract} (${B.code.evm.profile})`, int(B.code.evm.bytes), has(B.code.evm.bytes) && revivePerByte !== undefined ? `${planckToTpot(BigInt(B.code.evm.bytes) * revivePerByte)} tPOT` : NM],
      [B.code.wasm.contract, int(B.code.wasm.bytes), has(B.code.wasm.bytes) && perByte !== undefined ? `${planckToTpot(BigInt(B.code.wasm.bytes) * perByte)} tPOT` : NM],
    ],
  ),
  '',
  c?.contracts
    ? `DepositPerByte ${planckToTpot(BigInt(c.contracts.depositPerByte))} tPOT, DepositPerItem ${planckToTpot(BigInt(c.contracts.depositPerItem))} tPOT, code-hash lockup ${c.contracts.codeHashLockupDepositPercent} (read from the chain ${c.at}). The instantiating account also locks that share of the code deposit.`
    : `Chain deposit constants: ${NM}.`,
  '',
);

if (B.notes?.length) p('## Notes', '', ...B.notes.map((n: string) => `- ${n}`), '');

mkdirSync(resolve(ROOT, 'docs'), { recursive: true });
writeFileSync(OUT, lines.join('\n'));
console.log(`wrote ${OUT}`);
