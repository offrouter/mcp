import { describe, expect, it } from 'vitest';
import { chooseKey, E2eeError, enclave, encryptRequest } from '../src/e2ee.js';

const ALGOS = ['x25519-aes-256-gcm-hkdf-sha256', 'secp256k1-aes-256-gcm-hkdf-sha256'];
const MODEL = 'vendor/some-model';

describe.each(ALGOS)('e2ee with %s', (algo) => {
  it('seals every message so only the enclave can open it', async () => {
    const pair = enclave.keypair(algo);
    const body = { model: 'some-model', max_tokens: 50, messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'what is a TEE?' }] };
    const session = await encryptRequest(body, { key: { algo, public_key: pair.public }, model: MODEL });

    const wire = JSON.stringify(session.body);
    expect(wire).not.toContain('be brief');
    expect(wire).not.toContain('what is a TEE?');
    expect(session.body.max_tokens).toBe(50);

    const nonce = session.headers['X-E2EE-Nonce'];
    const ts = Number(session.headers['X-E2EE-Timestamp']);
    const opened = await enclave.openRequestField(algo, pair.secret, session.body.messages[1].content, 'messages.1.content', MODEL, nonce, ts);
    expect(opened).toBe('what is a TEE?');
  });

  it('opens an answer sealed for this request and refuses one sealed for another model', async () => {
    const pair = enclave.keypair(algo);
    const session = await encryptRequest({ messages: [{ role: 'user', content: 'hi' }] }, { key: { algo, public_key: pair.public }, model: MODEL });
    const h = session.headers;
    const seal = (model: string) =>
      enclave.sealAnswerField(algo, h['X-Client-Pub-Key'], 'hello there', 'choices.0.message.content', 'chat-1', model, h['X-E2EE-Nonce'], Number(h['X-E2EE-Timestamp']));

    const good = await session.decryptCompletion({ id: 'chat-1', choices: [{ index: 0, message: { content: await seal(MODEL) } }] });
    expect(good.choices[0].message.content).toBe('hello there');

    await expect(session.decryptCompletion({ id: 'chat-1', choices: [{ index: 0, message: { content: await seal('other/model') } }] })).rejects.toThrow(E2eeError);
  });
});

describe('chooseKey', () => {
  it('prefers x25519 and ignores key types it does not know', () => {
    const keys = [
      { algo: 'something-else', public_key: '00' },
      { algo: ALGOS[1], public_key: '04' },
      { algo: ALGOS[0], public_key: 'aa' },
    ];
    expect(chooseKey(keys)?.algo).toBe(ALGOS[0]);
    expect(chooseKey([{ algo: 'nope', public_key: '00' }])).toBeNull();
  });
});
