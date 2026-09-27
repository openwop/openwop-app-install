/**
 * Sharing routes (ADR 0013). Two surfaces:
 *   - AUTHED  /v1/host/openwop-app/sharing/orgs/:orgId/links
 *       (requireOrgScope — GET workspace:read, POST/DELETE workspace:write)
 *   - PUBLIC  /v1/host/openwop-app/shared/:token  (NO auth — the unguessable token IS
 *       the credential; tenant from the link. SHARE-1 correction: this line used
 *       to say "gated on the link-tenant's `sharing` toggle", which has been
 *       false since ADR 0434 removed that toggle. What gates it is the token
 *       itself plus revocation, expiry, the org↔tenant binding, and — for the
 *       eight types whose owning feature declares one — that feature's toggle,
 *       resolved against the LINK's tenant. Four types have no owning toggle at
 *       all; see `sharingService.ts` `owningFeatureEnabled`.) The
 *       `/v1/host/openwop-app/shared` prefix is on PUBLIC_PATH_PREFIXES
 *       (auth.ts) — it does NOT shadow `…/sharing/*`.
 *
 * @see docs/adr/0013-sharing.md
 */

import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope, publicBaseUrl } from '../featureRoute.js';
import {
  createLink,
  listLinks,
  resolveShared,
  resolveSharedCard,
  revokeLink,
  recordSharedFrameView,
  listFrameViews,
} from './sharingService.js';

export function registerSharingRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // ── authed: link management ──
  const BASE = '/v1/host/openwop-app/sharing/orgs/:orgId/links';

  app.get(BASE, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      res.json({ links: await listLinks(tenantId, orgId) });
    } catch (err) { next(err); }
  });

  app.post(BASE, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const link = await createLink(tenantId, orgId, user.userId, body);
      res.status(201).json(link);
    } catch (err) { next(err); }
  });

  // ADR 0328 P7 — per-frame analytics for one link (owner surface).
  app.get(`${BASE}/:token/frame-views`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      res.json({ frames: await listFrameViews(tenantId, orgId, req.params.token) });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:token`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      await revokeLink(tenantId, orgId, req.params.token);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── public: resolve a share link (NO auth; token is the credential) ──
  app.get('/v1/host/openwop-app/shared/:token', async (req, res, next) => {
    try {
      res.json(await resolveShared(req.params.token));
    } catch (err) { next(err); }
  });

  // ADR 0328 P7 — the public viewer reports which frame was viewed (analytics;
  // the token is the credential; validation + uniform-404 in the service).
  app.post('/v1/host/openwop-app/shared/:token/frame-view', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { frame?: unknown };
      await recordSharedFrameView(req.params.token, body.frame);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.get('/v1/host/openwop-app/shared/:token/card', async (req, res, next) => {
    try {
      res.json(await resolveSharedCard(req.params.token, publicBaseUrl(req)));
    } catch (err) { next(err); }
  });
}
