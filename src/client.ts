// Talks to the OffRouter API. One chat() call handles all three ways to pay
// (prepaid key, wallet, free demo) and, when encryption is on, seals the
// messages to the enclave before anything goes over the network.
import { EnclaveCache } from './attest.js';
import type { Config } from './config.js';
import { encryptRequest, type Session } from './e2ee.js';
import { makeWallet, settlement, type Wallet } from './pay.js';

export type Model = {
  id: string;
  /** "chat", or "image" for an image model (not served by chat, so left out of the list). */
  type?: string;
  context_length: number;
  input_usdc_per_mtok: number;
  output_usdc_per_mtok: number;
  input_modalities?: string[];
  discount_pct?: number;
  min_output_tokens?: number;
  e2ee?: { version: string; model: string };
};

export type ChatInput = {
  model: string;
  prompt: string;
  system?: string;
  max_tokens?: number;
  temperature?: number;
};

export type ImageModel = { id: string; type: 'image'; max_images: number; usdc_per_image: number; discount_pct?: number };

export type ImageInput = { model?: string; prompt: string; n?: number; size?: string };

export type ImageResult = {
  model: string;
  images: { data: string; mimeType: string; revisedPrompt?: string }[];
  chargeUsd: number | null;
  receiptUrl: string | null;
  paidWith: 'key' | 'wallet';
  transaction?: string;
};

export type ChatResult = {
  model: string;
  text: string;
  promptTokens: number;
  completionTokens: number;
  chargeUsd: number | null;
  receiptUrl: string | null;
  encrypted: boolean;
  paidWith: 'key' | 'wallet' | 'demo';
  transaction?: string;
  demoRemaining?: number;
};

/** An agent in the Studio directory, as anyone may see it. Its instructions and memory stay in the enclave. */
export type StudioAgent = {
  id: string;
  name: string;
  purpose: string;
  examples?: { task: string; expect: string }[];
  tools: string[];
  model: string;
  builder: string;
  address: string;
  config_hash: string;
  status: string;
  created_at: number;
  scheduled: boolean;
  stats: { good_runs: number; failed_runs: number; first_good_run_at: number | null; last_good_run_at: number | null; credits_spent: string };
  evaluation?: { at: number; judge: string; score: number; passed: boolean; leaked: boolean } | null;
  standing?: {
    ready: boolean;
    working?: { passed: boolean; score: number; evaluated_at: number; expires_at: number } | null;
    alive?: { ready: boolean; good_runs: number; needs_runs: number; live_for_sec: number; needs_sec: number } | null;
  };
  last_run_at?: number | null;
  image?: string | null;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

const MODELS_TTL_MS = 5 * 60_000;

export class OffRouter {
  readonly enclave: EnclaveCache;
  readonly wallet: Wallet | null;
  private catalog: { at: number; list: Promise<any[]> } | null = null;

  constructor(readonly config: Config) {
    this.enclave = new EnclaveCache(config.baseUrl);
    this.wallet = config.mode === 'wallet' ? makeWallet(config) : null;
  }

  private all(): Promise<any[]> {
    if (!this.catalog || Date.now() - this.catalog.at > MODELS_TTL_MS) {
      const list = this.getJson('/v1/models').then((b: any) => (b.data ?? []) as any[]);
      this.catalog = { at: Date.now(), list };
      list.catch(() => (this.catalog = null));
    }
    return this.catalog.list;
  }

  /** The chat models. Image models are served by generateImage, so they are left out. */
  async listModels(): Promise<Model[]> {
    return ((await this.all()) as Model[]).filter((m) => m.type !== 'image');
  }

  async listImageModels(): Promise<ImageModel[]> {
    return ((await this.all()) as ImageModel[]).filter((m) => m.type === 'image');
  }

  /**
   * Generate images. Image models do not take end to end encryption yet, so the prompt reaches
   * the gateway in the clear; it is still served inside the TEE and nothing is stored.
   */
  async generateImage(input: ImageInput): Promise<ImageResult> {
    const { mode } = this.config;
    if (mode === 'demo') throw new ApiError('Image generation needs a key or a wallet: the free demo only serves one chat model. Set OFFROUTER_API_KEY or OFFROUTER_WALLET_KEY.', 402);
    const models = await this.listImageModels();
    const model = input.model ?? models[0]?.id;
    if (!model) throw new ApiError('OffRouter has no image model right now.', 404, 'model_not_found');
    const entry = models.find((m) => m.id === model);
    if (!entry) throw new ApiError(`There is no image model called "${model}". Image models: ${models.map((m) => m.id).join(', ') || 'none'}.`, 404, 'model_not_found');

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (mode === 'key') headers.authorization = `Bearer ${this.config.apiKey}`;
    const body = { model, prompt: input.prompt, n: input.n ?? 1, size: input.size ?? '1024x1024', response_format: 'b64_json' };
    const res = await this.post('/v1/images/generations', headers, body);
    const out: any = await res.json();
    const images = (out.data ?? [])
      .filter((d: any) => typeof d?.b64_json === 'string' && d.b64_json)
      .map((d: any) => ({ data: d.b64_json as string, mimeType: mimeOf(d.b64_json), ...(d.revised_prompt ? { revisedPrompt: String(d.revised_prompt) } : {}) }));
    const charge = res.headers.get('x-offrouter-charge-usd');
    return {
      model,
      images,
      chargeUsd: charge == null ? null : Number(charge),
      receiptUrl: res.headers.get('x-offrouter-receipt-url'),
      paidWith: mode,
      transaction: mode === 'wallet' ? settlement(res.headers)?.transaction : undefined,
    };
  }

  /** Balance and recent usage of the prepaid key. */
  keyInfo(): Promise<any> {
    return this.getJson('/v1/keys/me', { authorization: `Bearer ${this.config.apiKey}` });
  }

  /** What the free demo allows and what this IP has left today. */
  demoInfo(): Promise<any> {
    return this.getJson('/v1/demo');
  }

  /** The Studio directory: the newest agents first, closed ones left out. */
  async listAgents(): Promise<StudioAgent[]> {
    const b: any = await this.getJson('/v1/studio/agents');
    return (b.agents ?? []) as StudioAgent[];
  }

  /** One Studio agent's public view, with its examples and last evaluation. */
  async getAgent(id: string): Promise<StudioAgent> {
    if (!/^0x[0-9a-fA-F]{32}$/.test(id)) throw new ApiError('An agent id is 0x followed by 32 hex characters.', 400, 'invalid_agent_id');
    return this.getJson(`/v1/studio/agents/${id}/public`);
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const messages: { role: string; content: string }[] = [];
    if (input.system) messages.push({ role: 'system', content: input.system });
    messages.push({ role: 'user', content: input.prompt });

    const { mode } = this.config;
    const body: Record<string, unknown> = { model: input.model, messages };
    if (mode !== 'demo') {
      // Pay per call needs max_tokens, since the price is quoted as a ceiling. With a key it is optional,
      // but we send our default anyway so a runaway answer can't drain the balance.
      body.max_tokens = input.max_tokens ?? this.config.defaultMaxTokens;
      if (typeof input.temperature === 'number') body.temperature = input.temperature;
    }

    try {
      return await this.send(input.model, body);
    } catch (e) {
      // The enclave takes each nonce once and rejects ciphertext for a key it no longer holds. The usual
      // cause is a rotated key, so check the enclave again and retry once with a fresh encryption.
      if (e instanceof ApiError && e.code === 'e2ee_rejected' && this.config.e2ee) {
        await this.enclave.refresh();
        return this.send(input.model, body);
      }
      throw e;
    }
  }

  private async send(model: string, body: Record<string, unknown>): Promise<ChatResult> {
    const { mode } = this.config;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (mode === 'key') headers.authorization = `Bearer ${this.config.apiKey}`;

    let session: Session | null = null;
    let payload = body;
    if (this.config.e2ee) {
      const entry = (await this.listModels()).find((m) => m.id === model);
      if (!entry) throw new ApiError(`There is no model called "${model}". Call list_models to see what is available.`, 404, 'model_not_found');
      if (!entry.e2ee?.model) throw new ApiError(`${model} does not support end to end encryption. Set OFFROUTER_E2EE=off to call it in the clear.`, 400);
      const enclave = await this.enclave.get();
      session = await encryptRequest(body, { key: enclave.key, model: entry.e2ee.model });
      // Belt and braces: never send a request that still has the prompt in it.
      const plain = (body.messages as { content: string }[]).map((m) => m.content).filter((c) => c.length >= 8);
      const wire = JSON.stringify(session.body);
      if (plain.some((c) => wire.includes(c))) throw new Error('Encryption did not apply, so the request was not sent.');
      payload = session.body;
      Object.assign(headers, session.headers);
    }

    const path = mode === 'demo' ? '/v1/demo/chat' : '/v1/chat/completions';
    const res = await this.post(path, headers, payload);
    if (session && !session.applied(res.headers)) throw new Error('The enclave did not confirm it encrypted the answer, so it was not read.');

    let text = '';
    let promptTokens = 0;
    let completionTokens = 0;
    if (mode === 'demo') {
      // The demo always streams.
      const out = await readStream(res, session);
      text = out.text;
      promptTokens = out.usage?.prompt_tokens ?? 0;
      completionTokens = out.usage?.completion_tokens ?? 0;
    } else {
      let completion: any = await res.json();
      if (session) completion = await session.decryptCompletion(completion);
      text = String(completion.choices?.[0]?.message?.content ?? '');
      promptTokens = completion.usage?.prompt_tokens ?? 0;
      completionTokens = completion.usage?.completion_tokens ?? 0;
    }

    const charge = res.headers.get('x-offrouter-charge-usd');
    const remaining = res.headers.get('x-offrouter-demo-remaining');
    return {
      model,
      text: text.trim(),
      promptTokens,
      completionTokens,
      chargeUsd: charge == null ? null : Number(charge),
      receiptUrl: res.headers.get('x-offrouter-receipt-url'),
      encrypted: !!session,
      paidWith: mode,
      transaction: mode === 'wallet' ? settlement(res.headers)?.transaction : undefined,
      demoRemaining: remaining == null ? undefined : Number(remaining),
    };
  }

  /** POST, paid from the wallet in wallet mode, with payment failures turned into readable errors. */
  private async post(path: string, headers: Record<string, string>, payload: unknown): Promise<Response> {
    const { mode } = this.config;
    const doFetch = mode === 'wallet' ? this.wallet!.fetch : fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.config.baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (mode === 'wallet' && /spendControls|maxAmountPerPayment/.test(msg)) {
        throw new Error(`Not paid: this call is quoted above the $${this.config.maxUsd} cap per call. Lower max_tokens (or n, for images) or raise OFFROUTER_MAX_USD.`);
      }
      if (mode === 'wallet') throw new Error(`Payment failed: ${msg.replace(/\.+$/, '')}.`);
      throw e;
    }
    if (!res.ok) {
      const err = await apiError(res);
      if (mode === 'wallet' && res.status === 402) {
        const why = /insufficient_balance/.test(err.message) ? 'it does not hold enough' : err.message.replace(/\.+$/, '');
        throw new ApiError(`The wallet ${this.wallet!.address} could not pay: ${why}. Fund it with USDC on Base or USDG on Robinhood Chain.`, 402, err.code);
      }
      throw err;
    }
    return res;
  }

  private async getJson(path: string, headers: Record<string, string> = {}): Promise<any> {
    const res = await fetch(`${this.config.baseUrl}${path}`, { headers: { accept: 'application/json', ...headers } });
    if (!res.ok) throw await apiError(res);
    return res.json();
  }
}

/** PNG, JPEG or WebP, from the first bytes. */
function mimeOf(b64: string): string {
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

async function apiError(res: Response): Promise<ApiError> {
  const body: any = await res.json().catch(() => null);
  const err = body?.error;
  const message = (typeof err === 'string' ? err : err?.message) || `OffRouter answered ${res.status}.`;
  return new ApiError(message, res.status, typeof err === 'object' ? err?.code : undefined);
}

/** Reads a server sent event stream of chat chunks, decrypting each one when the request was encrypted. */
async function readStream(res: Response, session: Session | null): Promise<{ text: string; usage: any }> {
  let text = '';
  let usage: any = null;
  let event = '';
  let buf = '';
  const decoder = new TextDecoder();
  const handle = async (line: string) => {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      return;
    }
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    // Named events (offrouter.forwarded, offrouter.stored) are the gateway's own notes, not model output.
    if (event) {
      event = '';
      return;
    }
    let chunk = JSON.parse(data);
    if (chunk.error) throw new ApiError(chunk.error.message ?? 'The stream ended with an error.', 502, chunk.error.code);
    if (session) chunk = await session.decryptChunk(chunk);
    text += chunk.choices?.[0]?.delta?.content ?? '';
    if (chunk.usage) usage = chunk.usage;
  };
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(part, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      await handle(line);
    }
  }
  if (buf.trim()) await handle(buf.trim());
  return { text, usage };
}
