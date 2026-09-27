/**
 * Sales Territory Management — admin surface (ADR 0272 P6). One cohesive page:
 * pick an org, manage territory models + their Planning→Active→Archived
 * lifecycle, edit the territory hierarchy, dry-run assignment coverage, and read
 * per-territory attainment (weighted pipeline + won vs quota, rolled up) with
 * inline quota editing. Built entirely from the shared ui/ design system.
 * Localized 2026-07-10 (the last zero-i18n feature page — `territories` ns).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Panel, Toolbar } from '../../ui/layout.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { DeepLinkMissNotice, isDeepLinkMiss } from '../../ui/DeepLinkMissNotice.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { toast } from '../../ui/toast.js';
import { useLiveRegion } from '../../ui/announce.js';
import { GlobeIcon } from '../../ui/icons/index.js';
import { formatNumber } from '../../i18n/format.js';
import {
  listOrgs, type Org,
  listModels, createModel, activateModel, archiveModel, deleteModel, type TerritoryModel,
  listTerritories, createTerritory, updateTerritory, type Territory,
  listRules, createRule, type AssignmentRule,
  previewModel, type PreviewSummary,
  getAttainment, setQuota, type TerritoryAttainment,
} from './territoriesClient.js';
// The picker-sized region catalog (id + name; NO geometry) — deliberately not
// worldBoundaries.ts, which would drag ~155 kB into this chunk (ADR 0282 §8).
import { REGION_CATALOG } from '../sales-maps/regionCatalog.js';

const DEAL_FIELDS = ['amount', 'title', 'currency', 'stageId', 'pipelineId', 'companyId', 'contactId', 'owner', 'status', 'closeDate'];
const COMPANY_FIELDS = ['name', 'domain', 'industry', 'tags'];
const OPS = ['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte', 'in', 'exists'] as const;
const fieldLabel = (f: string, t: TFunction): string => t(`field_${f}`, { defaultValue: f });
const opLabel = (op: string, t: TFunction): string => t(`op_${op}`, { defaultValue: op });
const NUMERIC_FIELDS = new Set(['amount']);
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL'];

interface Cond { id: string; field: string; op: (typeof OPS)[number]; value: string }
let condSeq = 0;
const newCond = (field: string): Cond => ({ id: `c${(condSeq += 1)}`, field, op: 'gte', value: '' });
const condNumInvalid = (c: Cond): boolean => c.op !== 'exists' && c.op !== 'in' && NUMERIC_FIELDS.has(c.field) && c.value !== '' && !Number.isFinite(Number(c.value));
const condIncomplete = (c: Cond): boolean => c.op !== 'exists' && c.value.trim() === '';
function condToExpr(c: Cond): Record<string, unknown> {
  const e: Record<string, unknown> = { field: c.field, op: c.op };
  if (c.op === 'in') e.value = c.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => (NUMERIC_FIELDS.has(c.field) ? Number(s) : s));
  else if (c.op !== 'exists') e.value = NUMERIC_FIELDS.has(c.field) ? Number(c.value) : c.value;
  return e;
}

const money = (n: number, currency?: string): string =>
  currency ? formatNumber(n, { style: 'currency', currency, maximumFractionDigits: 0 }) : formatNumber(n, { maximumFractionDigits: 0 });
const pct = (n: number | null): string => (n === null ? '—' : `${Math.round(n * 100)}%`);
const PERIOD_RE = /^\d{4}-(Q[1-4]|(0[1-9]|1[0-2]))$/;

/** Map a model's effective state to a distinctly-toned StatusBadge (M1): active
 *  reads green, planning amber (editable draft), archived neutral-cancel. */
function stateBadge(state: string, active: boolean, t: TFunction): { status: string; label: string } {
  if (active) return { status: 'active', label: t('badgeActive') };
  if (state === 'planning') return { status: 'waiting', label: t('badgePlanning') };
  if (state === 'archived') return { status: 'cancelled', label: t('badgeArchived') };
  return { status: state, label: state };
}

export function TerritoriesPage(): JSX.Element {
  const { t } = useTranslation('territories');
  const [searchParams, setSearchParams] = useSearchParams();
  // Deep-link spine (Phase 3): the store rides `?org=` (one-shot initial read;
  // validated against the accessible list, else first org) — the hook's third
  // argument, so a shared link still lands where it says. Switching org clears
  // the stale `?model=` selection.
  //
  // `.catch(() => setOrgs([]))` rendered the "No organizations — create one
  // first" instruction over a failed read, and left `orgId` '' so nothing below
  // ever loaded. Both facts, one value.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, true, searchParams.get('org') ?? '');
  const selectOrg = useCallback((id: string) => {
    setOrgId(id);
    setSearchParams((p) => { const n = new URLSearchParams(p); n.set('org', id); n.delete('model'); return n; }, { replace: true });
  }, [setSearchParams, setOrgId]);


  return (
    <div className="u-flex-col u-gap-4" data-walkthrough="territories.page">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
        actions={
          orgs && orgs.length > 1 ? (
            <SelectField label={t('orgPickerLabel')} value={orgId} onChange={(e) => selectOrg(e.target.value)}>
              {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
            </SelectField>
          ) : undefined
        }
      />
      {/* HG-4 — the noun and the branch ORDER (failed → zero-orgs → children) are
          `OrgSelectionState`'s now. This page had it inverted (the skeleton was
          checked ABOVE the zero-org branch); the workspace is the CHILD, which
          makes the right order unskippable.
          `OrgSelectionState` renders children while the org read is still in
          flight, and `TerritoriesWorkspace` fetches on mount with no `orgId`
          guard of its own — mounting it with `orgId` '' would list the territory
          models of no organization. The gate is the SELECTION, not `orgs`: the
          zero-org branch above already owns the "there is none to select" case,
          so inside here an empty `orgId` can only mean the read has not answered
          yet, which is exactly what the skeleton says. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<GlobeIcon />}>
        {orgId ? <TerritoriesWorkspace orgId={orgId} /> : <Skeleton />}
      </OrgSelectionState>
    </div>
  );
}

function TerritoriesWorkspace({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('territories');
  const [models, setModels] = useState<TerritoryModel[] | null>(null);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  // Deep-link spine (Phase 3): the URL owns the selected model (?model=), so a
  // link/reload restores it. `selected` derives from the param; an auto-default
  // effect fills in the active/first model when the URL names none valid.
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('model') ?? '';
  const setSelectedId = useCallback((id: string) => {
    setSearchParams((prev) => { const n = new URLSearchParams(prev); if (id) n.set('model', id); else n.delete('model'); return n; }, { replace: true });
  }, [setSearchParams]);
  const [err, setErr] = useState('');
  const [newModel, setNewModel] = useState('');
  const [busy, setBusy] = useState(false);

  const loadModels = useCallback(() => {
    setModels(null);
    void listModels(orgId)
      .then((r) => { setErr(''); setModels(r.models); setActiveModelId(r.activeModelId); })
      .catch((e) => { setModels([]); setErr(e instanceof Error ? e.message : t('loadModelsFailed')); });
  }, [orgId, t]);
  useEffect(() => { loadModels(); }, [loadModels]);
  useEffect(() => {
    if (!models) return;
    if (selectedId && models.some((m) => m.modelId === selectedId)) return;
    const def = (activeModelId && models.some((m) => m.modelId === activeModelId)) ? activeModelId : (models[0]?.modelId ?? '');
    if (def && def !== selectedId) setSelectedId(def);
  }, [models, activeModelId, selectedId, setSelectedId]);

  const addModel = async (): Promise<void> => {
    if (!newModel.trim()) return;
    setBusy(true);
    try { const m = await createModel(orgId, newModel.trim()); setNewModel(''); toast.success(t('modelCreated')); loadModels(); setSelectedId(m.modelId); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('createFailed')); } finally { setBusy(false); }
  };
  const activate = async (id: string): Promise<void> => {
    setBusy(true);
    try { await activateModel(orgId, id); toast.success(t('transitionSubmittedForReview')); loadModels(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('activateFailed')); } finally { setBusy(false); }
  };
  const archive = async (id: string): Promise<void> => {
    setBusy(true);
    try { await archiveModel(orgId, id); toast.success(t('transitionSubmittedForReview')); loadModels(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('archiveFailed')); } finally { setBusy(false); }
  };
  const del = async (id: string): Promise<void> => {
    setBusy(true);
    try { const { removed } = await deleteModel(orgId, id); toast.success(t('modelDeleted', { count: removed })); setSelectedId(''); loadModels(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); } finally { setBusy(false); }
  };

  const selected = useMemo(() => models?.find((m) => m.modelId === selectedId), [models, selectedId]);

  return (
    <div className="u-grid u-grid-3 u-gap-4 u-items-start">
      {/* Models column */}
      <Panel className="surface-card u-flex-col u-gap-3">
        <h2 className="u-mb-0">{t('modelsHeading')}</h2>
        <p className="u-text-muted u-mt-0">{t('modelsIntro')}</p>
        {err ? <Notice variant="error">{err}</Notice> : null}
        <DeepLinkMissNotice show={isDeepLinkMiss(selectedId, models !== null, selected)} onClear={() => setSelectedId('')} />
        {models === null ? <Skeleton /> : models.length === 0 ? (
          <p className="u-text-muted">{t('noModelsYet')}</p>
        ) : (
          <ul className="u-flex-col u-gap-1 u-list-none">
            {models.map((m) => (
              <li key={m.modelId}>
                <button
                  type="button"
                  className={`chip u-justify-between u-w-full${m.modelId === selectedId ? ' is-selected' : ''}`}
                  aria-pressed={m.modelId === selectedId}
                  onClick={() => setSelectedId(m.modelId)}
                >
                  <span>{m.name}</span>
                  {(() => { const b = stateBadge(m.state, m.modelId === activeModelId, t); return <StatusBadge status={b.status} label={b.label} />; })()}
                </button>
              </li>
            ))}
          </ul>
        )}
        <Toolbar className="u-gap-1">
          <TextField label={t('newModelLabel')} value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder={t('newModelPlaceholder')} />
        </Toolbar>
        <div className="action-bar">
          <Button variant="primary" disabled={busy || !newModel.trim()} onClick={() => void addModel()}>{t('createModel')}</Button>
        </div>
      </Panel>

      {/* Detail: territories + preview + attainment */}
      <div className="u-flex-col u-gap-4 u-col-span-2">
        {!selected ? (
          <StateCard icon={<GlobeIcon />} title={t('selectModelTitle')} body={t('selectModelBody')} />
        ) : (
          <ModelDetail
            orgId={orgId}
            model={selected}
            isActive={selected.modelId === activeModelId}
            busy={busy}
            onActivate={() => void activate(selected.modelId)}
            onArchive={() => void archive(selected.modelId)}
            onDelete={() => void del(selected.modelId)}
          />
        )}
      </div>
    </div>
  );
}

type Load<T> = { status: 'loading' } | { status: 'error' } | { status: 'ok'; data: T };
const LOADING = { status: 'loading' } as const;

function ModelDetail({ orgId, model, isActive, busy, onActivate, onArchive, onDelete }: {
  orgId: string; model: TerritoryModel; isActive: boolean; busy: boolean; onActivate: () => void; onArchive: () => void; onDelete: () => void;
}): JSX.Element {
  const { t } = useTranslation('territories');
  const [territories, setTerritories] = useState<Load<Territory[]>>(LOADING);
  const [preview, setPreview] = useState<Load<PreviewSummary>>(LOADING);
  const [attainment, setAttainment] = useState<Load<TerritoryAttainment[]>>(LOADING);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [regionId, setRegionId] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<null | 'activate' | 'archive' | 'delete'>(null);
  const editable = model.state === 'planning' && !isActive;

  const load = useCallback(() => {
    setTerritories(LOADING); setPreview(LOADING); setAttainment(LOADING);
    void listTerritories(orgId, model.modelId).then((d) => setTerritories({ status: 'ok', data: d })).catch(() => setTerritories({ status: 'error' }));
    void previewModel(orgId, model.modelId).then((d) => setPreview({ status: 'ok', data: d })).catch(() => setPreview({ status: 'error' }));
    void getAttainment(orgId, model.modelId).then((r) => setAttainment({ status: 'ok', data: r.territories })).catch(() => setAttainment({ status: 'error' }));
  }, [orgId, model.modelId]);
  useEffect(() => { setName(''); setParentId(''); setRegionId(''); load(); }, [load]);

  const addTerritory = async (): Promise<void> => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await createTerritory(orgId, model.modelId, { name: name.trim(), ...(parentId ? { parentTerritoryId: parentId } : {}), ...(regionId ? { regionId } : {}) });
      setName(''); setParentId(''); setRegionId(''); toast.success(t('territoryAdded')); load();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('addFailed')); } finally { setSaving(false); }
  };
  // Sales-map region mapping (ADR 0282 §8) — PATCHable while the model is in
  // planning (the backend guard); '' clears the mapping.
  const setRegion = async (territoryId: string, region: string): Promise<void> => {
    try {
      await updateTerritory(orgId, model.modelId, territoryId, { regionId: region });
      toast.success(t('regionSaved')); load();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('regionSaveFailed')); }
  };
  // REVIEW I8 — `setQuota` REBUILDS `repSplits` from its input, and this call never sent
  // them, so every quota edit from the console silently deleted every per-rep split on
  // that territory — including the `user:[erased]` sentinel the new eraser writes, which
  // would quietly undo an erasure's accounting. The row already carries the splits, so
  // they ride back unchanged unless the author is editing them (which no UI does yet).
  const saveQuota = async (territoryId: string, period: string, amount: number, currency: string | undefined, repSplits: Array<{ subjectId: string; amount: number }>): Promise<void> => {
    await setQuota(orgId, model.modelId, territoryId, { period, amount, ...(currency ? { currency } : {}), repSplits }); toast.success(t('quotaSaved')); load();
  };

  // depth for hierarchy indentation (cycle-safe)
  const depthOf = (terr: Territory, all: Territory[]): number => {
    let d = 0; let cur: Territory | undefined = terr; const seen = new Set<string>();
    while (cur?.parentTerritoryId && !seen.has(cur.territoryId)) { seen.add(cur.territoryId); cur = all.find((x) => x.territoryId === cur!.parentTerritoryId); d += 1; }
    return d;
  };
  const badge = stateBadge(model.state, isActive, t);
  const terrList = territories.status === 'ok' ? territories.data : [];

  return (
    <>
      <Panel className="surface-card u-flex-col u-gap-2">
        <Toolbar className="u-justify-between u-items-center">
          <div className="u-flex u-gap-2 u-items-center">
            <h2 className="u-mb-0">{model.name}</h2>
            <StatusBadge status={badge.status} label={badge.label} />
          </div>
          <div className="action-bar">
            {!isActive && model.state !== 'archived' ? <Button variant="primary" disabled={busy} onClick={() => setConfirm('activate')}>{t('submitActivate')}</Button> : null}
            {model.state !== 'archived' ? <Button variant="primary" disabled={busy} onClick={() => setConfirm('archive')}>{t('submitArchive')}</Button> : null}
            {model.state === 'archived' ? <Button variant="primary" className="u-text-danger" disabled={busy} onClick={() => setConfirm('delete')}>{t('common:delete')}</Button> : null}
          </div>
        </Toolbar>
        {isActive ? <Notice variant="info">{t('liveNotice')}</Notice> : null}
      </Panel>

      {confirm === 'activate' ? (
        <ConfirmDialog
          title={t('confirmActivateTitle')}
          body={t('submitActivateBody')}
          confirmLabel={t('submitActivate')}
          busy={busy}
          onConfirm={() => { setConfirm(null); onActivate(); }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {confirm === 'archive' ? (
        <ConfirmDialog
          title={t('confirmArchiveTitle')}
          body={t('submitArchiveBody')}
          confirmLabel={t('submitArchive')}
          danger
          busy={busy}
          onConfirm={() => { setConfirm(null); onArchive(); }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {confirm === 'delete' ? (
        <ConfirmDialog
          title={t('confirmDeleteTitle')}
          body={t('confirmDeleteBody')}
          confirmLabel={t('common:delete')}
          danger
          busy={busy}
          onConfirm={() => { setConfirm(null); onDelete(); }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}

      {/* Hierarchy */}
      <Panel className="surface-card u-flex-col u-gap-3">
        <h3 className="u-mb-0">{t('hierarchyHeading')}</h3>
        {territories.status === 'loading' ? <Skeleton /> : territories.status === 'error' ? (
          <Notice variant="error">{t('loadTerritoriesFailed')} <Button variant="link" onClick={load}>{t('retry')}</Button></Notice>
        ) : terrList.length === 0 ? (
          <p className="u-text-muted">{t('noTerritoriesYet')}</p>
        ) : (
          <ul className="u-flex-col u-gap-1 u-list-none">
            {terrList.map((terr) => (
              <li key={terr.territoryId} className="u-flex u-gap-2 u-items-center" style={{ paddingLeft: `${depthOf(terr, terrList) * 1.25}rem` }}>
                <span className="chip">{terr.name}</span>
                {terr.memberSubjectIds.length > 0 ? <span className="u-text-muted">{t('repsCount', { count: terr.memberSubjectIds.length })}</span> : null}
                {editable ? (
                  <select
                    className="u-w-auto u-text-sm"
                    aria-label={t('regionSelectAria', { name: terr.name })}
                    value={terr.regionId ?? ''}
                    onChange={(e) => void setRegion(terr.territoryId, e.target.value)}
                  >
                    <option value="">{t('regionNoneOption')}</option>
                    {REGION_CATALOG.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                ) : terr.regionId ? (
                  <span className="chip chip--muted">{REGION_CATALOG.find((r) => r.id === terr.regionId)?.name ?? terr.regionId}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {editable ? (
          <form className="u-flex u-gap-2 u-items-end u-flex-wrap" onSubmit={(e) => { e.preventDefault(); void addTerritory(); }}>
            <TextField label={t('territoryNameLabel')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('territoryNamePlaceholder')} />
            <SelectField label={t('parentLabel')} value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">{t('topLevelOption')}</option>
              {terrList.map((terr) => <option key={terr.territoryId} value={terr.territoryId}>{terr.name}</option>)}
            </SelectField>
            <SelectField label={t('regionLabel')} value={regionId} onChange={(e) => setRegionId(e.target.value)}>
              <option value="">{t('regionNoneOption')}</option>
              {REGION_CATALOG.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </SelectField>
            <Button type="submit" variant="primary" disabled={!name.trim() || saving}>{t('addTerritory')}</Button>
          </form>
        ) : <p className="u-text-muted">{t('planningOnly')}</p>}
      </Panel>

      {/* Assignment rules */}
      <RulesPanel orgId={orgId} modelId={model.modelId} editable={editable} territories={terrList} onChanged={load} />

      {/* Coverage preview */}
      <Panel className="surface-card u-flex-col u-gap-2">
        <h3 className="u-mb-0">{t('coverageHeading')} <span className="u-text-muted">{t('coverageDryRun')}</span></h3>
        {preview.status === 'loading' ? <Skeleton /> : preview.status === 'error' ? (
          <Notice variant="error">{t('coverageFailed')} <Button variant="link" onClick={load}>{t('retry')}</Button></Notice>
        ) : (
          <>
            <p className="u-text-muted u-mt-0">{t('coverageSummary', {
              deals: formatNumber(preview.data.totals.deals),
              companies: formatNumber(preview.data.totals.companies),
              unassigned: formatNumber(preview.data.unassigned.deals + preview.data.unassigned.companies),
            })}</p>
            {preview.data.perTerritory.length === 0 ? <p className="u-text-muted">{t('noRulesCoverage')}</p> : (
              <ul className="u-flex-col u-gap-1 u-list-none">
                {preview.data.perTerritory.map((p) => (
                  <li key={p.territoryId} className="u-flex u-gap-2 u-justify-between">
                    <span>{p.name}</span>
                    <span className="u-text-muted tabular-nums">{t('coveragePerTerritory', { deals: formatNumber(p.deals), companies: formatNumber(p.companies) })}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Panel>

      {/* Attainment */}
      <Panel className="surface-card u-flex-col u-gap-2">
        <h3 className="u-mb-0">{t('attainmentHeading')}</h3>
        {attainment.status === 'loading' ? <Skeleton /> : attainment.status === 'error' ? (
          <Notice variant="error">{t('attainmentFailed')} <Button variant="link" onClick={load}>{t('retry')}</Button></Notice>
        ) : attainment.data.length === 0 ? (
          <p className="u-text-muted">{t('noAttainment')}</p>
        ) : (
          <div className="u-overflow-x-auto">
            <table className="data-table">
              <caption className="sr-only">{t('tableCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('colTerritory')}</th>
                  <th scope="col" className="u-text-right">{t('colQuota')}</th>
                  <th scope="col" className="u-text-right">{t('colPipeline')}</th>
                  <th scope="col" className="u-text-right">{t('colWon')}</th>
                  <th scope="col" className="u-text-right">{t('colAttainment')}</th>
                  <th scope="col" className="u-text-right">{t('colCoverage')}</th>
                  <th scope="col"><span className="sr-only">{t('setQuotaSr')}</span></th>
                </tr>
              </thead>
              <tbody>
                {attainment.data.map((a) => <AttainmentRow key={a.territoryId} row={a} editable={editable} onSaveQuota={saveQuota} />)}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

type FilterNode = { field?: string; op?: string; value?: unknown; all?: FilterNode[]; any?: FilterNode[] };
function clauseText(f: FilterNode, t: TFunction): string {
  if (Array.isArray(f.all)) return f.all.map((n) => clauseText(n, t)).join(t('clauseAnd'));
  if (Array.isArray(f.any)) return `(${f.any.map((n) => clauseText(n, t)).join(t('clauseOr'))})`;
  if (!f.field) return '…';
  const op = opLabel(f.op ?? '', t);
  return `${fieldLabel(f.field, t)} ${op}${f.op === 'exists' ? '' : ` ${String(f.value)}`}`;
}
function ruleSummary(r: AssignmentRule, territories: Territory[], t: TFunction): string {
  const terr = territories.find((x) => x.territoryId === r.territoryId)?.name ?? r.territoryId;
  return t('ruleSummary', {
    target: t(`ruleTarget_${r.target}`, { defaultValue: r.target }),
    clause: clauseText(r.filter as FilterNode, t),
    territory: terr,
  });
}

function RulesPanel({ orgId, modelId, editable, territories, onChanged }: {
  orgId: string; modelId: string; editable: boolean; territories: Territory[]; onChanged: () => void;
}): JSX.Element {
  const { t } = useTranslation('territories');
  const [rules, setRules] = useState<Load<AssignmentRule[]>>(LOADING);
  const [target, setTarget] = useState<'deal' | 'company'>('deal');
  const [territoryId, setTerritoryId] = useState('');
  const [combinator, setCombinator] = useState<'all' | 'any'>('all');
  const [conds, setConds] = useState<Cond[]>(() => [newCond('amount')]);
  const [priority, setPriority] = useState('0');
  const [saving, setSaving] = useState(false);
  // ANN-UX-2 — a polite region only speaks when its text MUTATES, so a plain
  // `useState` announcer is silent when the same message is set twice (React
  // bails on `Object.is`-equal state). Both messages here are user verbs.
  const [liveMsg, setLiveMsg] = useLiveRegion();
  const addCondRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => {
    setRules(LOADING);
    void listRules(orgId, modelId).then((d) => setRules({ status: 'ok', data: d })).catch(() => setRules({ status: 'error' }));
  }, [orgId, modelId]);
  useEffect(() => { load(); }, [load]);

  const fields = target === 'deal' ? DEAL_FIELDS : COMPANY_FIELDS;
  useEffect(() => { setConds([newCond(fields[0] ?? 'amount')]); }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const setCond = (id: string, patch: Partial<Cond>): void => setConds((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  // The announce call USED to sit inside the `setConds` updater. That is a
  // side-effect in a function React may invoke more than once for one update
  // (StrictMode double-invokes updaters), and with `useLiveRegion` a doubled call
  // is not merely wasteful — it toggles the repeat marker ON then OFF, landing on
  // the identical string and announcing NOTHING. Both handlers now derive the next
  // list from `conds` directly and announce once, outside the updater.
  const addCond = (): void => {
    if (conds.length >= 8) return;
    const next = [...conds, newCond(fields[0] ?? 'amount')];
    setConds(next);
    setLiveMsg(t('conditionAdded', { n: next.length }));
  };
  const removeCond = (id: string): void => {
    if (conds.length > 1) {
      const next = conds.filter((c) => c.id !== id);
      setConds(next);
      setLiveMsg(t('conditionRemoved', { n: next.length }));
    }
    // I1 — keep focus in the form after the row unmounts (don't drop to <body>)
    requestAnimationFrame(() => addCondRef.current?.focus());
  };
  const anyInvalid = conds.some((c) => condNumInvalid(c) || condIncomplete(c));
  const disabledReason = !territoryId ? t('pickTerritoryReason') : anyInvalid ? t('incompleteReason') : '';
  const fieldLabelFor = (i: number): string => (i === 0 ? t('fieldFirst') : combinator === 'any' ? t('fieldOr') : t('fieldAnd'));

  const add = async (): Promise<void> => {
    if (!territoryId || saving || anyInvalid) return;
    setSaving(true);
    try {
      const filter = conds.length === 1 ? condToExpr(conds[0]!) : { [combinator]: conds.map(condToExpr) };
      await createRule(orgId, modelId, { territoryId, target, priority: Number(priority) || 0, filter });
      setConds([newCond(fields[0] ?? 'amount')]); toast.success(t('ruleAdded')); load(); onChanged();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('ruleFailed')); } finally { setSaving(false); }
  };

  return (
    <Panel className="surface-card u-flex-col u-gap-3">
      <h3 className="u-mb-0">{t('rulesHeading')}</h3>
      {rules.status === 'loading' ? <Skeleton /> : rules.status === 'error' ? (
        <Notice variant="error">{t('loadRulesFailed')} <Button variant="link" onClick={load}>{t('retry')}</Button></Notice>
      ) : rules.data.length === 0 ? (
        <p className="u-text-muted">{t('noRulesYet')}</p>
      ) : (
        <ul className="u-flex-col u-gap-1 u-list-none">
          {rules.data.map((r) => (
            <li key={r.ruleId} className="u-flex u-gap-2 u-items-center">
              <span className="chip">P{r.priority}</span>
              <span>{ruleSummary(r, territories, t)}</span>
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        <form className="u-flex-col u-gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <div className="u-flex u-gap-1 u-items-end u-flex-wrap">
            <SelectField label={t('appliesTo')} value={target} onChange={(e) => setTarget(e.target.value as 'deal' | 'company')}>
              <option value="deal">{t('targetDeals')}</option>
              <option value="company">{t('targetCompanies')}</option>
            </SelectField>
            <SelectField label={t('assignTo')} value={territoryId} onChange={(e) => setTerritoryId(e.target.value)}>
              <option value="">{t('pickTerritory')}</option>
              {territories.map((terr) => <option key={terr.territoryId} value={terr.territoryId}>{terr.name}</option>)}
            </SelectField>
            <TextField label={t('priorityLabel')} inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} className="field-compact" />
          </div>
          {/* Conditions group — grouping semantics (WCAG 1.3.1) tie the combinator to its rows */}
          <div role="group" aria-label={t('conditionsGroupLabel')} className="u-flex-col u-gap-2">
            {conds.length > 1 ? (
              <SelectField label={t('matchLabel')} value={combinator} onChange={(e) => setCombinator(e.target.value as 'all' | 'any')}>
                <option value="all">{t('matchAll')}</option>
                <option value="any">{t('matchAny')}</option>
              </SelectField>
            ) : null}
            {conds.map((c, i) => (
              <div key={c.id} className="u-flex u-gap-1 u-items-end u-flex-wrap">
                <SelectField label={fieldLabelFor(i)} value={c.field} onChange={(e) => setCond(c.id, { field: e.target.value })}>
                  {fields.map((f) => <option key={f} value={f}>{fieldLabel(f, t)}</option>)}
                </SelectField>
                <SelectField label={t('conditionLabel')} value={c.op} onChange={(e) => setCond(c.id, { op: e.target.value as (typeof OPS)[number] })}>
                  {OPS.map((o) => <option key={o} value={o}>{opLabel(o, t)}</option>)}
                </SelectField>
                {c.op !== 'exists' ? <TextField label={t('valueLabel')} value={c.value} onChange={(e) => setCond(c.id, { value: e.target.value })} error={condNumInvalid(c) ? t('valueNumberError') : undefined} placeholder={c.op === 'in' ? t('valuePlaceholderList') : NUMERIC_FIELDS.has(c.field) ? t('valuePlaceholderNumber') : t('valuePlaceholderText')} /> : null}
                {conds.length > 1 ? <Button variant="primary" onClick={() => removeCond(c.id)} aria-label={t('removeConditionAria', { n: i + 1 })}>{t('removeCondition')}</Button> : null}
              </div>
            ))}
          </div>
          <div className="action-bar u-items-center">
            <Button ref={addCondRef} variant="primary" onClick={addCond} disabled={conds.length >= 8}>{t('addCondition')}</Button>
            <Button type="submit" variant="primary" disabled={!territoryId || saving || anyInvalid}>{t('addRule')}</Button>
            {disabledReason ? <span className="u-text-muted">{disabledReason}</span> : conds.length >= 8 ? <span className="u-text-muted">{t('maxConditions')}</span> : null}
          </div>
          {/* `aria-atomic` is load-bearing with `useLiveRegion`: its repeat
              mechanism is an invisible TRAILING marker, and without atomic some
              assistive tech reads only the changed portion. */}
          <div className="sr-only" aria-live="polite" aria-atomic="true">{liveMsg}</div>
        </form>
      ) : <p className="u-text-muted">{t('planningOnly')}</p>}
    </Panel>
  );
}

/** Exported for test: the money/currency rendering is the load-bearing part. */
export function AttainmentRow({ row, editable, onSaveQuota }: { row: TerritoryAttainment; editable: boolean; onSaveQuota: (territoryId: string, period: string, amount: number, currency: string | undefined, repSplits: Array<{ subjectId: string; amount: number }>) => Promise<void> }): JSX.Element {
  const { t } = useTranslation('territories');
  const [period, setPeriod] = useState('');
  const [amount, setAmount] = useState(row.quota ? String(row.quota) : '');
  // TER-G2 — this defaulted to 'USD' and then SAVED it, so setting a quota on a
  // territory that had no currency silently stamped one onto the data. Start
  // empty and make choosing explicit.
  const [currency, setCurrency] = useState(row.currency ?? '');
  const [saving, setSaving] = useState(false);
  const periodValid = PERIOD_RE.test(period);
  const amountValid = amount !== '' && Number.isFinite(Number(amount)) && Number(amount) >= 0;
  // R2 TER2-B3 — the server refuses an amount with no currency; the form must say so
  // BEFORE the round trip rather than surfacing it as a toast on submit.
  const currencyMissing = amountValid && Number(amount) > 0 && currency === '';
  const canSave = periodValid && amountValid && !currencyMissing && !saving;
  const periodShowErr = period !== '' && !periodValid;
  const amountShowErr = amount !== '' && !amountValid;
  // R2 TER2-B1 — the SUMS are denominated only when the deals agree AND agree with
  // the quota. Round 1 checked the deals against each other and stopped there, so a
  // territory whose deals are uniformly JPY against a USD quota was labelled `$`.
  // REVIEW I1 — `valueCurrency ?? row.currency` was a back-compat fallback that put the
  // ORIGINAL defect back for the commonest shape: the backend omits `valueCurrency`
  // precisely to say "the deals do not tell us", and the page turned that into the
  // quota's symbol. Absence stays absence. A zero sum needs no unit.
  const denominated = !row.currencyMixed && !row.quotaCurrencyMismatch;
  const sumsAreZero = row.rolled.won === 0 && row.rolled.weightedPipeline === 0;
  const sumCurrency = denominated && (row.valueCurrency || sumsAreZero) ? (row.valueCurrency ?? row.currency) : undefined;
  const currencyNote = row.currencyMixed
    ? <> <span className="chip chip--warning" title={t('mixedCurrencyTitle')}>{t('mixedCurrencyChip')}</span></>
    : row.quotaCurrencyMismatch
      ? <> <span className="chip chip--warning" title={t('currencyMismatchTitle', { deals: row.valueCurrency ?? '', quota: row.currency ?? '' })}>{t('currencyMismatchChip', { deals: row.valueCurrency ?? '', quota: row.currency ?? '' })}</span></>
      : null;
  const quotaMixed = row.quotaCurrencyMixed
    ? <> <span className="chip chip--warning" title={t('quotaMixedTitle')}>{t('quotaMixedChip')}</span></>
    : null;
  // A bare em-dash where a percentage belongs reads as "no deals yet" — the one
  // thing it never means once a quota exists. Every null now carries its reason,
  // and the reason is TITLED so it is reachable, not hover-only decoration.
  const ratioReason = row.ratioUnavailable === 'no-quota' ? t('ratioNoQuota')
    : row.ratioUnavailable === 'mixed-deal-currencies' ? t('ratioMixedDeals')
      : row.ratioUnavailable === 'mixed-quota-currencies' ? t('ratioMixedQuota')
        : row.ratioUnavailable === 'quota-currency-mismatch' ? t('ratioMismatch', { deals: row.valueCurrency ?? '', quota: row.currency ?? '' })
          : '';
  // REVIEW I4 — `<abbr title aria-label>` was hover-only for sighted users, and an
  // `aria-label` on a role-less element is not reliably announced; the test asserted the
  // ATTRIBUTE, so "reachable, not hover-only" was unsupported. The reason is now real
  // text in the DOM — visually hidden beside the dash so the column stays scannable,
  // and read verbatim by a screen reader without depending on a name calculation.
  const ratioAbsent = ratioReason
    ? <>—<span className="sr-only">{` ${t('ratioWhyAria', { name: row.name })}: ${ratioReason}`}</span></>
    : <>—</>;
  const periodErrId = `qp-err-${row.territoryId}`;
  const amountErrId = `qa-err-${row.territoryId}`;
  const currencyErrId = `qc-err-${row.territoryId}`;
  const submit = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    try { await onSaveQuota(row.territoryId, period, Number(amount), currency, row.repSplits.map((sp) => ({ subjectId: sp.subjectId, amount: sp.quota }))); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('quotaFailed')); }
    finally { setSaving(false); }
  };
  return (
    <tr>
      <td>{row.name}</td>
      {/* TER-G1 — the quota is a single authored amount in its OWN currency, so it
          keeps its symbol. The pipeline/won figures are SUMS over deals that may
          span currencies; when they do, the sum is not denominated in anything
          and gets no symbol (there is no FX in this app). */}
      <td className="u-text-right tabular-nums">{row.quota ? money(row.quota, row.currency) : '—'}{quotaMixed}</td>
      <td className="u-text-right tabular-nums">{money(row.rolled.weightedPipeline, sumCurrency)}</td>
      <td className="u-text-right tabular-nums">
        {money(row.rolled.won, sumCurrency)}
        {currencyNote}
      </td>
      <td className="u-text-right tabular-nums">{row.attainment === null ? ratioAbsent : pct(row.attainment)}</td>
      <td className="u-text-right tabular-nums">{row.coverage === null ? ratioAbsent : pct(row.coverage)}</td>
      <td>
        {editable ? (
          <form className="u-flex u-gap-1 u-items-start" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <span className="u-flex-col u-gap-0-5">
              <input aria-label={t('quotaPeriodAria', { name: row.name })} aria-invalid={periodShowErr ? true : undefined} aria-describedby={periodShowErr ? periodErrId : undefined} placeholder={t('periodPlaceholder')} value={period} onChange={(e) => setPeriod(e.target.value)} className="field-compact--lg" />
              {periodShowErr ? <span id={periodErrId} className="field-error" role="alert">{t('periodError')}</span> : null}
            </span>
            <span className="u-flex-col u-gap-0-5">
              <input aria-label={t('quotaAmountAria', { name: row.name })} inputMode="numeric" aria-invalid={amountShowErr ? true : undefined} aria-describedby={amountShowErr ? amountErrId : undefined} placeholder={t('quotaAmountPlaceholder')} value={amount} onChange={(e) => setAmount(e.target.value)} className="field-compact--md" />
              {amountShowErr ? <span id={amountErrId} className="field-error" role="alert">{t('amountError')}</span> : null}
            </span>
            <span className="u-flex-col u-gap-0-5">
              <select aria-label={t('quotaCurrencyAria', { name: row.name })} aria-invalid={currencyMissing ? true : undefined} aria-describedby={currencyMissing ? currencyErrId : undefined} value={currency} onChange={(e) => setCurrency(e.target.value)} className="field-compact">
                <option value="">{t('currencyNone')}</option>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              {currencyMissing ? <span id={currencyErrId} className="field-error" role="alert">{t('currencyRequired')}</span> : null}
            </span>
            <Button type="submit" variant="primary" disabled={!canSave}>{t('setQuota')}</Button>
          </form>
        ) : null}
      </td>
    </tr>
  );
}
