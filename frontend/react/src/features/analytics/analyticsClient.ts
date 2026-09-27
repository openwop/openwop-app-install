/**
 * Analytics API client (ADR 0018). Authed org-scoped reporting under
 * /host/openwop-app/analytics/orgs/:orgId — read-only summary + recent events.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }

export interface AnalyticsSummary {
  total: number;
  byType: { pageview: number; event: number; conversion: number };
  /** ANL-UX-15 — OMITTED when no row in the window carried a sessionKey. */
  sessions?: number;
  /** ADR 0569 — daily uniques (cookieless): distinct daily-rotating visitor
   *  hashes per UTC day, summed across the window. Absent ⇒ counts only (the
   *  operator opt-out, or no hashed rows yet). */
  uniqueVisitors?: number;
  /** First hashed event — uniques begin at deployment; the UI names it. */
  uniqueVisitorsSince?: string;
  topPaths: { path: string; count: number }[];
  /** ANL-UX-10 — distinct counts BEFORE the top-10 cut, so the UI can say "top 10 of N". */
  topPathsTotal?: number;
  utmSourcesTotal?: number;
  utmSources: { source: string; count: number }[];
  /** ADR 0018 CWV fold-in — real-user Core Web Vitals p75 per metric. */
  vitals?: { metric: string; p75: number; rating: 'good' | 'needs-improvement' | 'poor'; count: number }[];
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

const root = `${config.baseUrl}/host/openwop-app`;

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

/** The reporting window, in days. `undefined` = all time (the historical
 *  behaviour, and still what the server does when the param is absent). */
export type AnalyticsWindow = 7 | 30 | 90 | undefined;
const windowQuery = (days: AnalyticsWindow): string => (days ? `?days=${days}` : '');

/** AN-G3 — the prior period of equal length; absent on the all-time window
 *  (all-time has no prior period) and from older backends (additive field). */
export interface AnalyticsComparison { days: number; total: number; sessions?: number; pageviews: number; conversions: number; uniqueVisitors?: number }

/** ANL-UX-2 R2 — the org's lifetime facts, ALWAYS sent by a backend that knows
 *  them. Its own absence is what tells this client "unknown" — an omitted
 *  `firstEventAt` alone cannot distinguish "this org never reported" from "the
 *  backend predates the field", and reading the second as the first shows a
 *  "not installed" page to a tenant with real history. */
export interface AnalyticsLifetime { firstEventAt?: string; uniqueVisitorsSince?: string }

export async function getSummary(
  orgId: string,
  days?: AnalyticsWindow,
): Promise<{ summary: AnalyticsSummary; comparison?: AnalyticsComparison; firstEventAt?: string; lifetime?: AnalyticsLifetime }> {
  const res = await fetch(`${base(orgId)}/summary${windowQuery(days)}`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ summary: AnalyticsSummary; comparison?: AnalyticsComparison; firstEventAt?: string; lifetime?: AnalyticsLifetime }>(res, 'getSummary');
  return {
    summary: body.summary,
    ...(body.comparison ? { comparison: body.comparison } : {}),
    ...(body.firstEventAt ? { firstEventAt: body.firstEventAt } : {}),
    ...(body.lifetime && typeof body.lifetime === 'object' ? { lifetime: body.lifetime } : {}),
  };
}

export interface TrendPoint {
  day: string; pageviews: number; events: number; conversions: number; uniques: number;
  /** ANL-UX-5 — this bucket does not cover a whole UTC day yet (today). The
   *  right-edge dip is the day still running, not a collapse in traffic. */
  partial?: boolean;
}
/** R2 AN-R2-1 — per-UTC-day counts behind the trend chart (windowed only). */
export async function getTrend(orgId: string, days: number): Promise<TrendPoint[]> {
  const res = await fetch(`${base(orgId)}/trend?days=${days}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ trend: TrendPoint[] }>(res, 'getTrend')).trend;
}

export async function getEvents(orgId: string, days?: AnalyticsWindow): Promise<AnalyticsEvent[]> {
  const res = await fetch(`${base(orgId)}/events${windowQuery(days)}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ events: AnalyticsEvent[] }>(res, 'getEvents')).events;
}

/** ADR 0512 — the tenant-scoped workspace-navigation aggregate (route pattern ×
 *  source × count over the last weeks). 404 when the sub-toggle is off. */
export interface NavReport { weeks: string[]; rows: { route: string; source: string; count: number }[] }
export async function getNavReport(): Promise<NavReport> {
  const res = await fetch(`${root}/analytics/nav/report`, fetchOpts({ headers: authedHeaders() }));
  return asJson<NavReport>(res, 'getNavReport');
}
