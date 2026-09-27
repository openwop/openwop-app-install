/**
 * Connection-lifecycle seam (ADR 0285) — the dependency-safe hook by which OTHER
 * features react when a Connection credential is REVOKED, without the connections
 * feature importing them. The third instance of the keyed-registry lifecycle
 * pattern (`commerce/productLifecycleSeam.ts` #1337, `host/crmRecordLifecycle.ts`
 * ADR 0283) — same contract: KEYED registration (repeated boots overwrite the
 * slot, never stack), handlers idempotent + bounded, best-effort fan-out that
 * never throws or blocks the revoke, FIRED AFTER the credential + row are gone
 * (fail-closed: a mid-way handler failure leaves re-markable rows, never a
 * resurrected credential).
 *
 * Consumers DISABLE, never delete (architect ruling): a revoked credential's
 * dependent configs (inbound webhooks, sync sources, gmail syncs) are
 * user-authored work — marking them paused/disabled shows the user what broke
 * and makes re-connecting a resume, not a rebuild. Use-time was already
 * fail-closed (a missing secret fails); this seam adds visibility and stops
 * daemons/schedulers from retrying a dead credential.
 */
export interface ConnectionRevokedEvent {
  tenantId: string;
  connectionId: string;
  /** The provider id of the revoked connection (consumers may filter on it). */
  provider?: string;
}

type ConnectionRevokedHandler = (e: ConnectionRevokedEvent) => Promise<void>;

const handlers = new Map<string, ConnectionRevokedHandler>();

/** A consumer feature registers (idempotently, keyed) its disable-hook at boot. */
export function onConnectionRevoked(key: string, fn: ConnectionRevokedHandler): void {
  handlers.set(key, fn);
}

/** Called by `revokeConnection` AFTER the secret + row are deleted; runs every
 *  registrant best-effort. Never throws. Returns how many handlers ran. */
export async function fireConnectionRevoked(e: ConnectionRevokedEvent): Promise<number> {
  let ran = 0;
  for (const h of handlers.values()) {
    try { await h(e); ran += 1; } catch { /* a consumer's failure must not block the revoke */ }
  }
  return ran;
}

/**
 * ADR 0627 D5 — a connection's STATUS moved without a revoke (today: the broker
 * flipping an oauth2 connection to `needs-reconsent` on a failed refresh /
 * unparseable token material). A separate event on purpose: `fireConnectionRevoked`
 * is a REVOKE (credential + row gone) and consumers treat it as "pause, the user
 * must reconnect a NEW connection"; a status change leaves the row in place and
 * the honest consumer state is "needs re-consent on THIS connection". Overloading
 * the revoke event would make every existing consumer disable on a transient
 * refresh failure. Same keyed-registry contract as the revoke hook.
 */
export interface ConnectionStatusChangedEvent {
  tenantId: string;
  connectionId: string;
  provider: string;
  /** `revoked` is never a status TRANSITION on a live row (a revoke deletes the
   *  row and fires `fireConnectionRevoked`), so it is not in this union. */
  status: 'active' | 'needs-reconsent' | 'expired';
  previousStatus: 'active' | 'needs-reconsent' | 'expired';
}

type ConnectionStatusChangedHandler = (e: ConnectionStatusChangedEvent) => Promise<void>;

const statusHandlers = new Map<string, ConnectionStatusChangedHandler>();

/** A consumer feature registers (idempotently, keyed) its status hook at boot. */
export function onConnectionStatusChanged(key: string, fn: ConnectionStatusChangedHandler): void {
  statusHandlers.set(key, fn);
}

/** Called by the connections service AFTER a status transition landed on the
 *  row (never on a same-status re-write). Best-effort; never throws. */
export async function fireConnectionStatusChanged(e: ConnectionStatusChangedEvent): Promise<number> {
  let ran = 0;
  for (const h of statusHandlers.values()) {
    try { await h(e); ran += 1; } catch { /* a consumer's failure must not block the status write */ }
  }
  return ran;
}

/** Test-only: drop all registrations so suites don't leak handlers across files. */
export function __resetConnectionLifecycleHooks(): void {
  handlers.clear();
  statusHandlers.clear();
}
