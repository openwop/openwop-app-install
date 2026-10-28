/**
 * Experiments (ADR 0949 P2b) — the org's experiments, and a form to start a
 * Decide experiment on a CMS page or a funnel step. A new experiment is a
 * DRAFT: its plan, lock and launch happen on its own page. Legacy CMS page and
 * funnel step tests are listed too, read-only here. Gated by `experiments`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../ui/Button.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useFormat } from '../../i18n/useFormat.js';
import { listOrgs, listPages, listVersions, type Org, type Page, type PageVersion } from '../cms/cmsClient.js';
import { listFunnels, type Funnel } from '../funnels/funnelsClient.js';
import { createExperiment, listExperiments, type Experiment, type SurfaceKind } from './experimentsClient.js';
import { ExperimentStatusChip } from './ExperimentStatusChip.js';

const SKELETON = ['40%', '20%', '15%', '15%'];

export function ExperimentsPage(): JSX.Element {
  const { t } = useTranslation('experiments');
  const { t: tc } = useTranslation('common');
  const fmt = useFormat();
  const navigate = useNavigate();
  const access = useFeatureAccess('experiments');
  const [searchParams] = useSearchParams();
  const [deepLinkOrg] = useState(() => searchParams.get('org'));
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, access.enabled, deepLinkOrg ?? '');

  const [rows, setRows] = useState<Experiment[] | null>(null);
  const [rowsFailed, setRowsFailed] = useState(false);
  const load = useCallback(async (org: string) => {
    if (!org) return;
    setRows(null); setRowsFailed(false);
    try { setRows(await listExperiments(org)); } catch { setRowsFailed(true); }
  }, []);
  useEffect(() => { if (orgId) void load(orgId); }, [orgId, load]);

  // The create form: a name, a target (page or funnel step) and the variant B ref.
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SurfaceKind>('cms.page');
  const [mode, setMode] = useState<'decide' | 'optimize'>('decide');
  const [pages, setPages] = useState<Page[]>([]);
  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [target, setTarget] = useState('');
  const [versions, setVersions] = useState<PageVersion[]>([]);
  const [variantRef, setVariantRef] = useState('');
  const [busy, setBusy] = useState(false);
  // A picker whose read failed says so; an empty list must mean "none exist".
  const [pickerFailed, setPickerFailed] = useState(false);
  useEffect(() => {
    if (!orgId) return;
    setTarget(''); setVariantRef(''); setPickerFailed(false);
    void listPages(orgId).then(setPages, () => setPickerFailed(true));
    void listFunnels(orgId).then(setFunnels, () => setPickerFailed(true));
  }, [orgId]);
  useEffect(() => {
    setVariantRef(''); setVersions([]);
    if (kind === 'cms.page' && orgId && target) void listVersions(orgId, target).then(setVersions, () => setPickerFailed(true));
  }, [kind, orgId, target]);

  const stepOptions = useMemo(() => funnels.flatMap((f) => f.steps.map((s) => ({ ref: `${f.funnelId}:${s.stepId}`, label: `${f.name} › ${s.name ?? s.kind}` }))), [funnels]);
  const variantOptions = kind === 'cms.page'
    ? versions.map((v) => ({ ref: v.versionId, label: t('versionOption', { n: fmt.number(v.version), title: v.snapshot.title }) }))
    : pages.filter((p) => p.status === 'published').map((p) => ({ ref: p.pageId, label: p.title }));

  const add = useCallback(async () => {
    if (!orgId || !name.trim() || !target || !variantRef) return;
    setBusy(true);
    try {
      const exp = await createExperiment(orgId, {
        name: name.trim(), surface: { kind, ref: target },
        arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: variantRef, weight: 50 }],
        // ADR 0949 P4 — Optimize starts with safe defaults the experiment page can edit.
        ...(mode === 'optimize' ? { mode, optimize: { rewardMetric: { kind: 'conversion' as const, name: 'conversion' }, floorPct: 5, epochMinutes: 1440 } } : {}),
      });
      toast.success(t('created'));
      navigate(`/experiments/${encodeURIComponent(exp.experimentId)}?org=${encodeURIComponent(orgId)}`);
    } catch (e) { toast.error(e instanceof Error ? e.message : t('createFailed')); }
    finally { setBusy(false); }
  }, [orgId, name, target, variantRef, kind, mode, navigate, t]);

  const href = useCallback((id: string) => `/experiments/${encodeURIComponent(id)}?org=${encodeURIComponent(orgId)}`, [orgId]);
  const columns = useMemo<DataColumn<Experiment>[]>(() => [
    { key: 'name', header: t('colName'), render: (e) => <Link to={href(e.experimentId)}>{e.name}</Link>, sortValue: (e) => e.name },
    { key: 'mode', header: t('colMode'), render: (e) => t(e.mode === 'optimize' ? 'modeOptimize' : 'modeDecide'), sortValue: (e) => e.mode },
    { key: 'surface', header: t('colSurface'), render: (e) => t(e.surface.kind === 'funnel.step' ? 'surfaceFunnelStep' : 'surfaceCmsPage') },
    { key: 'status', header: t('colStatus'), render: (e) => <ExperimentStatusChip experiment={e} />, sortValue: (e) => e.status },
    { key: 'created', header: t('colCreated'), render: (e) => fmt.date(e.createdAt), sortValue: (e) => e.createdAt },
  ], [t, fmt, href]);

  if (access.loading) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="experiments.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <SkeletonRows rows={4} columns={SKELETON} />
      </section>
    );
  }
  if (!access.enabled) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="experiments.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }

  return (
    <section className="u-grid u-gap-4" data-walkthrough="experiments.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs} emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')}>
        {pickerFailed ? <Notice variant="error" announce={t('pickerFailed')}>{t('pickerFailed')}</Notice> : null}
        <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }} aria-label={t('createFormLabel')}>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('ui:orgPickerLabel')}</span>
            <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {orgs === null ? <option value="">{t('ui:orgPickerLoading')}</option> : null}
              {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
            </select>
          </label>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('fieldName')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
          </label>
          {/* DESIGN.md §5.1 — the radio-group precedent (RevokePackDialog): option
              text in the sans field-check register, its help tied by aria-describedby. */}
          <fieldset className="field">
            <legend className="field-label">{t('fieldMode')}</legend>
            <label className="field-check-label u-iflex u-gap-2 u-items-center">
              <input type="radio" name="exp-mode" checked={mode === 'decide'} onChange={() => setMode('decide')} aria-describedby="exp-mode-decide-help" />
              <span>{t('modeDecide')}</span>
            </label>
            <p id="exp-mode-decide-help" className="u-label-sm muted u-m-0">{t('modeDecideHelp')}</p>
            <label className="field-check-label u-iflex u-gap-2 u-items-center">
              <input type="radio" name="exp-mode" checked={mode === 'optimize'} onChange={() => setMode('optimize')} aria-describedby="exp-mode-optimize-help" />
              <span>{t('modeOptimize')}</span>
            </label>
            <p id="exp-mode-optimize-help" className="u-label-sm muted u-m-0">{t('modeOptimizeHelp')}</p>
          </fieldset>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('fieldKind')}</span>
            <select value={kind} onChange={(e) => { setKind(e.target.value as SurfaceKind); setTarget(''); }}>
              <option value="cms.page">{t('surfaceCmsPage')}</option>
              <option value="funnel.step">{t('surfaceFunnelStep')}</option>
            </select>
          </label>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t(kind === 'cms.page' ? 'fieldPage' : 'fieldStep')}</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">{t('choose')}</option>
              {kind === 'cms.page'
                ? pages.map((p) => <option key={p.pageId} value={p.pageId}>{p.title}</option>)
                : stepOptions.map((s) => <option key={s.ref} value={s.ref}>{s.label}</option>)}
            </select>
          </label>
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t(kind === 'cms.page' ? 'fieldVariantVersion' : 'fieldVariantPage')}</span>
            <select value={variantRef} onChange={(e) => setVariantRef(e.target.value)} disabled={!target}>
              <option value="">{t('choose')}</option>
              {variantOptions.map((o) => <option key={o.ref} value={o.ref}>{o.label}</option>)}
            </select>
            <span className="u-label-sm muted">{t('variantHelp')}</span>
          </label>
          <Button variant="primary" type="submit" disabled={busy || !orgId || !name.trim() || !target || !variantRef}>{t('create')}</Button>
        </form>

        {rowsFailed ? (
          <StateCard announce title={tc('loadFailedTitle')} body={tc('loadFailedBody')} action={<Button variant="secondary" onClick={() => void load(orgId)}>{tc('retry')}</Button>} />
        ) : rows === null ? <SkeletonRows rows={4} columns={SKELETON} /> : rows.length === 0 ? (
          <StateCard title={t('noneTitle')} body={t('noneBody')} />
        ) : (
          <DataTable caption={t('captionExperiments')} columns={columns} rows={rows} rowKey={(e) => e.experimentId} />
        )}
      </OrgSelectionState>
    </section>
  );
}
