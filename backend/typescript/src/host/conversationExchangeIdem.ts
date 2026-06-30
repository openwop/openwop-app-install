/**
 * Conversation-exchange idempotency index (ADR 0067 §Phase 2).
 *
 * A retried `exchange` POST (network hiccup, double-submit) must NOT append a
 * duplicate user/assistant turn pair. The dispatch-first ordering in
 * `conversationExchange.ts` already prevents a *dangling* user turn when the
 * provider call fails; this index closes the OTHER half: a SUCCESSFUL exchange
 * that the client retries because it never saw the response.
 *
 * The dedup key lives in a host-ext sidecar — deliberately NOT on the
 * `conversation.exchanged` event payload. That event is normative (RFC 0005);
 * stamping a client idempotency key onto it would be a wire-shape change
 * requiring an OpenWOP RFC. The sidecar is an INDEX, not a second transcript:
 * the run event log remains the only source of turns.
 *
 * Concurrency: the claim is a real cross-instance `compareAndSwap` from null
 * (create-if-absent). A racing second request that loses the create is told the
 * exchange is in progress (409) rather than re-dispatching, so two simultaneous
 * submits of the same key produce exactly one turn pair. A `pending` claim left
 * behind by a crash mid-dispatch is reclaimable after `STALE_MS`.
 *
 * Backed by the host-ext `DurableCollection`. NON-NORMATIVE (`/v1/host/openwop-app/*`).
 *
 * @see docs/adr/0067-ai-chat-conversation-run-default.md
 */

import { DurableCollection } from './hostExtPersistence.js';

/** A pending claim older than this is treated as crash-abandoned and may be
 *  reclaimed by a retry. Bounds the window in which a crashed exchange wedges a
 *  key; comfortably longer than a provider dispatch timeout (120s). */
const STALE_MS = 180_000;

export interface ExchangeClaim {
  tenantId: string;
  conversationId: string;
  exchangeKey: string;
  status: 'pending' | 'committed';
  /** Turn indices the committed exchange produced (for the short-circuit). */
  userTurnIndex?: number;
  agentTurnIndex?: number;
  createdAt: string;
}

const claims = new DurableCollection<ExchangeClaim>(
  'chat:exchange-idem',
  (c) => `${c.tenantId}:${c.conversationId}:${c.exchangeKey}`,
);

export type ClaimOutcome =
  | { outcome: 'claimed' }
  | { outcome: 'committed'; claim: ExchangeClaim }
  | { outcome: 'in_progress' };

/**
 * Attempt to claim an exchange key for `(tenantId, conversationId, exchangeKey)`.
 * - `claimed`     — first writer; the caller dispatches + appends, then commits.
 * - `committed`   — the exchange already succeeded; the caller returns the
 *                   existing turns WITHOUT re-dispatching.
 * - `in_progress` — another live request holds a fresh pending claim; the caller
 *                   returns 409 so the client retries and eventually sees committed.
 */
export async function claimExchange(
  tenantId: string,
  conversationId: string,
  exchangeKey: string,
  nowMs: number,
): Promise<ClaimOutcome> {
  const pending: ExchangeClaim = {
    tenantId, conversationId, exchangeKey, status: 'pending',
    createdAt: new Date(nowMs).toISOString(),
  };
  // Create-if-absent: CAS from null wins only when no claim exists yet.
  if (await claims.compareAndSwap(null, pending)) return { outcome: 'claimed' };

  const existing = await claims.get(`${tenantId}:${conversationId}:${exchangeKey}`);
  if (!existing) {
    // Lost the create but the row vanished (deleted between CAS and get) — retry
    // the create once; if it still loses, report in-progress (fail closed).
    if (await claims.compareAndSwap(null, pending)) return { outcome: 'claimed' };
    return { outcome: 'in_progress' };
  }
  if (existing.status === 'committed') return { outcome: 'committed', claim: existing };

  // A pending claim. Fresh ⇒ another request owns it. Stale ⇒ reclaim it (crash
  // recovery) via CAS so only one retry can take over.
  const ageMs = nowMs - Date.parse(existing.createdAt);
  if (Number.isFinite(ageMs) && ageMs > STALE_MS) {
    if (await claims.compareAndSwap(existing, pending)) return { outcome: 'claimed' };
  }
  return { outcome: 'in_progress' };
}

/** Mark a claimed exchange committed with the turn indices it produced. */
export async function commitExchange(
  tenantId: string,
  conversationId: string,
  exchangeKey: string,
  userTurnIndex: number,
  agentTurnIndex: number,
  nowMs: number,
): Promise<void> {
  await claims.put({
    tenantId, conversationId, exchangeKey, status: 'committed',
    userTurnIndex, agentTurnIndex, createdAt: new Date(nowMs).toISOString(),
  });
}

/** Release a claim that failed to produce turns (e.g. provider dispatch threw),
 *  so a later retry isn't told `in_progress` for the full STALE window. */
export async function releaseExchange(
  tenantId: string,
  conversationId: string,
  exchangeKey: string,
): Promise<void> {
  await claims.delete(`${tenantId}:${conversationId}:${exchangeKey}`);
}

/** Test-only: clear the index. */
export async function __clearExchangeIdem(): Promise<void> {
  await claims.__clear();
}
