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

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Link } from 'react-router-dom';
import { TaskSourceChip } from '../agents/TaskSourceChip.js';
import { workflowName } from '../agents/roleTemplates.js';
import { AlertIcon, CheckIcon, GripVerticalIcon, PlayIcon, RotateCwIcon, UserIcon, WorkflowIcon, XIcon, ZapIcon } from '../ui/icons/index.js';
import { Markdown } from '../ui/Markdown.js';
import { MarkdownEditor } from '../ui/MarkdownEditor.js';
import { AssigneeControl } from './AssigneeControl.js';
import type { KanbanBoard, KanbanCard, KanbanColumn, KanbanCardSource } from './kanbanClient.js';
import { columnLaneKind, type LaneKind } from './laneKind.js';

const muted: React.CSSProperties = { color: 'var(--color-text-muted)' };

type MoveKind = 'todo' | 'working' | 'waiting' | 'done';

/** Match a column to a canonical lane by id or display name (BLD-8: shared with
 *  agentViewModel via `columnLaneKind`) so the non-drag quick-actions know where
 *  "Start" / "Waiting" / "Done" point on boards using either convention. */
const laneKindOf = (col: KanbanColumn): LaneKind | null => columnLaneKind(col);

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
}: {
  card: KanbanCard;
  /** Canonical lane of the column this card sits in (null = custom lane). */
  lane: LaneKind | null;
  /** Canonical lane → real column id, for the contextual action target. */
  laneTargets: ReadonlyMap<MoveKind, string>;
  onDelete?: ((cardId: string) => void) | undefined;
  onMove?: ((cardId: string, toColumnId: string) => void) | undefined;
}): JSX.Element {
  const { t } = useTranslation('kanban');
  // Drag activates from a dedicated grip handle, NOT the whole card: dnd-kit's
  // listeners/attributes set role="button"+tabindex on their element, and the
  // card body holds real interactive controls (delete, run link, move buttons)
  // that must not be nested inside a role=button (invalid ARIA). setNodeRef
  // marks the draggable; setActivatorNodeRef + listeners mark the handle.
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({ id: card.id });
  const style: React.CSSProperties = {
    transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
    opacity: isDragging ? 0.5 : 1,
  };
  const action = lane ? LANE_ACTION[lane] : null;
  const actionTarget = action ? laneTargets.get(action.to) : undefined;
  return (
    <div ref={setNodeRef} className={lane === 'waiting' ? 'surface-card kb-card kb-card--waiting kanban-card-box' : 'surface-card kb-card kanban-card-box'} style={style}>
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
      {card.description ? <Markdown style={{ ...muted, fontSize: '12px', marginTop: 2 }}>{card.description}</Markdown> : null}
      <div className="u-flex u-gap-1 u-wrap u-items-center u-mt-1">
        {card.source ? <TaskSourceChip source={card.source} sourceLabel={card.sourceLabel} /> : null}
        {card.workflowId ? (
          <span className="u-iflex u-items-center u-gap-1 u-fs-12 u-text-accent">
            <WorkflowIcon size={12} /> {workflowName(card.workflowId)}
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
      <div className="kb-card-foot">
        {action && actionTarget && onMove ? (
          // The lane's ONE next action — the non-drag path (a11y + touch).
          // Other moves stay drag-and-drop.
          <button
            type="button"
            className={action.accent ? 'btn-accent btn-sm' : 'secondary btn-sm'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onMove(card.id, actionTarget); }}
          >
            {action.icon} {t(action.labelKey)}
          </button>
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
  enableSources,
  workflowOptions,
  laneTargets,
  onMove,
}: {
  column: KanbanColumn;
  cards: KanbanCard[];
  onAddCard: (columnId: string, input: NewCardInput) => void;
  onDeleteCard?: ((cardId: string) => void) | undefined;
  enableSources?: boolean | undefined;
  workflowOptions?: string[] | undefined;
  /** Canonical lane → real column id (the contextual-action targets). */
  laneTargets: ReadonlyMap<MoveKind, string>;
  onMove?: ((cardId: string, toColumnId: string) => void) | undefined;
}): JSX.Element {
  const { t } = useTranslation('kanban');
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState<KanbanCardSource>('human');
  const [workflowId, setWorkflowId] = useState('');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal');
  const [dueAt, setDueAt] = useState('');
  const [assignmentReason, setAssignmentReason] = useState('');
  const [blockerNote, setBlockerNote] = useState('');
  const isTrigger = Boolean(column.triggerWorkflowId);
  const resetForm = (): void => { setTitle(''); setDescription(''); setSource('human'); setWorkflowId(''); setPriority('normal'); setDueAt(''); setAssignmentReason(''); setBlockerNote(''); setAdding(false); };

  const lane = laneKindOf(column);
  return (
    <div
      ref={setNodeRef}
      className={'kb-col' + (isTrigger ? ' kb-col--trigger' : '') + (isOver ? ' is-over' : '')}
    >
      <div className="kb-col-head">
        <span className="kb-col-name">
          {column.name}
          {isTrigger ? <ZapIcon size={13} style={{ color: 'var(--color-accent)' }} /> : null}
        </span>
        <span className="kb-col-count">{cards.length}</span>
      </div>
      {cards.map((c) => (
        <DraggableCard key={c.id} card={c} lane={lane} laneTargets={laneTargets} onDelete={onDeleteCard} onMove={onMove} />
      ))}
      {adding ? (
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
            resetForm();
          }}
          className="surface-form"
        >
          <div className="field"><input autoFocus className="ui-input u-w-full" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('taskTitlePlaceholder')} /></div>
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
                {workflowOptions.map((w) => <option key={w} value={w}>{workflowName(w)}</option>)}
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
            <button type="submit" className="primary btn-sm">{t('addCardButton')}</button>
            <button type="button" className="secondary btn-sm" onClick={resetForm}>{t('common:cancel')}</button>
          </div>
        </form>
      ) : (
        <button type="button" className="kb-add" onClick={() => setAdding(true)}>{t('addCard')}</button>
      )}
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
  leadingColumn,
}: {
  board: KanbanBoard;
  cards: KanbanCard[];
  enableSources?: boolean | undefined;
  /** Workflow ids the add-card form can attach (the owning agent's portfolio). */
  workflowOptions?: string[] | undefined;
  /** Owner persona — accepted for parity with the page header (unused here). */
  ownerPersona?: string | undefined;
  onMoveCard: (cardId: string, toColumnId: string) => void;
  onCreateCard: (columnId: string, input: NewCardInput) => void;
  onDeleteCard?: ((cardId: string) => void) | undefined;
  /** ADR 0049 — an optional synthetic column rendered FIRST (leftmost), OUTSIDE
   *  the DnD droppables: the personal board's "Assigned to me" rail. Its cards
   *  are foreign (they live on other boards) so it is deliberately not a drop
   *  target — never wire it through DroppableColumn. */
  leadingColumn?: React.ReactNode;
}): JSX.Element {
  // Mirror props into local state for an optimistic move; re-sync when the
  // parent refetches (SSE / poll / mutation).
  const [local, setLocal] = useState<KanbanCard[]>(cards);
  useEffect(() => setLocal(cards), [cards]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  const moveCard = (cardId: string, toColumnId: string): void => {
    const card = local.find((c) => c.id === cardId);
    if (!card || card.columnId === toColumnId) return;
    setLocal((prev) => prev.map((c) => (c.id === cardId ? { ...c, columnId: toColumnId } : c)));
    onMoveCard(cardId, toColumnId);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const toColumnId = event.over ? String(event.over.id) : null;
    if (toColumnId) moveCard(String(event.active.id), toColumnId);
  };

  // Canonical lane → first matching column, so each card's contextual action
  // ("Start work" / "Mark done" / "Resolve" / "Reopen") targets a real column.
  const laneTargets = new Map<MoveKind, string>();
  for (const kind of ['todo', 'working', 'waiting', 'done'] as MoveKind[]) {
    const col = board.columns.find((c) => laneKindOf(c) === kind);
    if (col) laneTargets.set(kind, col.id);
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="kanban-board-scroll">
        {leadingColumn}
        {board.columns.map((col) => (
          <DroppableColumn
            key={col.id}
            column={col}
            cards={local.filter((c) => c.columnId === col.id).sort((a, b) => a.order - b.order)}
            onAddCard={onCreateCard}
            onDeleteCard={onDeleteCard}
            enableSources={enableSources}
            workflowOptions={workflowOptions}
            laneTargets={laneTargets}
            onMove={moveCard}
          />
        ))}
      </div>
    </DndContext>
  );
}
