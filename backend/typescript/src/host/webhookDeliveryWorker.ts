/**
 * Durable webhook-delivery worker.
 *
 * Replaces the old `setImmediate` fire-and-forget delivery path (which dropped
 * deliveries on a process crash and never retried a transient failure). The
 * webhook routes now ENQUEUE a `WebhookDeliveryRecord` per matching subscriber
 * (`storage.enqueueWebhookDelivery`); this worker drains the queue:
 *
 *   1. `storage.claimDueWebhookDeliveries` atomically leases a batch of due
 *      rows (multi-instance-safe — Postgres `FOR UPDATE SKIP LOCKED`, sqlite a
 *      write transaction). A crashed worker's lease expires, so another
 *      instance re-claims the row — deliveries survive a crash.
 *   2. Each claimed row is POSTed with the HMAC-SHA256 signature recipe from
 *      `spec/v1/webhooks.md`.
 *   3. Success → `markWebhookDeliveryDelivered`. Failure (network error, or a
 *      non-2xx response) → `rescheduleWebhookDelivery` with exponential backoff
 *      until `maxAttempts`, after which the row is `dead` (dead-letter).
 *
 * `processDueWebhookDeliveries` is exported so tests can drain the queue
 * deterministically (pass a fixed `now`); `startWebhookDeliveryWorker` wraps it
 * in a polling loop for the running server.
 */

import { signStandardWebhooks, signWebhookV1 } from './webhookSignature.js';
import { isStandardWebhooksOptIn } from './webhookStandardWebhooks.js';
import { runUnderWorkerContract } from '../storage/eventEraAdapter.js';
import { fetch as undiciFetch } from 'undici';
import { openWebhookSecret } from './webhookSecretCodec.js';
import type { Storage } from '../storage/storage.js';
import type { WebhookDeliveryRecord, WebhookSubscriptionRecord } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { recordWebhookFirstAttemptDelay } from '../observability/metricSeams.js';
import { assertEgressSchemeAllowed, EgressUrlRejectedError, webhookEgressDispatcher } from './webhookEgressGuard.js';
import { sweepExpiredApprovalGates } from '../executor/approvalGateTimeout.js';
import { sweepExpiredEmailSent } from './emailSentLedger.js';
import { sweepExpiredEgressSent } from './egressSentLedger.js';
import { sweepExpiredCanvasIdem } from './canvasSurface.js';
import { APP_VERSION } from '../version.js';

const log = createLogger('webhookDeliveryWorker');

/** Per-delivery attempt budget before a row is dead-lettered. */
export const WEBHOOK_MAX_ATTEMPTS = 5;
/** Rows claimed per poll.
 *
 *  CORRECTED (WHD-1): this used to say the batch was sequential and that
 *  `CLAIM_BATCH × DELIVERY_TIMEOUT_MS` had to stay under `CLAIM_LEASE_MS`.
 *  That was the defect, not a safeguard — a slow row delayed every unrelated
 *  row behind it.
 *
 *  CORRECTED AGAIN (WHD-34): this then said CLAIM_BATCH was *also* the
 *  concurrency bound, "kept small so a burst cannot exhaust sockets or the DB
 *  pool". That reasoning covered outbound HTTP and silently ignored the
 *  CONNECTION POOL. See `deliveryConcurrency()`. */
const CLAIM_BATCH = 5;

/**
 * How many post-attempt DB WRITES may run at once — deliberately NOT the HTTP bound.
 *
 * CORRECTED (RFC 0215 §A, ADR 0752): this used to bound the whole attempt, HTTP
 * included, so it was ALSO the delivery concurrency — 3 in production (pool 4).
 * Eight subscribers that accept and never answer then held every slot, and a
 * healthy ninth waited out their timeouts: a §A.2 violation. The HTTP attempt
 * holds no connection, so it is now bounded by `webhookMaxInFlight()` and only
 * the write that follows it passes through this gate. The WHD-34 guarantee below
 * is unchanged: the worker still leaves at least one connection for everything
 * else.
 *
 * WHD-34. `sendDelivery` is HTTP-only; each row's DB write
 * (`markWebhookDeliveryDelivered` / `rescheduleWebhookDelivery`) runs AFTER it.
 * Because the HTTP calls race, their completions cluster, so an unbounded
 * `Promise.all(due.map(...))` can put `CLAIM_BATCH` writes against the pool at
 * the same instant. Production runs `OPENWOP_PG_POOL_MAX=4` with `CLAIM_BATCH=5`
 * — one `pg.Pool` per process, SHARED with HTTP request handling — so the worker
 * could take every slot and stall in-flight runs waiting to acquire one. That is
 * the failure mode `storage/postgres/index.ts` warns about in its header.
 *
 * The pre-WHD-1 sequential loop held at most ONE connection at a time. Nothing
 * stated that, which is exactly why making the batch concurrent removed it
 * without anyone noticing.
 *
 * Derived from the SAME env var the pool reads, so the two cannot drift: leave
 * at least one connection for everything that is not this worker.
 */
export function deliveryConcurrency(
  poolMaxRaw: string | undefined = process.env.OPENWOP_PG_POOL_MAX,
  batch: number = CLAIM_BATCH,
): number {
  const poolMax = Math.max(1, Number(poolMaxRaw ?? 10) || 10);
  return Math.max(1, Math.min(batch, poolMax - 1));
}

/**
 * A subscriber URL, safe to log (WHD-36).
 *
 * The delivery-failure line logged `rec.url` verbatim. A subscriber URL is
 * operator-supplied and routinely carries a credential in the query string
 * (`?token=`, `?key=`, a signed callback), so the log was a plausible path for
 * a customer secret into log storage — where it outlives the subscription and
 * is readable by anyone with log access.
 *
 * Origin + path are kept, because that is what makes the line diagnosable; the
 * query and fragment are dropped wholesale rather than key-filtered, since an
 * allowlist has to be right about every parameter name any subscriber ever
 * chooses. An unparseable URL degrades to a constant, never to the raw string.
 */
export function redactUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}${u.search ? '?<redacted>' : ''}`;
  } catch {
    return '<unparseable-url>';
  }
}

/**
 * RFC 0215 §A.2 floor: the host MUST keep starting attempts to other
 * subscriptions while at least 8 have attempts their receivers have not
 * answered. Lanes are one attempt per subscription, so 8 held + 1 healthy
 * needs 9 slots; a configured value below that is raised, never honoured.
 */
export const WEBHOOK_MIN_IN_FLIGHT = 9;
const DEFAULT_MAX_IN_FLIGHT = 32;

/** Outbound attempts in flight at once on this instance (one per subscription).
 *  `OPENWOP_WEBHOOK_MAX_IN_FLIGHT` tunes it; floored at `WEBHOOK_MIN_IN_FLIGHT`. */
export function webhookMaxInFlight(raw: string | undefined = process.env.OPENWOP_WEBHOOK_MAX_IN_FLIGHT): number {
  const n = Math.floor(Number(raw ?? DEFAULT_MAX_IN_FLIGHT));
  return Math.max(WEBHOOK_MIN_IN_FLIGHT, Number.isFinite(n) ? n : DEFAULT_MAX_IN_FLIGHT);
}

/**
 * RFC 0215 §A.3 (ADR 0752 P2): how many of this instance's in-flight attempts ONE
 * tenant may hold, so its unanswered receivers cannot take the capacity another
 * tenant needs. Default: half the capacity (16 of 32).
 *
 * Floored at `WEBHOOK_MIN_IN_FLIGHT` — and that floor is load-bearing, not
 * cosmetic: §A.2 is a MUST inside ONE tenant too (the conformance scenario holds 8
 * of one tenant's subscriptions and needs its ninth to start), so a per-tenant cap
 * below 9 would trade the MUST for the SHOULD. Capped at `capacity`.
 * `OPENWOP_WEBHOOK_MAX_IN_FLIGHT_PER_TENANT` tunes it.
 */
export function webhookMaxInFlightPerTenant(
  capacity: number,
  raw: string | undefined = process.env.OPENWOP_WEBHOOK_MAX_IN_FLIGHT_PER_TENANT,
): number {
  const n = raw === undefined ? Math.floor(capacity / 2) : Math.floor(Number(raw));
  const wanted = Number.isFinite(n) ? n : Math.floor(capacity / 2);
  return Math.min(capacity, Math.max(WEBHOOK_MIN_IN_FLIGHT, wanted));
}

/** A counting semaphore: `run` waits for a free slot, holds it for `fn`. */
function createGate(slots: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let free = slots;
  const waiters: Array<() => void> = [];
  return async (fn) => {
    if (free > 0) free -= 1;
    else await new Promise<void>((resolve) => waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiters.shift();
      if (next) next();       // hand the slot straight over
      else free += 1;
    }
  };
}

/** Claim lease duration (ms). A claimed row whose lease expires is re-claimable.
 *  MUST exceed the worst-case batch processing time with margin so an
 *  in-progress batch is never re-claimed.
 *
 *  Since WHD-1 that worst case is ONE `DELIVERY_TIMEOUT_MS` (10s), not
 *  `CLAIM_BATCH × DELIVERY_TIMEOUT_MS` (50s), because the rows run
 *  concurrently. The lease is deliberately left at 120s: the margin is now
 *  large rather than tight, and shrinking it would trade real safety for a
 *  number nothing needs. */
const CLAIM_LEASE_MS = 120_000;
/** Poll cadence for the running worker. */
const POLL_INTERVAL_MS = 1_000;
/** Per-delivery HTTP timeout. */
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Exponential backoff for attempt `attempts` (1-based: the delay applied AFTER
 * the Nth failure). 2s, 4s, 8s, 16s, … capped at 5 min. The caller adds this to
 * `now` to get `nextAttemptAt`.
 */
export function webhookBackoffMs(attempts: number): number {
  const base = 2_000 * 2 ** Math.max(0, attempts - 1);
  return Math.min(base, 300_000);
}

/** Sign + POST one delivery. Returns true on a 2xx response. The signature
 *  timestamp is computed at SEND time (not the batch-claim time) so a slow batch
 *  doesn't ship later items with a stale `t=` — receivers verify it against the
 *  spec's ±5min freshness window (webhooks.md §"Signature recipe").
 *
 *  RFC 0093 §A.1-A.2 delivery-time egress hardening:
 *   - `dispatcher: webhookEgressDispatcher()` re-validates every resolved
 *     address against the registration-time denied ranges inside the
 *     connection's own `lookup` (pinned resolution — no TOCTOU window). A
 *     denied resolution surfaces as a fetch error → delivery failure →
 *     existing retry policy.
 *   - `redirect: 'error'` — webhook delivery MUST NOT follow redirects; a
 *     `3xx` is a fetch error here, i.e. a delivery failure, retried per the
 *     existing backoff policy. */
/**
 * The signing headers for one attempt, from the SUBSCRIPTION's secrets as they
 * stand at send time (ADR 0747).
 *
 * WHY NOT THE DELIVERY ROW'S SECRET. The row copies the secret at enqueue. With
 * RFC 0201 §E rotation that copy is wrong in both directions: a row enqueued
 * before a rotation and retried after the overlap would still sign with a
 * secret §E.20 says "MUST NOT sign anything", and a row enqueued during the
 * overlap could not know it should dual-sign. For a subscription that never
 * opted in nothing changes — it cannot rotate, so its subscription secret IS
 * the row's copy, byte for byte.
 */
export async function signingHeaders(
  sub: WebhookSubscriptionRecord,
  deliveryId: string,
  timestamp: string,
  rawBody: string,
  now: number = Date.now(),
): Promise<{ openwopSignature: string; standardWebhooks?: Record<string, string> }> {
  // Stored sealed when KMS is configured; opened only here, at signing time.
  const current = await openWebhookSecret(sub.secret);
  if (!isStandardWebhooksOptIn(sub)) {
    return { openwopSignature: signWebhookV1(current, timestamp, rawBody) };
  }
  // §E.20 — inside the overlap the previous secret still signs; at
  // `previousSecretExpiresAt` it stops, even though the row still holds it.
  const { previousSecret, previousSecretExpiresAt } = sub;
  const previous = previousSecret !== undefined && previousSecretExpiresAt !== undefined && now < previousSecretExpiresAt
    ? await openWebhookSecret(previousSecret)
    : null;
  // §C.10 — `webhook-id` is the delivery row's id: minted once at enqueue,
  // persisted, so every attempt (including one after a restart) carries it, and
  // distinct per (subscription, event). §C.9 — `webhook-timestamp` IS the
  // `OpenWOP-Timestamp` value, the same variable.
  const entries = [signStandardWebhooks(current, deliveryId, timestamp, rawBody)];
  if (previous !== null) entries.push(signStandardWebhooks(previous, deliveryId, timestamp, rawBody));
  return {
    // §E.20 — `OpenWOP-Signature` is single-valued, so during the overlap it
    // stays on the PREVIOUS secret (a v1-scheme verifier has not rolled yet)
    // and moves to the new one when the overlap ends.
    openwopSignature: signWebhookV1(previous ?? current, timestamp, rawBody),
    standardWebhooks: {
      'webhook-id': deliveryId,
      'webhook-timestamp': timestamp,
      'webhook-signature': entries.join(' '),
    },
  };
}

async function sendDelivery(rec: WebhookDeliveryRecord, sub: WebhookSubscriptionRecord): Promise<{ ok: boolean; detail: string }> {
  // ADR 0606/0607 — re-check the SCHEME at delivery time, the same way the
  // dispatcher re-checks the resolved ADDRESS. Registration refuses a non-https
  // url, but rows registered before that arm existed are still in the queue, and
  // this is the layer that decides what actually leaves the process. Fails
  // closed: a plaintext delivery becomes a delivery failure and rides the
  // existing backoff to dead-letter rather than shipping the payload and its
  // signature in the clear. Scheme arms ONLY — the address is validated at
  // connect time by the pinned-resolution lookup, which is stronger; see
  // `assertEgressSchemeAllowed`.
  try {
    assertEgressSchemeAllowed(rec.url, { honorDevFlag: true });
  } catch (e) {
    if (!(e instanceof EgressUrlRejectedError)) throw e;
    return { ok: false, detail: `${e.reason}: webhook url must use https: (got "${e.protocol ?? 'invalid-url'}")` };
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  // ONE implementation of each scheme, shared with the RFC 0176 §D.2 receiver
  // seam (`host/webhookSignature.ts`). A verifier written separately from the
  // signer drifts invisibly — both sides keep agreeing with themselves.
  //
  // ADR 0755 (WIT-WH-2) — opening a sealed secret (a KMS outage, a
  // `previous_secret` sealed under a retired key) or signing (a stored secret
  // that is not `whsec_`) can throw. Uncaught, that escaped the attempt: the row
  // kept its lease, was re-claimed every `CLAIM_LEASE_MS` with `attempts` never
  // incremented, and so never backed off and never dead-lettered — a poison row
  // retried forever. It is an ordinary failed attempt instead. Only the error's
  // CLASS reaches the persisted detail; the message stays in the log.
  let signed: Awaited<ReturnType<typeof signingHeaders>>;
  try {
    signed = await signingHeaders(sub, rec.deliveryId, timestamp, rec.payload);
  } catch (err) {
    const cls = err instanceof Error && /^[A-Za-z]{1,64}$/.test(err.name) ? err.name : 'Error';
    log.warn('webhook_signing_failed', {
      subscriptionId: rec.subscriptionId,
      errorClass: cls,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, detail: `signing_failed:${cls}` };
  }
  const signature = signed.openwopSignature;
  try {
    const res = await undiciFetch(rec.url, {
      method: 'POST',
      // Dual emission, RFC 0165 §C.1 (ADR 0625). The signed bytes are the
      // spec's `v1` scheme (HMAC-SHA256 over `${timestamp}.${rawBody}`) in BOTH
      // families, with IDENTICAL values: `X-openwop-*` is the v1.x canonical set
      // (now `deprecated`, removeIn 2.0 in spec/v1/deprecations.json) and
      // `OpenWOP-*` is the family the v2 cut keeps. A subscriber may read either
      // and MUST verify the same bytes. This closes ADR 0538 Phase 2: the
      // pre-spec combined `openwop-signature: t=…,v1=…` encoding and the
      // `openwop-subscription-id` name are gone — the `OpenWOP-*` names now carry
      // the spec's values, and no consumer of the old encoding remains (the
      // openwop-sdks helpers were fixed in TS 1.9.0 / Py 1.7.0 / Go v1.6.0).
      headers: {
        'content-type': 'application/json',
        'user-agent': `openwop-webhook-dispatcher/${APP_VERSION}`,
        // v1.x canonical — webhooks.md §"Headers":
        'x-openwop-webhook-id': rec.wireSubscriptionId ?? rec.subscriptionId,
        'x-openwop-event-type': rec.eventType,
        'x-openwop-timestamp': timestamp,
        'x-openwop-signature': `sha256=${signature}`,
        'x-openwop-signature-algorithm': 'v1',
        // RFC 0165 §C.1 — same values, the family v2 keeps:
        'openwop-webhook-id': rec.wireSubscriptionId ?? rec.subscriptionId,
        'openwop-event-type': rec.eventType,
        'openwop-timestamp': timestamp,
        'openwop-signature': `sha256=${signature}`,
        'openwop-signature-algorithm': 'v1',
        // RFC 0201 §C.9 — ONLY for a subscription that opted in (§B.8), and
        // beside the headers above, never instead of them. Standard Webhooks'
        // own names, not mapped into `OpenWOP-*` (§F).
        ...(signed.standardWebhooks ?? {}),
      },
      body: rec.payload,
      redirect: 'error',
      dispatcher: webhookEgressDispatcher(),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, detail: `${res.status}` };
    // Body is irrelevant to the queue; cancel so the connection can be reused.
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return { ok: false, detail: err instanceof Error ? `${err.message}${cause}` : String(err) };
  }
}

/**
 * Claim and process one batch of due deliveries. Returns the number of rows
 * processed (0 when the queue is idle). Exported for deterministic tests —
 * pass a fixed `now`; the running worker passes `Date.now()`.
 */
export async function processDueWebhookDeliveries(
  storage: Storage,
  workerId: string,
  now: number = Date.now(),
): Promise<number> {
  const due = await storage.claimDueWebhookDeliveries(workerId, now, CLAIM_LEASE_MS, CLAIM_BATCH);
  // WHD-1 — the batch is processed CONCURRENTLY, not one row after another.
  //
  // This loop used to `await sendDelivery(rec)` per row, so a batch cost up to
  // `CLAIM_BATCH x DELIVERY_TIMEOUT_MS` (5 x 10s = 50s) and every row waited
  // behind the slowest one before it. The cost did not land on the failing
  // subscription -- it landed on whatever unrelated subscriptions shared the
  // batch. MEASURED on deployed `3080f2f24a0f` with a handful of dead
  // endpoints queued: a healthy subscriber's FIRST attempt arrived ~5.5 min
  // after its event, and successive attempts were 9.0 / 5.3 / 7.6 minutes
  // apart against a configured backoff of 2s / 4s / 8s. Those gaps are not
  // backoff: the row was due seconds later and simply was not claimed.
  //
  // Concurrency is safe here and is not a relaxation of anything:
  //   - rows are leased INDIVIDUALLY by `claimDueWebhookDeliveries`, so two
  //     rows in one batch share no state and no lock;
  //   - `webhooks.md` specifies at-least-once delivery with subscriber-side
  //     dedup on `(OpenWOP-Webhook-Id, runId, sequence)` and states no ordering
  //     guarantee -- that dedup requirement exists precisely because order is
  //     not promised, so nothing observable depends on the old sequencing;
  //   - the fan-out is bounded by `CLAIM_BATCH` (5), so this adds at most four
  //     concurrent outbound requests, not an unbounded burst.
  //
  // It also makes the lease comment above TRUE rather than aspirational: worst
  // case batch time falls from `CLAIM_BATCH x timeout` to one `timeout`, which
  // is comfortably inside `CLAIM_LEASE_MS` instead of uncomfortably near it.
  const gate = createGate(deliveryConcurrency());
  await Promise.all(due.map((rec) => attemptDelivery(storage, rec, () => now, gate)));
  return due.length;
}

/**
 * One attempt for one claimed row: POST, then record the outcome through the
 * DB-write gate. `clock` is the claim-time `now` in the deterministic test lane
 * and `Date.now` in the running dispatcher, where an attempt can outlive its
 * claim by the full `DELIVERY_TIMEOUT_MS` and the backoff must start from when
 * the attempt actually ended.
 */
async function attemptDelivery(
  storage: Storage,
  rec: WebhookDeliveryRecord,
  clock: () => number,
  writeGate: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const startedAt = clock();
  // ADR 0747 — the secrets are read from the subscription at send time (see
  // `signingHeaders`), through the SAME DB gate as the outcome write: the
  // dispatcher runs up to MAX_IN_FLIGHT attempts at once, and an ungated read
  // per attempt would put that many queries against a `pool − 1` budget. A
  // missing subscription was unregistered — RFC 0215 §B keeps new rows from
  // being enqueued for it, so this is an in-flight claim or an operator's retry
  // of a dead row. Its owner withdrew the URL: nothing is sent, and no attempt
  // exists for the WHOPS-2 first-attempt metric below to time.
  const sub = await writeGate(() => storage.getWebhook(rec.subscriptionId));
  if (sub === null) {
    await writeGate(() => storage.rescheduleWebhookDelivery(rec.deliveryId, clock(), clock(), true, 'subscription_deleted'));
    return;
  }
  const result = await sendDelivery(rec, sub);
  // WHOPS-2 — the FIRST attempt only (`attempts === 0` on the claimed row), so
  // this measures queue delay rather than backoff. WHD-1 is exactly this
  // number going wrong: ~5.5 min against a configured 2s first backoff, while
  // every delivery eventually succeeded, so no failure counter could see it.
  if (rec.attempts === 0) {
    recordWebhookFirstAttemptDelay(startedAt - rec.createdAt, result.ok ? 'delivered' : 'failed');
  }
  if (result.ok) {
    await writeGate(() => storage.markWebhookDeliveryDelivered(rec.deliveryId, clock()));
    // Every outcome is logged, success included (2026-09-25). Only failures
    // used to be, so a delivery that 500'd twice and then succeeded left two
    // `failed` lines and silence — indistinguishable from a worker that stopped
    // retrying, which is exactly what it was misread as during an evidence cut.
    // `info`, not `warn`: this fires on every delivery.
    log.info('webhook delivery succeeded', {
      subscriptionId: rec.subscriptionId,
      url: redactUrlForLog(rec.url),
      attempt: rec.attempts + 1,
      maxAttempts: rec.maxAttempts,
    });
    return;
  }
  const attempts = rec.attempts + 1;
  const dead = attempts >= rec.maxAttempts;
  const finishedAt = clock();
  const nextAttemptAt = finishedAt + webhookBackoffMs(attempts);
  // RFC 0215 §B — if the subscription was unregistered while this attempt was
  // in flight, its row is gone and this UPDATE matches nothing: no retry starts.
  await writeGate(() => storage.rescheduleWebhookDelivery(rec.deliveryId, finishedAt, nextAttemptAt, dead, result.detail));
  log.warn('webhook delivery failed', {
    subscriptionId: rec.subscriptionId,
    url: redactUrlForLog(rec.url),
    attempt: attempts,
    maxAttempts: rec.maxAttempts,
    dead,
    detail: result.detail,
  });
}

/**
 * RFC 0215 §A (ADR 0752) — the running worker's dispatcher: per-subscription LANES
 * that share only a capacity bound, Svix-style.
 *
 * WHY IT IS NOT `processDueWebhookDeliveries` IN A LOOP. That function awaits its
 * whole batch, and the tick awaited it, so the next claim could not start until
 * the slowest row in the previous batch answered or timed out. WHD-1 (#4052) made
 * the rows WITHIN a batch concurrent, but the barrier between batches remained,
 * and in production the batch ran 3 wide (pool 4). Eight receivers that accept and
 * never answer therefore held every slot, and a healthy ninth subscription waited
 * out their timeouts: exactly the §A.1 "start of an attempt waits for an attempt
 * to a DIFFERENT subscription" the RFC forbids.
 *
 * Here nothing waits for anything unrelated:
 *   - a claim takes up to the FREE capacity, launches each attempt, and returns;
 *     the attempt is never awaited by the claim or by the tick;
 *   - each subscription has at most ONE attempt in flight on this instance
 *     (`onePerSubscription` + `excludeSubscriptionIds`), so a subscription's
 *     backlog or its hung receiver occupies one slot, never the pool (§A.1, and
 *     the per-subscription half of the §A.3 SHOULD);
 *   - capacity is `webhookMaxInFlight()`, floored at 9 (§A.2: 8 held + 1);
 *   - an attempt finishing re-pumps immediately, so a busy healthy subscription
 *     is not rate-limited to one attempt per poll interval by its own lane.
 * The DB write after each attempt still goes through the WHD-34 pool gate.
 */
export interface WebhookDispatcher {
  /** Claim and launch as many due rows as there is free capacity for. Never
   *  waits for an attempt. Concurrent calls coalesce into one follow-up claim. */
  pump(): Promise<void>;
  /** Attempts currently in flight (test/observability seam). */
  inFlight(): number;
  /** Resolves once every attempt launched so far has settled (test seam). */
  settled(): Promise<void>;
  /** Stop claiming. Attempts already in flight run to completion. */
  stop(): void;
}

export function createWebhookDispatcher(
  storage: Storage,
  workerId: string,
  opts: { maxInFlight?: number; maxInFlightPerTenant?: number; clock?: () => number } = {},
): WebhookDispatcher {
  const capacity = Math.max(WEBHOOK_MIN_IN_FLIGHT, opts.maxInFlight ?? webhookMaxInFlight());
  const perTenant = opts.maxInFlightPerTenant !== undefined
    ? Math.min(capacity, Math.max(WEBHOOK_MIN_IN_FLIGHT, opts.maxInFlightPerTenant))
    : webhookMaxInFlightPerTenant(capacity);
  const clock = opts.clock ?? Date.now;
  const writeGate = createGate(deliveryConcurrency(undefined, capacity));
  /** deliveryId → the subscription (and tenant) it holds a lane for. */
  const lanes = new Map<string, { subscriptionId: string; tenantId: string | null; done: Promise<void> }>();
  let claiming = false;
  let again = false;
  let stopped = false;

  const launch = (rec: WebhookDeliveryRecord): void => {
    const done = attemptDelivery(storage, rec, clock, writeGate)
      .catch((err: unknown) => {
        // The row keeps its lease and is re-claimed when it expires
        // (at-least-once); nothing here may take the dispatcher down.
        log.warn('webhook delivery attempt error', {
          subscriptionId: rec.subscriptionId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        lanes.delete(rec.deliveryId);
        void pump();
      });
    lanes.set(rec.deliveryId, { subscriptionId: rec.subscriptionId, tenantId: rec.tenantId ?? null, done });
  };

  async function pump(): Promise<void> {
    if (claiming) {
      again = true;
      return;
    }
    claiming = true;
    try {
      do {
        again = false;
        const free = capacity - lanes.size;
        if (stopped || free <= 0) break;
        const busy = [...new Set([...lanes.values()].map((l) => l.subscriptionId))];
        // §A.3 — per-tenant in-flight counts. Tenants at the cap are excluded
        // from the claim, and the claim is sized to the SMALLEST room any
        // other in-flight tenant has left, so one claim cannot overshoot a cap
        // (rows are leased on claim; there is no giving one back). A tenant with
        // nothing in flight has the full `perTenant` room, which is ≥ 9, so the
        // limit never starves the §A.2 floor. Full claims loop, so a small limit
        // costs round trips, not throughput.
        const perTenantCount = new Map<string, number>();
        for (const l of lanes.values()) {
          if (l.tenantId !== null) perTenantCount.set(l.tenantId, (perTenantCount.get(l.tenantId) ?? 0) + 1);
        }
        const atCap = [...perTenantCount].filter(([, n]) => n >= perTenant).map(([t]) => t);
        const minRoom = Math.min(perTenant, ...[...perTenantCount.values()].filter((n) => n < perTenant).map((n) => perTenant - n));
        const limit = Math.min(free, minRoom);
        const claimed = await storage.claimDueWebhookDeliveries(workerId, clock(), CLAIM_LEASE_MS, limit, {
          onePerSubscription: true,
          excludeSubscriptionIds: busy,
          excludeTenantIds: atCap,
        });
        for (const rec of claimed) launch(rec);
        // A full claim may have left due rows behind; go round again. A short one
        // means the queue is drained for now — the next tick or completion re-pumps.
        if (claimed.length === limit) again = true;
      } while (again);
    } catch (err) {
      log.warn('webhook delivery claim error', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      claiming = false;
    }
  }

  return {
    pump,
    inFlight: () => lanes.size,
    settled: async () => {
      while (lanes.size > 0) await Promise.all([...lanes.values()].map((l) => l.done));
    },
    stop: () => {
      stopped = true;
    },
  };
}

export interface WebhookDeliveryWorker {
  stop(): void;
}

/**
 * Start the polling delivery worker for the running server. Each tick pumps the
 * lane dispatcher (which returns without waiting for any attempt) and then runs
 * the piggybacked sweeps; the `running` guard now only keeps SWEEPS from
 * overlapping — delivery no longer rides it. Returns a handle whose `stop()`
 * clears the timer and stops claiming (call on graceful shutdown).
 */
export function startWebhookDeliveryWorker(storage: Storage, workerId: string): WebhookDeliveryWorker {
  const dispatcher = createWebhookDispatcher(storage, workerId);
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await dispatcher.pump();
      // RFC 0093 §D — piggyback the approval-gate timeout sweep on this
      // worker's cadence so a timed-out gate auto-rejects (fail closed)
      // even when no caller ever touches its interrupt again. The lazy
      // checks in routes/interrupts.ts cover the with-traffic case; this
      // covers the quiescent one.
      await sweepExpiredApprovalGates(storage);
      // ADR 0193/0201 — retention sweep for the email:sent idempotency ledger,
      // on the same quiescent-safe cadence. Bounded + fail-contained internally.
      await sweepExpiredEmailSent();
      // ADR 0619 — retention sweep for the egress:sent (SMS/push) idempotency ledger,
      // same quiescent-safe cadence. Bounded + fail-contained internally.
      await sweepExpiredEgressSent();
      // DATA-D7 — retention sweep for the canvas create/write idempotency rows
      // (the un-cascadable ephemeral ct:/c:/w: ones; from-artifact is exempt).
      // Same cadence; bounded + fail-contained internally.
      await sweepExpiredCanvasIdem();
    } catch (err) {
      log.warn('webhook delivery worker tick error', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void runUnderWorkerContract(tick), POLL_INTERVAL_MS);
  // Don't keep the process alive solely for this timer.
  if (typeof timer.unref === 'function') timer.unref();
  log.info('webhook delivery worker started', { workerId, pollIntervalMs: POLL_INTERVAL_MS, maxInFlight: webhookMaxInFlight() });
  return {
    stop: () => {
      clearInterval(timer);
      dispatcher.stop();
    },
  };
}
