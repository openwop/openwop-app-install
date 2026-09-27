/**
 * Dynamic Sales Maps — REST routes (ADR 0282).
 *
 * P2: POST …/sales-maps/orgs/:orgId/geocode — resolve (and cache) an address to a
 * point. `workspace:write` because a genuine miss spends a BYOK provider call
 * (ADR 0024). Manual lat/lng + cache hits need no provider. Rides the global per-IP
 * rate limit; the address payload is bounded.
 *
 * @see docs/adr/0282-dynamic-sales-maps.md
 */

import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import type { Scope } from '../../host/accessControlService.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { geocode } from './entities/geocode.js';

const TOGGLE_ID = 'sales-maps';
const LABEL = 'Sales Maps';
const authorize = (req: Request, scope: Scope) => authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, scope);

export function registerSalesMapsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/sales-maps/orgs/:orgId';

  app.post(`${BASE}/geocode`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:write');
      const body = (req.body ?? {}) as { address?: unknown; lat?: unknown; lng?: unknown };
      const result = await geocode(tenantId, orgId, body);
      res.json({ address: result.address, lat: result.lat, lng: result.lng, source: result.source });
    } catch (err) { next(err); }
  });
}
