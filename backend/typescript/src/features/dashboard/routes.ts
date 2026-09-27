/**
 * Dashboard layout routes (host-extension, ADR 0375 Phase 1).
 *   GET  /v1/host/openwop-app/dashboard/layout  — the caller's own layout (or null)
 *   PUT  /v1/host/openwop-app/dashboard/layout  — upsert the caller's own layout
 *
 * SELF-SCOPED: the (tenant, subject) key is derived from the SESSION, never from
 * request input — IDOR-safe by construction (a caller can only ever name their
 * own row). Gated on the `dashboard` toggle + a resolvable acting subject. We do
 * NOT add an org-scope (`workspace:read/write`) check: the row is self-owned with
 * no cross-subject read path, so an org-RBAC gate would couple a personal
 * preference to org roles for no isolation gain (architect-reviewed deviation
 * from the ADR's read/write line).
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { tenantOf } from '../featureRoute.js';
import { getBriefingConfig, putBriefingConfig, getLayout, putLayout, MAX_TILES, type DashboardTileLayout, type TileSize, getNote, putNote, MAX_NOTE_CHARS } from './dashboardService.js';

const BASE = '/v1/host/openwop-app/dashboard';

/** The acting subject: the canonical acting-user id, else the session principal.
 *  Fail-closed — a request with neither has no self to scope to. */
function requireSubject(req: Request): string {
  const subject = req.userId ?? req.principal?.principalId;
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new OpenwopError('unauthenticated', 'A signed-in or session identity is required.', 401, {});
  }
  return subject;
}

/** Validate + normalize the PUT body's `tiles` (SHAPE only — tile-id validity
 *  against the registry is a frontend concern; the server stays registry-ignorant). */
function parseTiles(body: unknown): DashboardTileLayout[] {
  const raw = (body as { tiles?: unknown } | null)?.tiles;
  if (!Array.isArray(raw)) {
    throw new OpenwopError('validation_error', 'Field `tiles` is required and MUST be an array.', 400, { field: 'tiles' });
  }
  if (raw.length > MAX_TILES) {
    throw new OpenwopError('validation_error', `Too many tiles (max ${MAX_TILES}).`, 400, { field: 'tiles', max: MAX_TILES });
  }
  const seen = new Set<string>();
  return raw.map((t, i) => {
    const rec = t as Record<string, unknown>;
    const id = rec?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new OpenwopError('validation_error', `tiles[${i}].id must be a non-empty string.`, 400, { index: i });
    }
    if (seen.has(id)) {
      throw new OpenwopError('validation_error', `Duplicate tile id "${id}" — a layout is a set.`, 400, { id });
    }
    seen.add(id);
    if (typeof rec.order !== 'number' || !Number.isFinite(rec.order)) {
      throw new OpenwopError('validation_error', `tiles[${i}].order must be a finite number.`, 400, { index: i });
    }
    if (rec.size !== 'half' && rec.size !== 'full') {
      throw new OpenwopError('validation_error', `tiles[${i}].size must be "half" or "full".`, 400, { index: i });
    }
    if (typeof rec.enabled !== 'boolean') {
      throw new OpenwopError('validation_error', `tiles[${i}].enabled must be a boolean.`, 400, { index: i });
    }
    return { id, order: rec.order, size: rec.size as TileSize, enabled: rec.enabled };
  });
}

export function registerDashboardRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(`${BASE}/layout`, async (req, res, next) => {
    try {
      const subject = requireSubject(req);
      const layout = await getLayout(tenantOf(req), subject);
      res.status(200).json({ layout }); // { layout: null } ⇒ FE derives defaults
    } catch (err) {
      next(err);
    }
  });

  app.put(`${BASE}/layout`, async (req, res, next) => {
    try {
      const subject = requireSubject(req);
      const tiles = parseTiles(req.body);
      const layout = await putLayout(tenantOf(req), subject, tiles);
      res.status(200).json({ layout });
    } catch (err) {
      next(err);
    }
  });

  // ── Personal note (see dashboardService § Personal note) — same self-scoped
  //    contract as the layout: key from the session, never request input.
  app.get(`${BASE}/note`, async (req, res, next) => {
    try {
      const subject = requireSubject(req);
      const note = await getNote(tenantOf(req), subject);
      res.status(200).json({ note }); // { note: null } ⇒ nothing saved yet
    } catch (err) {
      next(err);
    }
  });

  // ── AI briefing tile config (ADR 0577) — same self-scoped contract as the
  //    note: key from the session, never request input. The config is a
  //    conversation POINTER; access to the conversation's content is enforced
  //    by the chat routes the tile reads through, not here.
  app.get(`${BASE}/briefing`, async (req, res, next) => {
    try {
      const subject = requireSubject(req);
      const config = await getBriefingConfig(tenantOf(req), subject);
      res.status(200).json({ config }); // { config: null } ⇒ not configured yet
    } catch (err) {
      next(err);
    }
  });

  app.put(`${BASE}/briefing`, async (req, res, next) => {
    try {
      const subject = requireSubject(req);
      const conversationId = (req.body as { conversationId?: unknown } | null)?.conversationId;
      if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 256) {
        throw new OpenwopError('validation_error', 'Field `conversationId` is required and MUST be a non-empty string (max 256 chars).', 400, { field: 'conversationId' });
      }
      const config = await putBriefingConfig(tenantOf(req), subject, conversationId);
      res.status(200).json({ config });
    } catch (err) {
      next(err);
    }
  });

  app.put(`${BASE}/note`, async (req, res, next) => {
    try {
      const subject = requireSubject(req);
      const text = (req.body as { text?: unknown } | null)?.text;
      if (typeof text !== 'string') {
        throw new OpenwopError('validation_error', 'Field `text` is required and MUST be a string.', 400, { field: 'text' });
      }
      if (text.length > MAX_NOTE_CHARS) {
        throw new OpenwopError('validation_error', `Note too long (max ${MAX_NOTE_CHARS} characters).`, 400, { field: 'text', max: MAX_NOTE_CHARS });
      }
      const note = await putNote(tenantOf(req), subject, text);
      res.status(200).json({ note });
    } catch (err) {
      next(err);
    }
  });
}
