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

import type { RequestHandler } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope, publicBaseUrl, toggleSubjectOf } from '../featureRoute.js';
import {
  createLink,
  listLinks,
  resolveShared,
  resolveSharedCard,
  revokeLink,
  adoptLink,
  recordSharedFrameView,
  listFrameViews,
  unlockLinkVerification,
  type ShareViewer,
} from './sharingService.js';
import { requestShareCode, verifyShareCode } from './recipientVerification.js';
import { clientIp } from '../../host/clientIp.js';
import { mintAnonSession, setAnonSessionCookie } from '../../middleware/cookieSession.js';
import { liveSessionSidOf } from '../../middleware/auth.js';

/** ADR 1141 D2 — the browser session a link's verification is bound to: the `sid`
 *  of the request's `__session` (signed-in or anonymous). The only cookie Firebase
 *  Hosting forwards on the `/api` rewrite, so a per-link cookie would never arrive.
 *  A bearer or API-key caller has none, and fails closed at the gate. */
async function viewerOf(req: Parameters<RequestHandler>[0]): Promise<ShareViewer> {
  // `/host/openwop-app/shared` is a public prefix the auth middleware does not
  // session; the live cookie session is resolved in middleware (ADR 0833 D1).
  const sid = await liveSessionSidOf(req);
  return sid ? { sid } : {};
}

/** ADR 0887 D4 — a capability-token response whose freshness IS the revocation
 *  mechanism must never be kept by a browser or an intermediary. Set before the
 *  handler, so 200, 404 and 410 all carry it. */
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
};

export function registerSharingRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // ── authed: link management ──
  const BASE = '/host/openwop-app/sharing/orgs/:orgId/links';

  app.get(BASE, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:read');
      res.json({ links: await listLinks(tenantId, orgId, user.userId) });
    } catch (err) { next(err); }
  });

  app.post(BASE, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const link = await createLink(tenantId, orgId, user.userId, body, { lane: 'member', subject: { ...toggleSubjectOf(req), tenantId } });
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

  // ADR 0887 D5 — adopt a link whose publisher lost access (keeps its URL).
  app.post(`${BASE}/:token/adopt`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      res.json(await adoptLink(tenantId, orgId, req.params.token, user.userId, { lane: 'member', subject: { ...toggleSubjectOf(req), tenantId } }));
    } catch (err) { next(err); }
  });

  // ADR 1141 D3 — the owner clears a link locked by five wrong codes.
  app.post(`${BASE}/:token/verification/unlock`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireOrgScope(req, 'workspace:write');
      await unlockLinkVerification(tenantId, orgId, req.params.token);
      res.status(204).end();
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
  app.get('/host/openwop-app/shared/:token', noStore, async (req, res, next) => {
    try {
      res.json(await resolveShared(req.params.token, await viewerOf(req)));
    } catch (err) { next(err); }
  });

  // ADR 0328 P7 — the public viewer reports which frame was viewed (analytics;
  // the token is the credential; validation + uniform-404 in the service).
  app.post('/host/openwop-app/shared/:token/frame-view', noStore, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { frame?: unknown };
      await recordSharedFrameView(req.params.token, body.frame, await viewerOf(req));
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.get('/host/openwop-app/shared/:token/card', noStore, async (req, res, next) => {
    try {
      res.json(await resolveSharedCard(req.params.token, publicBaseUrl(req), await viewerOf(req)));
    } catch (err) { next(err); }
  });

  // ── public: ADR 1141 — a recipient-bound link's one-time code ──
  // Both answer every token alike unless it is a live, bound link with a right code.
  app.post('/host/openwop-app/shared/:token/verification', noStore, async (req, res, next) => {
    try {
      await requestShareCode({ token: req.params.token, ip: clientIp(req) });
      res.status(202).json({});
    } catch (err) { next(err); }
  });

  app.post('/host/openwop-app/shared/:token/verification/verify', noStore, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { code?: unknown };
      // A visitor with no session gets an anonymous one, which the verification
      // then binds to. An existing session (signed in or not) is kept as it is.
      // A minted session is stateless (a signed cookie, no row), and its cookie is
      // set only AFTER a successful verify, so a refused attempt (wrong code, a
      // limiter refusal, any token) leaves the caller nothing. The send and verify
      // limits per IP bound the work either way.
      const existing = (await viewerOf(req)).sid;
      const fresh = existing ? undefined : mintAnonSession();
      await verifyShareCode({ token: req.params.token, code: body.code, sid: existing ?? fresh!.sid, ip: clientIp(req) });
      if (fresh) setAnonSessionCookie(res, fresh); // ADR 0833 D2: signed by the session module, minted by its builder
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
