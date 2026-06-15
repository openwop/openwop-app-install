/**
 * Sharing routes (ADR 0013). Two surfaces:
 *   - AUTHED  /v1/host/openwop-app/sharing/orgs/:orgId/links
 *       (authorizeOrgScope — GET workspace:read, POST/DELETE workspace:write)
 *   - PUBLIC  /v1/host/openwop-app/shared/:token  (NO auth — the unguessable token IS
 *       the credential; tenant from the link, gated on the link-tenant's
 *       `sharing` toggle). The `/v1/host/openwop-app/shared` prefix is on
 *       PUBLIC_PATH_PREFIXES (auth.ts) — it does NOT shadow `…/sharing/*`.
 *
 * @see docs/adr/0013-sharing.md
 */

import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, publicBaseUrl } from '../featureRoute.js';
import {
  createLink,
  listLinks,
  resolveShared,
  resolveSharedCard,
  revokeLink,
} from './sharingService.js';

const FEATURE = { toggleId: 'sharing', label: 'Sharing' };

export function registerSharingRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // ── authed: link management ──
  const BASE = '/v1/host/openwop-app/sharing/orgs/:orgId/links';

  app.get(BASE, async (req, res, next) => {
    try {
      const { user, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      res.json({ links: await listLinks(user.tenantId, orgId) });
    } catch (err) { next(err); }
  });

  app.post(BASE, async (req, res, next) => {
    try {
      const { user, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const link = await createLink(user.tenantId, orgId, user.userId, body);
      res.status(201).json(link);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:token`, async (req, res, next) => {
    try {
      const { user, orgId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      await revokeLink(user.tenantId, orgId, req.params.token);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── public: resolve a share link (NO auth; token is the credential) ──
  app.get('/v1/host/openwop-app/shared/:token', async (req, res, next) => {
    try {
      res.json(await resolveShared(req.params.token));
    } catch (err) { next(err); }
  });

  app.get('/v1/host/openwop-app/shared/:token/card', async (req, res, next) => {
    try {
      res.json(await resolveSharedCard(req.params.token, publicBaseUrl(req)));
    } catch (err) { next(err); }
  });
}
