/**
 * CDP event collection (ADR 0269 / CDP-G) — a first-party server-side ingest that
 * ENFORCES the event schema registry at the door: a payload for a registered event
 * type is validated (reject on mismatch), an unregistered type passes (no contract).
 * Accepted events are stored with per-field PII tagging (ingest-time classification).
 * The generic `cdp/collect` endpoint the collection SDKs target.
 */
import { randomUUID, createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { looksLikePiiName } from '../../host/dataClassification.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { validateEvent } from './eventSchemaService.js';
import { isPermittedForPurpose, isErasureTombstoned, type Purpose } from '../consent/consentService.js';
import { COLLECTED_IDENTITY_KEYS } from './collectedEventIdentity.js';
import { recordGovernanceDecision } from '../../host/governanceDecisionLog.js';
import { collectedEvents as store, isLiveCollectedEvent, persistCollectedEvent, replayCollectedEvent, deleteCollectedEvent } from './visitorEventIndex.js';

export interface CollectedEvent {
  eventId: string;
  tenantId: string;
  eventType: string;
  payload: Record<string, unknown>;
  /** ingest-time PII tagging (ADR 0269) — the payload keys detected as PII. */
  piiFields: string[];
  schemaVersion?: number;
  /** ADR 1024 D4.3 — what this event was collected FOR (RFC 0128 vocabulary). Absent on
   *  events stored before ADR 1024 and on first-party events, which carry their own gate. */
  purpose?: CollectionPurpose;
  at: string;
}

/** ADR 1024 D4.2 — who is calling. `http` is the generic ingest (SDKs, the routes);
 *  `first-party` is an in-process owner that already applied its own consent gate
 *  (funnels, kicktodo). The DEFAULT is `http`, so a caller that forgets says the
 *  stricter thing. */
export type CollectSource = 'http' | 'first-party';

/** ADR 1024 D4.3 — the purposes an event may be collected for. `transactional` is not
 *  one: it maps to the `necessary` category, which the consent module allows before it
 *  checks the erasure tombstone, so accepting it would let any caller skip both. */
export const COLLECTION_PURPOSES = ['analytics', 'personalization', 'advertising', 'marketing-email', 'marketing-sms', 'marketing-push'] as const;
export type CollectionPurpose = (typeof COLLECTION_PURPOSES)[number];

/** ADR 1024 D4.2 (`CDP2WF-2`) — event families written only in-process by their owning
 *  feature. Over HTTP, any member could post `funnel.step_completed` with an experiment
 *  arm and fabricate conversions that experiment promotion and lead scoring read as
 *  first-party truth. `forms.` has no in-process writer yet and is reserved for one. */
export const RESERVED_EVENT_PREFIXES = ['funnel.', 'kicktodo.', 'forms.'] as const;

export interface CollectOptions {
  source?: CollectSource;
  /** `http` only; default `analytics`. */
  purpose?: unknown;
}

/** ADR 1024 D4.3 — the consent decision for an HTTP event (user decision Q1, 2026-11-02,
 *  N1 resolved). Every identifier the payload names — a person key (`contactId`,
 *  `userId`, `subjectKey`) OR a persistent visitor/session id (`visitor`, `sessionKey`,
 *  `anonymousId`, `distinctId`, …) — needs consent for the purpose, decided by
 *  `isPermittedForPurpose` with the tenant's consent-policy default: an opt-in regime
 *  needs a recorded consent, an opt-out regime allows unless the subject opted out, and
 *  the consent toggle off allows everything (the consent module's own precedence; an
 *  erasure tombstone always refuses). No region is guessed. An event that names no
 *  identifier passes. Basis: ePrivacy Art. 5(3) per EDPB Guidelines 2/2023 (identifiers
 *  and tracking techniques are "information" on the device); CNIL sheet 16 (the narrow
 *  analytics exemption, which an operator who meets it expresses as an opt-out default);
 *  CCPA §1798.140 (a persistent device identifier is personal information). */
async function assertConsentedCollection(tenantId: string, payload: Record<string, unknown>, purpose: CollectionPurpose): Promise<void> {
  for (const key of COLLECTED_IDENTITY_KEYS) {
    const value = payload[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    // An ERASED subject is the barrier's answer (409 subject_erased), not a missing consent:
    // a 403 would tell the caller to go and get consent for a person who asked to be
    // forgotten (closing grade L2).
    if (await isErasureTombstoned(tenantId, value)) {
      throw new OpenwopError('subject_erased', 'Collected event identity was erased.', 409);
    }
    if (!(await isPermittedForPurpose(tenantId, value, purpose as Purpose, { quietDenial: true }))) {
      recordCollectDenial(tenantId, purpose);
      throw new OpenwopError('forbidden', `No consent basis for ${purpose} for the identifier in \`${key}\`; the event was not stored.`, 403, { reason: 'consent_required', purpose, field: key });
    }
  }
}

/** ADR 1024 (`CDP2WF-30`) — consent denials on the collect path, rolled up. The consent
 *  module writes one durable governance row per denial into the shared `audit_log` (no
 *  tenant column, no purger), so a busy anonymous SDK in an opt-in tenant would have
 *  written a row per page view. Here the FIRST denial per (tenant, purpose) in a window
 *  writes its row; later ones in that window are counted, and the next denial after the
 *  window closes writes ONE `collect-denials-suppressed` row carrying the count. Per
 *  instance and in memory: a restart loses at most one window's count, never a first row. */
export const DENIAL_WINDOW_MS = 60_000;
const denialWindows = new Map<string, { start: number; suppressed: number }>();
function recordCollectDenial(tenantId: string, purpose: CollectionPurpose, now = Date.now()): void {
  const key = `${tenantId}\u0000${purpose}`;
  const w = denialWindows.get(key);
  if (w && now - w.start < DENIAL_WINDOW_MS) { w.suppressed++; return; }
  if (w && w.suppressed > 0) {
    void recordGovernanceDecision({ tenantId, kind: 'consent', outcome: 'deny', reason: 'collect-denials-suppressed', resource: 'cdp.collected-event', detail: { purpose, suppressed: w.suppressed, windowMs: DENIAL_WINDOW_MS } });
  }
  denialWindows.set(key, { start: now, suppressed: 0 });
  if (denialWindows.size > 10_000) denialWindows.delete(denialWindows.keys().next().value as string);
  void recordGovernanceDecision({ tenantId, kind: 'consent', outcome: 'deny', reason: 'collect-consent-required', resource: 'cdp.collected-event', detail: { purpose } });
}
/** Test-only. */
export function __resetCollectDenialWindows(): void { denialWindows.clear(); }

function collectionPurposeOf(raw: unknown): CollectionPurpose {
  if (raw === undefined || raw === null || raw === '') return 'analytics';
  if (typeof raw === 'string' && (COLLECTION_PURPOSES as readonly string[]).includes(raw)) return raw as CollectionPurpose;
  throw new OpenwopError('validation_error', `purpose must be one of: ${COLLECTION_PURPOSES.join(', ')}.`, 400, { field: 'purpose' });
}

const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_SHAPED = /^\+[1-9]\d{6,14}$/;

/** Shallow PII-field detection over the payload (the ingest tag): a key whose NAME reads
 *  as PII, or (ADR 1024 D4.6, `CDP2WF-21`) whose string VALUE is an email address or an
 *  E.164 number. Before, an erased email posted under `to` or `recipient` was tagged
 *  nothing, so the erasure barrier (which reads these tags) re-admitted it. The tag feeds
 *  the barrier, erasure matching and read masking; it is NOT an identity for the consent
 *  check, which reads the named identity keys only (a `supportEmail` field is not the
 *  subject of the event). */
function tagPiiFields(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).filter((k) => {
    if (looksLikePiiName(k)) return true;
    const v = payload[k];
    return typeof v === 'string' && (EMAIL_SHAPED.test(v.trim()) || E164_SHAPED.test(v.trim()));
  });
}

/**
 * Ingest one event. Validates against the registered schema (422 on mismatch);
 * an unregistered event type is accepted (no contract ⇒ no rejection). Returns the
 * stored record's id + validation result.
 */
export async function collectEvent(tenantId: string, eventType: string, payload: unknown, dedupeKey?: string, opts: CollectOptions = {}): Promise<{ eventId: string; hasSchema: boolean; schemaVersion?: number; piiFields: string[]; purpose?: CollectionPurpose }> {
  const et = (eventType ?? '').trim();
  if (!et) throw new OpenwopError('validation_error', 'eventType is required.', 400, {});
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new OpenwopError('validation_error', 'payload must be an object.', 400, {});
  }
  const body = payload as Record<string, unknown>;
  const source: CollectSource = opts.source ?? 'http';
  let purpose: CollectionPurpose | undefined;
  if (source === 'http') {
    // Checked AFTER the trim, so a leading space cannot slip a reserved type through.
    if (RESERVED_EVENT_PREFIXES.some((p) => et.startsWith(p))) {
      throw new OpenwopError('validation_error', `Event types starting ${RESERVED_EVENT_PREFIXES.join(', ')} are written only by their own feature, not over this endpoint.`, 422, { reason: 'reserved_event_type', eventType: et });
    }
    purpose = collectionPurposeOf(opts.purpose);
    await assertConsentedCollection(tenantId, body, purpose);
  }
  // GEN-2g — opt-in at-most-once ingest (mirrors forms FRMB-IDEM): a client dedupe key
  // derives a DETERMINISTIC event id scoped to (tenant, eventType), so an at-least-once
  // retry replays the SAME row. The replay short-circuits BEFORE re-validation — a
  // retry must NOT 422 if the schema tightened after the original accept — and returns
  // the STORED record's fields. Keyless stays always-append.
  const dedupId = dedupeKey
    ? `evt:ck:${createHash('sha256').update(`${tenantId}\n${et}\n${dedupeKey}`).digest('hex').slice(0, 40)}`
    : undefined;
  if (dedupId) {
    const existing = await replayCollectedEvent(tenantId, dedupId, et, body);
    if (existing) {
      return { eventId: existing.eventId, hasSchema: existing.schemaVersion !== undefined, ...(existing.schemaVersion !== undefined ? { schemaVersion: existing.schemaVersion } : {}), piiFields: existing.piiFields };
    }
  }
  const result = await validateEvent(tenantId, et, body);
  if (result.hasSchema && !result.valid) {
    throw new OpenwopError('validation_error', `event failed its registered schema (v${result.version}).`, 422, { errors: result.errors });
  }
  const piiFields = tagPiiFields(body);
  const rec: CollectedEvent = {
    eventId: dedupId ?? `evt:${randomUUID()}`,
    tenantId,
    eventType: et,
    payload: body,
    piiFields,
    ...(result.version !== undefined ? { schemaVersion: result.version } : {}),
    ...(purpose ? { purpose } : {}),
    at: new Date().toISOString(),
  };
  const stored = await persistCollectedEvent(rec);
  return { eventId: stored.eventId, hasSchema: stored.schemaVersion !== undefined, ...(stored.schemaVersion !== undefined ? { schemaVersion: stored.schemaVersion } : {}), piiFields: stored.piiFields, ...(stored.purpose ? { purpose: stored.purpose } : {}) };
}

/** Recent collected events for a tenant (newest first) — the debugger/observability read. */
export async function listCollectedEvents(tenantId: string, limit = 100): Promise<CollectedEvent[]> {
  return (await store.listForTenantIndexed(tenantId)).filter(isLiveCollectedEvent).filter((row) => row.tenantId === tenantId).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** Hard cap on a single batch — a batch endpoint fans out N writes per request, so an
 *  unbounded batch would blow the DB connection budget / per-IP rate limit (architect
 *  HIGH). Oversize is rejected outright (never silently truncated). */
export const MAX_COLLECT_BATCH = 100;

export interface BatchItemResult {
  index: number;
  ok: boolean;
  eventId?: string;
  hasSchema?: boolean;
  schemaVersion?: number;
  piiFields?: string[];
  error?: { code: string; message: string };
}

/**
 * Batch ingest (ADR 0269 §"Batch import" — the buildable-now collection follow-on).
 * Composes the SAME per-event `collectEvent` path (schema-enforced + PII-tagged) — no
 * second ingest mechanism. Best-effort per row: one row's schema rejection does NOT
 * sink the batch; each row reports ok+eventId or its error, so the caller sees exactly
 * what landed. Processed SEQUENTIALLY (bounded work per request) and capped.
 */
export async function collectEventBatch(tenantId: string, events: unknown, opts: { source?: CollectSource } = {}): Promise<{ accepted: number; rejected: number; results: BatchItemResult[] }> {
  if (!Array.isArray(events)) throw new OpenwopError('validation_error', 'events must be an array.', 400, {});
  if (events.length === 0) throw new OpenwopError('validation_error', 'events must be a non-empty array.', 400, {});
  if (events.length > MAX_COLLECT_BATCH) {
    throw new OpenwopError('validation_error', `at most ${MAX_COLLECT_BATCH} events per batch.`, 400, { max: MAX_COLLECT_BATCH, got: events.length });
  }
  const results: BatchItemResult[] = [];
  let accepted = 0;
  let rejected = 0;
  for (let i = 0; i < events.length; i++) {
    const e = (events[i] ?? {}) as { eventType?: unknown; payload?: unknown; purpose?: unknown };
    try {
      const r = await collectEvent(tenantId, typeof e.eventType === 'string' ? e.eventType : '', e.payload, undefined, { source: opts.source ?? 'http', purpose: e.purpose });
      results.push({ index: i, ok: true, eventId: r.eventId, hasSchema: r.hasSchema, ...(r.schemaVersion !== undefined ? { schemaVersion: r.schemaVersion } : {}), piiFields: r.piiFields });
      accepted++;
    } catch (err) {
      const oe = err instanceof OpenwopError ? err : null;
      results.push({ index: i, ok: false, error: { code: oe?.code ?? 'error', message: oe instanceof Error ? oe.message : 'ingest failed' } });
      rejected++;
    }
  }
  return { accepted, rejected, results };
}

// ADR 0077 / architect HIGH — collected events are ingested raw data that can carry
// PII; without a purger the store grows unbounded (parity with analytics' event
// retention). The time-based retention sweep (env-gated daemon) purges a tenant's
// events past the window; age on `at`. No-op on falsy tenant / non-PII classification.
registerRetentionPurger({
  feature: 'cdp',
  dryRun: 'rows-by-age',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    return purgeRowsByAge('cdp:collected-event', (await store.listForTenantIndexed(tenantId)).filter(isLiveCollectedEvent), tenantId, cutoffIso,
      (e) => ({ tenantId: e.tenantId, updatedAt: e.at, id: e.eventId }),
      async (id) => {
        // Commit the coverage barrier before an event can disappear. An
        // ambiguous delete acknowledgement must never leave a complete rollup.
        // This callback is not called by the retention dry-run lane.
        await advanceRetentionWatermark(tenantId, cutoffIso);
        return deleteCollectedEvent(tenantId, id);
      });
  },
});

/** ADR 0949 P1b — per tenant, the newest cutoff admitted for event deletion.
 *  It can conservatively report partial coverage after a failed delete, but
 *  never complete coverage after a committed one. Subject erasure does not
 *  advance it: that removes one person's events, not a time range. */
const watermarks = new DurableCollection<{ tenantId: string; purgedBefore: string }>(
  'cdp:retention-watermark', (w) => w.tenantId, undefined, (w) => w.tenantId,
);

async function advanceRetentionWatermark(tenantId: string, cutoffIso: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await watermarks.get(tenantId);
    if (cur && cur.purgedBefore >= cutoffIso) return;
    if (await watermarks.compareAndSwap(cur, { tenantId, purgedBefore: cutoffIso })) return;
  }
  throw new OpenwopError('conflict', 'Retention coverage could not be recorded; the event was retained.', 409, { reason: 'retention_watermark_conflict' });
}

/** Events collected before this instant may have been purged (null: none were). */
export async function collectedEventsRetainedSince(tenantId: string): Promise<string | null> {
  return (await watermarks.get(tenantId))?.purgedBefore ?? null;
}
