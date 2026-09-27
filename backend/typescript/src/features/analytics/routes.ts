/**
 * Analytics feature routes (host-extension, ADR 0018).
 *   Public beacon (unauthed):  POST /v1/host/openwop-app/public-analytics/:orgId/collect
 *   Authed (org-scoped, RBAC):  GET  /v1/host/openwop-app/analytics/orgs/:orgId/{summary,events}
 * The public prefix is on PUBLIC_PATH_PREFIXES (auth.ts). The beacon is
 * consent-gated through the ADR 0020 helper (one consent rule — which is PERMISSIVE when the `consent` feature is off, the default; ADR 0651 D4) and relies on the
 * global per-IP rate-limit middleware for abuse control.
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { checkEntitlement } from '../../host/entitlementSeam.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getOrg } from '../../host/accessControlService.js';
import { isAllowed } from '../consent/consentService.js';

/** AN-G1 — the reporting window from `?days=`. Bounded and fail-open-to-all-time:
 *  an absent or unparseable value keeps the previous behaviour exactly, so an
 *  older client (or a bookmarked URL) sees no change. */
const WINDOW_DAYS = new Set([7, 30, 90]);
function windowDaysFor(req: Request): number | undefined {
  const raw = typeof req.query.days === 'string' ? Number(req.query.days) : NaN;
  return WINDOW_DAYS.has(raw) ? raw : undefined;
}
function windowFor(req: Request): string | undefined {
  return sinceIsoForDays(windowDaysFor(req));
}
import { recordEvent, listEvents, summarizeForReport, sinceIsoForDays, trendForDays } from './analyticsService.js';
import { recordNav, navReport } from './navTelemetryService.js';
import { visitorHashFor } from './visitorIdentity.js';

const FEATURE = { toggleId: 'analytics', label: 'Analytics' };
const ORG = '/v1/host/openwop-app/analytics/orgs/:orgId';
const PUB = '/v1/host/openwop-app/public-analytics';

// ANL-7 — per-org beacon budget (fixed 60 s window, per instance). Env-tunable
// like the IP limiter; `0` disables. Reset for tests via the exported helper.
// Read per call (cheap) so an operator's env change and a test's shrink both take
// effect without a re-import; `0` disables.
function orgBeaconPerMin(): number { const n = Number(process.env.OPENWOP_ANALYTICS_BEACON_ORG_REQS_PER_MIN ?? 600); return Number.isFinite(n) && n >= 0 ? n : 600; }
const orgBeaconWindows = new Map<string, { windowStart: number; count: number }>();
function takeOrgBeaconBudget(orgId: string, now = Date.now()): boolean {
  const limit = orgBeaconPerMin();
  if (limit === 0) return true;
  const w = orgBeaconWindows.get(orgId);
  if (!w || now - w.windowStart >= 60_000) { orgBeaconWindows.set(orgId, { windowStart: now, count: 1 }); return true; }
  if (w.count >= limit) return false;
  w.count += 1; return true;
}
/** Test affordance — never routed. */
export function __resetOrgBeaconBudgetForTests(): void { orgBeaconWindows.clear(); }

export function registerAnalyticsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  // ADR 0419 — gate on the tenant's plan/bundle entitlement at the ONE authz choke
  // (the commerce precedent). No-op unless an operator narrows OPENWOP_BILLING_PLAN_FEATURES
  // with billing on; an active `crm`-bundle grant re-includes `analytics`.
  // NOTE: the ADR 0419 CENTRAL gate (`requireFeatureEnabled`, which authorizeOrgScope
  // calls) now ALSO enforces this — kept here as deliberate defense-in-depth on a
  // revenue path (a central-gate regression must not silently un-paywall), not churn.
  const authz = async (req: Request, scope: 'workspace:read') => {
    const ctx = await authorizeOrgScope(req, FEATURE, scope);
    await checkEntitlement(req, FEATURE.toggleId);
    return ctx;
  };

  // org → tenant, gated on the org-tenant's `analytics` toggle (uniform 404).
  const resolvePublicTenant = async (orgId: string): Promise<string> => {
    const notFound = (): never => { throw new OpenwopError('not_found', 'Not found.', 404, {}); };
    const org = await getOrg(orgId);
    if (!org) return notFound();
    const a = await resolveOne(FEATURE.toggleId, { tenantId: org.tenantId });
    if (!a || !a.enabled) return notFound();
    return org.tenantId;
  };

  // ───────────────────────── public beacon ───────────────────────────────────
  app.post(`${PUB}/:orgId/collect`, async (req, res, next) => {
    try {
      const tenantId = await resolvePublicTenant(req.params.orgId);
      // ANL-7 / ANL-19 — a per-ORG write budget. The per-IP limiter is the only
      // abuse control an unauthenticated beacon otherwise has, and the public
      // renderer is an assignment oracle (`vk` is client-chosen), so the honest
      // control on stamp/conversion flooding is a budget on the SITE, not the
      // caller. Per-instance fixed window, like the IP limiter; a 429 is fine to
      // reveal AFTER the org resolved (the uniform 404 covers unknown/toggle-off).
      if (!takeOrgBeaconBudget(req.params.orgId)) {
        res.status(429).set('Retry-After', '60').json({ error: 'rate_limited', message: 'analytics beacon budget for this site is exhausted; retry in a minute' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const subjectKey = typeof body.sessionKey === 'string' ? body.sessionKey : '';
      // Consent gate (ADR 0020) — the ONE helper; honest 202 when analytics is
      // not consented (no error, simply not recorded).
      let consented: boolean;
      try { consented = await isAllowed(tenantId, subjectKey, 'analytics'); }
      catch (err) { throw new OpenwopError('consent_unreadable', 'The consent store could not be read; the event was not recorded. Retry.', 503, { cause: String(err) }); } // ADR 0657 D5 — an outage is a 503, never a 500
      if (!consented) { res.status(202).json({ recorded: false, reason: 'consent' }); return; }
      // ADR 0569 — SERVER-computed cookieless visitor hash (daily-rotating
      // salt; raw IP/UA never persisted). Undefined when the tenant's
      // `analytics-visitor-identity` toggle is off ⇒ counts only.
      const visitorHash = await visitorHashFor(tenantId, req.params.orgId, req);
      const e = await recordEvent({ tenantId, orgId: req.params.orgId, raw: body, ...(visitorHash ? { visitorHash } : {}) });
      res.status(201).json({ recorded: true, eventId: e.eventId });
    } catch (err) { next(err); }
  });

  // ───────────────────────── authed reporting ────────────────────────────────
  app.get(`${ORG}/summary`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const days = windowDaysFor(req);
      // AN-G3 — the prior period of EQUAL length (e.g. days=30 → [-60d, -30d)),
      // so the page can say "+12% vs prior 30 days". All-time has no prior
      // period, so `comparison` is simply absent (additive; older clients and
      // the all-time window see the previous response shape exactly).
      // R2 AN-SP-4 — ONE indexed scan for both windows (was two full scans);
      // ANL-UX-2/4 — and for the org's lifetime facts, at no extra scan.
      const { summary, prior, lifetime } = await summarizeForReport(tenantId, orgId, days);
      res.json({
        summary,
        // ANL-UX-2 — the beacon-ever-recorded signal the page had to invent.
        // ADDITIVE and OMITTED when this org has never recorded anything, which
        // an older client simply ignores.
        ...(lifetime.firstEventAt ? { firstEventAt: lifetime.firstEventAt } : {}),
        // ANL-UX-2 R2 — the ABSENCE GUARD. The line above used to claim absence
        // means "never, not an old backend that did not send it" — but that is
        // only true from the SERVER's side. A client cannot tell the two apart
        // from an omitted field, so a NEW SPA against an OLDER backend (or a
        // stale cached summary) shows "analytics is not installed" to a tenant
        // with real history — the exact inverse of the claim ANL-UX-2 removed.
        // `lifetime` is therefore ALWAYS present on a backend that knows the
        // answer; its own absence is the "unknown" the client must not read as
        // "never". Same object the ANL-UX-3/4 fields come from.
        lifetime: {
          ...(lifetime.firstEventAt ? { firstEventAt: lifetime.firstEventAt } : {}),
          ...(lifetime.uniqueVisitorsSince ? { uniqueVisitorsSince: lifetime.uniqueVisitorsSince } : {}),
        },
        ...(days !== undefined && prior
          ? {
              comparison: {
                days,
                total: prior.total,
                sessions: prior.sessions,
                pageviews: prior.byType.pageview,
                conversions: prior.byType.conversion,
                // ANL-UX-3 — STILL conditional, deliberately: an absent prior
                // measurement must stay absent on the wire so the client can
                // tell "did not exist" from "measured zero". The defect was the
                // client coalescing it to 0, not the omission.
                ...(prior.uniqueVisitors !== undefined ? { uniqueVisitors: prior.uniqueVisitors } : {}),
              },
            }
          : {}),
      });
    }
    catch (err) { next(err); }
  });

  // R2 AN-R2-1 — the trend chart's aggregate. Windowed ONLY (the same
  // `?days=` allowlist as the summary); all-time has no meaningful buckets.
  app.get(`${ORG}/trend`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const days = windowDaysFor(req);
      if (days === undefined) throw new OpenwopError('validation_error', '`days` is required for the trend (7, 30, or 90).', 400, { field: 'days' });
      res.json({ trend: await trendForDays(tenantId, orgId, days) });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/events`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      // R2 AN-SP-5 — project internals out of the HTTP response the way the
      // workflow surface always has: `tenantId` is an implementation detail
      // (the caller IS the tenant), and eventId is a storage key.
      const rows = await listEvents(tenantId, orgId, 100, windowFor(req));
      // ANL-15 — project to the DECLARED client shape (`analyticsClient.ts`
      // `AnalyticsEvent`). Stripping only `tenantId` shipped `visitorHash`,
      // `clickIds` (cross-site ad identifiers), `owx` and the experiment stamp
      // to every `workspace:read` member — none rendered, all re-identifying.
      res.json({ events: rows.map((e) => ({
        eventId: e.eventId, orgId: e.orgId, type: e.type, ts: e.ts,
        ...(e.path !== undefined ? { path: e.path } : {}),
        ...(e.name !== undefined ? { name: e.name } : {}),
        ...(e.sessionKey !== undefined ? { sessionKey: e.sessionKey } : {}),
        ...(e.referrer !== undefined ? { referrer: e.referrer } : {}),
        ...(e.utm !== undefined ? { utm: e.utm } : {}),
        ...(e.props !== undefined ? { props: e.props } : {}),
      })) });
    }
    catch (err) { next(err); }
  });

  // ── ADR 0512 — workspace navigation telemetry (counts-only, tenant-scoped) ──
  // Sub-toggle gate per ADR 0404 §P4: BOTH `workspace-nav-telemetry` AND the
  // parent `analytics` toggle must resolve enabled for the caller's tenant;
  // uniform 404 otherwise (the surface does not exist when off). Any authed
  // member may record + read: the aggregate holds no individual data, and
  // member-visible reporting is part of the disclosure posture.
  const navEnabled = async (req: Request): Promise<string> => {
    const tenantId = req.tenantId;
    if (!tenantId || !req.principal) throw new OpenwopError('not_found', 'Not found.', 404, {});
    const sub = await resolveOne('workspace-nav-telemetry', { tenantId });
    const parent = await resolveOne('analytics', { tenantId });
    if (!sub?.enabled || !parent?.enabled) throw new OpenwopError('not_found', 'Not found.', 404, {});
    return tenantId;
  };

  app.post('/v1/host/openwop-app/analytics/nav', async (req, res, next) => {
    try {
      const tenantId = await navEnabled(req);
      const body = (req.body ?? {}) as { route?: unknown; source?: unknown };
      const result = await recordNav(tenantId, body.route, body.source);
      // Invalid/capped input is DROPPED, honestly labeled, never an error page
      // for a background beacon.
      res.status(202).json({ recorded: result === 'recorded', ...(result !== 'recorded' ? { reason: result } : {}) });
    } catch (err) { next(err); }
  });

  app.get('/v1/host/openwop-app/analytics/nav/report', async (req, res, next) => {
    try {
      const tenantId = await navEnabled(req);
      res.json(await navReport(tenantId));
    } catch (err) { next(err); }
  });
}
