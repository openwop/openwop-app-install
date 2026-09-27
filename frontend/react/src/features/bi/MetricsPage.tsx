/**
 * BI metrics admin (ADR 0417 P4) — the governed metric catalog: list (system +
 * tenant metrics), define/edit/delete tenant metrics, and run any metric
 * inline. Validation is the backend's closed world — this form submits and
 * surfaces the typed 422s rather than duplicating the registry rules.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Notice } from '../../ui/Notice.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { confirm } from '../../ui/confirm.js';
import { SelectField, TextField } from '../../ui/Field.js';
import { BarChartIcon, PlusIcon, PlayIcon } from '../../ui/icons/index.js';
import { formatNumber } from '../../i18n/format.js';
import { listOrgs, type Organization } from '../../client/accessClient.js';
import { listEntityTypes, type EntityType } from '../entities/entitiesClient.js';
import {
  listBiMetrics, runBiMetric, createBiMetric, updateBiMetric, deleteBiMetric,
  KERNEL_METRIC_TYPES, type MetricSummary, type MetricRunResult, type BiRequestError,
} from './biClient.js';

const AGGREGATES = ['count', 'sum', 'avg', 'min', 'max'] as const;

interface FormState {
  metricId: string;
  title: string;
  description: string;
  entityType: string;
  aggregate: string;
  field: string;
  groupBy: string;
  timeField: string;
}
const EMPTY_FORM: FormState = { metricId: '', title: '', description: '', entityType: '', aggregate: 'count', field: '', groupBy: '', timeField: '' };

export function MetricsPage(): JSX.Element {
  const { t } = useTranslation('bi');
  // Same shape as service-desk: a failed org read left `orgId` '', the metrics
  // read is gated `if (!orgId) return`, and the skeleton never resolved.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Organization>(listOrgs);
  const [rows, setRows] = useState<MetricSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The metrics read failed — distinct from "no metrics defined yet". */
  const [rowsFailed, setRowsFailed] = useState(false);
  const [types, setTypes] = useState<EntityType[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // BI-G1 — which control the server blamed (`details.field`), so the message can
  // sit ON it rather than in one detached notice above seven inputs.
  const [errorField, setErrorField] = useState<string | null>(null);
  // BI-G2 — a failed entity-type read leaves the picker holding only the KERNEL
  // types and the field datalist empty, so the form silently offers less than it
  // should and the user hand-types names that then 422.
  const [typesFailed, setTypesFailed] = useState(false);
  const [runs, setRuns] = useState<Record<string, MetricRunResult | 'running' | { error: string }>>({});

  const load = useCallback(() => {
    if (!orgId) return;
    setRows(null); setError(null); setRowsFailed(false);
    // NOT `setRows([])` — that renders "No metrics yet — define a metric over your
    // deals, products, companies, or custom entities" beside the error Notice.
    listBiMetrics(orgId).then(setRows).catch((e) => { setError(e instanceof Error ? e.message : String(e)); setRowsFailed(true); });
  }, [orgId]);
  useEffect(() => { load(); }, [load]);

  const loadTypes = useCallback(() => {
    listEntityTypes()
      .then((ty) => { setTypes(ty); setTypesFailed(false); })
      .catch(() => { setTypes([]); setTypesFailed(true); });
  }, []);
  useEffect(() => { loadTypes(); }, [loadTypes]);

  const typeOptions = useMemo(
    () => [...KERNEL_METRIC_TYPES, ...types.map((ty) => ty.name).filter((n) => !(KERNEL_METRIC_TYPES as readonly string[]).includes(n))],
    [types],
  );
  const fieldsOf = (typeName: string): string[] =>
    types.find((ty) => ty.name === typeName)?.fields.map((f) => f.key) ?? [];

  const runOne = (metricId: string): void => {
    if (!orgId) return;
    setRuns((r) => ({ ...r, [metricId]: 'running' }));
    runBiMetric(orgId, metricId)
      .then((result) => setRuns((r) => ({ ...r, [metricId]: result })))
      .catch((e) => setRuns((r) => ({ ...r, [metricId]: { error: e instanceof Error ? e.message : String(e) } })));
  };

  /** The server's message, but only on the control it blamed. */
  const errOn = (name: string): string | undefined => (errorField === name && formError ? formError : undefined);

  const startCreate = (): void => { setForm(EMPTY_FORM); setEditingId(null); setFormError(null); setErrorField(null); };
  const startEdit = (m: MetricSummary): void => {
    setForm({
      metricId: m.metricId, title: m.title, description: m.description ?? '',
      entityType: m.entityType, aggregate: m.aggregate, field: m.field ?? '',
      groupBy: m.groupBy ?? '', timeField: m.timeField ?? '',
    });
    setEditingId(m.metricId);
    setFormError(null);
    setErrorField(null);
  };

  const save = (): void => {
    if (!orgId || !form) return;
    setSaving(true); setFormError(null); setErrorField(null);
    const body = {
      title: form.title, entityType: form.entityType, aggregate: form.aggregate,
      ...(form.description ? { description: form.description } : {}),
      ...(form.field ? { field: form.field } : {}),
      ...(form.groupBy ? { groupBy: form.groupBy } : {}),
      ...(form.timeField ? { timeField: form.timeField } : {}),
    };
    (editingId ? updateBiMetric(orgId, editingId, body) : createBiMetric(orgId, form.metricId, body))
      .then(() => { setForm(null); setEditingId(null); load(); })
      .catch((e: unknown) => {
        setFormError(e instanceof Error ? e.message : String(e));
        const f = (e as BiRequestError | null)?.field;
        setErrorField(typeof f === 'string' ? f : null);
      })
      .finally(() => setSaving(false));
  };

  const remove = async (m: MetricSummary): Promise<void> => {
    if (!orgId) return;
    const ok = await confirm({ title: t('deleteTitle'), body: t('deleteBody', { title: m.title }), confirmLabel: t('deleteConfirm'), danger: true });
    if (!ok) return;
    deleteBiMetric(orgId, m.metricId).then(load).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const columns: DataColumn<MetricSummary>[] = [
    { key: 'title', header: t('colTitle'), render: (m) => <span>{m.title}{m.system ? <span className="chip u-ml-1-5">{t('systemChip')}</span> : null}</span>, sortValue: (m) => m.title },
    { key: 'entityType', header: t('colEntity'), render: (m) => <code className="u-fs-12">{m.entityType}</code>, sortValue: (m) => m.entityType },
    { key: 'aggregate', header: t('colAggregate'), render: (m) => <span className="u-fs-12">{m.aggregate}{m.field ? ` · ${m.field}` : ''}</span>, sortValue: (m) => m.aggregate },
    { key: 'grouping', header: t('colGrouping'), render: (m) => <span className="u-fs-12 u-text-muted">{m.groupBy ?? m.timeField ?? '—'}</span> },
    {
      key: 'actions', header: '',
      render: (m) => (
        <span className="action-bar">
          <Button variant="quiet" size="sm" onClick={() => runOne(m.metricId)} disabled={runs[m.metricId] === 'running'}>
            <PlayIcon size={13} /> {runs[m.metricId] === 'running' ? t('running') : t('run')}
          </Button>
          {!m.system && <Button variant="quiet" size="sm" onClick={() => startEdit(m)}>{t('edit')}</Button>}
          {!m.system && <Button variant="quiet" size="sm" onClick={() => void remove(m)}>{t('delete')}</Button>}
        </span>
      ),
    },
  ];

  const renderRun = (metricId: string): JSX.Element | null => {
    const r = runs[metricId];
    if (!r || r === 'running') return null;
    if ('error' in r) return <Notice variant="error">{r.error}</Notice>;
    if (r.points.length === 0) return <p className="muted u-fs-12">{t('runEmpty')}</p>;
    return (
      <table className="u-fs-12" aria-label={t('runResultAria', { title: r.title })}>
        <thead><tr><th>{r.groupedBy ?? r.bucket ?? t('runKeyAll')}</th><th>{r.aggregate}</th><th>n</th></tr></thead>
        <tbody>
          {r.points.map((p) => (
            <tr key={p.key}><td>{p.key}</td><td>{formatNumber(p.value, { maximumFractionDigits: 2 })}</td><td>{p.n}</td></tr>
          ))}
        </tbody>
      </table>
    );
  };

  return (
    <section data-walkthrough="metrics.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {/* HG-4 — the noun and the branch ORDER (failed → zero-orgs → children)
          belong to `OrgSelectionState`, not to this page. Both org states still
          sit above the loading branch: the metric read is gated on `orgId`, so
          with none it never starts, `rows` never leaves `null`, and a
          `role="status"` "Loading…" live region would tell a screen-reader user
          forever that work is in progress. Taking the rest as CHILDREN is what
          makes that ordering unskippable.

          CORRECTION — "the rest" did not mean the rest. The "New metric" CTA,
          the whole create/edit form, and both notices were SIBLINGS above this
          wrapper, so they escaped the ordering entirely: over a failed
          organization read the page offered a seven-field metric definition
          form and a Save button whose `save()` returns on `if (!orgId …)` —
          filled in, submitted, and silently discarded. Children cannot be
          rendered above the guard; siblings can, and that is the same defect
          from the other side. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<BarChartIcon size={20} />}>
      <div className="action-bar u-mb-3">
        <Button variant="secondary" size="sm" onClick={startCreate}><PlusIcon size={13} /> {t('newMetric')}</Button>
        {orgs && orgs.length > 1 && (
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label={t('ui:orgPickerLabel')}>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </select>
        )}
      </div>
      {form && (
        <div className="surface-card u-mb-3">
          <h3 className="u-mt-0">{editingId ? t('editTitle') : t('createTitle')}</h3>
          <div className="form-grid">
            {/* BI-G1 — `errOn(name)` puts the SERVER's sentence on the control it
                blamed. `ui/Field` is what gives it somewhere to go: the previous
                hand-rolled labels had no error slot, which is why a located 422
                had to be rendered as one detached notice. */}
            {!editingId && (
              <TextField label={t('fieldId')} value={form.metricId} placeholder="deal-win-rate"
                error={errOn('metricId')} onChange={(e) => setForm({ ...form, metricId: e.target.value })} />
            )}
            <TextField label={t('fieldTitle')} value={form.title} error={errOn('title')}
              onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <SelectField label={t('fieldEntity')} value={form.entityType} error={errOn('entityType')}
              {...(typesFailed ? { help: t('typesFailedHelp') } : {})}
              onChange={(e) => setForm({ ...form, entityType: e.target.value })}>
              <option value="">{t('fieldEntityPick')}</option>
              {typeOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </SelectField>
            <SelectField label={t('fieldAggregate')} value={form.aggregate} error={errOn('aggregate')}
              onChange={(e) => setForm({ ...form, aggregate: e.target.value })}>
              {AGGREGATES.map((a) => <option key={a} value={a}>{a}</option>)}
            </SelectField>
            {form.aggregate !== 'count' && (
              <TextField label={t('fieldField')} value={form.field} list="bi-fields" error={errOn('field')}
                onChange={(e) => setForm({ ...form, field: e.target.value })} />
            )}
            <TextField label={t('fieldGroupBy')} value={form.groupBy} list="bi-fields" error={errOn('groupBy')}
              onChange={(e) => setForm({ ...form, groupBy: e.target.value })} />
            <TextField label={t('fieldTimeField')} value={form.timeField} list="bi-fields" error={errOn('timeField')}
              onChange={(e) => setForm({ ...form, timeField: e.target.value })} />
            <TextField label={t('fieldDescription')} value={form.description} error={errOn('description')}
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <datalist id="bi-fields">
              {fieldsOf(form.entityType).map((f) => <option key={f} value={f} />)}
            </datalist>
          </div>
          {/* Only when the server did NOT locate it — otherwise the message is
              already on the control and a second copy is noise. */}
          {formError && !errorField && <Notice variant="error">{formError}</Notice>}
          <div className="action-bar u-mt-2">
            <Button variant="primary" size="sm" onClick={save} disabled={saving || !form.title || !form.entityType}>
              {saving ? t('saving') : t('save')}
            </Button>
            <Button variant="quiet" size="sm" onClick={() => { setForm(null); setEditingId(null); }}>{t('cancel')}</Button>
          </div>
        </div>
      )}
      {typesFailed && (
        <Notice variant="warning" announce={t('typesFailed')}>
          {t('typesFailed')}{' '}
          <Button variant="quiet" size="sm" onClick={loadTypes}>{t('typesRetry')}</Button>
        </Notice>
      )}
      {error && <Notice variant="error">{error}</Notice>}
      {rowsFailed ? (
        <StateCard announce icon={<BarChartIcon size={20} />} title={t('rowsFailedTitle')} body={t('rowsFailedBody')}
          action={<Button variant="secondary" onClick={() => load()}>{t('orgsRetry')}</Button>} />
      ) : rows === null ? (
        <SkeletonRows rows={5} columns={['30%', '20%', '20%', '15%', '15%']} />
      ) : rows.length === 0 ? (
        <StateCard icon={<BarChartIcon size={20} />} title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(m) => m.metricId} />
          {rows.map((m) => {
            const detail = renderRun(m.metricId);
            return detail ? <div key={m.metricId} className="surface-card u-mt-2"><h4 className="u-mt-0 u-fs-13">{m.title}</h4>{detail}</div> : null;
          })}
        </>
      )}
      </OrgSelectionState>
    </section>
  );
}
