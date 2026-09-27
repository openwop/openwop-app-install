/**
 * Custom-domains routes (ADR 0295 / Funnel B). Authed operator surface under
 * `/v1/host/openwop-app/custom-domains/orgs/:orgId` (toggle + authorizeOrgScope;
 * tenant+org guarded in the host service). The HOST guard middleware and the
 * verification sweep are core-owned (`host/customDomains.ts`); this feature is
 * the management surface.
 */
import type { Request, Response } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { listDomains, addDomain, removeDomain, verifyDomain } from '../../host/customDomains.js';

const FEATURE = { toggleId: 'custom-domains', label: 'Custom domains' };
const BASE = '/v1/host/openwop-app/custom-domains/orgs/:orgId';

export function registerCustomDomainsRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(`${BASE}/domains`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      res.json({ domains: await listDomains(tenantId, orgId) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/domains`, async (req: Request, res: Response, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const domain = await addDomain({ tenantId, orgId, createdBy: user.userId, hostname: (req.body ?? {}).hostname });
      res.status(201).json({ domain });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/domains/:hostname/verify`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const domain = await verifyDomain(tenantId, orgId, req.params.hostname);
      if (!domain) throw new OpenwopError('not_found', 'Domain not found.', 404, {});
      res.json({ domain });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/domains/:hostname`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const ok = await removeDomain(tenantId, orgId, req.params.hostname);
      if (!ok) throw new OpenwopError('not_found', 'Domain not found.', 404, {});
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
}
