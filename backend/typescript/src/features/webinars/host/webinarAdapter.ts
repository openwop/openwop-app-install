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
    const msg = (body as { message?: unknown })?.message;
    return { ok: false, error: `zoom_${status}${typeof msg === 'string' ? `:${msg}` : ''}` };
  }
  return { ok: true, value: (body ?? {}) as Record<string, unknown> };
}

export interface WebinarAdapter {
  registerRegistrant(webinarId: string, r: WebinarRegistrant): Promise<AdapterResult<RegistrantResult>>;
  listAttendance(webinarId: string, cursor?: string): Promise<AdapterResult<{ rows: AttendanceRow[]; nextCursor?: string }>>;
}

const enc = encodeURIComponent;

export function makeWebinarAdapter(deps: BrokeredEgressDeps): WebinarAdapter {
  return {
    async registerRegistrant(webinarId, r) {
      const body = JSON.stringify({ email: r.email, ...(r.firstName ? { first_name: r.firstName } : {}), ...(r.lastName ? { last_name: r.lastName } : {}) });
      const out = await brokeredPost(deps, { provider: ZOOM_PROVIDER, url: `${zoomApiBase()}/webinars/${enc(webinarId)}/registrants`, body });
      const parsed = await readJson(out);
      if (!parsed.ok) return parsed;
      const registrantId = typeof parsed.value.registrant_id === 'string' ? parsed.value.registrant_id : '';
      const joinUrl = typeof parsed.value.join_url === 'string' ? parsed.value.join_url : '';
      return { ok: true, value: { registrantId, joinUrl } };
    },

    async listAttendance(webinarId, cursor) {
      // Past-webinar participants report (report:read:admin). Best-effort read.
      const qs = cursor ? `?next_page_token=${enc(cursor)}&page_size=300` : '?page_size=300';
      const out = await brokeredFetch(deps, { provider: ZOOM_PROVIDER, url: `${zoomApiBase()}/report/webinars/${enc(webinarId)}/participants${qs}`, method: 'GET' });
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
  };
}
