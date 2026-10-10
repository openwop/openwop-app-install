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
 * instances and survive restarts. A dead-lettered delivery is recorded as its
 * `triggerbridge:delivery` row(s) AND, since ADR 0805, as one RFC 0232 record
 * in `triggerbridge:deadletter` (the sink `listTriggerDeadLetters` reads).
 * CORRECTED 2026-10-03: this said a
 * production host routes it to "the RFC 0053 dead-letter sink" — nothing does;
 * that sink is the executor's, for RUN failures, and a dead-lettered delivery
 * has no run (RFC 0232 §D corrects trigger-bridge.md §B the same way).
 *
 * @see spec/v1/trigger-bridge.md section B/section C  -  RFCS/0083-durable-trigger-and-channel-bridge-profile.md
 * @see schemas/trigger-subscription.schema.json
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';
import { onWorkflowForked } from './workflowsRegistry.js';
import { casRepoint } from './forkRepoint.js';
import { registerKvAgeOut } from './kvAgeOut.js';

export type SubscriptionSource = 'webhook' | 'schedule' | 'queue' | 'email' | 'form' | 'stream' | 'change';
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
  /** ADR 0599 §6 — the feature that OWNS this subscription, resolved against the
   *  feature-toggle service at INGEST time (`triggerIngestionService`). Absent ⇒
   *  ungated, which is every pre-existing subscription. The scheduler twin of
   *  this field is `ScheduledJob.featureId`, and the rationale is the same: a
   *  toggle-status listener gates the CREATION lane, not the USE lane, so a
   *  per-tenant disable left the webhook accepting events for a tenant the
   *  feature was explicitly off for. */
  featureId?: string;
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

/**
 * RFC 0232 / ADR 0805 — the trigger-delivery dead-letter sink. A dead-lettered
 * delivery starts no run, so it is on no run's log; this collection is where
 * the host RECORDS it (`trigger-bridge.md` §C: run-less transitions are
 * recorded, not emitted), and `listTriggerDeadLetters` is where it is visible.
 *
 * Content-free BY CONSTRUCTION: every field is an id, an opaque dedup key, a
 * counter, an enum or an instant. Nothing here can hold the inbound body,
 * headers, signature or secret, because no caller passes them in.
 *
 * Keyed `<subscriptionId>:<inverted epoch ms>:<deliveryId>` so one
 * subscription's records are a bounded prefix scan, newest first — the
 * `listDeliveries` full scan is exactly what a public read must not be.
 */
export type TriggerDeadLetterReason = 'verification_failed' | 'retries_exhausted';

export interface TriggerDeadLetter {
  /** The row key (sort order). Never on the wire. */
  k: string;
  tenantId: string;
  subscriptionId: string;
  deliveryId: string;
  attemptEventId: string;
  attempt: { subscriptionId: string; dedupKey: string; attempt: number; outcome: 'dead-lettered' };
  stateChange?: { subscriptionId: string; source: SubscriptionSource; fromState: SubscriptionState; toState: SubscriptionState; reason: 'retry-exhausted' };
  reason: TriggerDeadLetterReason;
  deadLetteredAt: string;
  expiresAt: string;
}

/** The `triggerBridge.deadLetter` facet values (RFC 0232 §A). */
export const TRIGGER_DEAD_LETTER_RETENTION_DAYS = 7;
export const TRIGGER_DEAD_LETTER_MAX_PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Inverting the instant makes ascending key order newest-first. */
const INVERT_FROM = 9_999_999_999_999;

const deadLettersCol = new DurableCollection<TriggerDeadLetter>('triggerbridge:deadletter', (r) => r.k);
registerKvAgeOut({
  id: 'triggerbridge:deadletter',
  prefix: 'hostext:triggerbridge:deadletter:',
  ttlDays: TRIGGER_DEAD_LETTER_RETENTION_DAYS,
  timestampField: 'deadLetteredAt',
});

async function putDeadLetter(input: {
  sub: TriggerSubscription;
  deliveryId: string;
  dedupKey: string;
  attempt: number;
  reason: TriggerDeadLetterReason;
  stateChange?: TriggerDeadLetter['stateChange'];
}): Promise<void> {
  const at = nowMs();
  const inverted = String(INVERT_FROM - at).padStart(13, '0');
  await deadLettersCol.put({
    k: `${input.sub.subscriptionId}:${inverted}:${input.deliveryId}`,
    tenantId: input.sub.tenantId,
    subscriptionId: input.sub.subscriptionId,
    deliveryId: input.deliveryId,
    attemptEventId: randomUUID(),
    attempt: { subscriptionId: input.sub.subscriptionId, dedupKey: input.dedupKey, attempt: input.attempt, outcome: 'dead-lettered' },
    ...(input.stateChange ? { stateChange: input.stateChange } : {}),
    reason: input.reason,
    deadLetteredAt: new Date(at).toISOString(),
    expiresAt: new Date(at + TRIGGER_DEAD_LETTER_RETENTION_DAYS * DAY_MS).toISOString(),
  });
}

/**
 * RFC 0232 §B — one page of a subscription's dead letters, newest first.
 * `after` is the last row key of the previous page (the route wraps it in an
 * opaque, subscription-bound cursor). Expired rows are withheld even before
 * the age-out sweep reaches them, so `retentionDays` is exact on the read.
 */
export async function listDeadLetters(
  subscriptionId: string,
  opts: { limit: number; after?: string },
): Promise<{ records: TriggerDeadLetter[]; nextAfter?: string }> {
  const now = nowIso();
  const rows = (await deadLettersCol.listByPrefix(`${subscriptionId}:`))
    .filter((r) => r.subscriptionId === subscriptionId && r.expiresAt > now)
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const start = opts.after === undefined ? rows : rows.filter((r) => r.k > opts.after!);
  const records = start.slice(0, opts.limit);
  const nextAfter = start.length > records.length ? records[records.length - 1]?.k : undefined;
  return { records, ...(nextAfter ? { nextAfter } : {}) };
}

/**
 * RFC 0232 §C.2 — where a test seam ALSO appends the dead-lettered
 * `trigger.delivery.attempted` event, the record names that event's id, so the
 * read and the seam agree. Returns false if no record exists for the delivery.
 */
export async function bindDeadLetterAttemptEvent(subscriptionId: string, deliveryId: string, eventId: string): Promise<boolean> {
  const row = (await deadLettersCol.listByPrefix(`${subscriptionId}:`)).find((r) => r.deliveryId === deliveryId);
  if (!row) return false;
  await deadLettersCol.put({ ...row, attemptEventId: eventId });
  return true;
}

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
/**
 * ADR 0722 — the demo auto-ingest subscription id, deterministic per tenant and
 * inside the opaque grammar `^[A-Za-z0-9._~-]{16,128}$`. A tenant id is hashed
 * rather than embedded: it may carry `:` (`anon:<sid>`) and is not itself bound
 * by the opaque grammar.
 */
export function demoAutoIngestSubscriptionId(tenantId: string): string {
  return `demo-agent-knowledge-auto-ingest-${createHash('sha256').update(tenantId).digest('hex').slice(0, 32)}`;
}

/** The pre-ADR-0721 spelling, kept ONLY so migration 21 can find the rows it re-keys. */
export const LEGACY_DEMO_AUTO_INGEST_PREFIX = 'demo:agent-knowledge:auto-ingest:';

/**
 * Migration 21 — move a subscription to a new id, keeping every field. Idempotent:
 * a missing source is a no-op, an existing target wins (concurrent boots converge).
 */
/**
 * ADR 0726 — a HOST-DERIVED subscription id inside the corpus opaque grammar
 * (`^[A-Za-z0-9._~-]{16,128}$`, `identity.md` §5). Two host-ext features
 * derived theirs with colons (`host:kanban:<boardId>`,
 * `host:connections:<connectionId>`), so `trigger.delivery.attempted.subscriptionId`
 * could never bind on the major-2 wire (measured: every kanban/connection
 * delivery). The derivation is deterministic in the same inputs; a row minted
 * under the old spelling is moved on first use (`rekeySubscription`, the
 * migration-21 pattern) so nothing needs a boot-time scan.
 */
export function hostDerivedSubscriptionId(family: 'kanban' | 'connections', key: string): { id: string; legacyId: string } {
  return { id: `host-${family}-${key.replace(/[^A-Za-z0-9._~-]/g, '-')}`, legacyId: `host:${family}:${key}` };
}
/** Register under the grammar-safe id, moving a legacy-spelled row first if one exists. */
export async function registerHostDerivedSubscription(family: 'kanban' | 'connections', key: string, input: Omit<Parameters<typeof registerSubscription>[0], 'subscriptionId'>): Promise<string> {
  const { id, legacyId } = hostDerivedSubscriptionId(family, key);
  await rekeySubscription(legacyId, id);
  await registerSubscription({ ...input, subscriptionId: id });
  return id;
}

export async function rekeySubscription(oldId: string, newId: string): Promise<'moved' | 'absent' | 'target-exists'> {
  const existing = await subscriptions.get(oldId);
  if (!existing) return 'absent';
  if (await subscriptions.get(newId)) { await subscriptions.delete(oldId); return 'target-exists'; }
  await subscriptions.put({ ...existing, subscriptionId: newId, updatedAt: nowIso() });
  await subscriptions.delete(oldId);
  return 'moved';
}

export async function listLegacyDemoAutoIngestIds(): Promise<string[]> {
  return (await subscriptions.listByPrefix(LEGACY_DEMO_AUTO_INGEST_PREFIX)).map((s) => s.subscriptionId);
}

export async function registerSubscription(input: {
  subscriptionId: string;
  tenantId: string;
  source: SubscriptionSource;
  dedupEnabled?: boolean;
  retryPolicy?: Partial<RetryPolicy>;
  label?: string;
  workflowId?: string;
  featureId?: string;
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
    ...(input.featureId ? { featureId: input.featureId } : {}),
    ...(input.verificationMode ? { verificationMode: input.verificationMode } : {}),
    ...(input.secretFingerprint ? { secretFingerprint: input.secretFingerprint } : {}),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await subscriptions.put(sub);
  return sub;
}

/**
 * Delete a subscription and everything this module keeps for it: its delivery
 * attempt rows and its RFC 0232 dead-letter records. The dedup rows are
 * opaque hashes that age out on their own 24 h window, so they are left to it.
 * The sealed inbound signing secret lives in `triggerIngestionService` (which
 * imports this module), so the caller deletes that one.
 *
 * Returns null when no such subscription exists. Callers check the tenant
 * BEFORE calling: this is the storage operation, not the authorisation.
 */
export async function deleteSubscription(subscriptionId: string): Promise<{ deliveries: number; deadLetters: number } | null> {
  if (!(await subscriptions.get(subscriptionId))) return null;
  let deadLetters = 0;
  for (const r of await deadLettersCol.listByPrefix(`${subscriptionId}:`)) {
    if (r.subscriptionId === subscriptionId && (await deadLettersCol.delete(r.k))) deadLetters += 1;
  }
  // `triggerbridge:delivery` is keyed by delivery id, so this is a full scan.
  // Deletion is a rare operator action; the read paths never pay for it.
  let deliveries = 0;
  for (const d of await deliveriesCol.list()) {
    if (d.subscriptionId === subscriptionId && (await deliveriesCol.delete(`${d.deliveryId}:${d.attempt}`))) deliveries += 1;
  }
  await subscriptions.delete(subscriptionId);
  return { deliveries, deadLetters };
}

export async function getSubscription(subscriptionId: string): Promise<TriggerSubscription | null> {
  return subscriptions.get(subscriptionId);
}

export async function listSubscriptions(tenantId: string): Promise<TriggerSubscription[]> {
  return (await subscriptions.list())
    .filter((s) => s.tenantId === tenantId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** ADR 0395 — the operator webhook-health panel's cross-tenant read. Reaches
 *  the caller ONLY through the superadmin-gated operations route. */
export async function listAllSubscriptions(): Promise<TriggerSubscription[]> {
  return (await subscriptions.list()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
  // section C-2 exhaustion -> section B dead-letter, recorded in the subscription's
  // own sink (RFC 0232 / ADR 0805) -- never the RFC 0053 run sink: no run exists.
  const from = sub.state;
  sub.state = 'dead-lettered';
  sub.updatedAt = nowIso();
  await subscriptions.put(sub);
  await putDeadLetter({
    sub,
    deliveryId,
    dedupKey: input.dedupKey,
    attempt: max,
    reason: 'retries_exhausted',
    stateChange: { subscriptionId: sub.subscriptionId, source: sub.source, fromState: from, toState: 'dead-lettered', reason: 'retry-exhausted' },
  });
  return { outcome: 'dead-lettered', deliveryId, attempts: max, stateChange: { from, to: 'dead-lettered', reason: 'retry-exhausted' } };
}

/** Test-only: drop all subscriptions + deliveries + dedup index + retention. */
/**
 * ADR 0793 / RFC 0230 §C.1 — record a REFUSED inbound post (bad signature,
 * timestamp skew) as a dead-lettered delivery attempt. It deliberately does NOT
 * touch the subscription's state: the ingest route takes no OpenWOP credential,
 * so letting a refused post move the subscription out of `active` would let
 * anyone who learns the URL disable a working integration.
 */
export async function recordRefusedDelivery(subscriptionId: string, dedupKey: string): Promise<void> {
  const deliveryId = `dlv-refused-${randomUUID()}`;
  await deliveriesCol.put({
    deliveryId,
    subscriptionId,
    dedupKey,
    attempt: 1,
    outcome: 'dead-lettered',
    at: nowIso(),
  });
  // RFC 0232 §C.3 — a refused post IS a dead-lettered delivery, and carries no
  // `stateChange`: refusing it changed nothing (RFC 0230 §C.1).
  const sub = await subscriptions.get(subscriptionId);
  if (sub) await putDeadLetter({ sub, deliveryId, dedupKey, attempt: 1, reason: 'verification_failed' });
}

export async function __resetTriggerBridgeStore(): Promise<void> {
  await subscriptions.__clear();
  await deliveriesCol.__clear();
  await dedupCol.__clear();
  await deadLettersCol.__clear();
  dedupRetentionMs = 24 * 60 * 60 * 1000;
}

// ADR 0789 — an event source this tenant bound to a SHARED workflow starts the
// tenant's fork of it once the tenant has edited it.
onWorkflowForked('trigger-bridge:subscription', async (tenantId, from, to) => {
  let n = 0;
  for (const row of await listSubscriptions(tenantId)) {
    if (row.workflowId !== from) continue;
    if (await casRepoint(subscriptions, row.subscriptionId, (r) => (r.workflowId === from && r.tenantId === tenantId ? { ...r, workflowId: to } : null))) n += 1;
  }
  return n;
});
