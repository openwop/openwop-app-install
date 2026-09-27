/**
 * Webinar event processing (ADR 0404 §a) — the shared pipeline both ingestion
 * lanes feed: the inbound-webhook observer (real-time) and the backfill sync
 * (reconcile). A normalized WebinarEvent becomes:
 *   - a CRM contact (auto-captured, dedup by email), and
 *   - an idempotent CRM `webinar` activity (deterministic id
 *     `act:webinar:<providerEventId>:<contactId>:<phase>` — a Zoom retry or a
 *     backfill of an already-webhooked event is a safe no-op), and
 *   - a `host.webinar.<phase>` host event a journey chain can bind (Phase 2).
 *
 * Counts are NOT stored — the marketing-event dashboard derives them on read from
 * this activity stream (single source of truth, race-safe across both lanes).
 *
 * @see docs/adr/0404-event-and-creative-provider-integrations.md §a
 */

import { createLogger } from '../../observability/logger.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { getConnection } from '../connections/connectionsService.js';
import { createActivity, getActivity, makeLinkValidators } from '../crm/crmEntitiesService.js';
import { ensureContactWithOutcome } from '../crm/contactsService.js';
import { crmMutated } from '../crm/emit.js';
import { upsertMarketingEvent } from './entities/marketingEvent.js';

const log = createLogger('webinars.processor');

export type WebinarPhase = 'registered' | 'attended' | 'no-show';

export interface WebinarEvent {
  provider: string; // 'zoom'
  providerEventId: string; // the webinar id
  phase: WebinarPhase;
  participantEmail: string;
  participantName?: string;
  title?: string;
  startsAt?: string;
  occurredAt?: string; // event time (back-dates the activity)
  durationSec?: number;
}

const ACTOR = 'system:webinar';

/** ADR 0627 D2 — the webinar lanes create contacts SILENTLY (a participant sync
 *  is a bulk lane: N participants must not start N `route-new-lead` runs) and
 *  emit ONE `host.crm.contact.imported { source:'webinar', count }`. A single
 *  event (webhook, surface registration, forms sink) flushes inline; the
 *  attendance sync passes a batch and flushes once after the walk. */
export interface WebinarContactBatch { contactsCreated: number }

export function flushWebinarContactImports(tenantId: string, orgId: string, batch: WebinarContactBatch): void {
  if (batch.contactsCreated === 0) return;
  crmMutated({ entity: 'contact', verb: 'imported', tenantId, orgId, actor: ACTOR, entityId: 'import:webinar', count: batch.contactsCreated });
  batch.contactsCreated = 0;
}

/** Normalize a verified Zoom webhook body into a WebinarEvent (or null when the
 *  event type is not one we track). Zoom envelope: `{ event, payload:{ object } }`. */
/** Canonicalize an email so a registration and an attendance record for the SAME
 *  person match (case/whitespace variance between Zoom's registrant + report would
 *  otherwise split them into two contacts → a false no-show; grade-code WEB-2). */
function normEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizeZoomEvent(body: Record<string, unknown>): WebinarEvent | null {
  const event = typeof body.event === 'string' ? body.event : '';
  const payload = (body.payload ?? {}) as Record<string, unknown>;
  const object = (payload.object ?? {}) as Record<string, unknown>;
  const providerEventId = typeof object.id === 'string' ? object.id : (typeof object.id === 'number' ? String(object.id) : '');
  if (!providerEventId) return null;
  const title = typeof object.topic === 'string' ? object.topic : undefined;
  const startsAt = typeof object.start_time === 'string' ? object.start_time : undefined;

  if (event === 'webinar.registration_created' || event === 'meeting.registration_created') {
    const reg = (object.registrant ?? {}) as Record<string, unknown>;
    const email = typeof reg.email === 'string' ? normEmail(reg.email) : '';
    if (!email) return null;
    const first = typeof reg.first_name === 'string' ? reg.first_name : '';
    const last = typeof reg.last_name === 'string' ? reg.last_name : '';
    return { provider: 'zoom', providerEventId, phase: 'registered', participantEmail: email, ...(first || last ? { participantName: `${first} ${last}`.trim() } : {}), ...(title ? { title } : {}), ...(startsAt ? { startsAt } : {}) };
  }
  if (event === 'webinar.participant_joined' || event === 'meeting.participant_joined') {
    const p = (object.participant ?? {}) as Record<string, unknown>;
    const rawEmail = typeof p.email === 'string' ? p.email : (typeof p.user_email === 'string' ? p.user_email : '');
    const email = normEmail(rawEmail);
    if (!email) return null;
    return { provider: 'zoom', providerEventId, phase: 'attended', participantEmail: email, ...(typeof p.user_name === 'string' ? { participantName: p.user_name } : {}), ...(title ? { title } : {}), ...(startsAt ? { startsAt } : {}), ...(typeof p.join_time === 'string' ? { occurredAt: p.join_time } : {}) };
  }
  return null;
}

/** Resolve the org a connection's events belong to (v1 requires an org-scoped
 *  Zoom connection). Returns null (fail-soft) when unresolvable. */
async function resolveOrg(tenantId: string, connectionId: string): Promise<string | null> {
  const conn = await getConnection(tenantId, connectionId);
  return conn?.orgId ?? null;
}

/**
 * Process ONE normalized webinar event into the CRM + marketing-event + host
 * event. Idempotent by the deterministic activity id. `orgId` is resolved by the
 * caller (webhook observer) or supplied (backfill). Fail-soft — a processing
 * error is logged, never thrown into the webhook ack or the sync loop.
 */
export async function ingestWebinarEvent(tenantId: string, orgId: string, connectionId: string | undefined, ev: WebinarEvent, opts: { batch?: WebinarContactBatch } = {}): Promise<void> {
  try {
    // Upsert the aggregate (metadata only; counts are derived on read).
    await upsertMarketingEvent({
      tenantId, orgId, provider: ev.provider, providerEventId: ev.providerEventId,
      ...(ev.title ? { title: ev.title } : {}),
      ...(ev.startsAt ? { startsAt: ev.startsAt } : {}),
      ...(connectionId ? { connectionId } : {}),
    });

    // Ensure the CRM contact (dedup by email). Normalize here too so EVERY path
    // (webhook + report backfill/sync) matches the same person (grade-code WEB-2).
    const email = normEmail(ev.participantEmail);
    // ADR 0449 P1 — the shared ensure seam (was hand-rolled find-or-create).
    // ADR 0627 D2 — silent per row; `imported` is the batch event (see above).
    const { contact, created } = await ensureContactWithOutcome({ tenantId, email, name: ev.participantName || email, leadSource: 'webinar', actor: ACTOR, silent: true });
    if (!contact) return; // normEmail produced nothing — no contact, nothing to record
    if (created) {
      const batch = opts.batch ?? { contactsCreated: 0 };
      batch.contactsCreated += 1;
      if (!opts.batch) flushWebinarContactImports(tenantId, orgId, batch);
    }

    // Attendance wins: never record a no-show (nor emit host.webinar.no-show) for a
    // contact who already attended — protects the display counts AND the journey
    // lane from a false "you missed it" on a report-lag no-show.
    if (ev.phase === 'no-show' && (await getActivity(tenantId, orgId, `act:webinar:${ev.providerEventId}:${contact.contactId}:attended`))) return;

    // Idempotent, deterministic-id webinar activity (both lanes converge here).
    const activityId = `act:webinar:${ev.providerEventId}:${contact.contactId}:${ev.phase}`;
    if (await getActivity(tenantId, orgId, activityId)) return; // already recorded
    await createActivity({
      tenantId, orgId, kind: 'webinar',
      body: `${ev.phase === 'registered' ? 'Registered for' : ev.phase === 'attended' ? 'Attended' : 'No-show for'} webinar "${ev.title ?? ev.providerEventId}"`,
      contactId: contact.contactId,
      createdBy: ACTOR,
      activityId,
      ...(ev.occurredAt ? { createdAt: ev.occurredAt } : {}),
      validators: makeLinkValidators(tenantId, orgId),
    }); // ADR 0627 D2 — `activity.logged` fires inside `createActivity` (created branch only)

    // Host event for journey chains (Phase 2) — ids-only, PII-stripped by the dispatcher.
    void emitHostEvent({
      type: `host.webinar.${ev.phase === 'no-show' ? 'no-show' : ev.phase}`,
      tenantId,
      payload: { entityType: 'webinar', entityId: ev.providerEventId, orgId, contactId: contact.contactId, phase: ev.phase },
    });
  } catch (err) {
    log.warn('webinar event ingest failed', { providerEventId: ev.providerEventId, phase: ev.phase, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The inbound-webhook OBSERVER registered on the shared connections seam. Resolves
 *  the org from the connection, normalizes the Zoom body, and ingests it. */
export async function onVerifiedWebinarWebhook(event: { tenantId: string; connectionId: string; body: Record<string, unknown>; now: number }): Promise<void> {
  const ev = normalizeZoomEvent(event.body);
  if (!ev) return; // event type we don't track — safe no-op
  const orgId = await resolveOrg(event.tenantId, event.connectionId);
  if (!orgId) {
    log.warn('webinar webhook dropped — connection has no org', { connectionId: event.connectionId });
    return;
  }
  await ingestWebinarEvent(event.tenantId, orgId, event.connectionId, ev);
}
