/**
 * Entities page (ADR 0386 Phase 1) — headless content-modeling: define types
 * (schema-driven fields), then create/edit/delete records of each type. The
 * form vocabulary mirrors CRM's custom-field editor (the ADR 0257 seam this
 * feature reuses server-side).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { DatabaseIcon, PlusIcon, TrashIcon, PencilIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { formatRelativeTime } from '../../i18n/format.js';
import {
  createEntity,
  createEntityType,
  createRelationship,
  deleteEntity,
  deleteEntityType,
  deleteRelationship,
  exportUrl,
  importEntities,
  listEntities,
  getEntityLocaleContext,
  listEntityTypes,
  listRelationships,
  listTaxonomies,
  listTerms,
  queryEntities,
  updateEntity,
  updateEntityType,
  type EntityFieldSpec,
  type EntityLocaleContext,
  type EntityFieldType,
  type EntityRow,
  type EntityType,
  type QueryFilter,
  type QueryOp,
  type Relationship,
  type Taxonomy,
  type Term,
} from './entitiesClient.js';
import { TaxonomyPanel } from './TaxonomyPanel.js';

const FIELD_TYPES: EntityFieldType[] = ['string', 'number', 'boolean', 'date', 'enum', 'reference', 'media'];

interface DraftField {
  key: string;
  label: string;
  type: EntityFieldType;
  required: boolean;
  options: string; // comma-separated for enum
  refEntityType: string; // reference only
  /** ADR 0406 — string fields only (the seam enforces). */
  localizable: boolean;
}

const emptyField = (): DraftField => ({ key: '', label: '', type: 'string', required: false, options: '', refEntityType: '', localizable: false });

function toSpecInput(f: DraftField): {
  key: string; label?: string; type: EntityFieldType; required: boolean; options?: string[]; refEntityType?: string; localizable?: boolean;
} {
  return {
    key: f.key.trim(),
    ...(f.label.trim() ? { label: f.label.trim() } : {}),
    type: f.type,
    required: f.required,
    ...(f.type === 'string' && f.localizable ? { localizable: true } : {}),
    ...(f.type === 'enum'
      ? { options: f.options.split(',').map((o) => o.trim()).filter((o) => o.length > 0) }
      : {}),
    ...(f.type === 'reference' && f.refEntityType ? { refEntityType: f.refEntityType } : {}),
  };
}

/** Schema-driven input for one field of the selected type. `refOptions` feeds a
 *  `reference` field's target-entity select (first page of the target type). */
function FieldInput(props: {
  spec: EntityFieldSpec;
  value: string;
  onChange: (v: string) => void;
  refOptions?: Array<{ id: string; label: string }>;
  yesLabel: string;
  noLabel: string;
}): JSX.Element {
  const { spec, value, onChange, refOptions, yesLabel, noLabel } = props;
  const id = `ent-f-${spec.key}`;
  if (spec.type === 'reference') {
    // The stored value must ALWAYS be a selectable option — a target beyond the
    // loaded page would otherwise render "" and be silently cleared on save
    // (grade-code #5).
    const options = refOptions ?? [];
    const hasCurrent = value === '' || options.some((o) => o.id === value);
    return (
      <select id={id} className="ui-input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {!hasCurrent ? <option value={value}>{value}</option> : null}
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
    );
  }
  if (spec.type === 'boolean') {
    return (
      <select id={id} className="ui-input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        <option value="true">{yesLabel}</option>
        <option value="false">{noLabel}</option>
      </select>
    );
  }
  if (spec.type === 'enum') {
    return (
      <select id={id} className="ui-input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {(spec.options ?? []).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }
  return (
    <input
      id={id}
      className="ui-input"
      type={spec.type === 'number' ? 'number' : spec.type === 'date' ? 'date' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function coerceValues(specs: EntityFieldSpec[], raw: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of specs) {
    const v = raw[s.key];
    if (v === undefined || v === '') continue;
    if (s.type === 'number') out[s.key] = Number(v);
    else if (s.type === 'boolean') out[s.key] = v === 'true';
    else out[s.key] = v;
  }
  return out;
}

export function EntitiesPage(): JSX.Element {
  const { t } = useTranslation('entities');
  const access = useFeatureAccess('entities');
  const [types, setTypes] = useState<EntityType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<EntityRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // New-type form
  const [showTypeForm, setShowTypeForm] = useState(false);
  const [typeName, setTypeName] = useState('');
  const [typeDisplay, setTypeDisplay] = useState('');
  const [draftFields, setDraftFields] = useState<DraftField[]>([emptyField()]);

  // Entity form (create or edit)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [showEntityForm, setShowEntityForm] = useState(false);
  const [formTermIds, setFormTermIds] = useState<string[]>([]);
  // ADR 0406 P5 — per-locale overlays + the workspace locale context (one
  // backend resolver; null while loading, {enabled:false} when off).
  const [formLocalizations, setFormLocalizations] = useState<Record<string, Record<string, string>>>({});
  const [localeCtx, setLocaleCtx] = useState<EntityLocaleContext | null>(null);
  /**
   * EN-G1 — the locale-context read FAILED, as distinct from a workspace that
   * genuinely has localization off. The catch used to fabricate
   * `{ enabled: false }`, which is the same value as "off" — so a transient
   * failure silently REMOVED the translations editor and made a localized
   * workspace look like a plain one.
   *
   * Checked rather than assumed: this does NOT lose data. `overlays` becomes
   * `undefined` and `updateEntity` omits the field entirely
   * (`...(localizations ? { localizations } : {})`), so stored translations are
   * untouched. The cost is a confiscated capability and a wrong claim about the
   * workspace, not silent data loss — I suspected the latter and the client
   * disproved it.
   */
  const [localeCtxFailed, setLocaleCtxFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void getEntityLocaleContext()
      .then((ctx) => { if (active) { setLocaleCtx(ctx); setLocaleCtxFailed(false); } })
      .catch(() => { if (active) { setLocaleCtx({ enabled: false }); setLocaleCtxFailed(true); } });
    return () => { active = false; };
  }, []);

  // Phase 2 — reference options, taxonomy terms, relationships
  const [refOptions, setRefOptions] = useState<Record<string, Array<{ id: string; label: string }>>>({});
  const [taxonomies, setTaxonomies] = useState<Taxonomy[]>([]);
  const [termsByTax, setTermsByTax] = useState<Record<string, Term[]>>({});
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [relTo, setRelTo] = useState('');
  const [relOnDelete, setRelOnDelete] = useState<Relationship['onDelete']>('restrict');

  const selectedType = useMemo(() => types?.find((x) => x.name === selected) ?? null, [types, selected]);

  // Load reference-target options (first page per referenced type) + taxonomy
  // terms whenever the entity form opens.
  useEffect(() => {
    if (!showEntityForm || !selectedType) return;
    let cancelled = false;
    void (async () => {
      const next: Record<string, Array<{ id: string; label: string }>> = {};
      for (const spec of selectedType.fields) {
        if (spec.type !== 'reference' || !spec.refEntityType) continue;
        try {
          const page = await listEntities(spec.refEntityType, { limit: 50 });
          next[spec.key] = page.entities.map((e) => {
            const firstString = Object.values(e.values).find((v) => typeof v === 'string');
            return { id: e.entityId, label: typeof firstString === 'string' ? firstString : e.entityId };
          });
        } catch {
          next[spec.key] = [];
        }
      }
      try {
        const taxes = await listTaxonomies();
        const byTax: Record<string, Term[]> = {};
        for (const tax of taxes) {
          try {
            byTax[tax.name] = await listTerms(tax.name);
          } catch {
            byTax[tax.name] = [];
          }
        }
        if (!cancelled) {
          setTaxonomies(taxes);
          setTermsByTax(byTax);
        }
      } catch {
        if (!cancelled) setTaxonomies([]);
      }
      if (!cancelled) setRefOptions(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [showEntityForm, selectedType]);

  const refreshRelationships = useCallback(async () => {
    try {
      setRelationships(await listRelationships());
    } catch {
      setRelationships([]);
    }
  }, []);

  useEffect(() => {
    if (access.enabled) void refreshRelationships();
  }, [access.enabled, refreshRelationships]);

  const refreshTypes = useCallback(async () => {
    try {
      const list = await listEntityTypes();
      setTypes(list);
      setError(null);
      const first = list[0];
      if (first && !list.some((x) => x.name === selected)) setSelected(first.name);
      if (list.length === 0) setSelected(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTypes([]);
    }
  }, [selected]);

  // Phase 3 — filter bar state
  const [filterKey, setFilterKey] = useState('');
  const [filterOp, setFilterOp] = useState<QueryOp>('eq');
  const [filterValue, setFilterValue] = useState('');
  const [activeFilters, setActiveFilters] = useState<QueryFilter[]>([]);
  // §4.5 collection search (DESIGN.md rule 13) — client-side free-text over the
  // loaded page's display values; complements the bespoke field/op/value query.
  const [nameQuery, setNameQuery] = useState('');

  const refreshRows = useCallback(
    async (typeName0: string, filters?: QueryFilter[]) => {
      setRows(null);
      try {
        const effective = filters ?? activeFilters;
        if (effective.length > 0) {
          const page = await queryEntities(typeName0, { filters: effective, limit: 50 });
          setRows(page.entities);
          setNextCursor(page.nextCursor);
        } else {
          const page = await listEntities(typeName0, { limit: 50 });
          setRows(page.entities);
          setNextCursor(page.nextCursor);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setRows([]);
      }
    },
    [activeFilters],
  );

  useEffect(() => {
    if (access.enabled) void refreshTypes();
  }, [access.enabled, refreshTypes]);

  useEffect(() => {
    // Switching types drops the previous type's filters (their field keys
    // don't exist on the new type — a stale filter would 400 every load).
    setActiveFilters([]);
    setFilterKey('');
    setFilterValue('');
    setNameQuery('');
    if (selected) void refreshRows(selected, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshRows changes with activeFilters; this effect intentionally keys on `selected` only
  }, [selected]);

  const onCreateType = useCallback(async () => {
    setBusy(true);
    try {
      const fields = draftFields.filter((f) => f.key.trim().length > 0).map(toSpecInput);
      await createEntityType({
        name: typeName,
        ...(typeDisplay.trim() ? { displayName: typeDisplay.trim() } : {}),
        fields,
      });
      toast.success(t('typeCreated'));
      setShowTypeForm(false);
      setTypeName('');
      setTypeDisplay('');
      setDraftFields([emptyField()]);
      await refreshTypes();
      setSelected(typeName.trim().toLowerCase());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [draftFields, typeName, typeDisplay, refreshTypes, t]);

  const onTogglePublish = useCallback(async () => {
    if (!selectedType) return;
    setBusy(true);
    try {
      const next = selectedType.status === 'published' ? 'draft' : 'published';
      await updateEntityType(selectedType.name, { status: next });
      toast.success(next === 'published' ? t('typePublished') : t('typeUnpublished'));
      await refreshTypes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selectedType, refreshTypes, t]);

  // ADR 0407 — the anonymous-read opt-in (type-admin; meaningful when published).
  const onTogglePublicRead = useCallback(async () => {
    if (!selectedType) return;
    setBusy(true);
    try {
      const next = selectedType.publicRead !== true;
      await updateEntityType(selectedType.name, { publicRead: next });
      toast.success(next ? t('typePublicOn') : t('typePublicOff'));
      await refreshTypes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selectedType, refreshTypes, t]);

  // ADR 0407 — entry-level draft/live (absent status = live).
  const onToggleEntityStatus = useCallback(async (row: EntityRow) => {
    if (!selectedType) return;
    try {
      const next = row.status === 'draft' ? 'live' : 'draft';
      await updateEntity(selectedType.name, row.entityId, {}, undefined, next);
      toast.success(next === 'live' ? t('entryLiveToast') : t('entryDraftToast'));
      await refreshRows(selectedType.name, activeFilters);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [selectedType, refreshRows, activeFilters, t]);

  const onDeleteType = useCallback(async () => {
    if (!selectedType) return;
    const ok = await confirm({ title: t('deleteTypeTitle'), body: t('deleteTypeBody', { name: selectedType.displayName }) });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteEntityType(selectedType.name);
      toast.success(t('typeDeleted'));
      setSelected(null);
      await refreshTypes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selectedType, refreshTypes, t]);

  const openCreateEntity = useCallback(() => {
    setEditingId(null);
    setFormValues({});
    setFormTermIds([]);
    setFormLocalizations({});
    setShowEntityForm(true);
  }, []);

  const openEditEntity = useCallback((row: EntityRow) => {
    setEditingId(row.entityId);
    setFormValues(Object.fromEntries(Object.entries(row.values).map(([k, v]) => [k, String(v)])));
    setFormTermIds(row.termIds ?? []);
    setFormLocalizations(row.localizations ?? {});
    setShowEntityForm(true);
  }, []);

  /** Sparse overlay map: empty inputs and empty locales never persist. */
  const cleanedLocalizations = useCallback((): Record<string, Record<string, string>> => {
    const out: Record<string, Record<string, string>> = {};
    for (const [loc, overlay] of Object.entries(formLocalizations)) {
      const kept = Object.fromEntries(Object.entries(overlay).filter(([, v]) => v.trim().length > 0));
      if (Object.keys(kept).length > 0) out[loc] = kept;
    }
    return out;
  }, [formLocalizations]);

  const onSubmitEntity = useCallback(async () => {
    if (!selectedType) return;
    setBusy(true);
    try {
      const values = coerceValues(selectedType.fields, formValues);
      // ADR 0406 — only send overlays when localization is active (the write
      // gate 400s otherwise); on edit an empty map still replaces (clears).
      const locActive = localeCtx?.enabled === true && (localeCtx.supportedLocales ?? []).length > 0;
      const overlays = locActive ? cleanedLocalizations() : undefined;
      if (editingId) {
        // Clear keys the user emptied (non-required only — the server enforces).
        for (const s of selectedType.fields) {
          if (formValues[s.key] === '' && !s.required) (values as Record<string, unknown>)[s.key] = null;
        }
        await updateEntity(selectedType.name, editingId, values, formTermIds, undefined, overlays);
        toast.success(t('entityUpdated'));
      } else {
        await createEntity(
          selectedType.name,
          values,
          formTermIds.length > 0 ? formTermIds : undefined,
          overlays && Object.keys(overlays).length > 0 ? overlays : undefined,
        );
        toast.success(t('entityCreated'));
      }
      setShowEntityForm(false);
      await refreshRows(selectedType.name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selectedType, formValues, formTermIds, editingId, localeCtx, cleanedLocalizations, refreshRows, t]);

  const onDeleteEntity = useCallback(
    async (row: EntityRow) => {
      if (!selectedType) return;
      const ok = await confirm({ title: t('deleteEntityTitle'), body: t('deleteEntityBody') });
      if (!ok) return;
      try {
        await deleteEntity(selectedType.name, row.entityId);
        toast.success(t('entityDeleted'));
        await refreshRows(selectedType.name);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [selectedType, refreshRows, t],
  );

  const onLoadMore = useCallback(async () => {
    if (!selectedType || !nextCursor) return;
    try {
      // The cursor must go back to the SAME endpoint that minted it — a
      // filtered page's cursor is a query cursor (grade-code #3).
      const page =
        activeFilters.length > 0
          ? await queryEntities(selectedType.name, { filters: activeFilters, limit: 50, cursor: nextCursor })
          : await listEntities(selectedType.name, { limit: 50, cursor: nextCursor });
      setRows((prev) => [...(prev ?? []), ...page.entities]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [selectedType, nextCursor, activeFilters]);

  const columns = useMemo<DataColumn<EntityRow>[]>(() => {
    if (!selectedType) return [];
    const fieldCols: DataColumn<EntityRow>[] = selectedType.fields.slice(0, 5).map((s) => ({
      key: s.key,
      header: s.label,
      render: (row: EntityRow) => {
        const v = row.values[s.key];
        return v === undefined ? <span className="muted">—</span> : String(v);
      },
    }));
    return [
      ...fieldCols,
      {
        // ADR 0407 — entry publish state (absent = live; draft entries never
        // reach the anonymous public read).
        key: 'status',
        header: t('colStatus'),
        render: (row: EntityRow) => (
          row.status === 'draft'
            ? <span className="chip chip--warning">{t('entryDraftChip')}</span>
            : <span className="chip chip--success">{t('entryLiveChip')}</span>
        ),
      },
      {
        key: 'updatedAt',
        header: t('colUpdated'),
        render: (row: EntityRow) => formatRelativeTime(row.updatedAt),
      },
      {
        key: 'actions',
        header: t('colActions'),
        render: (row: EntityRow) => (
          <span className="u-flex u-gap-2">
            <Button variant="quiet" size="sm" onClick={() => void onToggleEntityStatus(row)}>
              {row.status === 'draft' ? t('makeLive') : t('makeDraft')}
            </Button>
            <Button variant="quiet" size="sm" onClick={() => openEditEntity(row)} aria-label={t('editEntity')}>
              <PencilIcon size={14} />
            </Button>
            <Button variant="quiet" size="sm" onClick={() => void onDeleteEntity(row)} aria-label={t('deleteEntity')}>
              <TrashIcon size={14} />
            </Button>
          </span>
        ),
      },
    ];
  }, [selectedType, t, openEditEntity, onDeleteEntity, onToggleEntityStatus]);

  const nameFilter = nameQuery.trim().toLowerCase();
  const visibleRows = useMemo(() => {
    if (rows === null) return null;
    if (!nameFilter) return rows;
    return rows.filter((r) => Object.values(r.values).some((v) => v != null && String(v).toLowerCase().includes(nameFilter)));
  }, [rows, nameFilter]);
  const hasActiveFilters = activeFilters.length > 0 || nameFilter.length > 0;

  if (!access.enabled) {
    return (
      <div data-walkthrough="entities.page" className="u-p-4">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<DatabaseIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </div>
    );
  }

  return (
    <div className="u-p-4">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      <p className="u-fs-13">
        <Link to="/entities/schema">{t('openSchemaGraph')}</Link>
      </p>
      {error ? <Notice variant="error">{error}</Notice> : null}

      <div className="u-flex u-gap-4 u-items-start">
        {/* Types rail */}
        <aside className="surface-card u-p-3 u-minw-220">
          <div className="u-flex u-justify-between u-items-center u-mb-2">
            <h2 className="u-fs-13 u-fw-600">{t('typesHeading')}</h2>
            <Button variant="quiet" size="sm" onClick={() => setShowTypeForm((v) => !v)} aria-label={t('newType')}>
              <PlusIcon size={14} />
            </Button>
          </div>
          {types === null ? (
            <SkeletonRows rows={3} columns={['70%']} />
          ) : types.length === 0 && !showTypeForm ? (
            <p className="u-text-sm muted">{t('noTypesHint')}</p>
          ) : (
            <ul className="u-list-none u-p-0 u-m-0">
              {types.map((x) => (
                <li key={x.typeId}>
                  <Button
                    variant="quiet"
                    size="sm"
                    // Selection was carried by `is-active` ALONE, and no rule a
                    // .btn-ghost can reach matches it — so the chosen type was
                    // invisible to sighted users, and with no aria-* it was
                    // invisible to assistive tech too (grade-ux DS-ENT-1). Same
                    // shape the allowlist rows already use.
                    // `aria-current`, NOT `aria-pressed`: pressed is the toggle
                    // contract (the control flips its own state), but activating
                    // one row here de-selects a DIFFERENT one, and
                    // `aria-pressed={false}` made every unselected row announce
                    // "not pressed" while browsing (grade-ux DS-ENT-5).
                    aria-current={x.name === selected ? 'true' : undefined}
                    className={`u-w-full u-text-left${x.name === selected ? ' is-active' : ''}`}
                    onClick={() => setSelected(x.name)}
                  >
                    {x.displayName}
                    {x.status === 'draft' ? <span className="chip chip--warning u-ml-2">{t('statusDraft')}</span> : null}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {showTypeForm ? (
            <form
              className="u-mt-3 surface-form"
              onSubmit={(e) => {
                e.preventDefault();
                void onCreateType();
              }}
            >
              <label className="u-block u-text-sm" htmlFor="ent-type-name">{t('typeNameLabel')}</label>
              <input id="ent-type-name" className="ui-input u-w-full" value={typeName} onChange={(e) => setTypeName(e.target.value)} required />
              <label className="u-block u-text-sm u-mt-2" htmlFor="ent-type-display">{t('typeDisplayLabel')}</label>
              <input id="ent-type-display" className="ui-input u-w-full" value={typeDisplay} onChange={(e) => setTypeDisplay(e.target.value)} />
              <p className="u-fs-13 u-fw-600 u-mt-2">{t('fieldsHeading')}</p>
              {draftFields.map((f, i) => (
                <div key={i} className="u-flex u-gap-2 u-mb-1 u-items-center">
                  <input
                    className="ui-input"
                    placeholder={t('fieldKeyPh')}
                    aria-label={t('fieldKeyPh')}
                    value={f.key}
                    onChange={(e) => setDraftFields((d) => d.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                  />
                  <select
                    className="ui-input"
                    aria-label={t('fieldTypePh')}
                    value={f.type}
                    onChange={(e) =>
                      setDraftFields((d) => d.map((x, j) => (j === i ? { ...x, type: e.target.value as EntityFieldType } : x)))
                    }
                  >
                    {FIELD_TYPES.map((ft) => (
                      <option key={ft} value={ft}>{t(`fieldType_${ft}`)}</option>
                    ))}
                  </select>
                  <label className="u-text-sm u-flex u-items-center u-gap-1">
                    <input
                      type="checkbox"
                      checked={f.required}
                      onChange={(e) => setDraftFields((d) => d.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))}
                    />
                    {t('fieldRequired')}
                  </label>
                  {f.type === 'string' ? (
                    <label className="u-text-sm u-flex u-items-center u-gap-1">
                      <input
                        type="checkbox"
                        checked={f.localizable}
                        onChange={(e) => setDraftFields((d) => d.map((x, j) => (j === i ? { ...x, localizable: e.target.checked } : x)))}
                      />
                      {t('fieldLocalizable')}
                    </label>
                  ) : null}
                  {f.type === 'enum' ? (
                    <input
                      className="ui-input"
                      placeholder={t('fieldOptionsPh')}
                      aria-label={t('fieldOptionsPh')}
                      value={f.options}
                      onChange={(e) => setDraftFields((d) => d.map((x, j) => (j === i ? { ...x, options: e.target.value } : x)))}
                    />
                  ) : null}
                  {f.type === 'reference' ? (
                    <select
                      className="ui-input"
                      aria-label={t('refTargetPh')}
                      value={f.refEntityType}
                      onChange={(e) => setDraftFields((d) => d.map((x, j) => (j === i ? { ...x, refEntityType: e.target.value } : x)))}
                    >
                      <option value="">{t('refTargetPh')}</option>
                      {(types ?? []).map((x) => (
                        <option key={x.typeId} value={x.name}>{x.displayName}</option>
                      ))}
                      {typeName.trim() ? <option value={typeName.trim().toLowerCase()}>{typeName.trim()}</option> : null}
                    </select>
                  ) : null}
                </div>
              ))}
              <div className="u-flex u-gap-2 u-mt-2">
                <Button variant="quiet" size="sm" onClick={() => setDraftFields((d) => [...d, emptyField()])}>
                  {t('addField')}
                </Button>
                <Button type="submit" variant="primary" size="sm" disabled={busy}>
                  {t('createType')}
                </Button>
              </div>
            </form>
          ) : null}
          <TaxonomyPanel />
        </aside>

        {/* Selected type detail + entities */}
        <section className="u-flex-1">
          {selectedType ? (
            <div className="surface-card u-p-4">
              <div className="u-flex u-justify-between u-items-center u-mb-3">
                <div>
                  <h2 className="u-fs-18 u-fw-600 u-m-0">
                    {selectedType.displayName}{' '}
                    <span className={selectedType.status === 'published' ? 'chip chip--success' : 'chip chip--warning'}>
                      {selectedType.status === 'published' ? t('statusPublished') : t('statusDraft')}
                    </span>
                    {selectedType.publicRead === true ? (
                      <span className="chip chip--accent u-ml-1">{t('publicReadChip')}</span>
                    ) : null}
                    {selectedType.system === true ? (
                      <span className="chip chip--muted u-ml-1">{t('systemChip')}</span>
                    ) : null}
                  </h2>
                  <p className="u-text-sm muted u-m-0">
                    {t('fieldsSummary', { count: selectedType.fields.length })}
                  </p>
                </div>
                <div className="action-bar">
                  {/* ADR 0408 — system types are code-owned: no runtime type
                      mutations, no direct record authoring (the owning
                      feature manages both; the server enforces the same). */}
                  {selectedType.system !== true ? (
                    <>
                      <Button variant="quiet" size="sm" onClick={() => void onTogglePublish()} disabled={busy}>
                        {selectedType.status === 'published' ? t('unpublish') : t('publish')}
                      </Button>
                      {selectedType.status === 'published' ? (
                        <Button variant="quiet" size="sm" onClick={() => void onTogglePublicRead()} disabled={busy}>
                          {selectedType.publicRead === true ? t('makePrivate') : t('makePublic')}
                        </Button>
                      ) : null}
                      <Button variant="quiet" size="sm" onClick={() => void onDeleteType()} disabled={busy}>
                        {t('deleteType')}
                      </Button>
                      <Button variant="primary" size="sm" onClick={openCreateEntity}>
                        {t('newEntity')}
                      </Button>
                    </>
                  ) : (
                    <span className="u-text-sm muted">{t('systemTypeHint')}</span>
                  )}
                </div>
              </div>

              {showEntityForm ? (
                <form
                  className="surface-form u-mb-3 u-p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void onSubmitEntity();
                  }}
                >
                  <p className="u-fs-13 u-fw-600">{editingId ? t('editEntityHeading') : t('newEntityHeading')}</p>
                  {selectedType.fields.map((s) => (
                    <div key={s.key} className="u-mb-2">
                      <label className="u-block u-text-sm" htmlFor={`ent-f-${s.key}`}>
                        {s.label}
                        {s.required ? ' *' : ''}
                      </label>
                      <FieldInput
                        spec={s}
                        value={formValues[s.key] ?? ''}
                        onChange={(v) => setFormValues((fv) => ({ ...fv, [s.key]: v }))}
                        yesLabel={t('boolYes')}
                        noLabel={t('boolNo')}
                        {...(s.type === 'reference' ? { refOptions: refOptions[s.key] ?? [] } : {})}
                      />
                    </div>
                  ))}
                  {taxonomies.length > 0 ? (
                    <fieldset className="u-border-0 u-p-0 u-m-0 u-mb-2">
                      <legend className="u-fs-13 u-fw-600">{t('termsHeading')}</legend>
                      {taxonomies.map((tax) => (
                        <div key={tax.taxonomyId} className="u-mb-1">
                          <span className="u-fs-12 muted">{tax.displayName}</span>
                          <span className="u-flex u-gap-2 u-flex-wrap">
                            {(termsByTax[tax.name] ?? []).map((term) => (
                              <label key={term.termId} className="u-fs-12 u-flex u-items-center u-gap-1">
                                <input
                                  type="checkbox"
                                  checked={formTermIds.includes(term.termId)}
                                  onChange={(e) =>
                                    setFormTermIds((prev) =>
                                      e.target.checked ? [...prev, term.termId] : prev.filter((x) => x !== term.termId),
                                    )
                                  }
                                />
                                {term.label}
                              </label>
                            ))}
                          </span>
                        </div>
                      ))}
                    </fieldset>
                  ) : null}
                  {/* ADR 0406 P5 — per-locale overlays for localizable string
                      fields. Shown only when the localization context resolves
                      (toggle + authored locales) and the type has localizable
                      fields; sparse — empty inputs never persist. */}
                  {localeCtxFailed ? (
                    <Notice variant="warning" announce={t('localeCtxFailed')}>{t('localeCtxFailed')}</Notice>
                  ) : null}
                  {localeCtx?.enabled && (localeCtx.supportedLocales ?? []).length > 0
                    && selectedType.fields.some((s) => s.localizable === true) ? (
                    <fieldset className="u-border-0 u-p-0 u-m-0 u-mb-2">
                      <legend className="u-fs-13 u-fw-600">{t('translationsHeading')}</legend>
                      <p className="u-fs-12 muted u-m-0 u-mb-1">{t('translationsHint', { base: localeCtx.baseLocale ?? '' })}</p>
                      {(localeCtx.supportedLocales ?? []).map((loc) => (
                        <details key={loc} className="u-mb-1" open={Object.keys(formLocalizations[loc] ?? {}).length > 0}>
                          <summary className="u-fs-12 u-fw-600 u-cursor-pointer">
                            {loc}
                            {Object.keys(formLocalizations[loc] ?? {}).length > 0 ? (
                              <span className="chip chip--accent u-ml-1">{t('translationsAuthored')}</span>
                            ) : null}
                          </summary>
                          {selectedType.fields.filter((s) => s.localizable === true).map((s) => (
                            <div key={`${loc}:${s.key}`} className="u-mb-1">
                              <label className="u-fs-12 muted" htmlFor={`loc-${loc}-${s.key}`}>{s.label} ({loc})</label>
                              <input
                                id={`loc-${loc}-${s.key}`}
                                className="ui-input"
                                value={formLocalizations[loc]?.[s.key] ?? ''}
                                placeholder={formValues[s.key] ?? ''}
                                onChange={(e) =>
                                  setFormLocalizations((prev) => ({
                                    ...prev,
                                    [loc]: { ...(prev[loc] ?? {}), [s.key]: e.target.value },
                                  }))
                                }
                              />
                            </div>
                          ))}
                        </details>
                      ))}
                    </fieldset>
                  ) : null}
                  <div className="u-flex u-gap-2">
                    <Button type="submit" variant="primary" size="sm" disabled={busy}>
                      {editingId ? t('saveEntity') : t('createEntity')}
                    </Button>
                    <Button variant="quiet" size="sm" onClick={() => setShowEntityForm(false)}>
                      {t('cancel')}
                    </Button>
                  </div>
                </form>
              ) : null}

              {/* Relationships (Phase 2) — policies FROM this type */}
              <details className="u-mb-3">
                <summary className="u-fs-13 u-fw-600 u-cursor-pointer">{t('relationshipsHeading')}</summary>
                <ul className="u-list-none u-p-0 u-mt-2">
                  {relationships
                    .filter((r) => r.fromTypeId === selectedType.typeId || r.toTypeId === selectedType.typeId)
                    .map((r) => {
                      const fromName = types?.find((x) => x.typeId === r.fromTypeId)?.displayName ?? r.fromTypeId;
                      const toName = types?.find((x) => x.typeId === r.toTypeId)?.displayName ?? r.toTypeId;
                      return (
                        <li key={r.relId} className="u-flex u-items-center u-gap-2 u-mb-1 u-fs-12">
                          <span>
                            {fromName} → {toName}
                          </span>
                          <span className="chip chip--muted">{t(`cardinality_${r.cardinality.replace('-', '_')}`)}</span>
                          <span className="chip chip--muted">{t(`onDeleteChip_${r.onDelete.replace('-', '')}`)}</span>
                          <Button
                            variant="quiet" size="sm"
                            aria-label={t('deleteRelationship')}
                            onClick={() => {
                              const from = types?.find((x) => x.typeId === r.fromTypeId)?.name;
                              const to = types?.find((x) => x.typeId === r.toTypeId)?.name;
                              if (from && to) {
                                void confirm({ title: t('deleteRelationshipTitle'), body: t('deleteRelationshipBody') }).then((ok) => {
                                  if (!ok) return;
                                  void deleteRelationship(from, to)
                                    .then(() => {
                                      toast.success(t('relationshipDeleted'));
                                      return refreshRelationships();
                                    })
                                    .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
                                });
                              }
                            }}
                          >
                            <TrashIcon size={12} />
                          </Button>
                        </li>
                      );
                    })}
                </ul>
                <div className="u-flex u-gap-2 u-items-center">
                  <select className="ui-input" aria-label={t('relTargetPh')} value={relTo} onChange={(e) => setRelTo(e.target.value)}>
                    <option value="">{t('relTargetPh')}</option>
                    {(types ?? []).map((x) => (
                      <option key={x.typeId} value={x.name}>{x.displayName}</option>
                    ))}
                  </select>
                  <select
                    className="ui-input"
                    aria-label={t('relOnDeletePh')}
                    value={relOnDelete}
                    onChange={(e) => setRelOnDelete(e.target.value as Relationship['onDelete'])}
                  >
                    <option value="restrict">{t('onDelete_restrict')}</option>
                    <option value="cascade">{t('onDelete_cascade')}</option>
                    <option value="set-null">{t('onDelete_setNull')}</option>
                  </select>
                  <Button
                    variant="quiet" size="sm"
                    disabled={!relTo || busy}
                    onClick={() => {
                      void createRelationship({ fromTypeName: selectedType.name, toTypeName: relTo, onDelete: relOnDelete })
                        .then(() => {
                          setRelTo('');
                          return refreshRelationships();
                        })
                        .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
                    }}
                  >
                    {t('addRelationship')}
                  </Button>
                </div>
              </details>

              {/* Filter bar + export/import (Phase 3) */}
              <div className="u-flex u-gap-2 u-items-center u-mb-2 u-flex-wrap">
                <select className="ui-input" aria-label={t('filterFieldPh')} value={filterKey} onChange={(e) => setFilterKey(e.target.value)}>
                  <option value="">{t('filterFieldPh')}</option>
                  {selectedType.fields.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
                <select className="ui-input" aria-label={t('filterOpPh')} value={filterOp} onChange={(e) => setFilterOp(e.target.value as QueryOp)}>
                  {(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte'] as QueryOp[]).map((op) => (
                    <option key={op} value={op}>{t(`op_${op}`)}</option>
                  ))}
                </select>
                <input
                  className="ui-input"
                  placeholder={t('filterValuePh')}
                  aria-label={t('filterValuePh')}
                  value={filterValue}
                  onChange={(e) => setFilterValue(e.target.value)}
                />
                <Button
                  variant="quiet" size="sm"
                  disabled={!filterKey}
                  onClick={() => {
                    const spec = selectedType.fields.find((s) => s.key === filterKey);
                    const value =
                      spec?.type === 'number' ? Number(filterValue) : spec?.type === 'boolean' ? filterValue === 'true' : filterValue;
                    const next = [{ key: filterKey, op: filterOp, value }];
                    setActiveFilters(next);
                    void refreshRows(selectedType.name, next);
                  }}
                >
                  {t('applyFilter')}
                </Button>
                {activeFilters.length > 0 ? (
                  <Button
                    variant="quiet" size="sm"
                    onClick={() => {
                      setActiveFilters([]);
                      void refreshRows(selectedType.name, []);
                    }}
                  >
                    {t('clearFilter')}
                  </Button>
                ) : null}
                <span className="u-ml-auto u-flex u-gap-2">
                  <a className="btn-ghost btn-sm" href={exportUrl(selectedType.name)} download>
                    {t('exportBtn')}
                  </a>
                  <label className="btn-ghost btn-sm">
                    {t('importBtn')}
                    <input
                      type="file"
                      accept=".ndjson,.jsonl,.txt,application/x-ndjson"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file || !selectedType) return;
                        void file.text().then(async (text) => {
                          try {
                            const r = await importEntities(selectedType.name, text);
                            toast.success(t('importDone', { created: r.created, existing: r.existing, errors: r.errors.length }));
                            await refreshRows(selectedType.name);
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : String(err));
                          }
                        });
                      }}
                    />
                  </label>
                </span>
              </div>

              {rows && rows.length > 3 ? (
                <div className="filterbar">
                  <input
                    type="search"
                    className="ui-input filterbar-search"
                    placeholder={t('searchRecordsPlaceholder')}
                    aria-label={t('searchRecordsAria')}
                    value={nameQuery}
                    onChange={(e) => setNameQuery(e.target.value)}
                  />
                </div>
              ) : null}

              {rows === null ? (
                <SkeletonRows rows={4} columns={['40%', '30%', '20%']} />
              ) : visibleRows && visibleRows.length === 0 ? (
                hasActiveFilters ? (
                  <StateCard
                    icon={<DatabaseIcon />}
                    title={t('noRecordsMatchTitle')}
                    body={t('noRecordsMatchBody')}
                    action={
                      <Button
                        variant="quiet" size="sm"
                        onClick={() => {
                          setNameQuery('');
                          setActiveFilters([]);
                          setFilterKey('');
                          setFilterValue('');
                          void refreshRows(selectedType.name, []);
                        }}
                      >
                        {t('clearFilters')}
                      </Button>
                    }
                  />
                ) : (
                  <StateCard icon={<DatabaseIcon />} title={t('noEntitiesTitle')} body={t('noEntitiesBody')} />
                )
              ) : (
                <>
                  <DataTable caption={t('entitiesCaption', { name: selectedType.displayName })} columns={columns} rows={visibleRows ?? []} rowKey={(r) => r.entityId} />
                  {nextCursor ? (
                    <Button variant="quiet" size="sm" className="u-mt-2" onClick={() => void onLoadMore()}>
                      {t('loadMore')}
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          ) : types !== null && types.length === 0 && !error ? (
            <StateCard icon={<DatabaseIcon />} title={t('emptyTitle')} body={t('emptyBody')} />
          ) : null}
        </section>
      </div>
    </div>
  );
}
