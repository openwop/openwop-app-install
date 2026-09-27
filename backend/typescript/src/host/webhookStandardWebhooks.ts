/**
 * RFC 0201 / ADR 0747 — the ONE source for what this host offers under the
 * Standard Webhooks companion scheme. Discovery advertises from here and the
 * registration/rotation routes validate against here, so the advert and the
 * behaviour cannot disagree (the v1 and v2 roots both read the same list).
 */
import { STANDARD_WEBHOOKS_ALG } from './webhookSignature.js';

/** Every id `webhooks.signatureAlgorithms[]` lists, v1 AND v2. `v1` first and
 *  always present (both majors require it; the v2 facet enforces it by
 *  `contains`). */
export const SUPPORTED_SIGNATURE_ALGORITHMS: readonly string[] = ['v1', STANDARD_WEBHOOKS_ALG];

/** Is this subscription opted in? Absent means `["v1"]` (RFC 0201 §B.4). */
export function isStandardWebhooksOptIn(sub: { signatureAlgorithms?: readonly string[] }): boolean {
  return sub.signatureAlgorithms?.includes(STANDARD_WEBHOOKS_ALG) === true;
}

const OVERLAP_ENV = 'OPENWOP_WEBHOOK_SECRET_ROTATION_OVERLAP_S';
const OVERLAP_DEFAULT_S = 86_400;
const OVERLAP_MIN_S = 60;
const OVERLAP_MAX_S = 604_800;

/**
 * `webhooks.secretRotation.overlapSeconds` (RFC 0201 §E.18, schema 60–604800).
 * One day by default — long enough for a subscriber to roll its verifier
 * without an incident. An out-of-range or unparseable knob falls back to the
 * default rather than clamping, so a typo never silently advertises a window
 * the operator did not choose. The conformance lane sets 60 so the
 * post-overlap leg fits the suite's 90 s wait cap.
 */
export function secretRotationOverlapSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[OVERLAP_ENV];
  if (raw === undefined || raw === '') return OVERLAP_DEFAULT_S;
  const n = Number(raw);
  return Number.isInteger(n) && n >= OVERLAP_MIN_S && n <= OVERLAP_MAX_S ? n : OVERLAP_DEFAULT_S;
}

const VERIFY_RATE_ENV = 'OPENWOP_WEBHOOK_VERIFY_PER_TENANT_PER_MIN';
const VERIFY_RATE_DEFAULT = 10;
const WINDOW_MS = 60_000;
const verifyWindows = new Map<string, { start: number; count: number }>();

/**
 * RFC 0201 §D.17 — "A host SHOULD rate-limit opted-in registrations per
 * tenant." Each opted-in registration costs a third-party endpoint one
 * request, so an unthrottled tenant could still aim a stream of verification
 * POSTs at a victim even though none of them ever becomes a subscription.
 * Counted BEFORE the verification is sent, so a refused registration spends
 * budget exactly like an accepted one — the cost lands on the endpoint either
 * way.
 *
 * Per INSTANCE (a fixed one-minute window in memory), so the effective ceiling
 * is this × the instance count. That is the right weight for a SHOULD the
 * suite cannot attribute; the per-IP write budget in `middleware/rateLimit.ts`
 * sits in front of it as well. Returns false when the tenant is over budget.
 */
export function takeVerificationBudget(tenantId: string, now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = Number(env[VERIFY_RATE_ENV]);
  const limit = Number.isInteger(raw) && raw > 0 ? raw : VERIFY_RATE_DEFAULT;
  const w = verifyWindows.get(tenantId);
  if (w === undefined || now - w.start >= WINDOW_MS) {
    // Opportunistic sweep so the map is bounded by tenants active this minute.
    if (verifyWindows.size > 10_000) {
      for (const [k, v] of verifyWindows) if (now - v.start >= WINDOW_MS) verifyWindows.delete(k);
    }
    verifyWindows.set(tenantId, { start: now, count: 1 });
    return true;
  }
  if (w.count >= limit) return false;
  w.count += 1;
  return true;
}

/** Test-only reset. */
export function __resetVerificationBudgetForTests(): void {
  verifyWindows.clear();
}
