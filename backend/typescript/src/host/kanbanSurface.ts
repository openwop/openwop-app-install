/**
 * `ctx.kanban` host surface (RFC `host.kanban`, `spec/v1/host-capabilities.md`
 * §host.kanban) — a REAL bridge from the `vendor.myndhyve.kanban` pack nodes to
 * the demo app's durable kanban store (`kanbanService.ts`), i.e. the SAME boards
 * and cards the builder UI shows. A board created by a workflow node appears in
 * the UI, and vice-versa.
 *
 * Methods map 1:1 onto the pack's call sites:
 *   boardCreate / boardReview / taskAssign / taskGet / taskCreateBatch /
 *   timelinePlan / automateRules / resourceMonitor / getReadyTasks / moveTask.
 *
 * Genuinely computed (not stubbed): boardReview aggregates real column counts +
 * at-risk cards; timelinePlan runs a dependency-aware working-day scheduler with
 * a real critical path; resourceMonitor tallies live per-assignee load + WIP
 * breaches + overdue cards. Create operations are idempotent by `idempotencyKey`
 * within a tenant. Board automation is deliberately unavailable until it has a
 * durable workflow-binding + delivery implementation; reporting success for an
 * in-process rule map would make a restart silently change product behavior.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../observability/logger.js';
import type { BundleScope } from './inMemorySurfaces.js';
import {
  createBoard, getBoard, listCards, getCard, createCard, updateCardFields, moveCard,
  isTerminalColumn, notifyBoardChanged, setCardLastRun,
  applyBoardCommand, completeKanbanOperation, reserveKanbanOperation,
  type KanbanCard, type MaterializeKanbanWorkItemsCommand, type MaterializeKanbanWorkItemsResult,
} from './kanbanService.js';
import { emitAssignmentNotification, withdrawAssignmentNotification } from './kanbanAssignmentNotify.js';
import { dispatchConfiguredKanbanTrigger } from './kanbanTriggerDelivery.js';

const log = createLogger('host.kanban');

type Json = Record<string, unknown>;

interface AutomationRule { trigger: string; action: string; config?: Json }

/** A stable key for one workflow invocation's board/card projection. It is
 * tenant-scoped but contains only a digest, so a caller's opaque key never
 * becomes a readable board field. */
function surfaceEntityId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
  return `${prefix}-${digest}`;
}

/** A missing board is treated as non-terminal so reporting helpers stay
 * defensive if its board was deleted between the two durable reads. */
const isOpenCard = (board: Awaited<ReturnType<typeof getBoard>>, card: KanbanCard): boolean =>
  !board || !isTerminalColumn(board, card.columnId);

/** Advance `from` by `n` working days, skipping weekends when the week is < 7
 *  working days. Returns a new Date. */
function addWorkingDays(from: Date, n: number, workingDaysPerWeek: number): Date {
  const d = new Date(from.getTime());
  if (workingDaysPerWeek >= 7) { d.setDate(d.getDate() + n); return d; }
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}

export interface KanbanSurface {
  boardCreate(args: { name: string; columns: Array<{ id: string; label: string; wipLimit?: number }>; description?: string; projectId?: string; idempotencyKey: string }): Promise<{ boardId: string; createdAt: string }>;
  boardReview(args: { boardId: string; includeArchived?: boolean; atRiskThresholdDays?: number }): Promise<unknown>;
  taskAssign(args: { taskId: string; assigneeId: string; notifyAssignee?: boolean; comment?: string; idempotencyKey: string }): Promise<unknown>;
  taskGet(taskId: string): Promise<unknown>;
  taskCreateBatch(args: { parentTaskId: string; subtasks: Array<{ title: string; description?: string; estimateHours?: number }>; idempotencyKey: string }): Promise<{ subtaskIds: string[] }>;
  timelinePlan(args: { boardId: string; startDate?: string; workingHoursPerDay?: number; workingDaysPerWeek?: number; scheduler?: string; idempotencyKey: string }): Promise<unknown>;
  automateRules(args: { boardId: string; rules: AutomationRule[]; replaceExisting?: boolean; idempotencyKey: string }): Promise<unknown>;
  resourceMonitor(args: { boardId: string; maxConcurrentPerAssignee?: number; includeAgents?: boolean }): Promise<unknown>;
  /** Canvas/use-case-neutral reviewed-plan boundary. The surface fills tenant
   * identity from the run scope, so node packs never accept tenant ids. */
  materializeWorkItems(args: Omit<MaterializeKanbanWorkItemsCommand, 'tenantId' | 'type'>): Promise<MaterializeKanbanWorkItemsResult>;
  getReadyTasks(boardId: string): Promise<Array<Json>>;
  /** Move through the same trigger-delivery path as the HTTP board. The
   * returned run id is intentionally optional: a transition without a binding,
   * a disabled agent, or a dangling legacy binding still completes the move. */
  moveTask(taskId: string, toColumn: string): Promise<{ taskId: string; toColumn: string; triggeredRunId?: string }>;
}

export function createKanbanSurface(scope: BundleScope): KanbanSurface {
  const tenantId = scope.tenantId;

  /** A workflow surface is tenant-bound, but its node inputs are still data.
   * Resolve every caller-provided board/card id through this guard before a
   * read, mutation, schedule, or notification can touch it. This keeps a
   * generic canvas adapter from turning an opaque foreign id into a
   * cross-tenant oracle or write primitive. */
  const loadScopedBoard = async (boardId: string): Promise<NonNullable<Awaited<ReturnType<typeof getBoard>>>> => {
    const board = await getBoard(boardId);
    if (!board || board.tenantId !== tenantId) {
      throw Object.assign(new Error(`board ${boardId} not found`), { code: 'kanban_board_not_found' });
    }
    return board;
  };
  const loadScopedCard = async (taskId: string): Promise<{ card: KanbanCard; board: NonNullable<Awaited<ReturnType<typeof getBoard>>> }> => {
    const card = await getCard(taskId);
    if (!card) throw Object.assign(new Error(`task ${taskId} not found`), { code: 'kanban_task_not_found' });
    const board = await loadScopedBoard(card.boardId);
    return { card, board };
  };

  return {
    async boardCreate({ name, columns, description, idempotencyKey }) {
      const board = await createBoard({
        tenantId,
        name,
        columns: (columns ?? []).map((c) => ({ id: c.id, name: c.label })),
        id: surfaceEntityId('board-workflow', tenantId, 'board.create', idempotencyKey),
      });
      if (description) log.info('board created with description (stored as name context only)', { boardId: board.id });
      return { boardId: board.id, createdAt: board.createdAt };
    },

    async boardReview({ boardId, atRiskThresholdDays = 3 }) {
      const board = await loadScopedBoard(boardId);
      const cards = await listCards(boardId);
      const columnCounts: Record<string, number> = {};
      for (const col of board?.columns ?? []) columnCounts[col.id] = 0;
      for (const c of cards) columnCounts[c.columnId] = (columnCounts[c.columnId] ?? 0) + 1;
      const horizon = Date.now() + atRiskThresholdDays * 86_400_000;
      const atRiskTasks = cards
        .filter((c) => c.dueAt && isOpenCard(board, c) && Date.parse(c.dueAt) <= horizon)
        .map((c) => ({ taskId: c.id, title: c.title, dueAt: c.dueAt, columnId: c.columnId }));
      return {
        ...(board?.name ? { boardName: board.name } : {}),
        totalTasks: cards.length,
        columnCounts,
        atRiskTasks,
        reviewedAt: new Date().toISOString(),
      };
    },

    async taskAssign({ taskId, assigneeId, notifyAssignee, comment, idempotencyKey }) {
      // The workflow/agent caller is trusted to choose an assignee, but its
      // card id remains untrusted input. Resolve the card through the bound
      // tenant before reserving a durable receipt, so a foreign id creates
      // neither a cross-tenant write nor a transient retry lease.
      const source = await loadScopedCard(taskId);
      const reservation = await reserveKanbanOperation(
        tenantId,
        'task.assign',
        idempotencyKey,
        [taskId, assigneeId, notifyAssignee === false ? 'silent' : 'notify', comment ?? ''].join('\u0000'),
      );
      if (reservation.kind === 'completed') return reservation.result;
      if (reservation.kind === 'in-progress') {
        throw Object.assign(new Error('Kanban assignment is already being applied. Retry shortly.'), {
          code: 'kanban_idempotency_in_progress', retryAt: reservation.retryAt,
        });
      }
      const card = await getCard(taskId);
      if (!card || card.boardId !== source.board.id) {
        throw Object.assign(new Error(`task ${taskId} not found`), { code: 'kanban_task_not_found' });
      }
      const previousAssigneeId = card.assigneeId;
      // Assigning a person clears any pending role-addressed state (ADR 0049 D2).
      await updateCardFields(taskId, {
        assigneeId,
        assigneeRole: null,
        ...(comment ? { assignmentReason: comment } : {}),
      });
      // ADR 0049 — honor `notifyAssignee` (previously declared but DROPPED).
      // Default ON: an assignment that doesn't reach the assignee is useless.
      if (notifyAssignee !== false && assigneeId && assigneeId !== previousAssigneeId) {
        await emitAssignmentNotification({
          tenantId, card, assigneeId, comment, idempotencyKey, boardName: source.board.name,
        });
        if (previousAssigneeId) {
          await withdrawAssignmentNotification({ tenantId, cardId: card.id, recipientUserId: previousAssigneeId });
        }
      }
      const out = { ...(previousAssigneeId ? { previousAssigneeId } : {}), assignedAt: new Date().toISOString() };
      if (!await completeKanbanOperation(reservation.receiptId, reservation.claimToken, out)) {
        throw Object.assign(new Error('Kanban assignment completed but its idempotency receipt was contested. Retry shortly.'), {
          code: 'kanban_idempotency_contested',
        });
      }
      return out;
    },

    async taskGet(taskId) {
      // Preserve the historical ``null`` result for an absent task while still
      // refusing to reveal a card that exists only in another tenant.
      const card = await getCard(taskId);
      if (!card) return null;
      await loadScopedBoard(card.boardId);
      return card;
    },

    async taskCreateBatch({ parentTaskId, subtasks, idempotencyKey }) {
      const { card: parent } = await loadScopedCard(parentTaskId);
      const subtaskIds: string[] = [];
      for (const s of subtasks ?? []) {
        const card = await createCard({
          boardId: parent.boardId,
          columnId: parent.columnId,
          title: s.title,
          ...(s.description !== undefined ? { description: s.description } : {}),
          ...(s.estimateHours !== undefined ? { estimateHours: s.estimateHours } : {}),
          dependsOn: [parentTaskId],
          source: 'workflow',
          cardId: surfaceEntityId('card-workflow', tenantId, parentTaskId, 'task.create-batch', idempotencyKey, String(subtaskIds.length)),
        });
        subtaskIds.push(card.id);
      }
      return { subtaskIds };
    },

    async timelinePlan({ boardId, startDate, workingHoursPerDay = 8, workingDaysPerWeek = 5 }) {
      await loadScopedBoard(boardId);
      const cards = await listCards(boardId);
      const byId = new Map(cards.map((c) => [c.id, c]));
      const durationDays = (c: KanbanCard): number => Math.max(1, Math.ceil((c.estimateHours ?? workingHoursPerDay) / workingHoursPerDay));
      // Topological order over dependsOn (Kahn); cards not on this board are
      // treated as already satisfied. Cycles fall back to board order.
      const order: KanbanCard[] = [];
      const indeg = new Map<string, number>();
      for (const c of cards) indeg.set(c.id, (c.dependsOn ?? []).filter((d) => byId.has(d)).length);
      const ready = cards.filter((c) => (indeg.get(c.id) ?? 0) === 0);
      while (ready.length) {
        const c = ready.shift()!;
        order.push(c);
        for (const other of cards) {
          if ((other.dependsOn ?? []).includes(c.id)) {
            const n = (indeg.get(other.id) ?? 1) - 1;
            indeg.set(other.id, n);
            if (n === 0) ready.push(other);
          }
        }
      }
      if (order.length < cards.length) order.push(...cards.filter((c) => !order.includes(c)));

      const base = startDate ? new Date(startDate) : new Date();
      const startOffset = new Map<string, number>(); // working-day offset from base
      const schedule: Array<{ taskId: string; startAt: string; endAt: string }> = [];
      for (const c of order) {
        const depEnd = Math.max(0, ...(c.dependsOn ?? [])
          .filter((d) => byId.has(d))
          .map((d) => (startOffset.get(d) ?? 0) + durationDays(byId.get(d)!)));
        startOffset.set(c.id, depEnd);
        const startAt = addWorkingDays(base, depEnd, workingDaysPerWeek);
        const endAt = addWorkingDays(base, depEnd + durationDays(c), workingDaysPerWeek);
        schedule.push({ taskId: c.id, startAt: startAt.toISOString(), endAt: endAt.toISOString() });
      }
      // Critical path: walk back from the task with the latest finish.
      const finish = (id: string): number => (startOffset.get(id) ?? 0) + durationDays(byId.get(id)!);
      let endTask = order[0];
      for (const c of order) if (endTask && finish(c.id) > finish(endTask.id)) endTask = c;
      const criticalPath: string[] = [];
      let cur: KanbanCard | undefined = endTask;
      while (cur) {
        criticalPath.unshift(cur.id);
        const deps: string[] = (cur.dependsOn ?? []).filter((d) => byId.has(d));
        const next: KanbanCard | undefined = deps.length
          ? deps.map((d) => byId.get(d)!).sort((a, b) => finish(b.id) - finish(a.id))[0]
          : undefined;
        cur = next;
      }
      const projectEndDate = schedule.reduce<string | undefined>((max, s) => (!max || s.endAt > max ? s.endAt : max), undefined);
      return { schedule, criticalPath, ...(projectEndDate ? { projectEndDate } : {}) };
    },

    async automateRules(_args) {
      // The pack exposes this method, but this host has not yet bound it to a
      // durable workflow configuration. Keep the API shape so capable hosts
      // can implement it, while this host gives an actionable, typed answer
      // instead of a false positive.
      void _args;
      throw Object.assign(
        new Error('Kanban automation requires a durable workflow binding and is not configured on this host.'),
        { code: 'kanban_automation_unavailable' },
      );
    },

    async resourceMonitor({ boardId, maxConcurrentPerAssignee = 5 }) {
      const board = await loadScopedBoard(boardId);
      const cards = await listCards(boardId);
      const open = cards.filter((c) => isOpenCard(board, c));
      const assigneeLoad: Record<string, number> = {};
      for (const c of open) if (c.assigneeId) assigneeLoad[c.assigneeId] = (assigneeLoad[c.assigneeId] ?? 0) + 1;
      const wipBreaches = Object.entries(assigneeLoad)
        .filter(([, n]) => n > maxConcurrentPerAssignee)
        .map(([assigneeId, current]) => ({ assigneeId, current, max: maxConcurrentPerAssignee }));
      const now = Date.now();
      const overdueTasks = open
        .filter((c) => c.dueAt && Date.parse(c.dueAt) < now)
        .map((c) => ({ taskId: c.id, dueAt: c.dueAt! }));
      return { assigneeLoad, wipBreaches, overdueTasks, monitoredAt: new Date().toISOString() };
    },

    async materializeWorkItems(args) {
      // The core service owns source identity, retries, dependency validation,
      // card projection, audit and outbox writes. This thin surface only binds
      // the authenticated workflow tenant — exactly the same pattern as every
      // other ctx.kanban method.
      return applyBoardCommand({ ...args, type: 'work-items.materialize', tenantId });
    },

    async getReadyTasks(boardId) {
      const board = await loadScopedBoard(boardId);
      const cards = await listCards(boardId);
      const done = new Set(cards.filter((c) => !isOpenCard(board, c)).map((c) => c.id));
      return cards
        .filter((c) => isOpenCard(board, c) && (c.dependsOn ?? []).every((d) => done.has(d) || !cards.some((x) => x.id === d)))
        .map((c) => ({ id: c.id, title: c.title, columnId: c.columnId, ...(c.assigneeId ? { assigneeId: c.assigneeId } : {}) }));
    },

    async moveTask(taskId, toColumn) {
      const { card, board } = await loadScopedCard(taskId);
      // Resolve `toColumn` against the board by id, then by case-insensitive name.
      const col = board?.columns.find((c) => c.id === toColumn)
        ?? board?.columns.find((c) => c.name.toLowerCase() === String(toColumn).toLowerCase());
      const targetId = col?.id ?? toColumn;
      const moved = await moveCard(taskId, targetId);
      if (!moved) throw Object.assign(new Error(`column ${toColumn} not found on task ${taskId}`), { code: 'kanban_column_not_found' });
      // Keep this trusted surface aligned with the HTTP mutation command: a
      // completed assignment must leave the assignee's inbox regardless of
      // which canvas or workflow initiated the move.
      if (board && isTerminalColumn(board, targetId) && card.assigneeId) {
        await withdrawAssignmentNotification({ tenantId, cardId: taskId, recipientUserId: card.assigneeId });
      }
      const started = moved.trigger
        ? await dispatchConfiguredKanbanTrigger(tenantId, moved.trigger)
        : null;
      if (started) await setCardLastRun(taskId, started.runId);
      notifyBoardChanged(card.boardId);
      return {
        taskId,
        toColumn: targetId,
        ...(started ? { triggeredRunId: started.runId } : {}),
      };
    },
  };
}
