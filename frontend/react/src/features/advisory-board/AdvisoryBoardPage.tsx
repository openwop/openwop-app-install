/**
 * Board of Advisors — MANAGEMENT page (ADR 0040 § Correction 2026-06-15). Create,
 * EDIT, CLONE, and delete advisory boards (the COHORT: advisor roster agents +
 * visibility + persona kind). The boardroom CONVERSATION does NOT happen here —
 * you convene a board in the AI chat by typing its `@@<handle>`, which adds every
 * advisor to the chat's active-agents lineup. The backend is the authority
 * (toggle + RBAC + visibility + living-persona ack); this gates its own render on
 * useFeatureAccess. Edit/clone reuse the create form (seeded from an existing
 * board); edit is owner-only and PATCHes, clone POSTs a fresh board.
 *
 * `ui/` cohesion: surface-card / chip / action-bar / Notice / StateCard / Field.
 *
 * @see docs/adr/0040-board-of-advisors.md
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Modal } from '../../ui/Modal.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { ScaleIcon, UserIcon, PlusIcon, SaveIcon, TrashIcon, FlagIcon, FolderIcon, BookOpenIcon } from '../../ui/icons/index.js';
// ADR 0079 Phase 5 — strategy context picker (one-directional FE import).
import { listStrategies as listStrategiesForContext, FeatureDisabledError } from '../strategy/strategyClient.js';
import { listProjects as listProjectsForContext } from '../projects/projectsClient.js';
import {
  listBoards, createBoard, updateBoard, deleteBoard, listRoster, listOrgs,
  getSharedKnowledge, setSharedKnowledge, ensureBoardChat,
  type AdvisoryBoard, type RosterMember, type OrgRef, type PersonaKind, type BoardVisibility,
  type SharedKnowledgeItem, type SharedKbKind,
} from './advisoryBoardClient.js';
import { AdvisoryBoardCard, AdvisoryBoardRow, type BoardActions } from './AdvisoryBoardViews.js';

const PERSONA_KINDS: { value: PersonaKind; labelKey: 'personaHistorical' | 'personaFictional' | 'personaOriginal' | 'personaLiving' }[] = [
  { value: 'historical', labelKey: 'personaHistorical' },
  { value: 'fictional', labelKey: 'personaFictional' },
  { value: 'original', labelKey: 'personaOriginal' },
  { value: 'living', labelKey: 'personaLiving' },
];

/** A board seeded into the form for Edit (PATCH) or Clone (POST a copy). */
type FormSeed = { board: AdvisoryBoard; mode: 'edit' | 'clone' } | null;

/** Which board dialog is open. `create` starts empty; `edit`/`clone` carry the
 *  source board. Null = no dialog (the list is the whole page). */
type Dialog =
  | { mode: 'create' }
  | { mode: 'edit'; board: AdvisoryBoard }
  | { mode: 'clone'; board: AdvisoryBoard }
  | null;

export function AdvisoryBoardPage(): JSX.Element {
  const { t } = useTranslation('advisory-board');
  const access = useFeatureAccess('advisory-board');
  const navigate = useNavigate();
  const [boards, setBoards] = useState<AdvisoryBoard[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [loading, setLoading] = useState(true);
  // `loading` goes false in `finally` whether the read worked or not, so without this
  // a failed read is indistinguishable from an empty workspace: BoardList drew
  // "No boards yet — assemble your first council" and BoardForm drew "No advisor agents
  // yet — add agents to your roster first", the second of which sends the author off to
  // fix a roster that may be perfectly full.
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  // ADV-UX-3 (Blocker) — dialog-scoped failures render INSIDE the dialog. They
  // used to route to the page-level <Notice> above, which the ModalPortal scrim
  // covers: a failed save, and the irreversible failed DELETE, wrote their
  // reason somewhere the user physically could not see while the dialog stayed
  // open over it, and announced nothing. `ui/Modal` has shipped an `error` slot
  // for exactly this since GAP-ANALYSIS E7.
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdvisoryBoard | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ADR 0278 — ensure-or-join the board's ONE canonical conversation and open
  // it in the chat (the ProjectChatTab deep-link pattern; same chat every time).
  // GRADE — busy-guarded: the button disables while the POST is in flight
  // (double-clicks fired two POSTs + two navigations with zero feedback).
  const [openingChat, setOpeningChat] = useState<string | null>(null);
  // M1 — the CONSUMER for the route's `contextDegraded`. Before this the flag was
  // emitted and read by nothing: the claim "reports contextDegraded to the opener
  // instead of logging server-side only" was true of the response body and false
  // of anything the opener could see. A stale snapshot is a warning with a real
  // continue, not a refusal — the turn's grounding is re-resolved per caller
  // anyway (ADVB-1) — so we hold the navigation, say so, and let them proceed.
  const [staleSessionId, setStaleSessionId] = useState<string | null>(null);
  const openBoardChat = useCallback(async (b: AdvisoryBoard) => {
    if (openingChat) return;
    setError(null);
    setStaleSessionId(null);
    setOpeningChat(b.boardId);
    try {
      const { sessionId, contextDegraded } = await ensureBoardChat(b.boardId);
      if (contextDegraded) { setStaleSessionId(sessionId); setOpeningChat(null); return; }
      navigate(`/chat?conversation=${encodeURIComponent(sessionId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('openChatError'));
      setOpeningChat(null);
    }
  }, [navigate, t, openingChat]);

  const reload = useCallback(async () => {
    setError(null);
    setLoadFailed(false);
    try {
      // One catch for three reads, so ANY failure discards all three: `boards`,
      // `roster` and `orgs` all stay `[]`, which is also what a successful empty read
      // looks like. Downstream that became two separate false claims — see loadFailed.
      const [b, r, o] = await Promise.all([listBoards(), listRoster(), listOrgs()]);
      setBoards(b); setRoster(r); setOrgs(o);
    } catch (e) { setError((e as Error).message); setLoadFailed(true); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (access.loading || !access.enabled) { setLoading(false); return; }
    void reload();
  }, [access.loading, access.enabled, reload]);

  if (access.loading || loading) return <StateCard title={t('common:loading')} loading />;
  if (!access.enabled) {
    return (
      <StateCard
        icon={<ScaleIcon size={20} />}
        title={t('notEnabledTitle')}
        body={t('notEnabledBody')}
      />
    );
  }

  // Create/Edit/Clone all run through the same BoardForm, now hosted in a modal
  // so the list — the thing you come here to manage — is the page's one job.
  const dialogTitle = dialog
    ? dialog.mode === 'create'
      ? t('newBoard')
      : dialog.mode === 'edit'
        ? t('editBoardLabel', { name: dialog.board.name })
        : t('cloneBoardLabel', { name: dialog.board.name })
    : '';
  const seed: FormSeed = dialog && dialog.mode !== 'create' ? { board: dialog.board, mode: dialog.mode } : null;

  const handleDelete = async (board: AdvisoryBoard): Promise<void> => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteBoard(board.boardId);
      setConfirmDelete(null);
      setDialog((d) => (d && d.mode !== 'create' && d.board.boardId === board.boardId ? null : d));
      await reload();
    } catch (e) { setDeleteError((e as Error).message); }
    finally { setDeleting(false); }
  };

  return (
    <div className="u-grid u-gap-4" data-walkthrough="advisors.page">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
        actions={
          <Button variant="primary" onClick={() => setDialog({ mode: 'create' })}>
            <PlusIcon size={14} /> {t('newBoard')}
          </Button>
        }
      />

      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* M1 — the opener is TOLD the room's saved planning snapshot is stale, and
          is given the exit (open it anyway; advisors are grounded live regardless). */}
      {staleSessionId ? (
        <Notice variant="warning" announce={t('boardContextStaleBody')}>
          {t('boardContextStaleBody')}
          {' '}
          <Button variant="secondary" onClick={() => navigate(`/chat?conversation=${encodeURIComponent(staleSessionId)}`)}>
            {t('boardContextStaleOpen')}
          </Button>
        </Notice>
      ) : null}

      <BoardList
        boards={boards}
        loadFailed={loadFailed}
        onCreate={() => setDialog({ mode: 'create' })}
        onOpenChat={openBoardChat}
        openingChatBoardId={openingChat}
        onEdit={(b) => setDialog({ mode: 'edit', board: b })}
        onClone={(b) => setDialog({ mode: 'clone', board: b })}
        onDeleteRequest={(b) => setConfirmDelete(b)}
      />

      {dialog ? (
        <Modal
          label={dialogTitle}
          className="surface-card board-modal"
          onClose={() => { setDialog(null); setDialogError(null); }}
          {...(dialogError ? { error: dialogError, errorAnnounce: t('dialogErrorAnnounce') } : {})}
        >
          <BoardForm
            title={dialogTitle}
            roster={roster}
            rosterFailed={loadFailed}
            orgs={orgs}
            seed={seed}
            onDone={async () => { setDialog(null); setDialogError(null); await reload(); }}
            onCancel={() => { setDialog(null); setDialogError(null); }}
            onError={setDialogError}
          />
        </Modal>
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title={t('confirmDeleteTitle', { name: confirmDelete.name })}
          body={t('confirmDeleteBody')}
          confirmLabel={t('common:delete')}
          confirmIcon={<TrashIcon size={14} />}
          danger
          busy={deleting}
          {...(deleteError ? { error: deleteError, errorAnnounce: t('deleteErrorAnnounce') } : {})}
          onConfirm={() => void handleDelete(confirmDelete)}
          onCancel={() => { setConfirmDelete(null); setDeleteError(null); }}
        />
      ) : null}
    </div>
  );
}

function BoardList({ boards, loadFailed, onCreate, onOpenChat, openingChatBoardId, onEdit, onClone, onDeleteRequest }: {
  boards: AdvisoryBoard[];
  loadFailed: boolean;
  onCreate: () => void;
  onOpenChat: (b: AdvisoryBoard) => void;
  openingChatBoardId: string | null;
  onEdit: (b: AdvisoryBoard) => void;
  onClone: (b: AdvisoryBoard) => void;
  onDeleteRequest: (b: AdvisoryBoard) => void;
}): JSX.Element {
  const { t } = useTranslation('advisory-board');
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useViewMode('advisors', 'grid');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return boards;
    return boards.filter((b) => b.name.toLowerCase().includes(q) || b.handle.toLowerCase().includes(q));
  }, [boards, query]);

  // Ordered ABOVE the empty branch: `[]` is what BOTH a failed read and an empty
  // workspace leave behind, and below it the failure card would never be reached.
  if (loadFailed) {
    return <StateCard announce icon={<ScaleIcon size={20} />} title={t('common:loadFailedTitle')} body={t('common:loadFailedBody')} />;
  }
  if (boards.length === 0) {
    return (
      <StateCard
        icon={<ScaleIcon size={20} />}
        title={t('boardsEmptyTitle')}
        body={t('boardsEmptyBody')}
        action={
          <Button variant="primary" onClick={onCreate}>
            <PlusIcon size={14} /> {t('newBoard')}
          </Button>
        }
      />
    );
  }

  const actions: BoardActions = { onOpenChat, openingChatBoardId, onEdit, onClone, onDeleteRequest };

  return (
    <div className="u-grid u-gap-3">
      <div className="filterbar" role="group" aria-label={t('filterGroup')}>
        {boards.length > 3 ? (
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('filterPlaceholder')}
            aria-label={t('filterAria')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : null}
        <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
      </div>

      {visible.length === 0 ? (
        <StateCard
          icon={<ScaleIcon size={20} />}
          title={t('noMatchTitle')}
          body={t('noMatchBody')}
          action={<Button variant="secondary" onClick={() => setQuery('')}>{t('clearSearch')}</Button>}
        />
      ) : viewMode === 'grid' ? (
        <div className="card-grid">
          {visible.map((b) => <AdvisoryBoardCard key={b.boardId} board={b} {...actions} />)}
        </div>
      ) : (
        <div className="surface-card list-view">
          {visible.map((b) => <AdvisoryBoardRow key={b.boardId} board={b} {...actions} />)}
        </div>
      )}
    </div>
  );
}

function BoardForm({ title, roster, rosterFailed, orgs, seed, onDone, onCancel, onError }: {
  title: string;
  roster: RosterMember[];
  rosterFailed: boolean;
  orgs: OrgRef[];
  seed: FormSeed;
  onDone: () => Promise<void>;
  onCancel: () => void;
  onError: (m: string) => void;
}): JSX.Element {
  const { t } = useTranslation('advisory-board');
  const editing = seed?.mode === 'edit' ? seed.board : null;
  const [name, setName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<BoardVisibility>('private');
  const [personaKind, setPersonaKind] = useState<PersonaKind>('historical');
  // ADV-UX-7 — who SYNTHESIZES. Empty string ⇒ no moderator ⇒ the cadence falls
  // back to the first activated advisor, which is what the product promised was
  // a "moderator" all along.
  const [moderatorRosterId, setModeratorRosterId] = useState<string>('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  // ADR 0079 Phase 5 — strategy context. `strategyOn=false` ⇒ feature off ⇒ no picker.
  const [strategies, setStrategies] = useState<{ id: string; title: string }[]>([]);
  const [strategyOn, setStrategyOn] = useState(false);
  const [pickedStrategies, setPickedStrategies] = useState<string[]>([]);
  // ADR 0100 — project context (the project counterpart of strategy context).
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectsOn, setProjectsOn] = useState(false);
  /** ADV-G1 — the read FAILED (as distinct from the feature being off). */
  const [strategyFailed, setStrategyFailed] = useState(false);
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [pickedProjects, setPickedProjects] = useState<string[]>([]);
  // ADR 0100 D2 — shared knowledge (managed KB binding). Out-of-band per-board
  // state (NOT on the board DTO), so it's editable only for an existing board and
  // reconciled on save via setSharedKnowledge, not the board PATCH.
  // null = not loaded / N-A (create/clone) · 'error' = load failed (show inline,
  // don't silently hide the section) · array = loaded.
  const [kbItems, setKbItems] = useState<SharedKnowledgeItem[] | 'error' | null>(null);
  const [pickedKbs, setPickedKbs] = useState<SharedKbKind[]>([]);

  useEffect(() => {
    // ADV-G1 — the strategy catch already ASKED whether this was a disabled
    // feature (`instanceof FeatureDisabledError`) and then threw the answer away
    // into an empty block. "The feature is off" and "the read failed" collapse
    // to the same silently-absent picker, so a board author loses the ability to
    // attach context and is never told the option exists. Hiding is right for
    // OFF; it is not right for a failure.
    void listStrategiesForContext()
      .then((rows) => { setStrategies(rows.filter((s) => s.status !== 'archived').map((s) => ({ id: s.id, title: s.title }))); setStrategyOn(true); })
      .catch((e) => { setStrategyOn(false); if (!(e instanceof FeatureDisabledError)) setStrategyFailed(true); });
    void listProjectsForContext()
      .then((rows) => { setProjects(rows.map((p) => ({ id: p.id, name: p.name }))); setProjectsOn(true); })
      .catch((e) => { setProjectsOn(false); if (!(e instanceof FeatureDisabledError)) setProjectsFailed(true); });
  }, []);

  // Pre-fill from a seeded board (Edit keeps the name; Clone suffixes it).
  useEffect(() => {
    if (!seed) return;
    const b = seed.board;
    setName(seed.mode === 'clone' ? t('cloneNameSuffix', { name: b.name }) : b.name);
    setOrgId(b.orgId);
    setPicked(b.advisors);
    setPickedStrategies((b.contextRefs ?? []).flatMap((r) => (r.kind === 'strategy' ? [r.strategyId] : [])));
    setPickedProjects((b.contextRefs ?? []).flatMap((r) => (r.kind === 'project' ? [r.projectId] : [])));
    setVisibility(b.visibility);
    setPersonaKind(b.personaKind);
    setModeratorRosterId(b.moderatorRosterId ?? '');
    // ADVB-4 / ADR 0588 D5 — pre-tick ONLY an acknowledgement a real person is
    // on record as having made. An unattributed ack (a pre-0588 row) or a
    // synthetic seed actor's leaves the box empty, so adopting a seeded board is
    // a deliberate act rather than a rename that silently makes you
    // owner-of-record. A clone is a NEW board and never inherits it.
    setAck(seed.mode === 'clone' ? false : b.livingPersonaAck === true && !!b.livingPersonaAckBy && !b.livingPersonaAckBy.startsWith('demo:'));
  }, [seed, t]);

  // Default org for a fresh create (never override a seeded board's org).
  useEffect(() => { if (!orgId && !seed && orgs[0]) setOrgId(orgs[0].orgId); }, [orgs, orgId, seed]);

  // Load shared-knowledge state for an existing board and seed the picker from
  // what's currently shared. Create/clone has no board bound yet ⇒ section hidden.
  const editingBoardId = editing?.boardId;
  useEffect(() => {
    if (!editingBoardId) { setKbItems(null); setPickedKbs([]); return undefined; }
    let live = true;
    getSharedKnowledge(editingBoardId)
      .then((items) => { if (live) { setKbItems(items); setPickedKbs(items.filter((it) => it.shared).map((it) => it.kind)); } })
      .catch(() => { if (live) setKbItems('error'); });
    return () => { live = false; };
  }, [editingBoardId]);

  const toggle = (id: string): void => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleStrategy = (id: string): void => setPickedStrategies((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleProject = (id: string): void => setPickedProjects((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleKb = (kind: SharedKbKind): void => setPickedKbs((p) => (p.includes(kind) ? p.filter((x) => x !== kind) : [...p, kind]));
  const contextRefs = useMemo(() => [
    ...pickedStrategies.map((strategyId) => ({ kind: 'strategy' as const, strategyId })),
    ...pickedProjects.map((projectId) => ({ kind: 'project' as const, projectId })),
  ], [pickedStrategies, pickedProjects]);
  const canSubmit = useMemo(() => name.trim().length > 0 && orgId && picked.length > 0 && (personaKind !== 'living' || ack), [name, orgId, picked, personaKind, ack]);

  const resetEmpty = (): void => { setName(''); setPicked([]); setPickedStrategies([]); setPickedProjects([]); setPickedKbs([]); setAck(false); setVisibility('private'); setPersonaKind('historical'); setModeratorRosterId(''); };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const livingAck = personaKind === 'living' ? { livingPersonaAck: ack } : {};
      // M3 — a chair OUTSIDE the cohort is a legal, server-supported shape
      // (`assertCohortSeats` explicitly budgets a seat for "a chair who is not one
      // of them"), so it must survive an unrelated edit. This used to coerce any
      // out-of-cohort chair to `''` and then send `moderatorRosterId: null`, which
      // `updateBoard` turns into `delete next.moderatorRosterId` — so RENAMING
      // such a board DESTROYED its chair, after the picker had already told the
      // author it had none (the option list omitted it).
      //
      // The field is now sent only when the author actually MOVED it. Absent ⇒
      // "leave unchanged" is exactly `updateBoard`'s contract for an omitted key,
      // so an edit that never touched the chair can no longer clear it.
      const chair = moderatorRosterId;
      const chairChanged = chair !== (editing?.moderatorRosterId ?? '');
      // Only send contextRefs when at least one context feature is available (avoid
      // clearing a selection the user couldn't see/edit because a toggle is off).
      const ctx = (strategyOn || projectsOn) ? { contextRefs } : {};
      if (editing) {
        await updateBoard(editing.boardId, {
          name: name.trim(), advisors: picked, visibility, personaKind,
          ...(chairChanged ? { moderatorRosterId: chair || null } : {}),
          ...livingAck, ...ctx,
        });
      } else {
        await createBoard({ orgId, name: name.trim(), advisors: picked, visibility, personaKind, ...(chair ? { moderatorRosterId: chair } : {}), ...livingAck, ...ctx });
      }
      // Reconcile shared knowledge (a separate per-board endpoint) for the edited
      // board — write only the kinds whose shared state actually changed. Skip when
      // the load errored (don't reconcile against a state we never saw).
      if (editing && Array.isArray(kbItems)) {
        const applied = new Map<SharedKbKind, boolean>();
        try {
          for (const it of kbItems) {
            const nowShared = pickedKbs.includes(it.kind);
            if (nowShared !== it.shared) { await setSharedKnowledge(editing.boardId, it.kind, nowShared); applied.set(it.kind, nowShared); }
          }
        } catch (kbErr) {
          // Persist partial progress so a retry diffs against reality, not stale state.
          setKbItems((prev) => (Array.isArray(prev) ? prev.map((it) => (applied.has(it.kind) ? { ...it, shared: applied.get(it.kind)! } : it)) : prev));
          throw kbErr;
        }
      }
      resetEmpty();
      await onDone();
    } catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  };

  if (roster.length === 0) {
    return (
      <div className="board-modal__body">
        {/* "Add agents to your roster first" is advice that costs the author a trip to
            another page to fix a roster that may already be full. Only say it when the
            roster was actually read. */}
        {rosterFailed
          ? <StateCard announce icon={<UserIcon size={20} />} title={t('common:loadFailedTitle')} body={t('common:loadFailedBody')} />
          : <StateCard icon={<UserIcon size={20} />} title={t('noAdvisorsTitle')} body={t('noAdvisorsBody')} />}
      </div>
    );
  }

  return (
    <form className="board-modal__form" onSubmit={(e) => void submit(e)}>
      <div className="board-modal__head">
        <h2 className="u-fs-16 u-m-0">{title}</h2>
      </div>
      <div className="board-modal__body">
      <div className="surface-form">
        <TextField label={t('boardNameLabel')} required value={name} onChange={(e) => setName(e.target.value)} placeholder={t('boardNamePlaceholder')} />
        <SelectField label={t('organizationLabel')} value={orgId} onChange={(e) => setOrgId(e.target.value)} disabled={!!editing}>
          {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
        {/* ADR 0665 D3 — the label said "Private (only me)", which the access rule does not
            deliver: an org `workspace:write` holder has authority over the board subject
            regardless of visibility (ADR 0054 D5, the same rule projects implement). The rule
            is unchanged; the help line states what `private` actually means, so the promise
            is true rather than reassuring. */}
        <SelectField label={t('visibilityLabel')} value={visibility} onChange={(e) => setVisibility(e.target.value as BoardVisibility)}>
          <option value="private">{t('visibilityPrivate')}</option>
          <option value="shared">{t('visibilityShared')}</option>
        </SelectField>
        {visibility === 'private' && <p className="muted u-fs-13 u-m-0">{t('visibilityPrivateHelp')}</p>}
        <SelectField label={t('personaKindLabel')} value={personaKind} onChange={(e) => setPersonaKind(e.target.value as PersonaKind)}>
          {PERSONA_KINDS.map((k) => <option key={k.value} value={k.value}>{t(k.labelKey)}</option>)}
        </SelectField>
        {/* ADV-UX-7 — the chair who writes the recommendation. Offered from the
            PICKED cohort, PLUS whoever is currently chairing even when they are
            outside it (M3): that shape is legal server-side — `assertCohortSeats`
            budgets a seat for "a chair who is not one of them" — so omitting the
            option made the picker MISREPRESENT the saved value as "No chair", and
            the save then destroyed it. Labelled, so the state is visible rather
            than merely preserved. */}
        <SelectField label={t('moderatorLabel')} help={t('moderatorHint')} value={moderatorRosterId} onChange={(e) => setModeratorRosterId(e.target.value)}>
          <option value="">{t('moderatorNone')}</option>
          {roster.filter((m) => picked.includes(m.rosterId) || m.rosterId === moderatorRosterId).map((m) => (
            <option key={m.rosterId} value={m.rosterId}>
              {picked.includes(m.rosterId) ? m.persona : t('moderatorOutOfCohort', { persona: m.persona })}
            </option>
          ))}
        </SelectField>
      </div>

      <div className="u-grid u-gap-2">
        <span className="u-fs-13 u-fw-600" id="advisor-picker-label">{t('advisorsLabel')}</span>
        <div className="u-flex u-gap-2 u-wrap" role="group" aria-labelledby="advisor-picker-label">
          {roster.map((m) => (
            <button key={m.rosterId} type="button" className={`chip ${picked.includes(m.rosterId) ? 'chip--accent' : 'chip--muted'}`} onClick={() => toggle(m.rosterId)} aria-pressed={picked.includes(m.rosterId)}>
              <UserIcon size={12} /> {m.persona}
            </button>
          ))}
        </div>
      </div>

      {/* ADV-G1 — a failed context read gets a note where the picker would have
          been. The save still OMITS `contextRefs` in this state, which is the
          existing guard and stays correct: refs the author cannot see must not
          be rewritten from an empty selection. */}
      {strategyFailed || projectsFailed ? (
        <Notice variant="warning" announce={t('contextLoadFailed')}>{t('contextLoadFailed')}</Notice>
      ) : null}

      {(strategyOn && strategies.length > 0) || (projectsOn && projects.length > 0) ? (
        <div className="u-grid u-gap-3">
          <div className="u-grid u-gap-1">
            <span className="u-fs-13 u-fw-600">{t('planningContextLabel')}</span>
            <span className="muted u-fs-12">{t('planningContextHint')}</span>
          </div>
          {strategyOn && strategies.length > 0 ? (
            <div className="u-grid u-gap-2">
              <span className="u-fs-12 u-fw-600 muted" id="strategy-picker-label">{t('strategyContextLabel')}</span>
              <div className="u-flex u-gap-2 u-wrap" role="group" aria-labelledby="strategy-picker-label">
                {strategies.map((s) => (
                  <button key={s.id} type="button" className={`chip ${pickedStrategies.includes(s.id) ? 'chip--accent' : 'chip--muted'}`} onClick={() => toggleStrategy(s.id)} aria-pressed={pickedStrategies.includes(s.id)}>
                    <FlagIcon size={12} /> {s.title}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {projectsOn && projects.length > 0 ? (
            <div className="u-grid u-gap-2">
              <span className="u-fs-12 u-fw-600 muted" id="project-picker-label">{t('projectContextLabel')}</span>
              <div className="u-flex u-gap-2 u-wrap" role="group" aria-labelledby="project-picker-label">
                {projects.map((p) => (
                  <button key={p.id} type="button" className={`chip ${pickedProjects.includes(p.id) ? 'chip--accent' : 'chip--muted'}`} onClick={() => toggleProject(p.id)} aria-pressed={pickedProjects.includes(p.id)}>
                    <FolderIcon size={12} /> {p.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {editing && kbItems === 'error' ? (
        <div className="u-grid u-gap-1">
          <span className="u-fs-13 u-fw-600" id="shared-knowledge-label">{t('sharedKnowledgeLabel')}</span>
          <Notice variant="error">{t('sharedKnowledgeLoadFailed')}</Notice>
        </div>
      ) : editing && Array.isArray(kbItems) && kbItems.length > 0 ? (
        <div className="u-grid u-gap-2">
          <div className="u-grid u-gap-1">
            <span className="u-fs-13 u-fw-600" id="shared-knowledge-label">{t('sharedKnowledgeLabel')}</span>
            <span className="muted u-fs-12">{t('sharedKnowledgeHint')}</span>
          </div>
          <div className="u-flex u-gap-2 u-wrap" role="group" aria-labelledby="shared-knowledge-label">
            {kbItems.map((it) => {
              const on = pickedKbs.includes(it.kind);
              const disabled = it.shareable === false && !on;
              return (
                <button
                  key={it.kind}
                  type="button"
                  // aria-disabled (not native `disabled`) keeps the chip focusable so a
                  // keyboard/SR user can reach it and hear the `title` reason; click is a no-op.
                  aria-disabled={disabled ? true : undefined}
                  className={`chip ${on ? 'chip--accent' : 'chip--muted'}`}
                  aria-pressed={on}
                  title={disabled
                    ? t('sharedKnowledgeEmptyTitle', { kind: t(`sharedKind_${it.kind}`) })
                    : t(on ? 'sharedKnowledgeOnTitle' : 'sharedKnowledgeOffTitle', { kind: t(`sharedKind_${it.kind}`) })}
                  onClick={() => { if (!disabled) toggleKb(it.kind); }}
                >
                  <BookOpenIcon size={12} aria-hidden /> {t(`sharedKind_${it.kind}`)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {personaKind === 'living' ? (
        <label className="advisory-ack u-flex u-gap-2 u-items-start">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>{t('livingPersonaAck')}</span>
        </label>
      ) : null}
      </div>

      <div className="board-modal__foot">
        <Button variant="secondary" onClick={() => { resetEmpty(); onCancel(); }} disabled={busy}>{t('common:cancel')}</Button>
        <Button variant="primary" type="submit" disabled={!canSubmit || busy}>
          {editing ? <><SaveIcon size={14} /> {t('saveChanges')}</> : <><PlusIcon size={14} /> {t('createBoard')}</>}
        </Button>
      </div>
    </form>
  );
}
