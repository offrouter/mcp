// Private mode against a fake gateway that plays the enclave: it can only read what was sealed to
// its key, and it seals its answers to the client's one-time key, as the real one does.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OffRouter, assertSealed } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { enclave } from '../src/e2ee.js';
import { opencodeConfig, pickDefault, PLACEHOLDER_KEY } from '../src/init.js';
import { createProxy, listen } from '../src/proxy.js';

const ALGO = 'x25519-aes-256-gcm-hkdf-sha256';
const E2EE_MODEL = 'vendor/coder';
const pair = enclave.keypair(ALGO);
const SECRET_FILE = 'export const apiSecret = "hunter2-do-not-leak";';

let gateway: Server;
let proxy: Server;
let base = '';
const seen: { auth?: string; wire: string }[] = [];

const port = (s: Server) => (s.address() as AddressInfo).port;

beforeAll(async () => {
  gateway = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          data: [
            { id: 'coder', type: 'chat', context_length: 200000, input_usdc_per_mtok: 1, output_usdc_per_mtok: 2, e2ee: { version: '2', model: E2EE_MODEL } },
            { id: 'plain-only', type: 'chat', context_length: 100000, input_usdc_per_mtok: 1, output_usdc_per_mtok: 1 },
          ],
        }),
      );
    }
    let raw = '';
    for await (const c of req) raw += c;
    seen.push({ auth: req.headers.authorization, wire: raw });
    const body = JSON.parse(raw);
    const nonce = String(req.headers['x-e2ee-nonce']);
    const ts = Number(req.headers['x-e2ee-timestamp']);
    const client = String(req.headers['x-client-pub-key']);
    // Open every message, as the enclave would; this throws if anything was not sealed to us.
    const opened = await Promise.all(body.messages.map((m: any, i: number) => (m.content == null ? null : enclave.openRequestField(ALGO, pair.secret, m.content, `messages.${i}.content`, E2EE_MODEL, nonce, ts))));
    const lastUser = opened.filter(Boolean).at(-1);
    const answer = `you said: ${lastUser}`;
    const id = 'chatcmpl-1';
    const seal = (text: string, field: string) => enclave.sealAnswerField(ALGO, client, text, field, id, E2EE_MODEL, nonce, ts);

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-e2ee-applied': 'true', 'x-offrouter-receipt-url': 'https://r/1' });
      res.write(`event: offrouter.forwarded\ndata: {"note":"gateway"}\n\n`);
      res.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: { role: 'assistant', content: await seal('you said: ', 'choices.0.delta.content') } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: { content: await seal(String(lastUser), 'choices.0.delta.content') } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-e2ee-applied': 'true', 'x-offrouter-charge-usd': '0.000123' });
    res.end(JSON.stringify({ id, choices: [{ index: 0, message: { role: 'assistant', content: await seal(answer, 'choices.0.message.content') } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
  });
  await listen(gateway, 0);

  const config = loadConfig({ OFFROUTER_BASE_URL: `http://127.0.0.1:${port(gateway)}`, OFFROUTER_API_KEY: 'off_sk_configured' });
  const api = new OffRouter(config);
  // Stand in for the attestation check, which needs real TDX hardware.
  (api.enclave as any).get = async () => ({ key: { algo: ALGO, public_key: pair.public }, notAfter: Date.now() / 1000 + 3600 });
  proxy = createProxy(api, { log: () => {} });
  await listen(proxy, 0);
  base = `http://127.0.0.1:${port(proxy)}/v1`;
});

afterAll(() => {
  gateway?.close();
  proxy?.close();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${PLACEHOLDER_KEY}`, ...headers }, body: JSON.stringify(body) });

describe('private mode proxy', () => {
  it('lists only the models that take end to end encryption', async () => {
    const r = await (await fetch(`${base}/models`)).json();
    expect(r.data.map((m: any) => m.id)).toEqual(['coder']);
  });

  it('seals the conversation, including tool results, and opens the answer', async () => {
    const body = {
      model: 'coder',
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      messages: [
        { role: 'system', content: 'You are a careful coding agent.' },
        { role: 'user', content: 'read a.ts please' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: SECRET_FILE },
        { role: 'user', content: [{ type: 'text', text: 'now summarise that file' }] },
      ],
    };
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-offrouter-private-mode')).toBe('e2ee');
    expect(res.headers.get('x-offrouter-charge-usd')).toBe('0.000123');
    const out = await res.json();
    expect(out.choices[0].message.content).toContain('now summarise that file');

    const wire = seen.at(-1)!.wire;
    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('careful coding agent');
    expect(wire).not.toContain('now summarise');
    // The placeholder is not a key: the configured one pays.
    expect(seen.at(-1)!.auth).toBe('Bearer off_sk_configured');
  });

  it('streams, opening each chunk and dropping the gateway notes', async () => {
    const res = await post({ model: 'coder', stream: true, messages: [{ role: 'user', content: 'stream me' }] });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).not.toContain('offrouter.forwarded');
    const chunks = text.split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
    const said = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(said).toBe('you said: stream me');
    expect(chunks.some((c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === 'read_file')).toBe(true);
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('uses a real key the agent sends instead of the configured one', async () => {
    await post({ model: 'coder', messages: [{ role: 'user', content: 'hello there' }] }, { authorization: 'Bearer off_sk_fromagent' });
    expect(seen.at(-1)!.auth).toBe('Bearer off_sk_fromagent');
  });

  it('refuses a model without end to end encryption rather than send it in the clear', async () => {
    const before = seen.length;
    const res = await post({ model: 'plain-only', messages: [{ role: 'user', content: 'secret stuff here' }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('e2ee_unsupported');
    expect(seen.length).toBe(before);
  });

  it('only answers clients on this machine', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const r = request(`${base}/models`, { headers: { host: 'evil.example:80' } }, (res) => resolve(res.statusCode ?? 0));
      r.end();
    });
    expect(status).toBe(403);
    const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(res.status).toBe(415);
  });
});

describe('assertSealed', () => {
  it('catches a message that went out in the clear', () => {
    const plain = { messages: [{ role: 'tool', content: SECRET_FILE }] };
    expect(() => assertSealed(plain, plain)).toThrow(/did not apply/);
    expect(() => assertSealed(plain, { messages: [{ role: 'tool', content: 'abcdef0123' }] })).not.toThrow();
  });
});

describe('init helpers', () => {
  const models: any[] = [
    { id: 'gpt-oss-120b', context_length: 131072, input_usdc_per_mtok: 0.15, output_usdc_per_mtok: 0.6, e2ee: { model: 'x' } },
    { id: 'glm-5.3', context_length: 200000, input_usdc_per_mtok: 1.4, output_usdc_per_mtok: 4.4, e2ee: { model: 'y' } },
  ];

  it('suggests a strong coding model first', () => {
    expect(pickDefault(models)?.id).toBe('glm-5.3');
  });

  it('adds a provider to OpenCode and keeps everything else', () => {
    const current = { theme: 'tokyonight', provider: { anthropic: { options: {} } }, model: 'anthropic/claude' };
    const next = opencodeConfig(current, { baseUrl: 'http://127.0.0.1:7402/v1', models });
    expect(next.theme).toBe('tokyonight');
    expect(next.provider.anthropic).toEqual({ options: {} });
    expect(next.model).toBe('anthropic/claude');
    expect(next.provider.offrouter.options).toEqual({ baseURL: 'http://127.0.0.1:7402/v1', apiKey: PLACEHOLDER_KEY });
    expect(Object.keys(next.provider.offrouter.models)).toEqual(['gpt-oss-120b', 'glm-5.3']);
    expect(opencodeConfig(current, { baseUrl: 'x', models, makeDefault: 'glm-5.3' }).model).toBe('offrouter/glm-5.3');
  });
});
