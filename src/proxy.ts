// Private mode: a local OpenAI-compatible endpoint for coding agents.
//
// Point an agent's base URL at http://127.0.0.1:7402/v1 and every chat request it makes is
// encrypted on this machine to the enclave's attested key before it goes over the network.
// The OffRouter gateway forwards ciphertext; the answer comes back encrypted to a key made for
// that one request and is opened here. Tools and streaming pass through untouched.
//
// What E2EE v2 covers: the content of every message, including tool results (the files your
// agent reads). What it does not: tool definitions, the arguments of tool calls (so edits the
// model writes through a tool), the model name and settings. See the README.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, type OffRouter } from './client.js';
import type { Session } from './e2ee.js';

export const DEFAULT_PORT = 7402;
const MAX_BODY = 32 * 1024 * 1024;

export type ProxyOptions = {
  port?: number;
  host?: string;
  /** Output budget when the agent sends none and we pay per call (the quote needs one). */
  walletMaxTokens?: number;
  log?: (line: string) => void;
};

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const fail = (res: ServerResponse, status: number, message: string, code?: string) =>
  json(res, status, { error: { message, type: status >= 500 ? 'api_error' : 'invalid_request_error', code: code ?? null } });

// Only a local client, by name: a web page that rebinds a DNS name to 127.0.0.1 must not reach us.
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError('Request body is too large.', 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The x-offrouter-* headers (charge, receipt) passed back to the agent. */
function passHeaders(from: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  from.forEach((v, k) => {
    if (k.startsWith('x-offrouter-') || k === 'payment-response') out[k] = v;
  });
  return out;
}

/** Re-emit a gateway SSE stream with each chunk opened, dropping the gateway's own named events. */
export async function pipeStream(body: AsyncIterable<Uint8Array>, session: Session | null, write: (s: string) => void): Promise<{ usage: any }> {
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  let usage: any = null;
  const handle = async (line: string) => {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      return;
    }
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (event) {
      event = '';
      return;
    }
    if (!data) return;
    if (data === '[DONE]') {
      write('data: [DONE]\n\n');
      return;
    }
    let chunk = JSON.parse(data);
    if (session && !chunk.error) chunk = await session.decryptChunk(chunk);
    if (chunk.usage) usage = chunk.usage;
    write(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  for await (const part of body) {
    buf += decoder.decode(part, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      await handle(line);
    }
  }
  if (buf.trim()) await handle(buf.trim());
  return { usage };
}

export function createProxy(api: OffRouter, opts: ProxyOptions = {}): Server {
  const log = opts.log ?? ((l: string) => console.error(l));
  const walletMax = opts.walletMaxTokens ?? 8192;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname.replace(/\/+$/, '').replace(/^\/v1(?=\/)/, '');
    try {
      if (!LOCAL_HOST.test(req.headers.host ?? '')) return fail(res, 403, 'Private mode only answers clients on this machine.', 'not_local');
      // Browsers can't send a cross-site JSON POST without a preflight, which we never answer.
      if (req.method === 'OPTIONS') return fail(res, 403, 'Not available to web pages.', 'not_local');

      if (req.method === 'GET' && (path === '' || path === '/' || path === '/health')) {
        return json(res, 200, { ok: true, private_mode: true, e2ee: api.config.e2ee, paying_with: api.config.mode });
      }

      if (req.method === 'GET' && path === '/models') {
        const models = (await api.listModels()).filter((m) => !api.config.e2ee || m.e2ee?.model);
        return json(res, 200, {
          object: 'list',
          data: models.map((m) => ({ id: m.id, object: 'model', owned_by: 'offrouter', context_length: m.context_length, input_usdc_per_mtok: m.input_usdc_per_mtok, output_usdc_per_mtok: m.output_usdc_per_mtok })),
        });
      }

      if (req.method === 'POST' && path === '/chat/completions') {
        if (!/application\/json/i.test(req.headers['content-type'] ?? '')) return fail(res, 415, 'Send JSON.', 'unsupported_media_type');
        let body: any;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          if (e instanceof ApiError) throw e;
          return fail(res, 400, 'The body is not valid JSON.', 'invalid_json');
        }
        if (!body || !Array.isArray(body.messages)) return fail(res, 400, '`messages` is required.', 'invalid_request');

        // An agent configured with a real key may send it; a placeholder is ignored.
        const bearer = /^Bearer\s+(off_sk_\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
        if (!bearer && api.config.mode === 'wallet' && body.max_tokens == null && body.max_completion_tokens == null) body.max_tokens = walletMax;

        const started = Date.now();
        const { res: up, session } = await api.openChat(body, bearer);
        const headers: Record<string, string> = { ...passHeaders(up.headers), 'x-offrouter-private-mode': session ? 'e2ee' : 'plain' };

        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
          try {
            const { usage } = await pipeStream(up.body as unknown as AsyncIterable<Uint8Array>, session, (s) => res.write(s));
            log(`${body.model} · stream · ${usage ? `${usage.prompt_tokens} in / ${usage.completion_tokens} out` : 'no usage'} · ${session ? 'e2ee' : 'plain'} · ${Date.now() - started} ms`);
          } catch (e) {
            res.write(`data: ${JSON.stringify({ error: { message: (e as Error).message, type: 'api_error' } })}\n\n`);
            log(`${body.model} · stream failed: ${(e as Error).message}`);
          }
          return res.end();
        }

        let completion: any = await up.json();
        if (session) completion = await session.decryptCompletion(completion);
        const u = completion.usage;
        log(`${body.model} · ${u ? `${u.prompt_tokens} in / ${u.completion_tokens} out` : 'no usage'} · ${headers['x-offrouter-charge-usd'] ? `$${headers['x-offrouter-charge-usd']} · ` : ''}${session ? 'e2ee' : 'plain'} · ${Date.now() - started} ms`);
        return json(res, 200, completion, headers);
      }

      return fail(res, 404, `Private mode serves GET /v1/models and POST /v1/chat/completions, not ${req.method} ${url.pathname}.`, 'not_found');
    } catch (e) {
      const err = e as ApiError;
      const status = typeof err.status === 'number' && err.status >= 400 ? err.status : 502;
      log(`error ${status}: ${err.message}`);
      if (res.headersSent) return res.end();
      return fail(res, status, err.message || 'Private mode failed.', err.code);
    }
  });
}

export function listen(server: Server, port: number, host = '127.0.0.1'): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'EADDRINUSE' ? new Error(`Port ${port} is taken. Is private mode already running? Pick another with --port.`) : e),
    );
    server.listen(port, host, () => resolve());
  });
}
