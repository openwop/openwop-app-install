/**
 * Strategy (Strategic Planning) portfolio page (ADR 0079 — see the routing
 * correction note). Lists all strategies (filterable by horizon/status/scope)
 * as grid/list cells that LINK to each strategy's own URL
 * (`/strategy/:strategyId` → `StrategyDetailPage`); this page no longer hosts
 * an in-page Portfolio/<title> tablist.
 *
 * Composes the shared ui/ cohesion layer (PageHeader / Notice / StateCard / Field
 * / Modal / chips) — no bespoke chrome, no inline color. Toggle-off (a direct
 * deep-link while `strategy` is off) renders a clean "not enabled" state.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Modal } from '../../ui/Modal.js';
import { TextField, TextareaField, SelectField } from '../../ui/Field.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { useLiveRegion } from '../../ui/announce.js';
import { FlagIcon, PlusIcon } from '../../ui/icons/index.js';
import { StrategyCard, StrategyRow } from './StrategyViews.js';
// SPU-2 — `toast.success` routes through `ui/toast.tsx:69` -> `announce()`, so one
// call reaches the screen AND assistive tech. See the note at the create form.
import { toast } from '../../ui/toast.js';
import {
  listStrategies, createStrategy, listOrgs, getStrategyHealth, FeatureDisabledError,
  type Strategy, type StrategyScope, type PlanningHorizon,
  type StrategyObjective, type StrategyInitiative,
  type OrgRef, type StrategyHealthState,
} from './strategyClient.js';
import { SCOPES, HORIZONS, STATUSES, uid, type TFn } from './strategyShared.js';
import { STRATEGY_TEMPLATES, type StrategyTemplate } from './strategyTemplates.js';

export function StrategyPage(): JSX.Element {
  const { t } = useTranslation('strategy');
  const navigate = useNavigate();
  const [strategies, setStrategies] = useState<Strategy[] | null>(null);
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [orgsFailed, setOrgsFailed] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [fScope, setFScope] = useState<string>('');
  const [fStatus, setFStatus] = useState<string>('');
  const [fHorizon, setFHorizon] = useState<string>('');
  // ADR 0080 — per-strategy health rollup.
  // R2 STR2-B1 — "fail-soft: empty map ⇒ no chip" reads as harmless and is not: an EMPTY
  // map says "nothing here is at risk", which is a positive claim, on the one column an
  // exec scans. Round 1's own doctrine, on the page round 1 did not open.
  //
  // CORRECTION (review): an earlier version of this comment said a missing chip "cannot
  // arise naturally". It can — `GET /health` reads `includeArchived: false` while this
  // page lists with `includeArchived: true`, so every archived row legitimately has a
  // blank chip. The disclosure is keyed on the CATCH, not on emptiness, so the fix is
  // unaffected; the reasoning was wrong and is worth not leaving in the file.
  const [health, setHealth] = useState<Map<string, StrategyHealthState>>(new Map());
  const [healthFailed, setHealthFailed] = useState(false);
  const refreshHealth = useCallback(async () => {
    try {
      setHealth(new Map((await getStrategyHealth()).map((r) => [r.id, r.health])));
      setHealthFailed(false);
    } catch { setHealth(new Map()); setHealthFailed(true); }
  }, []);

  const refresh = useCallback(async () => {
    // SPU-3 / SPC-13 — `setError(null)` appeared NOWHERE in this feature, and the
    // consequence is not "a banner lingers": it is a banner that MOUNTS FOR THE
    // FIRST TIME ON SUCCESS. While the read is failing, `error && !listFailed`
    // hides it (the StateCard owns the failure); a SUCCESSFUL retry flips
    // `listFailed` false with `error` still set, so the red Notice appears over a
    // correctly-loaded portfolio — and because it carries `announce`, it fires an
    // ASSERTIVE screen-reader interrupt reading a raw server error that is no
    // longer true. Clearing on success is the whole cure.
    try { setStrategies(await listStrategies({ includeArchived: true })); setDisabled(false); setListFailed(false); setError(null); }
    catch (e) {
      if (e instanceof FeatureDisabledError) { setDisabled(true); setStrategies([]); return; }
      // R2 STR2-M1 — the catch left `strategies === null`, so the page rendered the error
      // Notice AND an eternal `<StateCard loading />` at the same time, forever.
      setListFailed(true);
      setStrategies([]);
      setError(e instanceof Error ? e.message : t('loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    void refreshHealth();
    // R2 STR2-B2 — a bare swallow left `orgs: []`, which renders the option
    // "No organizations available" and disables Create (`!orgId`) with no error anywhere
    // on screen. The user is told their workspace has no orgs and files a bug against
    // Access Control.
    void listOrgs().then((o) => { setOrgs(o); setOrgsFailed(false); }).catch(() => { setOrgsFailed(true); });
  }, [refresh, refreshHealth]);

  const filtered = useMemo(() => (strategies ?? []).filter((s) =>
    (!query.trim() || s.title.toLowerCase().includes(query.trim().toLowerCase()))
    && (!fScope || s.scope === fScope) && (!fStatus || s.status === fStatus) && (!fHorizon || s.planningHorizon === fHorizon),
  ), [strategies, query, fScope, fStatus, fHorizon]);

  if (disabled) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<FlagIcon size={22} />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </div>
    );
  }

  return (
    <div data-walkthrough="strategy.page">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
        actions={strategies && strategies.length > 0 ? <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}><PlusIcon size={13} /> {t('newStrategy')}</Button> : undefined}
      />
      {/* R2 STR2-M3 — round 1 added `announce` to exactly one Notice; every OTHER error on
          this feature is conditionally mounted, which per `Notice`'s own docblock means
          the region arrives complete and announces nothing. */}
      {error && !listFailed ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {/* R2 STR2-B1 — say the health column could not be loaded, so a screen with no
          danger chips is not read as a portfolio with no danger. */}
      {healthFailed ? <Notice variant="warning" announce={t('healthLoadFailed')}>{t('healthLoadFailed')} <Button variant="link" onClick={() => void refreshHealth()}>{t('common:retry')}</Button></Notice> : null}

      {createOpen ? (
        <Modal label={t('createModalLabel')} onClose={() => setCreateOpen(false)}>
          <h2 className="u-mt-0">{t('createModalHeading')}</h2>
          <CreateStrategyForm
            orgs={orgs}
            orgsFailed={orgsFailed}
            onCreated={(s) => navigate(`/strategy/${encodeURIComponent(s.id)}`)}
            onError={setError}
          />
        </Modal>
      ) : null}

      {listFailed ? (
        /* R2 STR2-M1 — NOT the empty state: a failed list is not "no strategies yet". */
        <StateCard announce icon={<FlagIcon size={22} />} title={t('listFailedTitle')} body={t('listFailedBody')} action={<Button variant="primary" size="sm" onClick={() => void refresh()}>{t('common:retry')}</Button>} />
      ) : strategies === null ? (
        <StateCard icon={<FlagIcon size={20} />} title={t('loading')} loading />
      ) : strategies.length === 0 ? (
        <StateCard
          icon={<FlagIcon size={22} />}
          title={t('emptyTitle')}
          body={t('emptyBody')}
          action={<Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}><PlusIcon size={13} /> {t('createFirst')}</Button>}
        />
      ) : (
        <PortfolioSection
          strategies={filtered}
          total={strategies.length}
          health={health}
          query={query} setQuery={setQuery}
          fScope={fScope} fStatus={fStatus} fHorizon={fHorizon}
          setFScope={setFScope} setFStatus={setFStatus} setFHorizon={setFHorizon}
          t={t}
        />
      )}
    </div>
  );
}

function PortfolioSection(props: {
  strategies: Strategy[];
  /** Unfiltered count — gates the search input (shown past 3 strategies). */
  total: number;
  health: Map<string, StrategyHealthState>;
  query: string; setQuery: (v: string) => void;
  fScope: string; fStatus: string; fHorizon: string;
  setFScope: (v: string) => void; setFStatus: (v: string) => void; setFHorizon: (v: string) => void;
  t: TFn;
}): JSX.Element {
  const { strategies, total, health, query, setQuery, fScope, fStatus, fHorizon, setFScope, setFStatus, setFHorizon, t } = props;
  // ADR 0100 transparency: shared strategies are retrievable by agents only when
  // KB is on; user-scoped strategies are NEVER indexed (private).
  const kbEnabled = true; // KB always-on (toggle removed)
  const [viewMode, setViewMode] = useViewMode('strategy', 'grid');
  // ADR 0235 §D3 — the parent-lens grouping: resolve each child's parent title
  // from the CURRENT (readable, filtered) list; a parent that isn't present
  // (archived / filtered / unreadable) yields no chip — the silent-ungroup
  // posture the backend guarantees.
  const parentTitleById = useMemo(() => {
    const byId = new Map(strategies.map((s) => [s.id, s.title]));
    return (s: Strategy): string | undefined => (s.parentStrategyId ? byId.get(s.parentStrategyId) : undefined);
  }, [strategies]);
  return (
    <div>
      <div className="filterbar u-mb-4" role="group" aria-label={t('filterGroup')}>
        {total > 3 ? (
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('filterPlaceholder')}
            aria-label={t('filterAria')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : null}
        {/* Facet selects self-describe via their "All …" option (the marketplace
            filterbar pattern) — an eyebrow label would break the one-row baseline. */}
        <select className="ui-input filterbar-select" value={fScope} onChange={(e) => setFScope(e.target.value)} aria-label={t('filterScope')}>
          <option value="">{t('filterAllScopes')}</option>
          {SCOPES.map((s) => <option key={s} value={s}>{t(`scope_${s}`)}</option>)}
        </select>
        <select className="ui-input filterbar-select" value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label={t('filterStatus')}>
          <option value="">{t('filterAllStatuses')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
        </select>
        <select className="ui-input filterbar-select" value={fHorizon} onChange={(e) => setFHorizon(e.target.value)} aria-label={t('filterHorizon')}>
          <option value="">{t('filterAllHorizons')}</option>
          {HORIZONS.map((h) => <option key={h} value={h}>{t(`horizon_${h}`)}</option>)}
        </select>
        <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
      </div>

      {strategies.length === 0 ? (
        <StateCard
          icon={<FlagIcon size={20} />}
          title={t('noMatchTitle')}
          body={t('noMatchBody')}
          action={<Button variant="secondary" onClick={() => { setQuery(''); setFScope(''); setFStatus(''); setFHorizon(''); }}>{t('clearSearch')}</Button>}
        />
      ) : viewMode === 'grid' ? (
        <div className="card-grid">
          {strategies.map((s) => (
            <StrategyCard key={s.id} s={s} health={health} kbEnabled={kbEnabled} {...(parentTitleById(s) ? { parentTitle: parentTitleById(s)! } : {})} />
          ))}
        </div>
      ) : (
        <div className="surface-card list-view">
          {strategies.map((s) => (
            <StrategyRow key={s.id} s={s} health={health} kbEnabled={kbEnabled} {...(parentTitleById(s) ? { parentTitle: parentTitleById(s)! } : {})} />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateStrategyForm({ orgs, orgsFailed, onCreated, onError }: { orgs: OrgRef[]; /** R2 STR2-B2 — the orgs READ failed, so an empty list is not "you have none". */ orgsFailed: boolean; onCreated: (s: Strategy) => void | Promise<void>; onError: (m: string) => void }): JSX.Element {
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

  /**
   * SPU-8 — this confirmation had three defects in one line, all in the FIRST
   * thing a new user sees in the create modal:
   *
   *  1. it interpolated `{{n}}`, not i18next's magic `count`, so NO plural
   *     resolution happened in any of the four locales — and `portfolio-bet` and
   *     `working-backwards` each scaffold exactly ONE objective, so picking
   *     either rendered "Pre-filled 1 objectives" (and worse in fr/es/pt-BR,
   *     where the noun and adjective both disagree);
   *  2. it never named WHICH template was applied, so switching between those two
   *     one-objective templates produced BYTE-IDENTICAL text — the DOM did not
   *     mutate and a live region only speaks on mutation, so a screen-reader user
   *     could not tell the switch took effect;
   *  3. re-picking the SAME template is still identical text, which is why the
   *     region is on `useLiveRegion()` — it alternates an invisible marker so a
   *     repeat is a distinct string and gets re-read.
   */
  const [tplAnnounce, setTplAnnounce] = useLiveRegion();
  const applyTemplate = (tpl: StrategyTemplate | null): void => {
    setTemplateId(tpl?.id ?? 'blank');
    // ADR 0598 §Correction 11 — "Blank" DISCARDS the scaffolded objectives and
    // initiatives, and it used to `setTplAnnounce('')`: the most destructive
    // choice in the picker was the only one that said nothing. SPU-8 fixed the
    // three defects in the APPLIED message and left the CLEAR arm at the empty
    // string, so the row read as closed while half the control was still silent.
    //
    // The copy names what actually happens and what does NOT. `summary` and
    // `horizon` are deliberately KEPT (a user who typed over the template's
    // summary must not lose it), so the message says so rather than implying a
    // full reset — an announcement that overstates is the same family of defect
    // as one that is absent.
    if (!tpl) { setScaffold({ objectives: [], initiatives: [] }); setTplAnnounce(t('templateCleared')); return; }
    const s = tpl.scaffold;
    setHorizon(s.horizon);
    setSummary(t(s.summaryKey));
    setScaffold({
      ...(s.rationaleKey ? { rationale: t(s.rationaleKey) } : {}),
      objectives: s.objectives.map((o) => ({ id: uid(), title: t(o.titleKey), keyResults: o.keyResults.map((k) => ({ id: uid(), title: t(k.titleKey) })) })),
      initiatives: s.initiatives.map((i) => ({ id: uid(), title: t(i.titleKey) })),
    });
    setTplAnnounce(t('templateApplied', { count: s.objectives.length, template: t(tpl.labelKey) }));
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
      // SPU-2 — the create flow NAVIGATES to the new strategy, so the modal simply
      // disappears. `<Toaster>` is at the app shell, so this survives the route
      // change and is the only thing that distinguishes "created" from "the modal
      // closed on me". It announces via `ui/toast.tsx:69`.
      toast.success(t('toastStrategyCreated'));
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
        <span className="muted u-fs-12" role="status" aria-live="polite" aria-atomic="true">{tplAnnounce}</span>
      </div>
      <SelectField label={t('fieldOrg')} required value={orgId} onChange={(e) => setOrgId(e.target.value)}>
        {/* R2 STR2-B2 — "No organizations available" is a claim about the workspace; a
            failed read only justifies "we could not load them". */}
        {orgs.length === 0 ? <option value="">{orgsFailed ? t('orgsUnavailable') : t('noOrgs')}</option> : null}
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
        <Button type="submit" variant="primary" size="sm" disabled={busy || !title.trim() || !orgId}>{busy ? t('common:saving') : t('common:create')}</Button>
      </div>
    </form>
  );
}
