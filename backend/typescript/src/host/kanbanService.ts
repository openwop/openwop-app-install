/**
 * Kanban boards — host extension (non-normative).
 *
 * A demo work surface for the "named workflow agents" story (RFCS/0086
 * Standing Agent Roster + RFCS/0087 Agent Org-Chart): cards represent
 * work items; moving a card INTO a trigger-enabled column starts a
 * workflow run — the "new artifact lands in the To Do column → run a
 * workflow" pattern. The board itself is deliberately NOT a normative
 * protocol surface (RFC 0086 §E keeps the concrete work surface a
 * host/vendor extension; only the run attribution + the durable trigger
 * bridge are protocol concerns). The card→run wiring composes the
 * existing run surface — a card move resolves to a normal `POST /v1/runs`
 * equivalent (see routes/kanban.ts), so replay/fork/observability are
 * inherited unchanged.
 *
 * The store is a read-through, per-entity durable collection (boards + cards
 * each one row per entity in host/hostExtPersistence.ts) — consistent across
 * instances + restart-safe. This module is pure: `moveCard` returns a trigger
 * DIRECTIVE rather than starting a run itself, so the route handler (which
 * holds `storage` + `hostSuite`) owns the side effects and this service stays
 * testable in isolation.
 *
 * @see RFCS/0086-standing-agent-roster-and-workflow-portfolio.md §D/§E
 * @see RFCS/0087-agent-org-chart.md
 * @see src/host/schedulingService.ts — the process-local host-ext precedent
 */

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection, publishHostExtEvent, subscribeHostExtEvent } from './hostExtPersistence.js';
import type { Subject } from './subject.js';

/** A column on a board. When `triggerWorkflowId` is set, any card moved
 *  into this column starts that workflow (unless the card overrides it
 *  with its own `workflowId`). A "To Do" column is the canonical
 *  trigger column. */
export interface KanbanColumn {
  id: string;
  name: string;
  /** Column-level default workflow fired when a card enters this column.
   *  A card's own `workflowId` takes precedence. */
  triggerWorkflowId?: string;
  /** ADR 0049 — marks the board's terminal (Done) lane. A card sitting in a
   *  terminal column is "complete" (the canonical card-level completion signal,
   *  robust to column renames). The default board flags its "Done" column. */
  terminal?: boolean;
  /** CHATP-4 — the STRUCTURED kind of a terminal lane, so consumers (e.g. the
   *  priority-matrix schedule status, ADR 0103) can distinguish a completion lane
   *  ("Done") from a cancellation lane ("Won't Do") WITHOUT a locale-fragile name
   *  regex. Optional + only meaningful when `terminal` is true; legacy boards that
   *  predate it fall back to the stable seeded id / name heuristic. */
  terminalKind?: 'completion' | 'cancellation';
}

/** Where a task card came from — the demo "task source taxonomy" so the UI
 *  can show source-specific visual language (human / workflow / agent /
 *  Discord / schedule / API). Attribution-only; does not change run wiring. */
export type KanbanCardSource = 'human' | 'workflow' | 'agent' | 'discord' | 'schedule' | 'api';

export const KANBAN_CARD_SOURCES: ReadonlyArray<KanbanCardSource> = [
  'human',
  'workflow',
  'agent',
  'discord',
  'schedule',
  'api',
];

/** A card (work item). `workflowId` is the card-level override of the
 *  destination column's `triggerWorkflowId`. `order` is the position
 *  within its column (ascending). The `source`/`sourceLabel`/`priority`/
 *  `dueAt` fields are demo-oriented metadata (PRD §11) — all optional and
 *  backward-compatible; existing cards without them stay valid. */
export interface KanbanCard {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  description?: string;
  workflowId?: string;
  /** Set to the runId of the most recent run this card triggered. */
  lastRunId?: string;
  /** Where this task came from (drives the source chip). Defaults to `human`. */
  source?: KanbanCardSource;
  /** Free-text source detail, e.g. the Discord command or the agent name. */
  sourceLabel?: string;
  priority?: 'low' | 'normal' | 'high';
  /** ISO-8601 due date. */
  dueAt?: string;
  /** Who created this task (free text, e.g. a person's name or "Discord"). The
   *  `source` chip says HOW it arrived; this says WHO. */
  createdBy?: string;
  /** Why this task is assigned to the board's agent — the "why Sally?" answer. */
  assignmentReason?: string;
  /** Free-text note describing what's blocking the task (a lightweight blocker;
   *  not a dependency graph). Surfaced as a "Blocked" chip. */
  blockerNote?: string;
  /** Who the task is assigned to (host.kanban taskAssign / resourceMonitor).
   *  The single accountable owner — a userId (ADR 0049). Additive — existing
   *  cards without it stay valid. */
  assigneeId?: string;
  /** ADR 0049 — role-addressed assignment: the card is unclaimed and notifies
   *  every holder of this role; the first to CLAIM it sets `assigneeId` and
   *  clears this. Mutually exclusive with a set `assigneeId` in steady state. */
  assigneeRole?: string;
  /** ADR 0049 — set to the ISO timestamp the card first entered a `terminal`
   *  column (completion audit). Cleared if it moves back out of terminal. */
  completedAt?: string;
  /** Effort estimate in hours (host.kanban timelinePlan). */
  estimateHours?: number;
  /** Free-form labels (host.kanban automateRules `label-changed` triggers). */
  labels?: string[];
  /** Ids of tasks this one depends on (host.kanban timelinePlan critical path,
   *  getReadyTasks). A lightweight DAG over cards on the same board. */
  dependsOn?: string[];
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanBoard {
  id: string;
  tenantId: string;
  name: string;
  columns: KanbanColumn[];
  /** Optional RFCS/0086 roster member that OWNS this board. When set, a
   *  card→run trigger attributes the run to this named agent (persona). */
  rosterId?: string;
  /** ADR 0025 — a human USER that owns this board (the user/agent symmetry).
   *  Mutually exclusive with `rosterId`; a board owned by a person attributes
   *  card→run triggers to that user, not an agent. */
  ownerUserId?: string;
  /** ADR 0045/0046 — the generic owning `Subject` (the forward field). When set it
   *  is authoritative; legacy `rosterId`/`ownerUserId` remain for back-compat (no
   *  migration). A `kind:'project'` board's cards fire workflows, not agent turns. */
  ownerSubject?: Subject;
  createdAt: string;
  updatedAt: string;
}

/** ADR 0025 — the polymorphic board owner: an agent (roster) OR a human user.
 *  Reads the legacy `rosterId` as `{kind:'agent'}` for back-compat. */
export type BoardOwner = { kind: 'agent'; rosterId: string } | { kind: 'user'; userId: string } | null;

export function boardOwner(board: KanbanBoard): BoardOwner {
  if (board.rosterId) return { kind: 'agent', rosterId: board.rosterId };
  if (board.ownerUserId) return { kind: 'user', userId: board.ownerUserId };
  return null;
}

/** ADR 0045 — the board's owner as the canonical `Subject` (the bridge from the
 *  legacy `rosterId`/`ownerUserId` storage fields). Maps `rosterId` →
 *  `{kind:'agent'}`, `ownerUserId` → `{kind:'user'}`. */
export function boardSubject(board: KanbanBoard): Subject | null {
  if (board.ownerSubject) return board.ownerSubject;
  if (board.rosterId) return { kind: 'agent', id: board.rosterId };
  if (board.ownerUserId) return { kind: 'user', id: board.ownerUserId };
  return null;
}

/** ADR 0045 Phase 2 — list a SUBJECT's boards (the canonical owner query that
 *  unifies the per-agent `b.rosterId === …` filter and the per-user path). Storage
 *  is unchanged; this matches on the derived `boardSubject`. Tenant-scoped. */
export async function listBoardsForSubject(tenantId: string, subject: Subject): Promise<KanbanBoard[]> {
  return (await listBoards(tenantId)).filter((b) => {
    const s = boardSubject(b);
    return s !== null && s.kind === subject.kind && s.id === subject.id;
  });
}

/** Returned by `moveCard` when the destination column resolves a workflow
 *  to fire. The route handler turns this into a run. */
export interface KanbanTriggerDirective {
  workflowId: string;
  boardId: string;
  cardId: string;
  fromColumnId: string;
  toColumnId: string;
}

/** The default column set for a new board — the canonical To Do / Doing /
 *  Done lanes, with To Do flagged as the trigger column when a board is
 *  created with a `triggerWorkflowId`. */
export const DEFAULT_COLUMNS: ReadonlyArray<Omit<KanbanColumn, 'triggerWorkflowId'>> = [
  { id: 'todo', name: 'To Do' },
  { id: 'doing', name: 'Doing' },
  // ADR 0049 — the canonical terminal lane; a card here is "complete".
  { id: 'done', name: 'Done', terminal: true },
];

/** Column-name hints that mean "done" — the fallback terminal signal for boards
 *  whose columns predate the `terminal` flag (or were created via a path that
 *  doesn't set it, e.g. the `host.kanban` boardCreate surface). */
const DONE_HINTS = ['done', 'complete', 'completed', 'shipped', 'closed', 'archived'];

/** ADR 0049 — is `columnId` a TERMINAL (completion) lane on `board`?
 *  - If ANY column on the board is explicitly flagged `terminal`, only flagged
 *    columns count (respect an author's explicit lane design exactly).
 *  - Otherwise (legacy / surface-created / custom-column boards with no flag),
 *    fall back to a name/id "done" match OR the last column, so completion
 *    semantics still fire instead of silently no-op'ing. */
export function isTerminalColumn(board: KanbanBoard, columnId: string): boolean {
  const column = board.columns.find((c) => c.id === columnId);
  if (!column) return false;
  if (board.columns.some((c) => c.terminal)) return column.terminal === true;
  const hay = `${column.id} ${column.name}`.toLowerCase();
  if (DONE_HINTS.some((h) => hay.includes(h))) return true;
  return board.columns.length > 0 && board.columns[board.columns.length - 1].id === columnId;
}

const boards = new DurableCollection<KanbanBoard>('kanban:board', (b) => b.id);
const cards = new DurableCollection<KanbanCard>('kanban:card', (c) => c.id);

function nowIso(): string {
  return new Date().toISOString();
}

export async function createBoard(input: {
  tenantId: string;
  name: string;
  columns?: KanbanColumn[];
  /** When set, the default "To Do" column fires this workflow on card entry. */
  triggerWorkflowId?: string;
  /** Optional RFCS/0086 roster member that owns this board (attribution). */
  rosterId?: string;
  /** ADR 0025 — a human user that owns this board (mutually exclusive with rosterId). */
  ownerUserId?: string;
  /** ADR 0045/0046 — the generic owning Subject (e.g. a `kind:'project'` board).
   *  Authoritative when set; legacy `rosterId`/`ownerUserId` still supported. */
  ownerSubject?: Subject;
  /** ADR 0025 — override the random id for deterministic, idempotent provisioning. */
  id?: string;
}): Promise<KanbanBoard> {
  const id = input.id ?? `board-${randomUUID()}`;
  const now = nowIso();
  const columns: KanbanColumn[] = input.columns
    ? input.columns.map((c) => ({ ...c }))
    : DEFAULT_COLUMNS.map((c) =>
        c.id === 'todo' && input.triggerWorkflowId
          ? { ...c, triggerWorkflowId: input.triggerWorkflowId }
          : { ...c },
      );
  const board: KanbanBoard = {
    id,
    tenantId: input.tenantId,
    name: input.name,
    columns,
    ...(input.rosterId ? { rosterId: input.rosterId } : {}),
    ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
    ...(input.ownerSubject ? { ownerSubject: input.ownerSubject } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await boards.put(board);
  return board;
}

/** ADR 0025 — the deterministic id for a user's ONE personal board in a
 *  workspace. Stable so auto-provisioning is idempotent across concurrent
 *  first-access (no duplicate boards). */
export function personalBoardId(tenantId: string, ownerUserId: string): string {
  const key = createHash('sha256').update(`${tenantId}:${ownerUserId}`).digest('hex').slice(0, 24);
  return `board-personal-${key}`;
}

/** The user's personal board in this workspace, or null. */
export async function getPersonalBoard(tenantId: string, ownerUserId: string): Promise<KanbanBoard | null> {
  const b = await boards.get(personalBoardId(tenantId, ownerUserId));
  return b && b.tenantId === tenantId ? b : null;
}

/** ADR 0025 — auto-provision a user's personal board (idempotent). Mirrors how a
 *  seeded roster agent gets a board, but owned by a human. Safe under concurrent
 *  first-access: the deterministic id makes a racing create last-writer-wins on
 *  identical content rather than minting duplicates. */
export async function ensurePersonalBoard(tenantId: string, ownerUserId: string, name?: string): Promise<KanbanBoard> {
  const id = personalBoardId(tenantId, ownerUserId);
  const existing = await boards.get(id);
  if (existing && existing.tenantId === tenantId) return existing;
  return createBoard({ id, tenantId, name: name ?? 'My Board', ownerUserId });
}

/** ADR 0045/0046 — the deterministic id for a SUBJECT's one board in a workspace
 *  (the generic form of `personalBoardId`). Stable ⇒ idempotent provisioning. */
export function subjectBoardId(tenantId: string, subject: Subject): string {
  const key = createHash('sha256').update(`${tenantId}:${subject.kind}:${subject.id}`).digest('hex').slice(0, 24);
  return `board-${subject.kind}-${key}`;
}

/** ADR 0045/0046 — auto-provision a subject's board (idempotent; e.g. a project's
 *  board). Owned via the generic `ownerSubject`. Concurrent-first-access safe via
 *  the deterministic id. */
export async function ensureSubjectBoard(tenantId: string, subject: Subject, name?: string): Promise<KanbanBoard> {
  const id = subjectBoardId(tenantId, subject);
  const existing = await boards.get(id);
  if (existing && existing.tenantId === tenantId) return existing;
  return createBoard({ id, tenantId, name: name ?? 'Board', ownerSubject: subject });
}

export async function listBoards(tenantId: string): Promise<KanbanBoard[]> {
  return (await boards.list())
    .filter((b) => b.tenantId === tenantId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getBoard(boardId: string): Promise<KanbanBoard | null> {
  return boards.get(boardId);
}

/** Rename a board — metadata only. Owner (`rosterId`) and columns are
 *  deliberately NOT mutable here: rebinding the owner alters run attribution
 *  (RFC 0086 §C) and column edits alter trigger semantics (architect memo
 *  2026-06-05). Returns null when the board doesn't exist. */
export async function renameBoard(boardId: string, name: string): Promise<KanbanBoard | null> {
  const board = await boards.get(boardId);
  if (!board) return null;
  const next: KanbanBoard = { ...board, name, updatedAt: new Date().toISOString() };
  await boards.put(next);
  return next;
}

export async function deleteBoard(boardId: string): Promise<boolean> {
  const boardCards = (await cards.list()).filter((c) => c.boardId === boardId);
  for (const card of boardCards) await cards.delete(card.id);
  return boards.delete(boardId);
}

export async function listCards(boardId: string): Promise<KanbanCard[]> {
  return (await cards.list())
    .filter((c) => c.boardId === boardId)
    .sort((a, b) => a.columnId.localeCompare(b.columnId) || a.order - b.order);
}

export async function getCard(cardId: string): Promise<KanbanCard | null> {
  return cards.get(cardId);
}

/** One-scan batch: every board the tenant owns, each with its cards attached.
 *  Collapses the dashboard's N+1 (one `getBoard` per board → N card scans) into
 *  a single boards scan + a single cards scan, grouped in memory. */
export async function listBoardsWithCards(
  tenantId: string,
): Promise<Array<KanbanBoard & { cards: KanbanCard[] }>> {
  const tenantBoards = (await boards.list())
    .filter((b) => b.tenantId === tenantId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const boardIds = new Set(tenantBoards.map((b) => b.id));
  const byBoard = new Map<string, KanbanCard[]>();
  for (const card of await cards.list()) {
    if (!boardIds.has(card.boardId)) continue;
    const arr = byBoard.get(card.boardId) ?? [];
    arr.push(card);
    byBoard.set(card.boardId, arr);
  }
  return tenantBoards.map((b) => ({
    ...b,
    cards: (byBoard.get(b.id) ?? []).sort(
      (x, y) => x.columnId.localeCompare(y.columnId) || x.order - y.order,
    ),
  }));
}

export async function createCard(input: {
  boardId: string;
  columnId: string;
  title: string;
  description?: string;
  workflowId?: string;
  source?: KanbanCardSource;
  sourceLabel?: string;
  priority?: 'low' | 'normal' | 'high';
  dueAt?: string;
  createdBy?: string;
  assignmentReason?: string;
  blockerNote?: string;
  assigneeId?: string;
  assigneeRole?: string;
  estimateHours?: number;
  labels?: string[];
  dependsOn?: string[];
}): Promise<KanbanCard> {
  const id = `card-${randomUUID()}`;
  const now = nowIso();
  const siblings = (await cards.list()).filter(
    (c) => c.boardId === input.boardId && c.columnId === input.columnId,
  );
  const card: KanbanCard = {
    id,
    boardId: input.boardId,
    columnId: input.columnId,
    title: input.title,
    description: input.description,
    workflowId: input.workflowId,
    // Default unattributed cards to `human` — a person dragged it in.
    source: input.source ?? 'human',
    sourceLabel: input.sourceLabel,
    priority: input.priority,
    dueAt: input.dueAt,
    createdBy: input.createdBy,
    assignmentReason: input.assignmentReason,
    blockerNote: input.blockerNote,
    ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
    ...(input.assigneeRole !== undefined ? { assigneeRole: input.assigneeRole } : {}),
    ...(input.estimateHours !== undefined ? { estimateHours: input.estimateHours } : {}),
    ...(input.labels !== undefined ? { labels: input.labels } : {}),
    ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {}),
    order: siblings.length,
    createdAt: now,
    updatedAt: now,
  };
  await cards.put(card);
  return card;
}

export async function updateCardFields(
  cardId: string,
  patch: {
    title?: string;
    description?: string;
    workflowId?: string;
    source?: KanbanCardSource;
    sourceLabel?: string;
    priority?: 'low' | 'normal' | 'high';
    dueAt?: string;
    createdBy?: string;
    assignmentReason?: string;
    blockerNote?: string;
    /** Pass `null` to UNASSIGN (clear the field). ADR 0049. */
    assigneeId?: string | null;
    /** Pass `null` to clear the role-pending state (e.g. on claim). ADR 0049. */
    assigneeRole?: string | null;
    estimateHours?: number;
    labels?: string[];
    dependsOn?: string[];
  },
): Promise<KanbanCard | null> {
  const card = await cards.get(cardId);
  if (!card) return null;
  if (patch.title !== undefined) card.title = patch.title;
  if (patch.description !== undefined) card.description = patch.description;
  if (patch.workflowId !== undefined) card.workflowId = patch.workflowId;
  if (patch.source !== undefined) card.source = patch.source;
  if (patch.sourceLabel !== undefined) card.sourceLabel = patch.sourceLabel;
  if (patch.priority !== undefined) card.priority = patch.priority;
  if (patch.dueAt !== undefined) card.dueAt = patch.dueAt;
  if (patch.createdBy !== undefined) card.createdBy = patch.createdBy;
  if (patch.assignmentReason !== undefined) card.assignmentReason = patch.assignmentReason;
  if (patch.blockerNote !== undefined) card.blockerNote = patch.blockerNote;
  // `null` clears (unassign); a string sets; `undefined` leaves untouched.
  if (patch.assigneeId === null) delete card.assigneeId;
  else if (patch.assigneeId !== undefined) card.assigneeId = patch.assigneeId;
  if (patch.assigneeRole === null) delete card.assigneeRole;
  else if (patch.assigneeRole !== undefined) card.assigneeRole = patch.assigneeRole;
  if (patch.estimateHours !== undefined) card.estimateHours = patch.estimateHours;
  if (patch.labels !== undefined) card.labels = patch.labels;
  if (patch.dependsOn !== undefined) card.dependsOn = patch.dependsOn;
  card.updatedAt = nowIso();
  await cards.put(card);
  return card;
}

/** ADR 0049 — every card across the tenant addressed to a given user: their
 *  direct assignments (`assigneeId`) plus cards role-addressed to a role they
 *  hold (`assigneeRole` ∈ roleKeys). This is the derived "assigned to me"
 *  projection backing the personal-board live mirror — a single cards scan
 *  joined to the tenant's boards (no copies; the same records the origin
 *  boards render). */
export async function listCardsAssignedToUser(
  tenantId: string,
  userId: string,
  roleKeys: readonly string[] = [],
): Promise<Array<KanbanCard & { boardName: string; columnName: string; terminal: boolean }>> {
  const tenantBoards = (await boards.list()).filter((b) => b.tenantId === tenantId);
  const boardById = new Map(tenantBoards.map((b) => [b.id, b]));
  const roles = new Set(roleKeys);
  const out: Array<KanbanCard & { boardName: string; columnName: string; terminal: boolean }> = [];
  for (const card of await cards.list()) {
    const board = boardById.get(card.boardId);
    if (!board) continue; // cross-tenant / orphaned — never leak
    const mine = card.assigneeId === userId || (card.assigneeRole ? roles.has(card.assigneeRole) : false);
    if (!mine) continue;
    const column = board.columns.find((c) => c.id === card.columnId);
    out.push({
      ...card,
      boardName: board.name,
      columnName: column?.name ?? card.columnId,
      terminal: isTerminalColumn(board, card.columnId),
    });
  }
  return out.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

/** ADR 0049 — is `userId` allowed to act on this card without being a member
 *  of its origin board? True when they are the assignee (assignment confers
 *  card-scoped access, D4). Tenant isolation is enforced by the caller. */
export function isCardAssignee(card: KanbanCard, userId: string): boolean {
  return card.assigneeId === userId;
}

export async function deleteCard(cardId: string): Promise<boolean> {
  return cards.delete(cardId);
}

/** Record the run a card triggered (set by the route after starting it). */
export async function setCardLastRun(cardId: string, runId: string): Promise<void> {
  const card = await cards.get(cardId);
  if (card) {
    card.lastRunId = runId;
    card.updatedAt = nowIso();
    await cards.put(card);
  }
}

/**
 * Move a card to a new column. Returns the moved card plus an optional
 * trigger directive: when the destination column (or the card itself)
 * names a workflow, the route handler starts a run for it. A move within
 * the same column is a no-op trigger-wise (re-entering To Do does not
 * re-fire — the directive is only returned when `fromColumnId !==
 * toColumnId`). Returns `null` when the card or destination column is
 * unknown.
 */
export async function moveCard(
  cardId: string,
  toColumnId: string,
): Promise<{ card: KanbanCard; trigger: KanbanTriggerDirective | null } | null> {
  const card = await cards.get(cardId);
  if (!card) return null;
  const board = await boards.get(card.boardId);
  if (!board) return null;
  const destColumn = board.columns.find((c) => c.id === toColumnId);
  if (!destColumn) return null;

  const fromColumnId = card.columnId;
  if (fromColumnId === toColumnId) {
    return { card, trigger: null };
  }

  const siblings = (await cards.list()).filter(
    (c) => c.boardId === card.boardId && c.columnId === toColumnId,
  );
  const now = nowIso();
  card.columnId = toColumnId;
  card.order = siblings.length;
  card.updatedAt = now;
  // ADR 0049 — completion is "in a terminal column" (with a legacy fallback for
  // boards without an explicit `terminal` flag, see isTerminalColumn). Stamp
  // `completedAt` on first entry into a terminal lane; clear it when moved back
  // out. Because the origin board and the personal-board mirror render the SAME
  // record, this propagates both ways with no reconciliation.
  if (isTerminalColumn(board, toColumnId)) {
    if (!card.completedAt) card.completedAt = now;
  } else if (card.completedAt) {
    delete card.completedAt;
  }
  await cards.put(card);

  const workflowId = card.workflowId ?? destColumn.triggerWorkflowId;
  const trigger: KanbanTriggerDirective | null = workflowId
    ? { workflowId, boardId: card.boardId, cardId, fromColumnId, toColumnId }
    : null;
  return { card, trigger };
}

// --- live board-change fan-out (for the SSE board-events stream) ---
//
// A board mutation (card create/move/delete, board delete) publishes a
// board-change event on the storage pub/sub bus so an open SSE stream can tell
// connected clients to refetch — multi-client live board refresh. This is now
// CROSS-INSTANCE: on Postgres the publish rides LISTEN/NOTIFY so a mutation on
// any instance reaches SSE clients on every instance; on sqlite (single node)
// it is an in-process emitter. See host/hostExtPersistence.ts.

const BOARD_CHANGED_CHANNEL = 'hostext:kanban:board.changed';

/** Subscribe to board-change notifications. Returns an async unsubscribe fn. */
export function subscribeBoardChanges(fn: (boardId: string) => void): Promise<() => Promise<void>> {
  return subscribeHostExtEvent(BOARD_CHANGED_CHANNEL, fn);
}

/** Publish a board-change notification (cross-instance). Fire-and-forget: a
 *  failed publish must not abort the mutation that triggered it. */
export function notifyBoardChanged(boardId: string): void {
  void publishHostExtEvent(BOARD_CHANGED_CHANNEL, boardId).catch(() => undefined);
}

/** Test-only: drop all boards + cards. */
export async function __resetKanbanStore(): Promise<void> {
  await boards.__clear();
  await cards.__clear();
}
