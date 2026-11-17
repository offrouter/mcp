// Finds the key private web searches are encrypted to, without taking anyone's
// word for it.
//
// Search and fetch run in OffRouter's Private Gateway enclave. Its Intel TDX
// quote names one key in its report data: the address the enclave signs with.
// We check the quote up to Intel's root, replay the boot log to the measured
// launch file, and then check that this address signed the web key. A key that
// fails any of those could be anyone's, the API in between included.
import { verifyQuote } from '@phala/aci-verifier';
import type { AttestationReport } from '@phala/aci-verifier';
import { createHash } from 'node:crypto';
import { getAddress, verifyMessage, type Hex } from 'viem';
import { AttestationError } from './attest.js';

export type WebEnclave = {
  /** The X25519 key requests are encrypted to. */
  publicKey: string;
  /** The enclave's signer: it signed the key, and it signs every receipt. */
  gateway: `0x${string}`;
  /** sha256 of the launch file the enclave booted (the compose hash in its boot log). */
  composeHash: string | null;
  search: boolean;
  fetch: boolean;
  priceUsd: { search: number; fetch: number };
  verifiedAt: number;
};

/** What the signer signs to vouch for the web key. Must match gateway/src/sealed.ts. */
export const keyStatement = (publicKey: string) => `OffRouter private web key v1: ${publicKey}`;

type BootEvent = { imr: number; event_type: number; digest: string; event?: string; event_payload?: string };

const unhex = (h: string) => Buffer.from(h.replace(/^0x/, ''), 'hex');

/** RTMR3 as the TDX module extends it, replayed from the boot log. Each digest is recomputed from its payload. */
export function replayRtmr3(log: BootEvent[]): Buffer {
  let mr = Buffer.alloc(48);
  for (const ev of log) {
    if (ev.imr !== 3) continue;
    const type = Buffer.alloc(4);
    type.writeUInt32LE(ev.event_type >>> 0);
    const digest = createHash('sha384').update(Buffer.concat([type, Buffer.from(`:${ev.event ?? ''}:`), unhex(ev.event_payload ?? '')])).digest();
    if (ev.digest && ev.digest.toLowerCase() !== digest.toString('hex')) throw new AttestationError(`the boot log's ${ev.event ?? 'unnamed'} event does not match its payload`);
    mr = createHash('sha384').update(Buffer.concat([mr, digest])).digest();
  }
  return mr;
}

export async function verifyWebEnclave(baseUrl: string): Promise<WebEnclave> {
  const [qRes, iRes] = await Promise.all([fetch(`${baseUrl}/v1/web/attestation`), fetch(`${baseUrl}/v1/web`)]);
  if (!qRes.ok) throw new AttestationError(`the web attestation endpoint answered ${qRes.status}`);
  if (!iRes.ok) throw new AttestationError(iRes.status === 503 ? 'private web search is not available yet' : `GET /v1/web answered ${iRes.status}`);
  const q = (await qRes.json()) as { quote?: string; event_log?: string; report_data?: string };
  const info = (await iRes.json()) as any;

  // 1. Intel signed the quote, and its report data is one address followed by zeros.
  const rd = String(q.report_data ?? '').toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}0{88}$/.test(rd)) throw new AttestationError('the quote\'s report data is not an address followed by zeros');
  const report = { attestation: { tee_type: 'tdx', report_data: rd.slice(0, 64), evidence: { quote: q.quote } } } as unknown as AttestationReport;
  const quote = await verifyQuote(report);
  if (!quote.ok) throw new AttestationError(`the hardware quote did not verify: ${quote.detail || 'no reason given'}`);
  const quoted = unhex(q.quote!);
  // The report data inside the quote itself, not the copy beside it.
  if (quoted.subarray(568, 632).toString('hex') !== rd) throw new AttestationError('the quote does not carry the report data it was served with');
  const gateway = getAddress(`0x${rd.slice(0, 40)}`);

  // 2. The boot log replays to the RTMR3 inside the quote.
  let composeHash: string | null = null;
  try {
    const log = JSON.parse(q.event_log ?? '') as BootEvent[];
    if (!replayRtmr3(log).equals(quoted.subarray(520, 568))) throw new AttestationError('the boot log does not replay to what the quote measured');
    composeHash = log.find((e) => e.imr === 3 && e.event === 'compose-hash')?.event_payload ?? null;
  } catch (e) {
    throw e instanceof AttestationError ? e : new AttestationError('the boot log could not be read');
  }

  // 3. That address signed the web key.
  const pub = String(info?.e2ee?.public_key ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pub)) throw new AttestationError('GET /v1/web gave no web key');
  if (String(info.gateway ?? '').toLowerCase() !== gateway.toLowerCase()) throw new AttestationError('the web key is offered by another signer than the one the quote names');
  const ok = await verifyMessage({ address: gateway, message: keyStatement(pub), signature: info.e2ee.signature as Hex }).catch(() => false);
  if (!ok) throw new AttestationError('the web key is not signed by the enclave\'s signer');

  return {
    publicKey: pub,
    gateway,
    composeHash,
    search: !!info.search?.available,
    fetch: !!info.fetch?.available,
    priceUsd: { search: Number(info.price?.search_usd ?? 0), fetch: Number(info.price?.fetch_usd ?? 0) },
    verifiedAt: Date.now(),
  };
}

/** One verified web key, kept for 10 minutes, and dropped as soon as the enclave turns a request down as stale. */
export class WebEnclaveCache {
  private current: { at: number; value: Promise<WebEnclave> } | null = null;
  constructor(private baseUrl: string) {}

  get(): Promise<WebEnclave> {
    if (this.current && Date.now() - this.current.at < 10 * 60_000) return this.current.value;
    return this.refresh();
  }

  refresh(): Promise<WebEnclave> {
    const value = verifyWebEnclave(this.baseUrl);
    const entry = { at: Date.now(), value };
    this.current = entry;
    value.catch(() => {
      if (this.current === entry) this.current = null;
    });
    return value;
  }
}

/** Did the enclave's signer sign this receipt? */
export async function receiptSigned(gateway: `0x${string}`, receipt: unknown, signature: unknown): Promise<boolean> {
  if (typeof receipt !== 'string' || typeof signature !== 'string') return false;
  return verifyMessage({ address: gateway, message: receipt, signature: signature as Hex }).catch(() => false);
}
