/**
 * Runs every test suite in the repo and writes results/test-counts.json, which the docs render.
 *
 *   npm run test:counts                 # forge, sdk vitest, relayer vitest, ink! cargo test
 *   npm run test:counts -- --only sdk   # one suite (forge | sdk | relayer | ink); the others are kept
 *
 * A suite that cannot run (tool missing, build error) is recorded with its error and no counts,
 * so the docs say "not measured" instead of a stale or made-up number.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = resolve(ROOT, 'results/test-counts.json');
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined;

interface SuiteCount {
  command: string;
  cwd: string;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  total: number | null;
  /** Test files (vitest) or test contracts (forge). */
  files?: number | null;
  ms: number;
  error?: string;
}

function run(cmd: string, args: string[], cwd: string): { out: string; code: number; ms: number } {
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return { out: String(r.error.message), code: 1, ms: Date.now() - t };
  return { out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, code: r.status ?? 1, ms: Date.now() - t };
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const tail = (s: string) => strip(s).trim().split(/\r?\n/).slice(-6).join(' | ').slice(0, 400);

/** `forge test`: "Ran 31 test suites in 9.1s (...): 249 tests passed, 0 failed, 0 skipped (249 total tests)". */
function forge(): SuiteCount {
  const cwd = 'contracts';
  const r = run('forge', ['test'], resolve(ROOT, cwd));
  const m = strip(r.out).match(/Ran (\d+) test suites?.*?: (\d+) tests? passed, (\d+) failed, (\d+) skipped \((\d+) total tests?\)/);
  if (!m) return { command: 'forge test', cwd, passed: null, failed: null, skipped: null, total: null, ms: r.ms, error: tail(r.out) };
  return { command: 'forge test', cwd, files: +m[1], passed: +m[2], failed: +m[3], skipped: +m[4], total: +m[5], ms: r.ms };
}

/** vitest with its JSON reporter written to a temp file. */
function vitest(cwd: string): SuiteCount {
  const dir = mkdtempSync(join(tmpdir(), 'backhaul-vitest-'));
  const file = join(dir, 'report.json');
  try {
    const bin = resolve(ROOT, 'node_modules/vitest/vitest.mjs');
    const r = run(process.execPath, [bin, 'run', '--reporter=json', `--outputFile=${file}`], resolve(ROOT, cwd));
    const command = 'vitest run';
    if (!existsSync(file)) return { command, cwd, passed: null, failed: null, skipped: null, total: null, ms: r.ms, error: tail(r.out) };
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return {
      command,
      cwd,
      files: Array.isArray(j.testResults) ? j.testResults.length : null,
      passed: j.numPassedTests,
      failed: j.numFailedTests,
      skipped: (j.numPendingTests ?? 0) + (j.numTodoTests ?? 0),
      total: j.numTotalTests,
      ms: r.ms,
      ...(j.success === false && j.numFailedTests === 0 ? { error: tail(r.out) } : {}),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `cargo test --release`: sums every "test result: ok. N passed; F failed; I ignored" line. */
function ink(): SuiteCount {
  const cwd = 'ink/parlia_client';
  const r = run('cargo', ['test', '--release'], resolve(ROOT, cwd));
  const lines = [...strip(r.out).matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  const command = 'cargo test --release';
  if (!lines.length) return { command, cwd, passed: null, failed: null, skipped: null, total: null, ms: r.ms, error: tail(r.out) };
  const sum = (i: number) => lines.reduce((a, m) => a + Number(m[i]), 0);
  const [passed, failed, skipped] = [sum(1), sum(2), sum(3)];
  return { command, cwd, passed, failed, skipped, total: passed + failed + skipped, ms: r.ms };
}

const SUITES: Record<string, () => SuiteCount> = {
  forge,
  sdk: () => vitest('packages/sdk'),
  relayer: () => vitest('services/relayer'),
  ink,
};

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { suites: {} };
const suites: Record<string, SuiteCount> = { ...prev.suites };
for (const [name, fn] of Object.entries(SUITES)) {
  if (only && only !== name) continue;
  process.stdout.write(`${name}: running… `);
  const c = fn();
  suites[name] = c;
  console.log(c.error ? `could not count (${c.error})` : `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped (${(c.ms / 1000).toFixed(0)} s)`);
}

const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const vals = Object.values(suites);
const known = vals.every((s) => s.passed !== null);
const out = {
  at: new Date().toISOString(),
  commit: git || null,
  suites,
  total: known ? vals.reduce((a, s) => a + (s.total ?? 0), 0) : null,
  passed: known ? vals.reduce((a, s) => a + (s.passed ?? 0), 0) : null,
  failed: known ? vals.reduce((a, s) => a + (s.failed ?? 0), 0) : null,
  skipped: known ? vals.reduce((a, s) => a + (s.skipped ?? 0), 0) : null,
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${OUT}`);
if (vals.some((s) => s.failed)) process.exitCode = 1;
