/**
 * Model-router config routes (ADR 0130 Phase 2) — authed, org-scoped.
 * `/v1/host/openwop-app/model-router/orgs/:orgId/config` (GET/PUT) + `/enable`.
 * The dispatch stage (Phase 3) reads this; toggle gates it.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope } from '../featureRoute.js';
import { getRouterConfig, setRouterConfig, setRouterEnabled } from './configService.js';


export function registerModelRouterRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/model-router/orgs/:orgId/config';

  app.get(BASE, async (req, res, next) => {
    try { const { user, orgId } = await requireOrgScope(req, 'workspace:read'); res.json({ config: await getRouterConfig(user.tenantId, orgId) }); } catch (err) { next(err); }
  });
  app.put(BASE, async (req, res, next) => {
    try { const { user, orgId } = await requireOrgScope(req, 'workspace:write'); res.json({ config: await setRouterConfig(user.tenantId, orgId, user.userId, req.body) }); } catch (err) { next(err); }
  });
  app.post(`${BASE}/enable`, async (req, res, next) => {
    try { const { user, orgId } = await requireOrgScope(req, 'workspace:write'); const enabled = (req.body as { enabled?: unknown })?.enabled !== false; res.json({ config: await setRouterEnabled(user.tenantId, orgId, user.userId, enabled) }); } catch (err) { next(err); }
  });
}
