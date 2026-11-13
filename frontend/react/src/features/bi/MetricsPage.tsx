/**
 * BI metrics admin (ADR 0417 P4) — the governed metric catalog: list (system +
 * tenant metrics), define/edit/delete tenant metrics, and run any metric
 * inline. Validation is the backend's closed world — this form submits and
 * surfaces the typed 422s rather than duplicating the registry rules.
 *
 * ADR 1052: the page offers writes only to a caller the server says may manage the
 * org's catalog (D11); the editor round-trips a metric's filters and version, so a
 * save keeps what it measures and never overwrites a newer edit (D8/D12); a stale
 * metric shows which field broke it (D1); a run says when it is partial (D3/D4) or
 * workspace-wide (D2).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Notice } from '../../ui/Notice.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { confirm } from '../../ui/confirm.js';
import { useLiveRegion } from '../../ui/announce.js';
import { SelectField, TextField } from '../../ui/Field.js';
import { BarChartIcon, PlusIcon, PlayIcon } from '../../ui/icons/index.js';
import { formatNumber } from '../../i18n/format.js';
import { listOrgs, type Organization } from '../../client/accessClient.js';
import { listEntityTypes, type EntityType, type EntityFieldSpec } from '../entities/entitiesClient.js';
import {
  listBiMetrics, runBiMetric, createBiMetric, updateBiMetric, deleteBiMetric, adoptBiMetric,
  KERNEL_METRIC_TYPES, METRIC_FILTER_OPS, type MetricSummary, type MetricRunResult, type BiRequestError,
  type MetricFilter, type MetricFilterOp,
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
  /** ADR 1052 D12 — PATCH replaces the definition, so the editor carries these. */
  filters: MetricFilter[];
  /** ADR 1052 D8 — the version this edit is made against. */
  updatedAt?: string;
}
const EMPTY_FORM: FormState = { metricId: '', title: '', description: '', entityType: '', aggregate: 'count', field: '', groupBy: '', timeField: '', filters: [] };

/** The op labels are product copy, not the wire spelling. */
const OP_LABEL: Record<MetricFilterOp, string> = {
  eq: 'opEq', neq: 'opNeq', in: 'opIn', gt: 'opGt', gte: 'opGte', lt: 'opLt', lte: 'opLte', contains: 'opContains',
};

/** A typed draft value → the wire value the server validates (closed world there).
 *  With no field spec (the built-in types' fields are not listed here) a number-looking
 *  value is sent as a number and the server's typed 422 corrects a wrong guess. */
function filterValueOf(raw: string, op: MetricFilterOp, spec: EntityFieldSpec | undefined): MetricFilter['value'] {
  const num = (v: string): string | number => (/^-?\d+(\.\d+)?$/.test(v.trim()) && (spec === undefined || spec.type === 'number') ? Number(v.trim()) : v.trim());
  if (op === 'in') return raw.split(',').map((v) => v.trim()).filter(Boolean).map(num);
  if (spec?.type === 'boolean') return raw.trim() === 'true';
  return num(raw);
}

/** The conditions that make sense for a field's kind (UX grade M6); all of them when
 *  the kind is unknown. The server enforces the same rules. */
function opsFor(spec: EntityFieldSpec | undefined): readonly MetricFilterOp[] {
  if (!spec) return METRIC_FILTER_OPS;
  if (spec.type === 'boolean') return ['eq', 'neq'];
  if (spec.type === 'enum') return ['eq', 'neq', 'in'];
  if (spec.type === 'number') return ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'];
  return METRIC_FILTER_OPS;
}

/** Definition keys the server can blame that are not entity fields. */
const RESERVED_FIELD_LABEL: Record<string, string> = { entityType: 'fieldEntity', timeField: 'fieldTimeField', field: 'fieldField' };
const shownValue = (v: MetricFilter['value']): string => (Array.isArray(v) ? v.join(', ') : String(v));

export function MetricsPage(): JSX.Element {
  const { t } = useTranslation('bi');
  // Same shape as service-desk: a failed org read left `orgId` '', the metrics
  // read is gated `if (!orgId) return`, and the skeleton never resolved.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Organization>(listOrgs);
  const [rows, setRows] = useState<MetricSummary[] | null>(null);
  /** ADR 1052 D11 — false until the server says otherwise: never offer a write that 403s. */
  const [canManage, setCanManage] = useState(false);
  /** The draft filter row in the editor. */
  const [draft, setDraft] = useState<{ key: string; op: MetricFilterOp; value: string }>({ key: '', op: 'eq', value: '' });
  /** ADR 1052 D8 — someone saved this metric after it was loaded. */
  const [conflict, setConflict] = useState(false);
  /** UX grade H2/M7 — a filter problem, ON the filter control it is about. */
  const [draftError, setDraftError] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<{ index: number; message: string } | null>(null);
  /** UX grade M5 — added/removed filters are announced, and focus has somewhere to go. */
  // The shared live-region hook: a repeat of the same text still re-announces.
  const [filterAnnounce, announce] = useLiveRegion();
  /** UX re-grade M2 — which draft control carries the "add or clear" error. */
  const [draftErrorOn, setDraftErrorOn] = useState<'field' | 'value'>('value');
  const draftValueRef = useRef<HTMLInputElement & HTMLSelectElement>(null);
  const filterFieldRef = useRef<HTMLInputElement>(null);
  const editorHeadingRef = useRef<HTMLHeadingElement>(null);
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

  // grade-code M3 — an editor, a run or a write permission belongs to ONE org: a picker
  // change must not let a form opened in org A save into org B.
  // Re-grade L1 — the org every async reply must still belong to when it lands: a slow
  // org-A reply after a switch to B would otherwise show A's rows and permission, or
  // reopen A's editor inside B and save into B.
  const orgRef = useRef(orgId);
  useEffect(() => {
    orgRef.current = orgId;
    setForm(null); setEditingId(null); setConflict(false); setRuns({}); setCanManage(false);
  }, [orgId]);
  const stillOn = (requested: string): boolean => orgRef.current === requested;

  const load = useCallback(() => {
    if (!orgId) return;
    setRows(null); setError(null); setRowsFailed(false); setCanManage(false);
    // NOT `setRows([])` — that renders "No metrics yet — define a metric over your
    // deals, products, companies, or custom entities" beside the error Notice.
    const requested = orgId;
    listBiMetrics(requested)
      .then((cat) => { if (!stillOn(requested)) return; setRows(cat.metrics); setCanManage(cat.viewer.canManage); })
      .catch((e) => { if (!stillOn(requested)) return; setError(e instanceof Error ? e.message : String(e)); setRowsFailed(true); });
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
  const specsOf = (typeName: string): EntityFieldSpec[] => types.find((ty) => ty.name === typeName)?.fields ?? [];
  const fieldsOf = (typeName: string): string[] => specsOf(typeName).map((f) => f.key);

  const fieldLabel = (field: string): string => (RESERVED_FIELD_LABEL[field] ? t(RESERVED_FIELD_LABEL[field]!) : field);
  const staleText = (m: Pick<MetricSummary, 'system'>, field: string): string =>
    t(m.system ? 'staleHintSystem' : canManage ? 'staleHint' : 'staleHintReader', { field: fieldLabel(field) });

  const runOne = (metricId: string): void => {
    if (!orgId) return;
    setRuns((r) => ({ ...r, [metricId]: 'running' }));
    const requested = orgId;
    runBiMetric(requested, metricId)
      .then((result) => { if (stillOn(requested)) setRuns((r) => ({ ...r, [metricId]: result })); })
      .catch((e: unknown) => {
        if (!stillOn(requested)) return;
        // ADR 1052 D1 — say which field broke the metric, in the reader's language.
        const be = e as BiRequestError | null;
        if (be?.reason === 'metric_stale' && be.field) {
          // It went stale since the list loaded: the row takes the stale state (chip, no
          // Run) instead of a red error beside a Run button (UX grade L15).
          const field = be.field;
          setRows((rs) => rs?.map((m) => (m.metricId === metricId ? { ...m, stale: { field } } : m)) ?? rs);
          // UX re-grade M1 — the Run button just pressed is gone: say why, and move focus
          // to the reason now shown in its row.
          const row = rows?.find((m) => m.metricId === metricId);
          announce(staleText(row ?? {}, field));
          requestAnimationFrame(() => document.getElementById(`bi-stale-${metricId}`)?.focus());
          setRuns((r) => { const next = { ...r }; delete next[metricId]; return next; });
          return;
        }
        setRuns((r) => ({ ...r, [metricId]: { error: e instanceof Error ? e.message : String(e) } }));
      });
  };

  /** The server's message, but only on the control it blamed. */
  const errOn = (name: string): string | undefined => (errorField === name && formError ? formError : undefined);

  const resetDraft = (): void => { setDraft({ key: '', op: 'eq', value: '' }); setDraftError(null); };
  const startCreate = (): void => { setForm(EMPTY_FORM); setEditingId(null); setFormError(null); setErrorField(null); setConflict(false); resetDraft(); };
  const startEdit = (m: MetricSummary): void => {
    setForm({
      metricId: m.metricId, title: m.title, description: m.description ?? '',
      entityType: m.entityType, aggregate: m.aggregate, field: m.field ?? '',
      groupBy: m.groupBy ?? '', timeField: m.timeField ?? '',
      filters: m.filters ?? [],
      ...(m.updatedAt ? { updatedAt: m.updatedAt } : {}),
    });
    setEditingId(m.metricId);
    setFormError(null);
    setErrorField(null);
    setFilterError(null);
    setConflict(false);
    resetDraft();
  };

  const save = (): void => {
    if (!orgId || !form || conflict) return;
    // UX grade H2 — a filter typed but not added must not vanish on Save: the metric
    // would quietly measure more than the user meant.
    if (draft.key || draft.value.trim()) {
      // The error sits on the control that is focused (UX re-grade M2): the value when a
      // field was chosen, else the field.
      const on = draft.key ? 'value' : 'field';
      setDraftErrorOn(on);
      setDraftError(t('draftNotAdded'));
      (on === 'value' ? draftValueRef.current : filterFieldRef.current)?.focus();
      return;
    }
    setSaving(true); setFormError(null); setErrorField(null); setFilterError(null);
    const body = {
      title: form.title, entityType: form.entityType, aggregate: form.aggregate,
      ...(form.description ? { description: form.description } : {}),
      ...(form.field ? { field: form.field } : {}),
      ...(form.groupBy ? { groupBy: form.groupBy } : {}),
      ...(form.timeField ? { timeField: form.timeField } : {}),
      // Always sent: an empty list is how a removed filter is removed (PATCH replaces).
      filters: form.filters,
      ...(editingId && form.updatedAt ? { expectedUpdatedAt: form.updatedAt } : {}),
    };
    (editingId ? updateBiMetric(orgId, editingId, body) : createBiMetric(orgId, form.metricId, body))
      .then(() => { setForm(null); setEditingId(null); load(); })
      .catch((e: unknown) => {
        const be = e as BiRequestError | null;
        if (be?.reason === 'metric_changed') { setConflict(true); return; }
        const message = e instanceof Error ? e.message : String(e);
        // UX grade M7 — a refused filter is named by index: the message sits on that row.
        if (be?.field === 'filters' && typeof be.index === 'number' && form && be.index < form.filters.length) {
          setFilterError({ index: be.index, message });
          return;
        }
        setFormError(message);
        const f = be?.field;
        setErrorField(typeof f === 'string' ? f : null);
      })
      .finally(() => setSaving(false));
  };

  const adopt = async (m: MetricSummary): Promise<void> => {
    if (!orgId) return;
    const ok = await confirm({ title: t('adoptTitle'), body: t('adoptBody', { title: m.title }), confirmLabel: t('adoptConfirm') });
    if (!ok) return;
    adoptBiMetric(orgId, m.metricId).then(load).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const remove = async (m: MetricSummary): Promise<void> => {
    if (!orgId) return;
    const ok = await confirm({ title: t('deleteTitle'), body: t('deleteBody', { title: m.title }), confirmLabel: t('deleteConfirm'), danger: true });
    if (!ok) return;
    deleteBiMetric(orgId, m.metricId).then(load).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const addFilter = (): void => {
    if (!form || !draft.key || !draft.value.trim()) return;
    const spec = specsOf(form.entityType).find((f) => f.key === draft.key);
    setForm({ ...form, filters: [...form.filters, { key: draft.key, op: draft.op, value: filterValueOf(draft.value, draft.op, spec) }] });
    announce(t('filterAdded', { key: draft.key }));
    setFilterError(null);
    resetDraft();
    filterFieldRef.current?.focus();
  };
  const removeFilter = (i: number): void => {
    if (!form) return;
    announce(t('filterRemoved', { key: form.filters[i]?.key ?? '' }));
    setFilterError(null);
    setForm({ ...form, filters: form.filters.filter((_, j) => j !== i) });
    filterFieldRef.current?.focus();
  };
  /** D8 — reload the catalog and reopen the editor on the version someone else saved. */
  const reloadAfterConflict = (): void => {
    if (!orgId || !editingId) return;
    const id = editingId;
    const requested = orgId;
    setConflict(false);
    listBiMetrics(requested)
      .then((cat) => {
        if (!stillOn(requested)) return;
        setRows(cat.metrics); setCanManage(cat.viewer.canManage);
        const fresh = cat.metrics.find((m) => m.metricId === id);
        if (fresh && cat.viewer.canManage) { startEdit(fresh); requestAnimationFrame(() => editorHeadingRef.current?.focus()); }
        else { setForm(null); setEditingId(null); }
      })
      // Keep the conflict up: the editor still holds the old version (UX re-grade L6).
      .catch((e) => { if (!stillOn(requested)) return; setConflict(true); setError(e instanceof Error ? e.message : String(e)); });
  };
  const draftSpec = form ? specsOf(form.entityType).find((f) => f.key === draft.key) : undefined;
  const draftOps = opsFor(draftSpec);

  const columns: DataColumn<MetricSummary>[] = [
    {
      key: 'title', header: t('colTitle'), sortValue: (m) => m.title,
      render: (m) => (
        <span>
          {m.title}
          {m.system ? <span className="chip u-ml-1-5">{t('systemChip')}</span> : null}
          {m.legacy ? <span className="chip chip--muted u-ml-1-5">{t('legacyChip')}</span> : null}
          {m.legacy ? <span className="u-block u-fs-12 muted">{t(canManage ? 'legacyHint' : 'legacyHintReader')}</span> : null}
          {m.stale ? (
            <>
              <span className="chip chip--warning u-ml-1-5">{t(canManage && !m.system ? 'staleChip' : 'staleChipReader', { field: fieldLabel(m.stale.field) })}</span>
              {/* Visible, not a tooltip: keyboard, touch and screen-reader users get the reason too. */}
              <span className="u-block u-fs-12 muted" id={`bi-stale-${m.metricId}`} tabIndex={-1}>{staleText(m, m.stale.field)}</span>
            </>
          ) : null}
        </span>
      ),
    },
    { key: 'entityType', header: t('colEntity'), render: (m) => <code className="u-fs-12">{m.entityType}</code>, sortValue: (m) => m.entityType },
    { key: 'aggregate', header: t('colAggregate'), render: (m) => <span className="u-fs-12">{m.aggregate}{m.field ? ` · ${m.field}` : ''}</span>, sortValue: (m) => m.aggregate },
    { key: 'grouping', header: t('colGrouping'), render: (m) => <span className="u-fs-12 u-text-muted">{m.groupBy ?? m.timeField ?? '—'}</span> },
    {
      key: 'actions', header: '',
      render: (m) => (
        <span className="action-bar">
          {/* A stale metric cannot run (D1): the chip says why, not a Run that fails. */}
          {!m.stale && (
            <Button variant="quiet" size="sm" onClick={() => runOne(m.metricId)} disabled={runs[m.metricId] === 'running'}>
              <PlayIcon size={13} /> {runs[m.metricId] === 'running' ? t('running') : t('run')}
            </Button>
          )}
          {canManage && !m.system && !m.legacy && <Button variant="quiet" size="sm" onClick={() => startEdit(m)}>{t('edit')}</Button>}
          {canManage && !m.system && !m.legacy && <Button variant="quiet" size="sm" onClick={() => void remove(m)}>{t('delete')}</Button>}
          {/* BI84WF-12 — a pre-1052 metric is read-only until moved into one org. */}
          {canManage && m.legacy && <Button variant="quiet" size="sm" onClick={() => void adopt(m)}>{t('adopt')}</Button>}
        </span>
      ),
    },
  ];

  const renderRun = (metricId: string): JSX.Element | null => {
    const r = runs[metricId];
    if (!r || r === 'running') return null;
    if ('error' in r) return <Notice variant="error">{r.error}</Notice>;
    // D2/D3/D4 — what this answer does NOT include is part of the answer.
    const notes = [
      ...(r.scope === 'tenant' ? [t('runScopeTenant')] : []),
      ...(r.groupsTruncated ? [r.bucket ? t('runDroppedBuckets', { count: r.points.length }) : t('runDroppedGroups', { count: r.droppedGroups ?? 0 })] : []),
      ...(r.undatedRows ? [t('runUndated', { count: r.undatedRows })] : []),
    ];
    const noteList = notes.length ? <ul className="u-fs-12 muted u-mt-1">{notes.map((n) => <li key={n}>{n}</li>)}</ul> : null;
    if (r.points.length === 0) return <><p className="muted u-fs-12">{t('runEmpty')}</p>{noteList}</>;
    return (
      <>
      <table className="u-fs-12" aria-label={t('runResultAria', { title: r.title })}>
        <thead><tr><th>{r.groupedBy ?? r.bucket ?? t('runKeyAll')}</th><th>{r.aggregate}</th><th>{t('runColRows')}</th></tr></thead>
        <tbody>
          {r.points.map((p) => (
            <tr key={p.key}><td>{p.key}</td><td>{formatNumber(p.value, { maximumFractionDigits: 2 })}</td><td>{p.n}</td></tr>
          ))}
        </tbody>
      </table>
      {noteList}
      </>
    );
  };

  return (
    <section data-walkthrough="metrics.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {/* One polite status region for the page: filter add/remove, a metric gone stale. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{filterAnnounce}</p>
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
        {canManage && <Button variant="secondary" size="sm" onClick={startCreate}><PlusIcon size={13} /> {t('newMetric')}</Button>}
        {orgs && orgs.length > 1 && (
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label={t('ui:orgPickerLabel')}>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </select>
        )}
      </div>
      {form && canManage && (
        <div className="surface-card u-mb-3">
          <h3 className="u-mt-0" ref={editorHeadingRef} tabIndex={-1}>{editingId ? t('editTitle') : t('createTitle')}</h3>
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
            <fieldset>
              <legend>{t('filtersLabel')}</legend>
              {form.filters.length === 0 ? (
                <p className="muted u-fs-12 u-mt-0">{t('filtersNone')}</p>
              ) : (
                <ul className="u-fs-12">
                  {form.filters.map((f, i) => (
                    <li key={`${f.key}-${i}`}>
                      <code>{f.key}</code> {t(OP_LABEL[f.op])} <code>{shownValue(f.value)}</code>{' '}
                      <Button variant="quiet" size="sm" onClick={() => removeFilter(i)} aria-label={t('filterRemove', { n: i + 1, key: f.key })}>{t('filterRemoveShort')}</Button>
                      {filterError?.index === i && <Notice variant="error">{filterError.message}</Notice>}
                    </li>
                  ))}
                </ul>
              )}
              {errOn('filters') && <Notice variant="error">{errOn('filters')}</Notice>}
              <div className="form-grid">
                <TextField ref={filterFieldRef} label={t('filterField')} value={draft.key} list="bi-fields"
                  error={draftError && draftErrorOn === 'field' ? draftError : undefined}
                  onChange={(e) => {
                    const spec = specsOf(form.entityType).find((f) => f.key === e.target.value);
                    const ops = opsFor(spec);
                    // Keep the typed value unless the field's kind changed (UX re-grade L3).
                    const keep = spec?.type === draftSpec?.type;
                    setDraft({ key: e.target.value, op: ops.includes(draft.op) ? draft.op : ops[0]!, value: keep ? draft.value : '' });
                    setDraftError(null);
                  }} />
                <SelectField label={t('filterOp')} value={draft.op}
                  onChange={(e) => setDraft({ ...draft, op: e.target.value as MetricFilterOp })}>
                  {draftOps.map((op) => <option key={op} value={op}>{t(OP_LABEL[op])}</option>)}
                </SelectField>
                {/* The value control follows the field's kind (UX grade M6). */}
                {(draftSpec?.type === 'enum' && draft.op !== 'in') || draftSpec?.type === 'boolean' ? (
                  <SelectField ref={draftValueRef} label={t('filterValue')} value={draft.value} error={draftError && draftErrorOn === 'value' ? draftError : undefined}
                    onChange={(e) => { setDraft({ ...draft, value: e.target.value }); setDraftError(null); }}>
                    <option value="">{t('filterValuePick')}</option>
                    {(draftSpec.type === 'boolean' ? ['true', 'false'] : draftSpec.options ?? []).map((o) => (
                      <option key={o} value={o}>{draftSpec.type === 'boolean' ? t(o === 'true' ? 'valueYes' : 'valueNo') : o}</option>
                    ))}
                  </SelectField>
                ) : (
                  <TextField ref={draftValueRef} label={t('filterValue')} value={draft.value} error={draftError && draftErrorOn === 'value' ? draftError : undefined}
                    help={draft.op === 'in' ? (draftSpec?.type === 'enum' ? t('filterValueInOptions', { options: (draftSpec.options ?? []).join(', ') }) : t('filterValueInHelp')) : undefined}
                    onChange={(e) => { setDraft({ ...draft, value: e.target.value }); setDraftError(null); }} />
                )}
              </div>
              <span className="action-bar">
                <Button variant="quiet" size="sm" onClick={addFilter} disabled={!draft.key || !draft.value.trim()}><PlusIcon size={13} /> {t('filterAdd')}</Button>
                {(draft.key || draft.value) && (
                  <Button variant="quiet" size="sm" onClick={() => { resetDraft(); filterFieldRef.current?.focus(); }}>{t('filterClear')}</Button>
                )}
              </span>
            </fieldset>
            <datalist id="bi-fields">
              {fieldsOf(form.entityType).map((f) => <option key={f} value={f} />)}
            </datalist>
          </div>
          {/* Only when the server did NOT locate it — otherwise the message is
              already on the control and a second copy is noise. */}
          {formError && !errorField && <Notice variant="error">{formError}</Notice>}
          {conflict && (
            <Notice variant="warning" announce={t('changedConflict')}>
              {t('changedConflict')}{' '}
              <Button variant="quiet" size="sm" onClick={reloadAfterConflict}>{t('changedReload')}</Button>
            </Notice>
          )}
          <div className="action-bar u-mt-2">
            <Button variant="primary" size="sm" onClick={save} disabled={saving || conflict || !form.title || !form.entityType}>
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
        <StateCard icon={<BarChartIcon size={20} />} title={t('emptyTitle')} body={t(canManage ? 'emptyBody' : 'emptyBodyReader')} />
      ) : (
        <>
          <DataTable caption={t('title')} columns={columns} rows={rows} rowKey={(m) => m.metricId} />
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
