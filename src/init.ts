// `npx @offrouter/mcp init`: set up private mode for the coding agents on this machine.
//
// 1. Check a prepaid key against OffRouter and keep it in ~/.offrouter/config.json.
// 2. Pick a default model from the ones that take end to end encryption.
// 3. Point every agent we can configure safely at the local proxy, with a backup of each file
//    we change; print exact steps for the ones whose settings live where we shouldn't write.
import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { OffRouter, type Model } from './client.js';
import { loadConfig } from './config.js';
import { DEFAULT_PORT } from './proxy.js';
import { readSaved, writeSaved } from './store.js';

export type InitOptions = { key?: string; model?: string; port?: number; yes?: boolean; home?: string };

/** Models we'd suggest for coding, best first, when the catalog has them. */
const PREFERRED = ['glm-5.3', 'kimi-k3.1-pro', 'qwen3.5-397b', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'gpt-oss-120b'];
export const PLACEHOLDER_KEY = 'offrouter-private-mode';

export function pickDefault(models: Model[]): Model | undefined {
  for (const id of PREFERRED) {
    const m = models.find((x) => x.id === id);
    if (m) return m;
  }
  return models[0];
}

const price = (m: Model) => `$${m.input_usdc_per_mtok} in / $${m.output_usdc_per_mtok} out per 1M`;

// ---- OpenCode -------------------------------------------------------------------------------

export function opencodePath(home = homedir()): string {
  const dir = process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'opencode') : join(home, '.config', 'opencode');
  return join(dir, 'opencode.json');
}

/** OpenCode's config with an "offrouter" provider pointing at the proxy. Everything else is kept. */
export function opencodeConfig(current: any, opts: { baseUrl: string; models: Model[]; makeDefault?: string }): any {
  const next = { ...(current ?? {}) };
  if (!next.$schema) next.$schema = 'https://opencode.ai/config.json';
  next.provider = { ...(next.provider ?? {}) };
  next.provider.offrouter = {
    npm: '@ai-sdk/openai-compatible',
    name: 'OffRouter (private mode)',
    options: { baseURL: opts.baseUrl, apiKey: PLACEHOLDER_KEY },
    models: Object.fromEntries(
      opts.models.map((m) => [m.id, { name: `${m.id} (private)`, limit: { context: m.context_length, output: Math.min(32_768, Math.floor(m.context_length / 4)) } }]),
    ),
  };
  if (opts.makeDefault) next.model = `offrouter/${opts.makeDefault}`;
  return next;
}

// ---- Snippets for agents we don't write to ---------------------------------------------------

export function snippets(baseUrl: string, model: string): { name: string; text: string }[] {
  return [
    {
      name: 'Codex CLI (~/.codex/config.toml)',
      text: [
        '[model_providers.offrouter]',
        'name = "OffRouter (private mode)"',
        `base_url = "${baseUrl}"`,
        'wire_api = "chat"',
        '',
        '[profiles.private]',
        'model_provider = "offrouter"',
        `model = "${model}"`,
        '',
        '# then: codex --profile private',
      ].join('\n'),
    },
    {
      name: 'Continue (~/.continue/config.yaml, under models:)',
      text: [`  - name: OffRouter ${model} (private)`, '    provider: openai', `    model: ${model}`, `    apiBase: ${baseUrl}`, `    apiKey: ${PLACEHOLDER_KEY}`].join('\n'),
    },
    {
      name: 'Cline, Roo Code, Kilo Code',
      text: [`API Provider: OpenAI Compatible`, `Base URL:     ${baseUrl}`, `API Key:      ${PLACEHOLDER_KEY}`, `Model ID:     ${model}`].join('\n'),
    },
    {
      name: 'Aider',
      text: `aider --openai-api-base ${baseUrl} --openai-api-key ${PLACEHOLDER_KEY} --model openai/${model}`,
    },
  ];
}

const has = (bin: string) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// ---- The command ----------------------------------------------------------------------------

export async function runInit(opts: InitOptions = {}): Promise<{ port: number; start: boolean }> {
  const out = (s = '') => process.stdout.write(s + '\n');
  const interactive = !opts.yes && process.stdin.isTTY;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q: string, fallback = '') => (rl ? (await rl.question(q)).trim() || fallback : fallback);
  const yes = async (q: string, dflt = true) => {
    if (!rl) return dflt;
    const a = (await rl.question(`${q} ${dflt ? '(Y/n)' : '(y/N)'} `)).trim().toLowerCase();
    return a ? a.startsWith('y') : dflt;
  };

  try {
    out('OffRouter private mode');
    out('Your coding agent talks to a proxy on this machine, which encrypts every message to an');
    out('attested GPU enclave before it leaves. The gateway in between only sees ciphertext.');
    out();

    // 1. The key.
    const saved = readSaved(opts.home);
    let key = opts.key || process.env.OFFROUTER_API_KEY || saved.apiKey || '';
    if (!key) {
      out('You need a prepaid key. Fund one with a wallet at https://offrouter.org/dashboard');
      key = await ask('Paste your key (off_sk_...): ');
    }
    if (!key.startsWith('off_sk_')) throw new Error('A key starts with off_sk_. Get one at https://offrouter.org/dashboard and run init again.');
    const config = loadConfig({ ...process.env, OFFROUTER_API_KEY: key, OFFROUTER_WALLET_KEY: '' });
    const api = new OffRouter(config);
    let info: any;
    try {
      info = await api.keyInfo();
    } catch (e) {
      throw new Error(`OffRouter did not accept that key: ${(e as Error).message}`);
    }
    const balance = info?.balance_usdc ?? info?.balance ?? info?.key?.balance_usdc;
    out(`Key OK${balance != null ? `, balance $${Number(balance).toFixed(4)}` : ''}.`);
    const path = await writeSaved({ apiKey: key }, opts.home);
    out(`Saved to ${path} (only you can read it).`);
    out();

    // 2. The model.
    const models = (await api.listModels()).filter((m) => m.e2ee?.model);
    if (!models.length) throw new Error('OffRouter lists no model with end to end encryption right now. Try again later.');
    let model = models.find((m) => m.id === (opts.model ?? saved.model)) ?? pickDefault(models)!;
    if (opts.model && model.id !== opts.model) out(`${opts.model} does not take end to end encryption, using ${model.id}.`);
    if (rl && !opts.model) {
      out('Models with end to end encryption:');
      models.forEach((m, i) => out(`  ${String(i + 1).padStart(2)}. ${m.id.padEnd(22)} ${price(m)}${m.id === model.id ? '  (suggested)' : ''}`));
      const pick = await ask(`Default model [${model.id}]: `);
      const chosen = /^\d+$/.test(pick) ? models[Number(pick) - 1] : models.find((m) => m.id === pick);
      if (chosen) model = chosen;
    }
    const port = opts.port ?? saved.port ?? DEFAULT_PORT;
    await writeSaved({ model: model.id, port }, opts.home);
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    out(`Default model: ${model.id}. Proxy address: ${baseUrl}`);
    out();

    // 3. The agents.
    const ocPath = opencodePath(opts.home);
    if (existsSync(dirname(ocPath)) || has('opencode')) {
      let current: any = {};
      let readable = true;
      if (existsSync(ocPath)) {
        try {
          current = JSON.parse(await readFile(ocPath, 'utf8'));
        } catch {
          readable = false;
        }
      }
      if (!readable) {
        out(`OpenCode: ${ocPath} has comments or is not plain JSON, so it was left alone. Add this under "provider":`);
        out(JSON.stringify({ offrouter: opencodeConfig({}, { baseUrl, models }).provider.offrouter }, null, 2));
      } else if (await yes(`OpenCode found. Add OffRouter private mode to ${ocPath}?`)) {
        const makeDefault = (await yes(`Make offrouter/${model.id} OpenCode's default model?`, !!rl)) ? model.id : undefined;
        await mkdir(dirname(ocPath), { recursive: true });
        if (existsSync(ocPath)) await copyFile(ocPath, `${ocPath}.bak`);
        await writeFile(ocPath, JSON.stringify(opencodeConfig(current, { baseUrl, models, makeDefault }), null, 2) + '\n');
        out(`OpenCode: done${existsSync(`${ocPath}.bak`) ? ` (backup at ${ocPath}.bak)` : ''}. Pick "OffRouter (private mode)" with /models.`);
      }
      out();
    }

    out('Other agents: add these yourself (their settings live where we should not write).');
    for (const s of snippets(baseUrl, model.id)) {
      out();
      out(`  ${s.name}`);
      out(s.text.split('\n').map((l) => `    ${l}`).join('\n'));
    }
    out();
    out('  Cursor and Claude Code: their requests go through their own servers or speak a');
    out('  different API, so private mode can not sit under them. Use the MCP server instead');
    out('  for private second opinions: claude mcp add offrouter -- npx -y @offrouter/mcp');
    out();
    out('What is encrypted: every message, including the files your agent reads (tool results).');
    out('What is not: tool definitions, the arguments of tool calls (e.g. code written through an');
    out('edit tool), the model name and settings. Those reach the gateway in the clear, and the');
    out('enclave still serves them without storing anything.');
    out();

    const start = await yes('Start private mode now?', false);
    if (!start) out(`Start it whenever you code: npx -y @offrouter/mcp proxy${port !== DEFAULT_PORT ? ` --port ${port}` : ''}`);
    return { port, start };
  } finally {
    rl?.close();
  }
}
