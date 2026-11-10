// Everything is configured through environment variables, so it fits in the
// "env" block of any MCP client config.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Mode = 'key' | 'wallet' | 'demo';

export type Config = {
  baseUrl: string;
  mode: Mode;
  apiKey?: string;
  walletKey?: `0x${string}`;
  /** Most a single pay per call payment may be, in USD. */
  maxUsd: number;
  /** Restrict wallet payments to one chain. */
  network?: 'base' | 'robinhood';
  /** Output budget when the caller doesn't give one. */
  defaultMaxTokens: number;
  e2ee: boolean;
  /** Where generated images are saved. */
  imageDir: string;
};

const off = (v: string | undefined) => !!v && ['0', 'false', 'off', 'no'].includes(v.trim().toLowerCase());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = (env.OFFROUTER_BASE_URL || 'https://offrouter.org').replace(/\/+$/, '');
  const apiKey = env.OFFROUTER_API_KEY?.trim() || undefined;
  const walletKey = env.OFFROUTER_WALLET_KEY?.trim() || undefined;

  if (apiKey && !apiKey.startsWith('off_sk_')) throw new Error('OFFROUTER_API_KEY should start with off_sk_');
  if (walletKey && !/^0x[0-9a-fA-F]{64}$/.test(walletKey)) throw new Error('OFFROUTER_WALLET_KEY should be a 0x prefixed 32 byte hex private key');

  const maxUsd = env.OFFROUTER_MAX_USD ? Number(env.OFFROUTER_MAX_USD) : 0.1;
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error('OFFROUTER_MAX_USD should be a positive number, like 0.10');

  const network = env.OFFROUTER_NETWORK?.trim().toLowerCase() || undefined;
  if (network && network !== 'base' && network !== 'robinhood') throw new Error('OFFROUTER_NETWORK should be base or robinhood');

  const defaultMaxTokens = env.OFFROUTER_MAX_TOKENS ? Number(env.OFFROUTER_MAX_TOKENS) : 2048;
  if (!Number.isInteger(defaultMaxTokens) || defaultMaxTokens < 1) throw new Error('OFFROUTER_MAX_TOKENS should be a whole number');

  return {
    baseUrl,
    // A key wins over a wallet if both are set: it is cheaper per call and never needs a signature.
    mode: apiKey ? 'key' : walletKey ? 'wallet' : 'demo',
    apiKey,
    walletKey: walletKey as `0x${string}` | undefined,
    maxUsd,
    network: network as Config['network'],
    defaultMaxTokens,
    e2ee: !off(env.OFFROUTER_E2EE),
    imageDir: env.OFFROUTER_IMAGE_DIR?.trim() || join(tmpdir(), 'offrouter-images'),
  };
}
