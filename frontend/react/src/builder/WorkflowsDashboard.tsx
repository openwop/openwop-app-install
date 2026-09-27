/**
 * Workflows dashboard — list view at `/builder`.
 *
 * Renders saved workflows as a searchable / sortable grid of cards.
 * Each card supports rename (inline), duplicate, delete, and export
 * JSON via a three-dot menu. Persistence is localStorage-only; the
 * `version` counter forces re-reads after mutations.
 */

import { Button } from '../ui/Button.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStorageSubject } from '../platform/useStorageSubject.js';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { newWorkflowId } from './persistence/localStore.js';
// ADR 0163 Phase 3 — the builder dashboard is now backed by the per-tenant
// backend ownership index (durable, assignable), with localStorage as a
// draft/offline cache. The sync localStore API is left intact for other
// consumers (chat @workflow mentions) per the architect review (R-A).
import { archiveWorkflow, unarchiveWorkflow } from '../workflows/workflowsClient.js';
import {
  listWorkflows as listBackendWorkflows,
  loadWorkflow as loadBackendWorkflow,
  saveWorkflow as saveBackendWorkflow,
  removeWorkflow as removeBackendWorkflow,
  migrateLocalToBackend,
  listChainTemplates,
  instantiateChain,
  runsWithZeroConnections,
  type WorkflowSummary,
  type ChainTemplate,
} from './persistence/backendStore.js';
import { AssignWorkflowModal } from './AssignWorkflowModal.js';
import { SetBudgetDialog } from './SetBudgetDialog.js';
import { InstallPackModal } from './InstallPackModal.js';
import { TemplatePreflightModal } from './TemplatePreflightModal.js';
import { toast } from '../ui/toast.js';
import { SyncFailureError } from '../client/config.js';
import type { SavedWorkflow } from './schema/workflow.js';
import { serializeWorkflow } from './schema/serialize.js';
import { PageHeader } from '../ui/PageHeader.js';
import { KeyFigureBand, type KeyFigureItem } from '../ui/KeyFigure.js';
import { formatCurrency, formatDate, formatNumber } from '../i18n/format.js';
import { fetchFleetStats, type FleetStats } from '../workflows/fleetInsightsClient.js';
import { StateCard } from '../ui/StateCard.js';
import { ViewToggle, useViewMode } from '../ui/ViewToggle.js';
import { ArrowUpIcon, ArrowDownIcon, WorkflowIcon } from '../ui/icons/index.js';
import { WorkflowCard, WorkflowRow } from './WorkflowCardViews.js';

type SortBy = 'updated' | 'created' | 'name';
type SortDir = 'asc' | 'desc';

const SORT_LABEL_KEYS: Record<SortBy, string> = {
  updated: 'sortUpdated',
  created: 'sortCreated',
  name: 'sortName',
};

function compareWorkflows(a: WorkflowSummary, b: WorkflowSummary, by: SortBy): number {
  switch (by) {
    case 'name':
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    case 'created':
      return a.createdAt.localeCompare(b.createdAt);
    case 'updated':
      return a.updatedAt.localeCompare(b.updatedAt);
  }
}

export function WorkflowsDashboard() {
  const { t } = useTranslation('builder');
  const nav = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  // ADR 0137 — an accepted Ambient Work Graph suggestion lands here; create a fresh
  // workflow and forward the seed to its canvas (where the AI drawer consumes it).
  useEffect(() => {
    const seed = (location.state as { workGraphSeed?: unknown } | null)?.workGraphSeed;
    if (seed) nav(`/builder/${newWorkflowId()}`, { state: { workGraphSeed: seed }, replace: true });
  }, [location.state, nav]);
  const [query, setQuery] = useState('');
  // ADR 0369 — archived stays out of the default list; the toolbar chip opts in.
  const [showArchived, setShowArchived] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('updated');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [viewMode, setViewMode] = useViewMode('workflows', 'grid');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // The workflow whose "Assign to…" modal is open (ADR 0163 follow-on).
  const [assigning, setAssigning] = useState<{ id: string; name: string } | null>(null);
  // ADR 0482 — the workflow whose Set-budget dialog is open (kebab entry).
  const [budgeting, setBudgeting] = useState<WorkflowSummary | null>(null);
  // Bumped after mutations to re-read localStorage on next render.
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  // ADR 0434 / IDN-3 boot-window tri-state (IDN-11). Same rationale as the
  // prompts page: this list is backend-primary, so a boot-window read is
  // bounded rather than wrong — but it is scoped to the WRONG subject, and
  // nothing re-lists when auth settles. A returning signed-in user can sit on
  // the anonymous (usually empty) list until a mutation bumps `version`.
  // Primitive key, never the object — see chat/hooks/useChatSessions.ts.
  const subjectState = useStorageSubject();
  const subjectKey = subjectState.status === 'user' ? subjectState.subject : subjectState.status;

  // On mount: migrate any local draft workflows into the backend ownership
  // index (best-effort; never deletes localStorage — ADR 0163 R-C). The
  // first-visit template preload lives in its own effect below, keyed on the
  // loaded chains.
  useEffect(() => {
    void (async () => {
      await migrateLocalToBackend();
      refresh();
    })();
  }, []);

  // "Your workflows" — backend-primary (the per-tenant ownership index), with a
  // localStorage fallback baked into listBackendWorkflows for the offline path.
  // `version` is the cache-bust trigger: mutations call refresh() to re-fetch.
  const [all, setAll] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // ADR 0476 — the fleet stats band + per-card chips: ONE bounded aggregation
  // read; fail-soft (the dashboard renders without stats when it errors).
  const [fleet, setFleet] = useState<FleetStats | null>(null);
  const [fleetError, setFleetError] = useState(false);
  useEffect(() => {
    let live = true;
    setFleetError(false);
    void fetchFleetStats()
      .then((f) => { if (live) setFleet(f); })
      .catch(() => { if (live) setFleetError(true); }); // ux-review M6: unavailable ≠ no runs
    return () => { live = false; };
  }, [version]);
  const statsByWorkflow = useMemo(
    () => new Map((fleet?.workflows ?? []).map((w) => [w.workflowId, w])),
    [fleet],
  );
  const fleetFigures = useMemo<KeyFigureItem[]>(() => {
    if (!fleet || fleet.rowsConsidered === 0) return [];
    const terminalOutcomes = fleet.workflows.reduce((a, w) => a + w.completed + w.failed, 0);
    const completed = fleet.workflows.reduce((a, w) => a + w.completed, 0);
    const failed = fleet.workflows.reduce((a, w) => a + w.failed, 0);
    const cost = fleet.workflows.reduce((a, w) => a + w.costUsdTotal, 0);
    const p95s = fleet.workflows.map((w) => w.p95Ms).filter((v): v is number => v !== null);
    return [
      { key: 'runs', label: t('fleetRuns'), value: formatNumber(fleet.rowsConsidered) },
      {
        key: 'success',
        label: t('fleetSuccess'),
        // ux-review H4 — with failures present, cap at 99%: rounding must
        // never display "100%" beside a non-zero failure count.
        value: terminalOutcomes > 0
          ? `${failed > 0 ? Math.min(99, Math.round((completed / terminalOutcomes) * 100)) : Math.round((completed / terminalOutcomes) * 100)}%`
          : '—',
        ...(failed > 0 ? { tone: 'attention' as const } : {}),
      },
      { key: 'p95', label: t('fleetP95'), value: p95s.length > 0 ? t('fleetSeconds', { s: formatNumber(Math.max(...p95s) / 1000, { maximumFractionDigits: 1 }) }) : '—' },
      { key: 'cost', label: t('fleetCost'), value: formatCurrency(cost, 'USD', { maximumFractionDigits: cost > 0 && cost < 0.01 ? 4 : 2 }) },
    ];
  }, [fleet, t]);
  /** ADR 0434 — HTTP status when the workflow list was REFUSED (0 = transport
   *  failure). Non-null means "we could not read your account", which must not
   *  be rendered as an empty account. */
  const [listError, setListError] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    // Boot-window gate (IDN-11). Without this the settle re-runs this effect and
    // `setLoading(true)` below flips a POPULATED list back to the skeleton — a
    // second skeleton the user did not have before, which is a worse artifact
    // than the stale scope it was fixing. Holding the initial skeleton until the
    // subject resolves gives one fetch, one paint, no flash. The subject always
    // settles (auth/localContentAdoption.ts:44-49), so this cannot hang.
    if (subjectKey === 'pending') return;
    setLoading(true);
    setListError(null);
    // ADR 0434 — `listWorkflows` now REJECTS when the server refuses (401/429)
    // instead of quietly returning this device's local drafts as the account's
    // list. That makes a .catch mandatory: without it the rejection is unhandled
    // AND `setLoading(false)` never runs, leaving the dashboard spinning forever.
    void listBackendWorkflows({ includeArchived: showArchived })
      .then((list) => {
        if (live) { setAll(list); setLoading(false); }
      })
      .catch((err: unknown) => {
        if (!live) return;
        setLoading(false);
        setListError(err instanceof SyncFailureError ? err.status : 0);
      });
    return () => { live = false; };
  }, [version, showArchived, subjectKey]);

  // ADR 0163 Phase 4 — the template gallery, fed by installed workflow-chain packs.
  const [chains, setChains] = useState<ChainTemplate[]>([]);
  const [chainsLoading, setChainsLoading] = useState(true);
  const refreshChains = () => {
    setChainsLoading(true);
    void listChainTemplates().then((c) => { setChains(c); setChainsLoading(false); });
  };
  useEffect(refreshChains, []);

  // ADR 0190 — at 30+ chains the flat gallery needs a category cut. The filter
  // derives from the pack-declared category chip (loader `packCategory`); no
  // manifest/schema change. 'all' keeps the Day-1 UX P6 two-tier layout intact.
  const [chainCategory, setChainCategory] = useState('all');
  const chainCategories = useMemo(
    () => [...new Set(chains.map((c) => c.category ?? t('categoryPack')))].sort((a, b) => a.localeCompare(b)),
    [chains, t],
  );
  const visibleChains = chainCategory === 'all'
    ? chains
    : chains.filter((c) => (c.category ?? t('categoryPack')) === chainCategory);

  // First-visit preload (ADR 0163 — replaces the retired toy-example seed):
  // Workflow seeding is owned by the demo seeder (POST /example-data/seed),
  // NOT a silent client effect. The old per-browser preload here minted a fresh
  // random-id copy of every zero-config template on each new browser/incognito/
  // cleared-storage/anon-tenant, producing "X, X-2, X-3" duplicates that no
  // client-side flag could dedup (the server had no idempotency). Removed 2026-07-16.
  // ADR 0163 follow-on — the in-app marketplace (runtime pack install).
  const [installing, setInstalling] = useState(false);

  // "Use template" opens the PRE-FLIGHT first (day-1 UX P3): what the template
  // needs (connections / host packs) + its inputs as optional defaults. The
  // modal's Confirm does the instantiate; params land as the workflow's
  // run-input defaults — never frozen into config.
  const [preflightChain, setPreflightChain] = useState<ChainTemplate | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);

  // Product areas may deep-link to a *pack* workflow, but never instantiate it
  // themselves. Opening the regular preflight preserves the shared builder's
  // requirements review and creates the normal tenant-owned, editable copy.
  const requestedTemplate = searchParams.get('template');
  useEffect(() => {
    if (!requestedTemplate || chainsLoading || preflightChain) return;
    const chain = chains.find((candidate) => candidate.chainId === requestedTemplate);
    if (!chain) return;
    setPreflightError(null);
    setPreflightChain(chain);
    const next = new URLSearchParams(searchParams);
    next.delete('template');
    setSearchParams(next, { replace: true });
  }, [chains, chainsLoading, preflightChain, requestedTemplate, searchParams, setSearchParams]);

  function onUseChain(chain: ChainTemplate) {
    setPreflightError(null);
    setPreflightChain(chain);
  }

  async function onPreflightConfirm(params: Record<string, unknown>) {
    if (!preflightChain) return;
    setPreflightBusy(true);
    setPreflightError(null);
    try {
      const out = await instantiateChain(preflightChain.chainId, params);
      // §Correction (grade-ux TPI-3) — a template copied with blank REQUIRED
      // inputs used to land in the builder indistinguishable from a complete
      // one: no badge, no banner, an enabled Run button. The host computed the
      // gap and only logged it. "Just copy" stays; going silent about the
      // consequence does not.
      if (out.incompleteNodes?.length) {
        const fields = [...new Set(out.incompleteNodes.flatMap((n) => n.missing))];
        toast.warning(t('templateIncompleteConfig', {
          count: out.incompleteNodes.length,
          fields: fields.join(', '),
        }));
      }
      if (out.warnings?.length) {
        toast.warning(t('templateNeedsSetup', { nodes: out.warnings.join(', ') }));
      }
      // UXN-1 — RFC 0133 co-registration receipt: a template with sub-chains
      // ALSO minted its child workflow(s); without this the extra list entry is
      // explained only by the child's own name.
      if (out.subChainWorkflowIds?.length) {
        toast.info(t('templateChildWorkflows', { count: out.subChainWorkflowIds.length }));
      }
      setPreflightChain(null);
      nav(`/builder/${out.workflowId}`);
    } catch {
      setPreflightError(t('templateInstantiateError'));
    } finally {
      setPreflightBusy(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q ? all.filter((wf) => wf.name.toLowerCase().includes(q)) : all;
    const sorted = [...matched].sort((a, b) => compareWorkflows(a, b, sortBy));
    return sortDir === 'desc' ? sorted.reverse() : sorted;
  }, [all, query, sortBy, sortDir]);

  // Single click-outside listener while any kebab menu is open.
  const gridRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (menuOpenId === null) return;
    function onDocClick(e: MouseEvent) {
      const { target } = e;
      if (!(target instanceof Element)) return;
      if (!target.closest('.workflow-card-menu')) setMenuOpenId(null);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpenId]);

  function onCreate() {
    nav(`/builder/${newWorkflowId()}`);
  }

  function onOpen(id: string) {
    nav(`/builder/${id}`);
  }

  /** loadBackendWorkflow throws CanonicalParseError for a definition the
   *  builder can't materialize — surface it, don't leave the action a no-op. */
  /** Save, surfacing a refused write instead of letting it reject unhandled.
   *  Returns true when the backend accepted it (or we are offline, where the
   *  local cache is authoritative and the next save reconciles). */
  async function saveOrToast(wf: SavedWorkflow): Promise<boolean> {
    try {
      await saveBackendWorkflow(wf);
      return true;
    } catch (err) {
      toast.error(err instanceof SyncFailureError && (err.status === 401 || err.status === 403)
        ? t('saveRefusedAuth')
        : t('saveRefused'));
      return false;
    }
  }

  async function loadOrToast(id: string) {
    try {
      return await loadBackendWorkflow(id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function onRenameCommit(id: string, name: string) {
    const trimmed = name.trim();
    setRenamingId(null);
    if (!trimmed) return;
    const wf = await loadOrToast(id);
    // ADR 0434 — saveWorkflow now surfaces a refused write; unguarded it would
    // be an unhandled rejection AND skip refresh().
    if (wf && !(await saveOrToast({ ...wf, name: trimmed, updatedAt: new Date().toISOString() }))) return;
    refresh();
  }

  async function onDuplicate(id: string) {
    setMenuOpenId(null);
    const wf = await loadOrToast(id);
    if (!wf) return;
    const now = new Date().toISOString();
    if (!(await saveOrToast({ ...wf, id: newWorkflowId(), name: `${wf.name} (copy)`, createdAt: now, updatedAt: now }))) return;
    refresh();
  }

  async function onDelete(wf: WorkflowSummary) {
    if (!(await confirm({ title: t('deleteConfirm', { name: wf.name }), danger: true, confirmLabel: t('common:delete') }))) return;
    setMenuOpenId(null);
    try {
      await removeBackendWorkflow(wf.id);
    } catch (err) {
      // ADR 0369 — deletion refused while runs replay against the definition.
      // ADR 0434 — the reason now rides `SyncFailureError.reason`; the old
      // `err.message === 'workflow_referenced'` equality silently stopped
      // matching (the message is now `sync_failed_409: workflow_referenced`),
      // which would have lost this friendly toast and rethrown instead.
      if (err instanceof SyncFailureError && err.reason === 'workflow_referenced') {
        toast.error(t('deleteReferencedBody', { name: wf.name }));
        return;
      }
      throw err;
    }
    refresh();
  }

  async function onArchiveToggle(wf: WorkflowSummary) {
    setMenuOpenId(null);
    try {
      await (wf.archivedAt ? unarchiveWorkflow(wf.id) : archiveWorkflow(wf.id));
      toast.success(wf.archivedAt ? t('unarchivedToast', { name: wf.name }) : t('archivedToast', { name: wf.name }));
    } catch {
      toast.error(t('archiveFailed'));
    }
    refresh();
  }

  async function onExport(id: string) {
    setMenuOpenId(null);
    const wf = await loadOrToast(id);
    if (!wf) return;
    const blob = new Blob([JSON.stringify(serializeWorkflow(wf), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${wf.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'workflow'}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Older Safari/iOS need the URL to outlive the synchronous click.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <section
      className="workflows-dashboard"
      data-walkthrough="workflows.page"
      // H86 — this page has THREE INDEPENDENT async populations, and until now
      // none of them was observable from outside once settled:
      //   `refresh()`            -> `all`    ("Your workflows")
      //   `fetchFleetStats()`    -> `fleet`  (the KeyFigure band)
      //   `listChainTemplates()` -> `chains` (the template gallery)
      //
      // Each is an unchained promise. A caller that waits a fixed interval and
      // then measures the page samples whichever subset happened to land — which
      // is how the `/builder` route snapshot came to assert a page height that
      // FOUR execution contexts disagreed about (15873 / 15959 / 16164 / 16318,
      // none of them the committed baseline, and no common divisor because the
      // three blocks are different sizes).
      //
      // The fleet band is the one that cannot be awaited by its own presence:
      // `fleetFigures` is empty BOTH before the fetch lands AND on a host with
      // no runs, so "wait for the band" would hang forever on a quiet tenant.
      // Hence an explicit settled/erred state rather than a visual proxy — the
      // same reason the `/chat` snapshot pins its toggle and awaits DOM state
      // instead of sleeping: a settle timeout cannot fix a load-order fork.
      data-list-state={loading && all.length === 0 ? 'loading' : listError !== null ? 'error' : 'ready'}
      data-chains-state={chainsLoading ? 'loading' : 'ready'}
      data-fleet-state={fleetError ? 'error' : fleet !== null ? 'ready' : 'loading'}
    >
      <PageHeader
        eyebrow={t('dashboardEyebrow')}
        title={t('dashboardTitle')}
        lede={t('dashboardLede')}
        actions={<Button variant="accent-solid" onClick={onCreate}>{t('newWorkflow')}</Button>}
      />

      {fleetError ? (
        <p className="muted u-fs-11 u-m-0">{t('fleetStatsUnavailable')}</p>
      ) : null}
      {fleetFigures.length > 0 ? (
        <div className="workflows-section">
          <KeyFigureBand figures={fleetFigures} ariaLabel={t('fleetBandAria')} />
          <p className="muted u-fs-11 u-m-0">
            {t('fleetWindowNote', { rows: formatNumber(fleet!.rowsConsidered), since: fleet!.sinceOldest ? formatDate(fleet!.sinceOldest) : '—' })}
          </p>
        </div>
      ) : null}

      <div className="workflows-section">
        <div className="workflows-section-header">
          <h2>{t('yourWorkflows')}</h2>
        </div>

        <div className="workflows-toolbar filterbar">
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('searchByNamePlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="workflows-sort">
            <label htmlFor="wf-sort">{t('sortBy')}</label>
            <select
              id="wf-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
            >
              {(['updated', 'created', 'name'] as SortBy[]).map((k) => (
                <option key={k} value={k}>{t(SORT_LABEL_KEYS[k])}</option>
              ))}
            </select>
            <Button
              variant="secondary" className="workflows-sort-dir"
              onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
              title={sortDir === 'asc' ? t('sortAscendingTitle') : t('sortDescendingTitle')}
              aria-label={t('sortDirectionAria', { dir: sortDir })}
            >
              {sortDir === 'asc' ? <ArrowUpIcon size={14} /> : <ArrowDownIcon size={14} />}
            </Button>
          </div>
          <div className="segmented">
            <Button variant="primary"
              aria-pressed={showArchived}
              onClick={() => setShowArchived((v) => !v)}
            >
              {t('archivedFilter')}
            </Button>
          </div>
          <span className="workflows-toolbar-summary muted">
            {t('filteredOfTotal', { filtered: filtered.length, total: all.length })}
          </span>
          <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
        </div>

        {loading && all.length === 0 ? (
          <StateCard icon={<WorkflowIcon size={20} />} title={t('common:loading')} />
        ) : listError !== null ? (
          /* ADR 0434 — the list was REFUSED. Rendering the empty state here
             would tell the user their account has no workflows, which is the
             same lie the old silent local-cache fallback told. */
          <StateCard
            announce
            icon={<WorkflowIcon size={20} />}
            title={t('listRefusedTitle')}
            body={listError === 401 || listError === 403 ? t('listRefusedAuth') : t('listRefusedRetry')}
            action={
              <Button variant="secondary" size="sm" onClick={refresh}>
                {t('common:retry')}
              </Button>
            }
          />
        ) : all.length === 0 ? (
          <StateCard
            icon={<WorkflowIcon size={20} />}
            title={t('noWorkflowsYet')}
            body={t('noWorkflowsYetHint')}
          />
        ) : filtered.length === 0 ? (
          <StateCard
            icon={<WorkflowIcon size={20} />}
            title={t('noWorkflowsMatch', { query })}
            action={
              <Button variant="secondary" size="sm" onClick={() => { setQuery(''); setShowArchived(false); }}>
                {t('clearFilters')}
              </Button>
            }
          />
        ) : (
          <div className={viewMode === 'grid' ? 'workflows-grid' : 'surface-card list-view'} ref={gridRef}>
            {filtered.map((wf) => {
              const cardProps = {
                wf,
                stats: statsByWorkflow.get(wf.id),
                menuOpen: menuOpenId === wf.id,
                onMenuToggle: () => setMenuOpenId((cur) => (cur === wf.id ? null : wf.id)),
                renaming: renamingId === wf.id,
                onRenameStart: () => {
                  setRenamingId(wf.id);
                  setMenuOpenId(null);
                },
                onRenameCommit: (name: string) => onRenameCommit(wf.id, name),
                onRenameCancel: () => setRenamingId(null),
                onOpen: () => onOpen(wf.id),
                onAssign: () => { setMenuOpenId(null); setAssigning({ id: wf.id, name: wf.name }); },
                onSetBudget: () => { setMenuOpenId(null); setBudgeting(wf); },
                onDuplicate: () => onDuplicate(wf.id),
                onDelete: () => onDelete(wf),
                onExport: () => onExport(wf.id),
                archived: Boolean(wf.archivedAt),
                onArchiveToggle: () => onArchiveToggle(wf),
              };
              return viewMode === 'grid' ? (
                <WorkflowCard key={wf.id} {...cardProps} />
              ) : (
                <WorkflowRow key={wf.id} {...cardProps} />
              );
            })}
          </div>
        )}
      </div>

      <div className="workflows-section">
        <div className="workflows-section-header">
          <h2>{t('templatesFromPacks')}</h2>
          <span className="muted">{t('templatesFromPacksHint')}</span>
          {chainCategories.length > 1 ? (
            <select
              className="u-ml-auto"
              aria-label={t('templateCategoryFilterLabel')}
              value={chainCategory}
              onChange={(e) => setChainCategory(e.target.value)}
            >
              <option value="all">{t('templateCategoryAll')}</option>
              {chainCategories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            {...(chainCategories.length > 1 ? {} : { className: 'u-ml-auto' })}
            onClick={() => setInstalling(true)}
          >
            {t('installPackCta')}
          </Button>
        </div>
        {chainsLoading ? (
          <StateCard icon={<WorkflowIcon size={20} />} title={t('common:loading')} loading />
        ) : chains.length > 0 ? (
          (() => {
            // Day-1 UX P6 — "Start here": templates the host DERIVED as needing
            // zero connections lead the gallery (a guaranteed first win). Older
            // backends (no requirements block) render the flat gallery as before.
            const startHere = visibleChains.filter(runsWithZeroConnections);
            const rest = visibleChains.filter((c) => !runsWithZeroConnections(c));
            if (startHere.length === 0) {
              return (
                <div className="workflows-grid">
                  {visibleChains.map((chain) => (
                    <ChainTemplateCard key={chain.chainId} chain={chain} onUse={() => onUseChain(chain)} />
                  ))}
                </div>
              );
            }
            return (
              <>
                <div className="workflows-section-header">
                  <h3>{t('startHereTitle')}</h3>
                  <span className="muted">{t('startHereHint')}</span>
                </div>
                <div className="workflows-grid">
                  {startHere.map((chain) => (
                    <ChainTemplateCard key={chain.chainId} chain={chain} onUse={() => onUseChain(chain)} />
                  ))}
                </div>
                {rest.length > 0 ? (
                  <>
                    <div className="workflows-section-header">
                      <h3>{t('allTemplatesTitle')}</h3>
                    </div>
                    <div className="workflows-grid">
                      {rest.map((chain) => (
                        <ChainTemplateCard key={chain.chainId} chain={chain} onUse={() => onUseChain(chain)} />
                      ))}
                    </div>
                  </>
                ) : null}
              </>
            );
          })()
        ) : (
          <p className="muted u-fs-13">{t('templatesFromPacksEmpty')}</p>
        )}
      </div>

      {assigning && (
        <AssignWorkflowModal workflow={assigning} onClose={() => setAssigning(null)} />
      )}

      {budgeting && (
        <SetBudgetDialog
          workflow={{ id: budgeting.id, name: budgeting.name, ...(budgeting.budget ? { budget: budgeting.budget } : {}) }}
          onSaved={refresh}
          onClose={() => setBudgeting(null)}
        />
      )}

      {installing && (
        <InstallPackModal
          installedPackNames={[...new Set(chains.map((c) => c.packName))]}
          onInstalled={refreshChains}
          onClose={() => setInstalling(false)}
        />
      )}

      {preflightChain && (
        <TemplatePreflightModal
          chain={preflightChain}
          busy={preflightBusy}
          error={preflightError}
          onConfirm={(params) => { void onPreflightConfirm(params); }}
          onClose={() => setPreflightChain(null)}
        />
      )}
    </section>
  );
}

interface ChainTemplateCardProps {
  chain: ChainTemplate;
  onUse(): void;
}

/** A workflow-chain pack rendered as a template card (mirrors TemplateCard;
 *  a `.chip` marks the source pack). */
function ChainTemplateCard({ chain, onUse }: ChainTemplateCardProps) {
  const { t } = useTranslation('builder');
  return (
    <div className="workflow-card workflow-template-card">
      <div className="workflow-card-title-row">
        <h3 className="workflow-card-title">{chain.label}</h3>
        <span className="chip chip--muted" title={chain.packName}>{chain.category ?? t('categoryPack')}</span>
      </div>
      <p className="workflow-template-description muted">{chain.description}</p>
      <div className="workflow-card-meta muted">
        <span title={chain.packName}>{chain.packName}</span>
        {chain.parameters?.required?.length ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{t('templateAsksQuestions', { count: chain.parameters.required.length })}</span>
          </>
        ) : null}
      </div>
      {/* Zero-connections sits bottom-start, opposite the CTA (align-center
          keeps the chip on the button's midline). */}
      <div className="workflow-template-actions u-justify-between u-items-center">
        {runsWithZeroConnections(chain) ? (
          <span className="chip chip--success">{t('zeroConnectionsChip')}</span>
        ) : (
          <span aria-hidden="true" />
        )}
        <Button variant="primary" onClick={onUse}>{t('useTemplate')}</Button>
      </div>
    </div>
  );
}
