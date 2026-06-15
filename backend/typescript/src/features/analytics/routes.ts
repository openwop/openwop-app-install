/**
 * Analytics feature routes (host-extension, ADR 0018).
 *   Public beacon (unauthed):  POST /v1/host/openwop-app/public-analytics/:orgId/collect
 *   Authed (org-scoped, RBAC):  GET  /v1/host/openwop-app/analytics/orgs/:orgId/{summary,events}
 * The public prefix is on PUBLIC_PATH_PREFIXES (auth.ts). The beacon is
 * consent-gated through the ADR 0020 helper (one consent rule) and relies on the
 * global per-IP rate-limit middleware for abuse control.
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getOrg } from '../../host/accessControlService.js';
import { isAllowed } from '../consent/consentService.js';
import { recordEvent, listEvents, summarize } from './analyticsService.js';

const FEATURE = { toggleId: 'analytics', label: 'Analytics' };
const ORG = '/v1/host/openwop-app/analytics/orgs/:orgId';
const PUB = '/v1/host/openwop-app/public-analytics';

export function registerAnalyticsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: 'workspace:read') => authorizeOrgScope(req, FEATURE, scope);

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
      const body = (req.body ?? {}) as Record<string, unknown>;
      const subjectKey = typeof body.sessionKey === 'string' ? body.sessionKey : '';
      // Consent gate (ADR 0020) — the ONE helper; honest 202 when analytics is
      // not consented (no error, simply not recorded).
      if (!(await isAllowed(tenantId, subjectKey, 'analytics'))) { res.status(202).json({ recorded: false, reason: 'consent' }); return; }
      const e = await recordEvent({ tenantId, orgId: req.params.orgId, raw: body });
      res.status(201).json({ recorded: true, eventId: e.eventId });
    } catch (err) { next(err); }
  });

  // ───────────────────────── authed reporting ────────────────────────────────
  app.get(`${ORG}/summary`, async (req, res, next) => {
    try { const { user, orgId } = await authz(req, 'workspace:read'); res.json({ summary: await summarize(user.tenantId, orgId) }); }
    catch (err) { next(err); }
  });

  app.get(`${ORG}/events`, async (req, res, next) => {
    try { const { user, orgId } = await authz(req, 'workspace:read'); res.json({ events: await listEvents(user.tenantId, orgId, 100) }); }
    catch (err) { next(err); }
  });
}
