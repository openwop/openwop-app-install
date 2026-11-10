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
import { upsertMarketingEvent, getMarketingEventByProviderId } from './entities/marketingEvent.js';
import { OpenwopError } from '../../types.js';
import { tenantMayUseFeature } from '../../host/tenantFeatureGate.js';

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

/** ADR 1054 D3 — what one ingest did (it used to return `void` and swallow everything, so
 *  no caller could report a refusal or an unrecorded registration).
 *  - `recorded`  — the activity was written now;
 *  - `duplicate` — the same activity already existed (a retry or a second lane);
 *  - `suppressed`— a no-show for someone who attended (attendance wins);
 *  - `other_org` — the provider id is tracked by another client (D1); nothing written;
 *  - `untracked` — `requireTracked` and this client tracks no such event (D4); nothing written;
 *  - `failed`    — nothing recorded: no usable email, an ERASED person (never re-captured),
 *                  or a storage/CRM error (logged). */
export type IngestOutcome = 'recorded' | 'duplicate' | 'suppressed' | 'other_org' | 'untracked' | 'failed';

/**
 * Process ONE normalized webinar event into the CRM + marketing-event + host
 * event. Idempotent by the deterministic activity id. `orgId` is resolved by the
 * caller (webhook observer) or supplied (backfill). Fail-soft — a processing
 * error is logged and returned as `failed`, never thrown into the webhook ack or
 * the sync loop.
 *
 * ADR 1054 — the event's client is checked FIRST, before a contact is created: a
 * provider id another client tracks records nothing (`other_org`). With
 * `requireTracked` (the webhook lane, D4) an id this client has not tracked records
 * nothing either (`untracked`).
 */
export async function ingestWebinarEvent(tenantId: string, orgId: string, connectionId: string | undefined, ev: WebinarEvent, opts: { batch?: WebinarContactBatch; requireTracked?: boolean } = {}): Promise<IngestOutcome> {
  try {
    const tracked = await getMarketingEventByProviderId(tenantId, ev.provider, ev.providerEventId);
    if (tracked && tracked.orgId !== orgId) {
      log.warn('webinar_event_other_org', { providerEventId: ev.providerEventId, phase: ev.phase });
      return 'other_org';
    }
    if (!tracked && opts.requireTracked) return 'untracked';
    // Upsert the aggregate (metadata only; counts are derived on read) ONLY when this event
    // changes it: a burst of join webhooks must not contend on one row (grade-code WEB-5).
    // A lost first-writer race to another client surfaces as a 409 → `other_org`; a
    // contended patch of an event that already exists never blocks the activity write.
    const needsWrite = !tracked
      || (ev.title !== undefined && ev.title !== tracked.title)
      || (ev.startsAt !== undefined && ev.startsAt !== tracked.startsAt)
      || (connectionId !== undefined && !tracked.connectionId);
    if (needsWrite) {
      try {
        await upsertMarketingEvent({
          tenantId, orgId, provider: ev.provider, providerEventId: ev.providerEventId,
          ...(ev.title ? { title: ev.title } : {}),
          ...(ev.startsAt ? { startsAt: ev.startsAt } : {}),
          ...(connectionId ? { connectionId } : {}),
        });
      } catch (err) {
        const reason = err instanceof OpenwopError ? (err.details as { reason?: string } | undefined)?.reason : undefined;
        if (reason === 'event_in_other_org') {
          log.warn('webinar_event_other_org', { providerEventId: ev.providerEventId, phase: ev.phase });
          return 'other_org';
        }
        if (!(reason === 'event_write_contended' && tracked)) throw err;
      }
    }

    // Ensure the CRM contact (dedup by email). Normalize here too so EVERY path
    // (webhook + report backfill/sync) matches the same person (grade-code WEB-2).
    const email = normEmail(ev.participantEmail);
    // ADR 0449 P1 — the shared ensure seam (was hand-rolled find-or-create).
    // ADR 0627 D2 — silent per row; `imported` is the batch event (see above).
    const { contact, created } = await ensureContactWithOutcome({ tenantId, email, name: ev.participantName || email, leadSource: 'webinar', actor: ACTOR, silent: true });
    if (!contact) return 'failed'; // no usable email, or an erased person — nothing to record
    if (created) {
      const batch = opts.batch ?? { contactsCreated: 0 };
      batch.contactsCreated += 1;
      if (!opts.batch) flushWebinarContactImports(tenantId, orgId, batch);
    }

    // Attendance wins: never record a no-show (nor emit host.webinar.no-show) for a
    // contact who already attended — protects the display counts AND the journey
    // lane from a false "you missed it" on a report-lag no-show.
    if (ev.phase === 'no-show' && (await getActivity(tenantId, orgId, `act:webinar:${ev.providerEventId}:${contact.contactId}:attended`))) return 'suppressed';

    // Idempotent, deterministic-id webinar activity (both lanes converge here).
    const activityId = `act:webinar:${ev.providerEventId}:${contact.contactId}:${ev.phase}`;
    if (await getActivity(tenantId, orgId, activityId)) return 'duplicate'; // already recorded
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
    return 'recorded';
  } catch (err) {
    log.warn('webinar event ingest failed', { providerEventId: ev.providerEventId, phase: ev.phase, error: err instanceof Error ? err.message : String(err) });
    return 'failed';
  }
}

/** ADR 1054 D4 — untracked webhook deliveries dropped since boot (logged, sampled). */
let untrackedDropped = 0;

/** ADR 0820 §7 / G10 — the toggle the Zoom observer's work belongs to. */
export const WEBINARS_FEATURE_ID = 'webinars';

/** The inbound-webhook OBSERVER registered on the shared connections seam. Resolves
 *  the org from the connection, normalizes the Zoom body, and ingests it — ONLY for a
 *  webinar this client already tracks (ADR 1054 D4): any other registration or join in
 *  the connected Zoom account (an internal meeting, a webinar nobody added) is dropped,
 *  not turned into CRM leads. Zoom still gets its 200 (the route answers first). */
export async function onVerifiedWebinarWebhook(event: { tenantId: string; connectionId: string; body: Record<string, unknown>; now: number }): Promise<void> {
  const ev = normalizeZoomEvent(event.body);
  if (!ev) return; // event type we don't track — safe no-op
  // ADR 0820 §7 / G10 — ingesting registrants/attendees into CRM IS the webinars
  // product, so a tenant that may not use `webinars` (toggle off, or a lapsed
  // plan) is skipped silently. The provider still gets its ACK: the inbound
  // route answers before observers, and an observer never fails the delivery.
  if (!(await tenantMayUseFeature(WEBINARS_FEATURE_ID, event.tenantId))) return;
  const orgId = await resolveOrg(event.tenantId, event.connectionId);
  if (!orgId) {
    log.warn('webinar webhook dropped — connection has no org', { connectionId: event.connectionId });
    return;
  }
  const outcome = await ingestWebinarEvent(event.tenantId, orgId, event.connectionId, ev, { requireTracked: true });
  if (outcome === 'untracked') {
    // ADR 1054 D4 — ids and a running count only, never the participant. Sampled (the
    // first, then every 100th) so a busy Zoom account full of meetings cannot flood the log.
    untrackedDropped += 1;
    if (untrackedDropped === 1 || untrackedDropped % 100 === 0) {
      log.info('webinar_webhook_untracked', { connectionId: event.connectionId, providerEventId: ev.providerEventId, phase: ev.phase, droppedSinceBoot: untrackedDropped });
    }
  }
}
