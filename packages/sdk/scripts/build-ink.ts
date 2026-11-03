/**
 * Release build of the ink! twin (ink/parlia_client), the one the deploy and the benchmark use.
 *
 *   npx tsx packages/sdk/scripts/build-ink.ts
 *
 * ink! reads a message's input into a static buffer of INK_STATIC_BUFFER_SIZE bytes (16 KiB by
 * default, fixed when ink_env is compiled). A 48-header Parlia window is about 45 KB, so the build
 * sets 64 KiB; with the default the contract would refuse every real window (OutputBufferTooSmall).
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { INK_ARTIFACT_DIR, INK_CRATE_DIR, loadInkArtifact } from '../src/ink/parlia.js';

export const INK_STATIC_BUFFER_SIZE = '65536';

// ink_env does not rebuild when the variable changes, so start from a clean wasm target.
rmSync(INK_ARTIFACT_DIR, { recursive: true, force: true });
const r = spawnSync('cargo', ['contract', 'build', '--release'], {
  cwd: INK_CRATE_DIR,
  stdio: 'inherit',
  env: { ...process.env, INK_STATIC_BUFFER_SIZE },
  shell: process.platform === 'win32',
});
if (r.status !== 0) process.exit(r.status ?? 1);
const a = loadInkArtifact();
console.log(`${resolve(a.path)}: ${a.bytes} bytes, code hash ${a.codeHash}`);
