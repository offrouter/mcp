// Private web search and fetch against a fake API that plays the enclave: it can only read what was sealed
// to its web key, and seals its answers to the client's one-time key, as the real one does.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OffRouter } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { enclave } from '../src/e2ee.js';
import { replayRtmr3 } from '../src/web.js';

const ALGO = 'x25519-aes-256-gcm-hkdf-sha256';
const pair = enclave.keypair(ALGO);
const signer = privateKeyToAccount(`0x${'42'.repeat(32)}`);

let server: Server;
let api: OffRouter;
let wire: string[] = [];
let answer: (req: any) => object = () => ({ object: 'web.search', query_sent: 'q', redacted: {}, results: [] });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    wire.push(raw);
    const h = (n: string) => String(req.headers[n] ?? '');
    const model = req.url === '/v1/web/search' ? 'web-search' : 'web-fetch';
    const nonce = h('x-e2ee-nonce');
    const ts = Number(h('x-e2ee-timestamp'));
    const inner = JSON.parse(await enclave.openRequestField(ALGO, pair.secret, JSON.parse(raw).request, 'request', model, nonce, ts));
    const out: any = answer(inner);
    const receipt = JSON.stringify({ v: 1, kind: model });
    out.receipt = receipt;
    out.signature = await signer.signMessage({ message: receipt });
    const id = 'web_1';
    const response = await enclave.sealAnswerField(ALGO, h('x-client-pub-key'), JSON.stringify(out), 'response', id, model, nonce, ts);
    res.writeHead(200, { 'content-type': 'application/json', 'x-e2ee-applied': 'true', 'x-web-served': 'true', 'x-offrouter-charge-usd': '0.008000' });
    res.end(JSON.stringify({ object: 'web.encrypted', id, response }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  api = new OffRouter(loadConfig({ OFFROUTER_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, OFFROUTER_API_KEY: 'off_sk_web' }));
  // The quote check is covered against a real quote by hand; here the key is taken as checked.
  api.web.get = async () => ({ publicKey: pair.public, gateway: signer.address, composeHash: null, search: true, fetch: true, priceUsd: { search: 0.008, fetch: 0.002 }, verifiedAt: Date.now() });
});
afterAll(() => server.close());
beforeEach(() => (wire = []));

describe('web_search', () => {
  it('sends only ciphertext, and opens the results', async () => {
    answer = (req) => ({ object: 'web.search', query_sent: req.query, redacted: {}, results: [{ title: 'T', url: 'https://a.b/', snippet: 's' }] });
    const r = await api.webSearch({ query: 'my very private question', count: 3 });
    expect(wire[0]).not.toContain('private question');
    expect(r.results[0].url).toBe('https://a.b/');
    expect(r.querySent).toBe('my very private question');
    expect(r).toMatchObject({ encrypted: true, receiptVerified: true, chargeUsd: 0.008, paidWith: 'key' });
  });

  it('turns a sealed refusal into an error', async () => {
    answer = () => ({ error: { message: 'Nothing is left of the query.', code: 'invalid_query' } });
    await expect(api.webSearch({ query: 'x' })).rejects.toThrow('Nothing is left');
  });

  it('is not offered on the free demo', async () => {
    const demo = new OffRouter(loadConfig({ OFFROUTER_BASE_URL: 'http://127.0.0.1:1' }));
    await expect(demo.webSearch({ query: 'x' })).rejects.toThrow(/key or a wallet/);
  });
});

describe('web_fetch', () => {
  it('sends the URL only as ciphertext', async () => {
    answer = (req) => ({ object: 'web.page', url: req.url, final_url: req.url, status: 200, content_type: 'text/html', title: 'Page', text: 'hello', truncated: false });
    const p = await api.webFetch({ url: 'https://secret-project.example/roadmap' });
    expect(wire[0]).not.toContain('secret-project');
    expect(p).toMatchObject({ title: 'Page', text: 'hello', encrypted: true, receiptVerified: true });
  });
});

describe('boot log replay', () => {
  it('extends RTMR3 the way the TDX module does', () => {
    expect(replayRtmr3([]).equals(Buffer.alloc(48))).toBe(true);
    const one = replayRtmr3([{ imr: 3, event_type: 134217729, digest: '', event: 'compose-hash', event_payload: 'ab' }]);
    expect(one).toHaveLength(48);
    expect(replayRtmr3([{ imr: 0, event_type: 1, digest: '', event: 'x', event_payload: '' }]).equals(Buffer.alloc(48))).toBe(true);
  });
});
