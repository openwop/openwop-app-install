/**
 * `/boards` route — Kanban boards (RFCS/0086 "named workflow agents" demo).
 *
 * A board's columns are drop zones; cards are draggable. Dragging a card
 * into a column that names a workflow (the board's trigger column, "To Do"
 * by default) starts a workflow run — the host returns the started
 * `triggeredRunId`, which this page surfaces as a link to the run. This is
 * the digital-twin-employee surface: a card landing in To Do fires the
 * agent's workflow.
 *
 * Boards-redesign layout (2026-06-05, Claude Design mock in our tokens):
 * switcher PILLS with the owner's avatar, live card count, and an amber
 * attention dot for boards with waiting cards; a board header naming the
 * owner, trigger workflow, and waiting count, with an overflow menu
 * (Duplicate / Delete — Rename intentionally absent until the host grows a
 * board-PATCH endpoint; no fake affordances); the inline create form is now
 * the Create-a-board modal.
 *
 * Tenant scoping is server-side (board ownership from the caller's
 * principal); the page never sends a tenantId. Drag-drop via @dnd-kit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { useSearchParams } from 'react-router-dom';
import { listRoster, type RosterEntry } from '../agents/rosterClient.js';
import { roleThemeForAgent, workflowName } from '../agents/roleTemplates.js';
import { AgentAvatar } from '../agents/AgentAvatar.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { handleTablistKeyDown } from '../ui/rovingTabs.js';
import { classifyHttpError } from '../client/classifyHttpError.js';
import { PageHeader } from '../ui/PageHeader.js';
import { IconButton } from '../ui/IconButton.js';
import { AlertIcon, ColumnsIcon, DotsIcon, PencilIcon, TrashIcon, WorkflowIcon, ZapIcon } from '../ui/icons/index.js';
import { KanbanBoardView, type NewCardInput } from './KanbanBoardView.js';
import { AssignedColumn } from './AssignedColumn.js';
import { CreateBoardModal } from './CreateBoardModal.js';
import { Modal } from '../ui/Modal.js';
import { TextField } from '../ui/Field.js';
import {
  createBoard,
  createCard,
  deleteBoard,
  patchBoard,
  deleteCard,
  getBoard,
  getPersonalBoard,
  listAssignedToMe,
  claimCard,
  listBoardsWithCards,
  patchCard,
  subscribeBoardEvents,
  type AssignedCard,
  type KanbanBoard,
  type KanbanBoardWithCards,
  type KanbanCard,
} from './kanbanClient.js';

/** Waiting-lane cards on a board (drives the pill dot + the header chip). */
function waitingCount(columns: KanbanBoard['columns'], cards: readonly KanbanCard[]): number {
  const waitingCols = new Set(
    columns
      .filter((c) => c.id.toLowerCase() === 'waiting' || c.name.toLowerCase().startsWith('waiting'))
      .map((c) => c.id),
  );
  return cards.filter((c) => waitingCols.has(c.columnId)).length;
}

/** The board's overflow menu — Rename / Duplicate / Delete. */
function BoardMenu({ onRename, onDuplicate, onDelete }: {
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}): JSX.Element {
  const { t } = useTranslation('kanban');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onAway = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onAway);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onAway);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="board-menu" ref={rootRef}>
      <IconButton
        label={t('boardActions')}
        icon={<DotsIcon size={16} />}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open ? (
        <div className="board-menu-pop surface-card" role="menu">
          <button type="button" role="menuitem" className="board-menu-item" onClick={() => { setOpen(false); onRename(); }}>
            <PencilIcon size={14} aria-hidden /> {t('renameBoard')}
          </button>
          <button type="button" role="menuitem" className="board-menu-item" onClick={() => { setOpen(false); onDuplicate(); }}>
            <ColumnsIcon size={14} aria-hidden /> {t('duplicate')}
          </button>
          <div className="board-menu-rule" />
          <button type="button" role="menuitem" className="board-menu-item board-menu-item--danger" onClick={() => { setOpen(false); onDelete(); }}>
            <TrashIcon size={14} aria-hidden /> {t('deleteBoard')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** In-app board rename (replaces window.prompt). One field on the shared Modal. */
function RenameBoardModal({ current, onClose, onSubmit }: {
  current: string; onClose: () => void; onSubmit: (name: string) => void;
}): JSX.Element {
  const { t } = useTranslation('kanban');
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const canSave = name.trim().length > 0 && !busy;
  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    onSubmit(name);
  };
  return (
    <Modal label={t('renameBoard')} onClose={() => { if (!busy) onClose(); }}>
      <form className="u-grid u-gap-3" onSubmit={submit}>
        <h2 className="u-fs-16 u-m-0">{t('renameBoard')}</h2>
        <TextField label={t('boardNameLabel')} required value={name} onChange={(e) => setName(e.target.value)} placeholder={t('boardNamePlaceholder')} />
        <div className="action-bar u-justify-end">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>{t('common:cancel')}</button>
          <button type="submit" className="primary" disabled={!canSave}>{t('common:save')}</button>
        </div>
      </form>
    </Modal>
  );
}

export function KanbanPage(): JSX.Element {
  const { t } = useTranslation('kanban');
  const [boards, setBoards] = useState<KanbanBoardWithCards[]>([]);
  const [activeBoard, setActiveBoard] = useState<KanbanBoard | null>(null);
  const [cards, setCards] = useState<KanbanCard[]>([]);
  // BLD-4: cards with an in-flight move PATCH — guards against double-drag
  // races. A ref (not state) so toggling it never triggers a re-render.
  const movingCardIds = useRef<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Init-true so the first load shows a loading state, not a false "No boards
  // yet" empty flash before the fetch resolves (GAP-ANALYSIS E5).
  const [boardsLoading, setBoardsLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // Roster members boards can be bound to (RFC 0086): the owner's avatar
  // renders in the switcher pill and the board header.
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  // ADR 0049 — the "assigned to me" mirror, folded into the personal board as a
  // synthetic leftmost column (was the standalone /my-work page until
  // 2026-06-16). `personalBoardId` tells us which board hosts the rail; the
  // assigned list is workspace-wide (cards live on their origin boards).
  const [personalBoardId, setPersonalBoardId] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<AssignedCard[]>([]);
  const [claimBusyId, setClaimBusyId] = useState<string | null>(null);
  // A notification deep-links here as `/boards?card=<id>` (was `/my-work?card=`),
  // highlighting + scrolling that card in the rail.
  const [params] = useSearchParams();
  const highlightCardId = params.get('card');

  const refreshAssigned = useCallback(async () => {
    try {
      setAssigned(await listAssignedToMe());
    } catch {
      /* the rail is auxiliary — a transient failure must not break the board */
    }
  }, []);

  const refreshBoards = useCallback(async () => {
    try {
      setBoards(await listBoardsWithCards());
    } catch (err) {
      setError((() => { const c = classifyHttpError(err); return `${c.title} — ${c.detail}`; })());
    } finally {
      setBoardsLoading(false);
    }
  }, []);

  const openBoard = useCallback(async (boardId: string) => {
    try {
      const { board, cards: c } = await getBoard(boardId);
      setActiveBoard(board);
      setCards(c);
    } catch (err) {
      setError((() => { const c = classifyHttpError(err); return `${c.title} — ${c.detail}`; })());
    }
  }, []);

  useEffect(() => {
    void refreshBoards();
    void refreshAssigned();
    // ADR 0025/0049 — learn the caller's personal board id (idempotently ensured)
    // so we know which board hosts the "Assigned to me" rail.
    void getPersonalBoard().then(({ board }) => setPersonalBoardId(board.id)).catch(() => { /* personal board optional */ });
    void listRoster().then(setRoster).catch(() => { /* roster optional */ });
  }, [refreshBoards, refreshAssigned]);

  // Auto-open a board so the page never greets with an empty shell (decision-
  // first: show the work, not a picker). A `?card=` deep-link prefers the
  // personal board (the rail lives there); otherwise the first board.
  useEffect(() => {
    if (activeBoard) return;
    if (highlightCardId && personalBoardId) { void openBoard(personalBoardId); return; }
    if (boards[0]) void openBoard(boards[0].id);
  }, [boards, activeBoard, openBoard, highlightCardId, personalBoardId]);

  // Live refresh: while a board is open, refetch on any change (this client's
  // moves, another client's, or a triggered run updating a card's lastRunId).
  // Two mechanisms:
  //   1. SSE change stream — instant push, when reachable (same-site / direct).
  //   2. Polling (~5s) — the reliable floor. The in-browser /api path is
  //      proxied by Firebase Hosting, which buffers `text/event-stream`, so the
  //      SSE push does not flush through the CDN; polling keeps the board fresh
  //      regardless. Both simply refetch the open board.
  useEffect(() => {
    const boardId = activeBoard?.id;
    if (!boardId) return;
    // On the personal board, also refresh the cross-board "Assigned to me" rail:
    // its cards live on OTHER boards, so the per-board SSE stream can't cover
    // them — the poll is their floor (assignment changes elsewhere).
    const onPersonal = boardId === personalBoardId;
    const refresh = () => { void openBoard(boardId); if (onPersonal) void refreshAssigned(); };
    const unsubscribe = subscribeBoardEvents(boardId, refresh);
    // Visibility-gated polling (GAP-ANALYSIS E3): a hidden tab does not spend
    // the per-IP read budget; returning to the tab refreshes immediately so it
    // is never stale on focus.
    const poll = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsubscribe();
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [activeBoard?.id, openBoard, personalBoardId, refreshAssigned]);

  // ADR 0049 — claim a role-addressed (unclaimed) card from the rail; the caller
  // becomes its accountable owner. Refresh the rail (and the board, in case the
  // claimed card lives on the personal board itself).
  const onClaim = useCallback(async (cardId: string) => {
    setClaimBusyId(cardId);
    try {
      await claimCard(cardId);
      await refreshAssigned();
    } catch (err) {
      setError((() => { const c = classifyHttpError(err); return `${c.title} — ${c.detail}`; })());
    } finally {
      setClaimBusyId(null);
    }
  }, [refreshAssigned]);

  const onCreateBoard = async (input: { name: string; triggerWorkflowId?: string; rosterId?: string }) => {
    try {
      const board = await createBoard(input);
      setCreating(false);
      await refreshBoards();
      await openBoard(board.id);
    } catch (err) {
      setError((() => { const c = classifyHttpError(err); return `${c.title} — ${c.detail}`; })());
    }
  };

  // Duplicate = a new board with the same trigger/owner + a copy of every
  // card — composed entirely from existing create APIs.
  const onDuplicateBoard = async () => {
    if (!activeBoard) return;
    try {
      const todoCol = activeBoard.columns.find((c) => c.triggerWorkflowId);
      const copy = await createBoard({
        name: `${activeBoard.name} copy`,
        ...(todoCol?.triggerWorkflowId ? { triggerWorkflowId: todoCol.triggerWorkflowId } : {}),
        ...(activeBoard.rosterId ? { rosterId: activeBoard.rosterId } : {}),
      });
      for (const card of [...cards].sort((a, b) => a.order - b.order)) {
        await createCard(copy.id, {
          title: card.title,
          columnId: card.columnId,
          ...(card.description ? { description: card.description } : {}),
          ...(card.source ? { source: card.source } : {}),
          ...(card.workflowId ? { workflowId: card.workflowId } : {}),
          ...(card.priority ? { priority: card.priority } : {}),
          ...(card.dueAt ? { dueAt: card.dueAt } : {}),
          ...(card.assignmentReason ? { assignmentReason: card.assignmentReason } : {}),
          ...(card.blockerNote ? { blockerNote: card.blockerNote } : {}),
        });
      }
      setNotice(t('duplicatedNotice', { name: activeBoard.name }));
      await refreshBoards();
      await openBoard(copy.id);
    } catch (err) {
      setError((() => { const c = classifyHttpError(err); return `${c.title} — ${c.detail}`; })());
    }
  };

  // Open the in-app rename modal (replaces the native window.prompt — off-brand
  // + inaccessible). The actual PATCH lives in submitRename below.
  const onRenameBoard = (): void => { if (activeBoard) setRenaming(true); };
  const submitRename = async (raw: string): Promise<void> => {
    if (!activeBoard) return;
    const name = raw.trim();
    if (!name || name === activeBoard.name) { setRenaming(false); return; }
    try {
      const renamed = await patchBoard(activeBoard.id, { name });
      setActiveBoard(renamed);
      setNotice(t('renamedNotice', { name: renamed.name }));
      await refreshBoards();
    } catch (err) {
      setError((() => { const c = classifyHttpError(err); return `${c.title} — ${c.detail}`; })());
    } finally {
      setRenaming(false);
    }
  };

  const onDeleteBoard = async () => {
    if (!activeBoard) return;
    const board = activeBoard;
    if (!(await confirm({ title: t('deleteBoardConfirm', { name: board.name }), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteBoard(board.id);
      setActiveBoard(null);
      setCards([]);
      await refreshBoards();
    } catch (err) {
      setError((() => { const c = classifyHttpError(err); return `${c.title} — ${c.detail}`; })());
    }
  };

  const onCreateCard = async (columnId: string, input: NewCardInput) => {
    if (!activeBoard) return;
    try {
      // Forward every field the shared add-card form collects (description /
      // priority / due / source) — not just the title.
      await createCard(activeBoard.id, {
        title: input.title,
        columnId,
        ...(input.description ? { description: input.description } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.dueAt ? { dueAt: input.dueAt } : {}),
        ...(input.assignmentReason ? { assignmentReason: input.assignmentReason } : {}),
        ...(input.blockerNote ? { blockerNote: input.blockerNote } : {}),
      });
      await openBoard(activeBoard.id);
      await refreshBoards();
    } catch (err) {
      setError((() => { const c = classifyHttpError(err); return `${c.title} — ${c.detail}`; })());
    }
  };

  const onDeleteCard = async (cardId: string) => {
    if (!activeBoard) return;
    const card = cards.find((c) => c.id === cardId);
    if (!(await confirm({ title: card ? t('deleteCardConfirm', { title: card.title }) : t('deleteCardConfirmNoTitle'), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteCard(cardId);
      await openBoard(activeBoard.id);
      await refreshBoards();
    } catch (err) {
      setError((() => { const c = classifyHttpError(err); return `${c.title} — ${c.detail}`; })());
    }
  };

  const onMoveCard = async (cardId: string, toColumnId: string) => {
    if (!activeBoard) return;
    const card = cards.find((c) => c.id === cardId);
    // BLD-4: guard against a second drag of the same card before its PATCH
    // settles — two in-flight moves race and the later rollback can clobber
    // the earlier outcome. No-op the re-entry.
    if (movingCardIds.current.has(cardId)) return;
    const prevColumnId = card?.columnId;
    // Optimistic move (GAP-ANALYSIS E15): apply locally immediately so the card
    // stays where it was dropped instead of snapping back then jumping after the
    // round-trip.
    movingCardIds.current.add(cardId);
    setCards((cs) => cs.map((c) => (c.id === cardId ? { ...c, columnId: toColumnId } : c)));
    try {
      const { triggeredRunId } = await patchCard(cardId, { columnId: toColumnId });
      if (triggeredRunId && card) setNotice(t('startedRunNotice', { title: card.title }));
      // Reconcile with server truth (covers triggered-run side effects); the
      // card is already in place so there is no visible jump.
      await openBoard(activeBoard.id);
      await refreshBoards();
    } catch (err) {
      // BLD-3: revert ONLY the moved card against the *current* state via a
      // functional update — restoring a stale whole-list snapshot would clobber
      // any concurrent refetch/update that landed during the round-trip.
      if (prevColumnId !== undefined) {
        setCards((cs) => cs.map((c) => (c.id === cardId ? { ...c, columnId: prevColumnId } : c)));
      }
      setError((() => { const c = classifyHttpError(err); return `${c.title} — ${c.detail}`; })());
    } finally {
      movingCardIds.current.delete(cardId);
    }
  };

  const rosterById = new Map(roster.map((r) => [r.rosterId, r]));
  const owner = activeBoard?.rosterId ? rosterById.get(activeBoard.rosterId) : undefined;
  const activeTrigger = activeBoard?.columns.find((c) => c.triggerWorkflowId)?.triggerWorkflowId;
  const activeWaiting = activeBoard ? waitingCount(activeBoard.columns, cards) : 0;

  // ADR 0049 — the "Assigned to me" rail shows only on the caller's personal
  // board, and only its OPEN (non-terminal) cards: work actually waiting on
  // them. Empty ⇒ the column collapses away entirely (rendered as nothing).
  // Exception: a notification deep-link (`/boards?card=<id>`) to an already-
  // COMPLETED assigned card still surfaces that one card so the highlight/scroll
  // lands (otherwise the open-only filter would hide it and the link no-ops).
  const openAssigned = useMemo(() => {
    const open = assigned.filter((c) => !c.terminal);
    if (highlightCardId && !open.some((c) => c.id === highlightCardId)) {
      const target = assigned.find((c) => c.id === highlightCardId);
      if (target) return [target, ...open];
    }
    return open;
  }, [assigned, highlightCardId]);
  const showAssignedRail = Boolean(activeBoard && personalBoardId && activeBoard.id === personalBoardId && openAssigned.length > 0);

  return (
    <section>
      <PageHeader
        eyebrow={t('boardsEyebrow')}
        title={t('boardsTitle')}
        lede={<>{t('boardsLedePre')}<ZapIcon size={12} aria-hidden /> <strong>{t('boardsLedeTrigger')}</strong>{t('boardsLedePost')}</>}
        actions={<button type="button" className="btn-accent-solid" onClick={() => setCreating(true)}>{t('newBoard')}</button>}
      />

      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}

      {/* Switcher pills: owner avatar · name · live count · attention dot. */}
      <div className="board-pills">
        {/* role="tablist" wraps ONLY the board tabs (display:contents keeps the
            flex row); the "+ New board" action is a sibling, not a tab, so the
            tablist's required-children contract holds (a11y, axe-verified). */}
        {boards.length > 0 ? (
        <div role="tablist" aria-label={t('boardsTitle')} className="kanbanpage-tablist" onKeyDown={handleTablistKeyDown}>
        {boards.map((b) => {
          const o = b.rosterId ? rosterById.get(b.rosterId) : undefined;
          const waiting = waitingCount(b.columns, b.cards);
          const active = activeBoard?.id === b.id;
          return (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={active ? 'board-pill is-active' : 'board-pill'}
              onClick={() => void openBoard(b.id)}
            >
              {o ? (
                <AgentAvatar
                  persona={o.persona}
                  avatarUrl={o.avatarUrl}
                  roleTheme={roleThemeForAgent(o.agentRef?.agentId, o.workflows)}
                  size={18}
                  showBadge={false}
                />
              ) : null}
              <span className="board-pill-name">{b.name}</span>
              <span className="board-pill-count">{b.cards.length}</span>
              {waiting > 0 ? <span className="board-pill-dot" title={t('waitingOnYou', { count: waiting })} aria-label={t('waitingOnYou', { count: waiting })} /> : null}
            </button>
          );
        })}
        </div>
        ) : null}
        <button type="button" className="board-pill board-pill--new" onClick={() => setCreating(true)}>
          {t('newBoard')}
        </button>
      </div>

      {activeBoard ? (
        <>
          <div className="board-head">
            <h2 className="board-head-name">{activeBoard.name}</h2>
            {owner ? (
              <span className="board-head-owner">
                <AgentAvatar
                  persona={owner.persona}
                  avatarUrl={owner.avatarUrl}
                  roleTheme={roleThemeForAgent(owner.agentRef?.agentId, owner.workflows)}
                  size={20}
                  showBadge={false}
                />
                {owner.persona}
              </span>
            ) : null}
            {activeTrigger ? (
              <span className="board-head-trigger">
                <WorkflowIcon size={13} aria-hidden /> {t('triggers')}&nbsp;<strong>{workflowName(activeTrigger)}</strong>
              </span>
            ) : null}
            {activeWaiting > 0 ? (
              <span className="chip chip--warning">
                <AlertIcon size={11} aria-hidden /> {t('waitingOnYou', { count: activeWaiting })}
              </span>
            ) : null}
            <span className="board-head-spacer" />
            <BoardMenu onRename={() => void onRenameBoard()} onDuplicate={() => void onDuplicateBoard()} onDelete={() => void onDeleteBoard()} />
          </div>

          <KanbanBoardView
            board={activeBoard}
            cards={cards}
            ownerPersona={owner?.persona}
            onMoveCard={(cardId, toColumnId) => void onMoveCard(cardId, toColumnId)}
            onCreateCard={(columnId, input) => void onCreateCard(columnId, input)}
            onDeleteCard={(cardId) => void onDeleteCard(cardId)}
            leadingColumn={showAssignedRail ? (
              <AssignedColumn
                cards={openAssigned}
                busyId={claimBusyId}
                highlightId={highlightCardId}
                onClaim={(cardId) => void onClaim(cardId)}
              />
            ) : undefined}
          />
        </>
      ) : boardsLoading ? (
        <StateCard loading title={t('loadingBoards')} />
      ) : (
        <StateCard
          icon={<ColumnsIcon size={26} />}
          title={t('noBoardsYet')}
          body={t('noBoardsBody')}
          action={<button type="button" className="btn-accent-solid btn-sm" onClick={() => setCreating(true)}>{t('newBoard')}</button>}
        />
      )}

      {creating ? <CreateBoardModal roster={roster} onClose={() => setCreating(false)} onCreate={(input) => void onCreateBoard(input)} /> : null}
      {renaming && activeBoard ? <RenameBoardModal current={activeBoard.name} onClose={() => setRenaming(false)} onSubmit={(name) => void submitRename(name)} /> : null}
    </section>
  );
}
