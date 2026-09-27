/**
 * Anon → user tenant adoption (ADR 0003 Phase 4c client side).
 *
 * POSTs to /host/openwop-app/migrate-tenant carrying:
 *   - the Bearer ID token (auto-attached by authedHeaders())
 *   - the session cookie (auto-attached by credentials:'include')
 *
 * ADR 0434 Phase 2 — THIS IS A RECONCILIATION, NOT A ONE-SHOT.
 *
 * It previously returned `null` on any non-OK response and on any throw, with a
 * comment claiming "401 here means the OIDC token wasn't ready yet — caller can
 * retry after onIdTokenChanged fires". No caller ever retried, and the only
 * caller ran on an explicit sign-in click. So a token-cache race at sign-in
 * stranded the visitor's entire anonymous sandbox permanently: the anon cookie
 * aged out at 24h and that tenant became unreachable. That is a direct cause of
 * "same account, different data on my other machine".
 *
 * Two changes make it converge:
 *   1. transient failures RETRY with backoff — the token genuinely may not be
 *      cached on the first attempt;
 *   2. it is safe on EVERY session restore, not just sign-in, because the
 *      server answers `migrated: false` when there is nothing to adopt.
 */

import { config, authedHeaders, fetchOpts } from '../client/config.js';

export interface MigrateResult {
  migrated: boolean;
  runs: number;
  workflows: number;
  secrets: number;
}

/** Retry-worthy: the token may not be cached yet (401), we may be rate-limited
 *  (429), or the server may be briefly unhealthy (5xx). 403 is terminal —
 *  retrying a refusal only burns the per-IP budget. */
function isRetryable(status: number): boolean {
  return status === 401 || status === 429 || status >= 500;
}

const RETRY_DELAYS_MS = [250, 1000, 3000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Attempt adoption, retrying transient failures. Resolves to the result, or
 * null when there is nothing to adopt / adoption is not currently possible.
 * Never throws — sign-in must never be blocked by this.
 */
export async function migrateAnonToUser(): Promise<MigrateResult | null> {
  for (let attempt = 0; ; attempt += 1) {
    let retryable = false;
    try {
      const res = await fetch(
        `${config.baseUrl}/host/openwop-app/migrate-tenant`,
        fetchOpts({
          method: 'POST',
          headers: authedHeaders({ 'content-type': 'application/json' }),
          body: '{}',
        }),
      );
      if (res.ok) return (await res.json()) as MigrateResult;
      if (!isRetryable(res.status)) return null;
      retryable = true;
      if (attempt >= RETRY_DELAYS_MS.length) {
        // Out of attempts on a transient error. The sandbox is still adoptable
        // on the next session restore, so surface it rather than pretending
        // nothing happened — silence here is the original bug.
        console.warn('openwop: anon-sandbox adoption exhausted retries', { status: res.status });
        return null;
      }
    } catch {
      // Network blip — same policy as a 5xx.
      retryable = true;
      if (attempt >= RETRY_DELAYS_MS.length) return null;
    }
    if (!retryable) return null;
    await sleep(RETRY_DELAYS_MS[attempt] ?? 3000);
  }
}
