/**
 * Strategy (Strategic Planning) page (ADR 0079). The executive strategy
 * portfolio: a Portfolio tab (all strategies, filterable by horizon/status/scope)
 * + a per-strategy detail editor (Overview / Objectives / Initiatives / Alignment).
 *
 * Composes the shared ui/ cohesion layer (PageHeader / Notice / StateCard / Field
 * / Modal / chips) — no bespoke chrome, no inline color. Toggle-off (a direct
 * deep-link while `strategy` is off) renders a clean "not enabled" state.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { handleTablistKeyDown } from '../../ui/rovingTabs.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Modal } from '../../ui/Modal.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { TextField, TextareaField, SelectField } from '../../ui/Field.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { FlagIcon, PlusIcon, TrashIcon, LinkIcon, CheckIcon, XIcon } from '../../ui/icons/index.js';
import { StrategyCard, StrategyRow } from './StrategyViews.js';
import {
  listStrategies, createStrategy, updateStrategy, archiveStrategy, deleteStrategy,
  replaceLinks, listOrgs, listProjects, getStrategyHealth, FeatureDisabledError,
  type Strategy, type StrategyScope, type PlanningHorizon, type StrategyStatus, type StrategyConfidence,
  type StrategyRisk, type StrategyObjective, type StrategyInitiative, type StrategyLink,
  type OrgRef, type ProjectRef, type StrategyHealthState,
} from './strategyClient.js';
import { STRATEGY_TEMPLATES, type StrategyTemplate } from './strategyTemplates.js';

const SCOPES: StrategyScope[] = ['user', 'workspace', 'org'];
const HORIZONS: PlanningHorizon[] = ['quarter', 'half-year', 'annual', 'multi-year', 'custom'];
const STATUSES: StrategyStatus[] = ['draft', 'active', 'paused', 'completed', 'archived'];
const CONFIDENCES: StrategyConfidence[] = ['high', 'medium', 'low'];
const RISKS: StrategyRisk[] = ['low', 'medium', 'high'];

const STATUS_CHIP: Record<StrategyStatus, string> = { draft: 'chip--muted', active: 'chip--success', paused: 'chip--warning', completed: 'chip--accent', archived: 'chip--muted' };
// Linked-project health → chip (mirrors the projects feature's mapping, ADR 0054).
const PROJECT_HEALTH_CHIP: Record<string, string> = { 'on-track': 'chip--success', 'at-risk': 'chip--warning', 'off-track': 'chip--danger' };
// Strategy health (ADR 0080) — the portfolio Card/Row chip lives in StrategyViews;
// the detail editor only needs the health-OVERRIDE option list.
const HEALTH_STATES: StrategyHealthState[] = ['on-track', 'at-risk', 'off-track'];

const uid = (): string => `tmp-${Math.random().toString(36).slice(2, 10)}`;

export function StrategyPage(): JSX.Element {
  const { t } = useTranslation('strategy');
  const [strategies, setStrategies] = useState<Strategy[] | null>(null);
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<string>('portfolio'); // 'portfolio' | strategyId
  const [createOpen, setCreateOpen] = useState(false);
  const [fScope, setFScope] = useState<string>('');
  const [fStatus, setFStatus] = useState<string>('');
  const [fHorizon, setFHorizon] = useState<string>('');
  // ADR 0080 — per-strategy health rollup (fetched once, fail-soft: empty map ⇒ no chip).
  const [health, setHealth] = useState<Map<string, StrategyHealthState>>(new Map());
  const refreshHealth = useCallback(async () => {
    try { setHealth(new Map((await getStrategyHealth()).map((r) => [r.id, r.health]))); }
    catch { setHealth(new Map()); }
  }, []);

  const refresh = useCallback(async () => {
    try { setStrategies(await listStrategies({ includeArchived: true })); setDisabled(false); }
    catch (e) {
      if (e instanceof FeatureDisabledError) { setDisabled(true); setStrategies([]); return; }
      setError(e instanceof Error ? e.message : t('loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    void refreshHealth();
    void listOrgs().then(setOrgs).catch(() => {});
    void listProjects().then(setProjects).catch(() => {});
  }, [refresh, refreshHealth]);

  const selected = useMemo(() => strategies?.find((s) => s.id === view) ?? null, [strategies, view]);

  const filtered = useMemo(() => (strategies ?? []).filter((s) =>
    (!fScope || s.scope === fScope) && (!fStatus || s.status === fStatus) && (!fHorizon || s.planningHorizon === fHorizon),
  ), [strategies, fScope, fStatus, fHorizon]);

  if (disabled) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<FlagIcon size={22} />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
        actions={strategies && strategies.length > 0 ? <button type="button" className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}><PlusIcon size={13} /> {t('newStrategy')}</button> : undefined}
      />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {createOpen ? (
        <Modal label={t('createModalLabel')} onClose={() => setCreateOpen(false)}>
          <h2 className="u-mt-0">{t('createModalHeading')}</h2>
          <CreateStrategyForm
            orgs={orgs}
            onCreated={async (s) => { await refresh(); setView(s.id); setCreateOpen(false); }}
            onError={setError}
          />
        </Modal>
      ) : null}

      {strategies === null ? (
        <StateCard icon={<FlagIcon size={20} />} title={t('loading')} loading />
      ) : strategies.length === 0 ? (
        <StateCard
          icon={<FlagIcon size={22} />}
          title={t('emptyTitle')}
          body={t('emptyBody')}
          action={<button type="button" className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}><PlusIcon size={13} /> {t('createFirst')}</button>}
        />
      ) : (
        <>
          <div className="tabs u-mb-4" role="tablist" aria-label={t('tablistLabel')} onKeyDown={handleTablistKeyDown}>
            <button type="button" role="tab" aria-selected={view === 'portfolio'} tabIndex={view === 'portfolio' ? 0 : -1} className="tab" onClick={() => setView('portfolio')}>{t('tabPortfolio')}</button>
            {selected ? <button type="button" role="tab" aria-selected={view !== 'portfolio'} tabIndex={view === 'portfolio' ? -1 : 0} className="tab">{selected.title}</button> : null}
          </div>

          {view === 'portfolio' || !selected ? (
            <PortfolioSection
              strategies={filtered}
              health={health}
              fScope={fScope} fStatus={fStatus} fHorizon={fHorizon}
              setFScope={setFScope} setFStatus={setFStatus} setFHorizon={setFHorizon}
              onOpen={(id) => setView(id)}
              t={t}
            />
          ) : (
            <StrategyDetail
              key={selected.id}
              strategy={selected}
              projects={projects}
              onChanged={refresh}
              onClosed={async () => { setView('portfolio'); await refresh(); }}
              onError={setError}
              t={t}
            />
          )}
        </>
      )}
    </div>
  );
}

type TFn = ReturnType<typeof useTranslation>['t'];

function ScopeChip({ scope, t }: { scope: StrategyScope; t: TFn }): JSX.Element {
  return <span className="chip chip--muted">{t(`scope_${scope}`)}</span>;
}
function StatusChip({ status, t }: { status: StrategyStatus; t: TFn }): JSX.Element {
  return <span className={`chip ${STATUS_CHIP[status]}`}>{t(`status_${status}`)}</span>;
}

function PortfolioSection(props: {
  strategies: Strategy[];
  health: Map<string, StrategyHealthState>;
  fScope: string; fStatus: string; fHorizon: string;
  setFScope: (v: string) => void; setFStatus: (v: string) => void; setFHorizon: (v: string) => void;
  onOpen: (id: string) => void; t: TFn;
}): JSX.Element {
  const { strategies, health, fScope, fStatus, fHorizon, setFScope, setFStatus, setFHorizon, onOpen, t } = props;
  // ADR 0100 transparency: shared strategies are retrievable by agents only when
  // KB is on; user-scoped strategies are NEVER indexed (private).
  const kbEnabled = true; // KB always-on (toggle removed)
  const [viewMode, setViewMode] = useViewMode('strategy', 'grid');
  return (
    <div>
      <div className="action-bar u-mb-4 u-gap-2 u-flex-wrap">
        <SelectField label={t('filterScope')} value={fScope} onChange={(e) => setFScope(e.target.value)}>
          <option value="">{t('filterAll')}</option>
          {SCOPES.map((s) => <option key={s} value={s}>{t(`scope_${s}`)}</option>)}
        </SelectField>
        <SelectField label={t('filterStatus')} value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="">{t('filterAll')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
        </SelectField>
        <SelectField label={t('filterHorizon')} value={fHorizon} onChange={(e) => setFHorizon(e.target.value)}>
          <option value="">{t('filterAll')}</option>
          {HORIZONS.map((h) => <option key={h} value={h}>{t(`horizon_${h}`)}</option>)}
        </SelectField>
        <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
      </div>

      {strategies.length === 0 ? (
        <StateCard icon={<FlagIcon size={20} />} title={t('noMatchTitle')} body={t('noMatchBody')} />
      ) : viewMode === 'grid' ? (
        <div className="card-grid">
          {strategies.map((s) => (
            <StrategyCard key={s.id} s={s} health={health} kbEnabled={kbEnabled} onOpen={onOpen} />
          ))}
        </div>
      ) : (
        <div className="surface-card list-view">
          {strategies.map((s) => (
            <StrategyRow key={s.id} s={s} health={health} kbEnabled={kbEnabled} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateStrategyForm({ orgs, onCreated, onError }: { orgs: OrgRef[]; onCreated: (s: Strategy) => void | Promise<void>; onError: (m: string) => void }): JSX.Element {
  const { t } = useTranslation('strategy');
  const [orgId, setOrgId] = useState(orgs[0]?.orgId ?? '');
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState<StrategyScope>('org');
  const [horizon, setHorizon] = useState<PlanningHorizon>('annual');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  // ADR 0080 Phase E — template presets. 'blank' leaves the form as-is; a template
  // pre-fills horizon/summary/rationale + a scaffold of objectives/initiatives that
  // ride the existing createStrategy (the backend re-validates everything).
  const [templateId, setTemplateId] = useState<string>('blank');
  const [scaffold, setScaffold] = useState<{ rationale?: string; objectives: StrategyObjective[]; initiatives: StrategyInitiative[] }>({ objectives: [], initiatives: [] });
  useEffect(() => { if (!orgId && orgs[0]) setOrgId(orgs[0].orgId); }, [orgs, orgId]);

  const applyTemplate = (tpl: StrategyTemplate | null): void => {
    setTemplateId(tpl?.id ?? 'blank');
    if (!tpl) { setScaffold({ objectives: [], initiatives: [] }); return; }
    const s = tpl.scaffold;
    setHorizon(s.horizon);
    setSummary(t(s.summaryKey));
    setScaffold({
      ...(s.rationaleKey ? { rationale: t(s.rationaleKey) } : {}),
      objectives: s.objectives.map((o) => ({ id: uid(), title: t(o.titleKey), keyResults: o.keyResults.map((k) => ({ id: uid(), title: t(k.titleKey) })) })),
      initiatives: s.initiatives.map((i) => ({ id: uid(), title: t(i.titleKey) })),
    });
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!title.trim() || !orgId) return;
    setBusy(true);
    try {
      await onCreated(await createStrategy({
        orgId, title: title.trim(), scope, planningHorizon: horizon,
        ...(summary.trim() ? { summary: summary.trim() } : {}),
        ...(scaffold.rationale ? { rationale: scaffold.rationale } : {}),
        ...(scaffold.objectives.length ? { objectives: scaffold.objectives } : {}),
        ...(scaffold.initiatives.length ? { initiatives: scaffold.initiatives } : {}),
      }));
    }
    catch (err) { onError(err instanceof Error ? err.message : t('createFailed')); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="u-flex u-flex-col u-gap-3">
      <div className="u-grid u-gap-2">
        <span className="u-fs-13 u-fw-600" id="strategy-tpl-label">{t('startFromLabel')}</span>
        <div className="u-flex u-gap-2 u-wrap" role="group" aria-labelledby="strategy-tpl-label">
          <button type="button" className={`chip ${templateId === 'blank' ? 'chip--accent' : 'chip--muted'}`} aria-pressed={templateId === 'blank'} onClick={() => applyTemplate(null)}>{t('templateBlank')}</button>
          {STRATEGY_TEMPLATES.map((tpl) => (
            <button key={tpl.id} type="button" className={`chip ${templateId === tpl.id ? 'chip--accent' : 'chip--muted'}`} aria-pressed={templateId === tpl.id} title={t(tpl.descKey)} onClick={() => applyTemplate(tpl)}>{t(tpl.labelKey)}</button>
          ))}
        </div>
        <span className="muted u-fs-12" role="status" aria-live="polite">{templateId !== 'blank' ? t('templateApplied', { n: scaffold.objectives.length }) : ''}</span>
      </div>
      <SelectField label={t('fieldOrg')} required value={orgId} onChange={(e) => setOrgId(e.target.value)}>
        {orgs.length === 0 ? <option value="">{t('noOrgs')}</option> : null}
        {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
      </SelectField>
      <TextField label={t('fieldTitle')} required value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('fieldTitlePlaceholder')} />
      <div className="u-flex u-gap-3 u-flex-wrap">
        <SelectField label={t('fieldScope')} value={scope} onChange={(e) => setScope(e.target.value as StrategyScope)}>
          {SCOPES.map((s) => <option key={s} value={s}>{t(`scope_${s}`)}</option>)}
        </SelectField>
        <SelectField label={t('fieldHorizon')} value={horizon} onChange={(e) => setHorizon(e.target.value as PlanningHorizon)}>
          {HORIZONS.map((h) => <option key={h} value={h}>{t(`horizon_${h}`)}</option>)}
        </SelectField>
      </div>
      <TextareaField label={t('fieldSummary')} value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} />
      <div className="action-bar">
        <button type="submit" className="btn-primary btn-sm" disabled={busy || !title.trim() || !orgId}>{busy ? t('common:saving') : t('common:create')}</button>
      </div>
    </form>
  );
}

function StrategyDetail(props: {
  strategy: Strategy; projects: ProjectRef[];
  onChanged: () => void | Promise<void>; onClosed: () => void | Promise<void>; onError: (m: string) => void; t: TFn;
}): JSX.Element {
  const { strategy, projects, onChanged, onClosed, onError, t } = props;
  const [tab, setTab] = useState<'overview' | 'objectives' | 'initiatives' | 'alignment'>('overview');

  return (
    <div className="surface-card">
      <h2 className="u-mt-0 u-mb-2">{strategy.title}</h2>
      <div className="u-flex u-items-center u-justify-between u-gap-2 u-mb-3">
        <div className="u-flex u-gap-2 u-flex-wrap u-items-center">
          <ScopeChip scope={strategy.scope} t={t} />
          <StatusChip status={strategy.status} t={t} />
          <span className="chip chip--muted">{t(`horizon_${strategy.planningHorizon}`)}</span>
        </div>
        <button type="button" className="ghost btn-sm" onClick={() => void onClosed()}>{t('backToPortfolio')}</button>
      </div>

      <div className="tabs u-mb-4" role="tablist" aria-label={t('detailTablistLabel')} onKeyDown={handleTablistKeyDown}>
        <button type="button" role="tab" aria-selected={tab === 'overview'} tabIndex={tab === 'overview' ? 0 : -1} className="tab" onClick={() => setTab('overview')}>{t('detailOverview')}</button>
        <button type="button" role="tab" aria-selected={tab === 'objectives'} tabIndex={tab === 'objectives' ? 0 : -1} className="tab" onClick={() => setTab('objectives')}>{t('detailObjectives')}</button>
        <button type="button" role="tab" aria-selected={tab === 'initiatives'} tabIndex={tab === 'initiatives' ? 0 : -1} className="tab" onClick={() => setTab('initiatives')}>{t('detailInitiatives')}</button>
        <button type="button" role="tab" aria-selected={tab === 'alignment'} tabIndex={tab === 'alignment' ? 0 : -1} className="tab" onClick={() => setTab('alignment')}>{t('detailAlignment')}</button>
      </div>

      {tab === 'overview' ? <OverviewEditor strategy={strategy} onChanged={onChanged} onClosed={onClosed} onError={onError} t={t} /> : null}
      {tab === 'objectives' ? <ObjectivesEditor strategy={strategy} onChanged={onChanged} onError={onError} t={t} /> : null}
      {tab === 'initiatives' ? <InitiativesEditor strategy={strategy} onChanged={onChanged} onError={onError} t={t} /> : null}
      {tab === 'alignment' ? <AlignmentEditor strategy={strategy} projects={projects} onChanged={onChanged} onError={onError} t={t} /> : null}
    </div>
  );
}

function OverviewEditor({ strategy, onChanged, onClosed, onError, t }: { strategy: Strategy; onChanged: () => void | Promise<void>; onClosed: () => void | Promise<void>; onError: (m: string) => void; t: TFn }): JSX.Element {
  const [title, setTitle] = useState(strategy.title);
  const [summary, setSummary] = useState(strategy.summary ?? '');
  const [rationale, setRationale] = useState(strategy.rationale ?? '');
  const [scope, setScope] = useState(strategy.scope);
  const [horizon, setHorizon] = useState(strategy.planningHorizon);
  const [status, setStatus] = useState(strategy.status);
  const [confidence, setConfidence] = useState<string>(strategy.confidence ?? '');
  const [risk, setRisk] = useState<string>(strategy.risk ?? '');
  const [healthOverride, setHealthOverride] = useState<string>(strategy.healthOverride ?? '');
  const [owner, setOwner] = useState(strategy.ownerUserId ?? '');
  const [exec, setExec] = useState(strategy.accountableExecutive ?? '');
  const [busy, setBusy] = useState(false);
  // Which destructive action is awaiting confirmation (replaces window.confirm).
  const [confirm, setConfirm] = useState<null | 'archive' | 'delete'>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await updateStrategy(strategy.id, {
        title: title.trim(), summary, rationale, scope, planningHorizon: horizon, status,
        confidence: (confidence as StrategyConfidence) || null,
        risk: (risk as StrategyRisk) || null,
        healthOverride: (healthOverride as StrategyHealthState) || null,
        ownerUserId: owner, accountableExecutive: exec,
      });
      await onChanged();
    } catch (e) { onError(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  };

  const archive = async (): Promise<void> => {
    setBusy(true);
    try { await archiveStrategy(strategy.id); await onClosed(); }
    catch (e) { onError(e instanceof Error ? e.message : t('saveFailed')); setConfirm(null); }
    finally { setBusy(false); }
  };
  const hardDelete = async (): Promise<void> => {
    setBusy(true);
    try { await deleteStrategy(strategy.id); await onClosed(); }
    catch (e) { onError(e instanceof Error ? e.message : t('saveFailed')); setConfirm(null); }
    finally { setBusy(false); }
  };

  return (
    <div className="u-flex u-flex-col u-gap-3">
      <TextField label={t('fieldTitle')} value={title} onChange={(e) => setTitle(e.target.value)} />
      <TextareaField label={t('fieldSummary')} value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} />
      <TextareaField label={t('fieldRationale')} help={t('fieldRationaleHelp')} value={rationale} onChange={(e) => setRationale(e.target.value)} rows={4} />
      <div className="u-flex u-gap-3 u-flex-wrap">
        <SelectField label={t('fieldScope')} value={scope} onChange={(e) => setScope(e.target.value as StrategyScope)}>
          {SCOPES.map((s) => <option key={s} value={s}>{t(`scope_${s}`)}</option>)}
        </SelectField>
        <SelectField label={t('fieldHorizon')} value={horizon} onChange={(e) => setHorizon(e.target.value as PlanningHorizon)}>
          {HORIZONS.map((h) => <option key={h} value={h}>{t(`horizon_${h}`)}</option>)}
        </SelectField>
        <SelectField label={t('fieldStatus')} value={status} onChange={(e) => setStatus(e.target.value as StrategyStatus)}>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
        </SelectField>
      </div>
      <div className="u-flex u-gap-3 u-flex-wrap">
        <SelectField label={t('fieldConfidence')} value={confidence} onChange={(e) => setConfidence(e.target.value)}>
          <option value="">{t('common:none')}</option>
          {CONFIDENCES.map((c) => <option key={c} value={c}>{t(`level_${c}`)}</option>)}
        </SelectField>
        <SelectField label={t('fieldRisk')} value={risk} onChange={(e) => setRisk(e.target.value)}>
          <option value="">{t('common:none')}</option>
          {RISKS.map((r) => <option key={r} value={r}>{t(`level_${r}`)}</option>)}
        </SelectField>
        <SelectField label={t('fieldHealth')} help={t('fieldHealthHelp')} value={healthOverride} onChange={(e) => setHealthOverride(e.target.value)}>
          <option value="">{t('healthAuto')}</option>
          {HEALTH_STATES.map((h) => <option key={h} value={h}>{t(`health_${h}`)}</option>)}
        </SelectField>
      </div>
      <div className="u-flex u-gap-3 u-flex-wrap">
        <TextField label={t('fieldOwner')} value={owner} onChange={(e) => setOwner(e.target.value)} />
        <TextField label={t('fieldExec')} value={exec} onChange={(e) => setExec(e.target.value)} />
      </div>
      <div className="action-bar u-justify-between">
        <button type="button" className="btn-primary btn-sm" disabled={busy || !title.trim()} onClick={() => void save()}><CheckIcon size={13} /> {busy ? t('common:saving') : t('common:save')}</button>
        <div className="action-bar u-gap-2">
          {/* Shared/org strategies can be archived (reversible: hidden from the
              active portfolio). Hard-delete is offered for every strategy — the
              backend gates it to the creator or an org admin (requireConfig
              authority); an unauthorized caller gets a 403 surfaced as a notice. */}
          {strategy.scope !== 'user' ? (
            <button type="button" className="ghost btn-sm" disabled={busy || strategy.status === 'archived'} onClick={() => setConfirm('archive')}>{t('archive')}</button>
          ) : null}
          <button type="button" className="secondary u-text-danger btn-sm" disabled={busy} onClick={() => setConfirm('delete')}><TrashIcon size={13} /> {t('common:delete')}</button>
        </div>
      </div>

      {confirm ? (
        <ConfirmDialog
          title={t(confirm === 'delete' ? 'confirmDeleteTitle' : 'confirmArchiveTitle', { title: strategy.title })}
          body={t(confirm === 'delete' ? 'confirmDelete' : 'confirmArchive')}
          confirmLabel={confirm === 'delete' ? t('common:delete') : t('archive')}
          confirmIcon={confirm === 'delete' ? <TrashIcon size={14} /> : undefined}
          danger={confirm === 'delete'}
          busy={busy}
          onConfirm={() => void (confirm === 'delete' ? hardDelete() : archive())}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}

function ObjectivesEditor({ strategy, onChanged, onError, t }: { strategy: Strategy; onChanged: () => void | Promise<void>; onError: (m: string) => void; t: TFn }): JSX.Element {
  const [objectives, setObjectives] = useState<StrategyObjective[]>(() => structuredClone(strategy.objectives));
  const [busy, setBusy] = useState(false);

  const addObjective = (): void => setObjectives((p) => [...p, { id: uid(), title: '', keyResults: [] }]);
  const removeObjective = (oid: string): void => setObjectives((p) => p.filter((o) => o.id !== oid));
  const setObjTitle = (oid: string, title: string): void => setObjectives((p) => p.map((o) => (o.id === oid ? { ...o, title } : o)));
  const addKR = (oid: string): void => setObjectives((p) => p.map((o) => (o.id === oid ? { ...o, keyResults: [...o.keyResults, { id: uid(), title: '' }] } : o)));
  const removeKR = (oid: string, kid: string): void => setObjectives((p) => p.map((o) => (o.id === oid ? { ...o, keyResults: o.keyResults.filter((k) => k.id !== kid) } : o)));
  const setKR = (oid: string, kid: string, field: 'title' | 'target' | 'current', value: string): void =>
    setObjectives((p) => p.map((o) => (o.id === oid ? { ...o, keyResults: o.keyResults.map((k) => (k.id === kid ? { ...k, [field]: value } : k)) } : o)));

  const save = async (): Promise<void> => {
    setBusy(true);
    try { await updateStrategy(strategy.id, { objectives: objectives.filter((o) => o.title.trim()).map((o) => ({ ...o, keyResults: o.keyResults.filter((k) => k.title.trim()) })) }); await onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  };

  return (
    <div className="u-flex u-flex-col u-gap-3">
      {objectives.length === 0 ? <StateCard icon={<FlagIcon />} title={t('noObjectives')} /> : null}
      {objectives.map((o) => (
        <div key={o.id} className="surface-card">
          <div className="u-flex u-gap-2 u-items-end">
            <TextField label={t('objectiveTitle')} value={o.title} onChange={(e) => setObjTitle(o.id, e.target.value)} className="u-flex-1" />
            <button type="button" className="ghost btn-sm" aria-label={t('removeObjective')} onClick={() => removeObjective(o.id)}><TrashIcon size={13} /></button>
          </div>
          <div className="u-flex u-flex-col u-gap-2 u-mt-2 u-ml-2">
            {o.keyResults.map((k, ki) => (
              <div key={k.id} className="u-flex u-gap-2 u-items-end u-flex-wrap" role="group" aria-label={t('krGroupLabel', { n: ki + 1 })}>
                <TextField label={t('krTitle')} value={k.title} onChange={(e) => setKR(o.id, k.id, 'title', e.target.value)} className="u-flex-2" />
                <TextField label={t('krTarget')} value={k.target ?? ''} onChange={(e) => setKR(o.id, k.id, 'target', e.target.value)} className="u-flex-1" />
                <TextField label={t('krCurrent')} value={k.current ?? ''} onChange={(e) => setKR(o.id, k.id, 'current', e.target.value)} className="u-flex-1" />
                <button type="button" className="ghost btn-sm" aria-label={t('removeKr')} onClick={() => removeKR(o.id, k.id)}><XIcon size={13} /></button>
              </div>
            ))}
            <div><button type="button" className="ghost btn-sm" onClick={() => addKR(o.id)}><PlusIcon size={12} /> {t('addKr')}</button></div>
          </div>
        </div>
      ))}
      <div className="action-bar u-justify-between">
        <button type="button" className="ghost btn-sm" onClick={addObjective}><PlusIcon size={13} /> {t('addObjective')}</button>
        <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void save()}>{busy ? t('common:saving') : t('common:save')}</button>
      </div>
    </div>
  );
}

function InitiativesEditor({ strategy, onChanged, onError, t }: { strategy: Strategy; onChanged: () => void | Promise<void>; onError: (m: string) => void; t: TFn }): JSX.Element {
  const [initiatives, setInitiatives] = useState<StrategyInitiative[]>(() => structuredClone(strategy.initiatives));
  const [busy, setBusy] = useState(false);
  const add = (): void => setInitiatives((p) => [...p, { id: uid(), title: '' }]);
  const remove = (id: string): void => setInitiatives((p) => p.filter((i) => i.id !== id));
  const setField = (id: string, field: 'title' | 'ownerUserId', value: string): void => setInitiatives((p) => p.map((i) => (i.id === id ? { ...i, [field]: value } : i)));

  const save = async (): Promise<void> => {
    setBusy(true);
    try { await updateStrategy(strategy.id, { initiatives: initiatives.filter((i) => i.title.trim()) }); await onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  };

  return (
    <div className="u-flex u-flex-col u-gap-3">
      {initiatives.length === 0 ? <StateCard icon={<FlagIcon />} title={t('noInitiatives')} /> : null}
      {initiatives.map((i) => (
        <div key={i.id} className="u-flex u-gap-2 u-items-end u-flex-wrap">
          <TextField label={t('initiativeTitle')} value={i.title} onChange={(e) => setField(i.id, 'title', e.target.value)} className="u-flex-2" />
          <TextField label={t('initiativeOwner')} value={i.ownerUserId ?? ''} onChange={(e) => setField(i.id, 'ownerUserId', e.target.value)} className="u-flex-1" />
          <button type="button" className="ghost btn-sm" aria-label={t('removeInitiative')} onClick={() => remove(i.id)}><TrashIcon size={13} /></button>
        </div>
      ))}
      <div className="action-bar u-justify-between">
        <button type="button" className="ghost btn-sm" onClick={add}><PlusIcon size={13} /> {t('addInitiative')}</button>
        <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void save()}>{busy ? t('common:saving') : t('common:save')}</button>
      </div>
    </div>
  );
}

function AlignmentEditor({ strategy, projects, onChanged, onError, t }: { strategy: Strategy; projects: ProjectRef[]; onChanged: () => void | Promise<void>; onError: (m: string) => void; t: TFn }): JSX.Element {
  const [links, setLinks] = useState<StrategyLink[]>(() => structuredClone(strategy.links));
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);

  const linkedProjectIds = new Set(links.filter((l) => l.kind === 'project').map((l) => (l as { projectId: string }).projectId));
  const addable = projects.filter((p) => !linkedProjectIds.has(p.id));

  const addProject = (): void => { if (projectId) { setLinks((p) => [...p, { kind: 'project', projectId }]); setProjectId(''); } };
  const removeLink = (idx: number): void => setLinks((p) => p.filter((_, i) => i !== idx));

  const save = async (): Promise<void> => {
    setBusy(true);
    try { await replaceLinks(strategy.id, links); await onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  };

  const proj = (id: string): ProjectRef | undefined => projects.find((p) => p.id === id);

  return (
    <div className="u-flex u-flex-col u-gap-3">
      <p className="muted u-fs-13">{t('alignmentLede')}</p>
      {links.length === 0 ? <StateCard icon={<FlagIcon />} title={t('noLinks')} /> : (
        <ul className="u-flex u-flex-col u-gap-2 u-list-none u-p-0">
          {links.map((l, idx) => {
            const p = l.kind === 'project' ? proj(l.projectId) : undefined;
            const label = l.kind === 'project' ? (p?.name ?? l.projectId) : l.kind === 'priority-idea' ? `${l.listId} · ${l.cardId}` : l.kind === 'priority-list' ? l.listId : l.kind === 'advisory-board' ? l.boardId : l.documentId;
            return (
              <li key={`${l.kind}-${idx}`} className="u-flex u-items-center u-justify-between u-gap-2 surface-card u-py-2">
                <span className="u-flex u-items-center u-gap-2 u-flex-wrap">
                  <LinkIcon size={13} />
                  <span className="chip chip--accent">{t(`linkKind_${l.kind}`)}</span>
                  <span>{label}</span>
                  {p?.status ? <span className="chip chip--muted u-fs-11">{p.status}</span> : null}
                  {p?.health ? <span className={`chip u-fs-11 ${PROJECT_HEALTH_CHIP[p.health] ?? 'chip--muted'}`}>{p.health}</span> : null}
                </span>
                <button type="button" className="ghost btn-sm" aria-label={t('removeLink')} onClick={() => removeLink(idx)}><TrashIcon size={13} /></button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="u-flex u-gap-2 u-items-end u-flex-wrap">
        <SelectField label={t('linkProject')} value={projectId} onChange={(e) => setProjectId(e.target.value)} className="u-flex-1">
          <option value="">{addable.length ? t('selectProject') : t('noMoreProjects')}</option>
          {addable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </SelectField>
        <button type="button" className="ghost btn-sm" disabled={!projectId} onClick={addProject}><PlusIcon size={13} /> {t('addLink')}</button>
      </div>
      <div className="action-bar u-justify-end">
        <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void save()}>{busy ? t('common:saving') : t('saveAlignment')}</button>
      </div>
    </div>
  );
}
