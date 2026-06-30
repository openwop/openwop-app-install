/**
 * Priority Matrix page (ADR 0058/0059/0060/0061). Capture ideas into a named
 * priority list, score them against a weighted criteria set, see them ranked,
 * move them through statuses, and turn a selection into a meeting agenda.
 *
 * IA: the LISTS are the primary navigation — a tab strip under the header
 * (Portfolio + each list + "New list"). A list opens its detail: a sortable,
 * checkbox-selectable ideas table whose bulk action is "Add to meeting agenda",
 * plus the agenda (sortable) and the scoring model (in a modal). An idea = a
 * `host.kanban` card; statuses = the board's columns.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import i18n from '../../i18n/index.js';
import { formatNumber, formatDate } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { handleTablistKeyDown } from '../../ui/rovingTabs.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Markdown } from '../../ui/Markdown.js';
import { Field, TextField, TextareaField, SelectField, CheckboxField } from '../../ui/Field.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { Modal } from '../../ui/Modal.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { ListOrderedIcon, PlusIcon, TrashIcon, ScaleIcon, CheckIcon, AlertIcon, ClipboardIcon, FlagIcon, BookOpenIcon, ClockIcon, BoxesIcon, LayoutGridIcon } from '../../ui/icons/index.js';
import { PriorityQuadrant } from './PriorityQuadrant.js';
import { matrixSupported } from './quadrant.js';
import { listMembers, type OrgMember } from '../../client/accessClient.js';
// ADR 0079 Phase 3 — strategy alignment is composed from the strategy feature
// (one-directional import; the strategy package never imports priority-matrix).
import { StrategyAlignment, type StrategyRefLite } from '../strategy/StrategyAlignment.js';
import { getStrategyContext, FeatureDisabledError } from '../strategy/strategyClient.js';
import {
  listPresets, listLists, createList, updateList, deleteList,
  listIdeas, submitIdea, moveIdeaStatus, setIdeaScores, getVoteBreakdown,
  listSessions, createSession, updateSession, listOrgs, listProjects, listPortfolio,
  listPeers, addPeer, deletePeer, setPeerCredential, listFederatedPortfolio,
  getScheduleStatus, setIdeaSchedule, clearIdeaSchedule,
  type PriorityList, type RankedIdea, type CriteriaSet, type PlanningSession,
  type OrgRef, type ProjectRef, type PresetId, type VotingMode, type PortfolioItem,
  type NormalizeMode, type VoteBreakdownEntry, type FederatedPeer, type PeerStatus, type AgendaSort,
  type IdeaScheduleStatus, type ScheduleRollup, type ScheduleState,
} from './priorityMatrixClient.js';

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
// Scoring-model code → label key. A code with no entry falls back to the code itself.
const MODEL_LABEL_KEY = {
  weighted: 'modelWeighted',
  wsjf: 'modelWsjf',
  rice: 'modelRice',
  ice: 'modelIce',
  'value-effort': 'modelValueEffort',
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

export function PriorityMatrixPage(): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  // ADR 0100: a non-project (workspace/org) list is indexed for agents when kb is on.
  const kbEnabled = true; // KB always-on (toggle removed)
  const [lists, setLists] = useState<PriorityList[] | null>(null);
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [presets, setPresets] = useState<CriteriaSet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<string>('portfolio'); // 'portfolio' | listId
  const [createOpen, setCreateOpen] = useState(false);

  const refreshLists = useCallback(async () => {
    try { setLists(await listLists()); }
    catch (e) { setError(e instanceof Error ? e.message : t('loadListsFailed')); }
  }, [t]);

  useEffect(() => {
    void refreshLists();
    void listOrgs().then(setOrgs).catch(() => {});
    void listProjects().then(setProjects).catch(() => {});
    void listPresets().then(setPresets).catch(() => {});
  }, [refreshLists]);

  // Land on the first list the FIRST time lists arrive (so existing work is
  // immediately visible + editable). One-shot — guarded by a ref so a later
  // `lists` refresh (e.g. after a delete) doesn't yank the user off Portfolio.
  const didLand = useRef(false);
  useEffect(() => {
    if (didLand.current || !lists || lists.length === 0) return;
    didLand.current = true;
    const first = lists[0];
    if (first) setView(first.id);
  }, [lists]);

  const selected = useMemo(() => lists?.find((l) => l.id === view) ?? null, [lists, view]);

  return (
    <div>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
        actions={lists && lists.length > 0 ? <button type="button" className="primary btn-sm" onClick={() => setCreateOpen(true)}><PlusIcon size={13} /> {t('newList')}</button> : undefined}
      />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {createOpen ? (
        <Modal label={t('createModalLabel')} onClose={() => setCreateOpen(false)}>
          <h3 className="u-mt-0">{t('createModalHeading')}</h3>
          <CreateListForm
            orgs={orgs} projects={projects} presets={presets}
            onCreated={async (l) => { await refreshLists(); setView(l.id); setCreateOpen(false); }}
            onError={setError}
          />
        </Modal>
      ) : null}

      {lists === null ? (
        <StateCard icon={<ListOrderedIcon size={20} />} title={t('loadingLists')} loading />
      ) : lists.length === 0 ? (
        <StateCard
          icon={<ListOrderedIcon size={22} />}
          title={t('noListsTitle')}
          body={t('noListsBody')}
          action={<button type="button" className="primary btn-sm" onClick={() => setCreateOpen(true)}><PlusIcon size={13} /> {t('createFirstList')}</button>}
        />
      ) : (
        <>
          <div className="tabs u-mb-4" role="tablist" aria-label={t('tablistLabel')} onKeyDown={handleTablistKeyDown}>
            <button type="button" role="tab" aria-selected={view === 'portfolio'} tabIndex={view === 'portfolio' ? 0 : -1} className="tab" onClick={() => setView('portfolio')}>{t('tabPortfolio')}</button>
            {lists.map((l) => (
              <button key={l.id} type="button" role="tab" aria-selected={view === l.id} tabIndex={view === l.id ? 0 : -1} className="tab" onClick={() => setView(l.id)}>
                {l.name}{l.projectId
                  ? <span className="muted u-fs-11">{t('tabProjectSuffix')}</span>
                  : (kbEnabled ? <span className="muted u-fs-11" title={t('indexedForAgentsTitle')} aria-label={t('indexedForAgentsTitle')}> <BookOpenIcon size={10} /></span> : null)}
              </button>
            ))}
          </div>

          {view === 'portfolio' ? (
            <PortfolioSection onError={setError} />
          ) : selected ? (
            <ListDetail
              key={selected.id}
              list={selected}
              onChanged={refreshLists}
              onDeleted={async () => { setView('portfolio'); await refreshLists(); }}
              onError={setError}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

// ─── portfolio (cross-list rollup, ADR 0060) ─────────────────────────────────────

function PortfolioSection(props: { onError: (m: string) => void }): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const [items, setItems] = useState<Array<PortfolioItem & { source?: string }> | null>(null);
  const [listCount, setListCount] = useState(0);
  const [topN, setTopN] = useState(20);
  const [normalize, setNormalize] = useState<NormalizeMode>('none');
  const [federated, setFederated] = useState(false);
  const [peerStatus, setPeerStatus] = useState<PeerStatus[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      if (federated) {
        const p = await listFederatedPortfolio(topN);
        setItems(p.items); setPeerStatus(p.peers); setListCount(0);
      } else {
        const p = await listPortfolio(topN, undefined, normalize);
        setItems(p.items); setListCount(p.lists.length); setPeerStatus([]);
      }
    } catch (e) { props.onError(e instanceof Error ? e.message : t('loadPortfolioFailed')); }
    finally { setBusy(false); }
  }, [topN, normalize, federated, props, t]);

  useEffect(() => { void load(); }, [load]);

  const ranked = (items ?? []).map((it, i) => ({ ...it, globalRank: i + 1 }));
  type Row = typeof ranked[number];
  const modelLabel = (code: string): string => {
    const key = (MODEL_LABEL_KEY as Record<string, string>)[code];
    return key ? t(key) : code;
  };
  const cols: DataColumn<Row>[] = [
    { key: 'rank', header: t('colRank'), width: '44px', render: (r) => formatNumber(r.globalRank), sortValue: (r) => r.globalRank },
    { key: 'idea', header: t('colIdea'), render: (r) => <strong>{r.title}</strong>, sortValue: (r) => r.title },
    ...(federated ? [{ key: 'source', header: t('colSource'), render: (r: Row) => <span className="muted u-fs-12">{r.source ?? t('sourceLocal')}</span> } as DataColumn<Row>] : []),
    { key: 'list', header: t('colList'), render: (r) => <span>{r.listName} <span className="muted u-fs-12">{t('listCell', { rank: formatNumber(r.inListRank), model: modelLabel(r.scoringModel) })}</span></span>, sortValue: (r) => r.listName },
    { key: 'status', header: t('colStatus'), render: (r) => <span className="muted">{r.status}</span>, sortValue: (r) => r.status },
    { key: 'priority', header: t('colPriority'), align: 'right', render: (r) => <strong>{formatNumber(r.computedPriority)}</strong>, sortValue: (r) => r.computedPriority },
    ...(!federated && normalize !== 'none' ? [{
      key: 'normalized', header: normalize === 'percentile' ? t('colPercentile') : t('colNormalized'), align: 'right' as const,
      render: (r: Row) => <strong>{formatNumber(r.normalizedPriority ?? 0)}</strong>, sortValue: (r: Row) => r.normalizedPriority ?? 0,
    } as DataColumn<Row>] : []),
  ];

  return (
    <section className="surface-card u-mb-4">
      <div className="u-flex u-items-center u-gap-2 u-mb-2 u-flex-wrap">
        <ListOrderedIcon size={16} /> <h2 className="u-fs-16 u-m-0">{t('portfolioHeading')}</h2>
        <span className="muted u-fs-12">
          {federated ? t('portfolioSummaryFederated') : t('portfolioSummaryLocal', { count: listCount, formattedCount: formatNumber(listCount) })}
        </span>
        <div className="filterbar pm-portfolio-filters u-ml-auto">
          <CheckboxField label={t('includePeers')} checked={federated} onChange={(e) => setFederated(e.target.checked)} />
          {!federated ? (
            <SelectField label={t('compareLabel')} value={normalize} onChange={(e) => setNormalize(e.target.value as NormalizeMode)}>
              <option value="none">{t('compareRaw')}</option>
              <option value="list-relative">{t('compareListRelative')}</option>
              <option value="percentile">{t('comparePercentile')}</option>
            </SelectField>
          ) : null}
          <Field label={t('topN')}>{(w) => <input {...w} type="number" min={1} max={200} value={topN} onChange={(e) => setTopN(Number(e.target.value) || 1)} className="u-w-auto" />}</Field>
          <button type="button" className="secondary btn-sm" onClick={() => void load()} disabled={busy}>{t('common:refresh')}</button>
        </div>
      </div>
      <p className="muted u-fs-12 u-mb-3">
        {federated
          ? t('portfolioBlurbFederated')
          : normalize === 'none'
            ? t('portfolioBlurbRaw')
            : normalize === 'list-relative'
              ? t('portfolioBlurbListRelative')
              : t('portfolioBlurbPercentile')}
      </p>
      {federated && peerStatus.length > 0 ? (
        <div className="u-flex u-flex-wrap u-gap-2 u-mb-3">
          {peerStatus.map((p) => (
            <span key={p.peerId} className={`chip ${p.ok ? 'chip--success' : 'chip--danger'}`}>
              {p.ok ? <CheckIcon size={12} /> : <AlertIcon size={12} />}
              {t('peerChip', { label: p.label, value: p.ok ? formatNumber(p.count) : (p.error ?? t('peerError')) })}
            </span>
          ))}
        </div>
      ) : null}
      {items === null ? (
        <StateCard icon={<ListOrderedIcon size={18} />} title={t('loadingPortfolio')} loading />
      ) : (
        <DataTable<Row>
          rows={ranked}
          rowKey={(r) => `${r.source ?? 'local'}:${r.listId}:${r.cardId}`}
          density="compact"
          caption={t('captionPortfolio')}
          columns={cols}
          empty={<StateCard icon={<ListOrderedIcon size={18} />} title={t('noScoredIdeasTitle')} body={t('noScoredIdeasBody')} />}
        />
      )}
      <FederatedPeersAdmin onError={props.onError} onChanged={() => { if (federated) void load(); }} />
    </section>
  );
}

function FederatedPeersAdmin(props: { onError: (m: string) => void; onChanged: () => void }): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const [peers, setPeers] = useState<FederatedPeer[]>([]);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setPeers(await listPeers()); } catch { /* best-effort */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const onAdd = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!label.trim() || !baseUrl.trim() || busy) return;
    setBusy(true);
    try { await addPeer(label.trim(), baseUrl.trim()); setLabel(''); setBaseUrl(''); await refresh(); props.onChanged(); }
    catch (er) { props.onError(er instanceof Error ? er.message : t('addPeerFailed')); }
    finally { setBusy(false); }
  };
  const onDelete = async (id: string): Promise<void> => {
    try { await deletePeer(id); await refresh(); props.onChanged(); }
    catch (er) { props.onError(er instanceof Error ? er.message : t('removePeerFailed')); }
  };

  return (
    <details className="u-mt-3">
      <summary className="muted u-fs-12">{t('federatedPeers', { n: formatNumber(peers.length) })}</summary>
      <form className="surface-form u-mt-2" onSubmit={(e) => void onAdd(e)}>
        <TextField label={t('peerLabel')} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('peerLabelPlaceholder')} />
        <TextField label={t('baseUrl')} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={t('baseUrlPlaceholder')} />
        <button type="submit" className="primary" disabled={!label.trim() || !baseUrl.trim() || busy}><PlusIcon size={14} /> {t('addPeer')}</button>
      </form>
      {peers.length > 0 ? (
        <ul className="u-mt-2 u-flex u-flex-col u-gap-2 u-list-none u-p-0">
          {peers.map((p) => (
            <li key={p.id} className="u-flex u-flex-col u-gap-1">
              <div className="u-flex u-items-center u-gap-2">
                <strong className="u-fs-12">{p.label}</strong> <span className="muted u-fs-12">{p.baseUrl}</span>
                <button type="button" className="ghost btn-sm u-ml-auto" onClick={() => void onDelete(p.id)} aria-label={t('removePeerLabel', { label: p.label })}><TrashIcon size={14} /></button>
              </div>
              <PeerCredentialForm peerId={p.id} onError={props.onError} />
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

/** Set a peer's bearer (ADR 0062). "My own" closes the authz asymmetry per-user;
 *  "Workspace shared" is superadmin-only (a 403 surfaces as a clear message). */
function PeerCredentialForm(props: { peerId: string; onError: (m: string) => void }): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const [token, setToken] = useState('');
  const [scope, setScope] = useState<'user' | 'tenant'>('user');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const onSave = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true); setSaved(false);
    try { await setPeerCredential(props.peerId, token.trim(), scope); setToken(''); setSaved(true); }
    catch (er) { props.onError(er instanceof Error ? er.message : t('setCredentialFailed')); }
    finally { setBusy(false); }
  };
  return (
    <form className="surface-form" onSubmit={(e) => void onSave(e)}>
      <TextField label={t('bearerToken')} type="password" value={token} onChange={(e) => { setToken(e.target.value); setSaved(false); }} placeholder={t('bearerTokenPlaceholder')} autoComplete="off" />
      <SelectField label={t('scope')} value={scope} onChange={(e) => setScope(e.target.value as 'user' | 'tenant')}>
        <option value="user">{t('scopeUser')}</option>
        <option value="tenant">{t('scopeTenant')}</option>
      </SelectField>
      <button type="submit" className="secondary" disabled={!token.trim() || busy}>{t('common:save')}</button>
      {saved ? <span className="muted u-fs-12">{t('saved')}</span> : null}
    </form>
  );
}

// ─── create list ───────────────────────────────────────────────────────────────

function CreateListForm(props: {
  orgs: OrgRef[]; projects: ProjectRef[]; presets: CriteriaSet[];
  onCreated: (l: PriorityList) => Promise<void>; onError: (m: string) => void;
}): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const [name, setName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [presetId, setPresetId] = useState<PresetId>('weighted');
  const [votingMode, setVotingMode] = useState<VotingMode>('single');
  const [busy, setBusy] = useState(false);

  const effectiveOrg = orgId || props.orgs[0]?.orgId || '';
  const orgProjects = props.projects.filter((p) => p.orgId === effectiveOrg);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!effectiveOrg || !name.trim() || busy) return;
    setBusy(true);
    try {
      const l = await createList({ orgId: effectiveOrg, name: name.trim(), presetId, votingMode, ...(projectId ? { projectId } : {}) });
      setName(''); setProjectId('');
      await props.onCreated(l);
    } catch (er) { props.onError(er instanceof Error ? er.message : t('createListFailed')); }
    finally { setBusy(false); }
  };

  return (
    <form className="u-flex u-flex-col u-gap-3" onSubmit={(e) => void onSubmit(e)}>
      <TextField label={t('listName')} required value={name} onChange={(e) => setName(e.target.value)} placeholder={t('listNamePlaceholder')} />
      <div className="proj-grid">
        <SelectField label={t('workspace')} value={effectiveOrg} onChange={(e) => { setOrgId(e.target.value); setProjectId(''); }}>
          {props.orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
        <SelectField label={t('projectOptional')} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">{t('workspaceWide')}</option>
          {orgProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </SelectField>
        <SelectField label={t('scoringModel')} value={presetId} onChange={(e) => setPresetId(e.target.value as PresetId)}>
          <option value="weighted">{t('scoringModelWeighted')}</option>
          <option value="wsjf">{t('scoringModelWsjf')}</option>
          <option value="rice">{t('scoringModelRice')}</option>
          <option value="ice">{t('scoringModelIce')}</option>
          <option value="value-effort">{t('scoringModelValueEffort')}</option>
        </SelectField>
        <SelectField label={t('scoringMode')} value={votingMode} onChange={(e) => setVotingMode(e.target.value as VotingMode)}>
          <option value="single">{t('scoringModeSingle')}</option>
          <option value="multi-voter">{t('scoringModeMulti')}</option>
        </SelectField>
      </div>
      <div className="action-bar u-justify-end">
        <button type="submit" className="primary" disabled={!effectiveOrg || !name.trim() || busy}><PlusIcon size={14} /> {t('createList')}</button>
      </div>
    </form>
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
    <Modal label={t('editList')} onClose={() => { if (!busy) props.onClose(); }}>
      <h3 className="u-mt-0">{t('editList')}</h3>
      <form className="u-flex u-flex-col u-gap-3" onSubmit={(e) => void onSubmit(e)}>
        <TextField label={t('listName')} required value={name} onChange={(e) => setName(e.target.value)} placeholder={t('listNamePlaceholder')} />
        <SelectField label={t('scoringMode')} value={votingMode} onChange={(e) => setVotingMode(e.target.value as VotingMode)}>
          <option value="single">{t('scoringModeSingle')}</option>
          <option value="multi-voter">{t('scoringModeMulti')}</option>
        </SelectField>
        <div className="action-bar u-justify-end">
          <button type="button" className="secondary" onClick={() => props.onClose()} disabled={busy}>{t('common:cancel')}</button>
          <button type="submit" className="primary" disabled={!canSave}>{t('common:save')}</button>
        </div>
      </form>
    </Modal>
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
  const { list } = props;
  const [ideas, setIdeas] = useState<RankedIdea[] | null>(null);
  const [sessions, setSessions] = useState<PlanningSession[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({});
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
  const [breakdown, setBreakdown] = useState<{ idea: RankedIdea; entries: VoteBreakdownEntry[] | 'loading' | 'error' } | null>(null);
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
  const refreshStrategy = useCallback(async () => {
    try {
      const entries = await getStrategyContext({ priorityListId: list.id });
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
    return memberById.get(id) ?? t('unknown');
  }, [memberById, t]);

  const refresh = useCallback(async () => {
    try {
      setIdeas(await listIdeas(list.id));
      setSessions(await listSessions(list.id));
    } catch (e) { props.onError(e instanceof Error ? e.message : t('loadIdeasFailed')); }
  }, [list.id, props, t]);

  // ADR 0103 — schedule status, fetched ONCE per list (cardId → status + rollup).
  // A transient failure must not break the ideas table (mirrors the strategy fetch).
  const [schedule, setSchedule] = useState<{ byCard: Map<string, IdeaScheduleStatus>; rollup: ScheduleRollup } | null>(null);
  const refreshSchedule = useCallback(async () => {
    try {
      const s = await getScheduleStatus(list.id);
      setSchedule({ byCard: new Map(s.ideas.map((x) => [x.cardId, x])), rollup: s.rollup });
    } catch { setSchedule(null); }
  }, [list.id]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void refreshSchedule(); }, [refreshSchedule]);
  useEffect(() => { void listMembers(list.orgId).then(setMembers).catch(() => setMembers([])); }, [list.orgId]);

  useEffect(() => {
    if (!ideas) return;
    setDraft(Object.fromEntries(ideas.map((i) => {
      const own = i.myScores ?? i.scores;
      return [i.card.id, Object.fromEntries(list.criteriaSet.criteria.map((c) => [c.id, own[c.id] != null ? String(own[c.id]) : '']))];
    })));
  }, [ideas, list.criteriaSet.criteria]);

  const openBreakdown = async (idea: RankedIdea): Promise<void> => {
    setBreakdown({ idea, entries: 'loading' });
    try { setBreakdown({ idea, entries: await getVoteBreakdown(list.id, idea.card.id) }); }
    catch { setBreakdown({ idea, entries: 'error' }); }
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

  const onScore = async (idea: RankedIdea, criterionId: string, value: number): Promise<void> => {
    try {
      const current = draft[idea.card.id] ?? {};
      const next: Record<string, number> = {};
      for (const c of list.criteriaSet.criteria) {
        const raw = c.id === criterionId ? value : Number(current[c.id]);
        if (Number.isFinite(raw) && raw >= 1 && raw <= 10) next[c.id] = raw;
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

  const ideaColumns: DataColumn<RankedIdea>[] = [
    { key: 'rank', header: t('colRank'), width: '44px', align: 'right', render: (r) => formatNumber(r.rank), sortValue: (r) => r.rank },
    { key: 'idea', header: t('colIdea'), render: (r) => <strong>{r.card.title}</strong>, sortValue: (r) => r.card.title },
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
          onBlur={(e) => { const v = Number(e.target.value); if (v >= 1 && v <= 10) void onScore(r, c.id, v); }}
        />
      ),
    })),
    { key: 'priority', header: list.votingMode === 'multi-voter' ? t('colPriorityAgg') : t('colPriority'), align: 'right', render: (r) => <strong>{formatNumber(r.computedPriority)}</strong>, sortValue: (r) => r.computedPriority },
    { key: 'owner', header: t('colOwner'), render: (r) => <span className="muted u-fs-12">{ownerName(r)}</span>, sortValue: (r) => ownerName(r) },
    { key: 'created', header: t('colCreated'), align: 'right', render: (r) => <span className="muted u-fs-12">{fmtDate(r.card.createdAt)}</span>, sortValue: (r) => r.card.createdAt ?? '' },
    {
      key: 'schedule', header: t('colSchedule'),
      render: (r) => <ScheduleCell listId={list.id} idea={r} status={schedule?.byCard.get(r.card.id)} onChanged={refreshSchedule} onError={props.onError} />,
      sortValue: (r) => schedule?.byCard.get(r.card.id)?.targetDate ?? '',
    },
    ...(list.votingMode === 'multi-voter' ? [{
      key: 'votes', header: t('colVotes'), align: 'right' as const,
      render: (r: RankedIdea) => (
        <button type="button" className="ghost btn-sm" onClick={() => void openBreakdown(r)} aria-label={t('voteBreakdownButtonLabel', { title: r.card.title })}>{formatNumber(r.voterCount ?? 0)}</button>
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
  ];

  // The Grid cell — a read/scan tile of the SAME fields the table shows in read
  // form (rank, title, priority, status, owner, schedule, strategy alignment).
  // The per-cell EDITING (scoring, status change, schedule, bulk → agenda) stays
  // the List/table's power affordance; the Grid never fabricates or drops data.
  const renderIdeaCard = (r: RankedIdea): JSX.Element => {
    const sched = schedule?.byCard.get(r.card.id);
    const alignedCount = strategyRefs.get(r.card.id)?.length ?? 0;
    return (
      <article key={r.card.id} className="surface-card u-flex u-flex-col u-gap-2">
        <div className="u-flex u-items-baseline u-justify-between u-gap-2">
          <span className="u-flex u-items-baseline u-gap-2 u-minw-0">
            <span className="muted u-fs-12">#{formatNumber(r.rank)}</span>
            <strong className="u-fs-14">{r.card.title}</strong>
          </span>
          <strong className="u-fs-16" title={list.votingMode === 'multi-voter' ? t('colPriorityAgg') : t('colPriority')}>{formatNumber(r.computedPriority)}</strong>
        </div>
        <div className="u-flex u-gap-2 u-wrap u-items-center">
          <span className="chip chip--muted">{r.status.columnName}</span>
          {sched ? (
            <span className={`chip ${SCHEDULE_CHIP_CLASS[sched.state]} u-fs-11`}><ClockIcon size={11} aria-hidden /> {fmtDate(sched.targetDate)}</span>
          ) : null}
          {strategyOn && alignedCount > 0 ? (
            <span className="chip chip--accent"><FlagIcon size={11} aria-hidden /> {t('strategyAlignedCount', { count: alignedCount, formattedCount: formatNumber(alignedCount) })}</span>
          ) : null}
          {list.votingMode === 'multi-voter' ? (
            <button type="button" className="ghost btn-sm" onClick={() => void openBreakdown(r)} aria-label={t('voteBreakdownButtonLabel', { title: r.card.title })}>{t('votesChip', { count: r.voterCount ?? 0, formattedCount: formatNumber(r.voterCount ?? 0) })}</button>
          ) : null}
        </div>
        <span className="muted u-fs-12">{ownerName(r)}</span>
      </article>
    );
  };

  return (
    <div className="u-flex u-flex-col u-gap-4">
      {breakdown ? (
        <Modal label={t('voteBreakdownLabel', { title: breakdown.idea.card.title })} onClose={() => setBreakdown(null)}>
          <h3 className="u-mt-0">{t('voteBreakdownHeading', { title: breakdown.idea.card.title })}</h3>
          {breakdown.entries === 'loading' ? <p className="muted">{t('common:loading')}</p>
            : breakdown.entries === 'error' ? <Notice variant="info">{t('voteBreakdownRestricted')}</Notice>
              : breakdown.entries.length === 0 ? <p className="muted">{t('noVotesYet')}</p>
                : (
                  <>
                    <p className="muted u-fs-12">{t('weightExplainer')}</p>
                    <ul className="u-flex u-flex-col u-gap-2 u-list-none u-p-0">
                      {breakdown.entries.map((v) => {
                        const name = members.find((m) => m.subject === v.voterId)?.displayName ?? v.voterId;
                        return (
                          <li key={v.voterId} className="surface-card u-flex u-flex-row u-items-center u-justify-between u-gap-3 u-wrap">
                            <div className="u-minw-0">
                              <strong className="u-fs-12">{name}</strong>
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
          <div className="action-bar u-mt-3 u-justify-end"><button type="button" className="secondary" onClick={() => setBreakdown(null)}>{t('common:close')}</button></div>
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

      {/* ── List header ── */}
      <div className="surface-card u-flex u-flex-row u-items-center u-justify-between u-gap-3 u-wrap">
        <div className="u-flex u-flex-col u-gap-1 u-minw-0">
          <span className="proj-eyebrow">{t('priorityListEyebrow')}</span>
          <h2 className="u-fs-16 u-m-0">{list.name}</h2>
          <div className="proj-lineup">
            <span className="chip chip--muted">{(() => { const k = (MODEL_LABEL_KEY as Record<string, string>)[list.criteriaSet.presetId ?? '']; return k ? t(k) : t('modelCustom'); })()}</span>
            <span className="chip chip--muted">{list.votingMode === 'multi-voter' ? t('chipMultiVoter', { aggregation: list.voteAggregation }) : t('chipSingleScore')}</span>
            <span className="muted u-fs-12">{t('ideaCount', { count: ideas?.length ?? 0, formattedCount: formatNumber(ideas?.length ?? 0) })}</span>
          </div>
        </div>
        <div className="action-bar">
          <button type="button" className="secondary btn-sm" onClick={() => setEditOpen(true)}>{t('common:edit')}</button>
          <button type="button" className="secondary btn-sm" onClick={() => setCriteriaOpen(true)}><ScaleIcon size={13} /> {t('criteria')}</button>
          <button type="button" className="ghost btn-sm" onClick={() => setConfirmDeleteOpen(true)} aria-label={t('deleteList')}><TrashIcon size={14} /></button>
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
          {schedule && (schedule.rollup.onTrack + schedule.rollup.atRisk + schedule.rollup.behind + schedule.rollup.doneEarly + schedule.rollup.doneLate) > 0 ? (
            <span className={`chip ${SCHEDULE_CHIP_CLASS[schedule.rollup.health]} u-fs-11`} title={t('scheduleRollupSummary', { onTrack: schedule.rollup.onTrack, atRisk: schedule.rollup.atRisk, behind: schedule.rollup.behind })}>
              <ClockIcon size={11} /> {t('scheduleRollupSummary', { onTrack: formatNumber(schedule.rollup.onTrack), atRisk: formatNumber(schedule.rollup.atRisk), behind: formatNumber(schedule.rollup.behind) })}
            </span>
          ) : null}
          {ideas && ideas.length > 0 ? (
            <div className="segmented view-toggle u-ml-auto" role="group" aria-label={t('viewToggleAria')}>
              <button type="button" aria-pressed={ideaView === 'matrix'} disabled={!canMatrix} title={canMatrix ? t('viewMatrix') : t('matrixUnavailable')} onClick={() => setIdeaView('matrix')}>
                <LayoutGridIcon size={14} /> <span className="view-toggle-label">{t('viewMatrix')}</span>
              </button>
              <button type="button" aria-pressed={ideaView === 'grid'} title={t('viewGrid')} onClick={() => setIdeaView('grid')}>
                <BoxesIcon size={14} /> <span className="view-toggle-label">{t('viewGrid')}</span>
              </button>
              <button type="button" aria-pressed={ideaView === 'list'} title={t('viewList')} onClick={() => setIdeaView('list')}>
                <ListOrderedIcon size={14} /> <span className="view-toggle-label">{t('viewList')}</span>
              </button>
            </div>
          ) : null}
        </div>
        {ideas === null ? (
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
            caption={t('captionRankedIdeas')}
            columns={ideaColumns}
            initialSort={{ key: 'rank', dir: 'asc' }}
            selectable
            selected={selection}
            onSelectionChange={setSelection}
            bulkActions={(rows) => (
              <button type="button" className="primary btn-sm" onClick={() => void addToAgenda(rows)}><ClipboardIcon size={13} /> {t('addToAgendaBulk', { n: formatNumber(rows.length) })}</button>
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
    </div>
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
        <button
          type="button"
          className="ghost btn-sm"
          disabled={busy}
          aria-label={t('clearScheduleAria', { title: idea.card.title })}
          onClick={() => void onDate('')}
        >
          <TrashIcon size={12} />
        </button>
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
      <div className="action-bar u-justify-end"><button type="submit" className="primary" disabled={!title.trim() || busy}><PlusIcon size={14} /> {t('addIdea')}</button></div>
    </form>
  );
}

/** ADR 0058/0059 — the scoring model: per-criterion weight sliders + aggregation,
 *  in a modal so the matrix isn't pushed down by an always-open editor. */
function CriteriaModal(props: { list: PriorityList; onClose: () => void; onChanged: () => Promise<void>; onError: (m: string) => void }): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const { list } = props;
  const [weights, setWeights] = useState<Record<string, number>>(() => Object.fromEntries(list.criteriaSet.criteria.map((c) => [c.id, c.weight])));
  const [busy, setBusy] = useState(false);

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
    <Modal label={t('criteriaModalLabel')} onClose={props.onClose}>
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
        <button type="button" className="ghost" onClick={props.onClose} disabled={busy}>{t('common:cancel')}</button>
        <button type="button" className="primary" onClick={() => void save()} disabled={busy}>{busy ? t('common:saving') : t('saveWeights')}</button>
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
  const [n, setN] = useState(5);
  const [busy, setBusy] = useState(false);
  const { agenda } = props;
  // Map the agenda order onto the preview table's initial sort so the live view
  // mirrors the saved doc; keying the table on the order re-applies it on change.
  const previewSort = AGENDA_SORT_COL[props.agendaSort];

  const cols: DataColumn<RankedIdea>[] = [
    { key: 'idea', header: t('colIdea'), render: (r) => <strong>{r.card.title}</strong>, sortValue: (r) => r.card.title },
    { key: 'priority', header: t('colPriority'), align: 'right', render: (r) => <strong>{formatNumber(r.computedPriority)}</strong>, sortValue: (r) => r.computedPriority },
    { key: 'owner', header: t('colOwner'), render: (r) => <span className="muted u-fs-12">{props.ownerName(r)}</span>, sortValue: (r) => props.ownerName(r) },
    { key: 'status', header: t('colStatus'), render: (r) => <span className="muted u-fs-12">{r.status.columnName}</span>, sortValue: (r) => r.status.columnName },
    { key: 'created', header: t('colCreated'), align: 'right', render: (r) => <span className="muted u-fs-12">{fmtDate(r.card.createdAt)}</span>, sortValue: (r) => r.card.createdAt ?? '' },
  ];

  return (
    <section className="surface-card u-flex u-flex-col u-gap-3">
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        <ClipboardIcon size={16} /> <h3 className="u-fs-14 u-m-0">{t('meetingAgenda')}</h3>
        <span className="muted u-fs-12 u-ml-auto">{t('orBuildFromTop')}</span>
        <Field label={t('topN')}>{(w) => <input {...w} type="number" min={1} max={50} value={n} onChange={(e) => setN(Number(e.target.value) || 1)} className="u-w-auto" />}</Field>
        <button type="button" className="secondary btn-sm" disabled={busy} onClick={async () => { setBusy(true); try { await props.onBuildTopN(n); } finally { setBusy(false); } }}><FlagIcon size={13} /> {t('buildTopN', { n: formatNumber(n) })}</button>
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
                <button type="button" className="ghost btn-sm" onClick={() => props.onOpenSession(s)}>{s.name}</button>
                {s.agendaDocumentId ? <span className="muted u-fs-12">{t('savedAsDocument')}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
