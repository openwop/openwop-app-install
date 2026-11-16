/**
 * ADR 1136 D4 — which browser is attached for whom.
 *
 * Keyed by tenant and person: a browser belongs to the person who connected it,
 * so a session can only ever drive its opener's own browser. A second attach
 * for the same key retires the first (`replaced` is terminal, as in OpenCode),
 * so two windows cannot both claim to be "my browser".
 *
 * In-memory on purpose: an attachment is a live connection to this instance and
 * means nothing after a restart. The pairing that authorises it is durable and
 * lives with the companion (ADR 0785), not here.
 *
 * P2 entry criterion (release-manager review, 2026-11-16): with more than one
 * Cloud Run instance, an attach on instance A and a session step on instance B
 * miss each other. Before a real executor attaches, P2 needs instance
 * affinity for the attachment or a durable registry with routing to the
 * owning instance. P1 constructs no production adapter, so nothing reads this
 * registry in production yet.
 */
import type { BrowserExecutor } from './executorProtocol.js';

const attached = new Map<string, BrowserExecutor>();

const keyOf = (tenantId: string, personId: string): string => `${tenantId}\u0000${personId}`;

export function attachExecutor(tenantId: string, personId: string, executor: BrowserExecutor): void {
  if (!tenantId || !personId) throw new Error('attachExecutor needs a tenant and a person');
  const key = keyOf(tenantId, personId);
  const previous = attached.get(key);
  if (previous && previous !== executor) previous.markReplaced();
  attached.set(key, executor);
}

/** Detach only if `executor` is still the attached one (a late detach from a
 *  replaced connection must not remove its successor). */
export function detachExecutor(tenantId: string, personId: string, executor: BrowserExecutor): void {
  const key = keyOf(tenantId, personId);
  if (attached.get(key) === executor) attached.delete(key);
}

/** The person's attached browser, or null. A replaced or detached executor is
 *  never returned. */
export function executorFor(tenantId: string, personId: string): BrowserExecutor | null {
  const e = attached.get(keyOf(tenantId, personId));
  return e && e.state() === 'attached' ? e : null;
}

/** Test seam. */
export function _resetExecutorRegistry(): void {
  attached.clear();
}
