// The one place `init` keeps your prepaid key: ~/.offrouter/config.json, readable by you only.
// Coding agents are pointed at the local proxy with a placeholder key, so the real key is not
// copied into every agent's config. An OFFROUTER_API_KEY in the environment always wins.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Saved = { apiKey?: string; model?: string; port?: number };

export const storeDir = (home = homedir()) => join(process.env.OFFROUTER_HOME || join(home, '.offrouter'));
export const storePath = (home?: string) => join(storeDir(home), 'config.json');

export function readSaved(home?: string): Saved {
  try {
    const v = JSON.parse(readFileSync(storePath(home), 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export async function writeSaved(next: Saved, home?: string): Promise<string> {
  const path = storePath(home);
  await mkdir(storeDir(home), { recursive: true, mode: 0o700 });
  let current: Saved = {};
  try {
    current = JSON.parse(await readFile(path, 'utf8'));
  } catch {}
  await writeFile(path, JSON.stringify({ ...current, ...next }, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

/** The environment with the saved key filled in where none is set. */
export function withSaved(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const saved = readSaved();
  if (!saved.apiKey || env.OFFROUTER_API_KEY || env.OFFROUTER_WALLET_KEY) return env;
  return { ...env, OFFROUTER_API_KEY: saved.apiKey };
}
