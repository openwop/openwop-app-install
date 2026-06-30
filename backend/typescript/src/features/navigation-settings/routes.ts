/**
 * ADR 0139 — navigation-settings routes (host-extension, non-normative).
 *
 *   GET    /v1/host/openwop-app/menu-config         → { tenant, user }
 *   PUT    /v1/host/openwop-app/menu-config/tenant  → set the shared default (superadmin)
 *   PUT    /v1/host/openwop-app/menu-config/me      → set the caller's personalization
 *
 * The tenant layer is the workspace-wide default a superadmin curates (keyed by
 * the caller's tenant — `tenantOf(req)`; it needs no resolved *user*, so it works
 * for both a superadmin user and the admin bearer). The `me` layer is the caller's
 * own arrangement (needs a resolved user). GET returns both, and is open to any
 * authenticated principal (a signed-in user OR a superadmin bearer) — never to an
 * anonymous caller. Tenant isolation is structural: every key embeds the tenant.
 *
 * @see docs/adr/0139-configurable-navigation-menu.md
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { tenantOf } from '../featureRoute.js';
import { isSuperadmin, requireSuperadmin } from '../../host/superadmin.js';
import { OpenwopError } from '../../types.js';
import type { User } from '../users/usersService.js';
import { getBundle, getTenantBundle, putTenantConfig, putUserConfig, tenantConfigVersion, validateMenuConfig } from './service.js';

/** Resolve the caller's user, or null when there is no user identity (e.g. the
 *  superadmin bearer). Never throws for the no-user case. */
async function tryResolveUser(req: Request): Promise<User | null> {
  try {
    return await resolveCallerUser(req);
  } catch {
    return null;
  }
}

export function registerNavigationSettingsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/menu-config';

  app.get(BASE, async (req, res, next) => {
    try {
      const user = await tryResolveUser(req);
      if (!user && !isSuperadmin(req)) {
        throw new OpenwopError('sign_in_required', 'Sign in to read the menu configuration.', 401, {});
      }
      const layerTenant = user?.tenantId ?? tenantOf(req);
      // CHN-6: expose the tenant-layer version as an ETag so an editor can round-trip
      // it via If-Match on the next PUT (optimistic concurrency).
      res.setHeader('ETag', JSON.stringify(await tenantConfigVersion(layerTenant)));
      if (user) {
        res.json(await getBundle(user.tenantId, user.userId));
      } else {
        // Superadmin bearer with no user identity — the tenant layer only.
        res.json(await getTenantBundle(tenantOf(req)));
      }
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/tenant`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Editing the workspace default menu layout');
      const config = validateMenuConfig((req.body as { config?: unknown })?.config);
      // Key by the SAME tenant the GET reads (the resolved user's tenant) so a
      // superadmin's save is read back by their own GET; fall back to tenantOf()
      // only for the user-less superadmin bearer (which GETs via getTenantBundle).
      const user = await tryResolveUser(req);
      const tenantId = user?.tenantId ?? tenantOf(req);
      // CHN-6: honor an optional If-Match (the ETag from GET) for optimistic concurrency.
      // Absent → legacy last-writer-wins; present → a stale/racing write is 409'd.
      const ifMatch = req.header('If-Match');
      const expectedVersion = ifMatch === undefined ? undefined : ifMatch.replace(/^"|"$/g, '');
      const version = await putTenantConfig(tenantId, user?.userId ?? 'superadmin', config, expectedVersion);
      res.setHeader('ETag', JSON.stringify(version));
      res.json({ config });
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/me`, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const config = validateMenuConfig((req.body as { config?: unknown })?.config);
      await putUserConfig(user.tenantId, user.userId, config);
      res.json({ config });
    } catch (err) { next(err); }
  });
}
