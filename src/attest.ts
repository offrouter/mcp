// Finds the enclave's encryption key without taking the gateway's word for it.
//
// We ask for an attestation report that covers a random nonce we just made up,
// then check it with the enclave gateway's reference verifier: the Intel TDX
// quote has to verify up to Intel's root, the report has to cover our nonce
// and the key set, and the boot log has to replay to the measured launch file.
// Only then do we use a key from it. A key from a report that fails any of
// those could belong to anyone, including the gateway.
import { verifyComposeMeasurement, verifyQuote, verifyReportBinding } from '@phala/aci-verifier';
import type { AttestationReport } from '@phala/aci-verifier';
import { randomBytes } from 'node:crypto';
import { chooseKey, type ServiceKey } from './e2ee.js';

export type Enclave = {
  key: ServiceKey;
  /** Digest of the key set the hardware report vouches for. */
  keyset: string;
  /** Unix seconds after which the key set should not be used. */
  notAfter: number;
  /** Commit of the open source enclave gateway, when the measured launch file pins one. */
  commit: string | null;
  repo: string | null;
  verifiedAt: number;
};

const failed = (checks: { name: string; ok: boolean; detail?: string }[]) =>
  checks
    .filter((c) => !c.ok)
    .map((c) => c.detail || c.name)
    .join('; ');

export class AttestationError extends Error {}

export async function verifyEnclave(baseUrl: string): Promise<Enclave> {
  const nonce = randomBytes(32).toString('hex');
  const res = await fetch(`${baseUrl}/v1/private/attestation?nonce=${nonce}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new AttestationError(`the attestation endpoint answered ${res.status}`);
  const report = (await res.json()) as AttestationReport;

  const quote = await verifyQuote(report);
  if (!quote.ok) throw new AttestationError(`the hardware quote did not verify: ${quote.detail || 'no reason given'}`);

  const binding = await verifyReportBinding(report, nonce);
  if (!binding.ok || !binding.keyset || !binding.workloadKeysetDigest) {
    throw new AttestationError(`the report does not cover our nonce and key set: ${failed(binding.checks) || 'no key set bound'}`);
  }

  const code = await verifyComposeMeasurement(report);
  if (!code.ok) throw new AttestationError(`the boot measurement does not match: ${failed(code.checks) || 'no reason given'}`);

  const keyset = binding.keyset;
  if (keyset.not_after * 1000 < Date.now()) throw new AttestationError('the key set has expired');

  const key = chooseKey(keyset.e2ee_public_keys);
  if (!key) throw new AttestationError('the enclave offers no encryption key this client supports');

  const src = report.attestation.source_provenance as { repo_url?: unknown; repo_commit?: unknown } | undefined;
  const commit = typeof src?.repo_commit === 'string' && /^[0-9a-f]{40}$/.test(src.repo_commit) ? src.repo_commit : null;
  const compose = String((report.attestation.evidence as Record<string, unknown>)?.app_compose ?? '');
  const pinned = commit && compose.includes(commit) ? commit : null;
  const repo = typeof src?.repo_url === 'string' ? (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(?=\.git$|$)/.exec(src.repo_url)?.[0] ?? null) : null;

  return { key, keyset: binding.workloadKeysetDigest, notAfter: keyset.not_after, commit: pinned, repo, verifiedAt: Date.now() };
}

/**
 * Keeps one verified enclave key around so we don't re-run the full check on
 * every call. It is dropped when the key set is close to expiring, or when the
 * enclave rejects a request (which usually means the key rotated).
 */
export class EnclaveCache {
  private current: Promise<Enclave> | null = null;

  constructor(private baseUrl: string) {}

  get(): Promise<Enclave> {
    if (this.current) {
      return this.current.then((e) => (e.notAfter * 1000 - Date.now() > 60_000 ? e : this.refresh()));
    }
    return this.refresh();
  }

  refresh(): Promise<Enclave> {
    const next = verifyEnclave(this.baseUrl);
    this.current = next;
    // A failed check should not stick around and poison later calls.
    next.catch(() => {
      if (this.current === next) this.current = null;
    });
    return next;
  }
}
