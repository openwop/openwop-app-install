/**
 * Priority-list detail page (ADR 0058 — see the routing correction note) —
 * `/priority-matrix/:listId`. Every list has its own URL (deep-linkable,
 * shareable, back/forward-friendly), replacing the old in-page
 * Portfolio/<list…> tablist: the page leads with a PageHeader (list name) +
 * a "Back to portfolio" ghost link — the same shape as
 * `/strategy/:strategyId` and `/projects/:projectId`.
 *
 * The detail body (scoring table / matrix / grid, agenda, scenarios,
 * intake, criteria modal) is the former `ListDetail` moved here verbatim;
 * only the header card changed (the routed PageHeader now owns the title).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import i18n from '../../i18n/index.js';
import { formatNumber, formatDate } from '../../i18n/format.js';
import { Button } from '../../ui/Button.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { confirm } from '../../ui/confirm.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Markdown } from '../../ui/Markdown.js';
import { Field, TextField, TextareaField, SelectField } from '../../ui/Field.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { Modal } from '../../ui/Modal.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { Menu, type MenuEntry } from '../../ui/Menu.js';
import { ListOrderedIcon, PlusIcon, TrashIcon, ScaleIcon, CheckIcon, AlertIcon, ClipboardIcon, FlagIcon, ClockIcon, BoxesIcon, LayoutGridIcon, MoreHorizontalIcon, PencilIcon, CopyIcon, SaveIcon } from '../../ui/icons/index.js';
import { PriorityQuadrant } from './PriorityQuadrant.js';
import { matrixSupported } from './quadrant.js';
import { listMembers, type OrgMember } from '../../client/accessClient.js';
// ADR 0079 Phase 3 — strategy alignment is composed from the strategy feature
// (one-directional import; the strategy package never imports priority-matrix).
import { StrategyAlignment, type StrategyRefLite } from '../strategy/StrategyAlignment.js';
import { IdeaIntakePanel } from './IdeaIntakePanel.js';
import { ScenarioPanel } from './ScenarioPanel.js';
import { getStrategyContext, FeatureDisabledError } from '../strategy/strategyClient.js';
import { useUnsavedChangesWarning, useConfirmDiscardUnsaved } from '../../ui/useUnsavedChangesWarning.js';
import {
  listLists, updateList, deleteList, PriorityMatrixApiError,
  listIdeas, submitIdea, updateIdea, deleteIdea, cloneIdea, moveIdeaStatus, setIdeaScores, getVoteBreakdown,
  listSessions, createSession, updateSession,
  getScheduleStatus, setIdeaSchedule, clearIdeaSchedule,
  type PriorityList, type RankedIdea, type CriteriaSet, type PlanningSession,
  type VotingMode, type VoteBreakdownEntry, type AgendaSort,
  type IdeaScheduleStatus, type ScheduleRollup, type ScheduleState,
} from './priorityMatrixClient.js';
import { MODEL_LABEL_KEY } from './pmShared.js';

// The three idea views — Matrix (the 2×2 namesake), Grid (read cards), List
// (the power scoring table). A 3-way specialization of the §4.5 collection-view
// canon: Matrix is unique to this page, so it owns a bespoke `.segmented`
// control + persistence rather than the 2-value shared <ViewToggle>, reusing
// the same `openwop:view:<surface>` localStorage key scheme.
type IdeaView = 'matrix' | 'grid' | 'list';
const IDEA_VIEW_KEY = 'openwop:view:priority-matrix';
function readIdeaView(): IdeaView | null {
  try {
    const s = localStorage.getItem(IDEA_VIEW_KEY);
    return s === 'matrix' || s === 'grid' || s === 'list' ? s : null;
  } catch { return null; }
}

// Status column ids (board statuses) → label key in the `priority-matrix` namespace.
const STATUS_IDS = ['new', 'under-review', 'in-process', 'blocked', 'deferred', 'wont-do', 'done'] as const;
const STATUS_LABEL_KEY = {
  'new': 'statusNew',
  'under-review': 'statusUnderReview',
  'in-process': 'statusInProcess',
  'blocked': 'statusBlocked',
  'deferred': 'statusDeferred',
  'wont-do': 'statusWontDo',
  'done': 'statusDone',
} as const;
const AGENDA_SORT_LABEL_KEY: Record<AgendaSort, string> = {
  priority: 'agendaSortPriority',
  created: 'agendaSortCreated',
  owner: 'agendaSortOwner',
  status: 'agendaSortStatus',
  title: 'agendaSortTitle',
};
// Maps an agenda order onto the preview DataTable's column + direction.
const AGENDA_SORT_COL: Record<AgendaSort, { key: string; dir: 'asc' | 'desc' }> = {
  priority: { key: 'priority', dir: 'desc' },
  created: { key: 'created', dir: 'asc' },
  owner: { key: 'owner', dir: 'asc' },
  status: { key: 'status', dir: 'asc' },
  title: { key: 'idea', dir: 'asc' },
};

// Schedule state (ADR 0103) → chip class + label key. Every chip carries TEXT (not
// color alone) for accessibility; the class set is the shared ui/ chip palette.
const SCHEDULE_CHIP_CLASS: Record<ScheduleState, string> = {
  'on-track': 'chip--success',
  'at-risk': 'chip--warning',
  'behind': 'chip--danger',
  'done-early': 'chip--success',
  'done-late': 'chip--warning',
  'unscheduled': 'chip--muted',
};
const SCHEDULE_LABEL_KEY: Record<ScheduleState, string> = {
  'on-track': 'scheduleOnTrack',
  'at-risk': 'scheduleAtRisk',
  'behind': 'scheduleBehind',
  'done-early': 'scheduleDoneEarly',
  'done-late': 'scheduleDoneLate',
  'unscheduled': 'scheduleUnscheduled',
};

const fmtDate = (iso?: string): string => {
  if (!iso) return i18n.t('priority-matrix:emDash');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return formatDate(`${m[1]}-${m[2]}-${m[3]}T00:00:00`, { month: 'short', day: 'numeric' });
};

/**
 * ADR 0667 D1c — the priority cell, shared by the list column and the agenda panel
 * (they live in different components, so this is module-level rather than a closure).
 *
 * It renders THREE states where the app previously rendered two, because
 * `computedPriority === 0` is an overloaded sentinel: in ratio mode a WSJF idea
 * scored 10/10/10 with a blank job-size returns exactly 0, the same as a
 * never-touched idea. `completeness` is what tells them apart.
 *
 * The number is kept for a partially-scored idea rather than suppressed: suppressing
 * it would destroy a useful provisional signal AND re-create the very
 * one-label-for-two-states defect this fix exists to remove.
 */
function PriorityCell(props: { idea: RankedIdea }): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const c = props.idea.completeness;
  if (c && c.scored === 0) return <span className="muted u-fs-12">{t('priorityUnscored')}</span>;
  return (
    <span className="u-flex u-items-center u-gap-2 u-justify-end">
      <strong>{formatNumber(props.idea.computedPriority)}</strong>
      {c && !c.complete
        ? <span className="muted u-fs-12">{t('priorityPartial', { scored: c.scored, declared: c.declared })}</span>
        : null}
    </span>
  );
}

export function PriorityListPage(): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const { listId = '' } = useParams<{ listId: string }>();
  const navigate = useNavigate();
  const [lists, setLists] = useState<PriorityList[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Reads FAILED — distinct from `null` (loading) and `[]` (genuinely none).
   *  #2596: the resolution depends on what the EMPTY state says, and both of
   *  this page's are instructions ("Create one to start", "Add an idea"). */
  const [listsFailed, setListsFailed] = useState(false);

  const refreshLists = useCallback(async () => {
    try { setListsFailed(false); setLists(await listLists()); }
    catch (e) {
      setError(e instanceof Error ? e.message : t('loadListsFailed'));
      setListsFailed(true);
    }
  }, [t]);
  useEffect(() => { void refreshLists(); }, [refreshLists]);

  const list = useMemo(() => lists?.find((l) => l.id === listId) ?? null, [lists, listId]);
  const backLink = <Link to="/priority-matrix" className="btn-ghost">{t('backToPortfolio')}</Link>;

  if (lists === null && listsFailed) {
    // Ordered ABOVE the loading return: a failed-state branch below it never runs.
    return (
      <div>
        <PageHeader eyebrow={t('priorityListEyebrow')} title={t('listsLoadFailedTitle')} />
        <StateCard announce icon={<ListOrderedIcon size={20} />} title={t('listsLoadFailedTitle')} body={t('listsLoadFailedBody')} />
      </div>
    );
  }
  if (lists === null) {
    return (
      <div>
        <PageHeader eyebrow={t('priorityListEyebrow')} title={t('loadingList')} />
        <StateCard icon={<ListOrderedIcon size={20} />} title={t('loadingList')} loading />
      </div>
    );
  }
  if (!list) {
    return (
      <div>
        <PageHeader eyebrow={t('priorityListEyebrow')} title={t('listNotFoundTitle')} actions={backLink} />
        {error ? <Notice variant="error">{error}</Notice> : null}
        <StateCard icon={<ListOrderedIcon size={22} />} title={t('listNotFoundTitle')} body={t('listNotFoundBody')} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader eyebrow={t('priorityListEyebrow')} title={list.name} actions={backLink} />
      {error ? <Notice variant="error">{error}</Notice> : null}
      <ListDetail
        key={list.id}
        list={list}
        onChanged={refreshLists}
        onDeleted={async () => { navigate('/priority-matrix'); }}
        onError={setError}
      />
    </div>
  );
}

// ─── list detail ─────────────────────────────────────────────────────────────

function ListDetail(props: {
  list: PriorityList;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
  onError: (m: string) => void;
}): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  // PMX-7 (ADR 0590) — destructure the STABLE callbacks: `props` object identity
  // changes on every parent render, and with `props` in the useCallback deps
  // every keystroke in the page minted a new loader + refired its effect (a
  // real network read per keystroke against the 60 req/min per-IP budget).
  const { list, onError } = props;
  const [ideas, setIdeas] = useState<RankedIdea[] | null>(null);
  const [ideasFailed, setIdeasFailed] = useState(false);
  const [sessions, setSessions] = useState<PlanningSession[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  /** PMX-8c — the members read FAILED: owner names are UNKNOWABLE, not "Unknown". */
  const [membersFailed, setMembersFailed] = useState(false);
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({});
  const [scoreError, setScoreError] = useState<Record<string, boolean>>({});
  const [selection, setSelection] = useState<Set<string>>(new Set());
  // Matrix is the default when the list's criteria support it (a benefit AND a
  // cost axis); otherwise List. Grid is the read/scan companion. The user's
  // explicit choice persists globally; matrix downgrades to list for any list
  // that lacks an effort axis, without overwriting that choice.
  const canMatrix = useMemo(() => matrixSupported(list.criteriaSet), [list.criteriaSet]);
  const [ideaViewRaw, setIdeaViewRaw] = useState<IdeaView>(() => readIdeaView() ?? (matrixSupported(list.criteriaSet) ? 'matrix' : 'list'));
  const setIdeaView = useCallback((v: IdeaView) => {
    setIdeaViewRaw(v);
    try { localStorage.setItem(IDEA_VIEW_KEY, v); } catch { /* storage unavailable */ }
  }, []);
  const ideaView: IdeaView = ideaViewRaw === 'matrix' && !canMatrix ? 'list' : ideaViewRaw;
  // PMX-8b (ADR 0590) — 'forbidden' (a REAL 403) is discriminated from 'error'
  // (network/500): only the former may render the owner/admin-only explanation.
  const [breakdown, setBreakdown] = useState<{ idea: RankedIdea; entries: VoteBreakdownEntry[] | 'loading' | 'error' | 'forbidden' } | null>(null);
  // ADR 0232 — the intake & evidence panel target.
  const [intakeFor, setIntakeFor] = useState<RankedIdea | null>(null);
  // ADR 0259 — the idea being edited in the title/description modal.
  const [editIdeaFor, setEditIdeaFor] = useState<RankedIdea | null>(null);
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The current meeting agenda: the ideas in it + the persisted doc. `agendaSort`
  // orders BOTH the saved doc (server) and the live preview; `agendaSource` lets a
  // re-order rebuild the same selection in the new order.
  const [agenda, setAgenda] = useState<{ ideas: RankedIdea[]; markdown: string; name: string } | null>(null);
  const [agendaSort, setAgendaSort] = useState<AgendaSort>('priority');
  const [agendaSessionId, setAgendaSessionId] = useState<string | null>(null);
  // ADR 0079 Phase 3 — strategy chips per idea. Fetched ONCE per list from the
  // strategy context endpoint (RBAC already omits unreadable strategies), mapped
  // cardId → aligned strategies. `strategyOn=false` when the toggle is off ⇒ the
  // chips/align control are hidden and priority-matrix is unaffected.
  const [strategyRefs, setStrategyRefs] = useState<Map<string, StrategyRefLite[]>>(new Map());
  const [strategyOn, setStrategyOn] = useState(true);
  const strategySeq = useRef(0);
  const refreshStrategy = useCallback(async () => {
    const seq = ++strategySeq.current; // PMX-9 — stale-response guard
    try {
      const entries = await getStrategyContext({ priorityListId: list.id });
      if (seq !== strategySeq.current) return;
      const map = new Map<string, StrategyRefLite[]>();
      for (const e of entries) {
        for (const lp of e.linkedPriorities) {
          if (!lp.cardId) continue;
          const arr = map.get(lp.cardId) ?? [];
          arr.push({ id: e.id, title: e.title });
          map.set(lp.cardId, arr);
        }
      }
      setStrategyRefs(map);
      setStrategyOn(true);
    } catch (e) {
      if (seq !== strategySeq.current) return;
      if (e instanceof FeatureDisabledError) { setStrategyOn(false); return; }
      // a transient strategy-context failure must not break the priority table
      setStrategyRefs(new Map());
    }
  }, [list.id]);
  useEffect(() => { void refreshStrategy(); }, [refreshStrategy]);

  // O(1) owner lookup (the table calls this inside `sortValue`, per comparison).
  const memberById = useMemo(() => new Map(members.map((m) => [m.subject, m.displayName])), [members]);
  const ownerName = useCallback((idea: RankedIdea): string => {
    const id = idea.card.assigneeId ?? idea.card.createdBy;
    if (!id) return t('emDash');
    // PMX-8c (ADR 0590) — a FAILED members read must not render every owner as
    // "Unknown" (a claim about the member); the name is unknowable: em-dash +
    // the membersUnavailable notice in the list meta row.
    if (membersFailed) return t('emDash');
    return memberById.get(id) ?? t('unknown');
  }, [memberById, membersFailed, t]);

  // PMX-9 (ADR 0590) — sequence token: an older in-flight read resolving LAST
  // must not clobber a newer one (the IdeaIntakePanel pattern, applied to the
  // six loaders this page owns).
  const refreshSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      setIdeasFailed(false);
      const nextIdeas = await listIdeas(list.id);
      const nextSessions = await listSessions(list.id);
      if (seq !== refreshSeq.current) return;
      setIdeas(nextIdeas);
      setSessions(nextSessions);
    } catch (e) {
      if (seq !== refreshSeq.current) return;
      onError(e instanceof Error ? e.message : t('loadIdeasFailed'));
      setIdeasFailed(true);
    }
  }, [list.id, onError, t]);

  // ADR 0103 — schedule status, fetched ONCE per list (cardId → status + rollup).
  // A transient failure must not break the ideas table (mirrors the strategy fetch).
  // PMXU-4 / PMX-8a (ADR 0590) — TRI-STATE: `null` = loading, `'failed'` = the
  // read failed (schedule UNKNOWABLE — never rendered as "No date", which is a
  // positive factual claim manufactured from a failed read), object = loaded.
  const [schedule, setSchedule] = useState<{ byCard: Map<string, IdeaScheduleStatus>; rollup: ScheduleRollup } | null | 'failed'>(null);
  const scheduleSeq = useRef(0);
  const refreshSchedule = useCallback(async () => {
    const seq = ++scheduleSeq.current;
    try {
      const s = await getScheduleStatus(list.id);
      if (seq !== scheduleSeq.current) return;
      setSchedule({ byCard: new Map(s.ideas.map((x) => [x.cardId, x])), rollup: s.rollup });
    } catch { if (seq === scheduleSeq.current) setSchedule('failed'); }
  }, [list.id]);
  const scheduleLoaded = schedule !== null && schedule !== 'failed' ? schedule : null;

  const membersSeq = useRef(0);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void refreshSchedule(); }, [refreshSchedule]);
  useEffect(() => {
    // PMX-9 + PMX-8c — guarded, and a FAILED read is a fact the page states
    // (owners render as an em-dash, with a notice), not "Unknown" per member.
    const seq = ++membersSeq.current;
    void listMembers(list.orgId)
      .then((m) => { if (seq === membersSeq.current) { setMembers(m); setMembersFailed(false); } })
      .catch(() => { if (seq === membersSeq.current) { setMembers([]); setMembersFailed(true); } });
  }, [list.orgId]);

  useEffect(() => {
    if (!ideas) return;
    setDraft(Object.fromEntries(ideas.map((i) => {
      const own = i.myScores ?? i.scores;
      return [i.card.id, Object.fromEntries(list.criteriaSet.criteria.map((c) => [c.id, own[c.id] != null ? String(own[c.id]) : '']))];
    })));
    // R2 review — the draft is rebuilt from the server here, so any value that was
    // flagged invalid is gone from the input. Clearing the flags with it stops an empty
    // field being left permanently `aria-invalid` with no message attached to it.
    setScoreError({});
  }, [ideas, list.criteriaSet.criteria]);

  const openBreakdown = async (idea: RankedIdea): Promise<void> => {
    setBreakdown({ idea, entries: 'loading' });
    try { setBreakdown({ idea, entries: await getVoteBreakdown(list.id, idea.card.id) }); }
    catch (e) {
      // PMX-8b — a network 500 must not claim the USER lacks authority; the
      // client embeds the status, so a real 403 is distinguishable.
      setBreakdown({ idea, entries: e instanceof PriorityMatrixApiError && e.status === 403 ? 'forbidden' : 'error' });
    }
  };

  // ADR 0059 weighted voters — set one voter's weight list-wide (config-authority;
  // the breakdown itself is owner/admin-only, and the PATCH re-checks server-side).
  const setVoterWeight = async (voterId: string, weight: number): Promise<void> => {
    try {
      const next = { ...(list.voterWeights ?? {}) };
      if (weight === 1) delete next[voterId]; else next[voterId] = weight;
      await updateList(list.id, { voterWeights: next });
      await props.onChanged();
      await refresh();
    } catch (e) { props.onError(e instanceof Error ? e.message : t('setVoterWeightFailed')); }
  };

  const onSubmitIdea = async (title: string, description: string): Promise<void> => {
    try { await submitIdea(list.id, { title, ...(description ? { description } : {}) }); await refresh(); }
    catch (e) { props.onError(e instanceof Error ? e.message : t('submitIdeaFailed')); }
  };

  // ADR 0259 — per-idea edit / clone / delete.
  const onEditIdea = async (title: string, description: string): Promise<void> => {
    if (!editIdeaFor) return;
    // Let failures propagate to EditIdeaModal so it shows the error INSIDE the modal
    // (keeping the field values) rather than a page-level Notice hidden behind the overlay.
    await updateIdea(list.id, editIdeaFor.card.id, { title, description });
    setEditIdeaFor(null);
    await refresh();
  };
  const onCloneIdea = async (idea: RankedIdea): Promise<void> => {
    try { await cloneIdea(list.id, idea.card.id, { title: t('cloneIdeaSuffix', { title: idea.card.title }) }); await refresh(); }
    catch (e) { props.onError(e instanceof Error ? e.message : t('cloneIdeaFailed')); }
  };
  const onDeleteIdea = async (idea: RankedIdea): Promise<void> => {
    if (!(await confirm({ title: t('deleteIdeaConfirmTitle', { title: idea.card.title }), body: t('deleteIdeaConfirmBody'), confirmLabel: t('common:delete'), danger: true }))) return;
    try { await deleteIdea(list.id, idea.card.id); await refresh(); }
    catch (e) { props.onError(e instanceof Error ? e.message : t('deleteIdeaFailed')); }
  };
  const ideaActionItems = (r: RankedIdea): MenuEntry[] => [
    { id: 'edit', label: <><PencilIcon size={13} /> {t('editIdea')}</>, onSelect: () => setEditIdeaFor(r) },
    { id: 'clone', label: <><CopyIcon size={13} /> {t('cloneIdea')}</>, onSelect: () => void onCloneIdea(r) },
    { id: 'sep', separator: true },
    { id: 'delete', label: <><TrashIcon size={13} /> {t('deleteIdea')}</>, onSelect: () => void onDeleteIdea(r) },
  ];

  /**
   * R2 PM2-M4 — `value: null` means CLEAR this criterion. The blur handler used to do
   * `const v = Number(e.target.value); if (v >= 1 && v <= 10) …`, and `Number('')` is 0 —
   * so clearing a score fired nothing, said nothing, and left the old value on the server.
   * The next refresh rebuilt the draft from that server value and the number the reviewer
   * thought they had removed reappeared. Typing `0` or `11` behaved identically.
   */
  const onScore = async (idea: RankedIdea, criterionId: string, value: number | null): Promise<void> => {
    try {
      const current = draft[idea.card.id] ?? {};
      const next: Record<string, number> = {};
      for (const c of list.criteriaSet.criteria) {
        if (c.id === criterionId) {
          if (value !== null) next[c.id] = value;         // omitted ⇒ removed server-side
          continue;
        }
        // R2 review — REBUILDING from `draft` and omitting anything invalid is a
        // server-side DELETE of that criterion, because `setIdeaScore` replaces the map.
        // So after the new "keep what they typed and say so" branch left an invalid `30`
        // sitting in the draft, the NEXT edit to a different criterion silently deleted
        // job-size — and with the ratio fix, dropped the idea to 0 and last place, with
        // nothing said about a second criterion. An invalid draft must fall back to the
        // value the SERVER still holds, never to omission.
        const raw = Number(current[c.id]);
        if (Number.isFinite(raw) && raw >= 1 && raw <= 10) { next[c.id] = raw; continue; }
        const saved = (idea.myScores ?? idea.scores)?.[c.id];
        if (typeof saved === 'number' && saved >= 1 && saved <= 10) next[c.id] = saved;
      }
      await setIdeaScores(list.id, idea.card.id, next);
      await refresh();
    } catch (e) { props.onError(e instanceof Error ? e.message : t('saveScoreFailed')); }
  };

  const onMove = async (idea: RankedIdea, columnId: string): Promise<void> => {
    // A status move can flip schedule state (terminal/blocked) — refresh both.
    try { await moveIdeaStatus(list.id, idea.card.id, columnId); await refresh(); await refreshSchedule(); }
    catch (e) { props.onError(e instanceof Error ? e.message : t('changeStatusFailed')); }
  };

  const doDelete = async (): Promise<void> => {
    setDeleting(true);
    try { await deleteList(list.id); await props.onDeleted(); }
    catch (e) { props.onError(e instanceof Error ? e.message : t('deleteListFailed')); setDeleting(false); }
  };

  // Build a NEW agenda session. The server orders the SAVED doc by `sort`; the live
  // preview mirrors it via `initialSort`.
  const buildAgenda = async (source: { kind: 'manual'; ideas: RankedIdea[] } | { kind: 'topn'; n: number }, sort: AgendaSort): Promise<void> => {
    try {
      const s = source.kind === 'manual'
        ? await createSession(list.id, { mode: 'manual', cardIds: source.ideas.map((r) => r.card.id), sort })
        : await createSession(list.id, { mode: 'top-n', n: source.n, sort });
      const picked = source.kind === 'manual' ? source.ideas : [...(ideas ?? [])].sort((a, b) => a.rank - b.rank).slice(0, source.n);
      setAgenda({ ideas: picked, markdown: s.agendaMarkdown, name: s.name });
      setAgendaSessionId(s.id);
      setAgendaSort(sort);
      await refresh();
    } catch (e) { props.onError(e instanceof Error ? e.message : t('buildAgendaFailed')); }
  };

  // The user's ask: select ideas in the full list → "Add to meeting agenda".
  const addToAgenda = async (rows: RankedIdea[]): Promise<void> => {
    if (rows.length === 0) return;
    setSelection(new Set());
    await buildAgenda({ kind: 'manual', ideas: rows }, agendaSort);
  };
  const buildTopN = (n: number): Promise<void> => buildAgenda({ kind: 'topn', n }, agendaSort);
  // The "Order by" control — re-order the CURRENT session IN PLACE (PATCH), so the
  // saved doc tracks the order without spawning a duplicate session per reorder.
  const reorderAgenda = async (sort: AgendaSort): Promise<void> => {
    if (!agenda || !agendaSessionId) { setAgendaSort(sort); return; }
    try {
      const s = await updateSession(list.id, agendaSessionId, { sort });
      setAgenda({ ideas: agenda.ideas, markdown: s.agendaMarkdown, name: s.name });
      setAgendaSort(sort);
      await refresh();
    } catch (e) { props.onError(e instanceof Error ? e.message : t('reorderAgendaFailed')); }
  };

  // PMXU-1 (ADR 0590) — AI-written ideas carry a provenance chip (the
  // `scenarioProposed` chip pattern). Absent `source` = pre-stamp row: no chip,
  // no claim either way.
  const ideaSourceChip = (r: RankedIdea): JSX.Element | null =>
    r.card.source === 'agent' ? <span className="chip chip--warning u-fs-11">{t('ideaSourceAgent')}</span>
      : r.card.source === 'workflow' ? <span className="chip chip--warning u-fs-11">{t('ideaSourceWorkflow')}</span>
        : null;

  const ideaColumns: DataColumn<RankedIdea>[] = [
    { key: 'rank', header: t('colRank'), width: '44px', align: 'right', render: (r) => formatNumber(r.rank), sortValue: (r) => r.rank },
    { key: 'idea', header: t('colIdea'), render: (r) => <span className="u-flex u-items-center u-gap-2 u-wrap"><strong>{r.card.title}</strong>{ideaSourceChip(r)}</span>, sortValue: (r) => r.card.title },
    ...(strategyOn ? [{
      key: 'strategy', header: t('colStrategy'),
      render: (r: RankedIdea) => (
        <StrategyAlignment
          listId={list.id}
          cardId={r.card.id}
          refs={strategyRefs.get(r.card.id) ?? []}
          onChanged={refreshStrategy}
          onError={props.onError}
        />
      ),
    } as DataColumn<RankedIdea>] : []),
    ...list.criteriaSet.criteria.map((c): DataColumn<RankedIdea> => ({
      key: `crit-${c.id}`,
      header: c.name,
      ...(c.scaleHint ? { headerTitle: c.scaleHint } : {}),
      render: (r) => (
        <input
          type="number" min={1} max={10}
          value={draft[r.card.id]?.[c.id] ?? ''}
          aria-label={t('scoreInputLabel', { title: r.card.title, criterion: c.name })}
          className="u-w-auto"
          onChange={(e) => setDraft((d) => ({ ...d, [r.card.id]: { ...(d[r.card.id] ?? {}), [c.id]: e.target.value } }))}
          aria-invalid={scoreError[`${r.card.id}:${c.id}`] ? true : undefined}
          onBlur={(e) => {
            const key = `${r.card.id}:${c.id}`;
            const raw = e.target.value.trim();
            if (raw === '') { setScoreError((m) => ({ ...m, [key]: false })); void onScore(r, c.id, null); return; }
            const v = Number(raw);
            if (Number.isFinite(v) && v >= 1 && v <= 10) { setScoreError((m) => ({ ...m, [key]: false })); void onScore(r, c.id, v); return; }
            // Out of range: keep what they typed and SAY so, rather than swallowing the
            // blur and letting the next refresh quietly restore the old number.
            setScoreError((m) => ({ ...m, [key]: true }));
            props.onError(t('scoreOutOfRange', { criterion: c.name }));
          }}
        />
      ),
    })),
    // R3 — this column showed "0", which read as "scored worst".
    //
    // CORRECTED (ADR 0667 D1c): the note here used to say "a scored idea can never
    // produce exactly 0". That is FALSE and was falsified by measurement — in ratio
    // mode a WSJF idea scored 10/10/10 with a blank job-size returns exactly 0, the
    // same value a never-touched idea returns, because `PM2-B1`'s cost guard added a
    // second way to reach the sentinel. `completeness` now carries the distinction, so
    // a partially-scored idea says "3 of 4 scored" instead of claiming to be unscored.
    { key: 'priority', header: list.votingMode === 'multi-voter' ? t('colPriorityAgg') : t('colPriority'), align: 'right', render: (r) => <PriorityCell idea={r} />, sortValue: (r) => r.computedPriority },
    { key: 'owner', header: t('colOwner'), render: (r) => <span className="muted u-fs-12">{ownerName(r)}</span>, sortValue: (r) => ownerName(r) },
    { key: 'created', header: t('colCreated'), align: 'right', render: (r) => <span className="muted u-fs-12">{fmtDate(r.card.createdAt)}</span>, sortValue: (r) => r.card.createdAt ?? '' },
    {
      key: 'schedule', header: t('colSchedule'),
      // PMXU-4 / PMX-8a — a FAILED schedule read states the failure, never the
      // "No date" claim (which pre-fix painted `unscheduled` across rows that
      // HAVE target dates).
      render: (r) => (schedule === 'failed'
        ? <span className="muted u-fs-12">{t('scheduleUnavailable')}</span>
        : <ScheduleCell listId={list.id} idea={r} status={scheduleLoaded?.byCard.get(r.card.id)} onChanged={refreshSchedule} onError={onError} />),
      sortValue: (r) => scheduleLoaded?.byCard.get(r.card.id)?.targetDate ?? '',
    },
    ...(list.votingMode === 'multi-voter' ? [{
      key: 'votes', header: t('colVotes'), align: 'right' as const,
      render: (r: RankedIdea) => (
        <Button variant="quiet" size="sm" onClick={() => void openBreakdown(r)} aria-label={t('voteBreakdownButtonLabel', { title: r.card.title })}>{formatNumber(r.voterCount ?? 0)}</Button>
      ),
    } as DataColumn<RankedIdea>] : []),
    {
      key: 'status', header: t('colStatus'),
      render: (r) => (
        <select aria-label={t('statusSelectLabel', { title: r.card.title })} value={r.status.columnId} onChange={(e) => void onMove(r, e.target.value)}>
          {STATUS_IDS.map((id) => <option key={id} value={id}>{t(STATUS_LABEL_KEY[id])}</option>)}
        </select>
      ),
    },
    // ADR 0232 — intake & evidence panel (requester/source/value, evidence
    // pointers, merge-a-duplicate, promote-to-project).
    {
      key: 'intake', header: t('colIntake'),
      render: (r) => (
        <Button variant="quiet" size="sm" onClick={() => setIntakeFor(r)} aria-label={t('intakeButtonLabel', { title: r.card.title })}>{t('intakeButton')}</Button>
      ),
    },
    // ADR 0259 — per-idea edit / clone / delete overflow menu.
    {
      key: 'actions', header: <span className="sr-only">{t('colActions')}</span>, align: 'right',
      render: (r) => (
        <Menu
          label={t('ideaActionsLabel', { title: r.card.title })}
          triggerClassName="ghost btn-sm"
          triggerContent={<MoreHorizontalIcon size={16} />}
          items={ideaActionItems(r)}
          portal
        />
      ),
    },
  ];

  // The Grid cell — a read/scan tile of the SAME fields the table shows in read
  // form (rank, title, priority, status, owner, schedule, strategy alignment).
  // The per-cell EDITING (scoring, status change, schedule, bulk → agenda) stays
  // the List/table's power affordance; the Grid never fabricates or drops data.
  const renderIdeaCard = (r: RankedIdea): JSX.Element => {
    const sched = scheduleLoaded?.byCard.get(r.card.id);
    const alignedCount = strategyRefs.get(r.card.id)?.length ?? 0;
    return (
      <article key={r.card.id} className="surface-card u-flex u-flex-col u-gap-2">
        <div className="u-flex u-items-baseline u-justify-between u-gap-2">
          <span className="u-flex u-items-baseline u-gap-2 u-minw-0">
            <span className="muted u-fs-12">#{formatNumber(r.rank)}</span>
            <strong className="u-fs-14">{r.card.title}</strong>
          </span>
          <span className="u-flex u-items-center u-gap-2">
            {r.completeness && r.completeness.scored === 0
              ? <span className="muted u-fs-12">{t('priorityUnscored')}</span>
              : <>
                  <strong className="u-fs-16" title={list.votingMode === 'multi-voter' ? t('colPriorityAgg') : t('colPriority')}>{formatNumber(r.computedPriority)}</strong>
                  {r.completeness && !r.completeness.complete
                    ? <span className="muted u-fs-12">{t('priorityPartial', { scored: r.completeness.scored, declared: r.completeness.declared })}</span>
                    : null}
                </>}
            <Menu
              label={t('ideaActionsLabel', { title: r.card.title })}
              triggerClassName="ghost btn-sm"
              triggerContent={<MoreHorizontalIcon size={16} />}
              items={ideaActionItems(r)}
            />
          </span>
        </div>
        <div className="u-flex u-gap-2 u-wrap u-items-center">
          {ideaSourceChip(r)}
          <span className="chip chip--muted">{r.status.columnName}</span>
          {sched ? (
            <span className={`chip ${SCHEDULE_CHIP_CLASS[sched.state]} u-fs-11`}><ClockIcon size={11} aria-hidden /> {fmtDate(sched.targetDate)}</span>
          ) : null}
          {strategyOn && alignedCount > 0 ? (
            <span className="chip chip--accent"><FlagIcon size={11} aria-hidden /> {t('strategyAlignedCount', { count: alignedCount, formattedCount: formatNumber(alignedCount) })}</span>
          ) : null}
          {list.votingMode === 'multi-voter' ? (
            <Button variant="quiet" size="sm" onClick={() => void openBreakdown(r)} aria-label={t('voteBreakdownButtonLabel', { title: r.card.title })}>{t('votesChip', { count: r.voterCount ?? 0, formattedCount: formatNumber(r.voterCount ?? 0) })}</Button>
          ) : null}
        </div>
        <span className="muted u-fs-12">{ownerName(r)}</span>
      </article>
    );
  };

  return (
    <div className="u-flex u-flex-col u-gap-4">
      {intakeFor ? (
        <IdeaIntakePanel
          listId={list.id}
          idea={intakeFor}
          others={(ideas ?? []).filter((r) => r.card.id !== intakeFor.card.id)}
          onClose={() => setIntakeFor(null)}
          onChanged={refresh}
        />
      ) : null}
      {editIdeaFor ? (
        <EditIdeaModal idea={editIdeaFor} onSubmit={onEditIdea} onClose={() => setEditIdeaFor(null)} />
      ) : null}
      {breakdown ? (
        <Modal label={t('voteBreakdownLabel', { title: breakdown.idea.card.title })} onClose={() => setBreakdown(null)}>
          <h3 className="u-mt-0">{t('voteBreakdownHeading', { title: breakdown.idea.card.title })}</h3>
          {breakdown.entries === 'loading' ? <p className="muted">{t('common:loading')}</p>
            : breakdown.entries === 'forbidden' ? <Notice variant="info">{t('voteBreakdownRestricted')}</Notice>
              : breakdown.entries === 'error' ? (
                <Notice variant="error">{t('voteBreakdownFailed')} <Button variant="link" onClick={() => void openBreakdown(breakdown.idea)}>{t('common:retry')}</Button></Notice>
              )
              : breakdown.entries.length === 0 ? <p className="muted">{t('noVotesYet')}</p>
                : (
                  <>
                    <p className="muted u-fs-12">{t('weightExplainer')}</p>
                    <ul className="u-flex u-flex-col u-gap-2 u-list-none u-p-0">
                      {breakdown.entries.map((v) => {
                        // PMXU-1 (ADR 0590) — a run-cast vote's voterId is the literal
                        // 'workflow': label it as automation, never as a person's name;
                        // an AI-cast vote (source:'agent') is chipped beside the member
                        // who authorized it.
                        const isAutomation = v.voterId === 'workflow';
                        const name = isAutomation ? t('voterAutomation') : (members.find((m) => m.subject === v.voterId)?.displayName ?? v.voterId);
                        return (
                          <li key={v.voterId} className="surface-card u-flex u-flex-row u-items-center u-justify-between u-gap-3 u-wrap">
                            <div className="u-minw-0">
                              <span className="u-flex u-items-center u-gap-2"><strong className="u-fs-12">{name}</strong>
                                {v.source === 'agent' ? <span className="chip chip--warning u-fs-11">{t('ideaSourceAgent')}</span>
                                  : isAutomation || v.source === 'workflow' ? <span className="chip chip--warning u-fs-11">{t('ideaSourceWorkflow')}</span> : null}
                              </span>
                              <div className="muted u-fs-12">{list.criteriaSet.criteria.map((c) => { const s = v.scores[c.id]; return t('criterionScore', { name: c.name, score: s != null ? formatNumber(s) : t('emDash') }); }).join(' · ')}</div>
                            </div>
                            <Field label={t('weight')}>
                              {(w) => (
                                <select {...w} aria-label={t('weightForLabel', { name })} className="u-w-auto" value={list.voterWeights?.[v.voterId] ?? 1} onChange={(e) => void setVoterWeight(v.voterId, Number(e.target.value))}>
                                  {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{formatNumber(n)}</option>)}
                                </select>
                              )}
                            </Field>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
          <div className="action-bar u-mt-3 u-justify-end"><Button variant="secondary" onClick={() => setBreakdown(null)}>{t('common:close')}</Button></div>
        </Modal>
      ) : null}

      {criteriaOpen ? (
        <CriteriaModal list={list} onClose={() => setCriteriaOpen(false)} onChanged={async () => { await props.onChanged(); await refresh(); }} onError={props.onError} />
      ) : null}

      {editOpen ? (
        <EditListModal list={list} onClose={() => setEditOpen(false)} onChanged={async () => { await props.onChanged(); await refresh(); }} onError={props.onError} />
      ) : null}

      {confirmDeleteOpen ? (
        <ConfirmDialog
          title={t('confirmDeleteTitle', { name: list.name })}
          body={t('confirmDeleteBody')}
          confirmLabel={t('common:delete')}
          confirmIcon={<TrashIcon size={14} />}
          danger
          busy={deleting}
          onConfirm={() => void doDelete()}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      ) : null}

      {/* ── List meta + actions (the routed PageHeader owns the title) ── */}
      <div className="surface-card u-flex u-flex-row u-items-center u-justify-between u-gap-3 u-wrap">
        <div className="proj-lineup">
          <span className="chip chip--muted">{(() => { const k = (MODEL_LABEL_KEY as Record<string, string>)[list.criteriaSet.presetId ?? '']; return k ? t(k) : t('modelCustom'); })()}</span>
          <span className="chip chip--muted">{list.votingMode === 'multi-voter' ? t('chipMultiVoter', { aggregation: list.voteAggregation }) : t('chipSingleScore')}</span>
          <span className="muted u-fs-12">{t('ideaCount', { count: ideas?.length ?? 0, formattedCount: formatNumber(ideas?.length ?? 0) })}</span>
        </div>
        <div className="action-bar">
          <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>{t('common:edit')}</Button>
          <Button variant="secondary" size="sm" onClick={() => setCriteriaOpen(true)}><ScaleIcon size={13} /> {t('criteria')}</Button>
          <Button variant="quiet" size="sm" onClick={() => setConfirmDeleteOpen(true)} aria-label={t('deleteList')}><TrashIcon size={14} /></Button>
        </div>
      </div>

      {/* ── Add idea ── */}
      <IdeaForm onSubmit={onSubmitIdea} />

      {/* ── Ranked ideas — Grid (scan) / List (the sortable, selectable scoring
          table whose bulk action is "add to meeting agenda"). The List is the
          default power surface; Grid is the read companion (§4.5 rule 11). ── */}
      <section>
        <div className="u-flex u-items-center u-gap-2 u-mb-2 u-wrap">
          <ListOrderedIcon size={16} /> <h3 className="u-fs-14 u-m-0">{t('rankedIdeas')}</h3>
          <span className="muted u-fs-12">{t('rankedIdeasHint')}</span>
          {scheduleLoaded && (scheduleLoaded.rollup.onTrack + scheduleLoaded.rollup.atRisk + scheduleLoaded.rollup.behind + scheduleLoaded.rollup.doneEarly + scheduleLoaded.rollup.doneLate) > 0 ? (
            <span className={`chip ${SCHEDULE_CHIP_CLASS[scheduleLoaded.rollup.health]} u-fs-11`} title={t('scheduleRollupSummary', { onTrack: formatNumber(scheduleLoaded.rollup.onTrack), atRisk: formatNumber(scheduleLoaded.rollup.atRisk), behind: formatNumber(scheduleLoaded.rollup.behind) })}>
              <ClockIcon size={11} /> {t('scheduleRollupSummary', { onTrack: formatNumber(scheduleLoaded.rollup.onTrack), atRisk: formatNumber(scheduleLoaded.rollup.atRisk), behind: formatNumber(scheduleLoaded.rollup.behind) })}
            </span>
          ) : schedule === 'failed' ? (
            // PMXU-4 — the failed read is SAID (with a retry), not silently absent.
            <span className="chip chip--muted u-fs-11"><ClockIcon size={11} /> {t('scheduleUnavailable')} <Button variant="link" onClick={() => void refreshSchedule()}>{t('common:retry')}</Button></span>
          ) : null}
          {membersFailed ? <span className="chip chip--warning u-fs-11">{t('membersUnavailable')}</span> : null}
          {ideas && ideas.length > 0 ? (
            <div className="segmented view-toggle u-ml-auto" role="group" aria-label={t('viewToggleAria')}>
              <Button variant="primary" aria-pressed={ideaView === 'matrix'} disabled={!canMatrix} title={canMatrix ? t('viewMatrix') : t('matrixUnavailable')} onClick={() => setIdeaView('matrix')}>
                <LayoutGridIcon size={14} /> <span className="view-toggle-label">{t('viewMatrix')}</span>
              </Button>
              <Button variant="primary" aria-pressed={ideaView === 'grid'} title={t('viewGrid')} onClick={() => setIdeaView('grid')}>
                <BoxesIcon size={14} /> <span className="view-toggle-label">{t('viewGrid')}</span>
              </Button>
              <Button variant="primary" aria-pressed={ideaView === 'list'} title={t('viewList')} onClick={() => setIdeaView('list')}>
                <ListOrderedIcon size={14} /> <span className="view-toggle-label">{t('viewList')}</span>
              </Button>
            </div>
          ) : null}
        </div>
        {ideas === null && ideasFailed ? (
          <StateCard announce icon={<ListOrderedIcon size={18} />} title={t('ideasLoadFailedTitle')} body={t('ideasLoadFailedBody')} />
        ) : ideas === null ? (
          <StateCard icon={<ListOrderedIcon size={18} />} title={t('loadingIdeas')} loading />
        ) : ideas.length === 0 ? (
          <StateCard icon={<ListOrderedIcon size={18} />} title={t('noIdeasTitle')} body={t('noIdeasBody')} />
        ) : ideaView === 'matrix' ? (
          <PriorityQuadrant ideas={ideas} criteriaSet={list.criteriaSet} />
        ) : ideaView === 'grid' ? (
          <div className="card-grid">
            {[...ideas].sort((a, b) => a.rank - b.rank).map((r) => renderIdeaCard(r))}
          </div>
        ) : (
          <DataTable<RankedIdea>
            rows={ideas}
            rowKey={(r) => r.card.id}
            density="compact"
            stackHeaders
            caption={t('captionRankedIdeas')}
            columns={ideaColumns}
            initialSort={{ key: 'rank', dir: 'asc' }}
            selectable
            selected={selection}
            onSelectionChange={setSelection}
            bulkActions={(rows) => (
              <Button variant="primary" size="sm" onClick={() => void addToAgenda(rows)}><ClipboardIcon size={13} /> {t('addToAgendaBulk', { n: formatNumber(rows.length) })}</Button>
            )}
            empty={<StateCard icon={<ListOrderedIcon size={18} />} title={t('noIdeasTitle')} body={t('noIdeasBody')} />}
          />
        )}
      </section>

      {/* ── Meeting agenda ── */}
      <AgendaPanel
        agenda={agenda}
        agendaSort={agendaSort}
        sessions={sessions}
        ownerName={ownerName}
        onBuildTopN={buildTopN}
        onReorder={reorderAgenda}
        onOpenSession={(s) => { setAgendaSessionId(s.id); setAgenda({ ideas: [], markdown: s.agendaMarkdown, name: s.name }); }}
      />

      {/* ── What-if scenarios (ADR 0235 §D1) — active for the open session ── */}
      {agendaSessionId ? (
        <ScenarioPanel listId={list.id} sessionId={agendaSessionId} strategyRefs={strategyRefs} onError={props.onError} />
      ) : null}
    </div>
  );
}

/** Edit a list's metadata (name + scoring mode). Lists were previously
 *  un-editable after creation — you couldn't even rename one. Reuses the
 *  shared Modal; criteria/weights stay in CriteriaModal (this is metadata only). */
function EditListModal(props: {
  list: PriorityList; onClose: () => void; onChanged: () => Promise<void>; onError: (m: string) => void;
}): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const { list } = props;
  const [name, setName] = useState(list.name);
  const [votingMode, setVotingMode] = useState<VotingMode>(list.votingMode);
  const [busy, setBusy] = useState(false);
  const canSave = name.trim().length > 0 && !busy;
  // PMXU-7 (ADR 0590) — backdrop/Escape close discarded edits silently.
  const dirty = name !== list.name || votingMode !== list.votingMode;
  useUnsavedChangesWarning(dirty);
  const confirmDiscard = useConfirmDiscardUnsaved(dirty);
  const guardedClose = (): void => { if (!busy) void confirmDiscard().then((ok) => { if (ok) props.onClose(); }); };
  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    try {
      await updateList(list.id, { name: name.trim(), votingMode });
      await props.onChanged();
      props.onClose();
    } catch (er) { props.onError(er instanceof Error ? er.message : t('updateListFailed')); setBusy(false); }
  };
  return (
    <Modal label={t('editList')} onClose={guardedClose}>
      <h3 className="u-mt-0">{t('editList')}</h3>
      <form className="u-flex u-flex-col u-gap-3" onSubmit={(e) => void onSubmit(e)}>
        <TextField label={t('listName')} required value={name} onChange={(e) => setName(e.target.value)} placeholder={t('listNamePlaceholder')} />
        <SelectField label={t('scoringMode')} value={votingMode} onChange={(e) => setVotingMode(e.target.value as VotingMode)}>
          <option value="single">{t('scoringModeSingle')}</option>
          <option value="multi-voter">{t('scoringModeMulti')}</option>
        </SelectField>
        <div className="action-bar u-justify-end">
          <Button variant="secondary" onClick={guardedClose} disabled={busy}>{t('common:cancel')}</Button>
          <Button variant="primary" type="submit" disabled={!canSave}>{t('common:save')}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** ADR 0103 — per-idea schedule cell: a state chip (on-track / at-risk / behind /
 *  done-early / done-late / unscheduled) + an inline target-date input. Setting a
 *  date PUTs the schedule; clearing it (empty input) DELETEs it. Mirrors the
 *  StrategyAlignment per-row pattern; the parent owns the resolved status map. */
function ScheduleCell(props: {
  listId: string; idea: RankedIdea; status: IdeaScheduleStatus | undefined;
  onChanged: () => Promise<void>; onError: (m: string) => void;
}): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const { idea, status } = props;
  const [busy, setBusy] = useState(false);
  const state: ScheduleState = status?.state ?? 'unscheduled';
  const dateVal = status?.targetDate ? status.targetDate.slice(0, 10) : '';

  const onDate = async (value: string): Promise<void> => {
    setBusy(true);
    try {
      if (value) await setIdeaSchedule(props.listId, idea.card.id, value);
      else await clearIdeaSchedule(props.listId, idea.card.id);
      await props.onChanged();
    } catch (e) { props.onError(e instanceof Error ? e.message : t('saveScheduleFailed')); }
    finally { setBusy(false); }
  };

  const Icon = state === 'behind' || state === 'at-risk' || state === 'done-late' ? AlertIcon
    : state === 'on-track' || state === 'done-early' ? CheckIcon : ClockIcon;
  const suffix = state === 'behind' && status?.overdueByDays
    ? t('scheduleOverdueBy', { n: formatNumber(status.overdueByDays) })
    : (state === 'on-track' || state === 'at-risk') && status?.dueInDays != null
      ? t('scheduleDueIn', { n: formatNumber(status.dueInDays) })
      : '';

  return (
    <div className="u-flex u-items-center u-gap-2 u-wrap">
      <span className={`chip ${SCHEDULE_CHIP_CLASS[state]} u-fs-11`}>
        <Icon size={11} /> {t(SCHEDULE_LABEL_KEY[state])}{suffix ? <span className="muted u-fs-11"> {suffix}</span> : null}
      </span>
      <input
        type="date"
        className="u-w-auto"
        value={dateVal}
        disabled={busy}
        aria-label={t('setTargetDateAria', { title: idea.card.title })}
        onChange={(e) => void onDate(e.target.value)}
      />
      {dateVal ? (
        <Button
          variant="quiet" size="sm"
          disabled={busy}
          aria-label={t('clearScheduleAria', { title: idea.card.title })}
          onClick={() => void onDate('')}
        >
          <TrashIcon size={12} />
        </Button>
      ) : null}
    </div>
  );
}

function IdeaForm(props: { onSubmit: (title: string, description: string) => Promise<void> }): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try { await props.onSubmit(title.trim(), description.trim()); setTitle(''); setDescription(''); }
    finally { setBusy(false); }
  };
  return (
    <form className="surface-card u-flex u-flex-col" onSubmit={(e) => void submit(e)}>
      <TextField label={t('ideaTitleLabel')} required value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('ideaTitlePlaceholder')} />
      <TextareaField label={t('ideaContextLabel')} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder={t('ideaContextPlaceholder')} />
      <div className="action-bar u-justify-end"><Button variant="primary" type="submit" disabled={!title.trim() || busy}><PlusIcon size={14} /> {t('addIdea')}</Button></div>
    </form>
  );
}

/** ADR 0259 — edit an existing idea's title/description in a modal, seeded from the
 *  card. Scores/status/schedule live in the table; this only touches the text. */
function EditIdeaModal(props: { idea: RankedIdea; onSubmit: (title: string, description: string) => Promise<void>; onClose: () => void }): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const [title, setTitle] = useState(props.idea.card.title);
  const [description, setDescription] = useState(props.idea.card.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PMXU-7 (ADR 0590) — guard dirty edits against a silent backdrop/Escape close.
  const dirty = title !== props.idea.card.title || description !== (props.idea.card.description ?? '');
  useUnsavedChangesWarning(dirty);
  const confirmDiscard = useConfirmDiscardUnsaved(dirty);
  const guardedClose = (): void => { if (!busy) void confirmDiscard().then((ok) => { if (ok) props.onClose(); }); };
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try { await props.onSubmit(title.trim(), description.trim()); }
    catch (err) { setError(err instanceof Error ? err.message : t('editIdeaFailed')); }
    finally { setBusy(false); }
  };
  return (
    <Modal label={t('editIdeaHeading')} onClose={guardedClose}>
      <h3 className="u-mt-0">{t('editIdeaHeading')}</h3>
      <form className="u-flex u-flex-col u-gap-3" onSubmit={(e) => void submit(e)}>
        {error ? <Notice variant="error">{error}</Notice> : null}
        <TextField label={t('ideaTitleLabel')} required value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('ideaTitlePlaceholder')} />
        <TextareaField label={t('ideaContextLabel')} value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder={t('ideaContextPlaceholder')} />
        <div className="action-bar u-justify-end">
          <Button variant="secondary" onClick={guardedClose} disabled={busy}>{t('common:cancel')}</Button>
          <Button variant="primary" type="submit" disabled={!title.trim() || busy}><SaveIcon size={14} /> {busy ? t('common:saving') : t('common:save')}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** ADR 0058/0059 — the scoring model: per-criterion weight sliders + aggregation,
 *  in a modal so the matrix isn't pushed down by an always-open editor. */
function CriteriaModal(props: { list: PriorityList; onClose: () => void; onChanged: () => Promise<void>; onError: (m: string) => void }): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const { list } = props;
  const [weights, setWeights] = useState<Record<string, number>>(() => Object.fromEntries(list.criteriaSet.criteria.map((c) => [c.id, c.weight])));
  const [busy, setBusy] = useState(false);
  // PMXU-7 (ADR 0590) — the weights-slider editor closed on backdrop/Escape
  // discarding slider changes silently.
  const dirty = list.criteriaSet.criteria.some((c) => (weights[c.id] ?? c.weight) !== c.weight);
  useUnsavedChangesWarning(dirty);
  const confirmDiscard = useConfirmDiscardUnsaved(dirty);
  const guardedClose = (): void => { if (!busy) void confirmDiscard().then((ok) => { if (ok) props.onClose(); }); };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const criteriaSet: CriteriaSet = { ...list.criteriaSet, criteria: list.criteriaSet.criteria.map((c) => ({ ...c, weight: weights[c.id] ?? c.weight })) };
      await updateList(list.id, { criteriaSet });
      await props.onChanged();
      props.onClose();
    } catch (e) { props.onError(e instanceof Error ? e.message : t('saveWeightsFailed')); }
    finally { setBusy(false); }
  };

  return (
    <Modal label={t('criteriaModalLabel')} onClose={guardedClose}>
      <h3 className="u-mt-0 u-flex u-items-center u-gap-2"><ScaleIcon size={16} /> {t('criteriaWeights')}</h3>
      <p className="muted u-fs-12">{t('criteriaModalBlurb', { preset: list.criteriaSet.presetId ?? t('criteriaPresetCustom'), aggregation: list.criteriaSet.aggregation })}</p>
      <div className="u-flex u-flex-col u-gap-3">
        {list.criteriaSet.criteria.map((c) => (
          <Field key={c.id} label={c.direction === 'cost' ? t('criterionCostLabel', { name: c.name }) : t('criterionLabel', { name: c.name })} help={c.scaleHint}>
            {(w) => (
              <div className="u-flex u-items-center u-gap-3">
                <input {...w} type="range" min={1} max={10} step={1} value={weights[c.id] ?? c.weight} onChange={(e) => setWeights((prev) => ({ ...prev, [c.id]: Number(e.target.value) }))} />
                <span className="u-fs-12 muted">{t('weightValue', { value: formatNumber(weights[c.id] ?? c.weight) })}</span>
              </div>
            )}
          </Field>
        ))}
      </div>
      <div className="action-bar u-mt-3 u-justify-end">
        <Button variant="quiet" onClick={guardedClose} disabled={busy}>{t('common:cancel')}</Button>
        <Button variant="primary" onClick={() => void save()} disabled={busy}>{busy ? t('common:saving') : t('saveWeights')}</Button>
      </div>
    </Modal>
  );
}

/** The meeting agenda — built from a selection (or top-N), shown as a SORTABLE
 *  table (priority / owner / status / created) so the user orders it however the
 *  meeting needs, plus the saved agenda document and prior sessions. */
function AgendaPanel(props: {
  agenda: { ideas: RankedIdea[]; markdown: string; name: string } | null;
  agendaSort: AgendaSort;
  sessions: PlanningSession[];
  ownerName: (idea: RankedIdea) => string;
  onBuildTopN: (n: number) => Promise<void>;
  onReorder: (sort: AgendaSort) => Promise<void>;
  onOpenSession: (s: PlanningSession) => void;
}): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  // PMXU-12 (ADR 0590) — the R2 forms-pass number-field pattern: keep the RAW
  // string while typing (the old `Number(...) || 1` snapped a cleared field to
  // 1 mid-edit, clobbering "12" as it was typed); validate on use.
  const [nRaw, setNRaw] = useState('5');
  const n = Number(nRaw);
  const nValid = Number.isInteger(n) && n >= 1 && n <= 50;
  const [busy, setBusy] = useState(false);
  const { agenda } = props;
  // Map the agenda order onto the preview table's initial sort so the live view
  // mirrors the saved doc; keying the table on the order re-applies it on change.
  const previewSort = AGENDA_SORT_COL[props.agendaSort];

  const cols: DataColumn<RankedIdea>[] = [
    { key: 'idea', header: t('colIdea'), render: (r) => <strong>{r.card.title}</strong>, sortValue: (r) => r.card.title },
    { key: 'priority', header: t('colPriority'), align: 'right', render: (r) => <PriorityCell idea={r} />, sortValue: (r) => r.computedPriority },
    { key: 'owner', header: t('colOwner'), render: (r) => <span className="muted u-fs-12">{props.ownerName(r)}</span>, sortValue: (r) => props.ownerName(r) },
    { key: 'status', header: t('colStatus'), render: (r) => <span className="muted u-fs-12">{r.status.columnName}</span>, sortValue: (r) => r.status.columnName },
    { key: 'created', header: t('colCreated'), align: 'right', render: (r) => <span className="muted u-fs-12">{fmtDate(r.card.createdAt)}</span>, sortValue: (r) => r.card.createdAt ?? '' },
  ];

  return (
    <section className="surface-card u-flex u-flex-col u-gap-3">
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        <ClipboardIcon size={16} /> <h3 className="u-fs-14 u-m-0">{t('meetingAgenda')}</h3>
        <span className="muted u-fs-12 u-ml-auto">{t('orBuildFromTop')}</span>
        <Field label={t('topN')}>{(w) => <input {...w} type="number" min={1} max={50} value={nRaw} aria-invalid={nValid ? undefined : true} onChange={(e) => setNRaw(e.target.value)} className="u-w-auto" />}</Field>
        <Button variant="secondary" size="sm" disabled={busy || !nValid} onClick={async () => { setBusy(true); try { await props.onBuildTopN(n); } finally { setBusy(false); } }}><FlagIcon size={13} /> {t('buildTopN', { n: nValid ? formatNumber(n) : nRaw })}</Button>
      </div>

      {agenda ? (
        <>
          <div className="u-flex u-items-baseline u-gap-2 u-wrap">
            <span className="proj-eyebrow">{t('agendaEyebrow')}</span><span className="muted u-fs-12">{agenda.name}</span>
            {agenda.ideas.length > 0 ? (
              <SelectField label={t('orderBy')} className="u-ml-auto" value={props.agendaSort} disabled={busy} onChange={(e) => { setBusy(true); void props.onReorder(e.target.value as AgendaSort).finally(() => setBusy(false)); }}>
                {(['priority', 'created', 'owner', 'status', 'title'] as AgendaSort[]).map((s) => <option key={s} value={s}>{t(AGENDA_SORT_LABEL_KEY[s])}</option>)}
              </SelectField>
            ) : null}
          </div>
          {agenda.ideas.length > 0 ? (
            <DataTable<RankedIdea>
              key={props.agendaSort}
              rows={agenda.ideas}
              rowKey={(r) => r.card.id}
              density="compact"
              caption={t('captionMeetingAgenda')}
              columns={cols}
              initialSort={previewSort}
            />
          ) : null}
          <details>
            <summary className="muted u-fs-12">{t('agendaDocument')}</summary>
            <div className="surface-card u-mt-2"><Markdown>{agenda.markdown}</Markdown></div>
          </details>
        </>
      ) : (
        <p className="muted u-fs-13 u-m-0"><Trans ns="priority-matrix" i18nKey="agendaEmpty" components={[<strong key="0" />]} /></p>
      )}

      {props.sessions.length > 0 ? (
        <div className="u-flex u-flex-col u-gap-1">
          <span className="proj-eyebrow">{t('previousSessions')}</span>
          <ul className="u-list-none u-m-0 u-p-0 u-flex u-flex-col u-gap-1">
            {props.sessions.map((s) => (
              <li key={s.id} className="u-flex u-items-center u-gap-2">
                <Button variant="quiet" size="sm" onClick={() => props.onOpenSession(s)}>{s.name}</Button>
                {s.agendaDocumentId ? <span className="muted u-fs-12">{t('savedAsDocument')}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
