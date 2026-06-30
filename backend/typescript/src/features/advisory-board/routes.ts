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
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import { getBoardSharedKnowledge, setBoardSharedKnowledge, isSharedKbKind, sharedKbKinds } from './advisoryBoardKnowledgeService.js';
import { registerBoardContextResolver } from '../../host/boardContextResolver.js';
import {
  listBoards, getBoardView, getBoardByHandle, createBoard, updateBoard, deleteBoard,
  resolveBoardStrategyContext, previewBoardStrategyContext,
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


export function registerAdvisoryBoardRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/advisors';

  // ADR 0079 Phase 5 — register the board-context resolver into the core seam so
  // a boardroom snapshots its strategy context at `@@` summon (feature→core only).
  registerBoardContextResolver(resolveBoardStrategyContext);

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

  // ── preview the board's strategy context (ADR 0079 Phase 5 — "before convening") ──
  app.get(`${BASE}/boards/:boardId/strategy-context`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireTenantScope(req, 'workspace:read');
      res.json({ strategies: await previewBoardStrategyContext(tenantOf(req), actingUserOf(req), req.params.boardId) });
    } catch (err) { next(err); }
  });

  // ── shared knowledge (ADR 0100 D2): bind a managed planning KB to all advisors ──
  app.get(`${BASE}/boards/:boardId/shared-knowledge`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const board = await getBoardView(tenantOf(req), actingUserOf(req), req.params.boardId);
      // CHATP-2: read/write authz symmetry — the POST gates on `workspace:write`
      // for the board's org; the GET must likewise require at least `workspace:read`
      // org scope (not only board-access) so share STATUS isn't readable by a board
      // member who lacks org scope.
      await requireOrgScopeFor(req, board.orgId, 'workspace:read');
      res.json({ items: await getBoardSharedKnowledge(tenantOf(req), board) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/boards/:boardId/shared-knowledge`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const board = await getBoardView(tenantOf(req), actingUserOf(req), req.params.boardId);
      await requireOrgScopeFor(req, board.orgId, 'workspace:write');
      const body = (req.body ?? {}) as { kind?: unknown; shared?: unknown };
      if (!isSharedKbKind(body.kind)) {
        throw new OpenwopError('validation_error', `Field \`kind\` must be one of: ${sharedKbKinds().join(', ')}.`, 400, { field: 'kind' });
      }
      await setBoardSharedKnowledge(tenantOf(req), board, body.kind, body.shared === true, actingUserOf(req) ?? 'unknown');
      res.json({ items: await getBoardSharedKnowledge(tenantOf(req), board) });
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

  // ── resolve a board by its `@@<handle>` summon token (for the AI chat) ──
  // The chat expands the returned cohort into the active-agents lineup; the
  // conversation runs on the existing chat.turn infra (ADR 0040 § Correction).
  app.get(`${BASE}/boards/by-handle/:handle`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireTenantScope(req, 'workspace:read');
      res.json(await getBoardByHandle(tenantOf(req), actingUserOf(req), req.params.handle));
    } catch (err) { next(err); }
  });
}
