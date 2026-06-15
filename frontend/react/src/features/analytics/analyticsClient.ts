/**
 * Analytics API client (ADR 0018). Authed org-scoped reporting under
 * /v1/host/openwop-app/analytics/orgs/:orgId — read-only summary + recent events.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }

export interface AnalyticsSummary {
  total: number;
  byType: { pageview: number; event: number; conversion: number };
  sessions: number;
  topPaths: { path: string; count: number }[];
  utmSources: { source: string; count: number }[];
}

export interface AnalyticsEvent {
  eventId: string;
  orgId: string;
  type: 'pageview' | 'event' | 'conversion';
  path?: string;
  name?: string;
  ts: string;
  sessionKey?: string;
  referrer?: string;
  utm?: Record<string, string>;
  props?: Record<string, string | number | boolean>;
}

const root = `${config.baseUrl}/v1/host/openwop-app`;

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

const base = (orgId: string): string => `${root}/analytics/orgs/${encodeURIComponent(orgId)}`;

export async function getSummary(orgId: string): Promise<AnalyticsSummary> {
  const res = await fetch(`${base(orgId)}/summary`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ summary: AnalyticsSummary }>(res, 'getSummary')).summary;
}

export async function getEvents(orgId: string): Promise<AnalyticsEvent[]> {
  const res = await fetch(`${base(orgId)}/events`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ events: AnalyticsEvent[] }>(res, 'getEvents')).events;
}
