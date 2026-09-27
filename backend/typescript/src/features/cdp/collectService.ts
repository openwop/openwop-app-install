/**
 * CDP event collection (ADR 0269 / CDP-G) — a first-party server-side ingest that
 * ENFORCES the event schema registry at the door: a payload for a registered event
 * type is validated (reject on mismatch), an unregistered type passes (no contract).
 * Accepted events are stored with per-field PII tagging (ingest-time classification).
 * The generic `cdp/collect` endpoint the collection SDKs target.
 */
import { randomUUID, createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { looksLikePiiName } from '../../host/dataClassification.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { validateEvent } from './eventSchemaService.js';

export interface CollectedEvent {
  eventId: string;
  tenantId: string;
  eventType: string;
  payload: Record<string, unknown>;
  /** ingest-time PII tagging (ADR 0269) — the payload keys detected as PII. */
  piiFields: string[];
  schemaVersion?: number;
  at: string;
}

const store = new DurableCollection<CollectedEvent>('cdp:collected-event', (e) => e.eventId, undefined, (e) => e.tenantId);

/** Shallow PII-field detection over the payload keys (the ingest tag). */
function tagPiiFields(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).filter((k) => looksLikePiiName(k));
}

/**
 * Ingest one event. Validates against the registered schema (422 on mismatch);
 * an unregistered event type is accepted (no contract ⇒ no rejection). Returns the
 * stored record's id + validation result.
 */
export async function collectEvent(tenantId: string, eventType: string, payload: unknown, dedupeKey?: string): Promise<{ eventId: string; hasSchema: boolean; schemaVersion?: number; piiFields: string[] }> {
  const et = (eventType ?? '').trim();
  if (!et) throw new OpenwopError('validation_error', 'eventType is required.', 400, {});
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new OpenwopError('validation_error', 'payload must be an object.', 400, {});
  }
  const body = payload as Record<string, unknown>;
  // GEN-2g — opt-in at-most-once ingest (mirrors forms FRMB-IDEM): a client dedupe key
  // derives a DETERMINISTIC event id scoped to (tenant, eventType), so an at-least-once
  // retry replays the SAME row. The replay short-circuits BEFORE re-validation — a
  // retry must NOT 422 if the schema tightened after the original accept — and returns
  // the STORED record's fields. Keyless stays always-append.
  const dedupId = dedupeKey
    ? `evt:ck:${createHash('sha256').update(`${tenantId}\n${et}\n${dedupeKey}`).digest('hex').slice(0, 40)}`
    : undefined;
  if (dedupId) {
    const existing = await store.get(dedupId);
    if (existing && existing.tenantId === tenantId) {
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
    at: new Date().toISOString(),
  };
  await store.put(rec);
  return { eventId: rec.eventId, hasSchema: result.hasSchema, ...(result.version !== undefined ? { schemaVersion: result.version } : {}), piiFields };
}

/** Recent collected events for a tenant (newest first) — the debugger/observability read. */
export async function listCollectedEvents(tenantId: string, limit = 100): Promise<CollectedEvent[]> {
  return (await store.listForTenantIndexed(tenantId)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
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
export async function collectEventBatch(tenantId: string, events: unknown): Promise<{ accepted: number; rejected: number; results: BatchItemResult[] }> {
  if (!Array.isArray(events)) throw new OpenwopError('validation_error', 'events must be an array.', 400, {});
  if (events.length === 0) throw new OpenwopError('validation_error', 'events must be a non-empty array.', 400, {});
  if (events.length > MAX_COLLECT_BATCH) {
    throw new OpenwopError('validation_error', `at most ${MAX_COLLECT_BATCH} events per batch.`, 400, { max: MAX_COLLECT_BATCH, got: events.length });
  }
  const results: BatchItemResult[] = [];
  let accepted = 0;
  let rejected = 0;
  for (let i = 0; i < events.length; i++) {
    const e = (events[i] ?? {}) as { eventType?: unknown; payload?: unknown };
    try {
      const r = await collectEvent(tenantId, typeof e.eventType === 'string' ? e.eventType : '', e.payload);
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
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    return purgeRowsByAge('cdp:collected-event', await store.listForTenantIndexed(tenantId), tenantId, cutoffIso,
      (e) => ({ tenantId: e.tenantId, updatedAt: e.at, id: e.eventId }),
      (id) => store.delete(id));
  },
});
