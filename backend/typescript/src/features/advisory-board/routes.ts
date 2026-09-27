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
import { createLogger } from '../../observability/logger.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import { getBoardSharedKnowledge, setBoardSharedKnowledge, isSharedKbKind, sharedKbKinds } from './advisoryBoardKnowledgeService.js';
import { registerBoardContextResolver, registerBoardCohortResolver, registerBoardConveneGate, resolveBoardContextResult } from '../../host/boardContextResolver.js';
import {
  listBoards, getBoardView, getBoardByHandle, createBoard, updateBoard, deleteBoard,
  resolveBoardStrategyContext, previewBoardStrategyContext, recordSharedKbKind, boardSubject,
  boardCohortAgentRefs, resolveBoardCohortForCaller, assertBoardConvenable, boardConveneRefusal,
} from './service.js';
import { subjectConversationId, ensureConversationMeta, markAsBoardGroup, getConversationMeta, removeParticipant, refreshEntityChatTitle } from '../../host/conversationStore.js';
import { isSuperadmin } from '../../host/superadmin.js';

const log = createLogger('features.advisory-board.routes');

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
  const { app, storage } = deps;
  const BASE = '/v1/host/openwop-app/advisors';

  // ADR 0079 Phase 5 — register the board-context resolver into the core seam so
  // a boardroom snapshots its strategy context at `@@` summon (feature→core only).
  registerBoardContextResolver(resolveBoardStrategyContext);
  // WF-BOA-3 — the board-read gate + server-derived speak-set for core's
  // `@@`-summon attach lane. Same seam direction (feature→core only).
  registerBoardCohortResolver(resolveBoardCohortForCaller);
  // H1 / ADR 0588 D5 — the likeness gate on the TURN path. Registered here beside
  // its siblings so "the gate is unregistered" can only ever mean "no board
  // feature is mounted", never "this lane forgot".
  registerBoardConveneGate(boardConveneRefusal);

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
      const { ids } = await setBoardSharedKnowledge(tenantOf(req), board, body.kind, body.shared === true, actingUserOf(req) ?? 'unknown');
      // ADR 0277 P2 — persist the toggle as stored intent (the source of truth
      // cohort reconciliation works from), then report from the fresh board.
      // A share that bound NOTHING (e.g. only a private project — the
      // visibility carve-out) records no intent; an unshare always clears it.
      if (!body.shared || ids.length > 0) {
        await recordSharedKbKind(tenantOf(req), board.boardId, body.kind, body.shared === true);
      }
      const fresh = await getBoardView(tenantOf(req), actingUserOf(req), req.params.boardId);
      res.json({ items: await getBoardSharedKnowledge(tenantOf(req), fresh) });
    } catch (err) { next(err); }
  });

  // ── ADR 0278 — the CANONICAL board conversation (ensure-or-reuse + join) ──
  // One `type:'group'` conversation per board, deterministic id, bound via
  // `ownerSubject: board:<id>` (the ADR 0054 D5 subject-access join gate: any
  // org member with resolved read opens the SAME chat — no per-summon instance
  // proliferation). The project chat (ADR 0054 D3) is the exact precedent.
  app.post(`${BASE}/boards/:boardId/chat`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const tenantId = tenantOf(req);
      const userId = actingUserOf(req);
      // Board READ access (creator or shared visibility — getBoardView 404s
      // strangers with no existence leak).
      const board = await getBoardView(tenantId, userId, req.params.boardId);
      // GRADE-5 — org-scope gate (the CHATP-2 read/write symmetry rule): board
      // visibility alone admits any tenant caller to a `shared` board, but a
      // zero-role co-tenant could then MUTATE (create/stamp the canonical
      // session) via a route every read sibling would 403. Same gate as the
      // sibling reads; matches `resolveBoardAccess`'s read floor.
      await requireOrgScopeFor(req, board.orgId, 'workspace:read');
      // ADR 0588 D5 — the likeness gate `types.ts` has promised since ADR 0040
      // and nothing enforced. A `living` board with no acknowledgement cannot
      // open its room; the owner's edit dialog is the exit.
      assertBoardConvenable(board);
      const sessionId = subjectConversationId(tenantId, boardSubject(board.boardId));
      // Cohort → agent participants: the roster ids map to their chat-callable
      // agent projections (`agent:<agentRef.agentId>` — the SAME refs the `@@`
      // summon stamps, so RFC 0101 roster enforcement matches dispatched ids).
      const agentRefs = await boardCohortAgentRefs(tenantId, board);
      // ADV-UX-9 — a degraded re-snapshot was logged server-side ONLY, so the
      // person opening the room was never told their planning context is stale.
      // Reported on the response so the SPA can say so.
      let contextDegraded = false;
      const ts = new Date().toISOString();
      let created = true;
      try {
        await storage.createChatSession({ sessionId, tenantId, title: `${board.name} · board`, createdAt: ts, updatedAt: ts, messageCount: 0 });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'SQLITE_CONSTRAINT_PRIMARYKEY' && code !== '23505') throw err; // already exists ⇒ reuse
        created = false;
        // GRADE-9/D7 — a board rename previously left the rail title stale
        // forever (title-source-guarded shared helper; projects use it too).
        await refreshEntityChatTitle(storage, tenantId, sessionId, `${board.name} · board`);
      }
      // GRADE-6 — the opener becomes owner ONLY at creation. Passing every
      // opener as owner churned `ownerUserId` to "whoever clicked last" and
      // accumulated irremovable owner-role participants ("People are NOT
      // participants" — this route's own rule).
      const priorMeta = await getConversationMeta(tenantId, sessionId);
      const ownerForStamp = priorMeta ? undefined : userId;
      await ensureConversationMeta(tenantId, sessionId, {
        type: 'group',
        ...(ownerForStamp ? { ownerUserId: ownerForStamp } : {}),
        ownerSubject: boardSubject(board.boardId),
        participants: agentRefs,
      });
      // GRADE-8, CORRECTED by ADVB-1 — this narrowing is NOT the confidentiality
      // control it used to claim to be, and saying so was the bug: org
      // `workspace:write` is not the same predicate as `canSubjectReadStrategy` /
      // `resolveProjectAccess`, so it misses exactly where they diverge (a
      // `scope:'user'` strategy; a `private` project the reader isn't a member
      // of). A curator's render was persisted and then served verbatim to every
      // later reader of this SHARED conversation. The confidentiality control now
      // lives where it belongs — `host/chatContext.ts` re-resolves the block for
      // the CALLER on every turn and never reads this snapshot.
      //
      // What the narrowing still buys, and all it claims now: only a curator may
      // UPDATE the durable provenance record of "what this room was told", so a
      // narrow reader's open cannot silently downgrade it.
      const openerScopes = await resolveEffectiveAccess(tenantId, { subject: userId, orgId: board.orgId });
      const canCurate = openerScopes.scopes.includes('workspace:write');
      // WF-BOA-2 — `undefined ⇒ keep`, `null ⇒ clear`. A FAILED resolve keeps
      // (a transient strategy-read failure must never wipe the record); an
      // honest EMPTY clears (dropping every contextRef must actually clear it —
      // the symmetric half, which `block ?? undefined` used to swallow).
      let snapshot: string | null | undefined;
      if (!canCurate) snapshot = undefined;
      else {
        const ctx = await resolveBoardContextResult(tenantId, board.boardId, userId);
        if (ctx.failed) {
          // R3 — the curator's re-snapshot silently not happening was invisible.
          // Same semantics, disclosed. ADV-UX-9: also reported to the opener below.
          log.warn('strategy_context_resnapshot_degraded', { boardId: board.boardId });
          snapshot = undefined;
        } else snapshot = ctx.block;
        contextDegraded = ctx.failed;
      }
      // GRADE-7 — re-ASSERT ownerSubject on every stamp (not just preserve):
      // a summon racing an open could rebuild the meta without it, silently
      // downgrading the shared room to the legacy owner gate forever.
      await markAsBoardGroup(tenantId, sessionId, board.boardId, agentRefs, ownerForStamp, undefined, snapshot, boardSubject(board.boardId));
      // Reconcile the agent lineup to the CURRENT cohort both ways (a removed
      // advisor must not keep responding). People are NOT participants — they
      // join via the subject-access read gate (the project-chat pattern).
      const meta = await getConversationMeta(tenantId, sessionId);
      const want = new Set(agentRefs);
      for (const ref of (meta?.participants ?? []).map((p) => p.subjectRef)) {
        if (ref.startsWith('agent:') && !want.has(ref)) await removeParticipant(tenantId, sessionId, ref);
      }
      // GRADE-10 — honest REST: 201 only when the conversation was created.
      res.status(created ? 201 : 200).json({ sessionId, ...(contextDegraded ? { contextDegraded: true } : {}) });
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
      // A superadmin may delete any board (incl. synthetic seed-owned demo
      // boards); otherwise the service enforces owner-only (ADR 0321).
      await deleteBoard(tenantOf(req), actingUserOf(req), req.params.boardId, isSuperadmin(req));
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
