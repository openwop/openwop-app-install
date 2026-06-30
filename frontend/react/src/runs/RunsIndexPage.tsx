import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { DataTable, DensityToggle, type DataColumn } from '../ui/DataTable.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { toast } from '../ui/toast.js';
import { createRun, listMyRuns, type RunListItem } from '../client/runsClient.js';
import { classifyHttpError } from '../client/classifyHttpError.js';
import { StatusBadge } from '../ui/StatusBadge.js';
import type { Annotation } from '../client/feedbackClient.js';
import { useRunAnnotations, reviewOf, needsReview, reviewReason } from './useRunAnnotations.js';
import { formatDuration } from './format.js';
import { listSavedWorkflows } from '../builder/persistence/localStore.js';
import { serializeWorkflow, SerializeError } from '../builder/schema/serialize.js';
import { registerWorkflow } from '../builder/persistence/registerClient.js';
import { useAuth } from '../auth/useAuth.js';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { Notice } from '../ui/Notice.js';
import { KeyFigureBand, type KeyFigureItem } from '../ui/KeyFigure.js';
import { FlagIcon, PlayIcon, RotateCwIcon, PlusIcon, SearchIcon } from '../ui/icons/index.js';
import { SelectField, TextareaField } from '../ui/Field.js';
import { demoModeCached, loadDemoMode } from '../client/demoMode.js';
import { formatNumber, formatDateTime, formatPercent } from '../i18n/format.js';

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
  const { user, isConfigured } = useAuth();
  // Built-in example workflows are optional scaffolding — offered only on the public
  // showcase deployment, never on a clean / white-label install.
  const [demo, setDemo] = useState(demoModeCached());
  useEffect(() => { void loadDemoMode().then(setDemo); }, []);
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);

  // §C3 — annotation-driven review queue. One capability-gated fan-out shared
  // by the flagged filter (here) and the §C2 quality rollup (RunsSummary).
  const runIds = useMemo(() => runs.map((r) => r.runId), [runs]);
  const { byRun, feedbackOn } = useRunAnnotations(runIds);
  const [reviewOnly, setReviewOnly] = useState(false);
  // §4.5 "stats are filters" — the figure tiles below double as a status
  // filter on the table. null = no status filter (the "Total" tile, or none).
  const [statusFilter, setStatusFilter] = useState<RunStatusBucket | null>(null);
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
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  // Row density (comfortable/compact), persisted per-user (gap analysis #5).
  const [density, setDensity] = useState<'comfortable' | 'compact'>(() => {
    try { return localStorage.getItem('openwop.runs.density') === 'compact' ? 'compact' : 'comfortable'; } catch { return 'comfortable'; }
  });
  useEffect(() => { try { localStorage.setItem('openwop.runs.density', density); } catch { /* ignore */ } }, [density]);

  async function refreshRuns(signal?: AbortSignal) {
    setRunsLoading(true);
    setRunsError(null);
    try {
      const list = await listMyRuns({ limit: 20, ...(signal ? { signal } : {}) });
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
  }, [user?.uid]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const inputs = JSON.parse(inputsRaw);
      // Builder-saved workflows need to be registered with the backend's
      // in-memory catalog before POST /v1/runs can resolve them.
      const saved = savedWorkflows.find((w) => w.id === workflowId);
      if (saved) {
        const def = serializeWorkflow(saved);
        await registerWorkflow(def);
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
        setError(err instanceof Error ? err.message : String(err));
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
          {isFlagged(r.runId) && (
            <span
              className="chip chip--danger runs-review-flag"
              title={t('flaggedForReviewTitle', { reasons: reviewReason(reviewOf(byRun.get(r.runId) ?? [])) })}
            >
              <FlagIcon size={10} /> {t('reviewChip')}
            </span>
          )}
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

  return (
    <section className="page-enter">
      <PageHeader
        eyebrow={t('runsEyebrow')}
        title={t('runsTitle')}
        lede={t('runsLede')}
        actions={
          <>
            <button type="button" className="secondary" onClick={() => void refreshRuns()} disabled={runsLoading}>
              <RotateCwIcon size={14} /> {runsLoading ? t('common:loading') : t('common:refresh')}
            </button>
            <button type="button" className="btn-accent-solid" onClick={focusCreateForm}>
              <PlusIcon size={14} /> {t('createARun')}
            </button>
          </>
        }
      />

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
              <button type="button" aria-pressed={!reviewOnly} onClick={() => setReviewOnly(false)}>
                {t('filterAll')}
              </button>
              <button type="button" aria-pressed={reviewOnly} onClick={() => setReviewOnly(true)} title={t('flaggedFilterTitle')}>
                <FlagIcon size={13} /> {t('filterFlagged')}{flaggedCount > 0 ? ` (${formatNumber(flaggedCount)})` : ''}
              </button>
            </div>
          )}
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('filterPlaceholder')}
            aria-label={t('filterRuns')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <DensityToggle value={density} onChange={setDensity} />
        </div>
        {runsError ? <Notice variant="error">{runsError}</Notice> : null}
        <DataTable
          rows={visibleRuns}
          rowKey={(r) => r.runId}
          onRowClick={(r) => nav(`/runs/${r.runId}`)}
          density={density}
          caption={t('recentRuns')}
          initialSort={{ key: 'started', dir: 'desc' }}
          columns={runColumns}
          empty={
            runsLoading ? (
              <SkeletonRows rows={4} columns={[90, 180, 80, 150]} />
            ) : runs.length === 0 ? (
              <StateCard
                icon={<PlayIcon size={22} />}
                title={t('noRunsYetTitle')}
                body={t('noRunsYetBody')}
                action={
                  <button type="button" className="btn-accent-solid" onClick={focusCreateForm}>
                    <PlusIcon size={14} /> {t('createARun')}
                  </button>
                }
              />
            ) : reviewOnly ? (
              <StateCard
                icon={<FlagIcon size={22} />}
                title={t('nothingFlaggedTitle')}
                body={t('nothingFlaggedBody')}
                action={
                  <button type="button" className="secondary" onClick={() => setReviewOnly(false)}>
                    {t('showAllRuns')}
                  </button>
                }
              />
            ) : (
              <StateCard
                icon={<SearchIcon size={22} />}
                title={t('noRunsMatchTitle')}
                body={t('noRunsMatchBody')}
                action={
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => { setQuery(''); setStatusFilter(null); }}
                  >
                    {t('clearFilter')}
                  </button>
                }
              />
            )
          }
        />
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
          <TextareaField
            label={t('inputsFieldLabel')}
            rows={6}
            value={inputsRaw}
            onChange={(e) => setInputsRaw(e.target.value)}
            spellCheck={false}
          />
          {error && <Notice variant="error">{error}</Notice>}
          <div className="button-row">
            <button type="submit" className="btn-accent-solid" disabled={submitting}>
              {submitting ? t('creating') : <><PlusIcon size={14} /> {t('createRun')}</>}
            </button>
          </div>
        </form>
      </div>

      <div className="surface-card">
        <h2>{t('aboutThisApp')}</h2>
        <p className="muted">
          {t('aboutThisAppBodyPre')}<code>workflowCatalog</code>
          {' ('}<code>src/host/index.ts</code>{t('aboutThisAppBodyPost')}
        </p>
      </div>
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
