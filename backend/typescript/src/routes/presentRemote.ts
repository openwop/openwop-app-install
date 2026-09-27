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
import { getCanvasForTenant } from '../host/canvasSurface.js';
import {
  presentOutlineFor,
  publishPresentNav,
  subscribePresentNav,
  verifyPresentRemoteToken,
  type PresentNavEvent,
} from '../host/presentRemote.js';

const notFound = (res: Response): void => {
  res.status(404).json({ error: 'not_found', message: 'unknown or expired present session' });
};

const ACTIONS = new Set(['next', 'prev', 'goto', 'blank']);

export function registerPresentRemoteRoutes(app: Express): void {
  app.get('/v1/host/openwop-app/present/:token/outline', async (req: Request, res: Response) => {
    const claims = verifyPresentRemoteToken(req.params.token ?? '');
    if (!claims) { notFound(res); return; }
    const canvas = await getCanvasForTenant(claims.tenantId, claims.canvasId);
    const outline = canvas ? presentOutlineFor(canvas.canvasTypeId, canvas.state as Record<string, unknown>) : null;
    if (!outline) { notFound(res); return; }
    res.json(outline);
  });

  app.post('/v1/host/openwop-app/present/:token/command', async (req: Request, res: Response) => {
    const claims = verifyPresentRemoteToken(req.params.token ?? '');
    if (!claims) { notFound(res); return; }
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

  app.post('/v1/host/openwop-app/present/:token/state', async (req: Request, res: Response) => {
    const claims = verifyPresentRemoteToken(req.params.token ?? '');
    if (!claims) { notFound(res); return; }
    const body = (req.body ?? {}) as { current?: unknown };
    if (typeof body.current !== 'number' || !Number.isInteger(body.current) || body.current < 0 || body.current > 10_000) {
      res.status(400).json({ error: 'validation_error', message: 'current must be an integer frame index' });
      return;
    }
    await publishPresentNav(claims, { kind: 'position', current: body.current });
    res.status(202).json({ ok: true });
  });

  app.get('/v1/host/openwop-app/present/:token/events', async (req: Request, res: Response, next) => {
    try {
      const claims = verifyPresentRemoteToken(req.params.token ?? '');
      if (!claims) { notFound(res); return; }
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
