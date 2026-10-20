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
import {
  listDomains, addDomain, removeDomain, verifyDomain, retryDomainEdge, domainStatus, forceRemoveDomain,
} from '../../host/customDomains.js';
import { loadEdgeConfig } from '../../host/edgeCertificates/index.js';

const FEATURE = { toggleId: 'custom-domains', label: 'Custom domains' };
const BASE = '/host/openwop-app/custom-domains/orgs/:orgId';

export function registerCustomDomainsRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(`${BASE}/domains`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      res.json({ domains: await listDomains(tenantId, orgId), edge: edgeSummary() });
    } catch (err) { next(err); }
  });

  // ADR 0906 P3 — one domain, its edge state refreshed when stale (≤ 1 provider read/min).
  app.get(`${BASE}/domains/:hostname/status`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const domain = await domainStatus(tenantId, orgId, req.params.hostname);
      if (!domain) throw new OpenwopError('not_found', 'Domain not found.', 404, {});
      res.json({ domain });
    } catch (err) { next(err); }
  });

  // ADR 0906 P3 — "Check again": re-issue a failed certificate, else advance. 429 within a minute.
  app.post(`${BASE}/domains/:hostname/retry`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const domain = await retryDomainEdge(tenantId, orgId, req.params.hostname);
      if (!domain) throw new OpenwopError('not_found', 'Domain not found.', 404, {});
      res.json({ domain });
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

  // ADR 0906 D4 — a domain with a certificate is released first: 202 while the
  // provider cleanup is still running (the sweep finishes it). `?force=1` is the
  // org-admin escape after repeated failed releases, audited.
  app.delete(`${BASE}/domains/:hostname`, async (req: Request, res: Response, next) => {
    try {
      if (req.query['force'] === '1') {
        const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'host:org:manage');
        const ok = await forceRemoveDomain(tenantId, orgId, req.params.hostname, user.userId);
        if (!ok) throw new OpenwopError('not_found', 'Domain not found.', 404, {});
        res.json({ ok: true, outcome: 'deleted' });
        return;
      }
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const outcome = await removeDomain(tenantId, orgId, req.params.hostname);
      if (outcome === 'not_found') throw new OpenwopError('not_found', 'Domain not found.', 404, {});
      res.status(outcome === 'deleted' ? 200 : 202).json({ ok: true, outcome });
    } catch (err) { next(err); }
  });
}

/**
 * What the domains page needs to know about the edge (ADR 0906 D10): which
 * provider, whether it is working, and the routing targets to show. Never
 * carries anything secret.
 */
function edgeSummary(): Record<string, unknown> {
  const cfg = loadEdgeConfig();
  if (cfg.provider === 'manual') return { provider: 'manual', ready: true };
  if (!('ready' in cfg) || !cfg.ready) return { provider: cfg.provider, ready: false, reason: 'reason' in cfg ? cfg.reason : '' };
  return {
    provider: cfg.provider,
    ready: true,
    ...(cfg.lbIp ? { lbIp: cfg.lbIp } : {}),
    ...(cfg.edgeHostname ? { edgeHostname: cfg.edgeHostname } : {}),
  };
}
