/**
 * UI-ENT-1b — mid-session entitlement 403 → refresh the access context.
 *
 * `EntitlementGuard` decides at ROUTE time. If a tenant's entitlement narrows
 * while a page is already open (a subscription lapses, a bundle is revoked), the
 * next fetch 403s and the user sees a generic error Notice instead of the
 * designed locked state — the app looks broken rather than locked.
 *
 * The fix deliberately does NOT add a second locked experience (a competing one
 * that could disagree with the guard is worse than none — the standing
 * `/architect` ruling). It re-runs the EXISTING resolution, so the existing
 * guard re-renders the existing locked state.
 *
 * Why this is safe where the IDN-6 retry was not: this is ADDITIVE. Where it
 * fires the guard corrects; where it does not, behaviour is exactly today's.
 * It never re-sends a request, so it cannot replay a non-idempotent write, and
 * it masks no alarm.
 *
 * Coverage is honestly partial — only calls routed through `requestJson` reach
 * this seam (raw `fetch` call sites do not). That is a smaller correctness
 * surface, not an inconsistent one.
 */

/** Set by the access provider; null when no provider is mounted. */
let reloadAccess: (() => void) | null = null;

/** Register the access-context reloader. Pass null on unmount. */
export function registerEntitlementReloader(fn: (() => void) | null): void {
  reloadAccess = fn;
}

/** Floor between reload attempts. A 403 is not necessarily an ENTITLEMENT 403 —
 *  a superadmin-gated route refuses the same way — and each reload costs TWO
 *  network reads (assignments + entitlements). Without a floor, a surface that
 *  403s repeatedly turns every refusal into three requests, which is exactly the
 *  rate-limit fan-out CLAUDE.md warns about (the per-IP read budget is 60/min by
 *  default). One reload per window is enough: the resolution it triggers is a
 *  full re-read, so coalescing loses nothing. */
const RELOAD_COOLDOWN_MS = 10_000;
let lastReloadAt = 0;

/** Test seam — reset the cooldown so cases do not leak into each other. */
export function __resetEntitlementRefreshForTest(): void {
  lastReloadAt = 0;
}

/**
 * Called for every completed request. A 403 means the server refused on
 * authorization grounds — which INCLUDES a narrowed entitlement — so re-resolve
 * and let the guard decide.
 *
 * Deliberately NOT re-entrant: `featureTogglesClient` fetches assignments and
 * entitlements with raw `fetch`, not `requestJson`, so a 403 on the resolution
 * itself cannot come back through here. Verified rather than assumed — if those
 * reads are ever migrated onto `requestJson`, this becomes a self-feeding loop
 * and needs an explicit in-flight guard.
 *
 * The reload cannot spuriously LOCK a feature: resolution degrades to
 * unrestricted ('*') on any failure.
 */
export function noteRequestStatus(status: number): void {
  if (status !== 403) return;
  const now = Date.now();
  if (now - lastReloadAt < RELOAD_COOLDOWN_MS) return;
  lastReloadAt = now;
  reloadAccess?.();
}
