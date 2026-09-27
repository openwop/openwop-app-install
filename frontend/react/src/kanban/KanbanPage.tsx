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

import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { listRoster, type RosterEntry } from '../agents/rosterClient.js';
import { roleThemeForAgent, workflowName } from '../agents/roleTemplates.js';
import { listWorkflowSummaries, type WorkflowSummaryDTO } from '../workflows/workflowsClient.js';
import { AgentAvatar } from '../agents/AgentAvatar.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { classifyHttpError } from '../client/classifyHttpError.js';
import { PageHeader } from '../ui/PageHeader.js';
import { IconButton } from '../ui/IconButton.js';
import { AlertIcon, ClockIcon, ColumnsIcon, DotsIcon, PencilIcon, TrashIcon, WorkflowIcon, ZapIcon } from '../ui/icons/index.js';
import { KanbanBoardView, type CardMovePosition, type CardPatch, type NewCardInput } from './KanbanBoardView.js';
import { BoardReviewsSection } from './BoardReviewsSection.js';
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
  runWorkItem,
  setColumnLimit,
  subscribeBoardEvents,
  type AssignedCard,
  type KanbanBoard,
  type KanbanBoardWithCards,
  type KanbanCard,
  type KanbanWorkItem,
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
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t('common:cancel')}</Button>
          <Button variant="primary" type="submit" disabled={!canSave}>{t('common:save')}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function KanbanPage(): JSX.Element {
  const { t } = useTranslation('kanban');
  // Every board has its own URL (`/boards/:boardId`, routing-correction wave);
  // the bare `/boards` redirects below so the page never greets with an empty
  // shell (decision-first: show the work, not a picker).
  const { boardId } = useParams<{ boardId: string }>();
  const navigate = useNavigate();
  const [boards, setBoards] = useState<KanbanBoardWithCards[]>([]);
  const [activeBoard, setActiveBoard] = useState<KanbanBoard | null>(null);
  const [cards, setCards] = useState<KanbanCard[]>([]);
  const [workItems, setWorkItems] = useState<KanbanWorkItem[]>([]);
  const [startingWorkItemIds, setStartingWorkItemIds] = useState<Set<string>>(new Set());
  const workItemsByCardId = useMemo(
    () => new Map(workItems.map((workItem) => [workItem.cardId, workItem] as const)),
    [workItems],
  );
  // BLD-4: cards with an in-flight move PATCH — guards against double-drag
  // races. A ref (not state) so toggling it never triggers a re-render.
  const movingCardIds = useRef<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Init-true so the first load shows a loading state, not a false "No boards
  // yet" empty flash before the fetch resolves (GAP-ANALYSIS E5).
  const [boardsLoading, setBoardsLoading] = useState(true);
  // UX-BRD-1 — the boards read FAILED; we must not claim the user has none.
  const [boardsFailed, setBoardsFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // Roster members boards can be bound to (RFC 0086): the owner's avatar
  // renders in the switcher pill and the board header.
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  // Kanban binds the exact tenant-owned workflow visible in Workflow Builder.
  // This deliberately replaces the static role-template catalog so a user can
  // edit a workflow and select that owned revision from either board or card UX.
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowSummaryDTO[]>([]);
  const [workflowOptionsLoading, setWorkflowOptionsLoading] = useState(true);
  const [workflowOptionsFailed, setWorkflowOptionsFailed] = useState(false);
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
      setBoardsFailed(false);
    } catch (err) {
      // UX-BRD-1 — the error Notice below is set, but `boards` stayed [] and
      // `boardsLoading` went false, so the render ALSO fell through to
      // "No boards yet — Create a board to start tracking work" with a New-board
      // CTA. A user who owns boards was told they own none and invited to make a
      // duplicate. An error beside a false claim is still a false claim; and the
      // header's "never greets with an empty shell" promise is broken precisely
      // here, since the redirect can't fire without a board to redirect to.
      setBoardsFailed(true);
      setError((() => { const c = classifyHttpError(err); return `${c.title} — ${c.detail}`; })());
    } finally {
      setBoardsLoading(false);
    }
  }, []);

  const openBoard = useCallback(async (boardId: string) => {
    try {
      // `workItems` is an additive board-read field. Treat an older host or
      // embed that has not adopted it yet as an empty projection rather than
      // breaking the reusable board shell.
      const { board, cards: c, workItems: nextWorkItems = [] } = await getBoard(boardId);
      setActiveBoard(board);
      setCards(c);
      setWorkItems(nextWorkItems);
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
    void listWorkflowSummaries()
      .then((workflows) => { setWorkflowOptions(workflows); setWorkflowOptionsFailed(false); })
      .catch(() => { setWorkflowOptionsFailed(true); })
      .finally(() => { setWorkflowOptionsLoading(false); });
  }, [refreshBoards, refreshAssigned]);

  const workflowLabel = useCallback(
    (workflowId: string): string => workflowOptions.find((workflow) => workflow.workflowId === workflowId)?.name ?? workflowName(workflowId),
    [workflowOptions],
  );

  // The URL owns the open board: load whatever `:boardId` names (and reload on
  // param change — back/forward included).
  useEffect(() => {
    if (boardId) { void openBoard(boardId); return; }
    setActiveBoard(null);
    setCards([]);
    setWorkItems([]);
  }, [boardId, openBoard]);

  // The bare `/boards` redirects (replace) to a concrete board so the page
  // never greets with an empty shell (decision-first: show the work, not a
  // picker). A `?card=` deep-link prefers the personal board (the rail lives
  // there); otherwise the first board. The query string rides along.
  useEffect(() => {
    if (boardId || boardsLoading) return;
    const target = highlightCardId && personalBoardId ? personalBoardId : boards[0]?.id;
    if (!target) return;
    const qs = params.toString();
    navigate(`/boards/${encodeURIComponent(target)}${qs ? `?${qs}` : ''}`, { replace: true });
  }, [boardId, boards, boardsLoading, highlightCardId, personalBoardId, params, navigate]);

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
      navigate(`/boards/${encodeURIComponent(board.id)}`);
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
      navigate(`/boards/${encodeURIComponent(copy.id)}`);
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
      setWorkItems([]);
      await refreshBoards();
      // Back to the bare route; its redirect picks the next board (or empty state).
      navigate('/boards', { replace: true });
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

  // KB-R2-1 — persist an in-place card edit. The view sends CHANGED fields
  // only, so this can never clobber a field the user didn't touch.
  const onEditCard = async (cardId: string, patch: CardPatch) => {
    if (!activeBoard) return;
    const card = cards.find((c) => c.id === cardId);
    try {
      await patchCard(cardId, patch);
      await openBoard(activeBoard.id);
      await refreshBoards();
      setNotice(t('cardUpdatedNotice', { title: patch.title ?? card?.title ?? '' }));
    } catch (err) {
      setError((() => { const c = classifyHttpError(err); return `${c.title} — ${c.detail}`; })());
    }
  };

  const onMoveCard = async (cardId: string, toColumnId: string, position?: CardMovePosition) => {
    if (!activeBoard) return;
    const card = cards.find((c) => c.id === cardId);
    // BLD-4: guard against a second drag of the same card before its PATCH
    // settles — two in-flight moves race and the later rollback can clobber
    // the earlier outcome. No-op the re-entry.
    if (movingCardIds.current.has(cardId)) return;
    const prevCard = card;
    // Optimistic move (GAP-ANALYSIS E15): apply locally immediately so the card
    // stays where it was dropped instead of snapping back then jumping after the
    // round-trip.
    movingCardIds.current.add(cardId);
    // The shared board owns an in-lane optimistic rank. Do not replace its
    // local list with a parent array that has no rank change yet; cross-lane
    // moves still mirror immediately for the surrounding board chrome.
    if (card?.columnId !== toColumnId) {
      setCards((cs) => cs.map((c) => (c.id === cardId ? { ...c, columnId: toColumnId } : c)));
    }
    try {
      const { triggeredRunId } = await patchCard(cardId, {
        columnId: toColumnId,
        ...(position?.beforeCardId ? { beforeCardId: position.beforeCardId } : {}),
        ...(position?.afterCardId ? { afterCardId: position.afterCardId } : {}),
      });
      if (triggeredRunId && card) setNotice(t('startedRunNotice', { title: card.title }));
      // Reconcile with server truth (covers triggered-run side effects); the
      // card is already in place so there is no visible jump.
      await openBoard(activeBoard.id);
      await refreshBoards();
    } catch (err) {
      // BLD-3: revert ONLY the moved card against the *current* state via a
      // functional update — restoring a stale whole-list snapshot would clobber
      // any concurrent refetch/update that landed during the round-trip.
      if (prevCard && prevCard.columnId !== toColumnId) {
        setCards((cs) => cs.map((c) => (c.id === cardId ? prevCard : c)));
      }
      // An in-lane position optimistic update lives only in the shared board;
      // restore the authoritative order if its PATCH fails.
      void openBoard(activeBoard.id);
      setError((() => { const c = classifyHttpError(err); return `${c.title} — ${c.detail}`; })());
    } finally {
      movingCardIds.current.delete(cardId);
    }
  };

  /** Explicit human delivery for the reusable WorkItem aggregate. This is not
   * an App Builder action: the board sends only the core id, and the backend
   * resolves the tenant-owned, Builder-editable workflow binding at dispatch. */
  const onRunWorkItem = async (workItemId: string): Promise<void> => {
    if (!activeBoard || startingWorkItemIds.has(workItemId)) return;
    const card = cards.find((candidate) => candidate.workItemId === workItemId);
    setStartingWorkItemIds((current) => new Set(current).add(workItemId));
    setError(null);
    try {
      await runWorkItem(activeBoard.id, workItemId);
      await openBoard(activeBoard.id);
      await refreshBoards();
      setNotice(t('workRunStartedNotice', { title: card?.title ?? '' }));
    } catch (err) {
      setError((() => { const c = classifyHttpError(err); return `${c.title} — ${c.detail}`; })());
    } finally {
      setStartingWorkItemIds((current) => {
        const next = new Set(current);
        next.delete(workItemId);
        return next;
      });
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
    <section data-walkthrough="boards.page">
      <PageHeader
        eyebrow={t('boardsEyebrow')}
        title={t('boardsTitle')}
        lede={<>{t('boardsLedePre')}<ZapIcon size={12} aria-hidden /> <strong>{t('boardsLedeTrigger')}</strong>{t('boardsLedePost')}</>}
        actions={<Button variant="accent-solid" onClick={() => setCreating(true)}>{t('newBoard')}</Button>}
      />

      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success" announce={notice}>{notice}</Notice> : null}

      {/* Switcher pills: owner avatar · name · live count · attention dot.
          Each pill is a real LINK to the board's own URL (`/boards/:boardId`) —
          cmd/middle-click, share, back/forward — so the strip is a nav, not a
          tablist (the routing-correction wave; tabs were in-page state). */}
      <div className="board-pills">
        {boards.length > 0 ? (
        <nav aria-label={t('boardsTitle')} className="kanbanpage-tablist">
        {boards.map((b) => {
          const o = b.rosterId ? rosterById.get(b.rosterId) : undefined;
          const waiting = waitingCount(b.columns, b.cards);
          const active = boardId === b.id;
          return (
            <Link
              key={b.id}
              to={`/boards/${encodeURIComponent(b.id)}`}
              aria-current={active ? 'page' : undefined}
              className={active ? 'board-pill is-active' : 'board-pill'}
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
              {waiting > 0 ? <span role="img" className="board-pill-dot" title={t('waitingOnYou', { count: waiting })} aria-label={t('waitingOnYou', { count: waiting })} /> : null}
            </Link>
          );
        })}
        </nav>
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
                <WorkflowIcon size={13} aria-hidden /> {t('triggers')}&nbsp;<strong>{workflowLabel(activeTrigger)}</strong>
              </span>
            ) : null}
            {activeWaiting > 0 ? (
              <span className="chip chip--warning">
                <AlertIcon size={11} aria-hidden /> {t('waitingOnYou', { count: activeWaiting })}
              </span>
            ) : null}
            {/* ADR 0313 D3 — an agent board SAYS whether its owner actually
                checks it (the silence chip): the resolved cadence, or off. */}
            {owner?.heartbeat ? (
              owner.heartbeat.effectiveIntervalMs > 0 ? (
                <span className="chip chip--muted" title={t('heartbeatChipTitle')}>
                  <ClockIcon size={11} aria-hidden /> {t('heartbeatEvery', { minutes: Math.max(1, Math.round(owner.heartbeat.effectiveIntervalMs / 60_000)) })}
                </span>
              ) : (
                <span className="chip chip--warning" title={t('heartbeatOffTitle')}>
                  <ClockIcon size={11} aria-hidden /> {t('heartbeatOff')}
                </span>
              )
            ) : null}
            <span className="board-head-spacer" />
            <BoardMenu onRename={() => void onRenameBoard()} onDuplicate={() => void onDuplicateBoard()} onDelete={() => void onDeleteBoard()} />
          </div>

          {/* ADR 0311 P3 — read-time "Needs review" lane over the ADR 0068
              projection (a view, never an owner; renders nothing when empty). */}
          <BoardReviewsSection boardId={activeBoard.id} />

          <KanbanBoardView
            board={activeBoard}
            cards={cards}
            ownerPersona={owner?.persona}
            todoAutonomy={owner?.heartbeat
              ? (owner.heartbeat.effectiveIntervalMs > 0 && owner.heartbeat.agentTurnFallback ? 'agent-turn' : 'off')
              : undefined}
            workflowOptions={workflowOptions}
            onMoveCard={(cardId, toColumnId) => void onMoveCard(cardId, toColumnId)}
            onCreateCard={(columnId, input) => void onCreateCard(columnId, input)}
            onEditCard={(cardId, patch) => void onEditCard(cardId, patch)}
            onDeleteCard={(cardId) => void onDeleteCard(cardId)}
            workItemsByCardId={workItemsByCardId}
            onRunWorkItem={(workItemId) => void onRunWorkItem(workItemId)}
            startingWorkItemIds={startingWorkItemIds}
            onDeleteCards={(cardIds) => {
              void (async () => {
                // ONE count-confirm for the whole batch — the per-card handler's
                // dialog would fire N times through a fan-out.
                if (!(await confirm({ title: t('deleteCardsConfirm', { count: cardIds.length }), danger: true, confirmLabel: t('common:delete') }))) return;
                try {
                  await Promise.all(cardIds.map((id) => deleteCard(id)));
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
                // Same rule as every other mutation here: refresh the RENDERED
                // board (activeBoard) before the list, or the deleted cards sit
                // on screen until a reload.
                await openBoard(activeBoard.id);
                await refreshBoards();
              })();
            }}
            onSetColumnLimit={(columnId, wipLimit) => {
              void (async () => {
                try {
                  await setColumnLimit(activeBoard.id, columnId, wipLimit);
                  // `openBoard` FIRST — the rendered board is `activeBoard`,
                  // which `refreshBoards` (the boards LIST) does not touch.
                  // Browser-verified: without this the limit persisted but the
                  // column readout only appeared after a page reload.
                  await openBoard(activeBoard.id);
                  await refreshBoards();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              })();
            }}
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
      ) : boardsFailed ? (
        // UX-BRD-1 — a failed read never borrows the "create your first board"
        // invitation; offer a retry instead of a duplicate.
        <StateCard
          announce
          icon={<ColumnsIcon size={26} />}
          title={t('boardsUnavailableTitle')}
          body={t('boardsUnavailableBody')}
          action={<Button variant="secondary" size="sm" onClick={() => void refreshBoards()}>{t('common:retry')}</Button>}
        />
      ) : (
        <StateCard
          icon={<ColumnsIcon size={26} />}
          title={t('noBoardsYet')}
          body={t('noBoardsBody')}
          action={<Button variant="accent-solid" size="sm" onClick={() => setCreating(true)}>{t('newBoard')}</Button>}
        />
      )}

      {creating ? (
        <CreateBoardModal
          roster={roster}
          workflowOptions={workflowOptions}
          workflowOptionsLoading={workflowOptionsLoading}
          workflowOptionsFailed={workflowOptionsFailed}
          onClose={() => setCreating(false)}
          onCreate={(input) => void onCreateBoard(input)}
        />
      ) : null}
      {renaming && activeBoard ? <RenameBoardModal current={activeBoard.name} onClose={() => setRenaming(false)} onSubmit={(name) => void submitRename(name)} /> : null}
    </section>
  );
}
