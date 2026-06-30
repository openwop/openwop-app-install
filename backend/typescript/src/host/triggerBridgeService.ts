/**
 * Durable trigger bridge -- RFC 0083 reference durable-delivery (best-effort).
 *
 * Implements the RFC 0083 section B subscription state machine + section C delivery model
 * (dedup -> attempt -> retry -> dead-letter -> trigger->run causation) that the RFC
 * deferred to `Active -> Accepted`. A `TriggerSubscription` is a durable inbound
 * work source; `deliver()` wraps a "fire this run" thunk with at-least-once ->
 * effectively-once semantics:
 *
 *   - DEDUP (section C-1): a repeat `dedupKey` within retention is a no-op returning
 *     the prior runId -- at-least-once becomes effectively-once.
 *   - ATTEMPT + RETRY (section C-2): each attempt is recorded; on failure it retries
 *     up to `retryPolicy.maxAttempts`; on exhaustion the subscription
 *     transitions `active -> dead-lettered` (reason `retry-exhausted`).
 *   - CAUSATION (section C-3): a delivered run is created with `causationId` = the
 *     delivery id, so `/ancestry` resolves delivery -> run (the caller's `fire`
 *     thunk threads the delivery id onto the run).
 *
 * The two `trigger.*` events are emitted by the caller on the resulting run's
 * stream (this module is pure state + the delivery algorithm, testable without
 * a server). The store is now a read-through, per-entity durable collection
 * (subscriptions, delivery attempts, and the dedup index each one row per
 * entity) -- so effectively-once + the delivery history are consistent across
 * instances and survive restarts. A production host backs it with a durable
 * queue + the RFC 0053 dead-letter sink.
 *
 * @see spec/v1/trigger-bridge.md section B/section C  -  RFCS/0083-durable-trigger-and-channel-bridge-profile.md
 * @see schemas/trigger-subscription.schema.json
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';

export type SubscriptionSource = 'webhook' | 'schedule' | 'queue' | 'email' | 'form';
export type SubscriptionState = 'active' | 'paused' | 'failed' | 'dead-lettered';
export type DeliveryOutcome = 'delivered' | 'retrying' | 'dead-lettered';

export interface RetryPolicy {
  maxAttempts: number;
  backoff: 'none' | 'fixed' | 'exponential';
}

/** RFC 0099 §F.2 — source-authenticity policy stamped on an external-event
 *  subscription. `required` ⇒ an event that fails verification MUST NOT start a
 *  run (it dead-letters with reason `signature-invalid`). */
export type VerificationMode = 'required' | 'best-effort' | 'none';

export interface TriggerSubscription {
  subscriptionId: string;
  source: SubscriptionSource;
  state: SubscriptionState;
  dedupEnabled: boolean;
  retryPolicy: RetryPolicy;
  tenantId: string;
  label?: string;
  /** RFC 0099 §F.2 — the Workflow a delivered external event starts. Present on
   *  external-event subscriptions (webhook/email/form) registered via
   *  `POST /v1/trigger-subscriptions`; absent on internal sources (the Kanban
   *  `queue` subscription resolves its workflow per-card). */
  workflowId?: string;
  /** RFC 0099 §F.2 — source-authenticity policy. Defaults `required` for
   *  external sources. */
  verificationMode?: VerificationMode;
  /** RFC 0099 §F.2 — `sha256(secret).slice(0,8)` of the webhook signing secret
   *  (webhook source only). The cleartext secret is returned ONCE at
   *  registration and never persisted (re-reads return the fingerprint). */
  secretFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryAttempt {
  deliveryId: string;
  subscriptionId: string;
  dedupKey: string;
  attempt: number;
  outcome: DeliveryOutcome;
  runId?: string;
  at: string;
}

export interface DeliverResult {
  outcome: 'delivered' | 'deduped' | 'dead-lettered' | 'skipped';
  /** The delivery id used as the run's `causationId` (delivered case). */
  deliveryId: string;
  runId?: string;
  attempts: number;
  stateChange?: { from: SubscriptionState; to: SubscriptionState; reason: 'retry-exhausted' };
}

/** The dedup index row: `dedupKey -> { prior runId, insertion epoch ms }`. */
interface DedupRow {
  k: string;
  runId: string;
  at: number;
}

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, backoff: 'fixed' };

/**
 * Base inter-attempt delay (ms) for the retry loop. Defaults to 0 under a
 * test runner (so the suite stays fast) and to a real value otherwise, so a
 * transient downstream failure no longer burns every attempt in microseconds
 * (INT-2). Operators tune it with `OPENWOP_TRIGGER_RETRY_BASE_MS`.
 */
const RETRY_BASE_MS = (() => {
  const raw = process.env.OPENWOP_TRIGGER_RETRY_BASE_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 250;
  }
  return process.env.VITEST || process.env.NODE_ENV === 'test' ? 0 : 250;
})();

/** Delay before the next attempt per the subscription's backoff strategy. */
function backoffDelayMs(attempt: number, backoff: RetryPolicy['backoff']): number {
  if (RETRY_BASE_MS === 0 || backoff === 'none') return 0;
  if (backoff === 'fixed') return RETRY_BASE_MS;
  // exponential: base * 2^(attempt-1), capped at 30s.
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), 30_000);
}

/** Dedup retention window (section C-1: the idempotency.md Layer-1 >=24h
 *  floor). A `dedupKey` older than this is evicted and a re-delivery is
 *  treated as fresh. Overridable in tests via `__setDedupRetentionMs`. */
let dedupRetentionMs = 24 * 60 * 60 * 1000;
/** Hard cap on the dedup index size (a backstop against unbounded growth
 *  between retention sweeps on a busy host). */
const DEDUP_MAX_ENTRIES = 50_000;

const subscriptions = new DurableCollection<TriggerSubscription>('triggerbridge:sub', (s) => s.subscriptionId);
// A single deliveryId spans multiple attempt rows (retry/dead-letter), so the
// row key is composite: `<deliveryId>:<attempt>`.
const deliveriesCol = new DurableCollection<DeliveryAttempt>('triggerbridge:delivery', (d) => `${d.deliveryId}:${d.attempt}`);
const dedupCol = new DurableCollection<DedupRow>('triggerbridge:dedup', (r) => r.k);

function nowIso(): string {
  return new Date().toISOString();
}

function nowMs(): number {
  return Date.parse(nowIso());
}

/** Evict dedup entries past the retention window, then trim oldest-first if
 *  still over the hard cap. Called on each delivery (best-effort sweep). */
async function evictStaleDedup(): Promise<void> {
  // Expired ⇔ now - at >= retentionMs ⇔ at <= now - retentionMs (so a 0ms
  // retention expires an entry on the very next delivery, even within the
  // same millisecond).
  const cutoff = nowMs() - dedupRetentionMs;
  const rows = await dedupCol.list();
  const live: DedupRow[] = [];
  for (const r of rows) {
    if (r.at <= cutoff) {
      await dedupCol.delete(r.k);
    } else {
      live.push(r);
    }
  }
  if (live.length > DEDUP_MAX_ENTRIES) {
    live.sort((a, b) => a.at - b.at); // oldest first
    const overflow = live.length - DEDUP_MAX_ENTRIES;
    for (let i = 0; i < overflow; i++) await dedupCol.delete(live[i]!.k);
  }
}

/** Host-opaque dedup key (section C-1): a one-way hash, never inbound content in
 *  cleartext. */
export function makeDedupKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('')).digest('hex').slice(0, 32);
}

/** Test-only: override the dedup retention window. */
export function __setDedupRetentionMs(ms: number): void {
  dedupRetentionMs = ms;
}

/**
 * Register (or return the existing) subscription. Idempotent by
 * `subscriptionId` -- a caller (e.g. a Kanban board) uses a deterministic id so
 * one durable subscription backs the source across restarts.
 */
export async function registerSubscription(input: {
  subscriptionId: string;
  tenantId: string;
  source: SubscriptionSource;
  dedupEnabled?: boolean;
  retryPolicy?: Partial<RetryPolicy>;
  label?: string;
  workflowId?: string;
  verificationMode?: VerificationMode;
  secretFingerprint?: string;
}): Promise<TriggerSubscription> {
  const existing = await subscriptions.get(input.subscriptionId);
  if (existing) return existing;
  const sub: TriggerSubscription = {
    subscriptionId: input.subscriptionId,
    source: input.source,
    state: 'active',
    dedupEnabled: input.dedupEnabled ?? true,
    retryPolicy: { ...DEFAULT_RETRY, ...input.retryPolicy },
    tenantId: input.tenantId,
    label: input.label,
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    ...(input.verificationMode ? { verificationMode: input.verificationMode } : {}),
    ...(input.secretFingerprint ? { secretFingerprint: input.secretFingerprint } : {}),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await subscriptions.put(sub);
  return sub;
}

export async function getSubscription(subscriptionId: string): Promise<TriggerSubscription | null> {
  return subscriptions.get(subscriptionId);
}

export async function listSubscriptions(tenantId: string): Promise<TriggerSubscription[]> {
  return (await subscriptions.list())
    .filter((s) => s.tenantId === tenantId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listDeliveries(subscriptionId: string): Promise<DeliveryAttempt[]> {
  return (await deliveriesCol.list())
    .filter((d) => d.subscriptionId === subscriptionId)
    .sort((a, b) => a.at.localeCompare(b.at) || a.attempt - b.attempt);
}

/** Operator pause/resume (section B). Returns the state change, or null if a no-op. */
export async function setSubscriptionState(
  subscriptionId: string,
  toState: SubscriptionState,
): Promise<{ from: SubscriptionState; to: SubscriptionState } | null> {
  const sub = await subscriptions.get(subscriptionId);
  if (!sub || sub.state === toState) return null;
  const from = sub.state;
  sub.state = toState;
  sub.updatedAt = nowIso();
  await subscriptions.put(sub);
  return { from, to: toState };
}

/**
 * Deliver an inbound event through the section C model. `fire(deliveryId)` MUST create
 * + start the run with `causationId = deliveryId` and resolve its runId (or
 * throw to trigger a retry). Returns the outcome + the delivery id (the run's
 * causationId) + the per-call attempt records (also queryable via
 * `listDeliveries`). The caller emits the `trigger.delivery.attempted` event on
 * the resulting run.
 */
export async function deliver(input: {
  subscriptionId: string;
  dedupKey: string;
  fire: (deliveryId: string) => Promise<string>;
}): Promise<DeliverResult> {
  const sub = await subscriptions.get(input.subscriptionId);
  if (!sub) return { outcome: 'skipped', deliveryId: '', attempts: 0 };
  if (sub.state !== 'active') return { outcome: 'skipped', deliveryId: '', attempts: 0 };

  // section C-1 dedup -- effectively-once, bounded by the retention window.
  if (sub.dedupEnabled) {
    await evictStaleDedup();
    const prior = await dedupCol.get(input.dedupKey);
    if (prior !== null) {
      return { outcome: 'deduped', deliveryId: '', runId: prior.runId, attempts: 0 };
    }
  }

  const deliveryId = `dlv-${randomUUID()}`;
  const max = Math.max(1, sub.retryPolicy.maxAttempts);
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      const runId = await input.fire(deliveryId);
      await deliveriesCol.put({ deliveryId, subscriptionId: sub.subscriptionId, dedupKey: input.dedupKey, attempt, outcome: 'delivered', runId, at: nowIso() });
      if (sub.dedupEnabled) await dedupCol.put({ k: input.dedupKey, runId, at: nowMs() });
      return { outcome: 'delivered', deliveryId, runId, attempts: attempt };
    } catch {
      const last = attempt === max;
      await deliveriesCol.put({
        deliveryId,
        subscriptionId: sub.subscriptionId,
        dedupKey: input.dedupKey,
        attempt,
        outcome: last ? 'dead-lettered' : 'retrying',
        at: nowIso(),
      });
      // Back off before the next attempt per the subscription's policy
      // (0ms under test runners; see RETRY_BASE_MS). Skipped after the last
      // attempt, which falls through to dead-letter below.
      if (!last) {
        const delay = backoffDelayMs(attempt, sub.retryPolicy.backoff);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  // section C-2 exhaustion -> section B dead-letter (routed to the RFC 0053 sink in prod).
  const from = sub.state;
  sub.state = 'dead-lettered';
  sub.updatedAt = nowIso();
  await subscriptions.put(sub);
  return { outcome: 'dead-lettered', deliveryId, attempts: max, stateChange: { from, to: 'dead-lettered', reason: 'retry-exhausted' } };
}

/** Test-only: drop all subscriptions + deliveries + dedup index + retention. */
export async function __resetTriggerBridgeStore(): Promise<void> {
  await subscriptions.__clear();
  await deliveriesCol.__clear();
  await dedupCol.__clear();
  dedupRetentionMs = 24 * 60 * 60 * 1000;
}
