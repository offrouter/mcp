import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const WALLET = '0x' + '11'.repeat(32);

describe('loadConfig', () => {
  it('falls back to the free demo with encryption on', () => {
    const c = loadConfig({});
    expect(c.mode).toBe('demo');
    expect(c.e2ee).toBe(true);
    expect(c.baseUrl).toBe('https://offrouter.org');
  });

  it('prefers a key over a wallet', () => {
    expect(loadConfig({ OFFROUTER_API_KEY: 'off_sk_abc', OFFROUTER_WALLET_KEY: WALLET }).mode).toBe('key');
    expect(loadConfig({ OFFROUTER_WALLET_KEY: WALLET }).mode).toBe('wallet');
  });

  it('rejects values that are clearly wrong', () => {
    expect(() => loadConfig({ OFFROUTER_API_KEY: 'sk-123' })).toThrow();
    expect(() => loadConfig({ OFFROUTER_WALLET_KEY: '0x1234' })).toThrow();
    expect(() => loadConfig({ OFFROUTER_MAX_USD: '-1' })).toThrow();
    expect(() => loadConfig({ OFFROUTER_NETWORK: 'arc' })).toThrow();
  });

  it('lets encryption be turned off', () => {
    expect(loadConfig({ OFFROUTER_E2EE: 'off' }).e2ee).toBe(false);
    expect(loadConfig({ OFFROUTER_E2EE: '0' }).e2ee).toBe(false);
  });
});
