/**
 * Funnel detail — `/funnels/:funnelId` (ADR 0522).
 *
 * The step editor (each step bound to a CMS page; "Edit page" deep-links the CMS
 * Page Builder — no editor fork), the routing rules, per-step analytics with
 * rebuild, per-step A/B experiments with honest results, the live URLs, and
 * Delete. All of it used to stack UNDER the funnels table behind a `?funnel=`
 * mirror; §4.5 rule 12 gives a full-page detail a path route (ADR 0519 is the
 * reference, `docs/steward/COLLECTION-CANON-SWEEP.md` the sweep).
 *
 * The page loads its OWN funnel by id rather than reading a list the table
 * happened to fetch — it is reachable by bookmark, shared link, or reload with
 * no list in memory. `?org=` rides in from the table cell; absent it the first
 * workspace is used, and a funnel that is not in the resolved workspace renders
 * the designed not-found state instead of an empty editor.
 *
 * Lifecycle (publish / unpublish / archive) deliberately STAYS on the table row
 * as well: those are operate-surface actions you take while scanning, and the
 * `<DataTable>` exception in rule 11 is exactly that surface. Only DELETE moved
 * — rule 12 is about destructive actions, and it is here, beside the name that
 * says which funnel is about to go.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../../ui/Button.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';
import { CopyIcon, ArrowDownIcon, ArrowUpIcon, TrashIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useFormat } from '../../i18n/useFormat.js';
import { listPages, type Page } from '../cms/cmsClient.js';
import {
  listOrgs, getFunnel, updateFunnel, deleteFunnel,
  getFunnelStats, rebuildFunnelStats,
  setStepExperiment, stopStepExperiment, getExperimentResults, funnelViewerUrl, publicFunnelUrl,
  FUNNEL_STEP_KINDS,
  type Funnel, type FunnelStep, type FunnelStepKind, type StepRule,
  type FunnelStats, type ExperimentResults, type Org,
} from './funnelsClient.js';

interface EditStep { stepId?: string; kind: FunnelStepKind; pageId: string; name?: string; routing?: StepRule[] }

const statusChip = (status: Funnel['status']): string =>
  status === 'published' ? 'chip chip--success' : status === 'archived' ? 'chip chip--muted' : 'chip chip--warning';

export function FunnelDetailPage(): JSX.Element {
  const { t } = useTranslation('funnels');
  const { t: tc } = useTranslation('common');
  const fmt = useFormat();
  // `useFeatureAccess` returns an OBJECT, so `const enabled = …` + `if (!enabled)`
  // was ALWAYS truthy: the "not enabled" branch below was dead and this page
  // rendered regardless of its toggle — and the org effect's `if (!enabled …)`
  // guard was dead the same way, so a disabled feature still hit the network.
  const access = useFeatureAccess('funnels');
  const { funnelId = '' } = useParams<{ funnelId: string }>();
  const navigate = useNavigate();

  const [searchParams] = useSearchParams();
  // HG-4 — this page hand-rolled the org read and shipped the defect the shared
  // seam exists to remove. It resolved the workspace ONLY when `?org=` was
  // absent, kept its own `orgsFailed` flag, and had NO zero-organization branch
  // at all: with none, `orgId` stayed '', the funnel effect returned on
  // `if (!orgId)`, `funnel` never left `null`, and the render fell through to
  // the `!funnel` skeleton — a loading state with no terminal condition, on a
  // page whose sibling list had this exact bug fixed in the same commit range.
  // `useOrgSelection` keeps `orgs` null on failure, hands over the third state,
  // and honours the `?org=` deep link when the read confirms it exists.
  const { orgs, orgId, orgsFailed, retry: retryOrgs } =
    useOrgSelection<Org>(listOrgs, access.enabled, searchParams.get('org') ?? '');
  /** CCDATA-1 — when the link carried no `?org=` the hook GUESSED the first
   *  workspace. A not-found then has two very different meanings (deleted vs.
   *  looked in the wrong place), and only this can tell them apart, so the copy
   *  names the workspace actually checked instead of hedging. */
  const guessedOrgName = searchParams.get('org')
    ? ''
    : (orgs?.find((o) => o.orgId === orgId)?.name ?? '');

  const [funnel, setFunnel] = useState<Funnel | null>(null);
  /** The read resolved and found nothing — a deleted funnel or a stale link.
   *  Distinct from `null` (still loading), which must not render "not found". */
  const [notFound, setNotFound] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pages, setPages] = useState<Page[]>([]);
  /** The CMS page read FAILED — the picker says so rather than reading as "this
   *  workspace has no pages", which is a claim the failed read did not earn. */
  const [pagesFailed, setPagesFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editSteps, setEditSteps] = useState<EditStep[]>([]);
  const [stats, setStats] = useState<FunnelStats | null>(null);
  const [expStepId, setExpStepId] = useState('');
  const [expChallenger, setExpChallenger] = useState('');
  const [expResults, setExpResults] = useState<ExperimentResults | null>(null);
  const [expResultsFailed, setExpResultsFailed] = useState(false);

  // FN-B-3 — a failed stats read is NOT "no analytics yet" (and neither is
  // the in-flight fetch). Distinct states + a retry-able loader.
  const [statsFailed, setStatsFailed] = useState(false);
  const [statsLoading, setStatsLoading] = useState(true);
  const loadStats = useCallback(async (): Promise<void> => {
    if (!orgId || !funnelId) return;
    setStatsLoading(true);
    try { setStats(await getFunnelStats(orgId, funnelId)); setStatsFailed(false); }
    catch { setStats(null); setStatsFailed(true); }
    finally { setStatsLoading(false); }
  }, [orgId, funnelId]);

  // R2R F3 — the completion-CTA edit state, seeded from the loaded funnel.
  const [ctaLabel, setCtaLabel] = useState('');
  const [ctaUrl, setCtaUrl] = useState('');
  const reload = useCallback(async (): Promise<void> => {
    if (!orgId || !funnelId) return;
    try {
      const f = await getFunnel(orgId, funnelId);
      setFunnel(f);
      setEditSteps(f.steps.map((s) => ({ stepId: s.stepId, kind: s.kind, pageId: s.pageId, ...(s.name ? { name: s.name } : {}), ...(s.routing ? { routing: s.routing } : {}) })));
      setCtaLabel(f.completionCta?.label ?? '');
      setCtaUrl(f.completionCta?.url ?? '');
    } catch (e) {
      // A 404 IS the answer ("no such funnel here"), not a failure to read.
      if (e instanceof Error && /\b404\b/.test(e.message)) setNotFound(true);
      else { setError(e instanceof Error ? e.message : t('loadFailed')); setLoadFailed(true); }
    }
  }, [orgId, funnelId, t]);

  const saveCta = useCallback(async () => {
    if (!funnel) return;
    setBusy(true);
    try {
      const clearing = !ctaLabel.trim() && !ctaUrl.trim();
      await updateFunnel(orgId, funnel.funnelId, { completionCta: clearing ? null : { label: ctaLabel.trim(), url: ctaUrl.trim() } });
      toast.success(t(clearing ? 'completionCtaCleared' : 'completionCtaSaved'));
      await reload();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('updateFailed')); }
    finally { setBusy(false); }
  }, [funnel, orgId, ctaLabel, ctaUrl, reload, t]);


  useEffect(() => {
    // The toggle gates this read too, and the render branch alone does NOT cover
    // it: with `?org=` in the URL `orgId` is set on the very first render, so a
    // disabled feature hit three endpoints (funnel, pages, stats) underneath the
    // "not enabled" card. Same dead `if (!enabled …)` as the org resolver above.
    if (!access.enabled || !orgId || !funnelId) return;
    setFunnel(null); setNotFound(false); setLoadFailed(false); setStats(null);
    void reload();
    void listPages(orgId)
      .then((p) => { setPages(p); setPagesFailed(false); })
      .catch(() => { setPages([]); setPagesFailed(true); });
    void loadStats();
  }, [access.enabled, orgId, funnelId, reload, loadStats]);

  const expStep = useMemo(
    () => funnel?.steps.find((s) => s.stepId === expStepId) ?? null,
    [funnel, expStepId],
  );

  useEffect(() => {
    setExpResults(null);
    setExpResultsFailed(false); // R2R F6 — a stale flag showed the failure note on a step with no experiment
    if (!funnel || !expStepId) return;
    const step = funnel.steps.find((s) => s.stepId === expStepId);
    if (step?.experiment) {
      void getExperimentResults(orgId, funnel.funnelId, expStepId)
        .then((r) => { setExpResults(r); setExpResultsFailed(false); })
        // FN-B-4 — a failed read must not masquerade as "no results yet".
        .catch(() => { setExpResults(null); setExpResultsFailed(true); });
    }
  }, [funnel, expStepId, orgId]);

  const remove = useCallback(async () => {
    if (!funnel) return;
    if (!(await confirm({
      title: t('deleteConfirm', { name: funnel.name }),
      // FN-B-5 — a PUBLISHED funnel's delete takes a live public URL down;
      // the confirm says so instead of a generic "cannot be undone".
      body: funnel.status === 'published' ? t('deleteLiveBody') : t('deleteDraftBody'),
      danger: true, confirmLabel: t('common:delete'),
    }))) return;
    try {
      await deleteFunnel(orgId, funnel.funnelId);
      toast.success(t('funnelDeleted'));
      navigate(orgId ? `/funnels?org=${encodeURIComponent(orgId)}` : '/funnels');
    } catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [funnel, orgId, navigate, t]);

  const saveSteps = useCallback(async () => {
    if (!funnel) return;
    // FN-B-7 — name the two rejections the server would 400 raw: an unset
    // routing target, and (on remove flows) a rule pointing at a gone step.
    const unset = editSteps.find((s) => (s.routing ?? []).some((r) => !r.goto));
    if (unset) { toast.error(t('ruleTargetUnset', { step: unset.name || t(`kind_${unset.kind}`) })); return; }
    const ids = new Set(editSteps.map((s) => s.stepId));
    const dangling = editSteps.find((s) => (s.routing ?? []).some((r) => r.goto && !ids.has(r.goto)));
    if (dangling) { toast.error(t('ruleTargetGone', { step: dangling.name || t(`kind_${dangling.kind}`) })); return; }
    setBusy(true);
    try {
      await updateFunnel(orgId, funnel.funnelId, { steps: editSteps });
      toast.success(t('stepsSaved'));
      await reload();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('updateFailed')); }
    finally { setBusy(false); }
  }, [funnel, orgId, editSteps, reload, t]);

  const startExperiment = useCallback(async () => {
    if (!funnel || !expStepId || !expChallenger) return;
    setBusy(true);
    try {
      await setStepExperiment(orgId, funnel.funnelId, expStepId, [
        { key: 'control', pageId: null, weight: 50 },
        { key: 'b', pageId: expChallenger, weight: 50 },
      ]);
      toast.success(t('experimentStarted'));
      await reload();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('updateFailed')); }
    finally { setBusy(false); }
  }, [funnel, orgId, expStepId, expChallenger, reload, t]);

  const stopExperiment = useCallback(async () => {
    if (!funnel || !expStepId) return;
    try {
      await stopStepExperiment(orgId, funnel.funnelId, expStepId);
      toast.success(t('experimentStopped'));
      await reload();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('updateFailed')); }
  }, [funnel, orgId, expStepId, reload, t]);

  const [rebuilding, setRebuilding] = useState(false);
  const rebuild = useCallback(async () => {
    if (!funnel || rebuilding) return; // a double-click double-ran a full recompute
    setRebuilding(true);
    try {
      await rebuildFunnelStats(orgId, funnel.funnelId);
      await loadStats(); // R2R F7 — clears statsFailed; fresh stats were hidden behind the failure card
      toast.success(t('statsRebuilt'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('updateFailed')); }
    finally { setRebuilding(false); }
  }, [funnel, orgId, rebuilding, loadStats, t]);

  const pageTitle = useCallback((pageId: string): string => pages.find((p) => p.pageId === pageId)?.title ?? pageId, [pages]);

  // FNL-UX-2 — the visual routing-rule editor mutates editSteps[i].routing;
  // rules ship with Save steps (the same PATCH the API path uses).
  const setRule = useCallback((stepIx: number, ruleIx: number, next: StepRule | null | ((prev: StepRule) => StepRule)) => {
    setEditSteps((prev) => prev.map((step, i) => {
      if (i !== stepIx) return step;
      const rules = (step.routing ?? []).slice();
      if (next === null) rules.splice(ruleIx, 1);
      else if (typeof next === 'function') rules[ruleIx] = next(rules[ruleIx] ?? { goto: '' });
      else if (ruleIx >= rules.length) rules.push(next);
      else rules[ruleIx] = next;
      return rules.length ? { ...step, routing: rules } : (() => { const { routing: _drop, ...rest } = step; return rest; })();
    }));
  }, []);

  // FN-B-2 — the currency doctrine: a single-code sum keeps its symbol; a
  // MIXED sum renders unlabelled (the number is not a quantity of any one
  // currency) with the note below the table naming why.
  const renderRevenue = useCallback((s: FunnelStats['steps'][number]): string => {
    const codes = Object.keys(s.revenueByCurrency ?? {});
    if (codes.length === 1) return fmt.currency(s.revenue, codes[0]!);
    return fmt.number(s.revenue);
  }, [fmt]);
  const revenueMixed = useMemo(
    () => (stats?.steps ?? []).some((s) => Object.keys(s.revenueByCurrency ?? {}).length > 1),
    [stats],
  );
  // FN-G6 — the drop-off report: % of the PREVIOUS step's visitors lost before
  // this one (the largest-drop diagnostic), honest only now that the counts
  // are distinct-visitor (VP-R2-1).
  const statRows = useMemo(() => {
    const rows = stats?.steps ?? [];
    return rows.map((s, i) => {
      const prev = i > 0 ? rows[i - 1] : undefined;
      // R2R F10 — a later step OUT-viewing its predecessor (deep links; window
      // aging) is not a 0% drop: show the honest dash rather than a clamp.
      const raw = prev && prev.views > 0 && s.kind !== 'removed'
        ? Math.round((1 - s.views / prev.views) * 100) : null;
      const dropOff = raw !== null && raw > 0 ? raw : null;
      return { ...s, dropOff };
    });
  }, [stats]);
  const statColumns = useMemo<DataColumn<(typeof statRows)[number]>[]>(() => [
    { key: 'step', header: t('colStep'), render: (s) => s.name ?? t(`kind_${s.kind}`) },
    { key: 'views', header: t('colViews'), render: (s) => fmt.number(s.views), sortValue: (s) => s.views },
    { key: 'dropoff', header: t('colDropOff'), render: (s) => s.dropOff === null ? '—' : `−${s.dropOff}%`, sortValue: (s) => s.dropOff ?? null },
    { key: 'completions', header: t('colCompletions'), render: (s) => fmt.number(s.completions), sortValue: (s) => s.completions },
    { key: 'conversion', header: t('colConversion'), render: (s) => s.conversion === null ? '—' : `${Math.round(s.conversion * 100)}%` },
    { key: 'orders', header: t('colOrders'), render: (s) => fmt.number(s.orders), sortValue: (s) => s.orders },
    { key: 'revenue', header: t('colRevenue'), render: renderRevenue, sortValue: (s) => s.revenue },
  ], [t, fmt, renderRevenue]);

  // FN-B-1 — steps whose bound page is not currently published (their public
  // read 404s). Computed only from a SUCCESSFUL pages read.
  const deadSteps = useMemo(() => {
    if (!funnel || pagesFailed) return [] as string[];
    const byId = new Map(pages.map((p) => [p.pageId, p]));
    return funnel.steps
      .filter((s) => byId.get(s.pageId)?.status !== 'published')
      .map((s) => s.name || t(`kind_${s.kind}`));
  }, [funnel, pages, pagesFailed, t]);

  const backLink = <Link to={orgId ? `/funnels?org=${encodeURIComponent(orgId)}` : '/funnels'} className="btn-ghost">{t('backToFunnels')}</Link>;

  // Toggle unresolved — the header stays and the body is a shape-matched
  // skeleton (the corpus majority), not a title-only `StateCard` that would read
  // as a terminal answer about a question nobody has answered yet.
  if (access.loading) {
    return (
      <section className="u-grid u-gap-4">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} actions={backLink} />
        <Skeleton />
      </section>
    );
  }
  if (!access.enabled) return <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />;

  // HG-4 — the org states' ORDER (failed → zero-organizations → children) and
  // the noun are `OrgSelectionState`'s, not this page's. The zero-org branch is
  // the one that was missing entirely: `orgId` stays '' there, so `reload()`
  // returns on its `if (!orgId)` guard, `funnel` never leaves `null`, and the
  // `!funnel` skeleton below had no terminal condition. Every other branch of
  // this page is a CHILD, which is what makes that ordering unskippable — the
  // page cannot render its editor, or its own failure cards, above the guard.
  return (
    <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
      emptyBody={t('orgsEmptyClause')} failedBody={t('detailOrgsFailedClause')}>
    {notFound ? (
      <section className="u-grid u-gap-4">
        <PageHeader eyebrow={t('eyebrow')} title={t('funnelNotFoundTitle')} actions={backLink} />
        {/* A way out at the point of failure — the workspace picker that can
            fix a wrong-workspace link lives back on the table. */}
        <StateCard announce title={t('funnelNotFoundTitle')} body={guessedOrgName ? t('funnelNotFoundGuessedBody', { workspace: guessedOrgName }) : t('funnelNotFoundBody')}
          action={<Link to={orgId ? `/funnels?org=${encodeURIComponent(orgId)}` : '/funnels'} className="btn-accent-solid">{t('backToFunnels')}</Link>} />
      </section>
    ) : loadFailed ? (
      <section className="u-grid u-gap-4">
        <PageHeader eyebrow={t('eyebrow')} title={tc('loadFailedTitle')} actions={backLink} />
        {error ? <Notice variant="error">{error}</Notice> : null}
        {/* The retry the previous hand-rolled failure branch never offered: this
            read is gated on `orgId` + `funnelId`, both still in hand, so there
            is nothing to navigate away and back for. */}
        <StateCard announce title={tc('loadFailedTitle')} body={tc('loadFailedBody')}
          action={<Button variant="secondary" onClick={() => { setLoadFailed(false); setError(null); void reload(); }}>{tc('retry')}</Button>} />
      </section>
    ) : !funnel ? (
      <section className="u-grid u-gap-4">
        <PageHeader eyebrow={t('eyebrow')} title={t('loadingFunnel')} actions={backLink} />
        <Skeleton />
      </section>
    ) : (
    <section className="u-grid u-gap-4" data-walkthrough="funnels.detail">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={funnel.name}
        lede={t('detailLede')}
        actions={
          <>
            {backLink}
            <span className={statusChip(funnel.status)}>{t(`status_${funnel.status}`)}</span>
            <Button variant="danger" onClick={() => void remove()}><TrashIcon size={14} /> {t('common:delete')}</Button>
          </>
        }
      />
      {error ? <Notice variant="error">{error}</Notice> : null}
      {/* FN-B-1 — a Published funnel whose bound page is UNPUBLISHED is
          silently dead: the live link 404s for every visitor while this page
          shows Published + share URLs. Warn loudly, naming the steps. Never
          claimed over a failed pages read. */}
      {funnel.status === 'published' && !pagesFailed && deadSteps.length > 0 ? (
        <Notice variant="error">
          {t('deadStepsWarning', { n: deadSteps.length, steps: deadSteps.join(', ') })}
        </Notice>
      ) : null}

      <div className="surface-card u-p-4 u-grid u-gap-4">
      {funnel.status === 'published' ? (
        <div className="u-grid u-gap-1">
          <p className="u-m-0 u-flex u-gap-1 u-items-center u-wrap">
            {t('viewerUrlLabel')}{' '}
            <a href={funnelViewerUrl(orgId, funnel.slug)} target="_blank" rel="noreferrer"><code>{funnelViewerUrl(orgId, funnel.slug)}</code></a>
            <Button variant="quiet" size="sm" aria-label={t('copyViewerUrl')} onClick={() => void copyToClipboard(funnelViewerUrl(orgId, funnel.slug))}><CopyIcon size={14} /></Button>
          </p>
          <p className="u-m-0">
            {t('publicUrlLabel')}{' '}
            <a href={publicFunnelUrl(orgId, funnel.slug)} target="_blank" rel="noreferrer"><code>{publicFunnelUrl(orgId, funnel.slug)}</code></a>
          </p>
        </div>
      ) : null}

      <section className="u-grid u-gap-2">
        <h3 className="u-m-0">{t('stepsHeading')}</h3>
        {editSteps.length === 0 ? <p className="u-m-0">{t('noStepsBody')}</p> : null}
        {editSteps.map((s, ix) => (
          <div key={s.stepId ?? `new-${ix}`} className="surface-form u-items-end">
            <label className="u-grid u-gap-1 is-narrow">
              <span className="u-label-sm">{t('fieldKind')}</span>
              <select value={s.kind} onChange={(e) => setEditSteps((prev) => prev.map((p, i) => i === ix ? { ...p, kind: e.target.value as FunnelStepKind } : p))} disabled={funnel.status === 'archived'}>
                {FUNNEL_STEP_KINDS.map((k) => <option key={k} value={k}>{t(`kind_${k}`)}</option>)}
              </select>
              {/* ADR 0332 — an opt-in step captures via a `form` section on its
                  bound page; advisory only (never a lock). */}
              {s.kind === 'optin' ? (
                <span className="u-label-sm muted">
                  {t('optinFormHint')} <Link to="/forms">{t('optinFormHintLink')}</Link>
                </span>
              ) : null}
            </label>
            <label className="u-grid u-gap-1">
              {/* FN-B-8 (round 3) — the step-rename surface the R2 deferral
                  named. The server side has been correct all along (sanitize
                  bounds to MAX.stepName=120, absent clears); only the editor
                  was missing. Empty input ⇒ `name` omitted from the payload ⇒
                  the step falls back to its kind label everywhere (stats
                  table, routing pickers, viewer stage label). */}
              <span className="u-label-sm">{t('fieldStepName')}</span>
              <input
                value={s.name ?? ''}
                maxLength={120}
                placeholder={t(`kind_${s.kind}`)}
                aria-label={t('fieldStepNameAria', { index: ix + 1 })}
                disabled={funnel.status === 'archived'}
                onChange={(e) => {
                  const v = e.target.value;
                  setEditSteps((prev) => prev.map((p, i) => i === ix ? (v.trim() ? { ...p, name: v } : (({ name: _drop, ...rest }) => rest)(p)) : p));
                }}
              />
            </label>
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('fieldPage')}</span>
              <select value={s.pageId} onChange={(e) => setEditSteps((prev) => prev.map((p, i) => i === ix ? { ...p, pageId: e.target.value } : p))} disabled={funnel.status === 'archived'}>
                <option value="">{t('pickPage')}</option>
                {pages.map((p) => <option key={p.pageId} value={p.pageId}>{p.title}{p.status !== 'published' ? ` (${t('pageUnpublished')})` : ''}</option>)}
              </select>
              {/* Without this the picker is indistinguishable from "this workspace
                  has no CMS pages", which is a claim we cannot make when the read
                  failed. Non-blocking: the step is still editable. */}
              {pagesFailed ? <span className="muted u-fs-13">{tc('loadFailed')}</span> : null}
            </label>
            <div className="u-grid u-gap-1">
              {(s.routing ?? []).map((rule, rIx) => (
                <span key={rIx} className="action-bar">
                  <select
                    value={rule.when?.outcome ?? (rule.when?.utm ? 'utm' : 'always')}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === 'always') setRule(ix, rIx, (prev) => ({ goto: prev.goto }));
                      else if (v === 'utm') setRule(ix, rIx, (prev) => ({ goto: prev.goto, when: { utm: { key: 'source', value: '' } } }));
                      else setRule(ix, rIx, (prev) => ({ goto: prev.goto, when: { outcome: v as 'accepted' | 'declined' } }));
                    }}
                    aria-label={t('ruleConditionLabel', { ix: rIx + 1 })}
                    disabled={funnel.status === 'archived'}
                  >
                    <option value="always">{t('ruleAlways')}</option>
                    <option value="accepted">{t('ruleAccepted')}</option>
                    <option value="declined">{t('ruleDeclined')}</option>
                    <option value="utm">{t('ruleUtm')}</option>
                  </select>
                  {rule.when?.utm ? (
                    <>
                      <input value={rule.when.utm.key} onChange={(e) => setRule(ix, rIx, (prev) => ({ goto: prev.goto, when: { utm: { key: e.target.value, value: prev.when?.utm?.value ?? '' } } }))} placeholder={t('ruleUtmKey')} aria-label={t('ruleUtmKey')} disabled={funnel.status === 'archived'} />
                      <input value={rule.when.utm.value} onChange={(e) => setRule(ix, rIx, (prev) => ({ goto: prev.goto, when: { utm: { key: prev.when?.utm?.key ?? '', value: e.target.value } } }))} placeholder={t('ruleUtmValue')} aria-label={t('ruleUtmValue')} disabled={funnel.status === 'archived'} />
                    </>
                  ) : null}
                  <span>→</span>
                  <select value={rule.goto} onChange={(e) => setRule(ix, rIx, (prev) => ({ ...prev, goto: e.target.value }))} aria-label={t('ruleGotoLabel', { ix: rIx + 1 })} disabled={funnel.status === 'archived'}>
                    <option value="">{t('pickStep')}</option>
                    {editSteps.filter((_, i2) => i2 !== ix).map((st2, i2) => <option key={st2.stepId ?? i2} value={st2.stepId ?? ''}>{st2.name ?? t(`kind_${st2.kind}`)}</option>)}
                  </select>
                  <Button variant="quiet" onClick={() => setRule(ix, rIx, null)} disabled={funnel.status === 'archived'} aria-label={t('removeRuleLabel', { ix: rIx + 1 })}>{t('common:delete')}</Button>
                </span>
              ))}
              <span className="action-bar">
                <Button variant="quiet" onClick={() => setRule(ix, (s.routing ?? []).length, { goto: '' })} disabled={funnel.status === 'archived' || !s.stepId}>{t('addRule')}</Button>
              </span>
            </div>
            <span className="action-bar">
              <Button variant="quiet" onClick={() => setEditSteps((prev) => { const next = prev.slice(); [next[ix - 1], next[ix]] = [next[ix]!, next[ix - 1]!]; return next; })} disabled={ix === 0 || funnel.status === 'archived'} aria-label={t('moveStepUpLabel', { ix: ix + 1 })}><ArrowUpIcon /></Button>
              <Button variant="quiet" onClick={() => setEditSteps((prev) => { const next = prev.slice(); [next[ix], next[ix + 1]] = [next[ix + 1]!, next[ix]!]; return next; })} disabled={ix === editSteps.length - 1 || funnel.status === 'archived'} aria-label={t('moveStepDownLabel', { ix: ix + 1 })}><ArrowDownIcon /></Button>
              {s.pageId ? <Link className="btn-ghost" to={`/cms/p/${encodeURIComponent(orgId)}/${encodeURIComponent(s.pageId)}`}>{t('editPage')}</Link> : null}
              <Button variant="quiet" onClick={() => setEditSteps((prev) => prev.filter((_, i) => i !== ix))} disabled={funnel.status === 'archived'} aria-label={t('removeStepLabel', { ix: ix + 1 })}>{t('common:delete')}</Button>
            </span>
          </div>
        ))}
        <span className="action-bar">
          <Button variant="quiet" onClick={() => setEditSteps((prev) => [...prev, { kind: 'landing', pageId: '' }])} disabled={funnel.status === 'archived'}>{t('addStep')}</Button>
          <Button variant="primary" onClick={() => void saveSteps()} disabled={busy || funnel.status === 'archived' || editSteps.some((s) => !s.pageId)}>{t('saveSteps')}</Button>
        </span>
      </section>

      {/* R2R F3 — FN-G5's CTA was servable and renderable but NOT authorable
          (the built-but-unreachable class). Label + URL, saved together; both
          empty clears. */}
      <section className="u-grid u-gap-2">
        <h3 className="u-m-0">{t('completionHeading')}</h3>
        <p className="u-label-sm muted u-m-0">{t('completionLede')}</p>
        <div className="u-flex u-gap-2 u-wrap u-items-end">
          <label className="u-label-sm u-flex-1">{t('completionCtaLabel')}
            <input value={ctaLabel} maxLength={80} onChange={(e) => setCtaLabel(e.target.value)} placeholder={t('completionCtaLabelPlaceholder')} />
          </label>
          <label className="u-label-sm u-flex-1">{t('completionCtaUrl')}
            <input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder={t('completionCtaUrlPlaceholder')} />
          </label>
          <Button variant="secondary" disabled={busy || (Boolean(ctaLabel.trim()) !== Boolean(ctaUrl.trim()))} onClick={() => void saveCta()}>{t('saveCompletionCta')}</Button>
        </div>
      </section>

      <section className="u-grid u-gap-2">
        <header className="u-flex u-items-center u-gap-2">
          <h3 className="u-m-0">{t('statsHeading')}</h3>
          <Button variant="quiet" disabled={rebuilding} loading={rebuilding} onClick={() => void rebuild()}>{t('rebuildStats')}</Button>
        </header>
        {statsLoading ? <Skeleton /> : statsFailed ? (
          <div role="alert" className="u-grid u-gap-1 u-justify-start">
            <p className="u-m-0">{t('statsLoadFailed')}</p>
            <Button variant="quiet" size="sm" className="u-w-auto" onClick={() => void loadStats()}>{tc('retry')}</Button>
          </div>
        ) : stats === null ? <p className="u-m-0">{t('noStatsBody')}</p> : (
          <>
            <DataTable caption={t('captionStats')} columns={statColumns} rows={statRows} rowKey={(s) => s.stepId} />
            {revenueMixed ? <p className="u-label-sm muted u-m-0">{t('revenueMixedNote')}</p> : null}
            {/* FN-B-6 — the freshness the payload always carried: when the
                rollup last ran, and that views/completions age out of the
                event window while revenue joins all orders. */}
            <p className="u-label-sm muted u-m-0">
              {stats.rebuiltAt ? t('statsFreshness', { at: fmt.dateTime(stats.rebuiltAt) }) : t('statsNeverRebuilt')}{' '}
              {t('statsWindowNote', { n: fmt.number(stats.eventWindow) })}
            </p>
            {stats.days.length > 0 ? (
              <details>
                <summary>{t('dailyTrend', { days: stats.days.length })}</summary>
                <table className="u-w-full">
                  <caption className="u-text-left">{t('captionDaily')}</caption>
                  <thead>
                    <tr><th scope="col" className="u-text-left">{t('colDay')}</th><th scope="col" className="u-text-right">{t('colViews')}</th><th scope="col" className="u-text-right">{t('colCompletions')}</th><th scope="col" className="u-text-left">{t('colConversion')}</th></tr>
                  </thead>
                  <tbody>
                    {stats.days.map((d) => {
                      const views = Object.values(d.steps).reduce((sum, c) => sum + c.views, 0);
                      const completions = Object.values(d.steps).reduce((sum, c) => sum + c.completions, 0);
                      return (
                        <tr key={d.day}>
                          <td>{d.day}</td>
                          <td className="u-text-right">{fmt.number(views)}</td>
                          <td className="u-text-right">{fmt.number(completions)}</td>
                          <td><progress max={Math.max(views, 1)} value={completions} aria-label={t('dayConversionLabel', { day: d.day })} /> {views > 0 ? `${Math.round((completions / views) * 100)}%` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </details>
            ) : null}
          </>
        )}
      </section>

      <section className="u-grid u-gap-2">
        <h3 className="u-m-0">{t('experimentHeading')}</h3>
        <div className="surface-form u-items-end">
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('fieldExpStep')}</span>
            <select value={expStepId} onChange={(e) => setExpStepId(e.target.value)}>
              <option value="">{t('pickStep')}</option>
              {funnel.steps.map((st: FunnelStep, ix) => <option key={st.stepId} value={st.stepId}>{ix + 1}. {st.name ?? t(`kind_${st.kind}`)}</option>)}
            </select>
          </label>
          {expStep && !expStep.experiment ? (
            <>
              <label className="u-grid u-gap-1">
                <span className="u-label-sm">{t('fieldChallenger')}</span>
                <select value={expChallenger} onChange={(e) => setExpChallenger(e.target.value)}>
                  <option value="">{t('pickPage')}</option>
                  {pages.filter((p) => p.status === 'published' && p.pageId !== expStep.pageId).map((p) => <option key={p.pageId} value={p.pageId}>{p.title}</option>)}
                </select>
              </label>
              <Button variant="primary" onClick={() => void startExperiment()} disabled={busy || !expChallenger}>{t('startExperiment')}</Button>
            </>
          ) : null}
          {expStep?.experiment ? (
            <span className="action-bar">
              <span className={expStep.experiment.status === 'running' ? 'chip chip--success' : 'chip chip--muted'}>{t(`exp_${expStep.experiment.status}`)}</span>
              {expStep.experiment.status === 'running' ? <Button variant="quiet" onClick={() => void stopExperiment()}>{t('stopExperiment')}</Button> : null}
            </span>
          ) : null}
        </div>
        {expResultsFailed ? (
          <div role="alert"><p className="u-m-0 u-label-sm">{t('resultsLoadFailed')}</p></div>
        ) : null}
        {expResults ? (
          <table className="data-table">
            <caption>{t('captionResults')}</caption>
            <thead><tr><th scope="col">{t('colVariant')}</th><th scope="col">{t('colSessions')}</th><th scope="col">{t('colCompletions')}</th><th scope="col">{t('colConversion')}</th><th scope="col">{t('colVerdict')}</th></tr></thead>
            <tbody>
              {expResults.variants.map((v) => (
                <tr key={v.key}>
                  <td>{v.key}{v.pageId === null ? ` (${t('holdout')})` : ` — ${pageTitle(v.pageId)}`}</td>
                  <td>{fmt.number(v.sessions)}</td>
                  <td>{fmt.number(v.conversions)}</td>
                  <td>{`${Math.round(v.conversionRate * 100)}%`}</td>
                  <td>{v.insufficientSample ? t('verdictInsufficient', { min: expResults.minSessionsPerVariant }) : v.significant === null ? '—' : v.significant ? t('verdictSignificant') : t('verdictNotSignificant')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
      </div>
    </section>
    )}
    </OrgSelectionState>
  );
}
