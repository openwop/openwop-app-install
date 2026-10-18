/**
 * ADR 0873 D12 — the last positive entitlement answer, for a feature that opts in
 * with `offline.entitlement: 'last-known'`.
 *
 * Offline, `EntitlementGuard` cannot ask the server, so by default it fails closed
 * to an offline notice. A feature with its own device copy (Book AI's save queue
 * and encrypted store) would lose that data behind the notice, so it may opt in:
 * the guard then accepts the last positive answer it saw online, under these rules.
 *
 * - **Keyed** by (principal, tenant, feature), where both come from the
 *   assignments response's `caller` echo: the subject the answer was resolved FOR,
 *   i.e. the ACTIVE workspace. Not `/me`, whose `tenantId` is the HOME tenant and
 *   stays put across a workspace switch. Persisted because nothing answers offline;
 *   an answer for a new identity drops every grant the previous one held.
 * - **Network errors only.** The guard consults a grant only when the resolution
 *   failed to reach the server. A 401, a 403 or a "not entitled" answer is
 *   authoritative and deletes grants; a 5xx keeps today's degrade-to-render.
 * - **Bounded** by `VITE_OFFLINE_ENTITLEMENT_TTL_H` (default 24 hours).
 * - **localStorage**, so an installed app's cold start, a new session, can read it.
 * - **Deleted** on sign-out, beside the D8 cache purge (`auth/firebase.ts signOut`).
 * - **Written only when a feature opts in**: the provider records nothing for an
 *   empty opt-in list, so no build that does not need it stores an identity.
 *
 * It grants nothing on the server: every write still enforces entitlement on
 * reconnect. The worst case, a revoked entitlement, is a user drafting into their
 * own device copy for up to the TTL.
 *
 * This module sits in the entry chunk (the provider and guard import it), so it
 * imports nothing.
 */

const STORAGE_KEY = 'openwop:offline-entitlement';
const DEFAULT_TTL_H = 24;

export interface EntitlementIdentity {
  userId: string;
  tenantId: string;
}

interface Stored {
  v: 1;
  identity: EntitlementIdentity | null;
  /** `${userId}\n${tenantId}\n${featureId}` → epoch ms of the positive answer. */
  grants: Record<string, number>;
}

const EMPTY: Stored = { v: 1, identity: null, grants: {} };

function read(): Stored {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (parsed?.v !== 1 || typeof parsed.grants !== 'object' || parsed.grants === null) return EMPTY;
    const id = parsed.identity;
    const identity = id && typeof id.userId === 'string' && typeof id.tenantId === 'string' ? { userId: id.userId, tenantId: id.tenantId } : null;
    return { v: 1, identity, grants: parsed.grants };
  } catch {
    return EMPTY; // storage blocked or a corrupt value: no grant, so fail closed
  }
}

function write(next: Stored): void {
  try {
    if (!next.identity && Object.keys(next.grants).length === 0) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: nothing persists, so the guard fails closed offline.
  }
}

const keyOf = (id: EntitlementIdentity, featureId: string): string => `${id.userId}\n${id.tenantId}\n${featureId}`;

/** The host's TTL in milliseconds. A missing, non-numeric or non-positive value
 *  falls back to the default rather than disabling the bound. */
export function lastKnownTtlMs(raw: unknown = import.meta.env.VITE_OFFLINE_ENTITLEMENT_TTL_H): number {
  const h = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_TTL_H) * 3_600_000;
}

/**
 * Apply an ONLINE resolution for `identity` (the subject it was resolved FOR):
 * features in `entitled` get a fresh grant, features in `notEntitled` lose theirs.
 * An identity other than the stored one replaces it and drops its grants first.
 */
export function recordEntitlementAnswer(identity: EntitlementIdentity, entitled: readonly string[], notEntitled: readonly string[], now: number = Date.now()): void {
  const cur = read();
  const same = cur.identity?.userId === identity.userId && cur.identity?.tenantId === identity.tenantId;
  const id = { userId: identity.userId, tenantId: identity.tenantId };
  const grants = same ? { ...cur.grants } : {};
  for (const f of entitled) grants[keyOf(id, f)] = now;
  for (const f of notEntitled) delete grants[keyOf(id, f)];
  write({ v: 1, identity: id, grants });
}

/** A 401 or a 403 on the resolution: delete every grant, keep the identity. */
export function revokeLastKnownEntitlements(): void {
  const cur = read();
  write({ ...cur, grants: {} });
}

/** Sign-out: delete the identity and every grant. Never throws. */
export function clearLastKnownEntitlements(): void {
  write(EMPTY);
}

/** Whether the identity of the last online answer holds an unexpired grant for
 *  `featureId`. A grant dated in the future (a clock moved back) does not count. */
export function hasLastKnownEntitlement(featureId: string, now: number = Date.now(), ttlMs: number = lastKnownTtlMs()): boolean {
  const cur = read();
  if (!cur.identity) return false;
  const at = cur.grants[keyOf(cur.identity, featureId)];
  return typeof at === 'number' && at <= now && now - at <= ttlMs;
}

/**
 * A failure that never reached the server. Mirrors `client/config.ts`
 * `isOfflineError` (fetch rejects with `TypeError` for network/DNS/CORS failures
 * and `AbortError` when cancelled), restated here because the access provider's
 * tests mock `client/config.js`.
 */
export function isNetworkFailure(err: unknown): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true;
  return err instanceof TypeError;
}
