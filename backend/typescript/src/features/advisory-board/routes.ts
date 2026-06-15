/**
 * Board of Advisors routes (ADR 0040) — host-extension under
 * /v1/host/openwop-app/advisors/* (NOT /boards/* — that namespace is owned by
 * host.kanban; ADR 0040 § "Boundaries").
 *
 * Gating order, fail-closed:
 *   1. toggle `advisory-board` ON for the caller   (requireFeatureEnabled)
 *   2. RBAC — workspace:read (list/get/convene/session) /
 *      workspace:write (create), + owner check in the service (update/delete)
 *   3. visibility — a `private` board the caller doesn't own 404s (service)
 *
 * @see docs/adr/0040-board-of-advisors.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { getUser } from '../users/usersService.js';
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import {
  listBoards, getBoardView, createBoard, updateBoard, deleteBoard, getSession, convene,
} from './service.js';

const TOGGLE_ID = 'advisory-board';
const LABEL = 'Board of Advisors';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

async function requireTenantScope(req: Request, scope: Scope): Promise<void> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req) });
  if (!access.scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  }
}

async function requireOrgScopeFor(req: Request, orgId: string, scope: Scope): Promise<void> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  if (!access.scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}

/** The acting user's display name for the scaffold (tenant-scoped, fail-soft). */
async function userNameOf(req: Request): Promise<string | null> {
  const uid = actingUserOf(req);
  if (!uid) return null;
  try {
    const u = await getUser(uid);
    if (!u || (u.tenantId && u.tenantId !== tenantOf(req))) return null;
    const name = u.displayName?.trim();
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

export function registerAdvisoryBoardRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/advisors';

  // ── list boards (visible to the caller) ──
  app.get(`${BASE}/boards`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireTenantScope(req, 'workspace:read');
      res.json({ boards: await listBoards(tenantOf(req), actingUserOf(req)) });
    } catch (err) { next(err); }
  });

  // ── create a board (org-scoped) ──
  app.post(`${BASE}/boards`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString((req.body ?? {})?.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const board = await createBoard(tenantOf(req), orgId, actingUserOf(req) ?? 'unknown', req.body ?? {});
      res.status(201).json(board);
    } catch (err) { next(err); }
  });

  // ── get one board ──
  app.get(`${BASE}/boards/:boardId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireTenantScope(req, 'workspace:read');
      res.json(await getBoardView(tenantOf(req), actingUserOf(req), req.params.boardId));
    } catch (err) { next(err); }
  });

  // ── update a board (owner-only, enforced in the service) ──
  app.patch(`${BASE}/boards/:boardId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireTenantScope(req, 'workspace:write');
      res.json(await updateBoard(tenantOf(req), actingUserOf(req), req.params.boardId, req.body ?? {}));
    } catch (err) { next(err); }
  });

  // ── delete a board (owner-only) ──
  app.delete(`${BASE}/boards/:boardId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireTenantScope(req, 'workspace:write');
      await deleteBoard(tenantOf(req), actingUserOf(req), req.params.boardId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── convene: run a council round (the `@@` summon) ──
  app.post(`${BASE}/boards/:boardId/convene`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireTenantScope(req, 'workspace:read');
      const session = await convene(
        tenantOf(req),
        actingUserOf(req),
        await userNameOf(req),
        req.params.boardId,
        req.body ?? {},
      );
      res.status(201).json(session);
    } catch (err) { next(err); }
  });

  // ── read a council session transcript ──
  app.get(`${BASE}/boards/:boardId/sessions/:sessionId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireTenantScope(req, 'workspace:read');
      res.json(await getSession(tenantOf(req), actingUserOf(req), req.params.boardId, req.params.sessionId));
    } catch (err) { next(err); }
  });
}
