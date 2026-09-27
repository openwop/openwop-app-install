/**
 * Priority Matrix portfolio page (ADR 0058/0060 — see the routing correction
 * note in ADR 0058). Capture ideas into named priority lists and rank them
 * across lists.
 *
 * IA: the LISTS are the primary navigation — a card grid of real links, each
 * to its own URL (`/priority-matrix/:listId` → `PriorityListPage`), replacing
 * the old in-page Portfolio/<list…> tablist. Below the lists sits the
 * cross-list portfolio rollup (ADR 0060) + federated peers admin.
 */

import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUnsavedChangesWarning, useConfirmDiscardUnsaved } from '../../ui/useUnsavedChangesWarning.js';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { confirm } from '../../ui/confirm.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Field, TextField, SelectField, CheckboxField } from '../../ui/Field.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { Modal } from '../../ui/Modal.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { ListOrderedIcon, PlusIcon, TrashIcon, CheckIcon, AlertIcon } from '../../ui/icons/index.js';
import { PriorityListCard, PriorityListRow } from './PriorityListViews.js';
import {
  listPresets, listLists, createList,
  listOrgs, listProjects, listPortfolio,
  listPeers, addPeer, deletePeer, setPeerCredential, listFederatedPortfolio,
  type PriorityList, type CriteriaSet,
  type OrgRef, type ProjectRef, type PresetId, type VotingMode, type PortfolioItem,
  type NormalizeMode, type FederatedPeer, type PeerStatus,
} from './priorityMatrixClient.js';
import { MODEL_LABEL_KEY } from './pmShared.js';

/** Exhaustive over `PresetId` — adding a preset without a label is a type error,
 *  which is what keeps the picker from silently dropping one. */
const PRESET_LABEL_KEY: Record<PresetId, string> = {
  weighted: 'scoringModelWeighted',
  wsjf: 'scoringModelWsjf',
  rice: 'scoringModelRice',
  ice: 'scoringModelIce',
  'value-effort': 'scoringModelValueEffort',
};
const ALL_PRESET_IDS = Object.keys(PRESET_LABEL_KEY) as PresetId[];

export function PriorityMatrixPage(): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const navigate = useNavigate();
  // ADR 0100: a non-project (workspace/org) list is indexed for agents when kb is on.
  const kbEnabled = true; // KB always-on (toggle removed)
  const [lists, setLists] = useState<PriorityList[] | null>(null);
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [presets, setPresets] = useState<CriteriaSet[]>([]);
  const [orgsFailed, setOrgsFailed] = useState(false);
  /** PMX-8c / PMXU-19 (ADR 0590) — the projects read FAILED: project scoping
   *  degrades and the create form's picker is empty for a REASON the user is told. */
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The read FAILED — distinct from `null` (loading) and `[]` (genuinely none).
   *  #2596: the resolution depends on what the EMPTY state says; here it is
   *  "Create one to start" — an invitation to duplicate a list that may exist. */
  const [listsFailed, setListsFailed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // PMXU-7 (ADR 0590) — the create-list modal guarded against a silent
  // backdrop/Escape close discarding a typed name.
  const [createDirty, setCreateDirty] = useState(false);
  const confirmDiscardCreate = useConfirmDiscardUnsaved(createDirty);
  useUnsavedChangesWarning(createOpen && createDirty);
  const guardedCreateClose = (): void => { void confirmDiscardCreate().then((ok) => { if (ok) { setCreateDirty(false); setCreateOpen(false); } }); };

  const refreshLists = useCallback(async () => {
    try {
      setListsFailed(false); setLists(await listLists()); }
    catch (e) {
      setError(e instanceof Error ? e.message : t('loadListsFailed'));
        setListsFailed(true);
    }
  }, [t]);

  useEffect(() => {
    void refreshLists();
    // PM-G1 — a failed orgs read left `orgs` empty, which empties the workspace
    // select, leaves `effectiveOrg` blank, and makes submit silently inert (the
    // handler returns early on `!effectiveOrg`). A dead form with no explanation.
    void listOrgs().then((o) => { setOrgs(o); setOrgsFailed(false); }).catch(() => setOrgsFailed(true));
    // PMX-8c — the literal PM-G1 shape lived one line below the PM-G1 fix: a
    // failed projects read silently collapsed project scoping to workspace-wide.
    void listProjects().then((p) => { setProjects(p); setProjectsFailed(false); }).catch(() => setProjectsFailed(true));
    // PM-G2 — this result was stored, passed as a prop, typed … and never read;
    // the scoring-model select hard-coded all five options. Now it DRIVES the
    // select, so the request stops being wasted and the option list can no
    // longer drift from `CRITERIA_PRESETS`.
    void listPresets().then(setPresets).catch(() => setPresets([]));
  }, [refreshLists]);

  // §4.5 collection-view controls for the lists section: name search + scoring
  // model / scope filters + the shared grid⇄list toggle (ProjectsPage canon).
  const [query, setQuery] = useState('');
  const [fModel, setFModel] = useState('');
  const [fScope, setFScope] = useState<'' | 'workspace' | 'project'>('');
  const [viewMode, setViewMode] = useViewMode('priority-lists', 'grid');
  const projectNameById = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const modelOf = (l: PriorityList): string => (MODEL_LABEL_KEY as Record<string, string>)[l.criteriaSet.presetId ?? ''] ? (l.criteriaSet.presetId ?? '') : 'custom';
  const visible = useMemo(() => (lists ?? []).filter((l) =>
    (!query.trim() || l.name.toLowerCase().includes(query.trim().toLowerCase()))
    && (!fModel || modelOf(l) === fModel)
    && (!fScope || (fScope === 'project' ? Boolean(l.projectId) : !l.projectId)),
  ), [lists, query, fModel, fScope]);

  return (
    <div data-walkthrough="priority-matrix.page">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
        actions={lists && lists.length > 0 ? <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}><PlusIcon size={13} /> {t('newList')}</Button> : undefined}
      />
      {error ? <Notice variant="error">{error}</Notice> : null}
      {projectsFailed ? <Notice variant="warning" announce={t('projectsLoadFailed')}>{t('projectsLoadFailed')}</Notice> : null}

      {createOpen ? (
        <Modal label={t('createModalLabel')} onClose={guardedCreateClose}>
          <h3 className="u-mt-0">{t('createModalHeading')}</h3>
          <CreateListForm
            orgs={orgs} orgsFailed={orgsFailed} projects={projects} projectsFailed={projectsFailed} presets={presets}
            onCreated={async (l) => { navigate(`/priority-matrix/${encodeURIComponent(l.id)}`); }}
            onError={setError}
            onDirtyChange={setCreateDirty}
          />
        </Modal>
      ) : null}

      {lists === null && listsFailed ? (
        // NOT an empty list: "No priority lists yet — create one to start"
        // invites duplicating a list that may exist.
        <StateCard announce icon={<ListOrderedIcon size={20} />} title={t('listsLoadFailedTitle')} body={t('listsLoadFailedBody')} />
      ) : lists === null ? (
        <StateCard icon={<ListOrderedIcon size={20} />} title={t('loadingLists')} loading />
      ) : lists.length === 0 ? (
        <StateCard
          icon={<ListOrderedIcon size={22} />}
          title={t('noListsTitle')}
          body={t('noListsBody')}
          action={<Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}><PlusIcon size={13} /> {t('createFirstList')}</Button>}
        />
      ) : (
        <>
          {/* Every list has its own URL — the cells are real links
              (cmd/middle-click, share), the ProjectViews precedent; search +
              filters + grid⇄list per the §4.5 collection canon. */}
          <section className="u-mb-4" aria-label={t('listsHeading')}>
            <div className="u-flex u-items-center u-gap-2 u-mb-2">
              <ListOrderedIcon size={16} /> <h2 className="u-fs-16 u-m-0">{t('listsHeading')}</h2>
            </div>
            <div className="filterbar u-mb-3" role="group" aria-label={t('filterGroup')}>
              {lists.length > 3 ? (
                <input
                  type="search"
                  className="ui-input filterbar-search"
                  placeholder={t('filterPlaceholder')}
                  aria-label={t('filterAria')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              ) : null}
              {/* Facet selects self-describe via their "All …" option (the marketplace
                  filterbar pattern) — an eyebrow label would break the one-row baseline. */}
              <select className="ui-input filterbar-select" value={fModel} onChange={(e) => setFModel(e.target.value)} aria-label={t('filterModel')}>
                <option value="">{t('filterAllModels')}</option>
                {Object.keys(MODEL_LABEL_KEY).map((m) => <option key={m} value={m}>{t((MODEL_LABEL_KEY as Record<string, string>)[m]!)}</option>)}
                <option value="custom">{t('modelCustom')}</option>
              </select>
              <select className="ui-input filterbar-select" value={fScope} onChange={(e) => setFScope(e.target.value as '' | 'workspace' | 'project')} aria-label={t('filterScope')}>
                <option value="">{t('filterAllScopes')}</option>
                <option value="workspace">{t('workspaceWide')}</option>
                <option value="project">{t('scopeProject')}</option>
              </select>
              <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
            </div>
            {visible.length === 0 ? (
              <StateCard
                icon={<ListOrderedIcon size={20} />}
                title={t('noMatchTitle')}
                body={t('noMatchBody')}
                action={<Button variant="secondary" onClick={() => { setQuery(''); setFModel(''); setFScope(''); }}>{t('clearSearch')}</Button>}
              />
            ) : viewMode === 'grid' ? (
              <div className="card-grid">
                {visible.map((l) => (
                  <PriorityListCard key={l.id} l={l} {...(l.projectId && projectNameById.get(l.projectId) ? { projectName: projectNameById.get(l.projectId)! } : {})} kbEnabled={kbEnabled} />
                ))}
              </div>
            ) : (
              <div className="surface-card list-view">
                {visible.map((l) => (
                  <PriorityListRow key={l.id} l={l} {...(l.projectId && projectNameById.get(l.projectId) ? { projectName: projectNameById.get(l.projectId)! } : {})} kbEnabled={kbEnabled} />
                ))}
              </div>
            )}
          </section>

          <PortfolioSection onError={setError} />
        </>
      )}
    </div>
  );
}

// ─── portfolio (cross-list rollup, ADR 0060) ─────────────────────────────────────

/**
 * Ranking meter — the printed value plus a proportional clay fill on a quiet
 * track, so the ranking's magnitude falloff reads at a glance instead of by
 * mental division (the RunCostPanel cost-bar precedent, given a track so a
 * bottom-of-list fraction still registers). The number carries the datum; the
 * bar is decorative (aria-hidden). Width is data-driven, like `.cost-bar`.
 * Exported for tests.
 */
export function PriorityMeter({ value, max }: { value: number; max: number }): JSX.Element {
  const fraction = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <span className="pm-meter">
      <strong className={value === 0 ? 'pm-meter__value pm-meter__value--zero' : 'pm-meter__value'}>{formatNumber(value)}</strong>
      <span className="pm-meter__track" aria-hidden>
        <span className="pm-meter__fill" data-testid="pm-meter-fill" style={{ width: `${fraction * 100}%` }} />
      </span>
    </span>
  );
}

function PortfolioSection(props: { onError: (m: string) => void }): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  // PMX-7 (ADR 0590) — destructure the stable callback: with `props` in the
  // load deps, EVERY parent render (each keystroke in the list filter, every
  // modal open/close) minted a new `load` and its effect fired a real
  // GET /portfolio — 12 chars of search burned 12 of the 60 req/min budget.
  const { onError } = props;
  const [items, setItems] = useState<Array<PortfolioItem & { source?: string }> | null>(null);
  // R2 PM2-B4 — the catch below reported the error to the page banner and never touched
  // `items`, which stays `null` — and `null` renders the LOADING card. So the cross-list
  // portfolio, the whole point of this section, spun forever: a user who scrolled past
  // the banner read it as "still computing", and Refresh re-ran the same path.
  const [failed, setFailed] = useState(false);
  const [listCount, setListCount] = useState(0);
  // PMXU-12 (ADR 0590) — the R2 forms-pass number-field pattern: raw string
  // while typing (the old `Number(...) || 1` snapped a cleared field to 1 and
  // fetched topN=1 mid-edit); only a VALID value updates the effective topN.
  const [topNRaw, setTopNRaw] = useState('20');
  const [topN, setTopN] = useState(20);
  const topNParsed = Number(topNRaw);
  const topNValid = Number.isInteger(topNParsed) && topNParsed >= 1 && topNParsed <= 200;
  const onTopNChange = (raw: string): void => {
    setTopNRaw(raw);
    const v = Number(raw);
    if (Number.isInteger(v) && v >= 1 && v <= 200) setTopN(v);
  };
  const [normalize, setNormalize] = useState<NormalizeMode>('none');
  const [federated, setFederated] = useState(false);
  const [peerStatus, setPeerStatus] = useState<PeerStatus[]>([]);
  const [busy, setBusy] = useState(false);

  // PMX-9 (ADR 0590) — sequence token: a slow topN=200 response resolving after
  // a newer topN=20 must not repaint over it (and must not clear the newer
  // request's busy flag from its shared `finally`).
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setBusy(true);
    setFailed(false);
    try {
      if (federated) {
        const p = await listFederatedPortfolio(topN);
        if (seq !== loadSeq.current) return;
        setItems(p.items); setPeerStatus(p.peers); setListCount(0);
      } else {
        const p = await listPortfolio(topN, undefined, normalize);
        if (seq !== loadSeq.current) return;
        setItems(p.items); setListCount(p.lists.length); setPeerStatus([]);
      }
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setFailed(true); onError(e instanceof Error ? e.message : t('loadPortfolioFailed'));
    }
    finally { if (seq === loadSeq.current) setBusy(false); }
  }, [topN, normalize, federated, onError, t]);

  useEffect(() => { void load(); }, [load]);

  const ranked = (items ?? []).map((it, i) => ({ ...it, globalRank: i + 1 }));
  type Row = typeof ranked[number];
  const modelLabel = (code: string): string => {
    const key = (MODEL_LABEL_KEY as Record<string, string>)[code];
    return key ? t(key) : code;
  };
  // The meter rides whichever column the current mode ranks by (normalized when
  // a Compare mode is on, raw otherwise); the other numeric column stays plain.
  const showNormalized = !federated && normalize !== 'none';
  const rankValueOf = (r: Row): number => (showNormalized ? (r.normalizedPriority ?? 0) : r.computedPriority);
  const meterMax = ranked.reduce((m, r) => Math.max(m, rankValueOf(r)), 0);
  const cols: DataColumn<Row>[] = [
    { key: 'rank', header: t('colRank'), width: '44px', render: (r) => formatNumber(r.globalRank), sortValue: (r) => r.globalRank },
    { key: 'idea', header: t('colIdea'), render: (r) => <strong>{r.title}</strong>, sortValue: (r) => r.title },
    ...(federated ? [{ key: 'source', header: t('colSource'), render: (r: Row) => <span className="muted u-fs-12">{r.source ?? t('sourceLocal')}</span> } as DataColumn<Row>] : []),
    { key: 'list', header: t('colList'), render: (r) => <span>{r.listName} <span className="muted u-fs-12">{t('listCell', { rank: formatNumber(r.inListRank), model: modelLabel(r.scoringModel) })}</span></span>, sortValue: (r) => r.listName },
    { key: 'status', header: t('colStatus'), render: (r) => <span className="chip chip--muted">{r.status}</span>, sortValue: (r) => r.status },
    {
      key: 'priority', header: t('colPriority'), align: 'right', ...(showNormalized ? {} : { width: '160px' }),
      render: (r) => (showNormalized ? <strong className="pm-meter__value">{formatNumber(r.computedPriority)}</strong> : <PriorityMeter value={r.computedPriority} max={meterMax} />),
      sortValue: (r) => r.computedPriority,
    },
    ...(showNormalized ? [{
      key: 'normalized', header: normalize === 'percentile' ? t('colPercentile') : t('colNormalized'), align: 'right' as const, width: '160px',
      render: (r: Row) => <PriorityMeter value={r.normalizedPriority ?? 0} max={meterMax} />, sortValue: (r: Row) => r.normalizedPriority ?? 0,
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
          <Field label={t('topN')}>{(w) => <input {...w} type="number" min={1} max={200} value={topNRaw} aria-invalid={topNValid ? undefined : true} onChange={(e) => onTopNChange(e.target.value)} className="u-w-auto" />}</Field>
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={busy}>{t('common:refresh')}</Button>
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
      {/* R2 review — the guard used to be `items === null && failed`, which only covers a
          COLD load. After any successful first load `items` is non-null forever, so a
          failing Refresh set an invisible flag, left the table showing yesterday's
          ranking, and the user read it as current — the same failed-read-as-success
          family, one state later, and the more common one (people refresh far more often
          than they cold-load). */}
      {failed && items !== null ? (
        <Notice variant="warning" announce={t('portfolioStale')}>
          {t('portfolioStale')} <Button variant="link" onClick={() => void load()}>{t('common:retry')}</Button>
        </Notice>
      ) : null}
      {items === null && failed ? (
        <StateCard announce icon={<ListOrderedIcon size={18} />} title={t('loadPortfolioFailedTitle')} body={t('loadPortfolioFailedBody')} action={<Button variant="primary" size="sm" onClick={() => void load()}>{t('common:retry')}</Button>} />
      ) : items === null ? (
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
  /** PMX-8c / PMXU-19 (ADR 0590) — a failed peers read is said, not rendered
   *  as "Federated peers (0)" (a silently inert admin surface). */
  const [peersFailed, setPeersFailed] = useState(false);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setPeers(await listPeers()); setPeersFailed(false); } catch { setPeersFailed(true); }
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
  const onDelete = async (id: string, label: string): Promise<void> => {
    if (!(await confirm({ title: t('removePeerConfirm', { label }), danger: true, confirmLabel: t('common:remove') }))) return;
    try { await deletePeer(id); await refresh(); props.onChanged(); }
    catch (er) { props.onError(er instanceof Error ? er.message : t('removePeerFailed')); }
  };

  return (
    <details className="u-mt-3">
      <summary className="muted u-fs-12">{peersFailed ? t('peersLoadFailedSummary') : t('federatedPeers', { n: formatNumber(peers.length) })}</summary>
      {peersFailed ? (
        <Notice variant="warning" announce={t('peersLoadFailed')}>{t('peersLoadFailed')} <Button variant="link" onClick={() => void refresh()}>{t('common:retry')}</Button></Notice>
      ) : null}
      <form className="surface-form u-mt-2" onSubmit={(e) => void onAdd(e)}>
        <TextField label={t('peerLabel')} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('peerLabelPlaceholder')} />
        <TextField label={t('baseUrl')} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={t('baseUrlPlaceholder')} />
        <Button variant="primary" type="submit" disabled={!label.trim() || !baseUrl.trim() || busy}><PlusIcon size={14} /> {t('addPeer')}</Button>
      </form>
      {peers.length > 0 ? (
        <ul className="u-mt-2 u-flex u-flex-col u-gap-2 u-list-none u-p-0">
          {peers.map((p) => (
            <li key={p.id} className="u-flex u-flex-col u-gap-1">
              <div className="u-flex u-items-center u-gap-2">
                <strong className="u-fs-12">{p.label}</strong> <span className="muted u-fs-12">{p.baseUrl}</span>
                <Button variant="quiet" size="sm" className="u-ml-auto" onClick={() => void onDelete(p.id, p.label)} aria-label={t('removePeerLabel', { label: p.label })}><TrashIcon size={14} /></Button>
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
      <Button type="submit" variant="secondary" disabled={!token.trim() || busy}>{t('common:save')}</Button>
      {saved ? <span className="muted u-fs-12">{t('saved')}</span> : null}
    </form>
  );
}

// ─── create list ───────────────────────────────────────────────────────────────

function CreateListForm(props: {
  orgs: OrgRef[]; orgsFailed: boolean; projects: ProjectRef[]; projectsFailed: boolean; presets: CriteriaSet[];
  onCreated: (l: PriorityList) => Promise<void>; onError: (m: string) => void;
  /** PMXU-7 (ADR 0590) — lifts the form's dirty state so the parent modal's
   *  close can guard against silently discarding a typed name. */
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const [name, setName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [presetId, setPresetId] = useState<PresetId>('weighted');
  const [votingMode, setVotingMode] = useState<VotingMode>('single');
  const [busy, setBusy] = useState(false);
  const { onDirtyChange } = props;
  useEffect(() => { onDirtyChange(name.trim().length > 0); }, [name, onDirtyChange]);

  const effectiveOrg = orgId || props.orgs[0]?.orgId || '';
  // Prefer the server's list; fall back to every known id so the picker is never
  // empty just because the presets read failed.
  const presetOptions: PresetId[] = props.presets.length > 0
    ? props.presets.flatMap((c) => (c.presetId ? [c.presetId] : []))
    : ALL_PRESET_IDS;
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
        <SelectField
          label={t('workspace')}
          value={effectiveOrg}
          onChange={(e) => { setOrgId(e.target.value); setProjectId(''); }}
          {...(props.orgsFailed ? { error: t('orgsLoadFailed') } : {})}
        >
          {props.orgs.length === 0 ? <option value="">{props.orgsFailed ? t('orgsUnavailable') : t('noWorkspaces')}</option> : null}
          {props.orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
        <SelectField
          label={t('projectOptional')} value={projectId} onChange={(e) => setProjectId(e.target.value)}
          {...(props.projectsFailed ? { error: t('projectsUnavailable') } : {})}
        >
          <option value="">{t('workspaceWide')}</option>
          {orgProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </SelectField>
        {/* PM-G2 — driven by the fetched presets (falling back to the built-in
            ids when the read fails, so behaviour is never worse than before).
            Labels stay locally translated — better copy than the server's — and
            `PRESET_LABEL_KEY` is exhaustive over `PresetId`, so a new preset is
            a compile error rather than a silently missing option. */}
        <SelectField label={t('scoringModel')} value={presetId} onChange={(e) => setPresetId(e.target.value as PresetId)}>
          {presetOptions.map((id) => <option key={id} value={id}>{t(PRESET_LABEL_KEY[id])}</option>)}
        </SelectField>
        <SelectField label={t('scoringMode')} value={votingMode} onChange={(e) => setVotingMode(e.target.value as VotingMode)}>
          <option value="single">{t('scoringModeSingle')}</option>
          <option value="multi-voter">{t('scoringModeMulti')}</option>
        </SelectField>
      </div>
      <div className="action-bar u-justify-end">
        <Button variant="primary" type="submit" disabled={!effectiveOrg || !name.trim() || busy}><PlusIcon size={14} /> {t('createList')}</Button>
      </div>
    </form>
  );
}
