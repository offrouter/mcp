// Pay per call with x402, signed by your own wallet on this machine. The
// private key never leaves the process: it signs an EIP-3009 transfer for the
// exact amount the server quotes, and we refuse to sign anything above
// OFFROUTER_MAX_USD no matter what the server asks for.
//
// OffRouter quotes a ceiling (your full input plus max_tokens of output) and
// refunds the unused part to the paying wallet after the call.
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import type { Config } from './config.js';

// Chains where a plain EIP-3009 signature settles. Arc is left out on purpose:
// OffRouter takes Arc payments through Circle Gateway, which needs a Gateway
// balance rather than a wallet signature. The server only ever offers its own
// environment, so listing testnets here is harmless on mainnet and vice versa.
const CHAINS = [
  { id: 'base', caip2: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { id: 'base', caip2: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
  { id: 'robinhood', caip2: 'eip155:4663', asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' },
  { id: 'robinhood', caip2: 'eip155:46630', asset: '0x7E955252E15c84f5768B83c41a71F9eba181802F' },
] as const;

export type Wallet = { address: string; fetch: typeof fetch; chains: string[] };

export function makeWallet(config: Config): Wallet {
  const account = privateKeyToAccount(config.walletKey!);
  const chains = CHAINS.filter((c) => !config.network || c.id === config.network);
  const cap = String(Math.round(config.maxUsd * 1e6));
  const client = x402Client.fromConfig({
    schemes: chains.map((c) => ({ network: c.caip2, client: new ExactEvmScheme(account) })),
    spendControls: {
      maxAmountPerPayment: `$${config.maxUsd}`,
      allowedAssets: chains.map((c) => ({ network: c.caip2, asset: c.asset, maxAmountPerPayment: cap })),
    },
  });
  return {
    address: account.address,
    fetch: wrapFetchWithPayment(fetch, client),
    chains: [...new Set(chains.map((c) => c.id))],
  };
}

/** The settlement transaction from a PAYMENT-RESPONSE header, if there is one. */
export function settlement(headers: Headers): { transaction?: string; network?: string } | null {
  const raw = headers.get('payment-response');
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}
