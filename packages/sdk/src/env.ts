// Minimal .env loading: KEY=VALUE lines, `#` comments, optional quotes. Values already in
// process.env win, so a shell override always beats the file.

import { existsSync, readFileSync } from 'node:fs';

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Loads `path` into process.env (without overwriting). Returns the keys it found. */
export function loadEnvFile(path: string): string[] {
  if (!existsSync(path)) throw new Error(`env file not found: ${path}`);
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return Object.keys(parsed);
}

/** `--env <path>` from argv, else $BACKHAUL_ENV, else `.env` in the working directory if present. */
export function loadEnvFromArgs(argv: string[] = process.argv): string | undefined {
  const i = argv.indexOf('--env');
  const path = i >= 0 ? argv[i + 1] : (process.env.BACKHAUL_ENV ?? (existsSync('.env') ? '.env' : undefined));
  if (!path) return undefined;
  loadEnvFile(path);
  return path;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
