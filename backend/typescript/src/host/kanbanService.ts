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
import { registerSubjectEraser } from './subjectErasure.js';
import { createLogger } from '../observability/logger.js';
import { ERASED, subjectKeyForms } from './subjectErasureRedaction.js';
import { getRetentionHold } from './retentionHold.js';

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
  /** KB-R2-5 — soft work-in-progress limit. PURELY a visual signal (the
   *  GitHub-Projects/Jira consensus): the column head shows count/limit and
   *  highlights on breach; it NEVER blocks a create, a move, or an
   *  automation. Set/cleared via the dedicated column-limit route only — the
   *  board PATCH still rejects column edits (the 2026-06-05 memo). */
  wipLimit?: number;
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
  /** ADR 0311 P2 — the chat conversation this card was FILED from (the
   *  add-todo tool). Propagated onto a heartbeat-proposed approval so the
   *  approval card surfaces back in the originating chat (OQ-2). */
  sourceConversationId?: string;
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
  /** Optional link to the reusable execution aggregate. Legacy human-created
   * cards deliberately omit it and remain first-class board cards. */
  workItemId?: string;
  /** Additive optimistic-concurrency revision. Rows written before the core
   * command boundary have no revision and are treated as revision zero. */
  version?: number;
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

/** A namespaced domain/canvas context for a reusable work item. The core does
 * not know whether `kind` represents an App Builder plan, a CRM playbook, or a
 * future canvas type; extensions may register validation without owning a
 * second board or work store. */
export interface KanbanWorkScope {
  kind: string;
  externalRef?: string;
}

/** Opaque provenance for a reviewed artifact that requested work. IDs are
 * intentionally content-free: evidence lives in its source feature, while the
 * work core retains a stable traceable link. */
export interface KanbanWorkSource {
  kind: string;
  id: string;
  revision?: string;
}

export type KanbanWorkItemState = 'proposed' | 'ready' | 'running' | 'blocked' | 'completed' | 'cancelled';

/** Generic execution policy for a durable WorkItem. A domain adapter may opt
 * into automatic delivery, but it cannot supply a runner: the core always
 * starts the selected tenant-owned workflow through the normal run outbox. */
export interface KanbanWorkItemExecution {
  mode: 'manual' | 'auto';
  maxAttempts: number;
  attempts: number;
  status: 'idle' | 'starting' | 'running' | 'failed' | 'succeeded';
  runId?: string;
  claimToken?: string;
  claimExpiresAt?: string;
  lastError?: string;
}

/** The durable executable aggregate. A card mirrors its board-facing fields;
 * this record owns scope, provenance, dependency identity and lifecycle state. */
export interface KanbanWorkItem {
  workItemId: string;
  tenantId: string;
  boardId: string;
  cardId: string;
  scope: KanbanWorkScope;
  source: KanbanWorkSource;
  sourceKey: string;
  dependencyIds: string[];
  workflowId?: string;
  input?: Record<string, unknown>;
  execution: KanbanWorkItemExecution;
  state: KanbanWorkItemState;
  /** Initial reviewed-plan order; card column rank remains the interaction order. */
  order: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Safe, canvas-neutral operational view of a WorkItem. Workflow input and
 * execution-claim credentials intentionally never enter this projection: board
 * readers need status and provenance, while only the core dispatcher needs the
 * opaque input. It also forms the durable tenant-index projection so board
 * reads do not hydrate inputs merely to discard them at the host boundary.
 */
export type KanbanWorkItemProjection = Pick<
  KanbanWorkItem,
  'workItemId' | 'boardId' | 'cardId' | 'workflowId' | 'state' | 'order' | 'createdAt' | 'updatedAt'
> & {
  /** Board pages need the extension namespaces, never extension-controlled ids
   * or references. Those can be personal data in a generic canvas. */
  scope: Pick<KanbanWorkScope, 'kind'>;
  source: Pick<KanbanWorkSource, 'kind'>;
  dependencyCount: number;
  execution: Pick<KanbanWorkItemExecution, 'mode' | 'maxAttempts' | 'attempts' | 'status' | 'runId' | 'lastError'>;
};

/** The sole core projection boundary for presentation and host read paths. */
export function toKanbanWorkItemProjection(item: KanbanWorkItem): KanbanWorkItemProjection {
  return {
    workItemId: item.workItemId,
    boardId: item.boardId,
    cardId: item.cardId,
    scope: { kind: item.scope.kind },
    source: { kind: item.source.kind },
    dependencyCount: item.dependencyIds.length,
    ...(item.workflowId ? { workflowId: item.workflowId } : {}),
    state: item.state,
    order: item.order,
    execution: {
      mode: item.execution.mode,
      maxAttempts: item.execution.maxAttempts,
      attempts: item.execution.attempts,
      status: item.execution.status,
      ...(item.execution.runId ? { runId: item.execution.runId } : {}),
      ...(item.execution.lastError ? { lastError: item.execution.lastError } : {}),
    },
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Index markers are durable data too; reject malformed projections rather
 * than presenting an arbitrary marker if an operator/storage fault corrupts
 * one. The authoritative aggregate remains available to repair it on a later
 * write or legacy self-heal. */
function isKanbanWorkItemProjection(value: unknown): value is KanbanWorkItemProjection {
  if (!isRecord(value)) return false;
  const scope = value.scope;
  const source = value.source;
  const execution = value.execution;
  const state = value.state;
  if (!isRecord(scope) || typeof scope.kind !== 'string' || !isRecord(source)
    || typeof source.kind !== 'string' || !isRecord(execution)) return false;
  if (state !== 'proposed' && state !== 'ready' && state !== 'running' && state !== 'blocked'
    && state !== 'completed' && state !== 'cancelled') return false;
  const executionMode = execution.mode;
  const executionStatus = execution.status;
  if ((executionMode !== 'manual' && executionMode !== 'auto')
    || (executionStatus !== 'idle' && executionStatus !== 'starting' && executionStatus !== 'running'
      && executionStatus !== 'failed' && executionStatus !== 'succeeded')) return false;
  return typeof value.workItemId === 'string'
    && typeof value.boardId === 'string'
    && typeof value.cardId === 'string'
    && typeof value.dependencyCount === 'number' && Number.isInteger(value.dependencyCount) && value.dependencyCount >= 0
    && (value.workflowId === undefined || typeof value.workflowId === 'string')
    && Number.isFinite(value.order)
    && Number.isFinite(execution.maxAttempts)
    && Number.isFinite(execution.attempts)
    && (execution.runId === undefined || typeof execution.runId === 'string')
    && (execution.lastError === undefined || typeof execution.lastError === 'string')
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

/** Append-only, content-minimal audit record. Kept separate from the WorkItem
 * so the aggregate remains compact to project into any board renderer. */
export interface KanbanWorkItemAuditEntry {
  auditId: string;
  tenantId: string;
  boardId: string;
  workItemId: string;
  type: 'work-item.materialized' | 'work-item.state-changed' | 'work-item.execution-started' | 'work-item.execution-settled';
  at: string;
  metadata: Record<string, unknown>;
}

/** Durable command outbox. Phase 4 claims these events for eligible-work
 * execution; Phase 2 intentionally records rather than dispatches them. */
export interface KanbanWorkItemOutboxEntry {
  eventId: string;
  tenantId: string;
  boardId: string;
  workItemId: string;
  type: KanbanWorkItemAuditEntry['type'];
  status: 'pending' | 'claimed' | 'delivered' | 'dead-lettered';
  attempts: number;
  availableAt: string;
  claimedBy?: string;
  claimExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/** Tenant-scoped point index from a normal workflow run back to the one core
 * WorkItem whose terminal lifecycle it reconciles. Kept as a named durable
 * type so retention and subject-erasure inventories can audit its tenant
 * boundary just like the other WorkItem records. */
export interface KanbanWorkItemRunIndexEntry {
  runId: string;
  tenantId: string;
  workItemId: string;
}

/** Durable receipt for an idempotent core Kanban operation. Keys and payloads
 * are hashed before storage so callers' opaque idempotency material never
 * becomes another board-readable field. The receipt records a short lease while
 * a worker is applying its deterministic command, then its canonical result. */
export interface KanbanOperationReceipt {
  receiptId: string;
  tenantId: string;
  operation: string;
  payloadHash: string;
  status: 'claimed' | 'completed';
  claimToken?: string;
  claimExpiresAt?: string;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type KanbanOperationReservation =
  | { kind: 'claimed'; receiptId: string; claimToken: string }
  | { kind: 'completed'; result: Record<string, unknown> }
  | { kind: 'in-progress'; retryAt: string };

export interface KanbanWorkScopeRegistration {
  kind: string;
  validate?(scope: KanbanWorkScope): void;
}

const WORK_SCOPE_REGISTRATIONS = new Map<string, KanbanWorkScopeRegistration>();

/** Register optional domain validation for a namespaced scope. This is an
 * inversion point only: registrations cannot replace core storage, commands,
 * execution or UI behavior. */
export function registerKanbanWorkScope(registration: KanbanWorkScopeRegistration): void {
  WORK_SCOPE_REGISTRATIONS.set(registration.kind, registration);
}

export interface KanbanWorkItemProposal {
  /** Stable within its source artifact; duplicate keys fail before any write. */
  key: string;
  title: string;
  description?: string;
  columnId: string;
  workflowId?: string;
  dependsOnKeys?: string[];
  input?: Record<string, unknown>;
  priority?: 'low' | 'normal' | 'high';
  dueAt?: string;
  /** Default manual. `auto` is an explicit, workflow-builder-editable opt-in
   * to the core work dispatcher; it never introduces a feature-specific runner. */
  execution?: { mode?: 'manual' | 'auto'; maxAttempts?: number };
}

export interface MaterializeKanbanWorkItemsCommand {
  type: 'work-items.materialize';
  tenantId: string;
  boardId: string;
  scope: KanbanWorkScope;
  source: KanbanWorkSource;
  items: KanbanWorkItemProposal[];
  /** Caller-provided stable idempotency key. It is recorded only through
   * deterministic aggregate/event ids, never a process-local cache. */
  idempotencyKey: string;
  dryRun?: boolean;
}

/** The set of editable card fields. A combined content + lane mutation is one
 * canonical command, so an invalid destination cannot leave its content half
 * persisted. `null` is intentionally limited to the two assignment clears. */
export interface KanbanCardPatch {
  title?: string;
  description?: string;
  workflowId?: string;
  /** Internal lifecycle projection; public card PATCH deliberately does not
   * accept this field. Normal run delivery records it through the same CAS. */
  lastRunId?: string;
  source?: KanbanCardSource;
  sourceLabel?: string;
  priority?: 'low' | 'normal' | 'high';
  dueAt?: string;
  createdBy?: string;
  assignmentReason?: string;
  blockerNote?: string;
  assigneeId?: string | null;
  assigneeRole?: string | null;
  estimateHours?: number;
  labels?: string[];
  dependsOn?: string[];
}

/** A core, tenant-scoped card mutation. The route and every host surface use
 * this single operation for edits and moves; `columnId` is optional so a pure
 * field update stays the same command without a synthetic second write. */
export interface PatchKanbanCardCommand {
  type: 'card.patch';
  tenantId: string;
  boardId: string;
  cardId: string;
  patch: KanbanCardPatch;
  columnId?: string;
  /** Relative placement is core board behavior, not a canvas convention.
   * At most one anchor may be supplied; omission appends in the destination. */
  beforeCardId?: string;
  afterCardId?: string;
}

export type KanbanBoardCommand = MaterializeKanbanWorkItemsCommand | PatchKanbanCardCommand;

export interface MaterializeKanbanWorkItemsResult {
  dryRun: boolean;
  workItems: KanbanWorkItem[];
  cards: KanbanCard[];
}

export interface PatchKanbanCardResult {
  card: KanbanCard;
  trigger: KanbanTriggerDirective | null;
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
const workItems = new DurableCollection<KanbanWorkItem>(
  'kanban:work-item',
  (item) => item.workItemId,
  undefined,
  (item) => item.tenantId,
  (item) => toKanbanWorkItemProjection(item),
);
const workItemAudit = new DurableCollection<KanbanWorkItemAuditEntry>(
  'kanban:work-item-audit',
  (entry) => entry.auditId,
  undefined,
  (entry) => entry.tenantId,
);
const workItemOutbox = new DurableCollection<KanbanWorkItemOutboxEntry>(
  'kanban:work-item-outbox',
  (entry) => entry.eventId,
  undefined,
  (entry) => entry.tenantId,
);
/** Point lookup from the normal workflow lifecycle back to its generic work
 * aggregate. This avoids a cross-tenant WorkItem scan on every terminal run. */
const workItemRunIndex = new DurableCollection<KanbanWorkItemRunIndexEntry>(
  'kanban:work-item-run',
  (entry) => entry.runId,
  undefined,
  (entry) => entry.tenantId,
);
const operationReceipts = new DurableCollection<KanbanOperationReceipt>(
  'kanban:operation-receipt',
  (entry) => entry.receiptId,
  undefined,
  (entry) => entry.tenantId,
);

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
  if (input.id) {
    const existing = await boards.get(id);
    if (existing) {
      if (existing.tenantId !== input.tenantId) {
        throw boardCommandError('kanban_board_collision', `Board '${id}' is already owned by another tenant.`);
      }
      return existing;
    }
  }
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
  if (!input.id) {
    await boards.put(board);
    return board;
  }
  if (await boards.putIfAbsent(board)) return board;
  const winner = await boards.get(id);
  if (winner && winner.tenantId === input.tenantId) return winner;
  throw boardCommandError('kanban_board_collision', `Board '${id}' could not be created safely.`);
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

/** KB-R2-5 — set (positive integer) or clear (null) a column's soft WIP
 *  limit. The ONLY column field this touches; trigger/terminal semantics are
 *  structurally out of reach (the 2026-06-05 memo's invariant). Returns null
 *  when the board or column does not exist. */
export async function setColumnWipLimit(boardId: string, columnId: string, wipLimit: number | null): Promise<KanbanBoard | null> {
  const board = await boards.get(boardId);
  if (!board) return null;
  const col = board.columns.find((c) => c.id === columnId);
  if (!col) return null;
  const columns = board.columns.map((c) => {
    if (c.id !== columnId) return c;
    const { wipLimit: _drop, ...rest } = c;
    return wipLimit === null ? { ...rest } : { ...rest, wipLimit };
  });
  const next: KanbanBoard = { ...board, columns, updatedAt: new Date().toISOString() };
  await boards.put(next);
  return next;
}

/**
 * KT-D1 (account-deletion cascade) — purge a tenant's ENTIRE kanban estate.
 * Cards carry NO top-level `tenantId` (their tenant is derivable only through
 * their board), so the generic host-ext tenant purge deletes board rows but
 * strands every card as an orphan. This runs BEFORE the generic purge (it
 * needs the board rows to find the cards) and cascades board→cards through
 * `deleteBoard`. Fail-closed on a falsy tenant.
 */
export async function purgeTenantKanban(tenantId: string): Promise<{ boards: number; cards: number; workItems: number; operationReceipts: number }> {
  if (!tenantId) return { boards: 0, cards: 0, workItems: 0, operationReceipts: 0 };
  const tenantBoards = (await boards.list()).filter((b) => b.tenantId === tenantId);
  let cardCount = 0;
  let workItemCount = 0;
  for (const b of tenantBoards) {
    cardCount += (await cards.list()).filter((c) => c.boardId === b.id).length;
    workItemCount += (await workItems.listForTenantIndexed(tenantId)).filter((item) => item.boardId === b.id).length;
    await deleteBoard(b.id);
  }
  // Defensive final sweep for work records that predate their board/card
  // projection (e.g. a crash between deterministic writes). Tenant teardown is
  // destructive, so completeness takes precedence over preserving recoverable
  // partial materializations.
  for (const item of await workItems.listForTenantIndexed(tenantId)) {
    await deleteWorkItemRecord(item);
    workItemCount += 1;
  }
  // Operation receipts are deliberately outside the board/card cascade: they
  // may represent a workflow-surface request that completed before its board
  // was created. They are tenant-scoped nevertheless, so tenant deletion owns
  // their complete removal rather than waiting for time-based retention.
  let operationReceiptCount = 0;
  for (const receipt of await operationReceipts.listForTenantIndexed(tenantId)) {
    if (await operationReceipts.delete(receipt.receiptId)) operationReceiptCount += 1;
  }
  return { boards: tenantBoards.length, cards: cardCount, workItems: workItemCount, operationReceipts: operationReceiptCount };
}

export async function deleteBoard(boardId: string): Promise<boolean> {
  const board = await boards.get(boardId);
  const boardCards = (await cards.list()).filter((c) => c.boardId === boardId);
  for (const card of boardCards) await deleteCard(card.id);
  if (board) await deleteWorkItemsForBoard(board.tenantId, boardId);
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
  /** Internal core projection link; only `applyBoardCommand` should supply it. */
  workItemId?: string;
  sourceConversationId?: string;
  /** ADR 0311 — a caller-supplied DETERMINISTIC id (the `createDocument`
   *  precedent): an identical retried create returns the existing card instead
   *  of minting a duplicate. Omit for the normal random id. */
  cardId?: string;
}): Promise<KanbanCard> {
  if (input.cardId) {
    const prior = await cards.get(input.cardId);
    if (prior && prior.boardId === input.boardId) return prior;
    // Grade-pass fix GC-0311-1: a caller-supplied id that exists on a DIFFERENT
    // board must never fall through to the put below — that would silently
    // OVERWRITE the other board's card. Fail closed instead.
    if (prior) throw new Error(`cardId collision: ${input.cardId} already exists on another board`);
  }
  const id = input.cardId ?? `card-${randomUUID()}`;
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
    sourceConversationId: input.sourceConversationId,
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
    ...(input.workItemId !== undefined ? { workItemId: input.workItemId } : {}),
    version: 1,
    order: nextCardOrder(siblings),
    createdAt: now,
    updatedAt: now,
  };
  if (!input.cardId) {
    await cards.put(card);
    return card;
  }
  if (await cards.putIfAbsent(card)) return card;
  const winner = await cards.get(id);
  if (winner && winner.boardId === input.boardId) return winner;
  throw new Error(`cardId collision: ${id} could not be created safely`);
}

function boardCommandError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Fractional ranks let one card move/reorder with one CAS. They are derived
 * only from cards in the same board/lane, so this stays reusable for any
 * canvas and never requires a feature-specific ordered-list store. */
function nextCardOrder(siblings: readonly KanbanCard[]): number {
  if (siblings.length === 0) return 1;
  return Math.max(...siblings.map((card) => card.order)) + 1;
}

function cardOrderAtAnchor(
  siblings: readonly KanbanCard[],
  beforeCardId: string | undefined,
  afterCardId: string | undefined,
): number {
  if (beforeCardId !== undefined && afterCardId !== undefined) {
    throw boardCommandError('kanban_position_invalid', 'Choose either beforeCardId or afterCardId, not both.');
  }
  const ordered = [...siblings].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  if (beforeCardId === undefined && afterCardId === undefined) return nextCardOrder(ordered);
  const anchorId = beforeCardId ?? afterCardId!;
  const anchorIndex = ordered.findIndex((candidate) => candidate.id === anchorId);
  if (anchorIndex < 0) {
    throw boardCommandError('kanban_position_invalid', 'The placement anchor is not in the destination column.');
  }
  if (beforeCardId !== undefined) {
    const previous = ordered[anchorIndex - 1];
    return previous ? (previous.order + ordered[anchorIndex]!.order) / 2 : ordered[anchorIndex]!.order - 1;
  }
  const next = ordered[anchorIndex + 1];
  return next ? (ordered[anchorIndex]!.order + next.order) / 2 : ordered[anchorIndex]!.order + 1;
}

const WORK_SCOPE_KIND = /^[a-z][a-z0-9.-]{0,63}$/;
const WORK_SOURCE_KIND = /^[a-z][a-z0-9.-]{0,63}$/;

function stableWorkIdentity(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

const KANBAN_OPERATION_LEASE_MS = 30_000;
/** Completed receipts replay a caller's first result across restarts, but are
 * not an unbounded audit log. Keep the bounded replay window long enough for
 * workflow retries and then compact them through the daemon. */
const KANBAN_OPERATION_RECEIPT_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;

function operationReceiptId(tenantId: string, operation: string, idempotencyKey: string): string {
  return `kanban-operation-${stableWorkIdentity([tenantId, operation, idempotencyKey])}`;
}

/** Reserve a tenant-scoped operation before its side effects run. A caller that
 * repeats an already-completed key receives its first result; a second live
 * caller receives an explicit retry point rather than a second mutation. */
export async function reserveKanbanOperation(
  tenantId: string,
  operation: string,
  idempotencyKey: string,
  payloadFingerprint: string,
  now: number = Date.now(),
): Promise<KanbanOperationReservation> {
  if (!tenantId || !operation || !idempotencyKey) {
    throw boardCommandError('kanban_idempotency_invalid', 'Kanban operation idempotency requires tenant, operation, and key.');
  }
  const receiptId = operationReceiptId(tenantId, operation, idempotencyKey);
  const payloadHash = stableWorkIdentity([operation, payloadFingerprint]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await operationReceipts.get(receiptId);
    if (existing) {
      if (existing.tenantId !== tenantId || existing.operation !== operation || existing.payloadHash !== payloadHash) {
        throw boardCommandError('kanban_idempotency_conflict', 'An idempotency key cannot be reused for different Kanban work.');
      }
      if (existing.status === 'completed' && existing.result) return { kind: 'completed', result: existing.result };
      if (existing.claimExpiresAt && Date.parse(existing.claimExpiresAt) > now) {
        return { kind: 'in-progress', retryAt: existing.claimExpiresAt };
      }
      const claimToken = randomUUID();
      const next: KanbanOperationReceipt = {
        ...existing,
        status: 'claimed',
        claimToken,
        claimExpiresAt: new Date(now + KANBAN_OPERATION_LEASE_MS).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      if (await operationReceipts.compareAndSwap(existing, next)) return { kind: 'claimed', receiptId, claimToken };
      continue;
    }
    const claimToken = randomUUID();
    const stamped = new Date(now).toISOString();
    const receipt: KanbanOperationReceipt = {
      receiptId,
      tenantId,
      operation,
      payloadHash,
      status: 'claimed',
      claimToken,
      claimExpiresAt: new Date(now + KANBAN_OPERATION_LEASE_MS).toISOString(),
      createdAt: stamped,
      updatedAt: stamped,
    };
    if (await operationReceipts.putIfAbsent(receipt)) return { kind: 'claimed', receiptId, claimToken };
  }
  throw boardCommandError('kanban_idempotency_busy', 'Kanban operation contention did not settle. Retry shortly.');
}

/** Complete only the exact reservation holder. The operation's result becomes
 * the restart-safe answer for every subsequent invocation with this key. */
export async function completeKanbanOperation(
  receiptId: string,
  claimToken: string,
  result: Record<string, unknown>,
  now: number = Date.now(),
): Promise<boolean> {
  const current = await operationReceipts.get(receiptId);
  if (!current || current.status !== 'claimed' || current.claimToken !== claimToken) return false;
  const next: KanbanOperationReceipt = {
    ...current,
    status: 'completed',
    result,
    claimToken: undefined,
    claimExpiresAt: undefined,
    updatedAt: new Date(now).toISOString(),
  };
  return operationReceipts.compareAndSwap(current, next);
}

/** Compact old completed idempotency receipts. Claimed rows are deliberately
 * retained: their persisted lease is the cross-instance recovery mechanism.
 * The bounded sweep is safe to run from every replica because delete is
 * idempotent and a newer row cannot share this deterministic receipt id. */
export async function sweepExpiredKanbanOperationReceipts(
  now: number = Date.now(),
  limit: number = 100,
): Promise<number> {
  const cutoff = now - KANBAN_OPERATION_RECEIPT_RETENTION_MS;
  const expired = (await operationReceipts.list())
    .filter((receipt) => receipt.status === 'completed' && Date.parse(receipt.updatedAt) <= cutoff)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.receiptId.localeCompare(b.receiptId))
    .slice(0, limit);
  // A receipt is an operation record, not merely a cache entry. Resolve all
  // legal holds before deleting anything so an unreadable hold store fails
  // closed for this bounded batch rather than partially compacting it.
  const heldTenants = new Map<string, boolean>();
  const deletable: KanbanOperationReceipt[] = [];
  for (const receipt of expired) {
    let held = heldTenants.get(receipt.tenantId);
    if (held === undefined) {
      held = (await getRetentionHold(receipt.tenantId)) !== null;
      heldTenants.set(receipt.tenantId, held);
    }
    if (!held) deletable.push(receipt);
  }
  let deleted = 0;
  for (const receipt of deletable) if (await operationReceipts.delete(receipt.receiptId)) deleted += 1;
  return deleted;
}

function assertWorkScope(scope: KanbanWorkScope): void {
  if (!WORK_SCOPE_KIND.test(scope.kind)) {
    throw boardCommandError('kanban_scope_invalid', 'Work scope kind must be a lower-case, namespaced identifier.');
  }
  if (scope.externalRef !== undefined && (scope.externalRef.length === 0 || scope.externalRef.length > 512)) {
    throw boardCommandError('kanban_scope_invalid', 'Work scope externalRef must be between 1 and 512 characters.');
  }
  WORK_SCOPE_REGISTRATIONS.get(scope.kind)?.validate?.(scope);
}

function assertWorkSource(source: KanbanWorkSource): void {
  if (!WORK_SOURCE_KIND.test(source.kind) || source.id.trim().length === 0 || source.id.length > 512) {
    throw boardCommandError('kanban_source_invalid', 'Work source must have a namespaced kind and stable id.');
  }
  if (source.revision !== undefined && (source.revision.length === 0 || source.revision.length > 256)) {
    throw boardCommandError('kanban_source_invalid', 'Work source revision must be between 1 and 256 characters.');
  }
}

function stateForWorkItem(board: KanbanBoard, columnId: string, dependencyIds: readonly string[]): KanbanWorkItemState {
  if (isTerminalColumn(board, columnId)) {
    return board.columns.find((column) => column.id === columnId)?.terminalKind === 'cancellation'
      ? 'cancelled'
      : 'completed';
  }
  return dependencyIds.length > 0 ? 'proposed' : 'ready';
}

function executionForProposal(proposal: KanbanWorkItemProposal): KanbanWorkItemExecution {
  const mode = proposal.execution?.mode ?? 'manual';
  const maxAttempts = proposal.execution?.maxAttempts ?? 3;
  if ((mode !== 'manual' && mode !== 'auto') || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw boardCommandError('kanban_execution_invalid', `Work item '${proposal.key}' has an invalid execution policy.`);
  }
  if (mode === 'auto' && !proposal.workflowId) {
    throw boardCommandError('kanban_execution_invalid', `Auto-dispatched work item '${proposal.key}' needs a workflow binding.`);
  }
  return { mode, maxAttempts, attempts: 0, status: 'idle' };
}

function assertAcyclicProposal(items: readonly KanbanWorkItemProposal[]): void {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const visiting = new Set<string>();
  const complete = new Set<string>();
  const visit = (key: string): void => {
    if (complete.has(key)) return;
    if (visiting.has(key)) throw boardCommandError('kanban_dependency_cycle', `Work proposal contains a dependency cycle at '${key}'.`);
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOnKeys ?? []) visit(dependency);
    visiting.delete(key);
    complete.add(key);
  };
  for (const item of items) visit(item.key);
}

interface PreparedWorkItem {
  proposal: KanbanWorkItemProposal;
  workItemId: string;
  cardId: string;
  dependencyIds: string[];
}

/** Validate and create the deterministic proposal shape before a command writes
 * anything. That makes malformed or cyclic materializations atomic from the
 * caller's perspective even though the durable KV backend is per-record. */
function prepareWorkItems(
  board: KanbanBoard,
  command: MaterializeKanbanWorkItemsCommand,
): PreparedWorkItem[] {
  if (command.items.length === 0 || command.items.length > 100) {
    throw boardCommandError('kanban_work_items_invalid', 'A materialization must contain between 1 and 100 work items.');
  }
  const keys = new Set<string>();
  for (const item of command.items) {
    if (item.key.trim().length === 0 || item.key.length > 160 || keys.has(item.key)) {
      throw boardCommandError('kanban_work_items_invalid', 'Every work item must have a unique stable key.');
    }
    if (item.title.trim().length === 0 || item.title.length > 500) {
      throw boardCommandError('kanban_work_items_invalid', `Work item '${item.key}' needs a title of at most 500 characters.`);
    }
    if (!board.columns.some((column) => column.id === item.columnId)) {
      throw boardCommandError('kanban_column_not_found', `Work item '${item.key}' names an unknown board column.`);
    }
    executionForProposal(item);
    if (item.dependsOnKeys?.some((dependency) => dependency === item.key || !command.items.some((candidate) => candidate.key === dependency))) {
      throw boardCommandError('kanban_dependency_invalid', `Work item '${item.key}' has an unknown or self dependency.`);
    }
    keys.add(item.key);
  }
  assertAcyclicProposal(command.items);
  const identity = (key: string): string => stableWorkIdentity([
    command.tenantId,
    command.boardId,
    command.scope.kind,
    command.scope.externalRef ?? '',
    command.source.kind,
    command.source.id,
    command.source.revision ?? '',
    key,
  ]);
  const ids = new Map(command.items.map((item) => [item.key, `work-${identity(item.key)}`]));
  return command.items.map((proposal) => {
    const workItemId = ids.get(proposal.key);
    if (!workItemId) throw boardCommandError('kanban_work_items_invalid', `No identity was produced for '${proposal.key}'.`);
    return {
      proposal,
      workItemId,
      cardId: `card-work-${stableWorkIdentity([command.tenantId, command.boardId, workItemId])}`,
      dependencyIds: (proposal.dependsOnKeys ?? []).map((key) => ids.get(key) ?? ''),
    };
  });
}

function sameWorkIdentity(existing: KanbanWorkItem, candidate: KanbanWorkItem): boolean {
  return existing.tenantId === candidate.tenantId
    && existing.boardId === candidate.boardId
    && existing.cardId === candidate.cardId
    && existing.sourceKey === candidate.sourceKey
    && existing.scope.kind === candidate.scope.kind
    && existing.scope.externalRef === candidate.scope.externalRef
    && existing.source.kind === candidate.source.kind
    && existing.source.id === candidate.source.id
    && existing.source.revision === candidate.source.revision
    && existing.workflowId === candidate.workflowId
    && existing.execution.mode === candidate.execution.mode
    && existing.execution.maxAttempts === candidate.execution.maxAttempts
    && existing.dependencyIds.length === candidate.dependencyIds.length
    && existing.dependencyIds.every((dependencyId, index) => dependencyId === candidate.dependencyIds[index]);
}

async function recordWorkItemCommandEvent(
  item: KanbanWorkItem,
  type: KanbanWorkItemAuditEntry['type'],
  at: string,
  metadata: Record<string, unknown>,
  availableAt: string = at,
): Promise<void> {
  const eventIdentity = stableWorkIdentity([item.workItemId, type, String(item.version)]);
  await workItemAudit.putIfAbsent({
    auditId: `work-audit-${eventIdentity}`,
    tenantId: item.tenantId,
    boardId: item.boardId,
    workItemId: item.workItemId,
    type,
    at,
    metadata,
  });
  await workItemOutbox.putIfAbsent({
    eventId: `work-outbox-${eventIdentity}`,
    tenantId: item.tenantId,
    boardId: item.boardId,
    workItemId: item.workItemId,
    type,
    status: 'pending',
    attempts: 0,
    availableAt,
    createdAt: at,
    updatedAt: at,
  });
}

/** The core, canvas-neutral command boundary. Overloads retain an exact result
 * for each command while making the implementation's exhaustive command switch
 * visible to every core caller. */
export function applyBoardCommand(command: MaterializeKanbanWorkItemsCommand): Promise<MaterializeKanbanWorkItemsResult>;
export function applyBoardCommand(command: PatchKanbanCardCommand): Promise<PatchKanbanCardResult>;
/** Reviewed-plan materialization uses deterministic aggregate/card/event ids
 * and `putIfAbsent` so a retry after any partial durable write converges without
 * duplicate work or delivery. `dryRun` validates and projects exactly the
 * records that a real command would create, but writes nothing. */
export async function applyBoardCommand(
  command: KanbanBoardCommand,
): Promise<MaterializeKanbanWorkItemsResult | PatchKanbanCardResult> {
  if (command.type === 'card.patch') return applyKanbanCardPatchCommand(command);
  if (command.type !== 'work-items.materialize') {
    throw boardCommandError('kanban_command_unknown', 'Unsupported Kanban board command.');
  }
  if (command.tenantId.trim().length === 0 || command.idempotencyKey.trim().length === 0) {
    throw boardCommandError('kanban_command_invalid', 'Materialization requires tenant and idempotency keys.');
  }
  assertWorkScope(command.scope);
  assertWorkSource(command.source);
  const board = await boards.get(command.boardId);
  if (!board || board.tenantId !== command.tenantId) {
    throw boardCommandError('kanban_board_not_found', 'Board does not exist in this tenant.');
  }
  const prepared = prepareWorkItems(board, command);
  const now = nowIso();
  const projectedWorkItems = prepared.map(({ proposal, workItemId, cardId, dependencyIds }, order) => ({
    workItemId,
    tenantId: command.tenantId,
    boardId: command.boardId,
    cardId,
    scope: { ...command.scope },
    source: { ...command.source },
    sourceKey: proposal.key,
    dependencyIds,
    ...(proposal.workflowId ? { workflowId: proposal.workflowId } : {}),
    ...(proposal.input ? { input: proposal.input } : {}),
    execution: executionForProposal(proposal),
    state: stateForWorkItem(board, proposal.columnId, dependencyIds),
    order,
    version: 1,
    createdAt: now,
    updatedAt: now,
  } satisfies KanbanWorkItem));
  const projectedCards = prepared.map(({ proposal, cardId, workItemId, dependencyIds }) => ({
    id: cardId,
    boardId: command.boardId,
    columnId: proposal.columnId,
    title: proposal.title,
    ...(proposal.description !== undefined ? { description: proposal.description } : {}),
    ...(proposal.workflowId ? { workflowId: proposal.workflowId } : {}),
    source: 'workflow' as const,
    ...(proposal.priority ? { priority: proposal.priority } : {}),
    ...(proposal.dueAt ? { dueAt: proposal.dueAt } : {}),
    dependsOn: dependencyIds.map((dependencyId) => prepared.find((item) => item.workItemId === dependencyId)?.cardId ?? ''),
    workItemId,
    order: 0,
    createdAt: now,
    updatedAt: now,
  } satisfies KanbanCard));

  if (command.dryRun) return { dryRun: true, workItems: projectedWorkItems, cards: projectedCards };

  const materializedWorkItems: KanbanWorkItem[] = [];
  const materializedCards: KanbanCard[] = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const plan = prepared[index]!;
    const candidate = projectedWorkItems[index]!;
    // Check the projection before introducing its aggregate. A prior card with
    // this deterministic id can be a legitimate retry only when it names this
    // exact aggregate; otherwise fail without leaving a newly-created orphan.
    const existingCard = await cards.get(candidate.cardId);
    if (existingCard && (existingCard.boardId !== command.boardId || existingCard.workItemId !== candidate.workItemId)) {
      throw boardCommandError('kanban_card_collision', `Card for work item '${plan.proposal.key}' is already owned by different work.`);
    }
    const inserted = await workItems.putIfAbsent(candidate);
    const item = inserted ? candidate : await workItems.get(candidate.workItemId);
    if (!item || !sameWorkIdentity(item, candidate)) {
      throw boardCommandError('kanban_work_item_collision', `Work item '${plan.proposal.key}' already belongs to a different source.`);
    }
    const card = await createCard({
      boardId: command.boardId,
      columnId: plan.proposal.columnId,
      title: plan.proposal.title,
      ...(plan.proposal.description !== undefined ? { description: plan.proposal.description } : {}),
      ...(plan.proposal.workflowId ? { workflowId: plan.proposal.workflowId } : {}),
      source: 'workflow',
      ...(plan.proposal.priority ? { priority: plan.proposal.priority } : {}),
      ...(plan.proposal.dueAt ? { dueAt: plan.proposal.dueAt } : {}),
      dependsOn: projectedCards[index]!.dependsOn,
      workItemId: item.workItemId,
      cardId: item.cardId,
    });
    if (card.workItemId !== item.workItemId) {
      throw boardCommandError('kanban_card_collision', `Card for work item '${plan.proposal.key}' is already owned by different work.`);
    }
    await recordWorkItemCommandEvent(item, 'work-item.materialized', item.createdAt, {
      sourceKind: item.source.kind,
      sourceId: item.source.id,
      sourceRevision: item.source.revision ?? null,
      sourceKey: item.sourceKey,
      idempotencyKey: command.idempotencyKey,
    });
    materializedWorkItems.push(item);
    materializedCards.push(card);
  }
  notifyBoardChanged(command.boardId);
  return { dryRun: false, workItems: materializedWorkItems, cards: materializedCards };
}

function applyKanbanCardPatch(card: KanbanCard, patch: KanbanCardPatch): KanbanCard {
  const next: KanbanCard = { ...card };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.workflowId !== undefined) next.workflowId = patch.workflowId;
  if (patch.lastRunId !== undefined) next.lastRunId = patch.lastRunId;
  if (patch.source !== undefined) next.source = patch.source;
  if (patch.sourceLabel !== undefined) next.sourceLabel = patch.sourceLabel;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.dueAt !== undefined) next.dueAt = patch.dueAt;
  if (patch.createdBy !== undefined) next.createdBy = patch.createdBy;
  if (patch.assignmentReason !== undefined) next.assignmentReason = patch.assignmentReason;
  if (patch.blockerNote !== undefined) next.blockerNote = patch.blockerNote;
  if (patch.assigneeId === null) delete next.assigneeId;
  else if (patch.assigneeId !== undefined) next.assigneeId = patch.assigneeId;
  if (patch.assigneeRole === null) delete next.assigneeRole;
  else if (patch.assigneeRole !== undefined) next.assigneeRole = patch.assigneeRole;
  if (patch.estimateHours !== undefined) next.estimateHours = patch.estimateHours;
  if (patch.labels !== undefined) next.labels = patch.labels;
  if (patch.dependsOn !== undefined) next.dependsOn = patch.dependsOn;
  return next;
}

/**
 * Apply one complete card intent under a CAS. Validation happens before the
 * write and the move is folded into the same replacement row, which avoids the
 * old "fields persisted, destination rejected" partial success. The service is
 * deliberately canvas-neutral: it only knows a board/card and returns an
 * optional normal workflow trigger for the caller's existing delivery bridge.
 */
async function applyKanbanCardPatchCommand(command: PatchKanbanCardCommand): Promise<PatchKanbanCardResult> {
  if (!command.tenantId || !command.boardId || !command.cardId) {
    throw boardCommandError('kanban_command_invalid', 'Card mutations require a tenant, board, and card.');
  }
  if (command.patch.title !== undefined && command.patch.title.trim().length === 0) {
    throw boardCommandError('kanban_card_invalid', 'Card title must be a non-empty string.');
  }
  if (command.beforeCardId !== undefined && command.beforeCardId === command.cardId
    || command.afterCardId !== undefined && command.afterCardId === command.cardId) {
    throw boardCommandError('kanban_position_invalid', 'A card cannot be its own placement anchor.');
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [board, card] = await Promise.all([boards.get(command.boardId), cards.get(command.cardId)]);
    if (!board || board.tenantId !== command.tenantId || !card || card.boardId !== board.id) {
      throw boardCommandError('kanban_card_not_found', 'Card does not exist on this board in this tenant.');
    }
    const targetColumnId = command.columnId ?? card.columnId;
    const destination = board.columns.find((column) => column.id === targetColumnId);
    if (!destination) {
      throw boardCommandError('kanban_column_not_found', 'Destination column does not exist on this board.');
    }
    const moved = targetColumnId !== card.columnId;
    const repositioned = command.beforeCardId !== undefined || command.afterCardId !== undefined;
    const hasPatch = Object.values(command.patch).some((value) => value !== undefined);
    if (!moved && !repositioned && !hasPatch) return { card, trigger: null };

    const next = applyKanbanCardPatch(card, command.patch);
    const at = nowIso();
    next.columnId = targetColumnId;
    if (moved || repositioned) {
      const siblings = (await cards.list())
        .filter((candidate) => candidate.boardId === board.id && candidate.columnId === targetColumnId && candidate.id !== card.id);
      next.order = cardOrderAtAnchor(siblings, command.beforeCardId, command.afterCardId);
    }
    if (moved) {
      if (isTerminalColumn(board, targetColumnId)) {
        if (!next.completedAt) next.completedAt = at;
      } else {
        delete next.completedAt;
      }
    }
    next.version = (card.version ?? 0) + 1;
    next.updatedAt = at;
    if (!await cards.compareAndSwap(card, next)) continue;

    // Only a lane transition changes the card-derived WorkItem lifecycle.
    // Persisting run attribution, an assignment, or an in-lane rank through
    // this command must never turn an actively-running item back into `ready`.
    if (moved) {
      await syncWorkItemStateFromCard(board, next);
      if (next.workItemId) await reconcileDependentWorkItemStates(board, next.workItemId);
    }
    const workflowId = moved ? next.workflowId ?? destination.triggerWorkflowId : undefined;
    const trigger = workflowId
      ? { workflowId, boardId: board.id, cardId: next.id, fromColumnId: card.columnId, toColumnId: targetColumnId }
      : null;
    notifyBoardChanged(board.id);
    return { card: next, trigger };
  }
  throw boardCommandError('kanban_card_conflict', 'The card changed concurrently. Refresh and try again.');
}

export async function getWorkItem(workItemId: string): Promise<KanbanWorkItem | null> {
  return workItems.get(workItemId);
}

export async function listWorkItemsForBoard(tenantId: string, boardId: string): Promise<KanbanWorkItem[]> {
  return (await workItems.listForTenantIndexed(tenantId))
    .filter((item) => item.boardId === boardId)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.workItemId.localeCompare(b.workItemId));
}

/**
 * Bounded, input-free board read. The tenant index carries this projection, so
 * an operational board page avoids decoding every workflow input owned by the
 * tenant. This is read-only: mutations must use the authoritative aggregate.
 */
export async function listWorkItemProjectionsForBoard(
  tenantId: string,
  boardId: string,
): Promise<KanbanWorkItemProjection[]> {
  return (await workItems.listForTenantProjected(tenantId))
    .filter(isKanbanWorkItemProjection)
    .filter((item) => item.boardId === boardId)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.workItemId.localeCompare(b.workItemId));
}

export async function listPendingWorkItemOutbox(tenantId: string): Promise<KanbanWorkItemOutboxEntry[]> {
  return (await workItemOutbox.listForTenantIndexed(tenantId))
    .filter((entry) => entry.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const WORK_ITEM_OUTBOX_LEASE_MS = 30_000;
const WORK_ITEM_EXECUTION_LEASE_MS = 45_000;
const WORK_ITEM_RETRY_DELAY_MS = 10_000;

/** A row claimed by a Kanban worker. The lease is persisted on the row, so a
 * crashed instance cannot permanently strand an eligible item. */
export interface ClaimedKanbanWorkItemOutbox {
  entry: KanbanWorkItemOutboxEntry;
  workerId: string;
}

export type WorkItemExecutionClaim =
  | { kind: 'started'; item: KanbanWorkItem; card: KanbanCard; runId: string }
  | { kind: 'skip' }
  | { kind: 'defer'; availableAt: string };

/** Claim a bounded ready batch from the generic work outbox. `DurableCollection`
 * CAS is the cross-instance arbiter; scanning is intentionally bounded while
 * Phase 6 adds storage-native due indexes. */
export async function claimDueWorkItemOutbox(
  workerId: string,
  now: number = Date.now(),
  limit: number = 25,
): Promise<ClaimedKanbanWorkItemOutbox[]> {
  const nowIsoValue = new Date(now).toISOString();
  const expiresAt = new Date(now + WORK_ITEM_OUTBOX_LEASE_MS).toISOString();
  const entries = await workItemOutbox.list();
  const candidates = entries
    .filter((entry) => entry.status === 'pending' && Date.parse(entry.availableAt) <= now)
    .concat(entries
      .filter((entry) => entry.status === 'claimed' && entry.claimExpiresAt !== undefined && Date.parse(entry.claimExpiresAt) <= now))
    .sort((a, b) => a.availableAt.localeCompare(b.availableAt) || a.eventId.localeCompare(b.eventId))
    .slice(0, limit * 3);
  const claimed: ClaimedKanbanWorkItemOutbox[] = [];
  const seen = new Set<string>();
  for (const entry of candidates) {
    if (claimed.length >= limit || seen.has(entry.eventId)) continue;
    seen.add(entry.eventId);
    const next: KanbanWorkItemOutboxEntry = {
      ...entry,
      status: 'claimed',
      attempts: entry.attempts + 1,
      claimedBy: workerId,
      claimExpiresAt: expiresAt,
      updatedAt: nowIsoValue,
    };
    if (await workItemOutbox.compareAndSwap(entry, next)) claimed.push({ entry: next, workerId });
  }
  return claimed;
}

/** Complete a claimed delivery only when this worker still holds its lease. */
export async function completeWorkItemOutbox(
  claimed: ClaimedKanbanWorkItemOutbox,
  now: number = Date.now(),
): Promise<boolean> {
  const current = await workItemOutbox.get(claimed.entry.eventId);
  if (!current || current.status !== 'claimed' || current.claimedBy !== claimed.workerId) return false;
  const { claimedBy: _worker, claimExpiresAt: _lease, ...rest } = current;
  return workItemOutbox.compareAndSwap(current, {
    ...rest,
    status: 'delivered',
    updatedAt: new Date(now).toISOString(),
  });
}

/** Put a claimed delivery back on the durable queue. Exhausted delivery errors
 * are visible as a dead letter instead of being silently dropped. */
export async function rescheduleWorkItemOutbox(
  claimed: ClaimedKanbanWorkItemOutbox,
  options: { availableAt: number; error?: string; deadLetter?: boolean },
  now: number = Date.now(),
): Promise<boolean> {
  const current = await workItemOutbox.get(claimed.entry.eventId);
  if (!current || current.status !== 'claimed' || current.claimedBy !== claimed.workerId) return false;
  const { claimedBy: _worker, claimExpiresAt: _lease, ...rest } = current;
  return workItemOutbox.compareAndSwap(current, {
    ...rest,
    status: options.deadLetter === true ? 'dead-lettered' : 'pending',
    availableAt: new Date(options.availableAt).toISOString(),
    ...(options.error ? { lastError: options.error.slice(0, 500) } : {}),
    updatedAt: new Date(now).toISOString(),
  });
}

function deterministicWorkItemRunId(workItemId: string, attempt: number): string {
  return `kanban-work-run-${stableWorkIdentity([workItemId, String(attempt)])}`;
}

async function workItemReadyState(board: KanbanBoard, item: KanbanWorkItem, card: KanbanCard): Promise<KanbanWorkItemState> {
  if (isTerminalColumn(board, card.columnId)) return stateForWorkItem(board, card.columnId, item.dependencyIds);
  if (item.dependencyIds.length === 0) return 'ready';
  const dependencies = await Promise.all(item.dependencyIds.map((id) => workItems.get(id)));
  return dependencies.every((dependency) => dependency?.state === 'completed') ? 'ready' : 'proposed';
}

async function autoDispatchWipAvailable(board: KanbanBoard, item: KanbanWorkItem, card: KanbanCard): Promise<boolean> {
  const column = board.columns.find((candidate) => candidate.id === card.columnId);
  if (column?.wipLimit === undefined) return true;
  const sameLane = (await workItems.listForTenantIndexed(item.tenantId))
    .filter((candidate) => candidate.boardId === board.id && candidate.workItemId !== item.workItemId)
    .filter((candidate) => candidate.execution.status === 'starting' || candidate.execution.status === 'running');
  let active = 0;
  for (const candidate of sameLane) {
    const candidateCard = await cards.get(candidate.cardId);
    if (candidateCard?.columnId === card.columnId) active += 1;
  }
  return active < column.wipLimit;
}

/** Atomically reserve a ready WorkItem for a normal workflow run. `auto` is
 * used by the worker; `manual` is the same reusable seam for a future UI/API
 * command. The deterministic run id makes an expired execution lease safe to
 * retry without creating a parallel run. */
export async function claimEligibleWorkItemExecution(
  tenantId: string,
  workItemId: string,
  workerId: string,
  mode: 'auto' | 'manual' = 'auto',
  now: number = Date.now(),
): Promise<WorkItemExecutionClaim> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const item = await workItems.get(workItemId);
    if (!item || item.tenantId !== tenantId || !item.workflowId) return { kind: 'skip' };
    // Execution policy is an explicit part of the reviewed WorkItem contract.
    // A human may operate a `manual` item and the worker may operate an `auto`
    // item, but a caller cannot use the generic endpoint to silently override
    // the policy selected in the builder-editable materializer.
    if (item.execution.mode !== mode) return { kind: 'skip' };
    const [board, card] = await Promise.all([boards.get(item.boardId), cards.get(item.cardId)]);
    if (!board || board.tenantId !== tenantId || !card || card.boardId !== board.id) return { kind: 'skip' };
    const execution = item.execution;
    const leaseLive = execution.status === 'starting'
      && execution.claimExpiresAt !== undefined
      && Date.parse(execution.claimExpiresAt) > now;
    if (leaseLive) return { kind: 'defer', availableAt: execution.claimExpiresAt! };
    if (execution.status === 'running' || execution.status === 'succeeded' || item.state === 'completed' || item.state === 'cancelled') {
      return { kind: 'skip' };
    }
    const ready = await workItemReadyState(board, item, card);
    const resumingLease = execution.status === 'starting' && !leaseLive;
    if (ready !== 'ready' && !resumingLease) return { kind: 'skip' };
    if (!resumingLease && execution.attempts >= execution.maxAttempts) return { kind: 'skip' };
    if (mode === 'auto' && !resumingLease && !(await autoDispatchWipAvailable(board, item, card))) {
      return { kind: 'defer', availableAt: new Date(now + WORK_ITEM_RETRY_DELAY_MS).toISOString() };
    }
    const runAttempt = resumingLease ? execution.attempts : execution.attempts + 1;
    const runId = resumingLease
      ? execution.runId ?? deterministicWorkItemRunId(item.workItemId, runAttempt)
      : deterministicWorkItemRunId(item.workItemId, runAttempt);
    const next: KanbanWorkItem = {
      ...item,
      state: 'running',
      execution: {
        mode: execution.mode,
        maxAttempts: execution.maxAttempts,
        status: 'starting',
        attempts: runAttempt,
        runId,
        claimToken: workerId,
        claimExpiresAt: new Date(now + WORK_ITEM_EXECUTION_LEASE_MS).toISOString(),
      },
      version: item.version + 1,
      updatedAt: new Date(now).toISOString(),
    };
    if (await workItems.compareAndSwap(item, next)) return { kind: 'started', item: next, card, runId };
  }
  return { kind: 'defer', availableAt: new Date(now + WORK_ITEM_RETRY_DELAY_MS).toISOString() };
}

/** Persist the returned normal run on the aggregate and its shared card
 * projection. This is idempotent: a second worker may only record the exact
 * deterministic run id reserved by the prior lease holder. */
export async function markWorkItemExecutionStarted(
  tenantId: string,
  workItemId: string,
  runId: string,
  now: number = Date.now(),
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const item = await workItems.get(workItemId);
    if (!item || item.tenantId !== tenantId || item.execution.runId !== runId) return false;
    if (item.execution.status === 'running') return true;
    if (item.execution.status !== 'starting') return false;
    const { claimToken: _claim, claimExpiresAt: _expires, ...execution } = item.execution;
    const at = new Date(now).toISOString();
    const next: KanbanWorkItem = {
      ...item,
      state: 'running',
      execution: { ...execution, status: 'running', runId },
      version: item.version + 1,
      updatedAt: at,
    };
    if (await workItems.compareAndSwap(item, next)) {
      await workItemRunIndex.putIfAbsent({ runId, tenantId, workItemId });
      await setCardLastRun(item.cardId, runId);
      await recordWorkItemCommandEvent(next, 'work-item.execution-started', at, { runId, attempt: next.execution.attempts });
      notifyBoardChanged(item.boardId);
      return true;
    }
  }
  return false;
}

/** Release a reserved execution that failed before a normal run existed (for
 * example, its dynamically-selected workflow was unpublished). A real run's
 * terminal state is handled by `settleWorkItemExecutionFromRun` below. */
export async function failWorkItemExecutionReservation(
  tenantId: string,
  workItemId: string,
  runId: string,
  reason: string,
  now: number = Date.now(),
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const item = await workItems.get(workItemId);
    if (!item || item.tenantId !== tenantId || item.execution.runId !== runId || item.execution.status !== 'starting') return false;
    const [board, card] = await Promise.all([boards.get(item.boardId), cards.get(item.cardId)]);
    if (!board || !card || card.boardId !== board.id) return false;
    const retryable = item.execution.mode === 'auto' && item.execution.attempts < item.execution.maxAttempts;
    const at = new Date(now).toISOString();
    const next: KanbanWorkItem = {
      ...item,
      state: retryable ? await workItemReadyState(board, item, card) : 'blocked',
      execution: { ...item.execution, status: 'failed', lastError: reason.slice(0, 500) },
      version: item.version + 1,
      updatedAt: at,
    };
    if (await workItems.compareAndSwap(item, next)) {
      await recordWorkItemCommandEvent(
        next,
        'work-item.execution-settled',
        at,
        { runId, status: 'not-started', reason: reason.slice(0, 500), retryable },
        retryable ? new Date(now + WORK_ITEM_RETRY_DELAY_MS).toISOString() : at,
      );
      notifyBoardChanged(next.boardId);
      return true;
    }
  }
  return false;
}

/** Reconcile a normal workflow terminal event back to its WorkItem. The run
 * lifecycle remains the source of execution truth; Kanban merely updates its
 * durable projection and schedules a bounded retry for explicit auto policy. */
export async function settleWorkItemExecutionFromRun(
  tenantId: string,
  runId: string,
  status: 'completed' | 'failed' | 'cancelled',
  now: number = Date.now(),
): Promise<boolean> {
  const runLink = await workItemRunIndex.get(runId);
  if (!runLink || runLink.tenantId !== tenantId) return false;
  const item = await workItems.get(runLink.workItemId);
  const board = item ? await boards.get(item.boardId) : null;
  if (!item || !board || item.tenantId !== tenantId || item.execution.runId !== runId) return false;
  const card = await cards.get(item.cardId);
  if (!card || card.boardId !== board.id) return false;
  const at = new Date(now).toISOString();

  if (status === 'completed') {
    const terminal = board.columns.find((column) => isTerminalColumn(board, column.id));
    if (terminal && card.columnId !== terminal.id) await moveCard(card.id, terminal.id); // trigger directive intentionally ignored
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await workItems.get(item.workItemId);
    if (!current || current.tenantId !== tenantId || current.execution.runId !== runId) return false;
    const latestCard = await cards.get(current.cardId);
    if (!latestCard) return false;
    const succeeded = status === 'completed';
    const retryable = !succeeded && current.execution.mode === 'auto' && current.execution.attempts < current.execution.maxAttempts;
    const resumedState = succeeded
      ? 'completed'
      : retryable
        ? await workItemReadyState(board, current, latestCard)
        : 'blocked';
    const next: KanbanWorkItem = {
      ...current,
      state: resumedState,
      execution: {
        ...current.execution,
        status: succeeded ? 'succeeded' : 'failed',
        ...(succeeded ? {} : { lastError: `workflow_${status}` }),
      },
      version: current.version + 1,
      updatedAt: at,
    };
    if (await workItems.compareAndSwap(current, next)) {
      await recordWorkItemCommandEvent(
        next,
        'work-item.execution-settled',
        at,
        { runId, status, retryable },
        retryable ? new Date(now + WORK_ITEM_RETRY_DELAY_MS).toISOString() : at,
      );
      notifyBoardChanged(next.boardId);
      return true;
    }
  }
  return false;
}

async function deleteWorkItemRecord(item: KanbanWorkItem): Promise<void> {
  await workItems.delete(item.workItemId);
  for (const entry of await workItemAudit.listForTenantIndexed(item.tenantId)) {
    if (entry.workItemId === item.workItemId) await workItemAudit.delete(entry.auditId);
  }
  for (const entry of await workItemOutbox.listForTenantIndexed(item.tenantId)) {
    if (entry.workItemId === item.workItemId) await workItemOutbox.delete(entry.eventId);
  }
  for (const entry of await workItemRunIndex.listForTenantIndexed(item.tenantId)) {
    if (entry.workItemId === item.workItemId) await workItemRunIndex.delete(entry.runId);
  }
}

async function deleteWorkItemsForCard(tenantId: string, cardId: string): Promise<number> {
  const items = (await workItems.listForTenantIndexed(tenantId)).filter((item) => item.cardId === cardId);
  for (const item of items) await deleteWorkItemRecord(item);
  return items.length;
}

async function deleteWorkItemsForBoard(tenantId: string, boardId: string): Promise<number> {
  const items = (await workItems.listForTenantIndexed(tenantId)).filter((item) => item.boardId === boardId);
  for (const item of items) await deleteWorkItemRecord(item);
  return items.length;
}

/** Keep the optional aggregate aligned with the card projection on every core
 * move. Legacy cards skip this branch entirely; extensions get the same state
 * semantics whether the move originated in a board, a workflow, or a canvas. */
async function syncWorkItemStateFromCard(board: KanbanBoard, card: KanbanCard): Promise<void> {
  if (!card.workItemId) return;
  // A card move can arrive concurrently from another canvas session. Read and
  // CAS the aggregate instead of allowing a get→put last-writer to erase a
  // newer state transition. A later move still reconciles the projection, so a
  // bounded retry is enough to converge without turning this into a process lock.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const item = await workItems.get(card.workItemId);
    if (!item || item.tenantId !== board.tenantId || item.boardId !== board.id || item.cardId !== card.id) return;
    let state = stateForWorkItem(board, card.columnId, item.dependencyIds);
    if (!isTerminalColumn(board, card.columnId) && item.dependencyIds.length > 0) {
      const dependencies = await Promise.all(item.dependencyIds.map((dependencyId) => workItems.get(dependencyId)));
      state = dependencies.every((dependency) => dependency?.state === 'completed') ? 'ready' : 'proposed';
    }
    if (state === item.state) return;
    const at = nowIso();
    const next: KanbanWorkItem = { ...item, state, version: item.version + 1, updatedAt: at };
    if (await workItems.compareAndSwap(item, next)) {
      await recordWorkItemCommandEvent(next, 'work-item.state-changed', at, { state, columnId: card.columnId });
      return;
    }
  }
}

/** A dependency transition can make other items eligible (or re-block them on
 * reopen). Reconcile only items on this board that name the changed aggregate;
 * the tenant index keeps the scan bounded to this tenant's work estate. */
async function reconcileDependentWorkItemStates(board: KanbanBoard, changedWorkItemId: string): Promise<void> {
  const dependents = (await workItems.listForTenantIndexed(board.tenantId))
    .filter((item) => item.boardId === board.id && item.dependencyIds.includes(changedWorkItemId));
  for (const dependent of dependents) {
    const card = await cards.get(dependent.cardId);
    if (card) await syncWorkItemStateFromCard(board, card);
  }
}

export async function updateCardFields(
  cardId: string,
  patch: KanbanCardPatch,
): Promise<KanbanCard | null> {
  const card = await cards.get(cardId);
  const board = card ? await boards.get(card.boardId) : null;
  if (!card || !board) return null;
  return (await applyBoardCommand({
    type: 'card.patch', tenantId: board.tenantId, boardId: board.id, cardId, patch,
  })).card;
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


/**
 * ADR 0667 D5 (PMXWF-10) — the inversion point a board CO-OWNER needs.
 *
 * A kanban card can BE another feature's domain object (a priority-matrix idea IS a
 * card, ADR 0058 "no parallel board"), and that feature keeps overlay rows keyed by the
 * card id plus a KB projection of it. Deleting the card through kanban's own door ran
 * none of that: the overlays orphaned and the deleted idea kept being retrieved from the
 * org's shared KB. PM could not have registered a cascade — there was no registry.
 *
 * **Why not `host/hostEventDispatcher.ts` (ADR 0208), the existing record-change seam?**
 * Its two fanouts are outbound webhooks and tenant-CONFIGURED workflow bindings:
 * asynchronous, at-least-once, unordered, with no failure propagation and no guaranteed
 * subscriber. That can carry a notification; it cannot carry a cascade OBLIGATION. Kanban
 * also emits no host event on card delete today, so there would be nothing to subscribe
 * to even if the semantics fit.
 *
 * **Hooks MUST be idempotent and overlay-only.** `deleteCard` has five callers and THREE
 * of them are priority-matrix's own (`deleteIdea`, `deleteList`, the clone-merge path),
 * so a hook that re-entered the owning feature's card-deleting function would recurse and
 * double-run its cascade. A hook cleans up rows keyed BY the card; it never deletes the
 * card, and running twice must be harmless.
 */
export interface CardDeleteHook { id: string; run: (cardId: string, card: KanbanCard) => Promise<void> }
const CARD_DELETE_HOOKS: CardDeleteHook[] = [];
const log = createLogger('host.kanbanService');

export function registerCardDeleteHook(id: string, run: (cardId: string, card: KanbanCard) => Promise<void>): void {
  const existing = CARD_DELETE_HOOKS.findIndex((h) => h.id === id);
  if (existing >= 0) CARD_DELETE_HOOKS[existing] = { id, run }; // idempotent re-registration (test re-boots)
  else CARD_DELETE_HOOKS.push({ id, run });
}

/**
 * ADR 0667 D5(b) — a registrant may CLAIM a board, so kanban's own delete ROUTE can
 * refuse and point at the owner's door.
 *
 * Deliberately consulted by the route ONLY, never by `deleteBoard` itself: that function
 * is what tenant teardown (`purgeTenantKanban`), the roster cascade, projects and
 * priority-matrix's OWN `deleteList` all call. A refusal inside it would be a gate with
 * no exit — teardown could not complete and PM could not delete its own list.
 */
export interface BoardClaim { feature: string; ownerLabel: string }
const BOARD_CLAIMS: Array<{ id: string; claim: (boardId: string) => Promise<BoardClaim | null> }> = [];

export function registerBoardDeleteGuard(id: string, claim: (boardId: string) => Promise<BoardClaim | null>): void {
  const existing = BOARD_CLAIMS.findIndex((h) => h.id === id);
  if (existing >= 0) BOARD_CLAIMS[existing] = { id, claim };
  else BOARD_CLAIMS.push({ id, claim });
}

/** Returns the first registrant claiming this board, or `null` when none does. */
export async function boardDeleteClaim(boardId: string): Promise<BoardClaim | null> {
  for (const g of BOARD_CLAIMS) {
    const c = await g.claim(boardId);
    if (c) return c;
  }
  return null;
}

export async function deleteCard(cardId: string): Promise<boolean> {
  // The card row is read first and the hooks run AFTER the delete, with the deleted
  // card handed to them. Both halves matter: an overlay owner needs `card.boardId` to
  // find its own rows, and it needs the card to be ALREADY GONE — priority-matrix's KB
  // eviction decides "removed" by the card's absence from the live ranking, so a hook
  // running before the delete would re-index the very doc it is meant to evict.
  //
  // Best-effort per hook: one feature's overlay failure must not strand the card.
  const card = await cards.get(cardId);
  const board = card ? await boards.get(card.boardId) : null;
  const deleted = await cards.delete(cardId);
  if (card) {
    for (const h of CARD_DELETE_HOOKS) {
      try { await h.run(cardId, card); }
      catch (err: unknown) { log.warn('card_delete_hook_failed', { hook: h.id, cardId, error: err instanceof Error ? err.message : String(err) }); }
    }
  }
  if (card && board && deleted) await deleteWorkItemsForCard(board.tenantId, card.id);
  return deleted;
}

/** Record the run a card triggered (set by the route after starting it). */
export async function setCardLastRun(cardId: string, runId: string): Promise<void> {
  await updateCardFields(cardId, { lastRunId: runId });
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
  const board = card ? await boards.get(card.boardId) : null;
  if (!card || !board) return null;
  try {
    return await applyBoardCommand({
      type: 'card.patch', tenantId: board.tenantId, boardId: board.id, cardId, patch: {}, columnId: toColumnId,
    });
  } catch (err) {
    if ((err as { code?: unknown }).code === 'kanban_column_not_found') return null;
    throw err;
  }
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

// ── ADR 0464 P2 — DSAR subject erasure ───────────────────────────────────────
// A card is a structurally-needed row on a SHARED board (deleting it would tear
// a hole in other members' board), so a DSAR ANONYMIZES only the cards the
// erased subject authored (`createdBy`) or is assigned (`assigneeId`) — never
// other people's cards. On those cards the subject-identifier fields
// (`createdBy`/`assigneeId`) AND the free text the subject may have written
// (`title`/`description`/`assignmentReason`/`blockerNote`) are overwritten with
// the sentinel; every other card is left exactly as-is. A BOARD is likewise
// structural (never deleted); a board the erased subject OWNS has its
// `ownerUserId` / user-kind `ownerSubject` anonymized in place (integrator
// ruling — same taxonomy as cards), while agent/roster ownership (`rosterId`,
// agent-kind `ownerSubject`) is preserved (not a person). Cards carry no
// top-level tenant (their tenant is their board's), so the scan joins cards to
// this tenant's boards first. Idempotent; fail-closed on falsy input.

/** DSAR eraser — redact the subject's authored/assigned cards and anonymize any
 *  board they own, tenant-wide. */
export async function eraseSubjectKanban(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  const tenantBoards = (await boards.list()).filter((b) => b.tenantId === tenantId);
  const boardIds = new Set(tenantBoards.map((b) => b.id));
  // Boards the subject owns — anonymize the owner in place (never delete).
  for (const board of tenantBoards) {
    const ownedByUser = (board.ownerUserId !== undefined && forms.has(board.ownerUserId))
      || (board.ownerSubject?.kind === 'user' && forms.has(board.ownerSubject.id));
    if (!ownedByUser) continue;
    const next: KanbanBoard = { ...board, updatedAt: nowIso() };
    if (next.ownerUserId !== undefined && forms.has(next.ownerUserId)) next.ownerUserId = ERASED;
    if (next.ownerSubject?.kind === 'user' && forms.has(next.ownerSubject.id)) next.ownerSubject = { kind: 'user', id: ERASED };
    await boards.put(next);
  }
  for (const card of await cards.list()) {
    if (!boardIds.has(card.boardId)) continue; // cross-tenant / orphaned — never touch
    const mine = (card.assigneeId !== undefined && forms.has(card.assigneeId))
      || (card.createdBy !== undefined && forms.has(card.createdBy));
    if (!mine) continue;
    const next: KanbanCard = { ...card, title: ERASED, updatedAt: nowIso() };
    if (next.assigneeId !== undefined && forms.has(next.assigneeId)) next.assigneeId = ERASED;
    if (next.createdBy !== undefined && forms.has(next.createdBy)) next.createdBy = ERASED;
    if (next.description !== undefined) next.description = ERASED;
    if (next.assignmentReason !== undefined) next.assignmentReason = ERASED;
    if (next.blockerNote !== undefined) next.blockerNote = ERASED;
    await cards.put(next);
  }
}

/** Register the kanban DSAR eraser (idempotent — the seam dedupes by reference).
 *  Called from the host-erasers boot step (host/hostSubjectErasers.ts). */
export function registerKanbanErasure(): void {
  registerSubjectEraser(eraseSubjectKanban);
}

/** Test-only: drop all boards, cards, work aggregates and delivery records. */
export async function __resetKanbanStore(): Promise<void> {
  await boards.__clear();
  await cards.__clear();
  await workItems.__clear();
  await workItemAudit.__clear();
  await workItemOutbox.__clear();
  await workItemRunIndex.__clear();
  await operationReceipts.__clear();
}
