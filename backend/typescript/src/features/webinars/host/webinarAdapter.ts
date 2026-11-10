/**
 * Webinar provider adapter (ADR 0404 §a) — Zoom v1. Constructed per-request from
 * the connections broker (the `makeAdsAdapter` precedent): every governed write +
 * read goes through `brokeredPost`/`brokeredFetch` with the `zoom-webinar`
 * provider, so the credential is broker-resolved and the write can NEVER ride the
 * generic `ctx.http.safeFetch` (the provider is `adapterOnly`). The host base is a
 * hardcoded constant — the caller supplies only public path ids.
 *
 * The INBOUND webhook lane is NOT here: it rides the shared
 * `connections/inboundWebhooks.ts` seam (signature-verified, tenant-from-config,
 * dedup) + a feature observer. This adapter is OUTBOUND only.
 *
 * @see docs/adr/0404-event-and-creative-provider-integrations.md §a
 */

import { brokeredPost, brokeredFetch, type BrokeredEgressDeps } from '../../../host/brokeredEgress.js';

const ZOOM_PROVIDER = 'zoom-webinar';
/** Hardcoded host base — NEVER caller-derived (the ads-adapter host-pin rule). */
function zoomApiBase(): string {
  return (process.env.OPENWOP_ZOOM_API_BASE || 'https://api.zoom.us/v2').replace(/\/+$/, '');
}

export interface WebinarRegistrant {
  email: string;
  firstName?: string;
  lastName?: string;
}
export interface RegistrantResult { registrantId: string; joinUrl: string }
export interface AttendanceRow {
  email: string;
  name?: string;
  joinTime?: string;
  leaveTime?: string;
  durationSec?: number;
}

export type AdapterResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function readJson(res: Awaited<ReturnType<typeof brokeredPost>>): Promise<AdapterResult<Record<string, unknown>>> {
  if (res.outcome !== 'sent') return { ok: false, error: res.outcome };
  const status = res.res.status;
  let body: unknown;
  try { body = await res.res.json(); } catch { body = {}; }
  if (status < 200 || status >= 300) {
    // ADR 1054 review (WEB-22) — keep only the HTTP status and Zoom's NUMERIC error code.
    // Zoom's message text can echo the registrant ("Invalid email: …"), and this string is
    // stored on queued rows, shown to operators and written to the audit stream.
    const code = (body as { code?: unknown })?.code;
    return { ok: false, error: `zoom_${status}${typeof code === 'number' && Number.isInteger(code) ? `:${code}` : ''}` };
  }
  return { ok: true, value: (body ?? {}) as Record<string, unknown> };
}

export interface RegistrantRow { email: string; name?: string; createdAt?: string }

export interface WebinarAdapter {
  registerRegistrant(webinarId: string, r: WebinarRegistrant): Promise<AdapterResult<RegistrantResult>>;
  listAttendance(webinarId: string, cursor?: string): Promise<AdapterResult<{ rows: AttendanceRow[]; nextCursor?: string }>>;
  /** ADR 1054 D5 — the approved registrant list, so the backfill sees people who
   *  registered on Zoom before the webinar was tracked (no webhook ever carried them). */
  listRegistrants(webinarId: string, cursor?: string): Promise<AdapterResult<{ rows: RegistrantRow[]; nextCursor?: string }>>;
}

const enc = encodeURIComponent;

/** `connectionId` — ADR 1054 D2/D3: pin every call to the tracked event's connection
 *  (ADR 1035's pinned lane re-checks ownership / `connections:use` for the actor), so a
 *  client's webinar goes through that client's Zoom account. Absent ⇒ the broker's
 *  default order (the actor's own → the org's → the workspace's). */
export function makeWebinarAdapter(deps: BrokeredEgressDeps, connectionId?: string): WebinarAdapter {
  const pin = connectionId ? { connectionId } : {};
  return {
    async registerRegistrant(webinarId, r) {
      const body = JSON.stringify({ email: r.email, ...(r.firstName ? { first_name: r.firstName } : {}), ...(r.lastName ? { last_name: r.lastName } : {}) });
      const out = await brokeredPost(deps, { provider: ZOOM_PROVIDER, url: `${zoomApiBase()}/webinars/${enc(webinarId)}/registrants`, body, ...pin });
      const parsed = await readJson(out);
      if (!parsed.ok) return parsed;
      // ADR 1054 D3 — the registrant id IS Zoom's confirmation; a 2xx without one is not a
      // registration (it reported success with '' before). A missing join_url is tolerated:
      // Zoom omits it for approval-required webinars.
      const registrantId = typeof parsed.value.registrant_id === 'string' ? parsed.value.registrant_id : (typeof parsed.value.registrant_id === 'number' ? String(parsed.value.registrant_id) : '');
      if (!registrantId) return { ok: false, error: 'zoom_no_registrant_id' };
      const joinUrl = typeof parsed.value.join_url === 'string' ? parsed.value.join_url : '';
      return { ok: true, value: { registrantId, joinUrl } };
    },

    async listAttendance(webinarId, cursor) {
      // Past-webinar participants report (report:read:admin). Best-effort read.
      const qs = cursor ? `?next_page_token=${enc(cursor)}&page_size=300` : '?page_size=300';
      const out = await brokeredFetch(deps, { provider: ZOOM_PROVIDER, url: `${zoomApiBase()}/report/webinars/${enc(webinarId)}/participants${qs}`, method: 'GET', ...pin });
      if (out.outcome !== 'sent') return { ok: false, error: out.outcome };
      let body: Record<string, unknown> = {};
      try { body = (await out.res.json()) as Record<string, unknown>; } catch { /* keep {} */ }
      if (out.res.status < 200 || out.res.status >= 300) return { ok: false, error: `zoom_${out.res.status}` };
      const participants = Array.isArray(body.participants) ? (body.participants as Record<string, unknown>[]) : [];
      const rows: AttendanceRow[] = participants.map((p) => ({
        email: typeof p.user_email === 'string' ? p.user_email : (typeof p.email === 'string' ? p.email : ''),
        ...(typeof p.name === 'string' ? { name: p.name } : {}),
        ...(typeof p.join_time === 'string' ? { joinTime: p.join_time } : {}),
        ...(typeof p.leave_time === 'string' ? { leaveTime: p.leave_time } : {}),
        ...(typeof p.duration === 'number' ? { durationSec: p.duration } : {}),
      })).filter((r) => r.email);
      const nextCursor = typeof body.next_page_token === 'string' && body.next_page_token ? body.next_page_token : undefined;
      return { ok: true, value: { rows, ...(nextCursor ? { nextCursor } : {}) } };
    },

    async listRegistrants(webinarId, cursor) {
      const qs = cursor ? `?status=approved&next_page_token=${enc(cursor)}&page_size=300` : '?status=approved&page_size=300';
      const out = await brokeredFetch(deps, { provider: ZOOM_PROVIDER, url: `${zoomApiBase()}/webinars/${enc(webinarId)}/registrants${qs}`, method: 'GET', ...pin });
      if (out.outcome !== 'sent') return { ok: false, error: out.outcome };
      let body: Record<string, unknown> = {};
      try { body = (await out.res.json()) as Record<string, unknown>; } catch { /* keep {} */ }
      if (out.res.status < 200 || out.res.status >= 300) return { ok: false, error: `zoom_${out.res.status}` };
      const registrants = Array.isArray(body.registrants) ? (body.registrants as Record<string, unknown>[]) : [];
      const rows: RegistrantRow[] = registrants.map((r) => {
        const name = [r.first_name, r.last_name].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ');
        return {
          email: typeof r.email === 'string' ? r.email : '',
          ...(name ? { name } : {}),
          ...(typeof r.create_time === 'string' ? { createdAt: r.create_time } : {}),
        };
      }).filter((r) => r.email);
      const nextCursor = typeof body.next_page_token === 'string' && body.next_page_token ? body.next_page_token : undefined;
      return { ok: true, value: { rows, ...(nextCursor ? { nextCursor } : {}) } };
    },
  };
}
