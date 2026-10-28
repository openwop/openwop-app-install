/**
 * ADR 0973 D1–D2, D6, D8 — the durable, tenant-scoped host-event log behind
 * RFC 0250 replay (`GET /host/events?replay=required`).
 *
 * `host/hostEventStream.ts` keeps durable events in a per-process ring, so an
 * instance started after an event cannot replay it. This log is the one store
 * replay reads. Three kinds of row, all under the tenant's key prefix:
 *
 *   `${tenant}::h`              the head: the tenant's last sequence (CAS)
 *   `${tenant}::s::${seq:016}`  the event, in commit order
 *   `${tenant}::i::${eventId}`  the cursor index
 *
 * Only durable events are written, so an ephemeral id never resolves. The
 * sequence is host-private and never reaches the wire (RFC 0250: ids stay
 * opaque). Every row carries `tenantId`, which tenant teardown and the age-out
 * lane's legal-hold check both read. There is deliberately no tenant resolver:
 * the keys are already tenant-prefixed, and a resolver would pre-write an index
 * marker on every write of an emit (ADR 0973, architect finding 3).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DurableCollection, keyableTenant as validTenant, registerTenantPurgeHook } from './hostExtPersistence.js';
import { scanPrefix } from './durable/durableStore.js';
import { registerKvAgeOut } from './kvAgeOut.js';
import { locateRepoSchemasDir } from './_repoPath.js';
import { createLogger } from '../observability/logger.js';
import type { HostEventEnvelope } from './hostEventTypes.js';

const log = createLogger('host.hostEventLog');

/** The advertised floor (`hostEvents.replay.minRetentionSeconds`): 24 hours. */
export const HOST_EVENT_REPLAY_MIN_RETENTION_SECONDS = 86_400;
/** Rows outlive the advertised floor with margin (D6). */
const TTL_DAYS = 2;
/** Bounded head CAS (D2). */
const MAX_APPEND_ATTEMPTS = 8;
/** RFC 0236 §A event-id grammar; anything else cannot be a cursor. */
const EVENT_ID = /^[A-Za-z0-9._~-]{16,128}$/;

const NAME = 'host-event-log';
const PREFIX = `hostext:${NAME}:`;

interface HeadRow { k: string; kind: 'h'; tenantId: string; seq: number; committedAt: string }
interface EventRow { k: string; kind: 's'; tenantId: string; seq: number; committedAt: string; event: HostEventEnvelope }
interface IndexRow { k: string; kind: 'i'; tenantId: string; seq: number; committedAt: string; eventId: string }
/** ADR 0988 D2 — a durable event that could not be logged and could not be
 *  published with its body (over NOTIFY's limit, on a multi-instance host). It is
 *  kept here instead of reaching one instance only. `committedAt` is the failure
 *  time, so the row ages out with the log and is purged with the tenant. */
interface DeadLetterRow { k: string; kind: 'd'; tenantId: string; seq: 0; committedAt: string; event: HostEventEnvelope; reason: string }
type LogRow = HeadRow | EventRow | IndexRow | DeadLetterRow;

const rows = new DurableCollection<LogRow>(NAME, (r) => r.k);

const pad = (seq: number): string => String(seq).padStart(16, '0');
const headKey = (tenant: string): string => `${tenant}::h`;
const eventKey = (tenant: string, seq: number): string => `${tenant}::s::${pad(seq)}`;
const indexKey = (tenant: string, eventId: string): string => `${tenant}::i::${eventId}`;
const deadLetterKey = (tenant: string, eventId: string): string => `${tenant}::d::${eventId}`;

registerKvAgeOut({ id: NAME, prefix: PREFIX, ttlDays: TTL_DAYS, timestampField: 'committedAt' });

// Teardown by key prefix, ahead of the generic content scan (which also reaches
// these rows through their `tenantId`, so a failure here leaves nothing behind).
registerTenantPurgeHook(NAME, async (tenantId) => {
  if (!validTenant(tenantId)) return 0;
  let deleted = 0;
  for (const r of await rows.listByPrefix(`${tenantId}::`)) {
    if (r.tenantId === tenantId && await rows.delete(r.k)) deleted += 1;
  }
  return deleted;
});

// ── D8: dormant until the vendored schemas carry RFC 0250 ─────────────────────

let cachedWire: boolean | undefined;

/** True iff the vendored v2 capabilities schema defines `hostEvents.replay`. */
export function rfc0250WireAvailable(): boolean {
  if (cachedWire !== undefined) return cachedWire;
  try {
    const dir = join(locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json'), 'v2');
    const schema = JSON.parse(readFileSync(join(dir, 'capabilities.schema.json'), 'utf8')) as {
      properties?: { hostEvents?: { properties?: Record<string, unknown> } };
    };
    cachedWire = schema.properties?.hostEvents?.properties?.['replay'] !== undefined;
  } catch {
    cachedWire = false;
  }
  return cachedWire;
}

/** Test seam: re-read the vendored schemas (or force a value). */
export function resetRfc0250WireCache(force?: boolean): void {
  cachedWire = force;
}

// ── D2: append in commit order ───────────────────────────────────────────────

/**
 * Append one DURABLE event and return its sequence, or null when it was not
 * logged (ephemeral, a tenant id the key grammar cannot hold, or the head CAS
 * lost every attempt). The caller publishes either way: a failed append must
 * not fail the emitting write.
 *
 * A fresh head starts at the current epoch millisecond, not 1, so a head that
 * aged out with its tenant idle never re-issues a sequence an index row still
 * names.
 */
export async function appendHostEvent(tenantId: string, event: HostEventEnvelope): Promise<number | null> {
  if (event.delivery !== 'durable' || !validTenant(tenantId)) return null;
  if (failAppends > 0) {
    failAppends -= 1;
    throw new Error('host event log append failed (test fault)');
  }
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const head = await rows.get(headKey(tenantId)) as HeadRow | null;
    const committedAt = new Date().toISOString();
    const seq = head ? head.seq + 1 : Date.now();
    const next: HeadRow = { k: headKey(tenantId), kind: 'h', tenantId, seq, committedAt };
    if (!(await rows.compareAndSwap(head, next))) continue;
    // The event row before the index row: a cursor resolves only once its event exists.
    await rows.put({ k: eventKey(tenantId, seq), kind: 's', tenantId, seq, committedAt, event });
    await rows.put({ k: indexKey(tenantId, event.eventId), kind: 'i', tenantId, seq, committedAt, eventId: event.eventId });
    return seq;
  }
  log.warn('host_event_log_append_failed', { type: event.type, reason: 'head_contention', attempts: MAX_APPEND_ATTEMPTS });
  return null;
}

/** Test affordance (ADR 0988 D2 witness) — the next `n` appends throw, as a
 *  storage failure would. Never set outside tests. */
let failAppends = 0;
export function _failHostEventAppendsForTesting(n: number): void {
  failAppends = Math.max(0, Math.floor(n));
}

/** Can `event` be logged for `tenantId` at all? False for an ephemeral event or a
 *  tenant id the key grammar cannot hold: retrying those cannot succeed. */
export function hostEventAppendable(tenantId: string, event: HostEventEnvelope): boolean {
  return event.delivery === 'durable' && validTenant(tenantId);
}

/** ADR 0988 D2 — the bounded retry after the first append: 3 more attempts with
 *  jittered backoff, about one second in total. */
const APPEND_RETRY_DELAYS_MS = [100, 250, 500];

/**
 * Append with ADR 0988 D2's bounded retry. Returns the sequence, or null when the
 * event is not appendable or every attempt failed (each failure is logged). Never
 * throws: the emitting write must not fail because of the stream.
 */
export async function appendHostEventWithRetry(tenantId: string, event: HostEventEnvelope, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<number | null> {
  if (!hostEventAppendable(tenantId, event)) return null;
  for (let attempt = 0; attempt <= APPEND_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const base = APPEND_RETRY_DELAYS_MS[attempt - 1]!;
      await sleep(base / 2 + Math.floor(Math.random() * base));
    }
    try {
      const seq = await appendHostEvent(tenantId, event);
      if (seq !== null) return seq;
    } catch (err) {
      log.warn('host_event_log_append_failed', { type: event.type, attempt, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return null;
}

/**
 * ADR 0988 D2 — keep a durable event that could neither be logged nor published
 * with its body. Returns whether the row was written; a failure here is logged and
 * the event is lost, which the counter records.
 */
export async function deadLetterHostEvent(tenantId: string, event: HostEventEnvelope, reason: string): Promise<boolean> {
  if (!validTenant(tenantId)) return false;
  try {
    await rows.put({ k: deadLetterKey(tenantId, event.eventId), kind: 'd', tenantId, seq: 0, committedAt: new Date().toISOString(), event, reason });
    return true;
  } catch (err) {
    log.error('host_event_dead_letter_failed', { type: event.type, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Operator view (superadmin): dead-lettered host events by type, no bodies and
 *  no tenant ids. Scans the log collection, capped at `maxRows`, and says whether
 *  the cap was hit. */
export async function hostEventDeadLetterSummary(maxRows = 20_000): Promise<{ total: number; byType: Array<{ type: string; count: number }>; oldest: string | null; newest: string | null; scanned: number; truncated: boolean }> {
  const byType = new Map<string, number>();
  let total = 0;
  let scanned = 0;
  let oldest: string | null = null;
  let newest: string | null = null;
  for await (const { value } of scanPrefix(PREFIX, { op: 'host-event-dead-letter-summary' })) {
    scanned += 1;
    if (scanned > maxRows) return { total, byType: [...byType].map(([type, count]) => ({ type, count })), oldest, newest, scanned: maxRows, truncated: true };
    let row: Partial<DeadLetterRow>;
    try { row = JSON.parse(value) as Partial<DeadLetterRow>; } catch { continue; }
    if (row.kind !== 'd' || !row.event || typeof row.committedAt !== 'string') continue;
    total += 1;
    byType.set(row.event.type, (byType.get(row.event.type) ?? 0) + 1);
    if (oldest === null || row.committedAt < oldest) oldest = row.committedAt;
    if (newest === null || row.committedAt > newest) newest = row.committedAt;
  }
  return { total, byType: [...byType].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count), oldest, newest, scanned, truncated: false };
}

// ── D4/D5: resolve a cursor, read the backlog ────────────────────────────────

/**
 * The sequence a `Last-Event-ID` names in `tenantId`'s log, or null when it
 * cannot be resumed: not an event id, not in this tenant's log (unknown,
 * foreign or ephemeral), or older than the advertised floor. One null for every
 * cause, so the caller has one refusal and no oracle (D5).
 */
export async function resolveHostEventCursor(tenantId: string, eventId: string, nowMs: number = Date.now()): Promise<number | null> {
  if (!validTenant(tenantId) || !EVENT_ID.test(eventId)) return null;
  const row = await rows.get(indexKey(tenantId, eventId));
  if (row === null || row.kind !== 'i' || row.tenantId !== tenantId) return null;
  const age = nowMs - Date.parse(row.committedAt);
  if (!Number.isFinite(age) || age >= HOST_EVENT_REPLAY_MIN_RETENTION_SECONDS * 1000) return null;
  return row.seq;
}

/** The tenant's logged events strictly after `seq`, in commit order. Holes (a
 *  head advanced whose row was never written, or an aged-out row) are skipped. */
export async function* hostEventsAfter(tenantId: string, seq: number): AsyncGenerator<HostEventEnvelope> {
  const prefix = `${PREFIX}${tenantId}::s::`;
  for await (const { value } of scanPrefix(prefix, { after: `${prefix}${pad(seq)}`, op: 'host-event-replay' })) {
    let row: unknown;
    try { row = JSON.parse(value); } catch { continue; }
    const r = row as Partial<EventRow>;
    if (r.kind === 's' && r.tenantId === tenantId && r.event) yield r.event;
  }
}

/** One logged event by sequence: how an instance delivers an event whose
 *  NOTIFY was too large to carry it (D3). */
export async function loggedHostEvent(tenantId: string, seq: number): Promise<HostEventEnvelope | null> {
  if (!validTenant(tenantId)) return null;
  const row = await rows.get(eventKey(tenantId, seq));
  return row !== null && row.kind === 's' && row.tenantId === tenantId ? row.event : null;
}
