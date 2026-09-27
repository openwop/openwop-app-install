/**
 * Webinar backfill reconciliation (ADR 0404 §a) — the second ingestion lane that
 * catches webhooks Zoom never delivered. Copies the campaign-connectors sync
 * ERGONOMICS (a cooldown-CAS claim at start so concurrent syncs don't both hit
 * the provider, and a single chokepoint) into its OWN service — it does NOT
 * overload the ads AdsAdapter (that's ad-metrics-specialized). Idempotent: it
 * re-drives the same deterministic-id CRM activities, so a reconcile of an
 * already-webhooked event is a no-op.
 *
 * Also the home of the compute-on-read event COUNTS the dashboard reads (derived
 * from the activity stream — no stored counter to race).
 *
 * @see docs/adr/0404-event-and-creative-provider-integrations.md §a
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import type { BrokeredEgressDeps } from '../../host/brokeredEgress.js';
import { createLogger } from '../../observability/logger.js';
import { listActivitiesByIdPrefix } from '../crm/crmEntitiesService.js';
import { getContact } from '../crm/contactsService.js';
import { makeWebinarAdapter } from './host/webinarAdapter.js';
import { ingestWebinarEvent, flushWebinarContactImports, type WebinarContactBatch, type WebinarPhase } from './webinarProcessor.js';
import type { MarketingEvent } from './entities/marketingEvent.js';

const log = createLogger('webinars.sync');

/** Cooldown between backfill pulls per (tenant, org, event). */
export const WEBINAR_SYNC_COOLDOWN_MS = 15 * 60 * 1000;

interface SyncStateRow { key: string; tenantId: string; lastSyncAt: string }
const syncState = new DurableCollection<SyncStateRow>('webinars:sync-state', (r) => r.key);
const stateKey = (tenantId: string, orgId: string, eventId: string): string => `${tenantId}::${orgId}::${eventId}`;

/** Atomic cooldown claim at sync START (the campaign-connectors AUDIT-7 pattern). */
export async function claimWebinarSync(tenantId: string, orgId: string, eventId: string): Promise<{ claimed: boolean; retryAtIso?: string }> {
  const key = stateKey(tenantId, orgId, eventId);
  const prev = await syncState.get(key).catch(() => undefined);
  const now = Date.now();
  if (prev && prev.tenantId === tenantId) {
    const retryAt = new Date(prev.lastSyncAt).getTime() + WEBINAR_SYNC_COOLDOWN_MS;
    if (now < retryAt) return { claimed: false, retryAtIso: new Date(retryAt).toISOString() };
  }
  const next: SyncStateRow = { key, tenantId, lastSyncAt: new Date(now).toISOString() };
  const won = await syncState.compareAndSwap(prev && prev.tenantId === tenantId ? prev : null, next);
  if (!won) {
    const fresh = await syncState.get(key).catch(() => undefined);
    const retryAt = fresh ? new Date(fresh.lastSyncAt).getTime() + WEBINAR_SYNC_COOLDOWN_MS : now + WEBINAR_SYNC_COOLDOWN_MS;
    return { claimed: false, retryAtIso: new Date(retryAt).toISOString() };
  }
  return { claimed: true };
}

/** R2 WB-SP-5 — roll the claim back after an ERROR sync so the retry is not
 *  told "Recently synced" (a false past-success). Best-effort delete: a lost
 *  race just means a concurrent sync now owns the window. */
export async function releaseWebinarSyncClaim(tenantId: string, orgId: string, eventId: string): Promise<void> {
  await syncState.delete(stateKey(tenantId, orgId, eventId)).catch(() => undefined);
}

export interface EventCounts { registrantCount: number; attendeeCount: number; noShowCount: number }

type PhaseSets = Record<WebinarPhase, Set<string>>;
const emptyPhaseSets = (): PhaseSets => ({ registered: new Set(), attended: new Set(), 'no-show': new Set() });
function countsFrom(byPhase: PhaseSets): EventCounts {
  // Attendance wins over a (possibly stale, report-lag) no-show: a contact who
  // ended up attending is NOT a no-show, even if an earlier sync wrote one.
  const noShow = new Set([...byPhase['no-show']].filter((c) => !byPhase.attended.has(c)));
  return { registrantCount: byPhase.registered.size, attendeeCount: byPhase.attended.size, noShowCount: noShow.size };
}

/** Derive the counts from the CRM activity stream (compute-on-read — race-safe,
 *  single source of truth). Activity ids are `act:webinar:<providerEventId>:<contactId>:<phase>`. */
export async function computeEventCounts(tenantId: string, orgId: string, providerEventId: string): Promise<EventCounts> {
  const rows = await listActivitiesByIdPrefix(tenantId, orgId, `act:webinar:${providerEventId}:`);
  const byPhase = emptyPhaseSets();
  for (const a of rows) {
    // id = act:webinar:<providerEventId>:<contactId>:<phase> — phase is the last segment.
    const parts = a.activityId.split(':');
    const phase = parts[parts.length - 1] as WebinarPhase;
    const contactId = a.contactId;
    if (contactId && (phase === 'registered' || phase === 'attended' || phase === 'no-show')) byPhase[phase].add(contactId);
  }
  return countsFrom(byPhase);
}

/**
 * Counts for MANY events in ONE prefix scan (grade-code WEB-1 dashboard fan-out).
 * The events list route needs counts for every event; calling `computeEventCounts`
 * per event is N `host_ext_kv` prefix scans (each expensive — the prefix-scan
 * incident). This reads `act:webinar:` ONCE and buckets by providerEventId. Returns
 * a Map keyed by providerEventId (absent event ⇒ caller defaults to zeros).
 */
export async function computeEventCountsBatch(tenantId: string, orgId: string): Promise<Map<string, EventCounts>> {
  const rows = await listActivitiesByIdPrefix(tenantId, orgId, 'act:webinar:');
  const byEvent = new Map<string, PhaseSets>();
  for (const a of rows) {
    const parts = a.activityId.split(':');
    const phase = parts[parts.length - 1] as WebinarPhase;
    const contactId = a.contactId;
    if (!contactId || (phase !== 'registered' && phase !== 'attended' && phase !== 'no-show')) continue;
    // providerEventId = the id minus the `act:webinar:` prefix and the `:<contactId>:<phase>`
    // suffix — robust to a providerEventId or contactId that contains ':'.
    const rest = a.activityId.slice('act:webinar:'.length);
    const suffix = `:${contactId}:${phase}`;
    if (!rest.endsWith(suffix)) continue;
    const providerEventId = rest.slice(0, rest.length - suffix.length);
    if (!providerEventId) continue;
    let b = byEvent.get(providerEventId);
    if (!b) { b = emptyPhaseSets(); byEvent.set(providerEventId, b); }
    b[phase].add(contactId);
  }
  const out = new Map<string, EventCounts>();
  for (const [pid, b] of byEvent) out.set(pid, countsFrom(b));
  return out;
}

export type SyncOutcome =
  | { outcome: 'cooldown'; retryAtIso: string }
  | { outcome: 'synced'; attendees: number; noShows: number; partial?: boolean }
  | { outcome: 'error'; reason: string };

/**
 * Reconcile one event: pull attendance from the provider (paged), ingest missed
 * `attended` activities, then mark registrants who never attended as `no-show`.
 * Best-effort; respects the cooldown.
 */
export async function syncEvent(deps: BrokeredEgressDeps, tenantId: string, orgId: string, event: MarketingEvent): Promise<SyncOutcome> {
  const claim = await claimWebinarSync(tenantId, orgId, event.eventId);
  if (!claim.claimed) return { outcome: 'cooldown', retryAtIso: claim.retryAtIso! };

  const adapter = makeWebinarAdapter(deps);
  const attendedContactIds = new Set<string>();
  // R2 WB-SP-8 — count DISTINCT people, not report rows: Zoom emits one row
  // per join session, so a drop-and-rejoin attendee counted twice in the toast.
  const attendedEmails = new Set<string>();
  // ADR 0627 D2 — ONE `contact.imported { source:'webinar', count }` per sync,
  // never one `created` per participant.
  const contactBatch: WebinarContactBatch = { contactsCreated: 0 };
  let cursor: string | undefined;
  // R2 WB-SP-1 — a PARTIAL attendance walk must never feed the no-show
  // computation: the people on the unfetched pages ATTENDED, and marking them
  // no-show writes a durable false activity and fires a "you missed it"
  // notification at them. The old `break` kept the partial ingest (fine) but
  // fell through to the no-show pass anyway.
  let walkComplete = false;
  // Bounded page walk (avoid an unbounded loop on a misbehaving provider).
  for (let page = 0; page < 20; page++) {
    const res = await adapter.listAttendance(event.providerEventId, cursor);
    if (!res.ok) {
      if (page === 0) {
        // R2 WB-SP-5 — an ERROR sync must not consume the cooldown: the next
        // retry would toast "Recently synced" — a false past-success claim.
        await releaseWebinarSyncClaim(tenantId, orgId, event.eventId);
        return { outcome: 'error', reason: res.error };
      }
      break; // partial pages already ingested; walkComplete stays false
    }
    for (const row of res.value.rows) {
      await ingestWebinarEvent(tenantId, orgId, event.connectionId, {
        provider: event.provider, providerEventId: event.providerEventId, phase: 'attended',
        participantEmail: row.email, ...(row.name ? { participantName: row.name } : {}),
        ...(event.title ? { title: event.title } : {}), ...(row.joinTime ? { occurredAt: row.joinTime } : {}),
      }, { batch: contactBatch });
      attendedEmails.add(row.email.toLowerCase());
    }
    if (!res.value.nextCursor) { walkComplete = true; break; }
    cursor = res.value.nextCursor;
  }

  flushWebinarContactImports(tenantId, orgId, contactBatch);
  const attendees = attendedEmails.size;
  // No-shows are computed ONLY once the attendance report has data. Zoom's
  // participants report is empty right after a webinar ends; marking everyone a
  // no-show off an empty report (then correcting on the next sync) would fire a
  // false "you missed it" journey. If we saw zero attendees this pass, defer.
  if (attendees === 0) {
    log.info('webinar sync — attendance report empty, deferring no-show computation', { eventId: event.eventId });
    return { outcome: 'synced', attendees, noShows: 0 };
  }
  // R2 WB-SP-1 — the walk broke early (page failure or the 20-page bound): the
  // attendance picture is INCOMPLETE, so no-show conclusions are unsafe. Keep
  // the partial attendee ingest, defer the accusation.
  if (!walkComplete) {
    log.warn('webinar sync — partial attendance walk, deferring no-show computation', { eventId: event.eventId, attendees });
    // review Minor 3 — the OPERATOR must see this too, not just the log: a
    // plain 'synced' toasted "N attended, 0 no-show" as a full-success claim.
    return { outcome: 'synced', attendees, noShows: 0, partial: true };
  }

  // No-shows: registered contacts with no attended activity. Read the registered
  // activities, resolve each contact's attended presence from the activity stream.
  const registered = await listActivitiesByIdPrefix(tenantId, orgId, `act:webinar:${event.providerEventId}:`);
  const attendedIds = new Set(registered.filter((a) => a.activityId.endsWith(':attended')).map((a) => a.contactId));
  for (const cid of attendedIds) if (cid) attendedContactIds.add(cid);
  let noShows = 0;
  for (const a of registered) {
    if (!a.activityId.endsWith(':registered') || !a.contactId) continue;
    if (attendedContactIds.has(a.contactId)) continue;
    const contact = await getContact(a.contactId).catch(() => null);
    if (!contact || contact.tenantId !== tenantId || !contact.email) continue;
    await ingestWebinarEvent(tenantId, orgId, event.connectionId, {
      provider: event.provider, providerEventId: event.providerEventId, phase: 'no-show',
      participantEmail: contact.email, ...(event.title ? { title: event.title } : {}),
    });
    noShows += 1;
  }

  log.info('webinar sync complete', { eventId: event.eventId, attendees, noShows });
  return { outcome: 'synced', attendees, noShows };
}

