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

import type { HandoffRecordV1 } from './handoff/handoffRecord.js';
import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection, publishHostExtEvent, subscribeHostExtEvent } from './hostExtPersistence.js';
import { onWorkflowForked } from './workflowsRegistry.js';
import { registerTenantIndexAdoption } from './tenantIndexAdoption.js';
import {
  __clearSystemIndexType, afterSystemWrite, beforeSystemWrite, ensureSystemIndexBuilt, familyPrefix, indexedFamilyCount, listIndexPage, registerStoreIndex, resyncSystemRow,
} from '../features/entities/systemIndex.js';
import { casRepoint } from './forkRepoint.js';
import type { Subject } from './subject.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { createLogger } from '../observability/logger.js';
import { ERASED, subjectKeyForms } from './subjectErasureRedaction.js';
import { getRetentionHold } from './retentionHold.js';
import { isWorkspaceMember } from './accessControlService.js';
import { subjectReadAllowed, subjectRoleResolver } from './subjectAccess.js';
import { isPersonalTenantId } from './requestSubject.js';
import { emitAssignmentNotification, withdrawDueNotifications } from './kanbanAssignmentNotify.js';

/** Opaque hold state shared by restore, selection and erasure (ADR 0963 D3). */
export const RESTORE_NOTE_MARK = '[auto:run-restore]';

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
  /** ADR 0872 D1 — the board's tenant, stamped on every write (the card tenant
   *  index key). Absent only on rows written before ADR 0872; the hourly
   *  `stampCardTenants` pass fills those in. */
  tenantId?: string;
  columnId: string;
  title: string;
  description?: string;
  workflowId?: string;
  /** Set to the runId of the most recent run this card triggered. */
  lastRunId?: string;
  /** ADR 0774 D3 — the state of `lastRunId`, durable on the card so it survives
   *  the run row's retention. `running` is written ONLY by the work loop's own
   *  pick claim and approved-proposal dispatch (the proof reconcile needs before
   *  it restores a card whose run row is gone); terminal values are stamped by
   *  the run-terminal seam, guarded on `lastRunId`. Internal: the public card
   *  PATCH never accepts it. */
  lastRunStatus?: KanbanCardRunStatus;
  /** Where this task came from (drives the source chip). Defaults to `human`. */
  source?: KanbanCardSource;
  /** Free-text source detail, e.g. the Discord command or the agent name. */
  sourceLabel?: string;
  /** ADR 1138 D1 — where this card's work actually happens: an APP-RELATIVE path
   *  (`/projects/p1?tab=selections`) and the label for its Open link. Set by the
   *  feature that made the card; never an external URL (no scheme, no `//`). */
  sourceRef?: KanbanCardSourceRef;
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
  /** ADR 0829 P4 — the structured handoff note the assigner wrote when they
   *  handed this card to its current assignee (normalized, `producedBy: 'human'`).
   *  Replaced or cleared on every (re)assignment, so it always describes the
   *  CURRENT handoff. Erased by the DSAR eraser like the card's other free text. */
  handoff?: HandoffRecordV1;
  /** ADR 0829 P4 — who wrote `handoff` (the assigning caller's subject). */
  handoffBy?: string;
  /** ADR 0829 P4 — when `handoff` was written. */
  handoffAt?: string;
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
  /** ADR 1155 D1 — stable grouping keys (`{ stage: 'rough-in', room: 'r-12' }`):
   *  at most {@link FACETS_MAX} keys, each {@link FACET_KEY_RE}, each value
   *  1–{@link FACET_VALUE_MAX} characters. Labels are free tags; facets are what
   *  a board groups and filters by. */
  facets?: KanbanCardFacets;
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

export interface KanbanCardSourceRef { label: string; path: string }

/** ADR 1155 D1 — a card's grouping keys. */
export type KanbanCardFacets = Record<string, string>;
export const FACETS_MAX = 8;
export const FACET_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const FACET_VALUE_MAX = 64;
// Control characters, including the C1 range and the line/paragraph separators.
const FACET_VALUE_BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function facetsInvalid(why: string): Error {
  return boardCommandError('kanban_card_invalid', `Card facets ${why}`);
}

function assertFacetKey(key: string): void {
  if (!FACET_KEY_RE.test(key)) throw facetsInvalid(`need lower-case keys of at most 32 characters ('${key.slice(0, 40)}').`);
}

function assertFacetValue(key: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > FACET_VALUE_MAX || FACET_VALUE_BAD.test(value)) {
    throw facetsInvalid(`'${key}' needs a value of 1–${FACET_VALUE_MAX} characters with no control characters.`);
  }
}

/** ADR 1155 D1 — a complete facet map, validated and copied. Throws `kanban_card_invalid`. */
export function assertFacets(value: unknown): KanbanCardFacets {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw facetsInvalid('must be an object of string values.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > FACETS_MAX) throw facetsInvalid(`can have at most ${FACETS_MAX} keys.`);
  const out: KanbanCardFacets = {};
  for (const [key, v] of entries) {
    assertFacetKey(key);
    assertFacetValue(key, v);
    out[key] = v;
  }
  return out;
}

/** ADR 1155 D1 — a facet PATCH: `null` clears the map; a key set to `null` clears
 *  that key and keeps the rest. Validated here; the key count is checked on the
 *  merged result ({@link mergeFacets}). */
export function assertFacetPatch(value: unknown): Record<string, string | null> | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw facetsInvalid('must be an object, or null to clear them.');
  const out: Record<string, string | null> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    assertFacetKey(key);
    if (v === null) { out[key] = null; continue; }
    assertFacetValue(key, v);
    out[key] = v;
  }
  return out;
}

function mergeFacets(current: KanbanCardFacets | undefined, patch: Record<string, string | null>): KanbanCardFacets | undefined {
  const next: KanbanCardFacets = { ...(current ?? {}) };
  for (const [key, v] of Object.entries(patch)) {
    if (v === null) delete next[key];
    else next[key] = v;
  }
  if (Object.keys(next).length > FACETS_MAX) throw facetsInvalid(`can have at most ${FACETS_MAX} keys.`);
  return Object.keys(next).length > 0 ? next : undefined;
}

function sameFacets(a: KanbanCardFacets | undefined, b: KanbanCardFacets | undefined): boolean {
  const ak = Object.keys(a ?? {});
  return ak.length === Object.keys(b ?? {}).length && ak.every((k) => (b ?? {})[k] === (a ?? {})[k]);
}

const SOURCE_REF_LABEL_MAX = 80;
const SOURCE_REF_PATH_MAX = 512;

/** ADR 1138 D1 — an Open link stays inside the app: a single leading `/`, no
 *  scheme, no protocol-relative `//`, no backslash or whitespace. */
export function assertSourceRef(ref: unknown): asserts ref is KanbanCardSourceRef {
  const r = ref as Partial<KanbanCardSourceRef> | null;
  const ok = !!r && typeof r === 'object'
    && typeof r.label === 'string' && r.label.trim().length > 0 && r.label.length <= SOURCE_REF_LABEL_MAX
    && typeof r.path === 'string' && r.path.length <= SOURCE_REF_PATH_MAX && /^\/(?![\/\\])[^\s\\]*$/.test(r.path);
  if (!ok) {
    throw boardCommandError('kanban_card_invalid', 'A card source link needs a label and an app path that starts with a single "/".');
  }
}

export type KanbanCardRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

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
  /** ADR 1155 D7 — the facet key the board view groups its swimlanes by, by default.
   *  A viewer's own choice rides the URL (`?groupBy=`). */
  groupBy?: string;
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
  /** ADR 0832 D3 — the person whose run materialized this item (its acting user,
   *  else its org-scope subject). The daemon's delivery stamps it as the run's
   *  `orgScopeSubject`, so an auto-dispatched item is bounded by its requester's
   *  orgs. Narrows only. Not part of the work identity (a retry by another
   *  person is the same work) and not projected. */
  requestedBy?: string;
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
  type: 'work-item.materialized' | 'work-item.state-changed' | 'work-item.execution-started' | 'work-item.execution-settled' | 'work-item.delivery-outcome';
  at: string;
  metadata: Record<string, unknown>;
}

/**
 * Closed, canvas-neutral dispositions from the core work-item delivery worker.
 * These are deliberately outcomes, not error strings: the Operations console
 * needs to know whether delivery is progressing without receiving a tenant's
 * workflow input, card content, or failure detail.
 */
export const KANBAN_WORK_ITEM_DELIVERY_OUTCOMES = [
  'started',
  'not-eligible',
  'deferred',
  'workflow-unresolved',
  'retried',
  'dead-lettered',
] as const;

export type KanbanWorkItemDeliveryOutcome = (typeof KANBAN_WORK_ITEM_DELIVERY_OUTCOMES)[number];

export interface KanbanWorkItemDeliverySummary {
  /** Current shared outbox state, not a metric scraped from one instance. */
  queue: {
    pending: number;
    claimed: number;
    delivered: number;
    deadLettered: number;
    oldestPendingCreatedAt: string | null;
    oldestPendingAgeS: number | null;
  };
  /** Exact counts from the declared retained-audit window. */
  outcomes: Record<KanbanWorkItemDeliveryOutcome, number>;
  window: { startsAt: string; endsAt: string };
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
  /** ADR 1137 D1 — the one accountable person. Written when the card is CREATED,
   *  never by a later materialize (the board owns who). The assignee must be a
   *  workspace member who can read the board's subject; checked before any write. */
  assigneeId?: string;
  /** ADR 1137 D1 — a claimable role (ADR 0049 D2). Exclusive with `assigneeId`. */
  assigneeRole?: string;
  assignmentReason?: string;
  sourceLabel?: string;
  labels?: string[];
  /** ADR 1155 D1 — the card's grouping keys. A source-owned fact: written at
   *  create and kept in step by `refresh`. */
  facets?: KanbanCardFacets;
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
  /** ADR 1137 D3 — when an item's identity already exists, update the facts the
   *  SOURCE owns (title, description, dueAt, sourceLabel) on its card. Never the
   *  assignee, role, column, order or labels; never a terminal-column card; never
   *  re-creates a deleted card. Keep `source.revision` stable to refresh. */
  refresh?: boolean;
  /** ADR 0832 D3 — see `KanbanWorkItem.requestedBy`. Set by the host surface from
   *  the run scope, never from node args. */
  requestedBy?: string;
}

/** The set of editable card fields. A combined content + lane mutation is one
 * canonical command, so an invalid destination cannot leave its content half
 * persisted. `null` clears only the fields that say so below (the two
 * assignment clears, `dueAt`, `sourceRef`, `handoff`, `lastRunStatus`). */
export interface KanbanCardPatch {
  title?: string;
  description?: string;
  workflowId?: string;
  /** Internal lifecycle projection; public card PATCH deliberately does not
   * accept this field. Normal run delivery records it through the same CAS. */
  lastRunId?: string;
  /** ADR 0774 D3 — internal, like `lastRunId`; `null` clears it. */
  lastRunStatus?: KanbanCardRunStatus | null;
  source?: KanbanCardSource;
  sourceLabel?: string;
  /** ADR 1138 D1 — `null` clears it. */
  sourceRef?: KanbanCardSourceRef | null;
  priority?: 'low' | 'normal' | 'high';
  /** ADR 1155 D6 — `null` clears it. Clearing or changing it withdraws the
   *  assignee's open due notices for the card (ADR 1138). */
  dueAt?: string | null;
  createdBy?: string;
  assignmentReason?: string;
  blockerNote?: string;
  assigneeId?: string | null;
  assigneeRole?: string | null;
  /** ADR 0829 P4 — `null` clears the handoff note and its author/time. */
  handoff?: HandoffRecordV1 | null;
  handoffBy?: string;
  handoffAt?: string;
  estimateHours?: number;
  labels?: string[];
  /** ADR 1155 D1 — `null` clears the map; a key set to `null` clears that key. */
  facets?: Record<string, string | null> | null;
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
  /** ADR 0774 D2/D4 — an INTERNAL guard evaluated on the fresh read inside the
   *  CAS loop: false ⇒ `kanban_card_precondition_failed`, nothing written. It is
   *  a function precisely so no route can build one from request input. */
  precondition?: (card: KanbanCard, board: KanbanBoard) => boolean;
}

/** ADR 1155 D4 — one card of a batch create, named by its source's own id. */
export interface KanbanBatchCardInput {
  /** 1–200 characters, unique in the batch. The card id is derived from it, so a
   *  retried or resumed batch converges on the same cards. */
  sourceId: string;
  title: string;
  columnId: string;
  description?: string;
  dueAt?: string;
  assigneeId?: string;
  assigneeRole?: string;
  priority?: 'low' | 'normal' | 'high';
  labels?: string[];
  facets?: KanbanCardFacets;
  sourceLabel?: string;
  sourceRef?: KanbanCardSourceRef;
}

/** ADR 1155 D4 — create up to `KANBAN_BATCH_CREATE_MAX` plain cards in one command.
 *  Host code only (an adopter's backend, a feature): it trusts its caller like every
 *  `applyBoardCommand`. Every item is validated before anything is written; then each
 *  card is its own atomic write, and the result names each item's outcome. */
export interface CreateKanbanCardsBatchCommand {
  type: 'cards.create-batch';
  tenantId: string;
  boardId: string;
  items: KanbanBatchCardInput[];
  /** `skip` (default) leaves an existing card alone; `refresh` updates only the facts
   *  its source owns (ADR 1137 D3), never a card in a terminal lane. */
  onExisting?: 'skip' | 'refresh';
  /** Default false: a 6,000-card import must not send 6,000 notices. Due reminders
   *  (ADR 1138) still reach dated, assigned cards. */
  notifyAssignees?: boolean;
}

export type KanbanBatchCreateStatus = 'created' | 'existing' | 'refreshed' | 'collision' | 'failed';
export interface CreateKanbanCardsBatchResult {
  items: Array<{ sourceId: string; cardId: string; status: KanbanBatchCreateStatus; error?: string }>;
}

/** ADR 1155 D5 — the fields a batch may change: re-dating and grouping only.
 *  Assignment, moves and content keep their single-card paths and side effects. */
export interface KanbanBatchCardPatch {
  dueAt?: string | null;
  priority?: 'low' | 'normal' | 'high';
  labels?: string[];
  facets?: Record<string, string | null> | null;
}

/** ADR 1155 D5 — patch up to `KANBAN_BATCH_PATCH_MAX` cards, each under its own CAS. */
export interface PatchKanbanCardsBatchCommand {
  type: 'cards.patch-batch';
  tenantId: string;
  boardId: string;
  items: Array<{ cardId: string; expectedVersion?: number; patch: KanbanBatchCardPatch }>;
}

export type KanbanBatchPatchStatus = 'updated' | 'unchanged' | 'conflict' | 'not_found' | 'invalid' | 'failed';
export interface PatchKanbanCardsBatchResult {
  items: Array<{ cardId: string; status: KanbanBatchPatchStatus; card?: KanbanCard; error?: string }>;
}

export type KanbanBoardCommand = MaterializeKanbanWorkItemsCommand | PatchKanbanCardCommand | CreateKanbanCardsBatchCommand | PatchKanbanCardsBatchCommand;

export interface MaterializeKanbanWorkItemsResult {
  dryRun: boolean;
  workItems: KanbanWorkItem[];
  cards: KanbanCard[];
  /** ADR 1137 D3 — cards a `refresh` actually changed (empty otherwise). */
  refreshedCardIds: string[];
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

/** ADR 0774 D1 — the canonical column → lane classification, the server twin of
 *  the SPA's `kanban/laneKind.ts` (BLD-8). Before this, four backend call sites
 *  each looked for a lane named exactly `working` while `DEFAULT_COLUMNS` (and so
 *  every add-todo, career and user-created board) calls it `doing` — the SPA
 *  already treated both as the working lane, the server did not. Keep the rules
 *  identical to the SPA's; both sides pin the same case table in a test. */
export type KanbanLaneKind = 'todo' | 'working' | 'waiting' | 'done';

export function columnLaneKind(col: { id: string; name: string }): KanbanLaneKind | null {
  const id = col.id.toLowerCase();
  const name = col.name.toLowerCase();
  if (id === 'todo' || name === 'to do') return 'todo';
  if (id === 'working' || id === 'doing' || id === 'in-progress' || name === 'working' || name === 'doing' || name === 'in progress') return 'working';
  if (id === 'waiting' || name.startsWith('waiting')) return 'waiting';
  if (id === 'done' || name === 'done') return 'done';
  return null;
}

/** The lane the work loop picks FROM (and restores to). */
/** ADR 1138 D2 — the board's first completion lane (terminal, not cancellation). */
export function doneColumnOf(board: KanbanBoard): KanbanColumn | undefined {
  return board.columns.find((c) => isTerminalColumn(board, c.id) && c.terminalKind !== 'cancellation');
}

export function todoColumnOf(board: KanbanBoard): KanbanColumn | undefined {
  return board.columns.find((c) => columnLaneKind(c) === 'todo');
}

/** The lane a pick moves INTO — the "started" lane, by kind not by literal name. */
export function workingColumnOf(board: KanbanBoard): KanbanColumn | undefined {
  return board.columns.find((c) => columnLaneKind(c) === 'working');
}

const boards = new DurableCollection<KanbanBoard>('kanban:board', (b) => b.id);
// ADR 0872 — indexed by the stamped board tenant. An unstamped (legacy) row maps
// to '' and gets no marker; it keeps the index unverified until it is stamped.
const cardRows = new DurableCollection<KanbanCard>('kanban:card', (c) => c.id, undefined, (c) => c.tenantId ?? '');

// ADR 1155 P3b — the card read index: an ADR 1110 P5 store index over `kanban:card`
// (host imports the core entities index directly; decided 2026-11-23). Families:
//   board      [boardId, columnId, order]  every stamped card; the counted family
//   board-due  [boardId, dueAt | '~']
//   assignee   [userId, dueAt | '~']
//   role       [roleKey, dueAt | '~']
// Facets are not indexed: every marker costs one more write per card write (measured,
// ADR 1155 P3a), so only a board's group-by key will be, with D7. Nothing reads the
// index yet; P3c moves the board and assigned reads onto it.
export const KANBAN_CARD_TYPE = 'kanban.card';
const NO_DUE = '~';
/** A card's `order` (any finite double, fractional and negative included) as a key
 *  that sorts like the number: IEEE 754 bits, sign-flipped so negatives come first. */
export function sortableOrder(n: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Number.isFinite(n) ? n : 0);
  let hi = view.getUint32(0);
  let lo = view.getUint32(4);
  if (hi & 0x80000000) { hi = ~hi >>> 0; lo = ~lo >>> 0; } else { hi = (hi | 0x80000000) >>> 0; }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}
type BoardFamily = 'board' | 'board-due';
function boardMarkerSegments(c: KanbanCard, family: BoardFamily): string[] {
  return family === 'board' ? [c.boardId, c.columnId, sortableOrder(c.order)] : [c.boardId, c.dueAt ?? NO_DUE];
}
/** The facts a board page filters on: small, and never free text. A type alias, not an
 *  interface, so it fits a marker's `Record<string, unknown>` projection. */
type KanbanCardIndexFacts = {
  columnId: string;
  dueAt?: string;
  assigneeId?: string;
  assigneeRole?: string;
  completedAt?: string;
  labels?: string[];
  /** ADR 1155 P5 — every facet, so grouping and `facet.<key>` filters need no family
   *  per key and no rebuild when a board changes its group-by key. */
  facets?: Record<string, string>;
};
function cardFactsOf(c: KanbanCard): KanbanCardIndexFacts {
  return {
    columnId: c.columnId,
    ...(c.dueAt ? { dueAt: c.dueAt } : {}),
    ...(c.assigneeId ? { assigneeId: c.assigneeId } : {}),
    ...(c.assigneeRole ? { assigneeRole: c.assigneeRole } : {}),
    ...(c.completedAt ? { completedAt: c.completedAt } : {}),
    ...(c.labels?.length ? { labels: c.labels } : {}),
    ...(c.facets && Object.keys(c.facets).length > 0 ? { facets: { ...c.facets } } : {}),
  };
}
registerStoreIndex<KanbanCard>(KANBAN_CARD_TYPE, {
  // 1 (ADR 1155 P5): the board families' projection gained `facets`. A tenant built at 0
  // rebuilds rather than serve facet filters and group counts from markers without them.
  version: 1,
  isRow: (v): v is KanbanCard => typeof v === 'object' && v !== null && typeof (v as KanbanCard).id === 'string' && typeof (v as KanbanCard).boardId === 'string',
  idOf: (c) => c.id,
  tenantOf: (c) => c.tenantId ?? '',
  orgOf: () => undefined,
  countedFamily: 'board',
  markers: (c) => {
    const due = c.dueAt ?? NO_DUE;
    const facts = cardFactsOf(c);
    return [
      // Both board families carry the filter facts, so a page in either order filters
      // without reading a row (ADR 1155 P3c-1).
      { family: 'board', segments: boardMarkerSegments(c, 'board'), p: facts },
      { family: 'board-due', segments: boardMarkerSegments(c, 'board-due'), p: facts },
      ...(c.assigneeId ? [{ family: 'assignee', segments: [c.assigneeId, due], p: {} }] : []),
      ...(c.assigneeRole ? [{ family: 'role', segments: [c.assigneeRole, due], p: {} }] : []),
    ];
  },
  read: async (tenantId, id) => { const c = await cardRows.get(id); return c && c.tenantId === tenantId ? c : null; },
  scan: async function* (tenantId) { for (const c of await cardRows.listForTenantIndexed(tenantId)) if (c.tenantId === tenantId) yield c; },
  count: (tenantId) => cardRows.countForTenantIndexed(tenantId),
});
/** A card with a tenant is indexed; a legacy unstamped card (ADR 0872 D3) is not until
 *  the hourly stamp gives it one, which is itself a write through this store. */
const stamped = (c: KanbanCard | null | undefined): c is KanbanCard & { tenantId: string } => typeof c?.tenantId === 'string' && c.tenantId.length > 0;
/** The card store with the index's hooks around every write (the commerce `orders`
 *  shape): intent before, sync after; an index failure never fails the card write.
 *  Every card write in this module goes through here (ratchet: adr1155-p3b-card-index). */
const cards = {
  get: (id: string) => cardRows.get(id),
  list: () => cardRows.list(),
  listForTenantIndexed: (tenantId: string) => cardRows.listForTenantIndexed(tenantId),
  tenantIndexVerified: () => cardRows.tenantIndexVerified(),
  async put(c: KanbanCard): Promise<void> {
    if (stamped(c)) await beforeSystemWrite(KANBAN_CARD_TYPE, c.tenantId, c.id, c);
    await cardRows.put(c);
    if (stamped(c)) await afterSystemWrite(KANBAN_CARD_TYPE, c.tenantId, c.id, c);
  },
  async putIfAbsent(c: KanbanCard): Promise<boolean> {
    if (stamped(c)) await beforeSystemWrite(KANBAN_CARD_TYPE, c.tenantId, c.id, c);
    const ok = await cardRows.putIfAbsent(c);
    if (stamped(c)) await afterSystemWrite(KANBAN_CARD_TYPE, c.tenantId, c.id, ok ? c : await cardRows.get(c.id));
    return ok;
  },
  async compareAndSwap(expected: KanbanCard | null, next: KanbanCard): Promise<boolean> {
    if (stamped(next)) await beforeSystemWrite(KANBAN_CARD_TYPE, next.tenantId, next.id, next);
    const ok = await cardRows.compareAndSwap(expected, next);
    if (stamped(next)) await afterSystemWrite(KANBAN_CARD_TYPE, next.tenantId, next.id, ok ? next : await cardRows.get(next.id));
    return ok;
  },
  async delete(id: string): Promise<boolean> {
    const cur = await cardRows.get(id);
    if (stamped(cur)) await beforeSystemWrite(KANBAN_CARD_TYPE, cur.tenantId, id, null);
    const gone = await cardRows.delete(id);
    if (stamped(cur)) await afterSystemWrite(KANBAN_CARD_TYPE, cur.tenantId, id, null);
    return gone;
  },
  __clear: () => cardRows.__clear(),
};
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
/** ADR 1137 D3 — a person deleted this work item's card. A `refresh` sync skips
 *  the identity from then on, so a periodic re-materialize never brings back
 *  what someone removed. Ids only (no content); cleared with the board/tenant. */
interface KanbanWorkItemDismissal {
  workItemId: string;
  tenantId: string;
  boardId: string;
  cardId: string;
  dismissedAt: string;
}
const workItemDismissals = new DurableCollection<KanbanWorkItemDismissal>(
  'kanban:work-item-dismissal',
  (entry) => entry.workItemId,
  undefined,
  (entry) => entry.tenantId,
);
const operationReceipts = new DurableCollection<KanbanOperationReceipt>(
  'kanban:operation-receipt',
  (entry) => entry.receiptId,
  undefined,
  (entry) => entry.tenantId,
);

/** ADR 0872 D4 — one tenant's cards through the verified index, or `null` when
 *  the index is not verified (or the indexed read fails): the caller then scans.
 *  Only for reads where a missed card costs a delay, never a decision. */
async function indexedTenantCards(tenantId: string): Promise<KanbanCard[] | null> {
  if (!(await cards.tenantIndexVerified())) return null;
  try { return await cards.listForTenantIndexed(tenantId); } catch { return null; }
}

/** The cards on any of `boardIds` (all owned by `tenantId`): indexed when verified. */
async function cardsOnBoards(tenantId: string, boardIds: ReadonlySet<string>): Promise<KanbanCard[]> {
  const rows = (await indexedTenantCards(tenantId)) ?? (await cards.list());
  return rows.filter((c) => boardIds.has(c.boardId));
}

/** ADR 0872 D2 — stamp each legacy (unstamped) card with its board's tenant, by
 *  CAS so a concurrent edit wins (the next hour retries). A card whose board is
 *  gone cannot be stamped; it is counted, logged and left alone, and it keeps
 *  the index unverified (D3). Runs before each hourly reconcile pass. */
export async function stampCardTenants(): Promise<{ stamped: number; orphans: number }> {
  const unstamped = (await cards.list()).filter((c) => !c.tenantId);
  if (unstamped.length === 0) return { stamped: 0, orphans: 0 };
  const tenantOfBoard = new Map((await boards.list()).map((b) => [b.id, b.tenantId]));
  let stamped = 0;
  let orphans = 0;
  for (const card of unstamped) {
    const tenantId = tenantOfBoard.get(card.boardId);
    if (!tenantId) { orphans += 1; continue; }
    if (await cards.compareAndSwap(card, { ...card, tenantId })) stamped += 1;
  }
  if (orphans > 0) log.warn('kanban_card_unstamped_orphans', { orphans, stamped });
  return { stamped, orphans };
}

registerTenantIndexAdoption('kanban:card', cardRows, { beforeReconcile: async () => { await stampCardTenants(); } });

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
/** ADR 1155 D7 — set (a facet key) or clear (null) the board's default grouping. The
 *  index needs no rebuild: every card's facets ride its board markers' projection. */
export async function setBoardGroupBy(boardId: string, groupBy: string | null): Promise<KanbanBoard | null> {
  if (groupBy !== null && !FACET_KEY_RE.test(groupBy)) throw boardCommandError('kanban_command_invalid', 'groupBy must be a facet key.');
  const board = await boards.get(boardId);
  if (!board) return null;
  const { groupBy: _old, ...rest } = board;
  const next: KanbanBoard = { ...rest, ...(groupBy !== null ? { groupBy } : {}), updatedAt: new Date().toISOString() };
  await boards.put(next);
  return next;
}

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
  for (const d of await workItemDismissals.listForTenantIndexed(tenantId)) await workItemDismissals.delete(d.workItemId);
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
  if (board) {
    await deleteWorkItemsForBoard(board.tenantId, boardId);
    for (const d of await workItemDismissals.listForTenantIndexed(board.tenantId)) {
      if (d.boardId === boardId) await workItemDismissals.delete(d.workItemId);
    }
  }
  return boards.delete(boardId);
}

const byColumnThenOrder = (a: KanbanCard, b: KanbanCard): number => a.columnId.localeCompare(b.columnId) || a.order - b.order;

// ── ADR 1155 D3 / P3c-1 — one page of a board's cards, filtered on the server ─────────
// The read pages the card index (P3b) by key range and filters on the facts each
// marker carries, then point-reads only the page. While a large tenant's index is
// still building, the same query runs over today's read and returns the same shape,
// the same order and the same cursors. The stored row is truth: a card whose row no
// longer matches its marker is dropped from the page and its markers are re-synced.

export const KANBAN_PAGE_MAX = 100;
export const KANBAN_PAGE_DEFAULT = 50;
/** ADR 1155 OQ-2 / P5b — above this many cards, an unpaged board read and an unpaged
 *  "assigned to me" read are refused (`kanban_board_page_required`), never truncated. */
export const KANBAN_UNPAGED_MAX = 2000;

export interface KanbanBoardPageQuery {
  /** 1–100. */
  limit: number;
  /** An opaque value from the previous page's `nextCursor`, bound to this query. */
  cursor?: string;
  /** Any of these columns. */
  columns?: string[];
  /** `order` (column, then position) or `dueAt` (ascending, undated last). */
  sort?: 'order' | 'dueAt';
  /** Inclusive ISO bounds on `dueAt`. A card with no `dueAt` never matches a date filter. */
  dueFrom?: string;
  dueTo?: string;
  /** `dueAt` is before now and the card is not in a terminal lane. */
  overdue?: boolean;
  /** A user id, `none`, or `role:<key>`. The route resolves `me`. */
  assignee?: string;
  /** Any of these labels. */
  labels?: string[];
  /** ADR 1155 D3 — facet equals value, for every key given (AND). An empty value
   *  matches cards without that key. */
  facets?: Record<string, string>;
  /** ADR 1155 D7 — count every match by `column`, `assignee` or a facet key. */
  groupBy?: string;
}

export interface KanbanBoardPage {
  cards: KanbanCard[];
  /** Every card on the board that matches, across all pages. */
  total: number;
  nextCursor?: string;
  /** With `groupBy`: every match counted by group. `''` is the group of cards with
   *  no value (no assignee, or no such facet). */
  groupCounts?: Record<string, number>;
}

const PAGE_SCAN = 200;
const PAGE_READ_CONCURRENCY = 4;

function pageFamily(q: KanbanBoardPageQuery): BoardFamily {
  return q.sort === 'dueAt' ? 'board-due' : 'board';
}

/** The narrowest key range the query allows: one column when only one is asked for. */
function pageSegments(boardId: string, q: KanbanBoardPageQuery): string[] {
  return pageFamily(q) === 'board' && q.columns?.length === 1 ? [boardId, q.columns[0]!] : [boardId];
}

/** True when the slice alone answers the query, so `total` is a counted read. */
function sliceOnly(q: KanbanBoardPageQuery): boolean {
  const columnsInSlice = !q.columns?.length || (pageFamily(q) === 'board' && q.columns.length === 1);
  return columnsInSlice && !q.dueFrom && !q.dueTo && !q.overdue && q.assignee === undefined && !q.labels?.length
    && !(q.facets && Object.keys(q.facets).length > 0) && q.groupBy === undefined;
}

function factsMatch(board: KanbanBoard, f: KanbanCardIndexFacts, q: KanbanBoardPageQuery, nowMs: number): boolean {
  if (q.columns?.length && !q.columns.includes(f.columnId)) return false;
  if (q.dueFrom || q.dueTo || q.overdue) {
    if (!f.dueAt) return false;
    if (q.dueFrom && f.dueAt < q.dueFrom) return false;
    if (q.dueTo && f.dueAt > q.dueTo) return false;
    if (q.overdue && (Date.parse(f.dueAt) >= nowMs || isTerminalColumn(board, f.columnId))) return false;
  }
  if (q.assignee !== undefined) {
    if (q.assignee === 'none') { if (f.assigneeId || f.assigneeRole) return false; }
    else if (q.assignee.startsWith('role:')) { if (f.assigneeRole !== q.assignee.slice('role:'.length)) return false; }
    else if (f.assigneeId !== q.assignee) return false;
  }
  if (q.labels?.length && !(f.labels ?? []).some((l) => q.labels!.includes(l))) return false;
  for (const [key, want] of Object.entries(q.facets ?? {})) {
    const have = f.facets?.[key];
    if (want === '' ? have !== undefined : have !== want) return false;
  }
  return true;
}

/** The group a card counts under for `groupBy`; `''` when it has none. */
function groupOf(f: KanbanCardIndexFacts, groupBy: string): string {
  if (groupBy === 'column') return f.columnId;
  if (groupBy === 'assignee') return f.assigneeId ?? (f.assigneeRole ? `role:${f.assigneeRole}` : '');
  return f.facets?.[groupBy] ?? '';
}

function countGroup(counts: Record<string, number> | undefined, f: KanbanCardIndexFacts, groupBy: string | undefined): void {
  if (!counts || groupBy === undefined) return;
  const g = groupOf(f, groupBy);
  counts[g] = (counts[g] ?? 0) + 1;
}

function isFacts(p: Record<string, unknown>): p is Record<string, unknown> & KanbanCardIndexFacts {
  return typeof p.columnId === 'string';
}

/** The query a cursor is bound to: a cursor reused with another query is refused. */
function pageQueryHash(boardId: string, q: KanbanBoardPageQuery): string {
  const norm = {
    b: boardId,
    c: [...(q.columns ?? [])].sort(),
    s: q.sort ?? 'order',
    f: q.dueFrom ?? null,
    t: q.dueTo ?? null,
    o: q.overdue === true,
    a: q.assignee ?? null,
    l: [...(q.labels ?? [])].sort(),
    x: Object.entries(q.facets ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    g: q.groupBy ?? null,
  };
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 16);
}

function encodePageCursor(hash: string, key: string): string {
  return Buffer.from(JSON.stringify({ h: hash, k: key }), 'utf8').toString('base64url');
}

function decodePageCursor(cursor: string, hash: string): string {
  try {
    const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { h?: unknown; k?: unknown };
    if (o.h === hash && typeof o.k === 'string' && o.k.length > 0) return o.k;
  } catch { /* fall through */ }
  throw boardCommandError('kanban_cursor_invalid', 'This cursor belongs to a different query. Start again without it.');
}

const keyAfter = (a: string, b: string): boolean => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')) > 0;

/** A card's key in the family the page walks: the marker key a built index stores. */
function pageKeyOf(c: KanbanCard & { tenantId: string }, family: BoardFamily): string {
  return `${familyPrefix(c.tenantId, KANBAN_CARD_TYPE, family, undefined, boardMarkerSegments(c, family))}${encodeURIComponent(c.id)}`;
}

async function readCardsBounded(ids: readonly string[]): Promise<(KanbanCard | null)[]> {
  const out: (KanbanCard | null)[] = new Array(ids.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) { const i = next++; out[i] = await cards.get(ids[i]!); }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_READ_CONCURRENCY, ids.length) }, worker));
  return out;
}

export async function listBoardCardsPage(board: KanbanBoard, q: KanbanBoardPageQuery, now = Date.now()): Promise<KanbanBoardPage> {
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > KANBAN_PAGE_MAX) {
    throw boardCommandError('kanban_command_invalid', `limit must be a whole number from 1 to ${KANBAN_PAGE_MAX}.`);
  }
  const hash = pageQueryHash(board.id, q);
  const after = q.cursor ? decodePageCursor(q.cursor, hash) : undefined;
  const family = pageFamily(q);
  const segments = pageSegments(board.id, q);

  if ((await ensureSystemIndexBuilt(board.tenantId, KANBAN_CARD_TYPE)) === 'building') {
    return boardPageFromRows(board, q, now, hash, after, family, segments);
  }

  // Index path. A counted slice reads only as far as the page; a filtered one walks the
  // slice's markers (never its rows) once, so `total` counts every match.
  const picked: { id: string; key: string }[] = [];
  let total = 0;
  const groupCounts: Record<string, number> | undefined = q.groupBy !== undefined ? {} : undefined;
  const walkAll = !sliceOnly(q);
  let cursor = walkAll || after === undefined ? undefined : Buffer.from(after, 'utf8').toString('base64url');
  for (;;) {
    const page = await listIndexPage(board.tenantId, KANBAN_CARD_TYPE, family, undefined, { segments, limit: PAGE_SCAN, ...(cursor ? { cursor } : {}) });
    for (const row of page.rows) {
      let facts: KanbanCardIndexFacts | null = isFacts(row.p) ? row.p : null;
      if (!facts) {
        // A marker without the facts projection (written before P3c-1 gave the board
        // families one). It is never trusted or skipped: read its row, judge the row,
        // and re-sync the markers so the next read finds the facts.
        const c = await cards.get(row.id);
        await resyncSystemRow(board.tenantId, KANBAN_CARD_TYPE, row.id).catch(() => undefined);
        facts = c && c.boardId === board.id && c.tenantId === board.tenantId ? cardFactsOf(c) : null;
      }
      if (!facts || !factsMatch(board, facts, q, now)) continue;
      total += 1;
      countGroup(groupCounts, facts, q.groupBy);
      const key = Buffer.from(row.cursor, 'base64url').toString('utf8');
      if (after !== undefined && !keyAfter(key, after)) continue;
      if (picked.length <= q.limit) picked.push({ id: row.id, key });
    }
    if (!page.cursor || page.rows.length < PAGE_SCAN) break;
    if (!walkAll && picked.length > q.limit) break;
    cursor = page.cursor;
  }
  if (!walkAll) total = await indexedFamilyCount(board.tenantId, KANBAN_CARD_TYPE, family, '_', segments);

  const hasMore = picked.length > q.limit;
  const onPage = picked.slice(0, q.limit);
  const rows = await readCardsBounded(onPage.map((p) => p.id));
  const out: KanbanCard[] = [];
  for (let i = 0; i < onPage.length; i += 1) {
    const c = rows[i];
    if (c && c.boardId === board.id && c.tenantId === board.tenantId && factsMatch(board, cardFactsOf(c), q, now)) { out.push(c); continue; }
    // The marker was stale: the row moved, changed or went. Heal it; the next page is right.
    await resyncSystemRow(board.tenantId, KANBAN_CARD_TYPE, onPage[i]!.id).catch(() => undefined);
  }
  return {
    cards: out,
    total,
    ...(hasMore ? { nextCursor: encodePageCursor(hash, onPage[onPage.length - 1]!.key) } : {}),
    ...(groupCounts ? { groupCounts } : {}),
  };
}

/** Test-only: the while-building path for any tenant size, so a test can show it
 *  returns what the index path returns. */
export async function __listBoardCardsPageFromRows(board: KanbanBoard, q: KanbanBoardPageQuery, now = Date.now()): Promise<KanbanBoardPage> {
  const hash = pageQueryHash(board.id, q);
  return boardPageFromRows(board, q, now, hash, q.cursor ? decodePageCursor(q.cursor, hash) : undefined, pageFamily(q), pageSegments(board.id, q));
}

/** The same page over today's read (`listCards`), while the index builds. */
async function boardPageFromRows(
  board: KanbanBoard, q: KanbanBoardPageQuery, now: number, hash: string, after: string | undefined,
  family: BoardFamily, segments: string[],
): Promise<KanbanBoardPage> {
  const prefix = familyPrefix(board.tenantId, KANBAN_CARD_TYPE, family, undefined, segments);
  const keyed = (await listCards(board.id))
    .filter((c): c is KanbanCard & { tenantId: string } => stamped(c) && c.tenantId === board.tenantId)
    .map((c) => ({ c, key: pageKeyOf(c, family) }))
    .filter((e) => e.key.startsWith(prefix) && factsMatch(board, cardFactsOf(e.c), q, now))
    .sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const rest = after === undefined ? keyed : keyed.filter((e) => keyAfter(e.key, after));
  const onPage = rest.slice(0, q.limit);
  let groupCounts: Record<string, number> | undefined;
  if (q.groupBy !== undefined) {
    groupCounts = {};
    for (const e of keyed) countGroup(groupCounts, cardFactsOf(e.c), q.groupBy);
  }
  return {
    cards: onPage.map((e) => e.c),
    total: keyed.length,
    ...(rest.length > q.limit ? { nextCursor: encodePageCursor(hash, onPage[onPage.length - 1]!.key) } : {}),
    ...(groupCounts ? { groupCounts } : {}),
  };
}


/** A board's cards, for display and the work loop (ADR 0872 D4: indexed once
 *  verified; a missed card shows after the next hourly repair). A decision that
 *  must see every card (dedupe, caps, repoint) uses {@link listCardsExact}. */
export async function listCards(boardId: string): Promise<KanbanCard[]> {
  const board = await boards.get(boardId);
  // ADR 1155 (unpaged read on the index) — when the tenant's card index is built and
  // its legacy tenant index is verified (which proves no card lacks a tenant, so none
  // lacks a marker), read only this board's slice: its markers, then its cards. The
  // result is the same cards in the same order; the cost is the board, not the tenant.
  if (board && (await cards.tenantIndexVerified()) && (await ensureSystemIndexBuilt(board.tenantId, KANBAN_CARD_TYPE)) === 'built') {
    const ids = await cardIndexIds(board.tenantId, 'board', [board.id]);
    return (await readCardsBounded(ids))
      .filter((c): c is KanbanCard => c !== null && c.boardId === board.id && c.tenantId === board.tenantId)
      .sort(byColumnThenOrder);
  }
  const rows = board ? await cardsOnBoards(board.tenantId, new Set([boardId])) : (await cards.list()).filter((c) => c.boardId === boardId);
  return rows.sort(byColumnThenOrder);
}

/** Test-only: today's read of a board's cards, whatever the index's state. */
export async function __listCardsWithoutStoreIndex(boardId: string): Promise<KanbanCard[]> {
  const board = await boards.get(boardId);
  const rows = board ? await cardsOnBoards(board.tenantId, new Set([boardId])) : (await cards.list()).filter((c) => c.boardId === boardId);
  return rows.sort(byColumnThenOrder);
}

/**
 * ADR 1138 D4 — every tenant that owns at least one board, for a sweep that must
 * reach each workspace with cards. The agent roster is not that list: an adopter
 * with boards and no roster agents (casavoga-prod) is missing from it. One boards
 * scan; callers cache it (see `dueSweepTenantSource`).
 */
export async function listBoardTenants(): Promise<string[]> {
  const out = new Set<string>();
  for (const b of await boards.list()) if (b.tenantId) out.add(b.tenantId);
  return [...out].sort();
}

/**
 * ADR 1138 D4 — one tenant's open cards that have a due date and a person, with
 * their boards, for the due-reminder sweep. Reads ONLY the verified tenant card
 * index and point-reads each board; returns `null` (sweep skips the tenant this
 * tick) rather than falling back to a whole-table scan when the index is not yet
 * verified. Cards in a terminal lane are left out.
 */
export async function listOpenDueCards(tenantId: string): Promise<Array<{ card: KanbanCard; board: KanbanBoard }> | null> {
  let rows: KanbanCard[];
  try { rows = await cards.listForTenantIndexed(tenantId); } catch { return null; }
  const boardById = new Map<string, KanbanBoard | null>();
  const out: Array<{ card: KanbanCard; board: KanbanBoard }> = [];
  for (const card of rows) {
    if (!card.dueAt || !card.assigneeId) continue;
    if (!boardById.has(card.boardId)) boardById.set(card.boardId, await boards.get(card.boardId));
    const board = boardById.get(card.boardId);
    if (!board || board.tenantId !== tenantId || isTerminalColumn(board, card.columnId)) continue;
    out.push({ card, board });
  }
  return out.sort((x, y) => x.card.id.localeCompare(y.card.id));
}

/** A board's cards from the full scan: never misses one (ADR 0872 D4). */
export async function listCardsExact(boardId: string): Promise<KanbanCard[]> {
  return (await cards.list()).filter((c) => c.boardId === boardId).sort(byColumnThenOrder);
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
  for (const card of await cardsOnBoards(tenantId, boardIds)) {
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
  /** ADR 1138 D1. */
  sourceRef?: KanbanCardSourceRef;
  priority?: 'low' | 'normal' | 'high';
  dueAt?: string;
  createdBy?: string;
  assignmentReason?: string;
  blockerNote?: string;
  assigneeId?: string;
  assigneeRole?: string;
  estimateHours?: number;
  labels?: string[];
  /** ADR 1155 D1. */
  facets?: KanbanCardFacets;
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
  // ADR 0872 D1 — the card carries its board's tenant, so a board must exist.
  const board = await boards.get(input.boardId);
  if (!board) throw new Error(`kanban_board_not_found: ${input.boardId}`);
  if (input.assigneeRole !== undefined) assertAssigneeRoleFits(board, input.assigneeRole);
  if (input.sourceRef !== undefined) assertSourceRef(input.sourceRef);
  const facets = input.facets !== undefined ? assertFacets(input.facets) : undefined;
  // Ordering only (D4): a missed sibling can only repeat an `order`.
  const siblings = (await cardsOnBoards(board.tenantId, new Set([board.id]))).filter((c) => c.columnId === input.columnId);
  const card: KanbanCard = {
    id,
    boardId: input.boardId,
    tenantId: board.tenantId,
    columnId: input.columnId,
    title: input.title,
    description: input.description,
    workflowId: input.workflowId,
    // Default unattributed cards to `human` — a person dragged it in.
    source: input.source ?? 'human',
    sourceConversationId: input.sourceConversationId,
    sourceLabel: input.sourceLabel,
    ...(input.sourceRef !== undefined ? { sourceRef: { label: input.sourceRef.label, path: input.sourceRef.path } } : {}),
    priority: input.priority,
    dueAt: input.dueAt,
    createdBy: input.createdBy,
    assignmentReason: input.assignmentReason,
    blockerNote: input.blockerNote,
    ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
    ...(input.assigneeRole !== undefined ? { assigneeRole: input.assigneeRole } : {}),
    ...(input.estimateHours !== undefined ? { estimateHours: input.estimateHours } : {}),
    ...(input.labels !== undefined ? { labels: input.labels } : {}),
    ...(facets !== undefined && Object.keys(facets).length > 0 ? { facets } : {}),
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
    assertAssignmentShape(item);
    if (item.assigneeRole !== undefined) assertAssigneeRoleFits(board, item.assigneeRole);
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

const ASSIGNMENT_REASON_MAX = 500;
const SOURCE_LABEL_MAX = 200;
const LABELS_MAX = 20;
const LABEL_MAX = 64;

function assigneeInvalid(key: string, why: string): Error {
  return boardCommandError('kanban_assignee_invalid', `Work item '${key}' ${why}`);
}

/** ADR 1137 D4 — `<kind>:<role>` names a role on the board's own subject (e.g.
 *  `project:lead`) when that kind registered roles; anything else is a workspace
 *  role key, as before. */
function parseSubjectRole(assigneeRole: string): { kind: string; role: string } | null {
  const at = assigneeRole.indexOf(':');
  if (at <= 0) return null;
  const kind = assigneeRole.slice(0, at);
  return subjectRoleResolver(kind) ? { kind, role: assigneeRole.slice(at + 1) } : null;
}

/** ADR 1137 D4 — a subject role may address a card only on that subject's board,
 *  and only a role its owner made addressable. Throws `kanban_assignee_invalid`. */
export function assertAssigneeRoleFits(board: KanbanBoard, assigneeRole: string): void {
  const parsed = parseSubjectRole(assigneeRole.trim());
  if (!parsed) return;
  const subject = boardSubject(board);
  if (!subject || subject.kind !== parsed.kind) {
    throw boardCommandError('kanban_assignee_invalid', `The role '${assigneeRole}' can only address a card on a ${parsed.kind}'s board.`);
  }
  if (!subjectRoleResolver(parsed.kind)!.addressable.includes(parsed.role)) {
    throw boardCommandError('kanban_assignee_invalid', `The role '${assigneeRole}' can't be assigned work.`);
  }
}

/** ADR 1137 D1 — the synchronous shape rules, inside `prepareWorkItems`. */
function assertAssignmentShape(item: KanbanWorkItemProposal): void {
  const bad = (v: unknown, max: number): boolean => v !== undefined && (typeof v !== 'string' || v.trim().length === 0 || v.length > max);
  if (bad(item.assigneeId, 512)) throw assigneeInvalid(item.key, 'has an invalid assigneeId.');
  if (bad(item.assigneeRole, 128)) throw assigneeInvalid(item.key, 'has an invalid assigneeRole.');
  if (item.assigneeId !== undefined && item.assigneeRole !== undefined) {
    throw assigneeInvalid(item.key, 'names both an assignee and a role; pick one.');
  }
  if (item.assignmentReason !== undefined && (typeof item.assignmentReason !== 'string' || item.assignmentReason.length > ASSIGNMENT_REASON_MAX)) {
    throw boardCommandError('kanban_work_items_invalid', `Work item '${item.key}' has an assignmentReason over ${ASSIGNMENT_REASON_MAX} characters.`);
  }
  if (item.sourceLabel !== undefined && (typeof item.sourceLabel !== 'string' || item.sourceLabel.length > SOURCE_LABEL_MAX)) {
    throw boardCommandError('kanban_work_items_invalid', `Work item '${item.key}' has a sourceLabel over ${SOURCE_LABEL_MAX} characters.`);
  }
  if (item.labels !== undefined && (!Array.isArray(item.labels) || item.labels.length > LABELS_MAX
    || item.labels.some((l) => typeof l !== 'string' || l.trim().length === 0 || l.length > LABEL_MAX))) {
    throw boardCommandError('kanban_work_items_invalid', `Work item '${item.key}' has invalid labels (at most ${LABELS_MAX}, each 1–${LABEL_MAX} characters).`);
  }
  if (item.facets !== undefined) {
    try { assertFacets(item.facets); } catch (err) {
      throw boardCommandError('kanban_work_items_invalid', `Work item '${item.key}': ${err instanceof Error ? err.message : 'invalid facets'}`);
    }
  }
}

/**
 * ADR 1137 D1 — every named assignee must be able to SEE the card it would be
 * handed: a member of the board's workspace and, on a subject's board (a
 * project's), a reader of that subject in the subject's own org. That second
 * check is what keeps a private project's card, or a client org's project card,
 * from being assigned and notified to someone outside it (ADR 1118 / 1121). It
 * asks about the ASSIGNEE, not the caller, and runs before any write so one bad
 * assignee fails the whole materialization atomically.
 */
/** ADR 1137 D1 / ADR 1138 D4 — can `userId` see this board's cards? A member of
 *  the board's workspace and, on a subject's board, a reader of that subject in
 *  the subject's own org. The one rule assignment and due reminders share. */
export async function assigneeCanSeeBoard(board: KanbanBoard, userId: string): Promise<boolean> {
  // A personal workspace (`user:<id>`) is its owner's alone and seeds no member
  // row for them — the assign route's self-on-own-workspace rule.
  const ownPersonal = isPersonalTenantId(board.tenantId) && board.tenantId === userId;
  if (!ownPersonal && !(await isWorkspaceMember(userId, board.tenantId))) return false;
  const subject = boardSubject(board);
  return subject ? subjectReadAllowed(board.tenantId, subject, { subject: userId }) : true;
}

async function assertAssigneesCanRead(board: KanbanBoard, items: readonly KanbanWorkItemProposal[]): Promise<void> {
  const checked = new Map<string, Promise<boolean>>();
  const canRead = (assigneeId: string): Promise<boolean> => {
    let p = checked.get(assigneeId);
    if (!p) {
      p = assigneeCanSeeBoard(board, assigneeId);
      checked.set(assigneeId, p);
    }
    return p;
  };
  for (const item of items) {
    if (item.assigneeId !== undefined && !(await canRead(item.assigneeId.trim()))) {
      throw assigneeInvalid(item.key, 'names an assignee who cannot see this board.');
    }
  }
}

/** ADR 1137 D3 — the source-owned fields a refresh may change, and only those. */
/** ADR 1137 D3 — the facts a card's SOURCE owns, and so may refresh. */
export interface KanbanCardFacts { title: string; description?: string; dueAt?: string; sourceLabel?: string; facets?: KanbanCardFacets }

function refreshPatchFor(card: KanbanCard, proposal: KanbanCardFacts): KanbanCardPatch {
  const patch: KanbanCardPatch = {};
  if (proposal.title !== card.title) patch.title = proposal.title;
  if ((proposal.description ?? '') !== (card.description ?? '')) patch.description = proposal.description ?? '';
  if (proposal.dueAt !== undefined && proposal.dueAt !== card.dueAt) patch.dueAt = proposal.dueAt;
  if (proposal.sourceLabel !== undefined && proposal.sourceLabel !== card.sourceLabel) patch.sourceLabel = proposal.sourceLabel;
  // ADR 1155 D1 — the source's map replaces the card's: keys it dropped clear.
  if (proposal.facets !== undefined && !sameFacets(proposal.facets, card.facets)) {
    patch.facets = {
      ...Object.fromEntries(Object.keys(card.facets ?? {}).map((k) => [k, null])),
      ...proposal.facets,
    };
  }
  return patch;
}

/**
 * ADR 1137 D3 / ADR 1138 — the ONE "source wins on facts, board wins on who and
 * status" rule, for any card a feature keeps in step with its own record (a work
 * item's refresh and an adopter's plain cards both come through here). Updates only
 * title, description, dueAt and sourceLabel, through the normal `card.patch`; never
 * the holder, role, column, order or labels; leaves a finished card as it was; and
 * writes nothing when nothing differs. Returns whether it wrote.
 */
export async function refreshCardFacts(board: KanbanBoard, card: KanbanCard, facts: KanbanCardFacts): Promise<{ card: KanbanCard; refreshed: boolean }> {
  if (card.boardId !== board.id || isTerminalColumn(board, card.columnId)) return { card, refreshed: false };
  const patch = refreshPatchFor(card, facts);
  if (Object.keys(patch).length === 0) return { card, refreshed: false };
  const next = (await applyKanbanCardPatchCommand({
    type: 'card.patch', tenantId: board.tenantId, boardId: board.id, cardId: card.id, patch,
  })).card;
  return { card: next, refreshed: true };
}

/** ADR 1137 D1 — the assignment fields a proposal puts on the card it creates. */
function assignmentFieldsOf(proposal: KanbanWorkItemProposal): Pick<KanbanCard, 'assigneeId' | 'assigneeRole' | 'assignmentReason' | 'sourceLabel' | 'labels' | 'facets'> {
  return {
    ...(proposal.assigneeId !== undefined ? { assigneeId: proposal.assigneeId.trim() } : {}),
    ...(proposal.assigneeRole !== undefined ? { assigneeRole: proposal.assigneeRole.trim() } : {}),
    ...(proposal.assignmentReason !== undefined ? { assignmentReason: proposal.assignmentReason } : {}),
    ...(proposal.sourceLabel !== undefined ? { sourceLabel: proposal.sourceLabel } : {}),
    ...(proposal.labels !== undefined ? { labels: [...proposal.labels] } : {}),
    ...(proposal.facets !== undefined && Object.keys(proposal.facets).length > 0 ? { facets: { ...proposal.facets } } : {}),
  };
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
export function applyBoardCommand(command: CreateKanbanCardsBatchCommand): Promise<CreateKanbanCardsBatchResult>;
export function applyBoardCommand(command: PatchKanbanCardsBatchCommand): Promise<PatchKanbanCardsBatchResult>;
/** Reviewed-plan materialization uses deterministic aggregate/card/event ids
 * and `putIfAbsent` so a retry after any partial durable write converges without
 * duplicate work or delivery. `dryRun` validates and projects exactly the
 * records that a real command would create, but writes nothing. */
export async function applyBoardCommand(
  command: KanbanBoardCommand,
): Promise<MaterializeKanbanWorkItemsResult | PatchKanbanCardResult | CreateKanbanCardsBatchResult | PatchKanbanCardsBatchResult> {
  if (command.type === 'card.patch') return applyKanbanCardPatchCommand(command);
  if (command.type === 'cards.create-batch') return applyCardsCreateBatch(command);
  if (command.type === 'cards.patch-batch') return applyCardsPatchBatch(command);
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
  await assertAssigneesCanRead(board, command.items);
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
    ...(command.requestedBy ? { requestedBy: command.requestedBy } : {}),
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
    ...assignmentFieldsOf(proposal),
    dependsOn: dependencyIds.map((dependencyId) => prepared.find((item) => item.workItemId === dependencyId)?.cardId ?? ''),
    workItemId,
    order: 0,
    createdAt: now,
    updatedAt: now,
  } satisfies KanbanCard));

  if (command.dryRun) return { dryRun: true, workItems: projectedWorkItems, cards: projectedCards, refreshedCardIds: [] };
  const refreshedCardIds: string[] = [];

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
    // ADR 1137 D3 — someone deleted this work's card; a sync must not bring it back.
    if (command.refresh && !existingCard && await workItemDismissals.get(candidate.workItemId)) continue;
    const inserted = await workItems.putIfAbsent(candidate);
    const item = inserted ? candidate : await workItems.get(candidate.workItemId);
    if (!item || !sameWorkIdentity(item, candidate)) {
      throw boardCommandError('kanban_work_item_collision', `Work item '${plan.proposal.key}' already belongs to a different source.`);
    }
    // ADR 1137 D3 — a refresh of known work updates its card in place, or leaves
    // it alone. It never re-creates a card someone deleted, and never reopens one
    // that reached a terminal lane: the board owns who and status.
    if (!inserted && command.refresh) {
      if (!existingCard) {
        materializedWorkItems.push(item);
        continue;
      }
      const r = await refreshCardFacts(board, existingCard, plan.proposal);
      if (r.refreshed) refreshedCardIds.push(r.card.id);
      materializedWorkItems.push(item);
      materializedCards.push(r.card);
      continue;
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
      ...assignmentFieldsOf(plan.proposal),
      dependsOn: projectedCards[index]!.dependsOn,
      workItemId: item.workItemId,
      cardId: item.cardId,
    });
    if (card.workItemId !== item.workItemId) {
      throw boardCommandError('kanban_card_collision', `Card for work item '${plan.proposal.key}' is already owned by different work.`);
    }
    // ADR 1137 D2 — this call created the card, so its assignee hears about it,
    // once: the id derives from the command's idempotency key. Best-effort, as
    // every ADR 0049 notification is; a crash between the write and here loses
    // this one notice (recorded in the ADR).
    if (!existingCard && card.assigneeId) {
      await emitAssignmentNotification({
        tenantId: command.tenantId,
        card,
        assigneeId: card.assigneeId,
        ...(card.assignmentReason ? { comment: card.assignmentReason } : {}),
        boardName: board.name,
        idempotencyKey: `work-items.materialize\u0000${command.idempotencyKey}`,
      });
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
  return { dryRun: false, workItems: materializedWorkItems, cards: materializedCards, refreshedCardIds };
}

function applyKanbanCardPatch(card: KanbanCard, patch: KanbanCardPatch): KanbanCard {
  const next: KanbanCard = { ...card };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.workflowId !== undefined) next.workflowId = patch.workflowId;
  if (patch.lastRunId !== undefined) next.lastRunId = patch.lastRunId;
  if (patch.lastRunStatus === null) delete next.lastRunStatus;
  else if (patch.lastRunStatus !== undefined) next.lastRunStatus = patch.lastRunStatus;
  if (patch.source !== undefined) next.source = patch.source;
  if (patch.sourceLabel !== undefined) next.sourceLabel = patch.sourceLabel;
  if (patch.sourceRef === null) delete next.sourceRef;
  else if (patch.sourceRef !== undefined) next.sourceRef = { label: patch.sourceRef.label, path: patch.sourceRef.path };
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.dueAt === null) delete next.dueAt;
  else if (patch.dueAt !== undefined) next.dueAt = patch.dueAt;
  if (patch.createdBy !== undefined) next.createdBy = patch.createdBy;
  if (patch.assignmentReason !== undefined) next.assignmentReason = patch.assignmentReason;
  if (patch.blockerNote !== undefined) next.blockerNote = patch.blockerNote;
  if (patch.assigneeId === null) delete next.assigneeId;
  else if (patch.assigneeId !== undefined) next.assigneeId = patch.assigneeId;
  if (patch.assigneeRole === null) delete next.assigneeRole;
  else if (patch.assigneeRole !== undefined) next.assigneeRole = patch.assigneeRole;
  if (patch.handoff === null) { delete next.handoff; delete next.handoffBy; delete next.handoffAt; }
  else if (patch.handoff !== undefined) {
    next.handoff = patch.handoff;
    if (patch.handoffBy !== undefined) next.handoffBy = patch.handoffBy;
    if (patch.handoffAt !== undefined) next.handoffAt = patch.handoffAt;
  }
  if (patch.estimateHours !== undefined) next.estimateHours = patch.estimateHours;
  if (patch.labels !== undefined) next.labels = patch.labels;
  if (patch.facets === null) delete next.facets;
  else if (patch.facets !== undefined) {
    const merged = mergeFacets(card.facets, patch.facets);
    if (merged) next.facets = merged; else delete next.facets;
  }
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
// ── ADR 1155 D4 / D5 (P4) — batch create and batch patch ─────────────────────────────
// Caps sized from the P3a writes-per-card measurement: a card write costs 7 fixed kv
// calls plus one per index marker. A create here is about 10 writes and 11 reads (no
// facet is indexed), so 200 creates are about 4,200 kv calls. A re-date moves every
// marker keyed on `dueAt` (about 13 writes), so 500 re-dates are about 6,500, run 4 at
// a time. Each is a few seconds on Postgres: inside one request, and small enough that
// a client can resume a large import batch by batch.
export const KANBAN_BATCH_CREATE_MAX = 200;
export const KANBAN_BATCH_PATCH_MAX = 500;
const BATCH_CONCURRENCY = 4;
const BATCH_PATCH_FIELDS = new Set(['dueAt', 'priority', 'labels', 'facets']);
const PRIORITIES = new Set(['low', 'normal', 'high']);

/** The card a source id names on a board: deterministic, so a retried or resumed
 *  batch converges on the same cards instead of duplicating them. */
export function batchCardIdOf(tenantId: string, boardId: string, sourceId: string): string {
  return `card-src-${createHash('sha256').update([tenantId, boardId, sourceId].join('\u0000')).digest('hex').slice(0, 32)}`;
}

/** The inverse of `sortableOrder`. */
function orderFromSortable(key: string): number {
  if (!/^[0-9a-f]{16}$/.test(key)) return 0;
  let hi = Number.parseInt(key.slice(0, 8), 16);
  let lo = Number.parseInt(key.slice(8), 16);
  if (hi & 0x80000000) hi = (hi & 0x7fffffff) >>> 0; else { hi = ~hi >>> 0; lo = ~lo >>> 0; }
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, hi);
  view.setUint32(4, lo);
  const n = view.getFloat64(0);
  return Number.isFinite(n) ? n : 0;
}

/** The highest `order` in each column, so a batch appends after it. From the index's
 *  column slice when it is built (markers only, never rows); otherwise one read of the
 *  board's cards for the whole batch. A missed card can only repeat an order (D4). */
async function columnTopOrders(board: KanbanBoard, columnIds: readonly string[]): Promise<Map<string, number>> {
  const tops = new Map<string, number>();
  if ((await ensureSystemIndexBuilt(board.tenantId, KANBAN_CARD_TYPE)) === 'built') {
    for (const columnId of columnIds) {
      const prefix = familyPrefix(board.tenantId, KANBAN_CARD_TYPE, 'board', undefined, [board.id, columnId]);
      let last: string | undefined;
      let cursor: string | undefined;
      for (;;) {
        const page = await listIndexPage(board.tenantId, KANBAN_CARD_TYPE, 'board', undefined, { segments: [board.id, columnId], limit: 500, ...(cursor ? { cursor } : {}) });
        if (page.rows.length > 0) last = Buffer.from(page.rows[page.rows.length - 1]!.cursor, 'base64url').toString('utf8');
        if (!page.cursor || page.rows.length < 500) break;
        cursor = page.cursor;
      }
      if (last?.startsWith(prefix)) tops.set(columnId, orderFromSortable(last.slice(prefix.length).split(':')[0] ?? ''));
    }
    return tops;
  }
  for (const c of await cardsOnBoards(board.tenantId, new Set([board.id]))) {
    if (columnIds.includes(c.columnId)) tops.set(c.columnId, Math.max(tops.get(c.columnId) ?? Number.NEGATIVE_INFINITY, c.order));
  }
  return tops;
}

/** Run `fn` over every index with at most `limit` in flight, keeping each result's slot. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!, i); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const isoOk = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const stringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** One batch item, checked before anything is written. */
function assertBatchCardInput(board: KanbanBoard, item: KanbanBatchCardInput, index: number, seen: Set<string>): void {
  const bad = (why: string): never => { throw boardCommandError('kanban_card_invalid', `Item ${index}: ${why}`); };
  if (typeof item !== 'object' || item === null) bad('is not an object.');
  if (typeof item.sourceId !== 'string' || item.sourceId.length === 0 || item.sourceId.length > 200) bad('sourceId must be 1–200 characters.');
  if (seen.has(item.sourceId)) bad(`sourceId '${item.sourceId}' appears twice.`);
  seen.add(item.sourceId);
  if (typeof item.title !== 'string' || item.title.trim().length === 0) bad('title must be non-empty text.');
  if (!board.columns.some((c) => c.id === item.columnId)) bad(`column '${String(item.columnId)}' is not on this board.`);
  if (item.description !== undefined && typeof item.description !== 'string') bad('description must be text.');
  if (item.dueAt !== undefined && !isoOk(item.dueAt)) bad('dueAt must be an ISO date.');
  if (item.assigneeId !== undefined && (typeof item.assigneeId !== 'string' || item.assigneeId.trim().length === 0)) bad('assigneeId must be non-empty text.');
  if (item.priority !== undefined && !PRIORITIES.has(item.priority)) bad('priority must be low, normal or high.');
  if (item.labels !== undefined && !stringList(item.labels)) bad('labels must be a list of text.');
  if (item.sourceLabel !== undefined && typeof item.sourceLabel !== 'string') bad('sourceLabel must be text.');
  try {
    if (item.assigneeRole !== undefined) assertAssigneeRoleFits(board, item.assigneeRole);
    if (item.sourceRef !== undefined) assertSourceRef(item.sourceRef);
    if (item.facets !== undefined) assertFacets(item.facets);
  } catch (err) {
    bad(err instanceof Error ? err.message : 'is invalid.');
  }
}

async function applyCardsCreateBatch(command: CreateKanbanCardsBatchCommand): Promise<CreateKanbanCardsBatchResult> {
  if (!command.tenantId || !command.boardId) throw boardCommandError('kanban_command_invalid', 'A batch create needs a tenant and a board.');
  if (!Array.isArray(command.items) || command.items.length === 0 || command.items.length > KANBAN_BATCH_CREATE_MAX) {
    throw boardCommandError('kanban_command_invalid', `A batch create takes 1–${KANBAN_BATCH_CREATE_MAX} items.`);
  }
  const onExisting = command.onExisting ?? 'skip';
  if (onExisting !== 'skip' && onExisting !== 'refresh') throw boardCommandError('kanban_command_invalid', 'onExisting must be skip or refresh.');
  const board = await boards.get(command.boardId);
  if (!board || board.tenantId !== command.tenantId) throw boardCommandError('kanban_board_not_found', 'Board does not exist in this tenant.');

  // Everything is checked before anything is written: one bad item fails the batch.
  const seen = new Set<string>();
  command.items.forEach((item, i) => assertBatchCardInput(board, item, i, seen));
  for (const assigneeId of new Set(command.items.flatMap((i) => (i.assigneeId ? [i.assigneeId.trim()] : [])))) {
    if (!(await assigneeCanSeeBoard(board, assigneeId))) {
      throw boardCommandError('kanban_assignee_invalid', `The assignee '${assigneeId}' cannot see this board.`);
    }
  }

  const tops = await columnTopOrders(board, [...new Set(command.items.map((i) => i.columnId))]);
  const now = nowIso();
  const planned = command.items.map((item) => {
    const order = Math.max(tops.get(item.columnId) ?? 0, 0) + 1;
    tops.set(item.columnId, order);
    const card: KanbanCard = {
      id: batchCardIdOf(board.tenantId, board.id, item.sourceId),
      boardId: board.id,
      tenantId: board.tenantId,
      columnId: item.columnId,
      title: item.title,
      source: 'api',
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(item.sourceLabel !== undefined ? { sourceLabel: item.sourceLabel } : {}),
      ...(item.sourceRef !== undefined ? { sourceRef: { label: item.sourceRef.label, path: item.sourceRef.path } } : {}),
      ...(item.priority !== undefined ? { priority: item.priority } : {}),
      ...(item.dueAt !== undefined ? { dueAt: new Date(item.dueAt).toISOString() } : {}),
      ...(item.assigneeId !== undefined ? { assigneeId: item.assigneeId.trim() } : {}),
      ...(item.assigneeRole !== undefined ? { assigneeRole: item.assigneeRole.trim() } : {}),
      ...(item.labels !== undefined ? { labels: [...item.labels] } : {}),
      ...(item.facets !== undefined && Object.keys(item.facets).length > 0 ? { facets: { ...item.facets } } : {}),
      version: 1,
      order,
      createdAt: now,
      updatedAt: now,
    };
    return { item, card };
  });

  // Each card is its own atomic write; a failure is reported for that item alone.
  const items = await mapBounded(planned, BATCH_CONCURRENCY, async ({ item, card }) => {
    const base = { sourceId: item.sourceId, cardId: card.id };
    try {
      if (await cards.putIfAbsent(card)) return { ...base, status: 'created' as const };
      const existing = await cards.get(card.id);
      if (!existing || existing.boardId !== board.id || existing.tenantId !== board.tenantId) {
        return { ...base, status: 'collision' as const, error: 'The derived card id belongs to another board.' };
      }
      if (onExisting === 'skip') return { ...base, status: 'existing' as const };
      const facts: KanbanCardFacts = {
        title: item.title,
        ...(item.description !== undefined ? { description: item.description } : {}),
        ...(item.dueAt !== undefined ? { dueAt: new Date(item.dueAt).toISOString() } : {}),
        ...(item.sourceLabel !== undefined ? { sourceLabel: item.sourceLabel } : {}),
        ...(item.facets !== undefined ? { facets: item.facets } : {}),
      };
      return { ...base, status: (await refreshCardFacts(board, existing, facts)).refreshed ? 'refreshed' as const : 'existing' as const };
    } catch (err) {
      return { ...base, status: 'failed' as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  if (command.notifyAssignees === true) {
    for (const [i, r] of items.entries()) {
      const card = planned[i]!.card;
      if (r.status === 'created' && card.assigneeId) {
        await emitAssignmentNotification({ tenantId: board.tenantId, card, assigneeId: card.assigneeId, boardName: board.name });
      }
    }
  }
  if (items.some((r) => r.status === 'created' || r.status === 'refreshed')) notifyBoardChanged(board.id);
  return { items };
}

/** A batch patch item's shape, or why it is not one. */
function batchPatchProblem(item: PatchKanbanCardsBatchCommand['items'][number]): string | null {
  if (typeof item !== 'object' || item === null) return 'is not an object.';
  if (typeof item.cardId !== 'string' || item.cardId.length === 0) return 'cardId must be non-empty text.';
  if (item.expectedVersion !== undefined && (!Number.isInteger(item.expectedVersion) || item.expectedVersion < 1)) return 'expectedVersion must be a whole number of at least 1.';
  const patch = item.patch;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return 'patch must be an object.';
  const extra = Object.keys(patch).filter((k) => !BATCH_PATCH_FIELDS.has(k));
  if (extra.length > 0) return `a batch patch may change only dueAt, priority, labels and facets (got ${extra.join(', ')}).`;
  if (Object.keys(patch).length === 0) return 'patch changes nothing.';
  if (patch.dueAt !== undefined && patch.dueAt !== null && !isoOk(patch.dueAt)) return 'dueAt must be an ISO date or null.';
  if (patch.priority !== undefined && !PRIORITIES.has(patch.priority)) return 'priority must be low, normal or high.';
  if (patch.labels !== undefined && !stringList(patch.labels)) return 'labels must be a list of text.';
  if (patch.facets !== undefined) {
    try { assertFacetPatch(patch.facets); } catch (err) { return err instanceof Error ? err.message : 'facets are invalid.'; }
  }
  return null;
}

const batchFieldsOf = (c: KanbanCard): string => JSON.stringify([c.dueAt ?? null, c.priority ?? null, c.labels ?? null, c.facets ?? null]);

async function applyCardsPatchBatch(command: PatchKanbanCardsBatchCommand): Promise<PatchKanbanCardsBatchResult> {
  if (!command.tenantId || !command.boardId) throw boardCommandError('kanban_command_invalid', 'A batch patch needs a tenant and a board.');
  if (!Array.isArray(command.items) || command.items.length === 0 || command.items.length > KANBAN_BATCH_PATCH_MAX) {
    throw boardCommandError('kanban_command_invalid', `A batch patch takes 1–${KANBAN_BATCH_PATCH_MAX} items.`);
  }
  const board = await boards.get(command.boardId);
  if (!board || board.tenantId !== command.tenantId) throw boardCommandError('kanban_board_not_found', 'Board does not exist in this tenant.');

  // Each item is its own CAS. Not atomic across cards: the caller retries conflicts.
  const items = await mapBounded(command.items, BATCH_CONCURRENCY, async (item): Promise<PatchKanbanCardsBatchResult['items'][number]> => {
    const cardId = typeof item?.cardId === 'string' ? item.cardId : '';
    const problem = batchPatchProblem(item);
    if (problem) return { cardId, status: 'invalid', error: problem };
    const patch: KanbanCardPatch = {
      ...(item.patch.dueAt !== undefined ? { dueAt: item.patch.dueAt === null ? null : new Date(item.patch.dueAt).toISOString() } : {}),
      ...(item.patch.priority !== undefined ? { priority: item.patch.priority } : {}),
      ...(item.patch.labels !== undefined ? { labels: [...item.patch.labels] } : {}),
      ...(item.patch.facets !== undefined ? { facets: item.patch.facets } : {}),
    };
    try {
      // A patch that would change nothing writes nothing and reports `unchanged`.
      const current = await cards.get(cardId);
      if (current && current.boardId === board.id && current.tenantId === board.tenantId
        && (item.expectedVersion === undefined || (current.version ?? 1) === item.expectedVersion)
        && batchFieldsOf(applyKanbanCardPatch(current, patch)) === batchFieldsOf(current)) {
        return { cardId, status: 'unchanged', card: current };
      }
      const { card } = await applyKanbanCardPatchCommand({
        type: 'card.patch', tenantId: board.tenantId, boardId: board.id, cardId, patch,
        // A data comparison the service makes, never a function built from input (ADR 0774).
        precondition: (fresh) => item.expectedVersion === undefined || (fresh.version ?? 1) === item.expectedVersion,
      });
      return { cardId, status: 'updated', card };
    } catch (err) {
      const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
      const status: KanbanBatchPatchStatus = code === 'kanban_card_not_found' ? 'not_found'
        : code === 'kanban_card_precondition_failed' || code === 'kanban_card_conflict' ? 'conflict'
        : code === 'kanban_card_invalid' || code === 'kanban_command_invalid' ? 'invalid'
        : 'failed';
      return { cardId, status, error: err instanceof Error ? err.message : String(err) };
    }
  });
  if (items.some((r) => r.status === 'updated')) notifyBoardChanged(board.id);
  return { items };
}

async function applyKanbanCardPatchCommand(command: PatchKanbanCardCommand): Promise<PatchKanbanCardResult> {
  if (!command.tenantId || !command.boardId || !command.cardId) {
    throw boardCommandError('kanban_command_invalid', 'Card mutations require a tenant, board, and card.');
  }
  if (command.patch.sourceRef !== undefined && command.patch.sourceRef !== null) assertSourceRef(command.patch.sourceRef);
  if (command.patch.facets !== undefined) assertFacetPatch(command.patch.facets);
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
    if (typeof command.patch.assigneeRole === 'string') assertAssigneeRoleFits(board, command.patch.assigneeRole);
    if (command.precondition && !command.precondition(card, board)) {
      throw boardCommandError('kanban_card_precondition_failed', 'The card is no longer in the state this change requires.');
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
    next.tenantId = board.tenantId; // ADR 0872 D1 — stamps a legacy row on its first edit
    if (moved || repositioned) {
      const siblings = (await cardsOnBoards(board.tenantId, new Set([board.id])))
        .filter((candidate) => candidate.columnId === targetColumnId && candidate.id !== card.id);
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
    // ADR 1155 D6 — a due notice is about one date; once the date is gone or
    // moved, the notice is stale. The sweep sends a fresh one for a new date.
    if (card.dueAt && card.assigneeId && next.dueAt !== card.dueAt) {
      await withdrawDueNotifications({ tenantId: board.tenantId, cardId: card.id, recipientUserId: card.assigneeId });
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

function isKanbanWorkItemDeliveryOutcome(value: unknown): value is KanbanWorkItemDeliveryOutcome {
  return typeof value === 'string'
    && (KANBAN_WORK_ITEM_DELIVERY_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Records a worker's durable delivery disposition before it transitions the
 * leased outbox row. The audit id is deterministic for one claimed attempt, so
 * a recovery pass cannot inflate fleet counts. Recording first is intentional:
 * if this durable observability write cannot be made, the worker leaves its
 * lease to expire instead of silently completing an unaccounted delivery.
 */
export async function recordWorkItemDeliveryOutcome(
  claimed: ClaimedKanbanWorkItemOutbox,
  outcome: KanbanWorkItemDeliveryOutcome,
  now: number = Date.now(),
): Promise<void> {
  const entry = claimed.entry;
  const attempt = entry.attempts;
  const eventIdentity = stableWorkIdentity([entry.eventId, 'delivery-outcome', String(attempt), outcome]);
  // Delivery outcomes are the only audit type read as a short operational
  // window. Prefixing the new type with its UTC day lets that view read one or
  // two day slices instead of scanning the complete append-only audit history.
  const day = new Date(now).toISOString().slice(0, 10);
  await workItemAudit.putIfAbsent({
    auditId: `work-audit-delivery-${day}-${eventIdentity}`,
    tenantId: entry.tenantId,
    boardId: entry.boardId,
    workItemId: entry.workItemId,
    type: 'work-item.delivery-outcome',
    at: new Date(now).toISOString(),
    metadata: { outcome, attempt },
  });
}

const WORK_ITEM_DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1_000;

function emptyWorkItemDeliveryOutcomes(): Record<KanbanWorkItemDeliveryOutcome, number> {
  return {
    started: 0,
    'not-eligible': 0,
    deferred: 0,
    'workflow-unresolved': 0,
    retried: 0,
    'dead-lettered': 0,
  };
}

/**
 * Fleet-safe Operations projection for the reusable Kanban core. Both stores
 * are durable host-extension collections shared by all serving instances. The
 * response intentionally aggregates only closed outcome names and queue ages;
 * no work-item, tenant, board, workflow, input, user, or error data crosses
 * this boundary.
 */
export async function buildKanbanWorkItemDeliverySummary(
  now: number = Date.now(),
): Promise<KanbanWorkItemDeliverySummary> {
  const startsAtMs = now - WORK_ITEM_DELIVERY_WINDOW_MS;
  const days = new Set<string>();
  for (let day = new Date(startsAtMs); day <= new Date(now); day = new Date(day.getTime() + 24 * 60 * 60 * 1_000)) {
    days.add(day.toISOString().slice(0, 10));
  }
  const [entries, auditSlices] = await Promise.all([
    workItemOutbox.list(),
    Promise.all([...days].map((day) => workItemAudit.listByPrefix(`work-audit-delivery-${day}-`))),
  ]);
  const audit = auditSlices.flat();
  const outcomes = emptyWorkItemDeliveryOutcomes();
  for (const entry of audit) {
    if (entry.type !== 'work-item.delivery-outcome') continue;
    const at = Date.parse(entry.at);
    const outcome = entry.metadata.outcome;
    if (!Number.isFinite(at) || at < startsAtMs || at > now || !isKanbanWorkItemDeliveryOutcome(outcome)) continue;
    outcomes[outcome] += 1;
  }

  const pending = entries.filter((entry) => entry.status === 'pending');
  const oldestPendingCreatedAt = pending
    .map((entry) => entry.createdAt)
    .filter((at) => Number.isFinite(Date.parse(at)))
    .sort()[0] ?? null;
  return {
    queue: {
      pending: pending.length,
      claimed: entries.filter((entry) => entry.status === 'claimed').length,
      delivered: entries.filter((entry) => entry.status === 'delivered').length,
      deadLettered: entries.filter((entry) => entry.status === 'dead-lettered').length,
      oldestPendingCreatedAt,
      oldestPendingAgeS: oldestPendingCreatedAt === null
        ? null
        : Math.max(0, Math.round((now - Date.parse(oldestPendingCreatedAt)) / 1_000)),
    },
    outcomes,
    window: {
      startsAt: new Date(startsAtMs).toISOString(),
      endsAt: new Date(now).toISOString(),
    },
  };
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

/** ADR 1155 D3 — one page of an already-ordered "assigned to me" list. The cursor is
 *  the last card's `(updatedAt, id)`, so a page boundary survives cards added later. */
export function pageAssignedCards<T extends { id: string; updatedAt: string }>(
  ordered: readonly T[], q: { limit: number; cursor?: string },
): { cards: T[]; total: number; nextCursor?: string } {
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > KANBAN_PAGE_MAX) {
    throw boardCommandError('kanban_command_invalid', `limit must be a whole number from 1 to ${KANBAN_PAGE_MAX}.`);
  }
  const keyOf = (c: T): string => `${c.updatedAt}\u0000${c.id}`;
  let after: string | undefined;
  if (q.cursor) {
    try {
      const o = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as { a?: unknown };
      if (typeof o.a === 'string') after = o.a;
    } catch { /* fall through */ }
    if (after === undefined) throw boardCommandError('kanban_cursor_invalid', 'This cursor is not an assigned-cards cursor. Start again without it.');
  }
  const rest = after === undefined ? ordered : ordered.filter((c) => keyOf(c) > after!);
  const page = rest.slice(0, q.limit);
  return {
    cards: page,
    total: ordered.length,
    ...(rest.length > q.limit ? { nextCursor: Buffer.from(JSON.stringify({ a: keyOf(page[page.length - 1]!) }), 'utf8').toString('base64url') } : {}),
  };
}

/** Every id in one family slice of the card index, in key order. */
async function cardIndexIds(tenantId: string, family: string, segments: string[]): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await listIndexPage(tenantId, KANBAN_CARD_TYPE, family, undefined, { segments, limit: 500, ...(cursor ? { cursor } : {}) });
    for (const row of page.rows) ids.push(row.id);
    if (!page.cursor || page.rows.length < 500) return ids;
    cursor = page.cursor;
  }
}

/** ADR 1155 P3c-2 — the cards that might be addressed to `userId`, and their boards.
 *  Index path: the caller's slice of the `assignee` family plus the tenant's `role`
 *  family (role-addressed cards only), point-read, and only the boards those cards
 *  sit on. Before the tenant's index is built: today's read of every tenant board and
 *  card. The caller judges each stored row either way, so a stale marker costs a read
 *  and never a wrong card; a card whose marker is missing appears once the hourly
 *  drift check rebuilds the tenant (the ADR 0872 D4 stance for display reads). */
async function assignedCandidates(tenantId: string, userId: string): Promise<{ candidates: KanbanCard[]; boardById: Map<string, KanbanBoard> }> {
  if ((await ensureSystemIndexBuilt(tenantId, KANBAN_CARD_TYPE)) === 'built') {
    const ids = new Set([...(await cardIndexIds(tenantId, 'assignee', [userId])), ...(await cardIndexIds(tenantId, 'role', []))]);
    const rows = (await readCardsBounded([...ids])).filter((c): c is KanbanCard => c !== null && c.tenantId === tenantId);
    const boardById = new Map<string, KanbanBoard>();
    for (const boardId of new Set(rows.map((c) => c.boardId))) {
      const board = await boards.get(boardId);
      if (board && board.tenantId === tenantId) boardById.set(board.id, board);
    }
    return { candidates: rows, boardById };
  }
  const tenantBoards = (await boards.list()).filter((b) => b.tenantId === tenantId);
  const boardById = new Map(tenantBoards.map((b) => [b.id, b]));
  return { candidates: await cardsOnBoards(tenantId, new Set(boardById.keys())), boardById };
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
): Promise<Array<KanbanCard & { boardName: string; columnName: string; terminal: boolean; doneColumnId?: string }>> {
  const { candidates, boardById } = await assignedCandidates(tenantId, userId);
  const roles = new Set(roleKeys);
  // ADR 1137 D4 — the viewer's own role on a board's subject, resolved once per
  // board and only for boards that carry a subject-role card.
  const subjectRoles = new Map<string, Promise<string | null>>();
  const heldOn = (board: KanbanBoard, kind: string): Promise<string | null> => {
    let p = subjectRoles.get(board.id);
    if (!p) {
      const subject = boardSubject(board);
      const resolver = subjectRoleResolver(kind);
      p = subject && subject.kind === kind && resolver ? resolver.roleOf(tenantId, subject, userId) : Promise.resolve(null);
      subjectRoles.set(board.id, p);
    }
    return p;
  };
  const roleMatches = async (board: KanbanBoard, assigneeRole: string): Promise<boolean> => {
    const parsed = parseSubjectRole(assigneeRole);
    if (!parsed) return roles.has(assigneeRole);
    return (await heldOn(board, parsed.kind)) === parsed.role;
  };
  const out: Array<KanbanCard & { boardName: string; columnName: string; terminal: boolean; doneColumnId?: string }> = [];
  for (const card of candidates) {
    const board = boardById.get(card.boardId);
    if (!board) continue; // cross-tenant / orphaned — never leak
    const mine = card.assigneeId === userId || (card.assigneeRole ? await roleMatches(board, card.assigneeRole) : false);
    if (!mine) continue;
    const column = board.columns.find((c) => c.id === card.columnId);
    out.push({
      ...card,
      boardName: board.name,
      columnName: column?.name ?? card.columnId,
      terminal: isTerminalColumn(board, card.columnId),
      // ADR 1138 D2 — where the mirror's Done sends it: the board's completion
      // lane (never a cancellation lane).
      ...(doneColumnOf(board) ? { doneColumnId: doneColumnOf(board)!.id } : {}),
    });
  }
  // Oldest change first, then id, so the order is total and a page cursor is stable.
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
  if (card && board && deleted) {
    if (card.workItemId) {
      await workItemDismissals.put({
        workItemId: card.workItemId, tenantId: board.tenantId, boardId: board.id, cardId: card.id, dismissedAt: nowIso(),
      });
    }
    await deleteWorkItemsForCard(board.tenantId, card.id);
  }
  return deleted;
}

/** Record the run a card triggered (set by the route after starting it). A new
 *  run id clears any status the previous run left, so the card never shows the
 *  old run's outcome against the new run (ADR 0774 D3). Only the loop's own
 *  dispatch passes `'running'` — the human trigger lane leaves it null. */
export async function setCardLastRun(
  cardId: string,
  runId: string,
  status: KanbanCardRunStatus | null = null,
): Promise<void> {
  await updateCardFields(cardId, { lastRunId: runId, lastRunStatus: status });
}

/** ADR 0774 D2 — the deterministic run id of the work loop's pick of `card` at
 *  `version` (and its birth — see below). The claim consumes the version, so a re-presented pick resolves to
 *  the SAME run (`startWorkflowRun({ runId })`), never a second one, and any
 *  later pick (after a restore or a compensation, each of which bumps the
 *  version) gets a fresh id. */
export function pickRunIdFor(card: Pick<KanbanCard, 'id' | 'version' | 'createdAt'>): string {
  // `createdAt` is in the key because card ids are NOT unique over time: an
  // add-todo or KickTodo card deleted and re-filed comes back under the same
  // deterministic id at version 1, and without it would re-present the OLD
  // card's run id — adopting a finished run instead of starting new work
  // (grade-code KSCD-2).
  const key = createHash('sha256').update(`${card.id}\u0000${card.createdAt}\u0000${card.version ?? 0}`).digest('hex').slice(0, 32);
  return `kanban-pick-run-${key}`;
}

export function isPreconditionFailure(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'kanban_card_precondition_failed';
}

/**
 * ADR 0774 D2 — atomically claim a To Do card for a work-loop run. One CAS moves
 * the card into the working lane and stamps `lastRunId` + `lastRunStatus:
 * 'running'`, but only if the card is STILL in `fromColumnId` at the version the
 * pass saw. Returns the claimed card, or null when another pass (or a human) got
 * there first. The caller starts the run with `claimed.lastRunId`.
 */
export async function claimCardForRun(input: {
  card: KanbanCard;
  boardId: string;
  tenantId: string;
  fromColumnId: string;
  toColumnId: string;
}): Promise<KanbanCard | null> {
  const seenVersion = input.card.version ?? 0;
  const runId = pickRunIdFor(input.card);
  try {
    const { card } = await applyBoardCommand({
      type: 'card.patch',
      tenantId: input.tenantId,
      boardId: input.boardId,
      cardId: input.card.id,
      columnId: input.toColumnId,
      patch: { lastRunId: runId, lastRunStatus: 'running' },
      precondition: (fresh) => fresh.columnId === input.fromColumnId && (fresh.version ?? 0) === seenVersion,
    });
    return card;
  } catch (err) {
    if (isPreconditionFailure(err)) return null;
    throw err;
  }
}

/**
 * ADR 0774 D2 — hand a claimed card back to To Do: a claim whose run never
 * started, or (grade-code KSCD-1) a recovery restore. Guarded on the FRESH card
 * still carrying THIS run id AND still sitting in the working lane, so a human
 * who moved it meanwhile, or a newer pick, wins. A restore that checked a
 * snapshot and then moved unconditionally could yank a card another pass had
 * just re-claimed and cause a second run. Returns whether it moved.
 */
export async function releaseCardClaim(input: {
  cardId: string;
  boardId: string;
  tenantId: string;
  runId: string;
  workingColumnId: string;
  toColumnId: string;
  /** The status the released card keeps (a restore records the run's outcome);
   *  default clears it. */
  lastRunStatus?: KanbanCardRunStatus | null;
  /** Written in the SAME CAS as the move (a restore's reason note). */
  blockerNote?: string;
  /** ADR 0963 A1 — when set, the release lands only if the fresh card's note is
   *  still this one, so a note composed from a snapshot cannot overwrite a
   *  person's edit. `undefined` and `''` compare equal (both mean "no note"). */
  expectedBlockerNote?: string;
}): Promise<boolean> {
  try {
    await applyBoardCommand({
      type: 'card.patch',
      tenantId: input.tenantId,
      boardId: input.boardId,
      cardId: input.cardId,
      columnId: input.toColumnId,
      patch: {
        lastRunStatus: input.lastRunStatus ?? null,
        ...(input.blockerNote !== undefined ? { blockerNote: input.blockerNote } : {}),
      },
      precondition: (fresh) => fresh.lastRunId === input.runId && fresh.columnId === input.workingColumnId
        && (!('expectedBlockerNote' in input) || (fresh.blockerNote ?? '') === (input.expectedBlockerNote ?? '')),
    });
    return true;
  } catch (err) {
    if (isPreconditionFailure(err)) return false;
    throw err;
  }
}

/**
 * ADR 0774 D3 — stamp a run's state onto the card it belongs to, only while the
 * card still points at that run (a newer pick is never overwritten). Returns
 * whether it wrote.
 */
export async function recordCardRunStatus(
  cardId: string,
  runId: string,
  status: KanbanCardRunStatus,
): Promise<boolean> {
  const card = await cards.get(cardId);
  const board = card ? await boards.get(card.boardId) : null;
  if (!card || !board || card.lastRunId !== runId || card.lastRunStatus === status) return false;
  try {
    await applyBoardCommand({
      type: 'card.patch',
      tenantId: board.tenantId,
      boardId: board.id,
      cardId,
      patch: { lastRunStatus: status },
      precondition: (fresh) => fresh.lastRunId === runId,
    });
    return true;
  } catch (err) {
    if (isPreconditionFailure(err)) return false;
    throw err;
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
  for (const listed of await cards.list()) {
    if (!boardIds.has(listed.boardId)) continue;
    let settled = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const card = await cards.get(listed.id);
      if (!card || !boardIds.has(card.boardId)) { settled = true; break; }
      const board = await boards.get(card.boardId);
      if (!board || board.tenantId !== tenantId) { settled = true; break; }
      const mine = (card.assigneeId !== undefined && forms.has(card.assigneeId))
        || (card.createdBy !== undefined && forms.has(card.createdBy));
      // A handoff may name the subject even when another person owns the card.
      const noteTouches = card.handoff !== undefined && (
        (card.handoffBy !== undefined && forms.has(card.handoffBy))
        || card.handoff.decisions.some((d) => d.decidedBy !== undefined && forms.has(d.decidedBy)));
      if (!mine && !noteTouches) { settled = true; break; }
      const next: KanbanCard = { ...card, tenantId, updatedAt: nowIso(), version: (card.version ?? 0) + 1 };
      if (mine) {
        next.title = ERASED;
        if (next.assigneeId !== undefined && forms.has(next.assigneeId)) next.assigneeId = ERASED;
        if (next.createdBy !== undefined && forms.has(next.createdBy)) next.createdBy = ERASED;
        if (next.description !== undefined) next.description = ERASED;
        if (next.assignmentReason !== undefined) next.assignmentReason = ERASED;
        // Erase ALL prose (including machine run ids), retaining only the
        // opaque hold bit so erasure cannot authorize autonomous execution.
        if (next.blockerNote !== undefined) next.blockerNote = card.blockerNote?.includes(RESTORE_NOTE_MARK)
          ? `${ERASED}\n${RESTORE_NOTE_MARK}` : ERASED;
        // ADR 1155 D1 — facet values are ids, but one could still name a person.
        delete next.facets;
      }
      delete next.handoff; delete next.handoffBy; delete next.handoffAt;
      if (await cards.compareAndSwap(card, next)) { settled = true; break; }
      // A restore/edit may have arrived. Re-read and recompute from its row.
    }
    if (!settled) throw new Error('kanban_subject_erasure_conflict');
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
  await __clearSystemIndexType(KANBAN_CARD_TYPE);
  await workItems.__clear();
  await workItemAudit.__clear();
  await workItemOutbox.__clear();
  await workItemRunIndex.__clear();
  await operationReceipts.__clear();
  await workItemDismissals.__clear();
}

// ADR 0789 — this tenant's board references to a SHARED workflow follow its fork:
// a column's trigger, a card's bound workflow, and a work item that has not
// started (an item already running or finished keeps the id it ran — history).
onWorkflowForked('kanban', async (tenantId, from, to) => {
  let n = 0;
  for (const board of await listBoards(tenantId)) {
    if (board.columns.some((c) => c.triggerWorkflowId === from)) {
      if (await casRepoint(boards, board.id, (b) => (b.columns.some((c) => c.triggerWorkflowId === from)
        ? { ...b, columns: b.columns.map((c) => (c.triggerWorkflowId === from ? { ...c, triggerWorkflowId: to } : c)) }
        : null))) n += 1;
    }
    for (const card of await listCardsExact(board.id)) { // a repoint must not miss a card (ADR 0872 D4)
      if (card.workflowId !== from) continue;
      if (await casRepoint(cards, card.id, (c) => (c.workflowId === from ? { ...c, tenantId: board.tenantId, workflowId: to } : null))) n += 1;
    }
  }
  for (const item of await workItems.listForTenantIndexed(tenantId)) {
    if (item.workflowId !== from || item.execution.status !== 'idle') continue;
    if (await casRepoint(workItems, item.workItemId, (w) => (w.workflowId === from && w.execution.status === 'idle' ? { ...w, workflowId: to } : null))) n += 1;
  }
  return n;
});
