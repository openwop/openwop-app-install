/**
 * Kanban boards — host-extension routes (non-normative).
 *
 * Surface under `/v1/host/openwop-app/kanban/*`:
 *   GET    /boards                       list the caller's boards
 *   POST   /boards                       create a board (default To Do/Doing/Done lanes)
 *   GET    /boards/:boardId              board + cards + redacted core work items
 *   POST   /boards/:boardId/work-items/:workItemId/run
 *                                        manually starts an eligible core work item
 *   DELETE /boards/:boardId              delete a board (cascades cards)
 *   POST   /boards/:boardId/cards        create a card in a column
 *   PATCH  /cards/:cardId                update a card; a `columnId` change MOVES it,
 *                                        and a move INTO a trigger column starts a run
 *   DELETE /cards/:cardId                delete a card
 *
 * The card→run trigger is the "named workflow agents" demo (RFCS/0086 §D):
 * when a card lands in a column that names a workflow (or the card carries
 * its own `workflowId`), the host starts a normal run for it — reusing the
 * exact `POST /v1/runs` recipe (workflowCatalog.getWorkflow → insertRun →
 * executeRun) so replay/fork/observability are inherited. The run records
 * a `kanban` attribution block in its metadata + emits a content-free
 * `kanban.card.moved` event on its stream (the proto-`roster.run.initiated`
 * attribution RFC 0086 §C standardizes). Tenant-scoped per board ownership
 * (the RFC 0074 carry-forward): a caller only sees + mutates its own boards.
 *
 * @see src/host/kanbanService.ts — the durable store + core move logic
 * @see RFCS/0086-standing-agent-roster-and-workflow-portfolio.md §C/§D/§E
 */

import { randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import type { HostAdapterSuite } from '../host/index.js';
import type { Storage } from '../storage/storage.js';
import {
  applyBoardCommand,
  createBoard,
  createCard,
  claimEligibleWorkItemExecution,
  deleteBoard,
  deleteCard,
  ensurePersonalBoard,
  getBoard,
  getCard,
  getWorkItem,
  listBoards,
  listBoardsWithCards,
  isTerminalColumn,
  listCards,
  listCardsAssignedToUser,
  listWorkItemProjectionsForBoard,
  notifyBoardChanged,
  renameBoard,
  setCardLastRun,
  setColumnWipLimit,
  subscribeBoardChanges,
  updateCardFields,
  boardSubject,
  boardDeleteClaim,
  KANBAN_CARD_SOURCES,
  type KanbanBoard,
  type KanbanCard,
  type KanbanCardSource,
  toKanbanWorkItemProjection,
} from '../host/kanbanService.js';
import { getRosterEntry } from '../host/rosterService.js';
import { openSseChannel } from '../host/sseChannel.js';
import { tenantOf } from '../host/tenantGuard.js';
import { callerSubject, personalTenantOf, isDurableCaller, isOwnPersonalWorkspace } from '../host/requestSubject.js';
import { resolveCallerUser } from '../features/users/usersGuards.js';
import { isWorkspaceMember, listMembers, type Scope } from '../host/accessControlService.js';
import { resolveSubjectAccess, levelSatisfies } from '../host/subjectAccess.js';
import {
  emitAssignmentNotification,
  withdrawAssignmentNotification,
} from '../host/kanbanAssignmentNotify.js';
import { startKanbanTriggerRun } from '../host/kanbanTriggerDelivery.js';
import { deliverReservedWorkItem } from '../host/kanbanWorkItemDelivery.js';
import { recordKanbanWorkItemDelivery } from '../observability/metricSeams.js';

interface Deps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

/** One legacy v1 route root while the protocol overlap remains active. Keeping
 * it centralized means Kanban has one migration point on the v1 retirement
 * date, rather than every operation carrying an independent path dependency. */
const KANBAN_ROUTE_ROOT = '/v1/host/openwop-app/kanban';

// tenantOf moved to the shared host/tenantGuard (DATA-2).

/** Validate an optional card `source` against the known taxonomy. Unknown
 *  strings fall back to `undefined` (the service then defaults to `human`)
 *  rather than 400 — a forgiving demo surface. */
function parseCardSource(input: unknown): KanbanCardSource | undefined {
  return typeof input === 'string' && (KANBAN_CARD_SOURCES as readonly string[]).includes(input)
    ? (input as KanbanCardSource)
    : undefined;
}

function parseCardPriority(input: unknown): 'low' | 'normal' | 'high' | undefined {
  return input === 'low' || input === 'normal' || input === 'high' ? input : undefined;
}

/** Translate the deliberately transport-agnostic core command errors at the
 * one HTTP boundary. Keeping these codes out of the service lets canvases use
 * the same command without inheriting REST-shaped exceptions. */
function rethrowCardCommandError(err: unknown): never {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (code === 'kanban_card_invalid' || code === 'kanban_command_invalid' || code === 'kanban_column_not_found') {
    throw new OpenwopError('validation_error', err instanceof Error ? err.message : 'Invalid card update.', 400);
  }
  if (code === 'kanban_card_not_found') throw new OpenwopError('not_found', 'Card not found.', 404);
  if (code === 'kanban_card_conflict') throw new OpenwopError('conflict', err instanceof Error ? err.message : 'Card changed concurrently.', 409);
  throw err;
}

/** The caller's RESOLVED access level for a board's owning subject, or null when
 *  it isn't a membership/org-scoped board (an agent/personal board). For a PROJECT
 *  board this composes org authority with the project's visibility + members
 *  (ADR 0054 D5 `subjectAccess` seam) — so a `private` project's board is gated to
 *  its members, exactly like its other surfaces. */
async function boardAccess(req: Request, board: KanbanBoard): Promise<'none' | 'read' | 'write' | null> {
  const subject = boardSubject(board);
  return subject ? resolveSubjectAccess(board.tenantId, subject, callerSubject(req)) : null;
}

/** Drop membership/org-scoped boards the caller can't read (ADR 0046/0054) — keeps
 *  non-org (agent/personal) boards visible per the legacy rule. Bounded list. */
async function filterReadableBoards<T extends KanbanBoard>(req: Request, boards: T[]): Promise<T[]> {
  const out: T[] = [];
  for (const b of boards) {
    const lvl = await boardAccess(req, b);
    if (lvl === null || lvl !== 'none') out.push(b); // legacy (null) OR readable
  }
  return out;
}

/** Resolve a board AND authorize the caller for it — the single source of truth
 *  for board access (replaces the copy-pasted `board.tenantId !== tenantOf(req)`
 *  guard so the rule can't drift across handlers). A caller reaches a board when:
 *   - ORG-SCOPED board (e.g. a project's board, ADR 0046): the caller holds `need`
 *     IN the owning org. Closes the read-privacy gap — a project's cards were
 *     visible to ANY tenant member; now only org members with the scope see them.
 *   - otherwise it belongs to the active workspace (the shared/standard case), OR
 *   - the caller is the board's personal OWNER (ADR 0025): a human's personal
 *     board is reachable from ANY active workspace, exactly as an agent surfaces
 *     its board on the agent profile regardless of the viewer's active tenant.
 *  Returns null (→ uniform 404, no existence leak) when the board is missing or
 *  the caller lacks `need`. `need` defaults to read; mutation routes pass write.
 *  Fail-closed. (Returning null — not 403 — on insufficient scope lets
 *  `authorizeCard` fall through to the assignee carve-out, ADR 0049 D4.) */
async function authorizeBoard(req: Request, boardId: string, need: Scope = 'workspace:read'): Promise<KanbanBoard | null> {
  const board = await getBoard(boardId);
  if (!board) return null;
  const lvl = await boardAccess(req, board);
  if (lvl !== null) return levelSatisfies(lvl, need === 'workspace:write' ? 'write' : 'read') ? board : null;
  // Legacy (non-org) boards — agent + personal — keep their tenant/owner visibility.
  if (board.tenantId === tenantOf(req)) return board;
  const subject = callerSubject(req);
  if (board.ownerUserId && subject && board.ownerUserId === subject) return board;
  return null;
}

/** ADR 0049 D4 — authorize a caller for a specific CARD. Board members get full
 *  `board` scope. The card's ASSIGNEE gets card-scoped `assignment` access even
 *  without origin-board membership (assignment confers the right to read / move /
 *  complete the work routed to them) — but NOT access to the rest of the board.
 *  Returns null → uniform 404. Fail-closed. */
async function authorizeCard(
  req: Request,
  card: KanbanCard,
  need: Scope = 'workspace:read',
): Promise<{ board: KanbanBoard; scope: 'board' | 'assignment' } | null> {
  const board = await authorizeBoard(req, card.boardId, need);
  if (board) return { board, scope: 'board' };
  // The assignee carve-out (ADR 0049 D4): a card's assignee may act on THAT card
  // even without board membership. This is reached when board-scope access is
  // insufficient (incl. an org board where the caller lacks `need`).
  const subject = callerSubject(req);
  if (subject && card.assigneeId === subject) {
    const b = await getBoard(card.boardId);
    if (b) return { board: b, scope: 'assignment' };
  }
  return null;
}

/** The caller's ADR 0006 RBAC roles in a workspace — the role-source for
 *  role-addressed cards (ADR 0049 D2; resolves the ADR's open question in favor
 *  of RBAC workspace roles). Empty when the caller is not a member. */
async function callerRolesIn(workspaceId: string, subject: string | undefined): Promise<string[]> {
  if (!subject) return [];
  const members = await listMembers(workspaceId, workspaceId);
  return members.find((m) => m.subject === subject)?.roles ?? [];
}

export function registerKanbanRoutes(app: Express, deps: Deps): void {
  // Live board refresh (SSE): clients subscribe to a board's change stream
  // and refetch on `board.changed`. Tenant-scoped at subscribe time. A plain
  // text/event-stream with heartbeats; the payload is just the boardId — the
  // client refetches GET /boards/:id (no card bodies on the wire here).
  app.get(`${KANBAN_ROUTE_ROOT}/boards/:boardId/events`, async (req, res, next) => {
    try {
      const board = await authorizeBoard(req, req.params.boardId);
      if (!board) {
        throw new OpenwopError('not_found', 'Board not found.', 404, { boardId: req.params.boardId });
      }
      // Shared SSE lifecycle (host/sseChannel): canonical headers — including
      // X-Accel-Buffering: no, which this feed previously lacked (frames could
      // be held by the Cloud Run / Firebase proxy) — heartbeat, per-tenant
      // connection cap, and teardown.
      const channel = openSseChannel(req, res);
      let unsubscribe: (() => Promise<void>) | null = null;
      channel.onClose(() => { if (unsubscribe) void unsubscribe(); });
      // subscribe is async (it may open a LISTEN connection); if the client
      // already disconnected mid-subscribe, tear it down immediately (the
      // onClose hook above only fires if `unsubscribe` was already assigned).
      unsubscribe = await subscribeBoardChanges((changedBoardId) => {
        if (channel.closed) return;
        if (changedBoardId === board.id) {
          res.write(`event: board.changed\ndata: ${JSON.stringify({ boardId: board.id })}\n\n`);
        }
      });
      if (channel.closed) void unsubscribe();
    } catch (err) {
      next(err);
    }
  });

  // --- boards ---

  app.get(`${KANBAN_ROUTE_ROOT}/boards`, async (req, res, next) => {
    try {
      // `?include=cards` returns each board with its cards attached in a single
      // round trip — lets the agents dashboard render lane previews without an
      // N+1 `getBoard` per agent (which trips the per-IP read rate limit).
      // ADR 0046 — drop ORG-SCOPED boards (a project's) the caller can't read, so
      // the list can't leak a board (name/cards) a `GET /boards/:id` would 404.
      if (req.query.include === 'cards') {
        res.json({ boards: await filterReadableBoards(req, await listBoardsWithCards(tenantOf(req))) });
        return;
      }
      res.json({ boards: await filterReadableBoards(req, await listBoards(tenantOf(req))) });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${KANBAN_ROUTE_ROOT}/boards`, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as {
        name?: unknown;
        columns?: unknown;
        triggerWorkflowId?: unknown;
        rosterId?: unknown;
      };
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        throw new OpenwopError('validation_error', 'Field `name` is required and MUST be a non-empty string.', 400, {
          field: 'name',
        });
      }
      if (body.triggerWorkflowId !== undefined && typeof body.triggerWorkflowId !== 'string') {
        throw new OpenwopError('validation_error', 'Field `triggerWorkflowId` MUST be a string when present.', 400, {
          field: 'triggerWorkflowId',
        });
      }
      // Optional RFCS/0086 roster binding: the named agent that owns this
      // board. When bound and no explicit trigger workflow is given, the
      // To Do column defaults to the member's first portfolio workflow —
      // "Sally's board fires Sally's workflow".
      let rosterId: string | undefined;
      let triggerWorkflowId = typeof body.triggerWorkflowId === 'string' ? body.triggerWorkflowId : undefined;
      if (body.rosterId !== undefined) {
        if (typeof body.rosterId !== 'string') {
          throw new OpenwopError('validation_error', 'Field `rosterId` MUST be a string when present.', 400, {
            field: 'rosterId',
          });
        }
        const entry = await getRosterEntry(tenantOf(req), body.rosterId);
        if (!entry) {
          throw new OpenwopError('validation_error', 'Field `rosterId` does not name a roster entry in this tenant.', 400, {
            field: 'rosterId',
          });
        }
        rosterId = entry.rosterId;
        if (!triggerWorkflowId && entry.workflows.length > 0) {
          triggerWorkflowId = entry.workflows[0];
        }
      }
      const board = await createBoard({
        tenantId: tenantOf(req),
        name: body.name,
        triggerWorkflowId,
        rosterId,
        columns: Array.isArray(body.columns) ? (body.columns as never) : undefined,
      });
      res.status(201).json(board);
    } catch (err) {
      next(err);
    }
  });

  // ADR 0025 — the caller's personal "My Board", ensured idempotently. MUST be
  // registered before `/boards/:boardId` (Express first-match) or `personal`
  // would be parsed as a boardId. The board lives in the caller's PERSONAL
  // tenant — the same idempotent choke point that provisions it on workspace
  // listing (`routes/workspaces.ts`) — and is owned by the caller's subject, so
  // it is the human's own board regardless of which workspace is active. This
  // makes a human a board-owning orchestration principal, mirroring how an agent
  // board is surfaced on the agent profile.
  app.get(`${KANBAN_ROUTE_ROOT}/boards/personal`, async (req, res, next) => {
    try {
      const subject = callerSubject(req);
      const personal = personalTenantOf(req);
      // Durable accounts only (ADR 0025 / ADR 0015): a personal board is never
      // auto-provisioned for an ephemeral `anon:<sid>` sandbox session — the
      // same rule the workspace choke point enforces.
      if (!subject || !personal || !isDurableCaller(req)) {
        throw new OpenwopError('unauthenticated', 'A durable signed-in account is required for a personal board.', 401, {});
      }
      // ADR 0003 — own the board by the caller's ONE canonical durable user, not
      // the raw `callerSubject` (which is the volatile channel principal —
      // `oidc:<sub>` / `session:<sid>` — when the session isn't bound). Keying the
      // board id on the subject mints a SEPARATE "My Board" per auth channel; the
      // canonical userId is stable, so this matches the workspace choke point.
      const ownerId = (await resolveCallerUser(req)).userId;
      const board = await ensurePersonalBoard(personal, ownerId);
      res.json({ board, cards: await listCards(board.id) });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0049 — the "assigned to me" live mirror: every card across the ACTIVE
  // workspace addressed to the caller (direct `assigneeId` or a role they hold),
  // grouped by board. A derived view over the SAME card records the origin
  // boards render — no copies — so edits/completion sync both ways for free.
  // Private to the caller (and admins via their own membership). MUST be
  // registered before `/boards/:boardId` so `assigned` isn't parsed as a boardId.
  app.get(`${KANBAN_ROUTE_ROOT}/assigned`, async (req, res, next) => {
    try {
      const subject = callerSubject(req);
      if (!subject || !isDurableCaller(req)) {
        throw new OpenwopError('unauthenticated', 'A durable signed-in account is required.', 401, {});
      }
      const tenantId = tenantOf(req);
      const roles = await callerRolesIn(tenantId, subject);
      const cards = await listCardsAssignedToUser(tenantId, subject, roles);
      // ADR 0046/0054 × ADR 0049: a DIRECT assignee always sees their card (the D4
      // carve-out). A ROLE-addressed card on a membership/org-scoped board (a
      // project's), however, must not reach a non-reader via the inbox — gate those
      // on the caller's resolved read access (org + project visibility/members).
      const visible: typeof cards = [];
      for (const card of cards) {
        if (card.assigneeId === subject) { visible.push(card); continue; } // direct assignee
        const board = await getBoard(card.boardId);
        const lvl = board ? await boardAccess(req, board) : null;
        if (lvl === null) { visible.push(card); continue; } // legacy (non-org) board
        if (lvl !== 'none') visible.push(card);             // readable membership/org board
      }
      res.json({ cards: visible });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${KANBAN_ROUTE_ROOT}/boards/:boardId`, async (req, res, next) => {
    try {
      const board = await authorizeBoard(req, req.params.boardId);
      if (!board) {
        throw new OpenwopError('not_found', 'Board not found.', 404, { boardId: req.params.boardId });
      }
      res.json({
        board,
        cards: await listCards(board.id),
        workItems: await listWorkItemProjectionsForBoard(board.tenantId, board.id),
      });
    } catch (err) {
      next(err);
    }
  });

  /** Explicit human dispatch for a generic WorkItem. The board, authorization,
   * readiness claim, and dynamic workflow lookup all remain core Kanban
   * concerns; a producer/canvas only supplied the original work proposal. */
  app.post(`${KANBAN_ROUTE_ROOT}/boards/:boardId/work-items/:workItemId/run`, async (req, res, next) => {
    try {
      const board = await authorizeBoard(req, req.params.boardId, 'workspace:write');
      if (!board) {
        throw new OpenwopError('not_found', 'Board not found.', 404, { boardId: req.params.boardId });
      }
      const workItem = await getWorkItem(req.params.workItemId);
      if (!workItem || workItem.tenantId !== board.tenantId || workItem.boardId !== board.id) {
        // The board boundary is already authorized; retain a uniform local 404
        // rather than allowing a direct aggregate id to cross board/tenant scope.
        throw new OpenwopError('not_found', 'Work item not found.', 404, { workItemId: req.params.workItemId });
      }
      const reservation = await claimEligibleWorkItemExecution(
        board.tenantId,
        workItem.workItemId,
        `kanban-manual-${randomUUID()}`,
        'manual',
      );
      if (reservation.kind === 'skip') {
        recordKanbanWorkItemDelivery('manual', 'not-eligible');
        throw new OpenwopError('conflict', 'This work item is not ready to run.', 409, { workItemId: workItem.workItemId });
      }
      if (reservation.kind === 'defer') {
        recordKanbanWorkItemDelivery('manual', 'deferred');
        throw new OpenwopError('conflict', 'This work item is already being started. Try again shortly.', 409, {
          workItemId: workItem.workItemId,
          retryAt: reservation.availableAt,
        });
      }
      let runId: string | null;
      try {
        runId = await deliverReservedWorkItem(deps, reservation);
      } catch (err) {
        recordKanbanWorkItemDelivery('manual', 'failed');
        throw err;
      }
      if (!runId) {
        recordKanbanWorkItemDelivery('manual', 'workflow-unresolved');
        throw new OpenwopError('conflict', 'The selected workflow is no longer available. Choose another workflow in the Workflow Builder, then try again.', 409, {
          workItemId: workItem.workItemId,
          workflowId: workItem.workflowId,
        });
      }
      recordKanbanWorkItemDelivery('manual', 'started');
      const updated = await getWorkItem(workItem.workItemId);
      res.status(202).json({
        workItem: toKanbanWorkItemProjection(updated ?? reservation.item),
        runId,
      });
    } catch (err) {
      next(err);
    }
  });

  // Rename only (architect memo 2026-06-05): `rosterId` rebinding and column
  // edits are deliberately rejected — owner changes alter run attribution
  // (RFC 0086 §C) and column changes alter trigger semantics.
  app.patch(`${KANBAN_ROUTE_ROOT}/boards/:boardId`, async (req, res, next) => {
    try {
      const board = await authorizeBoard(req, req.params.boardId, 'workspace:write');
      if (!board) {
        throw new OpenwopError('not_found', 'Board not found.', 404, { boardId: req.params.boardId });
      }
      const body = (req.body ?? {}) as { name?: unknown } & Record<string, unknown>;
      const extra = Object.keys(body).filter((k) => k !== 'name');
      if (extra.length > 0) {
        throw new OpenwopError('validation_error', 'Only `name` is mutable on a board.', 400, { fields: extra });
      }
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        throw new OpenwopError('validation_error', 'Field `name` is required and MUST be a non-empty string.', 400, {
          field: 'name',
        });
      }
      const renamed = await renameBoard(board.id, body.name.trim());
      notifyBoardChanged(board.id);
      res.json(renamed);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${KANBAN_ROUTE_ROOT}/boards/:boardId`, async (req, res, next) => {
    try {
      const board = await authorizeBoard(req, req.params.boardId, 'workspace:write');
      if (!board) {
        throw new OpenwopError('not_found', 'Board not found.', 404, { boardId: req.params.boardId });
      }
      // ADR 0667 D5(b) (PMXWF-10) — a board can BE another feature's aggregate (a
      // priority-matrix idea IS a card, ADR 0058). This route needs only
      // `workspace:write`, while that feature's own delete door needs creator-or-org-admin
      // authority — so without this, an editor who cannot delete a priority list could
      // delete the board underneath it and the list would render empty, with every score,
      // vote, intake and evidence row intact and no signal anywhere.
      //
      // Refuse HERE, at the route, and ONLY here: `deleteBoard` itself is what tenant
      // teardown, the roster cascade, projects and the owning feature's own delete all
      // call, and a refusal inside it would be a gate with no exit.
      //
      // The predicate arrives through a registry, so this core route never imports a
      // feature package (ADR 0001).
      const claim = await boardDeleteClaim(board.id);
      if (claim) {
        throw new OpenwopError('conflict', `This board belongs to ${claim.feature} ("${claim.ownerLabel}"). Delete it from that feature, which applies its own ownership rules.`, 409, { boardId: board.id, ownedBy: claim.feature });
      }
      await deleteBoard(board.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // KB-R2-5 — the ONE mutable column field: the soft WIP limit. A dedicated
  // narrow route (NOT the board PATCH, which deliberately rejects column
  // edits — trigger/terminal semantics stay immutable per the 2026-06-05
  // memo). The limit is a visual signal only; nothing anywhere blocks on it.
  app.patch(`${KANBAN_ROUTE_ROOT}/boards/:boardId/columns/:columnId/limit`, async (req, res, next) => {
    try {
      const board = await authorizeBoard(req, req.params.boardId, 'workspace:write');
      if (!board) {
        throw new OpenwopError('not_found', 'Board not found.', 404, { boardId: req.params.boardId });
      }
      const body = (req.body ?? {}) as { wipLimit?: unknown };
      const raw = body.wipLimit;
      let wipLimit: number | null;
      if (raw === null || raw === undefined) wipLimit = null;
      else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 999) wipLimit = raw;
      else {
        throw new OpenwopError('validation_error', '`wipLimit` must be an integer 1–999, or null to clear.', 400, { wipLimit: raw });
      }
      const updated = await setColumnWipLimit(board.id, req.params.columnId, wipLimit);
      if (!updated) {
        throw new OpenwopError('not_found', 'Column not found.', 404, { columnId: req.params.columnId });
      }
      notifyBoardChanged(board.id);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // --- cards ---

  app.post(`${KANBAN_ROUTE_ROOT}/boards/:boardId/cards`, async (req, res, next) => {
    try {
      const board = await authorizeBoard(req, req.params.boardId, 'workspace:write');
      if (!board) {
        throw new OpenwopError('not_found', 'Board not found.', 404, { boardId: req.params.boardId });
      }
      const body = (req.body ?? {}) as {
        title?: unknown;
        columnId?: unknown;
        description?: unknown;
        workflowId?: unknown;
        source?: unknown;
        sourceLabel?: unknown;
        priority?: unknown;
        dueAt?: unknown;
        createdBy?: unknown;
        assignmentReason?: unknown;
        blockerNote?: unknown;
      };
      if (typeof body.title !== 'string' || body.title.trim().length === 0) {
        throw new OpenwopError('validation_error', 'Field `title` is required and MUST be a non-empty string.', 400, {
          field: 'title',
        });
      }
      const columnId = typeof body.columnId === 'string' ? body.columnId : board.columns[0]?.id;
      if (!columnId || !board.columns.some((c) => c.id === columnId)) {
        throw new OpenwopError('validation_error', 'Field `columnId` MUST name a column on this board.', 400, {
          field: 'columnId',
        });
      }
      const card = await createCard({
        boardId: board.id,
        columnId,
        title: body.title,
        description: typeof body.description === 'string' ? body.description : undefined,
        workflowId: typeof body.workflowId === 'string' ? body.workflowId : undefined,
        source: parseCardSource(body.source),
        sourceLabel: typeof body.sourceLabel === 'string' ? body.sourceLabel : undefined,
        priority: parseCardPriority(body.priority),
        dueAt: typeof body.dueAt === 'string' ? body.dueAt : undefined,
        createdBy: typeof body.createdBy === 'string' ? body.createdBy : undefined,
        assignmentReason: typeof body.assignmentReason === 'string' ? body.assignmentReason : undefined,
        blockerNote: typeof body.blockerNote === 'string' ? body.blockerNote : undefined,
      });
      notifyBoardChanged(board.id);
      res.status(201).json(card);
    } catch (err) {
      next(err);
    }
  });

  app.patch(`${KANBAN_ROUTE_ROOT}/cards/:cardId`, async (req, res, next) => {
    try {
      const cardId = req.params.cardId;
      const existing = await getCard(cardId);
      if (!existing) {
        throw new OpenwopError('not_found', 'Card not found.', 404, { cardId });
      }
      const access = await authorizeCard(req, existing, 'workspace:write');
      if (!access) {
        throw new OpenwopError('not_found', 'Card not found.', 404, { cardId });
      }
      const { board, scope } = access;
      const body = (req.body ?? {}) as {
        title?: unknown;
        description?: unknown;
        workflowId?: unknown;
        columnId?: unknown;
        beforeCardId?: unknown;
        afterCardId?: unknown;
        source?: unknown;
        sourceLabel?: unknown;
        priority?: unknown;
        dueAt?: unknown;
        createdBy?: unknown;
        assignmentReason?: unknown;
        blockerNote?: unknown;
      };

      // ADR 0049 D4 — a caller with only card-scoped (assignment) access may
      // PROGRESS the work (move/complete via `columnId`) but not edit the card's
      // content/config — that belongs to the origin board's members.
      if (scope === 'assignment') {
        const contentFields = Object.keys(body).filter((k) => k !== 'columnId' && k !== 'beforeCardId' && k !== 'afterCardId');
        if (contentFields.length > 0) {
          throw new OpenwopError(
            'forbidden',
            'As the assignee you can move this card, but only the board members can edit its content.',
            403,
            { fields: contentFields },
          );
        }
      }

      const requestedColumnId = typeof body.columnId === 'string' && body.columnId !== existing.columnId
        ? body.columnId
        : undefined;
      if (requestedColumnId && !board.columns.some((column) => column.id === requestedColumnId)) {
        throw new OpenwopError('validation_error', 'Field `columnId` MUST name a column on this board.', 400, {
          field: 'columnId',
        });
      }

      // One CAS-backed command validates the whole intent BEFORE persisting it:
      // a bad lane can no longer leave a valid title/metadata edit behind.
      let mutation;
      try {
        mutation = await applyBoardCommand({
          type: 'card.patch', tenantId: board.tenantId, boardId: board.id, cardId,
          ...(requestedColumnId ? { columnId: requestedColumnId } : {}),
          ...(typeof body.beforeCardId === 'string' ? { beforeCardId: body.beforeCardId } : {}),
          ...(typeof body.afterCardId === 'string' ? { afterCardId: body.afterCardId } : {}),
          patch: {
            title: typeof body.title === 'string' ? body.title : undefined,
            description: typeof body.description === 'string' ? body.description : undefined,
            workflowId: typeof body.workflowId === 'string' ? body.workflowId : undefined,
            source: parseCardSource(body.source),
            sourceLabel: typeof body.sourceLabel === 'string' ? body.sourceLabel : undefined,
            priority: parseCardPriority(body.priority),
            dueAt: typeof body.dueAt === 'string' ? body.dueAt : undefined,
            createdBy: typeof body.createdBy === 'string' ? body.createdBy : undefined,
            assignmentReason: typeof body.assignmentReason === 'string' ? body.assignmentReason : undefined,
            blockerNote: typeof body.blockerNote === 'string' ? body.blockerNote : undefined,
          },
        });
      } catch (err) {
        rethrowCardCommandError(err);
      }

      // A columnId change is a move — and a move into a trigger column
      // starts a run.
      let triggeredRunId: string | null = null;
      let attribution: Record<string, unknown> | null = null;
      if (requestedColumnId) {
        const destColumn = board.columns.find((column) => column.id === requestedColumnId);
        // ADR 0049 — completing the work resolves the inbox item: moving the
        // card into a terminal lane withdraws the assignee's assignment notice.
        if (destColumn && isTerminalColumn(board, destColumn.id) && existing.assigneeId) {
          await withdrawAssignmentNotification({
            tenantId: board.tenantId,
            cardId,
            recipientUserId: existing.assigneeId,
          });
        }
        if (mutation.trigger) {
          // Attribute the run to the BOARD's tenant, not the caller's active
          // workspace — so a personal board's card→run fires into the owner's
          // personal tenant even when accessed from another workspace.
          const started = await startKanbanTriggerRun(deps, board.tenantId, mutation.trigger);
          if (started) {
            triggeredRunId = started.runId;
            attribution = started.attribution;
            await setCardLastRun(cardId, started.runId);
          }
        }
      }

      res.json({ card: mutation.card, triggeredRunId, attribution });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0049 — assign a card to a person (or address it to a role), or unassign.
  // Body: { assigneeId: "<userId>", comment?, notifyAssignee? } to assign a
  //       person; { assigneeId: null } to unassign; { assigneeRole: "<role>" }
  //       to address an unclaimed role. The card NEVER leaves its origin board —
  //       assignment is a reference. Only a board member may assign (write).
  app.post(`${KANBAN_ROUTE_ROOT}/cards/:cardId/assign`, async (req, res, next) => {
    try {
      const cardId = req.params.cardId;
      const existing = await getCard(cardId);
      if (!existing) throw new OpenwopError('not_found', 'Card not found.', 404, { cardId });
      const board = await authorizeBoard(req, existing.boardId, 'workspace:write');
      if (!board) throw new OpenwopError('not_found', 'Card not found.', 404, { cardId });

      const body = (req.body ?? {}) as {
        assigneeId?: unknown;
        assigneeRole?: unknown;
        comment?: unknown;
        notifyAssignee?: unknown;
      };
      const comment = typeof body.comment === 'string' ? body.comment : undefined;
      const notify = body.notifyAssignee !== false;
      const prev = existing.assigneeId;

      // Unassign — clear the assignee and withdraw their inbox item.
      if (body.assigneeId === null) {
        await updateCardFields(cardId, { assigneeId: null, assignmentReason: comment ?? '' });
        if (prev) await withdrawAssignmentNotification({ tenantId: board.tenantId, cardId, recipientUserId: prev });
        notifyBoardChanged(board.id);
        res.json({ card: await getCard(cardId) });
        return;
      }

      // Role-addressed (unclaimed) — surfaces in every role-holder's mirror;
      // the first to claim becomes the accountable assignee (ADR 0049 D2).
      if (typeof body.assigneeRole === 'string' && body.assigneeRole.trim().length > 0) {
        await updateCardFields(cardId, { assigneeId: null, assigneeRole: body.assigneeRole.trim(), assignmentReason: comment });
        if (prev) await withdrawAssignmentNotification({ tenantId: board.tenantId, cardId, recipientUserId: prev });
        notifyBoardChanged(board.id);
        res.json({ card: await getCard(cardId) });
        return;
      }

      // Assign a person.
      if (typeof body.assigneeId !== 'string' || body.assigneeId.trim().length === 0) {
        throw new OpenwopError('validation_error', 'Provide `assigneeId` (a workspace member), `assigneeRole`, or `assigneeId: null` to unassign.', 400, {});
      }
      const assigneeId = body.assigneeId.trim();
      // Tenant isolation (ADR 0006/0015): the assignee MUST be a member of the
      // board's workspace. Fail-closed — never assign across tenants. Exception:
      // self-assignment on your OWN personal workspace, whose implicit owner has
      // no explicit member row until the workspace surface seeds one (and the
      // single-principal `default`/dev tenant never seeds members at all).
      const selfOnOwnWorkspace = isOwnPersonalWorkspace(req) && assigneeId === callerSubject(req);
      if (!selfOnOwnWorkspace && !(await isWorkspaceMember(assigneeId, board.tenantId))) {
        throw new OpenwopError('validation_error', 'Assignee must be a member of this workspace.', 400, { field: 'assigneeId' });
      }
      await updateCardFields(cardId, { assigneeId, assigneeRole: null, ...(comment ? { assignmentReason: comment } : {}) });
      if (notify && assigneeId !== prev) {
        const card = await getCard(cardId);
        if (card) {
          await emitAssignmentNotification({ tenantId: board.tenantId, card, assigneeId, comment, boardName: board.name });
          if (prev) await withdrawAssignmentNotification({ tenantId: board.tenantId, cardId, recipientUserId: prev });
        }
      }
      notifyBoardChanged(board.id);
      res.json({ card: await getCard(cardId) });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0049 D2 — claim a role-addressed (unclaimed) card: the caller becomes
  // the single accountable assignee. Open to any workspace member (a board
  // member need not be); claiming requires only workspace membership + the card
  // being role-addressed. No origin-board membership is required (the claimer
  // gains card-scoped access as the assignee).
  app.post(`${KANBAN_ROUTE_ROOT}/cards/:cardId/claim`, async (req, res, next) => {
    try {
      const cardId = req.params.cardId;
      const subject = callerSubject(req);
      if (!subject) throw new OpenwopError('unauthenticated', 'Sign in to claim a task.', 401, {});
      const existing = await getCard(cardId);
      if (!existing) throw new OpenwopError('not_found', 'Card not found.', 404, { cardId });
      const board = await getBoard(existing.boardId);
      // Claiming a role-addressed card is a WRITE (you become its assignee), so it
      // must respect the same gate as every other board mutation (ADR 0046/0054):
      // a membership/org-scoped board (a project's) needs `write` access; a legacy
      // (non-org) board keeps the cross-workspace tenant-member check.
      const claimLvl = board ? await boardAccess(req, board) : null;
      const claimAllowed = !!board && (claimLvl !== null
        ? claimLvl === 'write'
        : await isWorkspaceMember(subject, board.tenantId));
      if (!claimAllowed) {
        throw new OpenwopError('not_found', 'Card not found.', 404, { cardId });
      }
      if (!existing.assigneeRole || existing.assigneeId) {
        throw new OpenwopError('validation_error', 'This card is not available to claim.', 400, {});
      }
      await updateCardFields(cardId, { assigneeId: subject, assigneeRole: null });
      notifyBoardChanged(board.id);
      res.json({ card: await getCard(cardId) });
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${KANBAN_ROUTE_ROOT}/cards/:cardId`, async (req, res, next) => {
    try {
      const card = await getCard(req.params.cardId);
      if (!card) {
        throw new OpenwopError('not_found', 'Card not found.', 404, { cardId: req.params.cardId });
      }
      const board = await authorizeBoard(req, card.boardId, 'workspace:write');
      if (!board) {
        throw new OpenwopError('not_found', 'Card not found.', 404, { cardId: req.params.cardId });
      }
      await deleteCard(card.id);
      // ADR 0049 — a deleted card's inbox item is withdrawn (the mirror drops it
      // automatically, being a derived view).
      if (card.assigneeId) {
        await withdrawAssignmentNotification({ tenantId: board.tenantId, cardId: card.id, recipientUserId: card.assigneeId });
      }
      notifyBoardChanged(card.boardId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}
