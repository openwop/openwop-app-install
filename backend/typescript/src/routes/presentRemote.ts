/**
 * Present-remote public routes (ADR 0328 Phase 4 / research C3) — the phone
 * controller's surface. Token-authed (the stateless HMAC capability IS the
 * credential, like /assets/:token); every failure is a uniform 404 so the
 * endpoints neither confirm canvas ids nor distinguish expiry from forgery.
 *
 *   GET  /v1/host/openwop-app/present/:token/outline   → { title, frames, current? }
 *   POST /v1/host/openwop-app/present/:token/command   { action, index? }
 *   POST /v1/host/openwop-app/present/:token/state     { current }   (presenter)
 *   GET  /v1/host/openwop-app/present/:token/events    → SSE nav feed
 *
 * The mint route lives in the canvas-editor factory (authed, per canvas type);
 * everything here is reachable with the token alone.
 */

import type { Express, Request, Response } from 'express';
import { openSseChannel } from '../host/sseChannel.js';
import { canvasWriteAllowed, getCanvasForTenant, type CanvasRecordView } from '../host/canvasSurface.js';
import { resolveCanvasTypeAccess } from '../host/canvasTypeOwnership.js';
import { assertOrgScope } from '../host/accessControlService.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('routes.presentRemote');
import {
  presentOutlineFor,
  publishPresentNav,
  subscribePresentNav,
  verifyPresentRemoteToken,
  type PresentNavEvent,
  type PresentRemoteClaims,
} from '../host/presentRemote.js';

/**
 * ADR 0886 D3 — THE present-remote authorization, run by all four public routes.
 * The token proves who minted it and where; it is not, on its own, a grant. A
 * request is served only while every fact the MINT checked is still true:
 *   1. signature + expiry (v2 claims: tenant, canvas, minter, org);
 *   2. the canvas exists, its type has a present mode;
 *   3. the type's owning feature is enabled for the tenant (toggle + plan);
 *   4. the minter still passes the mint's own org gate — `assertOrgScope` with the
 *      signed org, the exact call `requireOrgScope` made — so a token is never
 *      valid at mint and dead at first use, or the reverse;
 *   5. the minter may still WRITE the canvas (`canvasWriteAllowed`, ADR 0886 D1).
 * Any failure is the uniform 404 (no canvas-id confirmation, no expiry/forgery
 * distinction).
 */
async function authorizePresentRemote(token: string): Promise<{ claims: PresentRemoteClaims; canvas: CanvasRecordView } | null> {
  const claims = verifyPresentRemoteToken(token);
  if (!claims) return null; // verify logs its own reason
  // SL2CD-6 — each refusal names its cause for the operator (never the caller:
  // the response stays the uniform 404).
  const refused = (reason: string): null => { log.info('present_remote_refused', { reason, canvasId: claims.canvasId }); return null; };
  const canvas = await getCanvasForTenant(claims.tenantId, claims.canvasId);
  if (!canvas) return refused('canvas_gone');
  if (!presentOutlineFor(canvas.canvasTypeId, canvas.state as Record<string, unknown>)) return refused('no_present_mode');
  const access = await resolveCanvasTypeAccess(canvas.canvasTypeId, { tenantId: claims.tenantId, userId: claims.userId });
  if (!access.allowed) return refused('feature_off');
  try {
    await assertOrgScope(claims.tenantId, claims.userId, claims.orgId, 'workspace:write');
  } catch {
    return refused('minter_lost_org_write');
  }
  if (!(await canvasWriteAllowed(claims.tenantId, canvas, { subject: claims.userId }))) return refused('minter_lost_canvas_write');
  return { claims, canvas };
}

const notFound = (res: Response): void => {
  res.status(404).json({ error: 'not_found', message: 'unknown or expired present session' });
};

const ACTIONS = new Set(['next', 'prev', 'goto', 'blank']);

export function registerPresentRemoteRoutes(app: Express): void {
  app.get('/host/openwop-app/present/:token/outline', async (req: Request, res: Response) => {
    const auth = await authorizePresentRemote(req.params.token ?? '');
    if (!auth) { notFound(res); return; }
    res.json(presentOutlineFor(auth.canvas.canvasTypeId, auth.canvas.state as Record<string, unknown>));
  });

  app.post('/host/openwop-app/present/:token/command', async (req: Request, res: Response) => {
    const auth = await authorizePresentRemote(req.params.token ?? '');
    if (!auth) { notFound(res); return; }
    const { claims } = auth;
    const body = (req.body ?? {}) as { action?: unknown; index?: unknown };
    if (typeof body.action !== 'string' || !ACTIONS.has(body.action)) {
      res.status(400).json({ error: 'validation_error', message: `action must be one of: ${[...ACTIONS].join(', ')}` });
      return;
    }
    const ev: PresentNavEvent = { kind: 'command', action: body.action as PresentNavEvent['action'] };
    if (body.action === 'goto') {
      if (typeof body.index !== 'number' || !Number.isInteger(body.index) || body.index < 0 || body.index > 10_000) {
        res.status(400).json({ error: 'validation_error', message: 'goto requires an integer index' });
        return;
      }
      ev.index = body.index;
    }
    await publishPresentNav(claims, ev);
    res.status(202).json({ ok: true });
  });

  app.post('/host/openwop-app/present/:token/state', async (req: Request, res: Response) => {
    const auth = await authorizePresentRemote(req.params.token ?? '');
    if (!auth) { notFound(res); return; }
    const { claims } = auth;
    const body = (req.body ?? {}) as { current?: unknown };
    if (typeof body.current !== 'number' || !Number.isInteger(body.current) || body.current < 0 || body.current > 10_000) {
      res.status(400).json({ error: 'validation_error', message: 'current must be an integer frame index' });
      return;
    }
    await publishPresentNav(claims, { kind: 'position', current: body.current });
    res.status(202).json({ ok: true });
  });

  app.get('/host/openwop-app/present/:token/events', async (req: Request, res: Response, next) => {
    try {
      // Checked at CONNECT (ADR 0886 D3). The stream carries frame indices only,
      // never deck content; one already open when access is lost runs until it
      // closes (ADR 0886 OQ-3).
      const auth = await authorizePresentRemote(req.params.token ?? '');
      if (!auth) { notFound(res); return; }
      const { claims } = auth;
      // The stream cap keys off the request (authed presenter → tenant bucket;
      // the anon phone → source-IP bucket) — the sseChannel convention.
      const channel = openSseChannel(req, res);
      // Grade pass 2026-07-10 (B3): register teardown BEFORE the awaited
      // subscribe — a client that disconnects DURING the await would otherwise
      // fire the channel's close with no unsubscribe registered (a bus
      // subscription leaked per phone reconnect). The indirection covers both
      // orders; a subscribe FAILURE must close() the channel itself (headers
      // are already flushed, so next(err) can't produce a response, and the
      // cap slot + heartbeat would otherwise linger until socket death).
      let unsubscribe: (() => Promise<void>) | null = null;
      channel.onClose(() => { if (unsubscribe) void unsubscribe(); });
      try {
        unsubscribe = await subscribePresentNav(claims, (ev) => {
          if (channel.closed) return;
          res.write('event: nav\n');
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        });
      } catch {
        channel.close();
        return;
      }
      // Client left mid-subscribe: onClose already ran with unsubscribe null.
      if (channel.closed) { void unsubscribe(); }
    } catch (err) { next(err); }
  });
}
