// Client side of end-to-end encryption to the enclave. It encrypts the content
// of each message to a key that the enclave's attestation report vouches for,
// and decrypts the answer with a throwaway key made for that one request. The
// OffRouter gateway in the middle only ever sees ciphertext.
//
// This file is just the cryptography. It trusts whatever key it is given, so
// only hand it a key from a report you verified yourself (see attest.ts).
//
// Wire format is "E2EE v2" from the enclave gateway. For every encrypted
// field: a fresh ephemeral key, ECDH with the recipient's key, HKDF-SHA256 to
// an AES-256-GCM key, and the field's position in the request bound in as
// associated data:
//   hex( ephemeral_public_key || nonce (12) || ciphertext || tag (16) )
import { x25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';

/** An entry of `e2ee_public_keys` in the attestation report's key set. */
export type ServiceKey = { key_id?: string; algo: string; public_key: string };

export class E2eeError extends Error {}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
function unhex(text: string): Uint8Array {
  const s = text.replace(/^0x/, '');
  if (s.length % 2 || !/^[0-9a-fA-F]*$/.test(s)) throw new E2eeError('not hex');
  return Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
}
const utf8 = new TextEncoder();
const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

type Suite = {
  algo: string;
  info: string;
  /** Bytes of a public key as it sits at the front of a ciphertext. */
  publicLength: number;
  keypair(): { secret: Uint8Array; public: Uint8Array };
  /** The ECDH secret that goes into the key derivation. */
  shared(secret: Uint8Array, peer: Uint8Array): Uint8Array;
  /** A public key as published, in the form `shared` takes. */
  parse(publicKey: string): Uint8Array;
};

const SUITES: Suite[] = [
  {
    algo: 'x25519-aes-256-gcm-hkdf-sha256',
    info: 'aci.e2ee.v2.x25519',
    publicLength: 32,
    keypair() {
      const secret = x25519.utils.randomPrivateKey();
      return { secret, public: x25519.getPublicKey(secret) };
    },
    shared: (secret, peer) => x25519.getSharedSecret(secret, peer),
    parse(publicKey) {
      const bytes = unhex(publicKey);
      if (bytes.length !== 32) throw new E2eeError('an X25519 public key is 32 bytes');
      return bytes;
    },
  },
  {
    algo: 'secp256k1-aes-256-gcm-hkdf-sha256',
    info: 'aci.e2ee.v2.secp256k1',
    publicLength: 65,
    keypair() {
      const secret = secp256k1.utils.randomPrivateKey();
      return { secret, public: secp256k1.getPublicKey(secret, false) };
    },
    // The x coordinate of the shared point.
    shared: (secret, peer) => secp256k1.getSharedSecret(secret, peer, false).slice(1, 33),
    parse(publicKey) {
      const bytes = unhex(publicKey);
      // 64 bytes is the same key without its 0x04 prefix.
      if (bytes.length === 64) return Uint8Array.from([4, ...bytes]);
      if (bytes.length !== 65 || bytes[0] !== 4) throw new E2eeError('a secp256k1 public key is 65 bytes, uncompressed');
      return bytes;
    },
  },
];

/** The key to encrypt to, out of the ones a report offers: X25519 when it is there. Null when none is usable. */
export function chooseKey(keys: ServiceKey[] | undefined | null): ServiceKey | null {
  for (const suite of SUITES) {
    const key = keys?.find((k) => k?.algo === suite.algo && typeof k.public_key === 'string');
    if (key) return key;
  }
  return null;
}

const aesKey = (suite: Suite, shared: Uint8Array, usage: 'encrypt' | 'decrypt') =>
  crypto.subtle.importKey('raw', Uint8Array.from(hkdf(sha256, shared, undefined, suite.info, 32)), 'AES-GCM', false, [usage]);

async function seal(suite: Suite, recipient: Uint8Array, plaintext: string, aad: string): Promise<string> {
  const ephemeral = suite.keypair();
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(suite, suite.shared(ephemeral.secret, recipient), 'encrypt');
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: utf8.encode(aad) }, key, utf8.encode(plaintext)));
  return hex(Uint8Array.from([...ephemeral.public, ...nonce, ...sealed]));
}

async function open(suite: Suite, secret: Uint8Array, ciphertext: string, aad: string): Promise<string> {
  const bytes = unhex(ciphertext);
  if (bytes.length < suite.publicLength + 12 + 16) throw new E2eeError('too short to be a ciphertext');
  const ephemeral = bytes.slice(0, suite.publicLength);
  const nonce = bytes.slice(suite.publicLength, suite.publicLength + 12);
  const key = await aesKey(suite, suite.shared(secret, ephemeral), 'decrypt');
  return text.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: utf8.encode(aad) }, key, bytes.slice(suite.publicLength + 12)));
}

// The associated data is canonical JSON (RFC 8785). For these values that is JSON.stringify with the members in
// alphabetical order, which is the order they are written in here.
const requestAad = (algo: string, field: string, model: string, nonce: string, ts: number) => JSON.stringify({ algo, field, model, nonce, purpose: 'aci.e2ee.request.v2', ts });
const responseAad = (algo: string, field: string, id: string, model: string, nonce: string, ts: number) => JSON.stringify({ algo, field, id, model, nonce, purpose: 'aci.e2ee.response.v2', ts });

// What the enclave encrypts in an answer, under `choices.{i}.message` or `choices.{i}.delta`.
const ANSWER_FIELDS = ['content', 'reasoning', 'reasoning_content'];

export type Session = {
  /** The request to send: the same body, with the content of every message encrypted. */
  body: any;
  /** The five headers to send with it. */
  headers: Record<string, string>;
  /** Did the enclave say it encrypted the answer? If not, do not read the answer as one: it was not made from your messages. */
  applied(headers: Headers | { get(name: string): string | null }): boolean;
  /** A whole (non-streamed) completion, with its encrypted fields opened. Throws E2eeError if one does not open. */
  decryptCompletion<T = any>(completion: T): Promise<T>;
  /** One streamed chunk, with its encrypted fields opened. Chunks with nothing encrypted come back as they are. */
  decryptChunk<T = any>(chunk: T): Promise<T>;
};

/**
 * Encrypt a chat request to the enclave.
 *
 * `key` is the enclave's key, from a verified attestation report. `model` is
 * the model's name as the enclave knows it (`e2ee.model` in GET /v1/models):
 * every ciphertext is bound to it, so a request encrypted for one model cannot
 * be served by another. `body.model` stays the id you would normally send.
 *
 * What is encrypted: the `content` of every message, as a string or as a
 * whole array of parts. What is not: the model, `max_tokens` and the other
 * settings, tool definitions, and the arguments of tool calls.
 *
 * A session is for one request. To retry, encrypt again: the enclave takes
 * each nonce once.
 */
export async function encryptRequest(body: any, opts: { key: ServiceKey; model: string; now?: number }): Promise<Session> {
  const suite = SUITES.find((s) => s.algo === opts.key?.algo);
  if (!suite) throw new E2eeError(`no support for the key type ${JSON.stringify(opts.key?.algo)}`);
  if (!body || !Array.isArray(body.messages)) throw new E2eeError('`messages` is required');
  if (typeof opts.model !== 'string' || !opts.model) throw new E2eeError('the model\'s `e2ee.model` name is required');
  const service = suite.parse(opts.key.public_key);
  const client = suite.keypair();
  const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
  const ts = Math.floor((opts.now ?? Date.now()) / 1000);

  let sealedAny = false;
  const messages = await Promise.all(
    body.messages.map(async (m: any, i: number) => {
      if (!m || m.content == null) return m;
      // An array of parts is encrypted whole, as its JSON.
      const plaintext = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      sealedAny = true;
      return { ...m, content: await seal(suite, service, plaintext, requestAad(suite.algo, `messages.${i}.content`, opts.model, nonce, ts)) };
    }),
  );
  if (!sealedAny) throw new E2eeError('no message has any content to encrypt');

  const openField = async (value: unknown, field: string, id: unknown): Promise<unknown> => {
    if (typeof value !== 'string' || value === '') return value;
    try {
      return await open(suite, client.secret, value, responseAad(suite.algo, field, typeof id === 'string' ? id : '', opts.model, nonce, ts));
    } catch {
      throw new E2eeError(`the answer's ${field} did not decrypt with this request's key: it was not made by the enclave for this request`);
    }
  };
  const openChoices = async (response: any, part: 'message' | 'delta') => {
    if (!response || !Array.isArray(response.choices)) return response;
    const choices = await Promise.all(
      response.choices.map(async (choice: any) => {
        const inner = choice?.[part];
        if (!inner || typeof inner !== 'object') return choice;
        const opened = { ...inner };
        // The field path names the choice by its own index, which a stream carries on each chunk.
        const index = Number.isInteger(choice.index) ? choice.index : response.choices.indexOf(choice);
        for (const name of ANSWER_FIELDS) if (name in inner) opened[name] = await openField(inner[name], `choices.${index}.${part}.${name}`, response.id);
        return { ...choice, [part]: opened };
      }),
    );
    return { ...response, choices };
  };

  return {
    body: { ...body, messages },
    headers: {
      'X-E2EE-Version': '2',
      'X-Client-Pub-Key': hex(client.public),
      'X-Model-Pub-Key': hex(service),
      'X-E2EE-Nonce': nonce,
      'X-E2EE-Timestamp': String(ts),
    },
    applied: (headers) => headers.get('x-e2ee-applied') === 'true',
    decryptCompletion: (completion) => openChoices(completion, 'message'),
    decryptChunk: (chunk) => openChoices(chunk, 'delta'),
  };
}

/** The enclave's side, for tests and for anything that plays the enclave: open a request field, seal an answer field. */
export const enclave = {
  openRequestField(algo: string, secret: Uint8Array, ciphertext: string, field: string, model: string, nonce: string, ts: number) {
    const suite = SUITES.find((s) => s.algo === algo)!;
    return open(suite, secret, ciphertext, requestAad(algo, field, model, nonce, ts));
  },
  sealAnswerField(algo: string, clientPublic: string, plaintext: string, field: string, id: string, model: string, nonce: string, ts: number) {
    const suite = SUITES.find((s) => s.algo === algo)!;
    return seal(suite, suite.parse(clientPublic), plaintext, responseAad(algo, field, id, model, nonce, ts));
  },
  keypair(algo: string) {
    const pair = SUITES.find((s) => s.algo === algo)!.keypair();
    return { secret: pair.secret, public: hex(pair.public) };
  },
  requestAad,
  responseAad,
};
