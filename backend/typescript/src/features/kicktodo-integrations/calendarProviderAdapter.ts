/**
 * KT-PORT-6a — the calendar-write PROVIDER ADAPTER (the real transport behind
 * ADR 0421's INERT calendar port).
 *
 * WHAT THE OPERATOR / PARTICIPANT TOUCHES (the correction to the first cut, which
 * wrongly made the ENDPOINT an operator env var — 6a-2):
 *   - the PARTICIPANT connects their calendar provider in the UI
 *     (`/access?tab=connections`, the ADR 0024 Connections flow) + grants the
 *     `calendar.events` write scope. That Connection is the ONLY per-user config;
 *   - for a KNOWN provider (`google`) the API endpoint AND the request shape are
 *     DERIVED from the provider — no endpoint env var. The single operator control
 *     that remains is the honesty gate `OPENWOP_CALENDAR_PROVIDER_ENABLED` (below).
 *   - `OPENWOP_CALENDAR_PROVIDER_ENDPOINT` survives ONLY as an optional override for
 *     a self-hosted / not-yet-modelled provider (it then speaks the generic
 *     `{dateLocal,title}` contract) — it is NOT how you configure Google.
 *
 * HONESTY GATE: `registerCalendarProviderAdapter()` registers the transport ONLY
 * when `OPENWOP_CALENDAR_PROVIDER_ENABLED === 'true'` (+ a resolvable endpoint,
 * always true for a known provider). Otherwise it registers nothing,
 * `syncEnrollmentCalendar` keeps throwing `CalendarUnavailableError`, and
 * `isCalendarTransportConfigured()` stays honestly false. The gate stays because the
 * live lane is UNVERIFIED here — a real Google Calendar write needs live OAuth creds
 * this environment can't provide; ships gated-off + mock-tested, and an operator
 * opts in only once they've confirmed it against their tenant.
 *
 * FOLLOW-ON (KT-PORT-6a-2, TODO §6): the built-in `google` provider is `reach:'mcp'`
 * — the architecturally-correct call path is the registered MCP server (credential
 * injected), not this bespoke direct-REST adapter. This adapter is the honest
 * interim; the reach-based version is captured as a follow-on.
 *
 * Credential: the OWNER's user-scoped calendar Connection, resolved through the
 * ADR 0024 broker (`resolveConnectionCredential({…, actingUserId: ownerSubject})` —
 * calendar-write is per-participant). Egress: pinned through the SSRF-guarding
 * dispatcher (deny private/loopback unless allow-private, https-pinned, timeout,
 * redirect:'error'); errors are generic — the endpoint is never echoed. The
 * deterministic `externalId` maps to a provider-valid, idempotent event id so a
 * re-sync UPSERTs (PUT) and a supersession DELETEs the same event — never dupes.
 */
import { createHash } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { isDeniedWebhookHost, webhookEgressDispatcher, webhookPrivateEgressAllowed } from '../../host/webhookEgressGuard.js';
import { resolveConnectionCredential } from '../connections/connectionsService.js';
import { createLogger } from '../../observability/logger.js';
import { registerCalendarTransport, type CalendarTransport, type CalendarWriteContext } from './calendarWriteService.js';

const log = createLogger('kicktodo.calendarProvider');
const DEFAULT_TIMEOUT_MS = 20_000;

interface CalendarEvent { dateLocal: string; title: string }

/** A provider's known integration shape — its API base (so no operator endpoint
 *  config is needed) and how the generic event maps to ITS request body. */
interface CalendarProviderSpec {
  /** The provider's well-known API base. Absent ⇒ the provider is not modelled and
   *  an operator endpoint override is REQUIRED (the generic self-hosted case). */
  base?: string;
  upsertBody(event: CalendarEvent): unknown;
}

/** All-day event's exclusive end date (Google `end.date` is exclusive → +1 day). */
function nextDay(dateLocal: string): string {
  const d = new Date(`${dateLocal}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Self-hosted / not-yet-modelled provider: the simple contract, endpoint via the
 *  operator override env var. */
const GENERIC_SPEC: CalendarProviderSpec = {
  upsertBody: (e) => ({ dateLocal: e.dateLocal, title: e.title }),
};

const PROVIDER_SPECS: Record<string, CalendarProviderSpec> = {
  google: {
    // Google Calendar API v3 — the participant's PRIMARY calendar. A known constant;
    // never operator-configured. NOTE: the exact resource shape is UNVERIFIED against
    // live Google (this lane ships gated-off) — an all-day event: summary + start/end
    // `date` (end exclusive). The reach-based path (6a-2) is the verified long-term.
    base: 'https://www.googleapis.com/calendar/v3/calendars/primary',
    upsertBody: (e) => ({ summary: e.title, start: { date: e.dateLocal }, end: { date: nextDay(e.dateLocal) } }),
  },
};

/** The RFC 0095 provider id whose Connection credential backs the write. Operator
 *  override via `OPENWOP_CALENDAR_PROVIDER` (default `google`, a built-in provider). */
function calendarProvider(): string {
  return process.env.OPENWOP_CALENDAR_PROVIDER?.trim() || 'google';
}

function specFor(provider: string): CalendarProviderSpec {
  return PROVIDER_SPECS[provider] ?? GENERIC_SPEC;
}

/** The write endpoint: the provider's KNOWN base (derived, no config), OR an operator
 *  override (`OPENWOP_CALENDAR_PROVIDER_ENDPOINT`) for a self-hosted/unmodelled
 *  provider. Absent ⇒ the lane can't resolve an endpoint (unmodelled + no override). */
export function calendarEndpoint(): string | undefined {
  return process.env.OPENWOP_CALENDAR_PROVIDER_ENDPOINT?.trim() || specFor(calendarProvider()).base;
}

/** The honesty gate: the operator opted in AND an endpoint is resolvable (always the
 *  case for a known provider like `google` — so for Google, only the enable flag). */
export function calendarProviderConfigured(): boolean {
  return process.env.OPENWOP_CALENDAR_PROVIDER_ENABLED === 'true' && !!calendarEndpoint();
}

/** The `externalId` (`enrollmentId|dateLocal|stableActivityId`) carries delimiters a
 *  provider event id rejects; hash it to a stable, idempotent id. Lowercase hex is a
 *  base32hex subset, so it is a valid Google Calendar event id (`kt` prefix stays in
 *  the a–v/0–9 alphabet). */
function providerEventId(externalId: string): string {
  return `kt${createHash('sha1').update(externalId).digest('hex')}`;
}

async function ownerAuthHeader(ctx: CalendarWriteContext): Promise<Record<string, string>> {
  const resolved = await resolveConnectionCredential({
    tenantId: ctx.tenantId,
    provider: calendarProvider(),
    actingUserId: ctx.ownerSubject,
  }).catch(() => null);
  // Fail-closed: no authorized Connection for THIS participant ⇒ no write. The
  // caller (syncEnrollmentCalendar) surfaces it; we never write unauthenticated.
  if (!resolved?.secret) throw new Error('calendar_provider_unauthorized');
  return { authorization: `Bearer ${resolved.secret}` };
}

async function dispatch(method: 'PUT' | 'DELETE', ctx: CalendarWriteContext, eventId: string, body?: unknown): Promise<void> {
  const endpoint = calendarEndpoint();
  if (!endpoint) throw new Error('calendar_provider_not_configured');
  let url: URL;
  try { url = new URL(`${endpoint.replace(/\/$/, '')}/events/${encodeURIComponent(eventId)}`); }
  catch { throw new Error('calendar_provider_misconfigured'); }
  // SSRF guard — never echo the endpoint.
  if (!webhookPrivateEgressAllowed() && isDeniedWebhookHost(url.hostname)) throw new Error('calendar_provider_blocked');
  if (url.protocol !== 'https:' && !webhookPrivateEgressAllowed()) throw new Error('calendar_provider_insecure');
  const headers = await ownerAuthHeader(ctx);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await undiciFetch(url, {
      method,
      headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      dispatcher: webhookEgressDispatcher(),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error((e as { name?: string }).name === 'AbortError' ? 'calendar_provider_timeout' : 'calendar_provider_transport_error');
  } finally {
    clearTimeout(timer);
  }
  // DELETE of an already-absent event is idempotent-OK (provider 404/410).
  if (!res.ok && !(method === 'DELETE' && (res.status === 404 || res.status === 410))) {
    throw new Error('calendar_provider_error'); // no status/endpoint echo
  }
}

/** The connection-backed transport. Idempotent by the deterministic event id; the
 *  request body is the resolved provider's shape.
 *  Exported for unit tests (production reaches it only via the boot registration). */
export const calendarProviderTransport: CalendarTransport = {
  async upsert(externalId, event, ctx) {
    await dispatch('PUT', ctx, providerEventId(externalId), specFor(calendarProvider()).upsertBody(event));
  },
  async remove(externalId, ctx) {
    await dispatch('DELETE', ctx, providerEventId(externalId));
  },
};

/** Boot hook (called from the feature's registerRoutes). Registers the transport
 *  ONLY when the operator has opted in (+ a resolvable endpoint) — so the port stays
 *  honestly "awaiting adapter" by default. */
export function registerCalendarProviderAdapter(): void {
  if (!calendarProviderConfigured()) return;
  registerCalendarTransport(calendarProviderTransport);
  log.info('kicktodo_calendar_provider_registered', { provider: calendarProvider() });
}
