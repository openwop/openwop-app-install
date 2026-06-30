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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Modal } from '../../ui/Modal.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { ScaleIcon, UserIcon, PlusIcon, SaveIcon, TrashIcon, FlagIcon, FolderIcon } from '../../ui/icons/index.js';
// ADR 0079 Phase 5 — strategy context picker (one-directional FE import).
import { listStrategies as listStrategiesForContext, FeatureDisabledError } from '../strategy/strategyClient.js';
import { listProjects as listProjectsForContext } from '../projects/projectsClient.js';
import {
  listBoards, createBoard, updateBoard, deleteBoard, listRoster, listOrgs,
  type AdvisoryBoard, type RosterMember, type OrgRef, type PersonaKind, type BoardVisibility,
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
  const [boards, setBoards] = useState<AdvisoryBoard[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdvisoryBoard | null>(null);
  const [deleting, setDeleting] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [b, r, o] = await Promise.all([listBoards(), listRoster(), listOrgs()]);
      setBoards(b); setRoster(r); setOrgs(o);
    } catch (e) { setError((e as Error).message); }
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
    try {
      await deleteBoard(board.boardId);
      setConfirmDelete(null);
      setDialog((d) => (d && d.mode !== 'create' && d.board.boardId === board.boardId ? null : d));
      await reload();
    } catch (e) { setError((e as Error).message); }
    finally { setDeleting(false); }
  };

  return (
    <div className="u-grid u-gap-4">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
        actions={
          <button type="button" className="primary" onClick={() => setDialog({ mode: 'create' })}>
            <PlusIcon size={14} /> {t('newBoard')}
          </button>
        }
      />

      {error ? <Notice variant="error">{error}</Notice> : null}

      <BoardList
        boards={boards}
        onCreate={() => setDialog({ mode: 'create' })}
        onEdit={(b) => setDialog({ mode: 'edit', board: b })}
        onClone={(b) => setDialog({ mode: 'clone', board: b })}
        onDeleteRequest={(b) => setConfirmDelete(b)}
      />

      {dialog ? (
        <Modal label={dialogTitle} className="surface-card board-modal" onClose={() => setDialog(null)}>
          <BoardForm
            title={dialogTitle}
            roster={roster}
            orgs={orgs}
            seed={seed}
            onDone={async () => { setDialog(null); await reload(); }}
            onCancel={() => setDialog(null)}
            onError={setError}
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
          onConfirm={() => void handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}
    </div>
  );
}

function BoardList({ boards, onCreate, onEdit, onClone, onDeleteRequest }: {
  boards: AdvisoryBoard[];
  onCreate: () => void;
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

  if (boards.length === 0) {
    return (
      <StateCard
        icon={<ScaleIcon size={20} />}
        title={t('boardsEmptyTitle')}
        body={t('boardsEmptyBody')}
        action={
          <button type="button" className="primary" onClick={onCreate}>
            <PlusIcon size={14} /> {t('newBoard')}
          </button>
        }
      />
    );
  }

  const actions: BoardActions = { onEdit, onClone, onDeleteRequest };

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
          action={<button type="button" className="secondary" onClick={() => setQuery('')}>{t('clearSearch')}</button>}
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

function BoardForm({ title, roster, orgs, seed, onDone, onCancel, onError }: {
  title: string;
  roster: RosterMember[];
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
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  // ADR 0079 Phase 5 — strategy context. `strategyOn=false` ⇒ feature off ⇒ no picker.
  const [strategies, setStrategies] = useState<{ id: string; title: string }[]>([]);
  const [strategyOn, setStrategyOn] = useState(false);
  const [pickedStrategies, setPickedStrategies] = useState<string[]>([]);
  // ADR 0100 — project context (the project counterpart of strategy context).
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectsOn, setProjectsOn] = useState(false);
  const [pickedProjects, setPickedProjects] = useState<string[]>([]);

  useEffect(() => {
    void listStrategiesForContext()
      .then((rows) => { setStrategies(rows.filter((s) => s.status !== 'archived').map((s) => ({ id: s.id, title: s.title }))); setStrategyOn(true); })
      .catch((e) => { if (!(e instanceof FeatureDisabledError)) { /* transient */ } setStrategyOn(false); });
    void listProjectsForContext()
      .then((rows) => { setProjects(rows.map((p) => ({ id: p.id, name: p.name }))); setProjectsOn(true); })
      .catch(() => setProjectsOn(false));
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
    setAck(b.livingPersonaAck ?? false);
  }, [seed, t]);

  // Default org for a fresh create (never override a seeded board's org).
  useEffect(() => { if (!orgId && !seed && orgs[0]) setOrgId(orgs[0].orgId); }, [orgs, orgId, seed]);

  const toggle = (id: string): void => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleStrategy = (id: string): void => setPickedStrategies((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleProject = (id: string): void => setPickedProjects((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const contextRefs = useMemo(() => [
    ...pickedStrategies.map((strategyId) => ({ kind: 'strategy' as const, strategyId })),
    ...pickedProjects.map((projectId) => ({ kind: 'project' as const, projectId })),
  ], [pickedStrategies, pickedProjects]);
  const canSubmit = useMemo(() => name.trim().length > 0 && orgId && picked.length > 0 && (personaKind !== 'living' || ack), [name, orgId, picked, personaKind, ack]);

  const resetEmpty = (): void => { setName(''); setPicked([]); setPickedStrategies([]); setPickedProjects([]); setAck(false); setVisibility('private'); setPersonaKind('historical'); };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const livingAck = personaKind === 'living' ? { livingPersonaAck: ack } : {};
      // Only send contextRefs when at least one context feature is available (avoid
      // clearing a selection the user couldn't see/edit because a toggle is off).
      const ctx = (strategyOn || projectsOn) ? { contextRefs } : {};
      if (editing) {
        await updateBoard(editing.boardId, { name: name.trim(), advisors: picked, visibility, personaKind, ...livingAck, ...ctx });
      } else {
        await createBoard({ orgId, name: name.trim(), advisors: picked, visibility, personaKind, ...livingAck, ...ctx });
      }
      resetEmpty();
      await onDone();
    } catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  };

  if (roster.length === 0) {
    return (
      <div className="board-modal__body">
        <StateCard icon={<UserIcon size={20} />} title={t('noAdvisorsTitle')} body={t('noAdvisorsBody')} />
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
        <SelectField label={t('visibilityLabel')} value={visibility} onChange={(e) => setVisibility(e.target.value as BoardVisibility)}>
          <option value="private">{t('visibilityPrivate')}</option>
          <option value="shared">{t('visibilityShared')}</option>
        </SelectField>
        <SelectField label={t('personaKindLabel')} value={personaKind} onChange={(e) => setPersonaKind(e.target.value as PersonaKind)}>
          {PERSONA_KINDS.map((k) => <option key={k.value} value={k.value}>{t(k.labelKey)}</option>)}
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

      {personaKind === 'living' ? (
        <label className="advisory-ack u-flex u-gap-2 u-items-start">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>{t('livingPersonaAck')}</span>
        </label>
      ) : null}
      </div>

      <div className="board-modal__foot">
        <button type="button" className="secondary" onClick={() => { resetEmpty(); onCancel(); }} disabled={busy}>{t('common:cancel')}</button>
        <button type="submit" className="primary" disabled={!canSubmit || busy}>
          {editing ? <><SaveIcon size={14} /> {t('saveChanges')}</> : <><PlusIcon size={14} /> {t('createBoard')}</>}
        </button>
      </div>
    </form>
  );
}
