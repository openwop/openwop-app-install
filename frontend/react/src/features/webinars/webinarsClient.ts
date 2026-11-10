/**
 * Webinars API client (ADR 0404 §a/§b) — the operator dashboard over
 * /host/openwop-app/webinars/orgs/:orgId/*. Connector SETUP (connect Zoom,
 * configure the inbound webhook) is owned by the Connections surface — this
 * client covers the marketing-event dashboard + form binding + backfill sync.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface EventCounts { registrantCount: number; attendeeCount: number; noShowCount: number }

export interface MarketingEvent {
  eventId: string;
  provider: string;
  providerEventId: string;
  title: string;
  startsAt?: string;
  connectionId?: string;
  formId?: string;
  journeyId?: string;
  createdAt: string;
  counts: EventCounts;
  /** R2 WB-SP-2 — registrations the forms sink could not push to the provider
   *  (it runs with no acting user, so the connection gate fail-closes). */
  pendingPushCount?: number;
}

const root = `${config.baseUrl}/host/openwop-app`;
const orgBase = (orgId: string): string => `${root}/webinars/orgs/${encodeURIComponent(orgId)}`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/** ADR 1054 — carries the server's `details.reason` (e.g. `event_in_other_org`) so the
 *  page can show its own copy instead of the server's English message. */
export class WebinarsApiError extends Error {
  constructor(message: string, readonly reason?: string, readonly code?: string) { super(message); this.name = 'WebinarsApiError'; }
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    let reason: string | undefined;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: unknown; message?: string; details?: { reason?: unknown } };
      detail = body?.message ?? '';
      if (typeof body?.details?.reason === 'string') reason = body.details.reason;
      if (typeof body?.error === 'string') code = body.error;
    } catch { /* non-JSON */ }
    throw new WebinarsApiError(detail || `${ctx} returned ${res.status}`, reason, code);
  }
  return (await res.json()) as T;
}

export interface OrgRef { orgId: string; name: string }
export async function listOrgs(): Promise<OrgRef[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: OrgRef[] }>(res, 'listOrgs')).orgs;
}

export async function listWebinarEvents(orgId: string): Promise<MarketingEvent[]> {
  const res = await fetch(`${orgBase(orgId)}/events`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ events: MarketingEvent[] }>(res, 'listWebinarEvents')).events;
}

export async function createWebinarEvent(orgId: string, input: { providerEventId: string; title?: string; startsAt?: string; connectionId?: string }): Promise<MarketingEvent> {
  const res = await fetch(`${orgBase(orgId)}/events`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<MarketingEvent>(res, 'createWebinarEvent');
}

export async function bindWebinarForm(orgId: string, eventId: string, formId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/events/${encodeURIComponent(eventId)}/bind-form`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ formId }) }));
  await asJson<unknown>(res, 'bindWebinarForm');
}

export interface SyncResult { outcome: 'synced' | 'cooldown' | 'error'; attendees?: number; noShows?: number; registrants?: number; partial?: boolean; retryAtIso?: string; reason?: string }
export async function syncWebinarEvent(orgId: string, eventId: string): Promise<SyncResult> {
  const res = await fetch(`${orgBase(orgId)}/events/${encodeURIComponent(eventId)}/sync`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return asJson<SyncResult>(res, 'syncWebinarEvent');
}

/** R2 WB-SP-2 — drain the pending registrant-push queue with a real acting
 *  user. Successes leave the queue; failures stay, with reasons. */
export interface PushResult {
  pushed: number;
  failed: number;
  /** First 10 failures; each one stays queued with its reason (ADR 1054 D3). */
  failures: Array<{ email: string; reason: string }>;
}
export async function pushWebinarRegistrants(orgId: string, eventId: string): Promise<PushResult> {
  const res = await fetch(`${orgBase(orgId)}/events/${encodeURIComponent(eventId)}/push-registrants`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return asJson(res, 'pushWebinarRegistrants');
}

/** ADR 1054 review (WEB86-14) — who is waiting for a Zoom push, with Zoom's last answer.
 *  Emails arrive masked (`ad…@example.com`) with the name the person gave; `pendingId` is
 *  the random handle to remove one. */
export interface PendingRegistrant { pendingId: string; email: string; name?: string; queuedAt: string; attempts: number; lastError?: string }
export async function listPendingRegistrants(orgId: string, eventId: string): Promise<{ total: number; items: PendingRegistrant[] }> {
  const res = await fetch(`${orgBase(orgId)}/events/${encodeURIComponent(eventId)}/pending`, fetchOpts({ headers: authedHeaders() }));
  return asJson(res, 'listPendingRegistrants');
}
/** Drop one queued Zoom push (the person stays registered in the CRM). */
export async function removePendingRegistrant(orgId: string, eventId: string, pendingId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/events/${encodeURIComponent(eventId)}/pending/${encodeURIComponent(pendingId)}/remove`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  await asJson<unknown>(res, 'removePendingRegistrant');
}
