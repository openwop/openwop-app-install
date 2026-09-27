/**
 * KanbanBoardView — the ONE board renderer shared by the standalone `/boards`
 * page (KanbanPage) and the embedded agent-workspace Board tab
 * (AgentBoardPanel). Previously those were two divergent boards (drag-and-drop
 * vs a "Move" dropdown); this unifies them.
 *
 * Features:
 *  - @dnd-kit drag-and-drop (pointer + keyboard sensor — focus a card, Space to
 *    pick up, arrows to move, Space to drop) with an optimistic local move.
 *  - Rich cards: source chip, workflow name, priority, due date, run link,
 *    and ONE lane-contextual action (boards redesign 2026-06-05): To do →
 *    Start work · Working → Mark done · Waiting → Resolve · Done → Reopen.
 *    Reopen moves back into the trigger lane and therefore fires the
 *    workflow — the same semantics as dragging the card back.
 *  - Trigger columns (⚡) read as accent-outlined; waiting cards carry an
 *    amber edge bar.
 *  - Per-column count badge + dashed add-card affordance.
 *
 * Presentational + interactive: it owns drag state but delegates persistence to
 * the parent via onMoveCard / onCreateCard / onDeleteCard, so each surface keeps
 * its own data-fetch + live-refresh wiring.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type ScreenReaderInstructions,
} from '@dnd-kit/core';
import { Link } from 'react-router-dom';
import { TaskSourceChip } from '../agents/TaskSourceChip.js';
import { workflowName } from '../agents/roleTemplates.js';
import { AlertIcon, CheckIcon, GripVerticalIcon, PencilIcon, PlayIcon, RotateCwIcon, SettingsIcon, UserIcon, WorkflowIcon, XIcon, ZapIcon } from '../ui/icons/index.js';
import { IconButton } from '../ui/IconButton.js';
import { announce } from '../ui/announce.js';
import { Button } from '../ui/Button.js';
import { Markdown } from '../ui/Markdown.js';
import { MarkdownEditor } from '../ui/MarkdownEditor.js';
import { AssigneeControl } from './AssigneeControl.js';
import { columnSnapCoordinateGetter } from './columnKeyboardCoordinates.js';
import type { KanbanBoard, KanbanCard, KanbanColumn, KanbanCardSource, KanbanWorkItem } from './kanbanClient.js';
import { columnLaneKind, type LaneKind } from './laneKind.js';


type MoveKind = 'todo' | 'working' | 'waiting' | 'done';

/** KB-R2-4 — the most cards ONE paste may create. Each card is its own POST,
 *  so an unbounded paste would burn the per-IP write budget (a wall of 429s);
 *  the cap surfaces IN the confirm-button label, never as a silent trim. */
const PASTE_SPLIT_CAP = 25;

/** Match a column to a canonical lane by id or display name (BLD-8: shared with
 *  agentViewModel via `columnLaneKind`) so the non-drag quick-actions know where
 *  "Start" / "Waiting" / "Done" point on boards using either convention. */
const laneKindOf = (col: KanbanColumn): LaneKind | null => columnLaneKind(col);

/** The changed-fields-only payload the card edit form can produce (KB-R2-1).
 *  Only fields the user actually altered are present — the PATCH stays
 *  minimal, so an edit can never clobber a field it didn't touch. */
export interface CardPatch {
  title?: string;
  description?: string;
  priority?: 'low' | 'normal' | 'high';
  dueAt?: string;
  blockerNote?: string;
}

/** A canvas-neutral position intent. The backend turns this into a durable
 * fractional rank under one card CAS; consumers never manipulate ranks. */
export interface CardMovePosition {
  beforeCardId?: string;
  afterCardId?: string;
}

const CARD_DROP_PREFIX = 'kanban-card-target:';

/** The full create-card payload the add-card form can produce. */
export interface NewCardInput {
  title: string;
  source?: KanbanCardSource;
  description?: string;
  workflowId?: string;
  priority?: 'low' | 'normal' | 'high';
  dueAt?: string;
  assignmentReason?: string;
  blockerNote?: string;
}

/** A workflow a Kanban consumer permits a card to bind. Strings remain
 * supported for embedded legacy consumers; the core board page passes the
 * tenant-owned workflow inventory so user-authored names are preserved. */
export type KanbanWorkflowOption = string | { workflowId: string; name: string };

function workflowOptionId(option: KanbanWorkflowOption): string {
  return typeof option === 'string' ? option : option.workflowId;
}

function workflowOptionName(option: KanbanWorkflowOption): string {
  return typeof option === 'string' ? workflowName(option) : option.name;
}

function workflowOptionLabel(workflowId: string, options: readonly KanbanWorkflowOption[] | undefined): string {
  const option = options?.find((candidate) => workflowOptionId(candidate) === workflowId);
  return option ? workflowOptionName(option) : workflowName(workflowId);
}

const WORK_ITEM_STATE_KEY: Record<KanbanWorkItem['state'],
  'workStateProposed' | 'workStateReady' | 'workStateRunning' | 'workStateBlocked' | 'workStateCompleted' | 'workStateCancelled'
> = {
  proposed: 'workStateProposed',
  ready: 'workStateReady',
  running: 'workStateRunning',
  blocked: 'workStateBlocked',
  completed: 'workStateCompleted',
  cancelled: 'workStateCancelled',
};

/** Compact operational projection for any core WorkItem. This deliberately has
 * no App Builder assumptions: a canvas contributes scope/source provenance,
 * while the shared Kanban renderer owns the status, accessibility, and run
 * affordance for every board consumer. */
function WorkItemSummary({
  workItem,
  workflowOptions,
  onRun,
  running,
}: {
  workItem: KanbanWorkItem;
  workflowOptions?: readonly KanbanWorkflowOption[] | undefined;
  onRun?: ((workItemId: string) => void) | undefined;
  running?: boolean | undefined;
}): JSX.Element {
  const { t } = useTranslation('kanban');
  const canRun = workItem.execution.mode === 'manual'
    && workItem.state === 'ready'
    && workItem.execution.status === 'idle'
    && Boolean(workItem.workflowId)
    && Boolean(onRun);
  const runStatus = workItem.execution.status === 'starting' || workItem.execution.status === 'running'
    ? t('workRunInProgress')
    : workItem.execution.status === 'succeeded'
      ? t('workRunSucceeded')
      : null;
  return (
    <div className="kb-work-item" role="group" aria-label={t('workItemAria', { state: t(WORK_ITEM_STATE_KEY[workItem.state]) })}>
      <div className="kb-work-item-head">
        <span className={`kb-work-state kb-work-state--${workItem.state}`} role="status">{t(WORK_ITEM_STATE_KEY[workItem.state])}</span>
        <span className="kb-work-mode">{workItem.execution.mode === 'auto' ? t('workModeAuto') : t('workModeManual')}</span>
      </div>
      <div className="kb-work-meta">
        <span>{t('workScope', { scope: workItem.scope.kind })}</span>
        <span>{t('workSource', { source: workItem.source.kind })}</span>
        {workItem.dependencyCount > 0 ? <span>{t('workDependencies', { count: workItem.dependencyCount })}</span> : null}
      </div>
      {workItem.workflowId ? (
        <div className="kb-work-workflow"><WorkflowIcon size={12} aria-hidden /> {workflowOptionLabel(workItem.workflowId, workflowOptions)}</div>
      ) : (
        <div className="kb-work-warning"><AlertIcon size={12} aria-hidden /> {t('workNoWorkflow')}</div>
      )}
      {runStatus ? <div className="kb-work-run-status" role="status">{runStatus}</div> : null}
      {workItem.execution.lastError ? <div className="kb-work-warning" role="status"><AlertIcon size={12} aria-hidden /> {t('workRunNeedsAttention')}</div> : null}
      {canRun ? (
        <Button
          variant="accent-solid"
          size="sm"
          disabled={running}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onRun?.(workItem.workItemId); }}
        >
          <PlayIcon size={12} aria-hidden /> {running ? t('workStarting') : t('runWork')}
        </Button>
      ) : null}
    </div>
  );
}

const SOURCE_OPTIONS: ReadonlyArray<{ value: KanbanCardSource; labelKey: string }> = [
  { value: 'human', labelKey: 'sourceHuman' },
  { value: 'discord', labelKey: 'sourceDiscord' },
  { value: 'agent', labelKey: 'sourceAgent' },
  { value: 'api', labelKey: 'sourceApi' },
];

function DraggableCard({
  card,
  lane,
  laneTargets,
  onDelete,
  onMove,
  onEdit,
  todoAutonomy,
  columnHasTrigger,
  isSelected,
  workflowOptions,
  workItem,
  onRunWorkItem,
  workItemRunning,
}: {
  card: KanbanCard;
  /** Canonical lane of the column this card sits in (null = custom lane). */
  lane: LaneKind | null;
  /** Canonical lane → real column id, for the contextual action target. */
  laneTargets: ReadonlyMap<MoveKind, string>;
  onDelete?: ((cardId: string) => void) | undefined;
  onMove?: ((cardId: string, toColumnId: string, position?: CardMovePosition) => void) | undefined;
  /** KB-R2-1 — absent ⇒ cards are not editable on this surface. */
  onEdit?: ((cardId: string, patch: CardPatch) => void) | undefined;
  /** ADR 0313 D3 — the fate of a BARE todo card on this (agent-owned) board:
   *  'agent-turn' = the heartbeat proposes it as an agent turn; 'off' = it
   *  won't auto-run. Absent (non-agent boards) ⇒ no hint. */
  todoAutonomy?: 'agent-turn' | 'off' | undefined;
  columnHasTrigger?: boolean | undefined;
  /** KB-BULK — this card is in the multi-selection (outline + announced). */
  isSelected?: boolean | undefined;
  /** Dynamic workflow labels supplied by the embedding canvas. */
  workflowOptions?: readonly KanbanWorkflowOption[] | undefined;
  /** Optional core WorkItem projection for this card. Legacy cards remain
   * card-only; any canvas type can opt in by passing this generic map. */
  workItem?: KanbanWorkItem | undefined;
  onRunWorkItem?: ((workItemId: string) => void) | undefined;
  workItemRunning?: boolean | undefined;
}): JSX.Element {
  const { t } = useTranslation('kanban');
  // Drag activates from a dedicated grip handle, NOT the whole card: dnd-kit's
  // listeners/attributes set role="button"+tabindex on their element, and the
  // card body holds real interactive controls (delete, run link, move buttons)
  // that must not be nested inside a role=button (invalid ARIA). setNodeRef
  // marks the draggable; setActivatorNodeRef + listeners mark the handle.
  const { attributes, listeners, setNodeRef: setDragNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({ id: card.id });
  // Each card is also a drop target. This gives every canvas that uses the
  // shared board true in-lane placement without opting into dnd-kit/sortable
  // or implementing a competing rank model.
  const { setNodeRef: setDropNodeRef } = useDroppable({
    id: `${CARD_DROP_PREFIX}${card.id}`,
    data: { kind: 'card', cardId: card.id, columnId: card.columnId },
  });
  const setNodeRef = (node: HTMLElement | null): void => {
    setDragNodeRef(node);
    setDropNodeRef(node);
  };
  const style: React.CSSProperties = {
    transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
    opacity: isDragging ? 0.5 : 1,
  };
  // KB-R2-1 — in-place edit (the Trello card-back / Linear `E` table-stakes
  // parity, scoped to the fields our create form already offers). Prefilled on
  // open; Save sends CHANGED fields only.
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState(card.title);
  const [eDescription, setEDescription] = useState(card.description ?? '');
  const [ePriority, setEPriority] = useState<'low' | 'normal' | 'high'>(card.priority ?? 'normal');
  const [eDueAt, setEDueAt] = useState(card.dueAt ? card.dueAt.slice(0, 10) : '');
  const [eBlocker, setEBlocker] = useState(card.blockerNote ?? '');
  // The diff BASELINE is the card as the user SAW it when the form opened —
  // not the live prop at save time. The board refetches every 5s (poll + SSE),
  // so a peer's concurrent rename would otherwise make the untouched stale
  // title read as "changed" and PATCH the old value back over theirs. Only a
  // field the USER altered relative to what they saw may enter the patch.
  const editBaseline = useRef<{ title: string; description: string; priority: 'low' | 'normal' | 'high'; dueAt: string; blockerNote: string } | null>(null);
  const openEdit = (): void => {
    const base = {
      title: card.title,
      description: card.description ?? '',
      priority: card.priority ?? 'normal' as const,
      dueAt: card.dueAt ? card.dueAt.slice(0, 10) : '',
      blockerNote: card.blockerNote ?? '',
    };
    editBaseline.current = base;
    setETitle(base.title);
    setEDescription(base.description);
    setEPriority(base.priority);
    setEDueAt(base.dueAt);
    setEBlocker(base.blockerNote);
    setEditing(true);
  };
  const submitEdit = (e: React.FormEvent): void => {
    e.preventDefault();
    const base = editBaseline.current;
    const title = eTitle.trim();
    if (!title || !base) return;
    const patch: CardPatch = {
      ...(title !== base.title ? { title } : {}),
      ...(eDescription.trim() !== base.description ? { description: eDescription.trim() } : {}),
      ...(ePriority !== base.priority ? { priority: ePriority } : {}),
      ...(eDueAt !== base.dueAt ? { dueAt: eDueAt } : {}),
      ...(eBlocker.trim() !== base.blockerNote ? { blockerNote: eBlocker.trim() } : {}),
    };
    setEditing(false);
    if (Object.keys(patch).length > 0) onEdit?.(card.id, patch);
  };
  const action = lane ? LANE_ACTION[lane] : null;
  const actionTarget = action ? laneTargets.get(action.to) : undefined;
  if (editing) {
    return (
      <div ref={setNodeRef} data-card-id={card.id} className="surface-card kb-card kanban-card-box" style={style}>
        <form onSubmit={submitEdit} className="surface-form">
          <div className="field"><input autoFocus className="ui-input u-w-full" value={eTitle} onChange={(e) => setETitle(e.target.value)} aria-label={t('editTitleAria')} placeholder={t('taskTitlePlaceholder')} /></div>
          <div className="field"><MarkdownEditor value={eDescription} onChange={setEDescription} placeholder={t('taskDescriptionPlaceholder')} rows={2} compact ariaLabel={t('taskDescriptionAria')} /></div>
          <div className="field">
            <select className="ui-input u-w-full" value={ePriority} onChange={(e) => setEPriority(e.target.value as 'low' | 'normal' | 'high')} aria-label={t('priorityAria')}>
              <option value="low">{t('priorityLowOption')}</option>
              <option value="normal">{t('priorityNormalOption')}</option>
              <option value="high">{t('priorityHighOption')}</option>
            </select>
          </div>
          <div className="field"><input className="ui-input u-w-full" type="date" value={eDueAt} onChange={(e) => setEDueAt(e.target.value)} aria-label={t('dueDateAria')} /></div>
          <div className="field"><input className="ui-input u-w-full" value={eBlocker} onChange={(e) => setEBlocker(e.target.value)} placeholder={t('blockerPlaceholder')} aria-label={t('blockerAria')} /></div>
          <div className="action-bar">
            <Button type="submit" variant="primary" size="sm">{t('common:save')}</Button>
            <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>{t('common:cancel')}</Button>
          </div>
        </form>
      </div>
    );
  }
  return (
    <div
      ref={setNodeRef}
      data-card-id={card.id}
      className={['surface-card kb-card kanban-card-box', lane === 'waiting' ? 'kb-card--waiting' : '', isSelected ? 'kb-card--selected' : ''].filter(Boolean).join(' ')}
      style={style}
    >
      <div className="u-flex u-items-center u-gap-2">
        <span
          ref={setActivatorNodeRef}
          aria-label={t('dragCardToLane', { title: card.title })}
          // ≥24px hit area (WCAG 2.5.8): 14px glyph + 5px padding; negative
          // margin keeps the row layout from growing. Rounded so the focus
          // ring (global [role=button]:focus-visible) reads cleanly.
          className="kanban-grip"
          {...listeners}
          {...attributes}
        >
          <GripVerticalIcon size={14} />
        </span>
        <div className="u-fw-600 u-fs-13 u-flex-1 u-minw-0">{card.title}</div>
        {onEdit ? (
          <button
            type="button"
            className="icon-button kb-card-edit"
            aria-label={t('editCard', { title: card.title })}
            aria-keyshortcuts="e"
            title={t('editCard', { title: card.title })}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); openEdit(); }}
          >
            <PencilIcon size={13} aria-hidden />
          </button>
        ) : null}
        {onDelete ? (
          <button
            type="button"
            className="icon-button kb-card-delete"
            aria-label={t('deleteCard', { title: card.title })}
            title={t('deleteCard', { title: card.title })}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onDelete(card.id); }}
          >
            <XIcon size={13} aria-hidden />
          </button>
        ) : null}
      </div>
      {card.description ? <Markdown className="kb-card-desc">{card.description}</Markdown> : null}
      <div className="u-flex u-gap-1 u-wrap u-items-center u-mt-1">
        {card.source ? <TaskSourceChip source={card.source} sourceLabel={card.sourceLabel} /> : null}
        {card.workflowId ? (
          <span className="u-iflex u-items-center u-gap-1 u-fs-12 u-text-accent">
            <WorkflowIcon size={12} /> {workflowOptionLabel(card.workflowId, workflowOptions)}
          </span>
        ) : null}
        {card.priority === 'high' ? <span className="chip chip--danger kb-prio">{t('priorityHigh')}</span> : null}
        {card.priority === 'low' ? <span className="chip chip--muted kb-prio">{t('priorityLow')}</span> : null}
        {card.createdBy ? (
          <span className="kb-person"><UserIcon size={12} aria-hidden /> {card.createdBy}</span>
        ) : null}
        {card.dueAt ? <span className="muted u-fs-12">{t('dueDate', { date: card.dueAt.slice(0, 10) })}</span> : null}
        {/* ADR 0049 — assign this card to a workspace member (notifies them + */}
        {/* surfaces it on their "My Work" mirror). */}
        <AssigneeControl cardId={card.id} assigneeId={card.assigneeId} />
      </div>
      {card.assignmentReason ? <div className="muted u-fs-12">{t('whyAssigned', { reason: card.assignmentReason })}</div> : null}
      {card.blockerNote ? <div className="kanban-blocker"><AlertIcon size={12} /> {t('blocked', { note: card.blockerNote })}</div> : null}
      {workItem ? <WorkItemSummary workItem={workItem} workflowOptions={workflowOptions} onRun={onRunWorkItem} running={workItemRunning} /> : null}
      {/* ADR 0313 D3 — a bare todo card on an agent board says what the
          heartbeat will do with it (or that nothing will). */}
      {todoAutonomy && lane === 'todo' && !card.workflowId && !columnHasTrigger ? (
        <div className="muted u-fs-12">
          {todoAutonomy === 'agent-turn' ? t('bareAgentTurnHint') : t('bareWontRunHint')}
        </div>
      ) : null}
      <div className="kb-card-foot">
        {action && actionTarget && onMove ? (
          // The lane's ONE next action — the non-drag path (a11y + touch).
          // Other moves stay drag-and-drop.
          <Button
            variant={action.accent ? 'accent' : 'secondary'} size="sm"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onMove(card.id, actionTarget); }}
          >
            {action.icon} {t(action.labelKey)}
          </Button>
        ) : null}
        <span className="kb-card-foot-spacer" />
        {card.lastRunId ? (
          <Link
            to={`/runs/${card.lastRunId}`}
            onPointerDown={(e) => e.stopPropagation()}
            className="kb-run-link"
            title={t('viewRunTitle')}
          >
            <PlayIcon size={12} aria-hidden /> {t('viewRun')}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** The ONE contextual action per lane (boards redesign): what a human most
 *  plausibly does next with a card in that lane. Everything else stays
 *  drag-and-drop. */
const LANE_ACTION: Record<LaneKind, { labelKey: string; to: MoveKind; icon: JSX.Element; accent?: boolean } | null> = {
  todo: { labelKey: 'startWork', to: 'working', icon: <PlayIcon size={12} /> },
  working: { labelKey: 'markDone', to: 'done', icon: <CheckIcon size={12} /> },
  waiting: { labelKey: 'resolve', to: 'working', icon: <CheckIcon size={12} />, accent: true },
  done: { labelKey: 'reopen', to: 'todo', icon: <RotateCwIcon size={12} /> },
};

function DroppableColumn({
  column,
  cards,
  onAddCard,
  onDeleteCard,
  onEditCard,
  enableSources,
  workflowOptions,
  laneTargets,
  onMove,
  footer,
  todoAutonomy, onSetColumnLimit, selectedIds,
  workItemsByCardId, onRunWorkItem, startingWorkItemIds,
}: {
  column: KanbanColumn;
  cards: KanbanCard[];
  /** Absent ⇒ the column is read-only for creation: no add-card affordance.
   *  (Non-task boards — e.g. the CRM deal pipeline — move cards but create
   *  records through their own domain forms.) */
  onAddCard?: ((columnId: string, input: NewCardInput) => void) | undefined;
  onDeleteCard?: ((cardId: string) => void) | undefined;
  onEditCard?: ((cardId: string, patch: CardPatch) => void) | undefined;
  enableSources?: boolean | undefined;
  workflowOptions?: readonly KanbanWorkflowOption[] | undefined;
  /** Canonical lane → real column id (the contextual-action targets). */
  laneTargets: ReadonlyMap<MoveKind, string>;
  onMove?: ((cardId: string, toColumnId: string, position?: CardMovePosition) => void) | undefined;
  /** Optional per-column footer (e.g. the CRM board's amount rollup). */
  footer?: React.ReactNode;
  /** ADR 0313 D3 — see DraggableCard. */
  todoAutonomy?: 'agent-turn' | 'off' | undefined;
  /** KB-R2-5 — absent ⇒ no limit-config affordance on this surface. */
  onSetColumnLimit?: ((columnId: string, wipLimit: number | null) => void) | undefined;
  /** KB-BULK — the board-level selection (ids), for the card outline. */
  selectedIds?: ReadonlySet<string> | undefined;
  /** Reusable core execution projection keyed by the card it mirrors. */
  workItemsByCardId?: ReadonlyMap<string, KanbanWorkItem> | undefined;
  onRunWorkItem?: ((workItemId: string) => void) | undefined;
  startingWorkItemIds?: ReadonlySet<string> | undefined;
}): JSX.Element {
  const { t } = useTranslation('kanban');
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  // KB-R2-4 — a multi-line paste into the title offers one-card-per-line
  // (Trello's convention: a CONFIRMATION, never a silent split; the plain
  // press-Enter path is untouched). Capped so a giant paste cannot blow the
  // per-IP write budget — the cap is IN the button label, never silent.
  const [pendingPaste, setPendingPaste] = useState<string[] | null>(null);
  // KB-R2-5 — the column-limit mini-form (only when the surface passes
  // onSetColumnLimit; the agent Board tab does not).
  const [limitEditOpen, setLimitEditOpen] = useState(false);
  const [limitValue, setLimitValue] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState<KanbanCardSource>('human');
  const [workflowId, setWorkflowId] = useState('');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal');
  const [dueAt, setDueAt] = useState('');
  const [assignmentReason, setAssignmentReason] = useState('');
  const [blockerNote, setBlockerNote] = useState('');
  const isTrigger = Boolean(column.triggerWorkflowId);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const clearFields = (): void => { setTitle(''); setDescription(''); setSource('human'); setWorkflowId(''); setPriority('normal'); setDueAt(''); setAssignmentReason(''); setBlockerNote(''); setPendingPaste(null); };
  const resetForm = (): void => { clearFields(); setAdding(false); };

  const lane = laneKindOf(column);
  return (
    <div
      ref={setNodeRef}
      data-column-id={column.id}
      className={'kb-col' + (isTrigger ? ' kb-col--trigger' : '') + (isOver ? ' is-over' : '')}
    >
      <div className="kb-col-head">
        <span className="kb-col-name">
          {column.name}
          {isTrigger ? <ZapIcon size={13} style={{ color: 'var(--clay-text)' }} /> : null}
        </span>
        {/* KB-R2-5 — count/limit readout, highlighted on breach. NEVER blocks
            (the GitHub/Jira soft-limit consensus): drops, creates, and
            automations all proceed; the breach is a signal, not a gate. */}
        {column.wipLimit ? (
          <span className={cards.length > column.wipLimit ? 'kb-col-count kb-col-count--over' : 'kb-col-count'}>
            {cards.length}/{column.wipLimit}
            {cards.length > column.wipLimit ? <span className="sr-only"> {t('wipOverLimit')}</span> : null}
          </span>
        ) : (
          <span className="kb-col-count">{cards.length}</span>
        )}
        {onSetColumnLimit ? (
          <IconButton
            label={t('wipLimitEditAria', { name: column.name })}
            icon={<SettingsIcon size={13} />}
            className="icon-button kb-col-limit-edit"
            aria-expanded={limitEditOpen}
            onClick={() => { setLimitValue(column.wipLimit ? String(column.wipLimit) : ''); setLimitEditOpen((o) => !o); }}
          />
        ) : null}
      </div>
      {onSetColumnLimit && limitEditOpen ? (
        <form
          className="u-flex u-gap-1 u-items-center u-fs-13"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number.parseInt(limitValue, 10);
            if (Number.isInteger(n) && n >= 1 && n <= 999) { onSetColumnLimit(column.id, n); setLimitEditOpen(false); }
          }}
        >
          <label className="u-flex u-gap-1 u-items-center">
            <span className="u-label-sm">{t('wipLimitLabel')}</span>
            <input
              type="number"
              min={1}
              max={999}
              className="ui-input kb-col-limit-input"
              value={limitValue}
              onChange={(e) => setLimitValue(e.target.value)}
            />
          </label>
          <Button size="sm" type="submit" disabled={!limitValue}>{t('wipLimitSet')}</Button>
          {column.wipLimit ? (
            <Button variant="secondary" size="sm" onClick={() => { onSetColumnLimit(column.id, null); setLimitEditOpen(false); }}>{t('wipLimitClear')}</Button>
          ) : null}
        </form>
      ) : null}
      {cards.map((c) => (
        <DraggableCard key={c.id} card={c} lane={lane} laneTargets={laneTargets} onDelete={onDeleteCard} onMove={onMove} onEdit={onEditCard} todoAutonomy={todoAutonomy} columnHasTrigger={Boolean(column.triggerWorkflowId)} isSelected={selectedIds?.has(c.id)} workflowOptions={workflowOptions} workItem={workItemsByCardId?.get(c.id)} onRunWorkItem={onRunWorkItem} workItemRunning={startingWorkItemIds?.has(workItemsByCardId?.get(c.id)?.workItemId ?? '')} />
      ))}
      {onAddCard && adding ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim()) return;
            onAddCard(column.id, {
              title: title.trim(),
              ...(enableSources ? { source } : {}),
              ...(description.trim() ? { description: description.trim() } : {}),
              ...(workflowId ? { workflowId } : {}),
              ...(priority !== 'normal' ? { priority } : {}),
              ...(dueAt ? { dueAt } : {}),
              ...(assignmentReason.trim() ? { assignmentReason: assignmentReason.trim() } : {}),
              ...(blockerNote.trim() ? { blockerNote: blockerNote.trim() } : {}),
            });
            // KB-R2-2 — the composer STAYS OPEN for consecutive adds (the
            // Trello "press Enter to keep adding" pattern; GitHub Projects'
            // add-row persists the same way). Cancel or Esc-away closes it.
            // The announce gives non-visual users the same "it landed"
            // signal the appearing card gives sighted ones.
            announce(t('cardAddedAnnounce', { title: title.trim() }));
            clearFields();
            titleRef.current?.focus();
          }}
          className="surface-form"
        >
          <div className="field"><input
            ref={titleRef}
            autoFocus
            className="ui-input u-w-full"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text');
              const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
              if (lines.length < 2) return; // single line: the default paste
              e.preventDefault();
              setPendingPaste(lines);
            }}
            placeholder={t('taskTitlePlaceholder')}
          /></div>
          {pendingPaste ? (
            <div className="u-flex u-gap-1 u-items-center u-wrap u-fs-13" role="group" aria-label={t('pasteSplitOffer', { count: pendingPaste.length })}>
              <span className="muted">{t('pasteSplitOffer', { count: pendingPaste.length })}</span>
              <Button
                size="sm"
                onClick={() => {
                  const toCreate = pendingPaste.slice(0, PASTE_SPLIT_CAP);
                  for (const line of toCreate) onAddCard?.(column.id, { title: line, ...(enableSources ? { source } : {}) });
                  announce(t('cardsPastedAnnounce', { count: toCreate.length }));
                  setPendingPaste(null);
                  titleRef.current?.focus();
                }}
              >
                {pendingPaste.length > PASTE_SPLIT_CAP
                  ? t('pasteSplitCreateCapped', { count: PASTE_SPLIT_CAP })
                  : t('pasteSplitCreate', { count: pendingPaste.length })}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { setTitle((prev) => (prev + ' ' + pendingPaste.join(' ')).trim()); setPendingPaste(null); titleRef.current?.focus(); }}
              >
                {t('pasteSplitKeep')}
              </Button>
            </div>
          ) : null}
          <div className="field"><MarkdownEditor value={description} onChange={setDescription} placeholder={t('taskDescriptionPlaceholder')} rows={2} compact ariaLabel={t('taskDescriptionAria')} /></div>
          {enableSources ? (
            <div className="field">
              <select className="ui-input u-w-full" value={source} onChange={(e) => setSource(e.target.value as KanbanCardSource)} aria-label={t('taskSourceAria')}>
                {SOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
              </select>
            </div>
          ) : null}
          {workflowOptions && workflowOptions.length > 0 ? (
            <div className="field">
              <select className="ui-input u-w-full" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} aria-label={t('workflowAria')}>
                <option value="">{t('noWorkflowOptionShort')}</option>
                {workflowOptions.map((workflow) => (
                  <option key={workflowOptionId(workflow)} value={workflowOptionId(workflow)}>
                    {workflowOptionName(workflow)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="field">
            <select className="ui-input u-w-full" value={priority} onChange={(e) => setPriority(e.target.value as 'low' | 'normal' | 'high')} aria-label={t('priorityAria')}>
              <option value="low">{t('priorityLowOption')}</option>
              <option value="normal">{t('priorityNormalOption')}</option>
              <option value="high">{t('priorityHighOption')}</option>
            </select>
          </div>
          <div className="field"><input className="ui-input u-w-full" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} aria-label={t('dueDateAria')} /></div>
          <div className="field"><input className="ui-input u-w-full" value={assignmentReason} onChange={(e) => setAssignmentReason(e.target.value)} placeholder={t('whyAssignedPlaceholder')} aria-label={t('whyAssignedAria')} /></div>
          <div className="field"><input className="ui-input u-w-full" value={blockerNote} onChange={(e) => setBlockerNote(e.target.value)} placeholder={t('blockerPlaceholder')} aria-label={t('blockerAria')} /></div>
          <div className="action-bar">
            <Button type="submit" variant="primary" size="sm">{t('addCardButton')}</Button>
            <Button variant="secondary" size="sm" onClick={resetForm}>{t('common:cancel')}</Button>
          </div>
        </form>
      ) : onAddCard ? (
        <button type="button" className="kb-add" aria-keyshortcuts="n" title={t('addCardShortcutHint')} onClick={() => setAdding(true)}>{t('addCard')}</button>
      ) : null}
      {footer}
    </div>
  );
}

export function KanbanBoardView({
  board,
  cards,
  enableSources,
  workflowOptions,
  onMoveCard,
  onCreateCard,
  onDeleteCard,
  onEditCard,
  leadingColumn,
  columnFooter,
  onSetColumnLimit,
  onDeleteCards,
  todoAutonomy,
  workItemsByCardId,
  onRunWorkItem,
  startingWorkItemIds,
}: {
  board: KanbanBoard;
  cards: KanbanCard[];
  enableSources?: boolean | undefined;
  /** Workflows the embedding surface permits a card to bind. Strings preserve
   * legacy consumers; object entries carry the dynamic, editable workflow name. */
  workflowOptions?: readonly KanbanWorkflowOption[] | undefined;
  /** Owner persona — accepted for parity with the page header (unused here). */
  ownerPersona?: string | undefined;
  onMoveCard: (cardId: string, toColumnId: string, position?: CardMovePosition) => void;
  /** Absent ⇒ no add-card affordance anywhere on the board (see DroppableColumn). */
  onCreateCard?: ((columnId: string, input: NewCardInput) => void) | undefined;
  onDeleteCard?: ((cardId: string) => void) | undefined;
  /** KB-R2-1 — absent ⇒ no in-place card editing on this surface. */
  onEditCard?: ((cardId: string, patch: CardPatch) => void) | undefined;
  /** Optional per-column footer factory (e.g. CRM's count + amount rollup). */
  columnFooter?: ((column: KanbanColumn, cards: KanbanCard[]) => React.ReactNode) | undefined;
  /** KB-R2-5 — soft WIP-limit config (set/clear). Only the owning /boards
   *  surface passes it; the limit itself renders on every surface. */
  onSetColumnLimit?: ((columnId: string, wipLimit: number | null) => void) | undefined;
  /** KB-BULK — bulk delete. A SEPARATE callback (not a fan-out over
   *  onDeleteCard) because the consumer's single-card handler confirms per
   *  card — N dialogs for N cards. The consumer confirms ONCE with the count
   *  here. Absent ⇒ no bulk delete on this surface. */
  onDeleteCards?: ((cardIds: string[]) => void) | undefined;
  /** ADR 0049 — an optional synthetic column rendered FIRST (leftmost), OUTSIDE
   *  the DnD droppables: the personal board's "Assigned to me" rail. Its cards
   *  are foreign (they live on other boards) so it is deliberately not a drop
   *  target — never wire it through DroppableColumn. */
  leadingColumn?: React.ReactNode;
  /** ADR 0313 D3 — set on AGENT-owned boards only: the fate of a bare todo
   *  card ('agent-turn' = proposed by the heartbeat, 'off' = won't auto-run).
   *  Absent on non-agent surfaces (CRM, personal) — no hint noise. */
  todoAutonomy?: 'agent-turn' | 'off' | undefined;
  /** Core work projection supplied by a board consumer. No canvas-specific
   * renderer is needed: this map is intentionally keyed by the shared card. */
  workItemsByCardId?: ReadonlyMap<string, KanbanWorkItem> | undefined;
  /** Explicit human dispatch uses the same server-side core delivery seam as
   * automatic work; absent on read-only/embedded consumers. */
  onRunWorkItem?: ((workItemId: string) => void) | undefined;
  startingWorkItemIds?: ReadonlySet<string> | undefined;
}): JSX.Element {
  const { t } = useTranslation('kanban');
  // Mirror props into local state for an optimistic move; re-sync when the
  // parent refetches (SSE / poll / mutation).
  const [local, setLocal] = useState<KanbanCard[]>(cards);
  useEffect(() => setLocal(cards), [cards]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // CRM-UX-18 — Left/Right snap to the neighbouring COLUMN (one press, one
    // column, as `dndInstructions` promises), not dnd-kit's 25 px default.
    useSensor(KeyboardSensor, { coordinateGetter: columnSnapCoordinateGetter }),
  );

  // Board a11y announcements (UX audit finding #4) — dnd-kit's keyboard sensor
  // moves cards silently to a screen reader unless the host supplies its own
  // live-region text; the defaults are also English-only. Announce by CARD
  // TITLE + COLUMN NAME so "picked up / over / dropped" reads as real content,
  // not an id. Benefits every KanbanBoardView consumer (/boards included).
  const cardTitle = (id: string | number): string => local.find((c) => c.id === String(id))?.title ?? String(id);
  const columnName = (id: string | number | undefined): string => {
    if (id === undefined) return '';
    const raw = String(id);
    const cardTarget = raw.startsWith(CARD_DROP_PREFIX)
      ? local.find((candidate) => candidate.id === raw.slice(CARD_DROP_PREFIX.length))
      : undefined;
    return board.columns.find((c) => c.id === (cardTarget?.columnId ?? raw))?.name ?? raw;
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('dndPickedUp', { title: cardTitle(active.id) }),
    onDragOver: ({ active, over }) => (over ? t('dndOver', { title: cardTitle(active.id), column: columnName(over.id) }) : undefined),
    onDragEnd: ({ active, over }) => (over
      ? t('dndDropped', { title: cardTitle(active.id), column: columnName(over.id) })
      : t('dndDroppedOutside', { title: cardTitle(active.id) })),
    onDragCancel: ({ active }) => t('dndCancelled', { title: cardTitle(active.id) }),
  };
  const screenReaderInstructions: ScreenReaderInstructions = { draggable: t('dndInstructions') };

  const moveCard = (cardId: string, toColumnId: string, position?: CardMovePosition): void => {
    const card = local.find((c) => c.id === cardId);
    if (!card || (card.columnId === toColumnId && !position)) return;
    setLocal((prev) => {
      const moving = prev.find((candidate) => candidate.id === cardId);
      if (!moving) return prev;
      const remaining = prev.filter((candidate) => candidate.id !== cardId);
      const lane = remaining.filter((candidate) => candidate.columnId === toColumnId)
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      let index = lane.length;
      if (position?.beforeCardId) {
        const anchor = lane.findIndex((candidate) => candidate.id === position.beforeCardId);
        if (anchor >= 0) index = anchor;
      } else if (position?.afterCardId) {
        const anchor = lane.findIndex((candidate) => candidate.id === position.afterCardId);
        if (anchor >= 0) index = anchor + 1;
      }
      lane.splice(index, 0, { ...moving, columnId: toColumnId });
      const ranked = new Map(lane.map((candidate, rank) => [candidate.id, rank + 1]));
      return remaining.map((candidate) => ranked.has(candidate.id)
        ? { ...candidate, columnId: toColumnId, order: ranked.get(candidate.id)! }
        : candidate);
    });
    onMoveCard(cardId, toColumnId, position);
  };

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over) return;
    const overId = String(event.over.id);
    if (!overId.startsWith(CARD_DROP_PREFIX)) {
      moveCard(String(event.active.id), overId);
      return;
    }
    const targetCardId = overId.slice(CARD_DROP_PREFIX.length);
    const targetCard = local.find((candidate) => candidate.id === targetCardId);
    if (!targetCard || targetCard.id === String(event.active.id)) return;
    const activeRect = event.active.rect.current.translated;
    const after = activeRect !== null && activeRect !== undefined
      && activeRect.top + activeRect.height / 2 > event.over.rect.top + event.over.rect.height / 2;
    moveCard(String(event.active.id), targetCard.columnId, after
      ? { afterCardId: targetCard.id }
      : { beforeCardId: targetCard.id });
  };

  // Canonical lane → first matching column, so each card's contextual action
  // ("Start work" / "Mark done" / "Resolve" / "Reopen") targets a real column.
  const laneTargets = new Map<MoveKind, string>();
  for (const kind of ['todo', 'working', 'waiting', 'done'] as MoveKind[]) {
    const col = board.columns.find((c) => laneKindOf(c) === kind);
    if (col) laneTargets.set(kind, col.id);
  }

  // KB-BULK — multi-select (the Linear model, round-4 catalog): `x` selects
  // the focused card, modifier-click toggles, Shift-click ranges WITHIN a
  // column (the board is columnar — the Trello single-list analog), ⌘/Ctrl-A
  // selects the whole VIEW (Linear's scoping), Esc clears. Selection is
  // ANNOUNCED (counts via the shared live region — the a11y contract no
  // vendor in the field documents). Bulk actions fan out over the EXISTING
  // per-card callbacks — one mutation path, no second bulk API.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  // Prune selection when cards leave the board (moved off / deleted / refetch).
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(local.map((c) => c.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [local]);

  const toggleSelect = (cardId: string, range = false): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (range && anchorRef.current && anchorRef.current !== cardId) {
        // Range within the anchor's column, in display order.
        const anchorCard = local.find((c) => c.id === anchorRef.current);
        const targetCard = local.find((c) => c.id === cardId);
        if (anchorCard && targetCard && anchorCard.columnId === targetCard.columnId) {
          const colCards = local.filter((c) => c.columnId === anchorCard.columnId).sort((a, b) => a.order - b.order);
          const ai = colCards.findIndex((c) => c.id === anchorCard.id);
          const ti = colCards.findIndex((c) => c.id === targetCard.id);
          for (const c of colCards.slice(Math.min(ai, ti), Math.max(ai, ti) + 1)) next.add(c.id);
          announce(t('bulkSelectedAnnounce', { count: next.size }));
          return next;
        }
      }
      if (next.has(cardId)) next.delete(cardId);
      else { next.add(cardId); anchorRef.current = cardId; }
      announce(next.size > 0 ? t('bulkSelectedAnnounce', { count: next.size }) : t('bulkClearedAnnounce'));
      return next;
    });
  };
  const clearSelection = (): void => {
    setSelected((prev) => {
      if (prev.size > 0) announce(t('bulkClearedAnnounce'));
      return new Set();
    });
    anchorRef.current = null;
  };

  // KB-R2-3 — board verb keys (Linear's `E` / Trello's `n` convention): `e`
  // edits the card that owns focus, `n` opens the composer in the column that
  // owns focus (else the first composable column). Both DELEGATE to the real
  // affordance button — one edit path, one compose path, their wiring intact
  // — so a board without that affordance (no onEditCard / onCreateCard)
  // no-ops by construction. Keys fire only while focus is inside the board
  // (that IS the focused-card model) and never while typing in a form.
  const onBoardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    const tag = target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable || Boolean(target.closest('form'));
    // ⌘/Ctrl-A — select the whole view (Linear's scoping), never while typing.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'a' && !typing) {
      e.preventDefault();
      setSelected(new Set(local.map((c) => c.id)));
      announce(t('bulkSelectedAnnounce', { count: local.length }));
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && selected.size > 0 && !typing) { e.preventDefault(); clearSelection(); return; }
    if (typing) return;
    const key = e.key.toLowerCase();
    if (key === 'e') {
      const btn = target.closest('.kb-card')?.querySelector<HTMLButtonElement>('.kb-card-edit');
      if (btn) { e.preventDefault(); btn.click(); }
    } else if (key === 'n') {
      const scope = target.closest('.kb-col') ?? e.currentTarget;
      const btn = scope.querySelector<HTMLButtonElement>('.kb-add')
        ?? e.currentTarget.querySelector<HTMLButtonElement>('.kb-add');
      if (btn) { e.preventDefault(); btn.click(); }
    } else if (key === 'x') {
      // Linear's select key — the card owning focus.
      const cardEl = target.closest<HTMLElement>('[data-card-id]');
      const id = cardEl?.getAttribute('data-card-id');
      if (id) { e.preventDefault(); toggleSelect(id, e.shiftKey); }
    }
  };

  // Modifier-click / Shift-click selection on the card BODY — inner controls
  // (buttons, links, the grip) keep their own behavior untouched.
  const onBoardClickCapture = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, [role="button"], form')) return;
    const id = target.closest<HTMLElement>('[data-card-id]')?.getAttribute('data-card-id');
    if (!id) return;
    e.preventDefault();
    toggleSelect(id, e.shiftKey);
  };

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd} accessibility={{ announcements, screenReaderInstructions }}>
      <div className="kanban-board-scroll" onKeyDown={onBoardKeyDown} onClickCapture={onBoardClickCapture}>
        {leadingColumn}
        {board.columns.map((col) => {
          const colCards = local.filter((c) => c.columnId === col.id).sort((a, b) => a.order - b.order);
          return (
            <DroppableColumn
              key={col.id}
              column={col}
              cards={colCards}
              onAddCard={onCreateCard}
              onDeleteCard={onDeleteCard}
              onEditCard={onEditCard}
              enableSources={enableSources}
              workflowOptions={workflowOptions}
              laneTargets={laneTargets}
              onMove={moveCard}
              footer={columnFooter?.(col, colCards)}
              onSetColumnLimit={onSetColumnLimit}
              selectedIds={selected}
              workItemsByCardId={workItemsByCardId}
              onRunWorkItem={onRunWorkItem}
              startingWorkItemIds={startingWorkItemIds}
              todoAutonomy={todoAutonomy}
            />
          );
        })}
      </div>
      {/* KB-BULK — the bottom-floating bulk bar (the Linear/Asana convention).
          Every action fans out over the EXISTING per-card callback and appears
          only when that callback exists — one mutation path, structural no-op
          elsewhere. Esc (or Clear) dismisses. */}
      {selected.size > 0 ? (
        <div className="kb-bulkbar surface-card" role="toolbar" aria-label={t('bulkBarAria')}>
          <span className="u-fs-13 u-fw-600">{t('bulkSelectedCount', { count: selected.size })}</span>
          <label className="u-flex u-gap-1 u-items-center u-fs-13">
            <span className="u-label-sm">{t('bulkMoveTo')}</span>
            <select
              className="ui-input u-w-auto"
              value=""
              onChange={(e) => {
                const toColumnId = e.target.value;
                if (!toColumnId) return;
                const ids = [...selected];
                for (const id of ids) moveCard(id, toColumnId);
                announce(t('bulkMovedAnnounce', { count: ids.length, column: board.columns.find((c) => c.id === toColumnId)?.name ?? toColumnId }));
                clearSelection();
              }}
            >
              <option value="">{t('bulkMovePlaceholder')}</option>
              {board.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {onEditCard ? (
            <label className="u-flex u-gap-1 u-items-center u-fs-13">
              <span className="u-label-sm">{t('bulkPriority')}</span>
              <select
                className="ui-input u-w-auto"
                value=""
                onChange={(e) => {
                  const p = e.target.value as 'low' | 'normal' | 'high' | '';
                  if (!p) return;
                  const ids = [...selected];
                  for (const id of ids) onEditCard(id, { priority: p });
                  announce(t('bulkPriorityAnnounce', { count: ids.length }));
                  clearSelection();
                }}
              >
                <option value="">{t('bulkMovePlaceholder')}</option>
                <option value="low">{t('priorityLowOption')}</option>
                <option value="normal">{t('priorityNormalOption')}</option>
                <option value="high">{t('priorityHighOption')}</option>
              </select>
            </label>
          ) : null}
          {onDeleteCards ? (
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                const ids = [...selected];
                onDeleteCards(ids);
                announce(t('bulkDeletedAnnounce', { count: ids.length }));
                clearSelection();
              }}
            >
              {t('bulkDelete', { count: selected.size })}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={clearSelection}>{t('bulkClear')}</Button>
        </div>
      ) : null}
    </DndContext>
  );
}
