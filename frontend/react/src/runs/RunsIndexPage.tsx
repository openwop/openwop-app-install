import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { scrollBehavior } from '../ui/motion.js';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { DataTable, type DataColumn } from '../ui/DataTable.js';
import { ViewToggle, useViewMode } from '../ui/ViewToggle.js';
import { RunCard, RunFlagChip } from './RunViews.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { toast } from '../ui/toast.js';
import { getWorkflowDefinitionRaw } from '../client/workflowsClient.js';
import { createRun, listMyRuns, type RunListItem } from '../client/runsClient.js';
import { redriveRuns, type RedriveResult } from '../workflows/workflowDebugClient.js';
import { classifyHttpError } from '../client/classifyHttpError.js';
import { StatusBadge } from '../ui/StatusBadge.js';
import type { Annotation } from '../client/feedbackClient.js';
import { useRunAnnotations, reviewOf, needsReview, reviewReason } from './useRunAnnotations.js';
import { formatDuration } from './format.js';
import { listSavedWorkflows } from '../builder/persistence/localStore.js';
import { definitionMetadataFor } from '../builder/persistence/definitionMetadata.js';
import { serializeWorkflow, SerializeError } from '../builder/schema/serialize.js';
import { registerWorkflow, fetchRegisteredWorkflow } from '../builder/persistence/registerClient.js';
import { useAuth } from '../auth/useAuth.js';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { Notice } from '../ui/Notice.js';
import { KeyFigureBand, type KeyFigureItem } from '../ui/KeyFigure.js';
import { FlagIcon, PlayIcon, RotateCwIcon, PlusIcon, SearchIcon } from '../ui/icons/index.js';
import { SelectField, TextareaField } from '../ui/Field.js';
import { demoModeCached } from '../client/demoMode.js';
import { useDemoMode } from '../client/useDemoMode.js';
import { SchemaInputForm } from './SchemaInputForm.js';
import { isRenderableSchema, type SchemaObject } from './inputSchemaForm.js';
import { formatNumber, formatDateTime, formatPercent } from '../i18n/format.js';
import { Tabs, TabPanel, useUrlTab } from '../ui/Tabs.js';
import { ActiveRunsTab } from './ActiveRunsTab.js';

const EXAMPLE_WORKFLOWS = [
  { id: 'openwop-app.uppercase', labelKey: 'exampleWorkflowUppercase' },
  { id: 'openwop-app.approval-gate', labelKey: 'exampleWorkflowApprovalGate' },
];

// Outcome buckets shared by the figure band (which doubles as a status filter)
// and the table predicate, so a tile and the rows it filters always agree.
type RunStatusBucket = 'completed' | 'failed' | 'cancelled' | 'awaiting';
function statusBucket(status: string): RunStatusBucket | null {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status.startsWith('waiting') || status === 'suspended' || status === 'paused') return 'awaiting';
  return null;
}

export function RunsIndexPage() {
  const { t } = useTranslation('runs');
  const nav = useNavigate();
  // The live "Active runs" view (formerly the standalone /mission Mission Control)
  // is folded in as a deep-linkable tab (?tab=active); /mission redirects here.
  const [tab, setTab] = useUrlTab<'runs' | 'active'>('tab', ['runs', 'active'], 'runs');
  const { user, isConfigured } = useAuth();
  // Built-in example workflows are optional scaffolding — offered only on the public
  // showcase deployment, never on a clean / white-label install. (This page's
  // inline cached+load pattern was extracted to useDemoMode — ADR 0196 Phase 3.)
  const demo = useDemoMode();
  const savedWorkflows = useMemo(() => listSavedWorkflows(), []);
  const allOptions = useMemo(
    () => [
      ...(demo ? EXAMPLE_WORKFLOWS.map((wf) => ({ id: wf.id, label: t(wf.labelKey) })) : []),
      ...savedWorkflows.map((wf) => ({
        id: wf.id,
        label: t('savedWorkflowOption', { name: wf.name, count: wf.nodes.length }),
      })),
    ],
    [savedWorkflows, demo, t],
  );
  const [workflowId, setWorkflowId] = useState('');
  // Pick the first option once the (feature-gated) list resolves; never overwrite a
  // user's explicit choice.
  useEffect(() => { setWorkflowId((cur) => cur || allOptions[0]?.id || ''); }, [allOptions]);
  const [inputsRaw, setInputsRaw] = useState(() => (demoModeCached() ? JSON.stringify({ text: 'hello world' }, null, 2) : '{}'));
  // ADR 0197 Phase 2 — schema-driven inputs: when the toggle is on and the
  // selected workflow's definition declares a renderable `inputSchema`, the
  // launch form renders SchemaInputForm over the SAME inputsRaw string
  // (raw-JSON stays the fallback + escape hatch). The definition read is the
  // the shared definition read (returns the definition verbatim, incl.
  // inputSchema — no backend change); one fetch per selection, stale-guarded.
  const [inputSchema, setInputSchema] = useState<SchemaObject | null>(null);
  useEffect(() => {
    setInputSchema(null);
    if (!workflowId) return;
    let stale = false;
    void (async () => {
      try {
        const def = await getWorkflowDefinitionRaw(workflowId); // schema-less UX (textarea) on any read failure
        if (!stale && def && isRenderableSchema(def.inputSchema)) setInputSchema(def.inputSchema);
      } catch {
        /* keep the textarea fallback */
      }
    })();
    return () => { stale = true; };
  }, [workflowId]);
  const [submitting, setSubmitting] = useState(false);
  // ADR 0729 D1 — does the SCHEMA FORM currently refuse this payload? The form owns the
  // answer (it is the thing rendering the per-field errors); the page owns the submit.
  const [formBlocking, setFormBlocking] = useState(false);
  const onBlockingChange = useCallback((b: boolean) => setFormBlocking(b), []);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  // Grade-ux #8 — the list was hard-capped at the 20 newest rows, so bulk
  // redrive (batches of 25) could never even SEE a full batch. Load more
  // grows the window.
  const [runsLimit, setRunsLimit] = useState(20);
  const [runsError, setRunsError] = useState<string | null>(null);

  // §C3 — annotation-driven review queue. One capability-gated fan-out shared
  // by the flagged filter (here) and the §C2 quality rollup (RunsSummary).
  const runIds = useMemo(() => runs.map((r) => r.runId), [runs]);
  const { byRun, feedbackOn, degraded: annotationsDegraded } = useRunAnnotations(runIds);
  const [reviewOnly, setReviewOnly] = useState(false);
  // §4.5 "stats are filters" — the figure tiles below double as a status
  // filter on the table. null = no status filter (the "Total" tile, or none).
  const [statusFilter, setStatusFilter] = useState<RunStatusBucket | null>(null);
  // ADR 0475 — bulk redrive of terminal failed/cancelled runs. Selection is a
  // set of run ids; only redrivable rows offer a checkbox.
  const [redriveSelected, setRedriveSelected] = useState<Set<string>>(new Set());
  const [redriveBusy, setRedriveBusy] = useState(false);
  const [redriveOutcome, setRedriveOutcome] = useState<RedriveResult[] | null>(null);
  const isRedrivable = useCallback(
    (r: RunListItem): boolean => r.status === 'failed' || r.status === 'cancelled',
    [],
  );
  const isFlagged = useCallback(
    (runId: string) => needsReview(reviewOf(byRun.get(runId) ?? [])),
    [byRun],
  );
  const flaggedCount = useMemo(
    () => runs.filter((r) => isFlagged(r.runId)).length,
    [runs, isFlagged],
  );
  const reviewFiltered = useMemo(() => {
    let base = reviewOnly ? runs.filter((r) => isFlagged(r.runId)) : runs;
    if (statusFilter) base = base.filter((r) => statusBucket(r.status) === statusFilter);
    return base;
  }, [runs, reviewOnly, isFlagged, statusFilter]);
  // Scroll the create-run form into view + focus it (the PageHeader / empty-state
  // "Create a run" CTAs point here rather than at prose "above").
  const createFormRef = useRef<HTMLFormElement | null>(null);
  const focusCreateForm = useCallback(() => {
    const form = createFormRef.current;
    if (!form) return;
    form.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    form.querySelector<HTMLElement>('select, textarea, button')?.focus();
  }, []);
  // Free-text filter, persisted in the URL (?q=) so a filtered view is
  // shareable + survives reload (gap analysis #4). Matches run id or workflow.
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const setQuery = useCallback((q: string) => {
    const next = new URLSearchParams(searchParams);
    if (q) next.set('q', q); else next.delete('q');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const visibleRuns = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return reviewFiltered;
    return reviewFiltered.filter((r) => r.runId.toLowerCase().includes(q) || r.workflowId.toLowerCase().includes(q));
  }, [reviewFiltered, query]);
  // List/grid collection view (§4.5 canon), persisted per-user. `list` keeps the
  // sortable table (the run-ledger default); `grid` shows run cards.
  const [view, setView] = useViewMode('runs', 'list');

  async function onRedriveSelected(): Promise<void> {
    // The backend caps a batch at 25 — take the first 25 and KEEP the
    // remainder selected (ux-review M2: never silently drop part of a bulk
    // action); the outcome notice reports the remainder count.
    const all = [...redriveSelected];
    const ids = all.slice(0, 25);
    const remainder = all.slice(25);
    if (ids.length === 0) return;
    setRedriveBusy(true);
    setRedriveOutcome(null);
    try {
      const results = await redriveRuns(ids);
      setRedriveOutcome(results);
      setRedriveSelected(new Set(remainder));
      await refreshRuns();
    } catch (err) {
      setRunsError(t('redriveRequestFailed'));
      void err;
    } finally {
      setRedriveBusy(false);
    }
  }

  async function refreshRuns(signal?: AbortSignal) {
    setRunsLoading(true);
    setRunsError(null);
    try {
      const list = await listMyRuns({ limit: runsLimit, ...(signal ? { signal } : {}) });
      setRuns(list);
    } catch (err) {
      // Ignore the abort fired by effect cleanup on unmount (GAP-ANALYSIS E15).
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      // Friendly transport copy (GAP-ANALYSIS E5) — a busy page hitting the
      // per-IP budget shows "Too many requests, retry" instead of a raw
      // "listMyRuns failed: 429".
      const c = classifyHttpError(err);
      setRunsError(`${c.title} — ${c.detail}`);
    } finally {
      if (!signal?.aborted) setRunsLoading(false);
    }
  }

  useEffect(() => {
    // Abort the in-flight read on unmount / tenant change (GAP-ANALYSIS E15).
    const ctrl = new AbortController();
    void refreshRuns(ctrl.signal);
    // Refresh whenever sign-in state flips so the user sees their
    // new tenant's runs after migration.
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshRuns identity changes every render; refetch on uid/limit only
  }, [user?.uid, runsLimit]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // ADR 0729 D1 — the form has ALREADY told the user this value is wrong, in their
    // language, beside the field. Posting it anyway spent a round trip to be told the
    // same thing worse (`RIU-2`: the 400 surfaces as a raw SDK string). Refuse locally
    // and put the cursor on the first offending control instead. Form mode only: the
    // JSON escape hatch reports itself non-blocking, so it stays the way out.
    if (formBlocking) {
      const first = createFormRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      first?.focus();
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const inputs = JSON.parse(inputsRaw);
      // Builder-saved workflows need to be registered with the backend's
      // in-memory catalog before POST /v1/runs can resolve them.
      const saved = savedWorkflows.find((w) => w.id === workflowId);
      if (saved) {
        // ADR 0524 — register ONLY when the backend cannot already resolve it.
        //
        // `saved` comes from localStorage, and a record written by a pre-ADR-0523
        // bundle carries no node `inputs` (the old deserializer never read them).
        // Registering it overwrites the server head with the stale copy — and
        // because the staleness lives in browser storage rather than in the
        // bundle, a refresh does NOT heal it. A workflow the user only ever RUNS
        // never gets healed at all. The register exists solely so `POST /v1/runs`
        // can resolve the definition, so when the head already exists this write
        // is pure downside.
        // FAIL CLOSED. A probe error (429 / 5xx / offline) used to fall through to
        // the register — i.e. the DESTRUCTIVE branch — and CLAUDE.md documents the
        // per-IP read budget as a real 429 source on fan-out pages, so that is not
        // theoretical. Skipping the register instead costs a loud 404 from
        // `POST /v1/runs` for a workflow that exists only locally; overwriting costs
        // the authored values silently. This ADR's whole thesis is that a loud
        // failure beats a silent loss.
        let probe: unknown | null = null;
        let probeFailed = false;
        try { probe = await fetchRegisteredWorkflow(workflowId); } catch { probeFailed = true; }
        if (!probe && !probeFailed) {
          const def = serializeWorkflow(saved);
          // ADR 0440 P1 — carry the definition metadata. The route replaces the
          // definition wholesale, so registering without it erases walkthrough
          // flags, handoff gates, retention and chain provenance.
          await registerWorkflow({ ...def, metadata: definitionMetadataFor(saved) });
        }
      }
      // Tenant is no longer carried in the request body — the backend
      // derives it from the authenticated principal (cookie or OIDC).
      // Sending an empty string still satisfies the schema; the auth
      // middleware overrides it with the principal's tenant.
      const res = await createRun({ workflowId, tenantId: '', inputs });
      void refreshRuns();
      toast.success(t('runCreatedToast', { runId: res.runId.slice(0, 8) }));
      nav(`/runs/${res.runId}`);
    } catch (err) {
      if (err instanceof SerializeError) {
        setError(t('savedWorkflowNotRunnable', { message: err.message }));
      } else {
        // ADR 0482 (ux-1) — a budget-exhausted 429 gets the honest localized
        // budget sentence instead of the raw SDK message.
        const c = classifyHttpError(err);
        setError(c.kind === 'budget-exhausted'
          ? t('common:errorBudgetExhausted')
          : err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const tenantScope = isConfigured && user
    ? t('signedInAs', { name: user.displayName ?? user.email ?? user.uid })
    : t('anonymousSession');

  const runColumns = useMemo<DataColumn<RunListItem>[]>(() => [
    {
      key: 'run',
      header: t('runColRun'),
      render: (r) => (
        <>
          <Link to={`/runs/${r.runId}`} onClick={(e) => e.stopPropagation()}><code>{r.runId.slice(0, 8)}…</code></Link>
          <RunFlagChip flagged={isFlagged(r.runId)} reason={reviewReason(reviewOf(byRun.get(r.runId) ?? []))} />
        </>
      ),
    },
    { key: 'workflow', header: t('runColWorkflow'), render: (r) => r.workflowId, sortValue: (r) => r.workflowId },
    { key: 'status', header: t('runColStatus'), render: (r) => <StatusBadge status={r.status} />, sortValue: (r) => r.status },
    {
      key: 'started',
      header: t('runColStarted'),
      cellClassName: 'muted',
      render: (r) => (r.startedAt ? formatDateTime(r.startedAt) : '—'),
      sortValue: (r) => (r.startedAt ? Date.parse(r.startedAt) : 0),
    },
  ], [isFlagged, byRun, t]);

  // Shared empty/loading node — rendered in place of BOTH the grid and the list
  // when there are no visible runs, so the two views stay consistent.
  const runsEmptyState = runsLoading ? (
    <SkeletonRows rows={4} columns={[90, 180, 80, 150]} />
  ) : runs.length === 0 ? (
    <StateCard
      icon={<PlayIcon size={22} />}
      title={t('noRunsYetTitle')}
      body={t('noRunsYetBody')}
      action={
        <Button variant="accent-solid" onClick={focusCreateForm}>
          <PlusIcon size={14} /> {t('createARun')}
        </Button>
      }
    />
  ) : reviewOnly ? (
    <StateCard
      icon={<FlagIcon size={22} />}
      title={t('nothingFlaggedTitle')}
      body={t('nothingFlaggedBody')}
      action={
        <Button variant="secondary" onClick={() => setReviewOnly(false)}>
          {t('showAllRuns')}
        </Button>
      }
    />
  ) : (
    <StateCard
      icon={<SearchIcon size={22} />}
      title={t('noRunsMatchTitle')}
      body={t('noRunsMatchBody')}
      action={
        <Button variant="secondary" onClick={() => { setQuery(''); setStatusFilter(null); }}>
          {t('clearFilter')}
        </Button>
      }
    />
  );

  return (
    <section className="page-enter" data-walkthrough="runs.page">
      <PageHeader
        eyebrow={t('runsEyebrow')}
        title={t('runsTitle')}
        lede={t('runsLede')}
        actions={tab === 'runs' ? (
          <>
            <Button variant="secondary" onClick={() => void refreshRuns()} disabled={runsLoading}>
              <RotateCwIcon size={14} /> {runsLoading ? t('common:loading') : t('common:refresh')}
            </Button>
            <Button variant="accent-solid" onClick={focusCreateForm}>
              <PlusIcon size={14} /> {t('createARun')}
            </Button>
          </>
        ) : null}
      />

      <Tabs
        idBase="runs"
        className="u-mb-4"
        label={t('runsTablistLabel')}
        value={tab}
        onChange={setTab}
        items={[{ id: 'runs', label: t('tabAllRuns') }, { id: 'active', label: t('tabActiveRuns') }]}
      />
      <TabPanel idBase="runs" tabId={tab}>
        {tab === 'active' ? <ActiveRunsTab /> : (
        <>

      <RunsSummary
        runs={runs}
        annotationsByRun={byRun}
        activeStatus={statusFilter}
        onToggleStatus={(b) => setStatusFilter((cur) => (cur === b ? null : b))}
      />

      <div className="surface-card">
        <div className="u-flex u-items-baseline u-justify-between u-gap-2 u-wrap">
          <h2 className="u-m-0">{reviewOnly ? t('flaggedForReview') : t('recentRuns')}</h2>
        </div>
        <div className="filterbar">
          {/* §C3 — flagged review queue. Only offered when the host advertises
              feedback; mirrors the inbox tab pattern. */}
          {feedbackOn && (
            <div className="segmented" role="group" aria-label={t('filterRuns')}>
              <Button variant="primary" aria-pressed={!reviewOnly} onClick={() => setReviewOnly(false)}>
                {t('filterAll')}
              </Button>
              {/* RUN-R2-1 — when ≥1 annotation read failed, the count is a
                  FLOOR: show "n+" (or no number at 0) so a partial outage never
                  reads as a clean "nothing flagged". */}
              <Button variant="primary" aria-pressed={reviewOnly} onClick={() => setReviewOnly(true)} title={annotationsDegraded ? t('reviewSignalsDegraded') : t('flaggedFilterTitle')}>
                <FlagIcon size={13} /> {t('filterFlagged')}
                {flaggedCount > 0 ? ` (${formatNumber(flaggedCount)}${annotationsDegraded ? '+' : ''})` : ''}
              </Button>
            </div>
          )}
          {feedbackOn && annotationsDegraded ? (
            // `announce` is required here: a conditionally-rendered region
            // arrives COMPLETE, so its aria-live never fires (Notice's own
            // docstring); without it this warning is SR-silent — the exact
            // silence family RUN-R2-1 exists to close.
            <Notice variant="warning" announce={t('reviewSignalsDegraded')}>{t('reviewSignalsDegraded')}</Notice>
          ) : null}
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('filterPlaceholder')}
            aria-label={t('filterRuns')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ViewToggle value={view} onChange={(v) => {
            // Grid view has no checkboxes — carrying an invisible selection
            // into it would leave the bulk bar acting on hidden state.
            if (v === 'grid') setRedriveSelected(new Set());
            setView(v);
          }} />
        </div>
        {redriveOutcome ? (
          <Notice variant={redriveOutcome.some((o) => o.error) ? 'warning' : 'success'}>
            <span>{t('redriveOutcome', {
              ok: redriveOutcome.filter((o) => o.redriveRunId).length,
              failed: redriveOutcome.filter((o) => o.error).length,
            })}</span>
            {redriveOutcome.filter((o) => o.error).map((o) => (
              <span key={o.runId} className="u-fs-12"> {t('redriveRowFailed', {
                runId: o.runId.slice(0, 8),
                reason: o.error === 'not_redrivable' ? t('redriveReasonNotRedrivable')
                  : o.error === 'workflow_not_found' ? t('redriveReasonWorkflowGone')
                  : o.error === 'run_not_found' ? t('redriveReasonRunGone')
                  : t('redriveReasonGeneric'),
              })}</span>
            ))}
            {redriveSelected.size > 0 ? (
              <span className="u-fs-12"> {t('redriveRemaining', { count: redriveSelected.size })}</span>
            ) : null}
          </Notice>
        ) : null}
        {runsError ? <Notice variant="error">{runsError}</Notice> : null}
        {visibleRuns.length === 0 ? (
          runsEmptyState
        ) : view === 'grid' ? (
          <div className="card-grid">
            {visibleRuns.map((r) => (
              <RunCard
                key={r.runId}
                run={r}
                flagged={isFlagged(r.runId)}
                flagReason={reviewReason(reviewOf(byRun.get(r.runId) ?? []))}
              />
            ))}
          </div>
        ) : (
          <DataTable
            rows={visibleRuns}
            rowKey={(r) => r.runId}
            onRowClick={(r) => nav(`/runs/${r.runId}`)}
            caption={t('recentRuns')}
            initialSort={{ key: 'started', dir: 'desc' }}
            columns={runColumns}
            selectable
            selected={redriveSelected}
            onSelectionChange={setRedriveSelected}
            rowSelectable={isRedrivable}
            bulkActions={() => (
              <Button
                variant="secondary"
                onClick={() => { void onRedriveSelected(); }}
                disabled={redriveBusy}
                title={t('redriveTitle')}
              >
                <RotateCwIcon size={13} /> {t('redriveSelected', { count: Math.min(redriveSelected.size, 25) })}
              </Button>
            )}
          />
        )}
        {runs.length >= runsLimit ? (
          <Button variant="secondary" size="sm" className="u-mt-2" onClick={() => setRunsLimit((n) => n + 20)} disabled={runsLoading}>
            {t('loadMoreRuns')}
          </Button>
        ) : null}
      </div>

      <div className="surface-card">
        <h2>{t('createARun')}</h2>
        <p className="muted u-mt-0">
          {tenantScope}
        </p>
        <form ref={createFormRef} onSubmit={onSubmit}>
          <SelectField label={t('workflowFieldLabel')} value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
            {allOptions.map((w) => (
              <option key={w.id} value={w.id}>{w.label}</option>
            ))}
          </SelectField>
          {inputSchema ? (
            <SchemaInputForm schema={inputSchema} raw={inputsRaw} onRawChange={setInputsRaw} onBlockingChange={onBlockingChange} />
          ) : (
            <TextareaField
              label={t('inputsFieldLabel')}
              rows={6}
              value={inputsRaw}
              onChange={(e) => setInputsRaw(e.target.value)}
              spellCheck={false}
            />
          )}
          {error && <Notice variant="error">{error}</Notice>}
          <div className="button-row">
            <Button type="submit" variant="accent-solid" disabled={submitting}>
              {submitting ? t('creating') : <><PlusIcon size={14} /> {t('createRun')}</>}
            </Button>
          </div>
        </form>
      </div>

      {/* Developer-education card about the seeded demo workflows — showcase
          content only (ADR 0196 Gate A / DEMO-10): it names source files and
          "seeded workflows", which is meaningless on a clean install. */}
      {demo && (
        <div className="surface-card">
          <h2>{t('aboutThisApp')}</h2>
          <p className="muted">
            {t('aboutThisAppBodyPre')}<code>workflowCatalog</code>
            {' ('}<code>src/host/index.ts</code>{t('aboutThisAppBodyPost')}
          </p>
        </div>
      )}
        </>
        )}
      </TabPanel>
    </section>
  );
}

interface QualityRollup {
  runsAnnotated: number;
  meanRating: number | null;
  correctionRate: number; // fraction of runs with ≥1 correction
  flagRate: number; // fraction of runs with ≥1 flag
  topCorrected: Array<[string, number]>;
}

/**
 * §A2 tenant rollup — outcome distribution + mean completed-run duration
 * over the runs already in hand. §C2 adds the *quality* dimension (mean
 * rating, correction/flag rate, most-corrected nodes) over the shared
 * annotation map fetched once by `useRunAnnotations` — empty (so the quality
 * block is hidden) against a host that doesn't advertise feedback.
 */
function RunsSummary({
  runs,
  annotationsByRun,
  activeStatus,
  onToggleStatus,
}: {
  runs: RunListItem[];
  annotationsByRun: Map<string, readonly Annotation[]>;
  /** Currently-active status filter (null = none); drives the figure-tile pressed state. */
  activeStatus: RunStatusBucket | null;
  /** Toggling a figure tile filters the table below it (§4.5 stats-are-filters). */
  onToggleStatus: (bucket: RunStatusBucket) => void;
}) {
  const { t } = useTranslation('runs');
  // §C2 — quality rollup derived from the shared annotation map.
  const quality = useMemo<QualityRollup | null>(() => {
    if (runs.length === 0) return null;
    const ratings: number[] = [];
    let runsAnnotated = 0;
    let runsCorrected = 0;
    let runsFlagged = 0;
    const correctedNodes = new Map<string, number>();
    for (const r of runs) {
      const anns = annotationsByRun.get(r.runId) ?? [];
      if (anns.length > 0) runsAnnotated += 1;
      let hasCorrection = false;
      let hasFlag = false;
      for (const a of anns) {
        if (a.signal.kind === 'rating' && typeof a.signal.rating === 'number') {
          ratings.push(a.signal.rating);
        } else if (a.signal.kind === 'correction') {
          hasCorrection = true;
          if (a.target.nodeId) correctedNodes.set(a.target.nodeId, (correctedNodes.get(a.target.nodeId) ?? 0) + 1);
        } else if (a.signal.kind === 'flag') {
          hasFlag = true;
        }
      }
      if (hasCorrection) runsCorrected += 1;
      if (hasFlag) runsFlagged += 1;
    }
    if (runsAnnotated === 0) return null;
    return {
      runsAnnotated,
      meanRating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
      correctionRate: runsCorrected / runs.length,
      flagRate: runsFlagged / runs.length,
      topCorrected: [...correctedNodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
    };
  }, [runs, annotationsByRun]);

  const s = useMemo(() => {
    if (runs.length === 0) return null;
    const total = runs.length;
    const n = (pred: (st: string) => boolean) => runs.filter((r) => pred(r.status)).length;
    const durations = runs
      .flatMap((r) =>
        r.status === 'completed' && r.startedAt && r.completedAt
          ? [Date.parse(r.completedAt) - Date.parse(r.startedAt)]
          : [],
      )
      .filter((d) => Number.isFinite(d) && d >= 0);
    const meanMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
    return {
      total,
      completed: n((x) => x === 'completed'),
      failed: n((x) => x === 'failed'),
      cancelled: n((x) => x === 'cancelled'),
      awaiting: n((x) => x.startsWith('waiting') || x === 'suspended' || x === 'paused'),
      meanMs,
    };
  }, [runs]);

  if (!s) return null;

  // Outcome distribution as the signature figure band — each numeral tile also
  // FILTERS the table below (§4.5). "Mean duration" is reportorial only, so it
  // sits in a trailing non-interactive sub-figure row.
  const outcomeFigures: KeyFigureItem[] = [
    { key: 'completed', label: t('figureCompleted'), value: s.completed },
    { key: 'failed', label: t('figureFailed'), value: s.failed, ...(s.failed > 0 ? { tone: 'attention' as const } : {}) },
    { key: 'cancelled', label: t('figureCancelled'), value: s.cancelled },
    { key: 'awaiting', label: t('figureAwaitingInput'), value: s.awaiting, ...(s.awaiting > 0 ? { tone: 'attention' as const } : {}) },
  ];

  return (
    <div className="surface-card">
      <h2 className="u-mt-0">
        {t('summaryHeading')} <span className="muted u-fs-12 u-fw-400">{t('summaryLastRuns', { count: s.total })}</span>
      </h2>
      <KeyFigureBand
        figures={outcomeFigures}
        activeKey={activeStatus}
        onToggle={(k) => onToggleStatus(k as RunStatusBucket)}
        ariaLabel={t('runOutcomesAria')}
      />
      <dl className="run-stats">
        <div className="run-stat">
          <dt className="run-stat-label">{t('meanDuration')}</dt>
          <dd className="run-stat-value">{s.meanMs == null ? '—' : formatDuration(s.meanMs)}</dd>
        </div>
      </dl>
      {quality && (
        <>
          <h3 className="runsidx-quality-heading">
            {t('qualityHeading')} <span className="muted u-fs-11 u-fw-400">{t('qualityAnnotated', { annotated: formatNumber(quality.runsAnnotated), total: formatNumber(s.total) })}</span>
          </h3>
          <dl className="run-stats">
            <div className="run-stat">
              <dt className="run-stat-label">{t('statMeanRating')}</dt>
              <dd className="run-stat-value">{quality.meanRating == null ? '—' : t('meanRatingValue', { rating: formatNumber(quality.meanRating, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</dd>
            </div>
            <div className={`run-stat${quality.correctionRate > 0 ? ' run-stat--warn' : ''}`}>
              <dt className="run-stat-label">{t('correctionRate')}</dt>
              <dd className="run-stat-value">{formatPercent(quality.correctionRate)}</dd>
            </div>
            <div className={`run-stat${quality.flagRate > 0 ? ' run-stat--danger' : ''}`}>
              <dt className="run-stat-label">{t('flagRate')}</dt>
              <dd className="run-stat-value">{formatPercent(quality.flagRate)}</dd>
            </div>
          </dl>
          {quality.topCorrected.length > 0 && (
            <div className="u-mt-1">
              <div className="muted u-fs-11 u-mb-1">{t('mostCorrectedNodes')}</div>
              <ul className="runsidx-corrected-list">
                {quality.topCorrected.map(([nodeId, n]) => (
                  <li key={nodeId}><code>{nodeId}</code> — {t('correctionCount', { count: n })}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
