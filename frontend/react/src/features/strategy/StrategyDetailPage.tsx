/**
 * Strategy detail page (ADR 0079 — see the routing correction note) —
 * `/strategy/:strategyId`. Every strategy has its own URL (deep-linkable,
 * shareable, back/forward-friendly); the editor tabs ride `?tab=` via
 * `useUrlTab`. Header = PageHeader with the strategy title + a
 * "Back to portfolio" ghost link — the DealDetailPage / ProjectDetailPage
 * pattern, replacing the old in-page Portfolio/<title> tablist.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Tabs, TabPanel, useUrlTab } from '../../ui/Tabs.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { TextField, TextareaField, SelectField } from '../../ui/Field.js';
import { FlagIcon, PlusIcon, TrashIcon, LinkIcon, CheckIcon, XIcon } from '../../ui/icons/index.js';
import {
  listStrategies, getStrategy, updateStrategy, archiveStrategy, deleteStrategy,
  replaceLinks, listProjects, getStrategyDetailContext, FeatureDisabledError,
  listStrategyCheckIns, createCheckIn, decideCheckIn, getStrategyTimeline, importObjectives, type TimelineItem,
  type Strategy, type StrategyScope, type PlanningHorizon, type StrategyStatus, type StrategyConfidence,
  type StrategyRisk, type StrategyObjective, type StrategyKeyResult, type StrategyInitiative, type StrategyLink,
  type ProjectRef, type StrategyHealthState, type StrategyContextEntry, type StrategyCheckIn,
} from './strategyClient.js';
import {
  SCOPES, HORIZONS, STATUSES, CONFIDENCES, RISKS, HEALTH_STATES, PROJECT_HEALTH_CHIP,
  uid, ScopeChip, StatusChip, type TFn,
} from './strategyShared.js';
import { UserPicker } from '../../orgs/UserPicker.js';
import { formatNumber, formatDate } from '../../i18n/format.js';
import { InfoTip } from '../../ui/InfoTip.js';
// SPU-4 — the canonical imperative confirm (`window.confirm` is banned).
import { confirm } from '../../ui/confirm.js';
// SPU-2 — every save in this feature was silent to sighted AND screen-reader users
// alike; `onChanged -> refresh()` remounts the editor with identical values, so the
// screen looked the same before and after. `toast.success` announces for free
// (`ui/toast.tsx:69`), which is why it is the primitive rather than a bare Notice.
import { toast } from '../../ui/toast.js';
// SPU-1 — the import result span was a live region MOUNTED WITH ITS TEXT, which
// announces nothing (DESIGN.md:367-375). The result is spoken imperatively instead.
import { announce } from '../../ui/announce.js';

/** ADR 0598 §Correction 5 — a shared empty set, so "no dirty sources" is one
 *  stable identity and clearing the registry cannot trigger a render. */
const EMPTY_DIRTY: ReadonlySet<string> = new Set<string>();

const TABS = ['overview', 'objectives', 'initiatives', 'alignment', 'timeline'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL_KEYS: Record<Tab, string> = {
  overview: 'detailOverview',
  objectives: 'detailObjectives',
  initiatives: 'detailInitiatives',
  alignment: 'detailAlignment',
  timeline: 'detailTimeline',
};

export function StrategyDetailPage(): JSX.Element {
  const { t } = useTranslation('strategy');
  const { strategyId = '' } = useParams<{ strategyId: string }>();
  const navigate = useNavigate();
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  // Parent-lens options for the Overview editor (ADR 0235 §D3) — fail-soft.
  const [allStrategies, setAllStrategies] = useState<Strategy[]>([]);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  // STR-G1/G2 — both of these used `catch(() => {})`, the most invisible form of
  // swallowing: state stays `[]`, and DOWNSTREAM that emptiness becomes a
  // positive claim — "no more projects", "no eligible parents" — when the read
  // simply failed.
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [strategiesFailed, setStrategiesFailed] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // R2 STR2-M5 — a save that DEACTIVATED the strategy has to say so. Editing a protected
  // field on an active strategy reverts it to draft (and it must be re-approved); the
  // marker existed only on the event and the audit, so on screen the status chip simply
  // changed and nothing explained it.
  const [autoReverted, setAutoReverted] = useState<string[] | null>(null);
  // ADR 0597 §Correction 4 residual, closed here: the backend withdraws a pending
  // activation review when a protected field is edited, and said so ONLY in the
  // response body. Both editors that can send a protected field report it.
  const [reviewClosed, setReviewClosed] = useState(false);
  const [tab, setTab] = useUrlTab<Tab>('tab', TABS, 'overview');
  /**
   * SPU-4 — every tab body is `{tab === 'x' ? <Editor …/> : null}` with no
   * keep-alive, so switching tabs UNMOUNTS the editor and destroys its draft.
   * On Objectives that is the measurement config (kind/baseline/target/unit/
   * direction/weight per key result) — a lot of typing, gone with no warning
   * and no way back. The feature already knows this class of harm: the blank-title
   * guard exists because a cleared title used to silently delete a row.
   *
   * ONE rule at ONE composition owner. Both ways off a mounted editor — the
   * tablist and "Back to portfolio" — go through `leaveGuard`, so they cannot
   * drift into two different rules (the mistake PR-A's §2 fixed one file away).
   * The editors report VALUE-equality dirtiness, not "was touched": typing an
   * edit and undoing it must not prompt.
   *
   * ADR 0598 §Correction 5 — ONE OWNER, but MORE THAN ONE SOURCE. SPU-4
   * enumerated the four TAB EDITORS and stopped there. The Objectives tab holds
   * THREE draft-bearing components — `ObjectivesEditor`, `ImportObjectivesBlock`
   * (a CSV textarea) and `CheckInsPanel` (a value + note per measured key
   * result) — and only the first reported, so the other two were destroyed by a
   * tab switch with no prompt. PROVEN by probe before this changed.
   *
   * A plain second `useState` per child would have recreated a clobber that the
   * single flag avoids only by ACCIDENT (there was exactly one reporter): each
   * child runs `useEffect(() => onDirty(dirty))`, so the last one to fire would
   * win and a clean import block would erase a dirty editor. The owner keeps a
   * SET of dirty SOURCES, which composes.
   *
   * `markDirty` returns the PREVIOUS Set when nothing changed. That identity is
   * load-bearing: the per-source callbacks are stable, but React bails out on
   * `Object.is`, and returning a fresh `new Set()` every time would re-render on
   * every effect run.
   */
  const [dirtySources, setDirtySources] = useState<ReadonlySet<string>>(EMPTY_DIRTY);
  const dirty = dirtySources.size > 0;
  const markDirty = useCallback((source: string, isDirty: boolean): void => {
    setDirtySources((prev) => {
      if (prev.has(source) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(source); else next.delete(source);
      return next;
    });
  }, []);
  // Stable per-source reporters, so a child's `useEffect([dirty, onDirty])` does
  // not re-run on every parent render.
  const onDirty = useMemo(() => ({
    overview: (d: boolean) => markDirty('overview', d),
    objectives: (d: boolean) => markDirty('objectives', d),
    initiatives: (d: boolean) => markDirty('initiatives', d),
    alignment: (d: boolean) => markDirty('alignment', d),
    import: (d: boolean) => markDirty('import', d),
    checkins: (d: boolean) => markDirty('checkins', d),
  }), [markDirty]);
  // On a CONFIRMED leave the whole registry is dropped: the outgoing tab's
  // components unmount without a cleanup that could report themselves clean, so
  // clearing per-source would strand entries and prompt forever.
  const clearDirty = useCallback((): void => setDirtySources(EMPTY_DIRTY), []);
  /**
   * SPU-11 — see the note beside the error Notice below.
   *
   * ADR 0598 §Correction 6 — the SECOND identical failure did nothing at all.
   * `setError` with an `Object.is`-equal string is a React bail-out, so neither
   * this focus effect (`[error]`) nor `Notice`'s own
   * `useEffect(…, [announce, assertive])` re-fired — the notice was already
   * mounted with an unchanged prop. Retrying a failing save and getting the same
   * message back was total silence and no focus movement, i.e. the §2 "the
   * button did nothing" defect arriving through the failure path.
   *
   * A MONOTONIC COMPANION rather than re-running the effect on every render:
   * focusing on every render would steal focus from a field being typed in while
   * an error is standing, which is a worse defect than the one being fixed.
   * `raiseError` is the single writer, so every `onError` site inherits it.
   *
   * The tick also KEYS the `<Notice>`. Its announce effect is prop-keyed and the
   * prop is by definition unchanged on a repeat, so remounting is what re-runs
   * it — and `announce()` alternates an invisible marker, so the repeat is a
   * distinct live-region value rather than a swallowed no-op. Dropping the
   * `announce` prop and calling `announce()` here instead would announce twice
   * or, if the prop were removed, re-open the very family §4 extended a gate to
   * catch.
   */
  const [errorTick, setErrorTick] = useState(0);
  const raiseError = useCallback((m: string): void => {
    setError(m);
    setErrorTick((n) => n + 1);
  }, []);
  const errorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error, errorTick]);
  const leaveGuard = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true;
    return confirm({ title: t('discardTitle'), body: t('discardBody'), confirmLabel: t('discardConfirm'), danger: true });
  }, [dirty, t]);
  const changeTab = (next: Tab): void => {
    if (next === tab) return;
    void (async () => { if (await leaveGuard()) { clearDirty(); setTab(next); } })();
  };
  const leaveToPortfolio = (e: React.MouseEvent): void => {
    if (!dirty) return; // let the <Link> do its normal job (⌘-click, middle-click)
    e.preventDefault();
    void (async () => { if (await leaveGuard()) { clearDirty(); navigate('/strategy'); } })();
  };

  const refresh = useCallback(async () => {
    // SPU-3 / SPC-13 — see the note on `StrategyPage.refresh`. `refresh` is also
    // every editor's `onChanged`, so clearing here is what makes a SUCCESSFUL save
    // drop the previous failure ("2 item(s) have an empty title") instead of
    // leaving it standing over saved content.
    //
    // `autoReverted` is deliberately NOT cleared here. It is set by the SAVE that
    // caused the revert, immediately BEFORE `onChanged()`; clearing it on refresh
    // would destroy the R2 STR2-M5 disclosure at the moment it is raised — the fix
    // reintroducing the family it closes. It is cleared by the next save instead
    // (`ObjectivesEditor`, which is the only writer).
    try { setStrategy(await getStrategy(strategyId)); setDisabled(false); setLoadError(null); setError(null); }
    catch (e) {
      if (e instanceof FeatureDisabledError) { setDisabled(true); return; }
      setLoadError(e instanceof Error ? e.message : t('strategyLoadFailed'));
    }
  }, [strategyId, t]);

  useEffect(() => {
    void refresh();
    void listStrategies({ includeArchived: true })
      .then((x) => { setAllStrategies(x); setStrategiesFailed(false); })
      .catch(() => setStrategiesFailed(true));
    void listProjects()
      .then((x) => { setProjects(x); setProjectsFailed(false); })
      .catch(() => setProjectsFailed(true));
  }, [refresh]);

  if (disabled) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<FlagIcon size={22} />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </div>
    );
  }
  if (loadError) {
    return (
      <div>
        <PageHeader
          eyebrow={t('detailEyebrow')}
          title={t('title')}
          actions={<Link to="/strategy" className="btn-ghost">{t('backToPortfolio')}</Link>}
        />
        {/* SPU-5 — the WHOLE-PAGE load failure, and it was the one failure in the
            feature with no `announce`, while five siblings had it. A screen-reader
            user deep-linking here is otherwise left on a page whose only content
            is an unannounced error, i.e. silence, which reads as "nothing to
            report". `role="alert"` is NOT a substitute: `ui/Notice.tsx:19-22`
            states in as many words that its announce-on-insertion behaviour is
            unverified here and must not be assumed. */}
        <Notice variant="error" announce={loadError}>{loadError}</Notice>
      </div>
    );
  }
  if (!strategy) {
    return (
      <div>
        <PageHeader eyebrow={t('detailEyebrow')} title={t('loadingStrategy')} />
        <StateCard icon={<FlagIcon size={20} />} title={t('loadingStrategy')} loading />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow={t('detailEyebrow')}
        title={strategy.title}
        actions={<Link to="/strategy" className="btn-ghost" onClick={leaveToPortfolio}>{t('backToPortfolio')}</Link>}
      />
      {/* SPU-11 — every error in this feature renders HERE, immediately under the
          PageHeader, while every Save button is at the BOTTOM of an editor that is
          several viewports tall on a realistic ten-objective annual plan. So a
          blocked save and a successful save looked exactly the same from where the
          user was standing: the button flickered "Saving…" and the explanation
          rendered off-screen above. Moving FOCUS (rather than only scrolling) is
          what also serves a keyboard user, and it lands them on the thing they now
          have to read. `preventScroll:false` is deliberate — the scroll IS the fix
          for the sighted case. */}
      {error ? (
        <div ref={errorRef} tabIndex={-1}>
          {/* ADR 0598 §Correction 6 — `key={errorTick}` REMOUNTS the notice on a
              repeat, which is the only thing that re-runs its prop-keyed announce
              effect when the message is unchanged. The focus HOLDER stays mounted,
              so the ref (and the focus above) is unaffected. */}
          <Notice key={errorTick} variant="error" announce={error}>{error}</Notice>
        </div>
      ) : null}
      {/* ADR 0598 §Correction 4 — ONE polite message per save, and the two
          disclosures CAN co-occur. `ui/announce.tsx:99-105` keeps a single
          module-level `politeMsg`, so two announcing notices for one save means
          the second overwrites the first and the user hears whichever landed
          last. §2 wrote the "one message per save" rule against
          `autoRevertedToDraft`; `activationReviewClosed` arrived one commit
          later (§8) and inherited none of it.

          REACHABLE, not theoretical: backend `routes.ts` computes both from
          `touchesProtected`, and `STATUS_GATE_POSTURE.paused` is
          `{approved: true, terminal: false}` — so pause → submit for activation
          (the flip is withheld and queued, status stays `paused`) → edit
          objectives returns BOTH flags on one response.

          The cure is a COMBINED disclosure, not dropping an `announce`: the
          withdrawal notice going silent would recreate exactly the §8 defect
          and redden the gate §4 extended. */}
      {autoReverted && reviewClosed ? (
        <Notice variant="warning" announce={t('autoRevertedAndWithdrawnNotice', { fields: autoReverted.join(', ') })}>
          {t('autoRevertedAndWithdrawnNotice', { fields: autoReverted.join(', ') })}
        </Notice>
      ) : (
        <>
          {autoReverted ? (
            <Notice variant="warning" announce={t('autoRevertedNotice', { fields: autoReverted.join(', ') })}>
              {t('autoRevertedNotice', { fields: autoReverted.join(', ') })}
            </Notice>
          ) : null}
          {reviewClosed ? (
            <Notice variant="warning" announce={t('activationWithdrawnNotice')}>{t('activationWithdrawnNotice')}</Notice>
          ) : null}
        </>
      )}

      <div className="u-flex u-gap-2 u-flex-wrap u-items-center u-mb-4">
        <ScopeChip scope={strategy.scope} t={t} />
        <StatusChip status={strategy.status} t={t} />
        {strategy.activationPending ? <span className="chip chip--warning" title={t('activationPendingTitle')}>{t('activationPending')}</span> : null}
        <span className="chip chip--muted">{t(`horizon_${strategy.planningHorizon}`)}</span>
      </div>

      <Tabs
        items={TABS.map((id) => ({ id, label: t(TAB_LABEL_KEYS[id]) }))}
        value={tab}
        onChange={changeTab}
        label={t('detailTablistLabel')}
        idBase="strategy"
        className="u-mb-4"
      />

      <TabPanel idBase="strategy" tabId={tab}>
        <div className="surface-card">
          {tab === 'overview' ? (
            <OverviewEditor
              key={strategy.updatedAt}
              strategy={strategy}
              allStrategies={allStrategies}
              strategiesFailed={strategiesFailed}
              onChanged={refresh}
              onClosed={() => navigate('/strategy')}
              onError={raiseError}
              onDirty={onDirty.overview}
              onReviewClosed={setReviewClosed}
              t={t}
            />
          ) : null}
          {tab === 'objectives' ? (
            <div className="u-flex u-flex-col u-gap-4">
              <ObjectivesEditor key={strategy.updatedAt} strategy={strategy} onChanged={refresh} onError={raiseError} onAutoReverted={setAutoReverted} onDirty={onDirty.objectives} onReviewClosed={setReviewClosed} t={t} />
              <ImportObjectivesBlock strategy={strategy} onChanged={refresh} onError={raiseError} onDirty={onDirty.import} t={t} />
              <CheckInsPanel strategy={strategy} onError={raiseError} onDirty={onDirty.checkins} t={t} />
            </div>
          ) : null}
          {tab === 'initiatives' ? <InitiativesEditor key={strategy.updatedAt} strategy={strategy} onChanged={refresh} onError={raiseError} onDirty={onDirty.initiatives} t={t} /> : null}
          {tab === 'alignment' ? <AlignmentEditor key={strategy.updatedAt} strategy={strategy} projects={projects} projectsFailed={projectsFailed} onChanged={refresh} onError={raiseError} onDirty={onDirty.alignment} t={t} /> : null}
          {tab === 'timeline' ? <TimelineView strategy={strategy} t={t} /> : null}
        </div>
      </TabPanel>
    </div>
  );
}

/**
 * ADR 0234 §C6 — a read-only timeline: initiatives + linked project milestones
 * + linked idea schedules, grouped by month, with slip chips computed
 * server-side. One fetch; deliberately NOT a Gantt.
 */
function TimelineView({ strategy, t }: { strategy: Strategy; t: TFn }): JSX.Element {
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  // SPU-5 — this was the ONLY failure in the feature with no Retry; every other
  // one offers it, so a user whose timeline read 429s had to reload the page.
  const [loadTick, setLoadTick] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(false);
    getStrategyTimeline(strategy.id)
      .then((r) => { if (live) { setItems(r); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [strategy.id, strategy.updatedAt, loadTick]);

  if (failed) {
    return (
      <Notice variant="error" announce={t('timelineLoadFailed')}>
        {t('timelineLoadFailed')}{' '}
        <Button variant="link" onClick={() => { setItems(null); setLoadTick((v) => v + 1); }}>{t('common:retry')}</Button>
      </Notice>
    );
  }
  if (items === null) return <p className="muted u-fs-12">{t('common:loading')}</p>;
  if (items.length === 0) return <StateCard icon={<FlagIcon />} title={t('timelineEmpty')} body={t('timelineEmptyBody')} />;

  const groups = new Map<string, TimelineItem[]>();
  for (const it of items) {
    const key = (it.dueDate ?? it.startDate ?? '').slice(0, 7) || t('timelineUndated');
    const g = groups.get(key) ?? [];
    g.push(it);
    groups.set(key, g);
  }
  return (
    <div className="u-flex u-flex-col u-gap-3">
      <p className="muted u-fs-13 u-m-0">{t('timelineLede')}</p>
      {[...groups.entries()].map(([month, rows]) => (
        <section key={month} aria-label={month} className="u-flex u-flex-col u-gap-2">
          <h3 className="u-m-0 u-fs-12 muted">{/^\d{4}-\d{2}$/.test(month) ? formatDate(`${month}-01`, { year: 'numeric', month: 'long' }) : month}</h3>
          {rows.map((it) => (
            <div key={`${it.kind}-${it.id}`} className="surface-card u-flex u-flex-row u-items-center u-gap-2 u-py-2 u-flex-wrap">
              <span className="chip chip--muted u-fs-11">{t(`timelineKind_${it.kind}`)}</span>
              <span className="u-flex-1 u-fs-13">{it.title}</span>
              {it.dueDate ? <span className="muted u-fs-12">{formatDate(it.dueDate)}</span> : null}
              {it.done ? <span className="chip chip--success u-fs-11">{t('timelineDone')}</span> : null}
              {it.overdue ? <span className="chip chip--danger u-fs-11">{t('timelineOverdue')}</span> : null}
              {it.dependencyLate?.length ? <span className="chip chip--warning u-fs-11">{t('timelineDepLate')} <InfoTip label={t('timelineDepLateInfo')} text={t('timelineDepLateTitle')} /></span> : null}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function OverviewEditor({ strategy, allStrategies, strategiesFailed, onChanged, onClosed, onError, onDirty, onReviewClosed, t }: { strategy: Strategy; allStrategies: Strategy[]; strategiesFailed: boolean; onChanged: () => void | Promise<void>; onClosed: () => void | Promise<void>; onError: (m: string) => void; /** SPU-4 — report VALUE-equality dirtiness so the page can guard the exits. */ onDirty: (d: boolean) => void; /** ADR 0597 §Correction 4 — this save can WITHDRAW a pending activation review. */ onReviewClosed: (v: boolean) => void; t: TFn }): JSX.Element {
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
  // ADR 0235 §D3 — the one-level parent lens: eligible parents are same-org
  // strategies that are not themselves children (and not this one).
  const [parentId, setParentId] = useState(strategy.parentStrategyId ?? '');
  const eligibleParents = allStrategies.filter((p) => p.id !== strategy.id && p.orgId === strategy.orgId && !p.parentStrategyId);
  const [busy, setBusy] = useState(false);
  // Which destructive action is awaiting confirmation (replaces window.confirm).
  const [confirmAction, setConfirmAction] = useState<null | 'archive' | 'delete'>(null);

  // SPU-4 — every field here is a SCALAR, so an exact comparison is possible and
  // a "was touched" flag would be strictly worse: it would prompt after a typo the
  // user already undid. Falsely clean is the direction that costs data; falsely
  // dirty is the direction that costs a click. This is neither.
  const dirty = title !== strategy.title
    || summary !== (strategy.summary ?? '')
    || rationale !== (strategy.rationale ?? '')
    || scope !== strategy.scope
    || horizon !== strategy.planningHorizon
    || status !== strategy.status
    || confidence !== (strategy.confidence ?? '')
    || risk !== (strategy.risk ?? '')
    || healthOverride !== (strategy.healthOverride ?? '')
    || owner !== (strategy.ownerUserId ?? '')
    || exec !== (strategy.accountableExecutive ?? '')
    || parentId !== (strategy.parentStrategyId ?? '');
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await updateStrategy(strategy.id, {
        title: title.trim(), summary, rationale, scope, planningHorizon: horizon, status,
        confidence: (confidence as StrategyConfidence) || null,
        risk: (risk as StrategyRisk) || null,
        healthOverride: (healthOverride as StrategyHealthState) || null,
        ownerUserId: owner, accountableExecutive: exec,
        parentStrategyId: parentId || null,
      });
      onReviewClosed(res.activationReviewClosed === true);
      // ADR 0598 §Correction 4 — the SAME "one message per save" rule §2 wrote
      // for the objectives editor. "Saved — but … that review was withdrawn"
      // already reports the save; a plain "Strategy saved" behind it in the
      // polite queue describes strictly less and displaces the part the user
      // has to act on. This save path had NO suppression at all.
      if (res.activationReviewClosed !== true) toast.success(t('toastStrategySaved'));
      await onChanged();
    } catch (e) { onError(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  };

  const archive = async (): Promise<void> => {
    setBusy(true);
    try { await archiveStrategy(strategy.id); toast.success(t('toastArchived')); await onClosed(); }
    catch (e) { onError(e instanceof Error ? e.message : t('saveFailed')); setConfirmAction(null); }
    finally { setBusy(false); }
  };
  const hardDelete = async (): Promise<void> => {
    setBusy(true);
    // Archive and delete NAVIGATE AWAY, so the row simply vanishes from the
    // portfolio. The toast is what says which of "it worked" and "it silently
    // failed" happened — <Toaster> lives at the shell, so it survives the route
    // change that this editor does not.
    try { await deleteStrategy(strategy.id); toast.success(t('toastDeleted')); await onClosed(); }
    catch (e) { onError(e instanceof Error ? e.message : t('saveFailed')); setConfirmAction(null); }
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
        {/* STR-G2 — an empty parent list reads as "there are no eligible
            parents"; a failed strategies read must not make that claim. */}
        <SelectField
          label={t('fieldParent')}
          help={strategiesFailed ? t('strategiesLoadFailed') : t('fieldParentHelp')}
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
        >
          <option value="">{t('parentNone')}</option>
          {eligibleParents.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </SelectField>
        <SelectField label={t('fieldHealth')} help={t('fieldHealthHelp')} value={healthOverride} onChange={(e) => setHealthOverride(e.target.value)}>
          <option value="">{t('healthAuto')}</option>
          {HEALTH_STATES.map((h) => <option key={h} value={h}>{t(`health_${h}`)}</option>)}
        </SelectField>
      </div>
      <div className="u-flex u-gap-3 u-flex-wrap">
        <UserPicker label={t('fieldOwner')} value={owner} onChange={setOwner} orgId={strategy.orgId} />
        <TextField label={t('fieldExec')} value={exec} onChange={(e) => setExec(e.target.value)} />
      </div>
      <div className="action-bar u-justify-between">
        <Button variant="primary" size="sm" disabled={busy || !title.trim()} onClick={() => void save()}><CheckIcon size={13} /> {busy ? t('common:saving') : t('common:save')}</Button>
        <div className="action-bar u-gap-2">
          {/* Shared/org strategies can be archived (reversible: hidden from the
              active portfolio). Hard-delete is offered for every strategy — the
              backend gates it to the creator or an org admin (requireConfig
              authority); an unauthorized caller gets a 403 surfaced as a notice. */}
          {strategy.scope !== 'user' ? (
            <Button variant="quiet" size="sm" disabled={busy || strategy.status === 'archived'} onClick={() => setConfirmAction('archive')}>{t('archive')}</Button>
          ) : null}
          <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirmAction('delete')}><TrashIcon size={13} /> {t('common:delete')}</Button>
        </div>
      </div>

      {confirmAction ? (
        <ConfirmDialog
          title={t(confirmAction === 'delete' ? 'confirmDeleteTitle' : 'confirmArchiveTitle', { title: strategy.title })}
          body={t(confirmAction === 'delete' ? 'confirmDelete' : 'confirmArchive')}
          confirmLabel={confirmAction === 'delete' ? t('common:delete') : t('archive')}
          confirmIcon={confirmAction === 'delete' ? <TrashIcon size={14} /> : undefined}
          danger={confirmAction === 'delete'}
          busy={busy}
          onConfirm={() => void (confirmAction === 'delete' ? hardDelete() : archive())}
          onCancel={() => setConfirmAction(null)}
        />
      ) : null}
    </div>
  );
}

function ObjectivesEditor({ strategy, onChanged, onError, onAutoReverted, onDirty, onReviewClosed, t }: { strategy: Strategy; onChanged: () => void | Promise<void>; onError: (m: string) => void; /** R2 STR2-M5 — this save can DEACTIVATE the strategy; the page has to say so.
   *  SPU-3 — `null` CLEARS it: a later save that does not revert must not leave the
   *  previous "returned to Draft" warning standing, and `refresh()` cannot clear it
   *  (it runs immediately after this callback sets it). */ onAutoReverted: (fields: string[] | null) => void; /** SPU-4 — see `OverviewEditor`. */ onDirty: (d: boolean) => void; /** ADR 0597 §Correction 4 — see `OverviewEditor`. */ onReviewClosed: (v: boolean) => void; t: TFn }): JSX.Element {
  const [objectives, setObjectives] = useState<StrategyObjective[]>(() => structuredClone(strategy.objectives));
  const [busy, setBusy] = useState(false);

  const addObjective = (): void => setObjectives((p) => [...p, { id: uid(), title: '', keyResults: [] }]);
  const removeObjective = (oid: string): void => setObjectives((p) => p.filter((o) => o.id !== oid));
  const setObjTitle = (oid: string, title: string): void => setObjectives((p) => p.map((o) => (o.id === oid ? { ...o, title } : o)));
  const addKR = (oid: string): void => setObjectives((p) => p.map((o) => (o.id === oid ? { ...o, keyResults: [...o.keyResults, { id: uid(), title: '' }] } : o)));
  const removeKR = (oid: string, kid: string): void => setObjectives((p) => p.map((o) => (o.id === oid ? { ...o, keyResults: o.keyResults.filter((k) => k.id !== kid) } : o)));
  const setKR = (oid: string, kid: string, field: 'title' | 'target' | 'current', value: string): void =>
    setObjectives((p) => p.map((o) => (o.id === oid ? { ...o, keyResults: o.keyResults.map((k) => (k.id === kid ? { ...k, [field]: value } : k)) } : o)));

  // STRATUX-3 (grade-ux): the typed-measure editor (ADR 0231's measure block was
  // API/import-only). Numeric fields draft as STRINGS and parse at save so
  // intermediate typing ("1.") never fights the input.
  interface MeasureDraft { kind: string; baseline: string; target: string; unit: string; direction: string; weight: string }
  const draftOf = (k: StrategyKeyResult): MeasureDraft => ({
    kind: k.measure?.kind ?? '',
    baseline: k.measure?.baseline !== undefined ? String(k.measure.baseline) : '',
    target: k.measure?.target !== undefined ? String(k.measure.target) : '',
    unit: k.measure?.unit ?? '',
    direction: k.measure?.direction ?? 'increase',
    weight: k.weight !== undefined ? String(k.weight) : '',
  });
  const buildDrafts = (objs: StrategyObjective[]): Record<string, MeasureDraft> => {
    const out: Record<string, MeasureDraft> = {};
    for (const o of objs) for (const k of o.keyResults) out[k.id] = draftOf(k);
    return out;
  };
  const [measureDrafts, setMeasureDrafts] = useState<Record<string, MeasureDraft>>(() => buildDrafts(strategy.objectives));
  // SPU-4 — the objectives tree AND the measurement drafts, because the drafts are
  // where most of the typing goes and they live in a SEPARATE state atom: comparing
  // only `objectives` would report a fully-configured measurement block as clean and
  // discard it silently, which is the defect wearing a guard.
  //
  // Both sides are produced by the same code paths (`structuredClone`, `draftOf`,
  // and spreads that preserve key order), so `JSON.stringify` is a stable identity
  // here — the baseline is captured ONCE at mount, never recomputed against a moving
  // prop.
  const [dirtyBaseline] = useState(() => JSON.stringify([strategy.objectives, buildDrafts(strategy.objectives)]));
  const dirty = JSON.stringify([objectives, measureDrafts]) !== dirtyBaseline;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const measureDraft = (k: StrategyKeyResult): MeasureDraft => measureDrafts[k.id] ?? draftOf(k);
  const setMeasure = (kid: string, field: keyof MeasureDraft, value: string): void =>
    setMeasureDrafts((p) => ({ ...p, [kid]: { ...(p[kid] ?? { kind: '', baseline: '', target: '', unit: '', direction: 'increase', weight: '' }), [field]: value } }));

  const num = (v: string): number | undefined => {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) ? n : undefined;
  };
  const applyMeasure = (k: StrategyKeyResult): StrategyKeyResult => {
    const d = measureDrafts[k.id];
    if (!d) return k;
    const weight = num(d.weight);
    const baseline = num(d.baseline);
    const target = num(d.target);
    const { measure: _m, weight: _w, ...rest } = k;
    return {
      ...rest,
      ...(d.kind ? {
        measure: {
          kind: d.kind as NonNullable<StrategyKeyResult['measure']>['kind'],
          ...(baseline !== undefined ? { baseline } : {}),
          ...(target !== undefined ? { target } : {}),
          ...(d.unit.trim() ? { unit: d.unit.trim() } : {}),
          ...(d.direction === 'decrease' ? { direction: 'decrease' as const } : {}),
          ...(k.measure?.source ? { source: k.measure.source } : {}),
        },
      } : {}),
      ...(weight !== undefined ? { weight } : {}),
    };
  };

  const save = async (): Promise<void> => {
    // R3 (the R2 deferral) — the save used to FILTER OUT any objective or KR whose
    // title was cleared: a blank field silently deleted the row on a 200. Deletion
    // has its own button; a blank title blocks the save and says why.
    const blanks = objectives.filter((o) => !o.title.trim()).length
      + objectives.reduce((a, o) => a + o.keyResults.filter((k) => !k.title.trim()).length, 0);
    if (blanks > 0) { onError(t('blankTitlesBlockSave', { count: blanks })); return; }
    setBusy(true);
    try {
      const res = await updateStrategy(strategy.id, { objectives: objectives.map((o) => ({ ...o, keyResults: o.keyResults.map(applyMeasure) })) });
      onAutoReverted(res.autoRevertedToDraft ? (res.autoRevertedFields ?? ['objectives']) : null);
      onReviewClosed(res.activationReviewClosed === true);
      // Only ONE message per save. When the save auto-reverted, `autoRevertedNotice`
      // ("Saved — but …") is both the confirmation and the disclosure, and it
      // announces; adding a plain "Objectives saved" would put two strings in the
      // polite queue, where the second describes less than the first.
      //
      // ADR 0598 §Correction 4 — the rule was enforced against ONE of the two
      // flags that raise an announcing disclosure. `activationReviewClosed`
      // landed a commit later (§8) and this term was never extended, so a
      // withdrawal save spoke twice.
      if (!res.autoRevertedToDraft && res.activationReviewClosed !== true) toast.success(t('toastObjectivesSaved'));
      await onChanged();
    }
    catch (e) { onError(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  };

  return (
    <div className="u-flex u-flex-col u-gap-3">
      {objectives.length === 0 ? <StateCard icon={<FlagIcon />} title={t('noObjectives')} /> : null}
      {objectives.map((o, oi) => (
        /* SPU-10 — the container was a bare `<div className="surface-card">` with
           NO accessible name, and each key-result group inside was labelled
           "Key result {n}" with `n` restarting at 1 for every objective. A screen
           -reader user editing a four-objective strategy heard
           "Key result 1, Key result 2, Key result 1, Key result 2, Key result 1…"
           with nothing in the accessible tree tying a group to its owner —
           and editing the wrong one is hard to recover from, because there is no
           undo. Naming the objective group AND qualifying the KR label fixes both
           halves; either alone still leaves the repeated numbering ambiguous when
           focus jumps straight into a field. */
        <div key={o.id} className="surface-card" role="group" aria-label={t('objectiveGroupLabel', { n: oi + 1, title: o.title.trim() || t('objectiveUntitled') })}>
          <div className="surface-form">
            <TextField label={t('objectiveTitle')} value={o.title} onChange={(e) => setObjTitle(o.id, e.target.value)} className="u-flex-1" />
            <Button variant="quiet" size="sm" aria-label={t('removeObjective')} onClick={() => removeObjective(o.id)}><TrashIcon size={13} /></Button>
          </div>
          <div className="u-flex u-flex-col u-gap-2 u-mt-2 u-ml-2">
            {o.keyResults.map((k, ki) => (
              <div key={k.id} className="surface-form" role="group" aria-label={t('krGroupLabel', { n: ki + 1, objective: o.title.trim() || t('objectiveUntitled') })}>
                <TextField label={t('krTitle')} value={k.title} onChange={(e) => setKR(o.id, k.id, 'title', e.target.value)} className="u-flex-2" />
                <TextField label={t('krTarget')} value={k.target ?? ''} onChange={(e) => setKR(o.id, k.id, 'target', e.target.value)} className="u-flex-1" />
                <TextField label={t('krCurrent')} value={k.current ?? ''} onChange={(e) => setKR(o.id, k.id, 'current', e.target.value)} className="u-flex-1" />
                <SelectField label={t('krMeasureKind')} value={measureDraft(k).kind} onChange={(e) => setMeasure(k.id, 'kind', e.target.value)}>
                  <option value="">{t('krMeasureNone')}</option>
                  {(['numeric', 'percent', 'currency', 'boolean'] as const).map((m) => <option key={m} value={m}>{t(`measureKind_${m}`)}</option>)}
                </SelectField>
                {measureDraft(k).kind && measureDraft(k).kind !== 'boolean' ? (
                  <>
                    <TextField label={t('krBaseline')} value={measureDraft(k).baseline} onChange={(e) => setMeasure(k.id, 'baseline', e.target.value)} inputMode="decimal" />
                    <TextField label={t('krMeasureTarget')} value={measureDraft(k).target} onChange={(e) => setMeasure(k.id, 'target', e.target.value)} inputMode="decimal" />
                    <TextField label={t('krUnit')} value={measureDraft(k).unit} onChange={(e) => setMeasure(k.id, 'unit', e.target.value)} />
                    <SelectField label={t('krDirection')} value={measureDraft(k).direction} onChange={(e) => setMeasure(k.id, 'direction', e.target.value)}>
                      <option value="increase">{t('direction_increase')}</option>
                      <option value="decrease">{t('direction_decrease')}</option>
                    </SelectField>
                  </>
                ) : null}
                {measureDraft(k).kind ? (
                  <TextField label={t('krWeight')} value={measureDraft(k).weight} onChange={(e) => setMeasure(k.id, 'weight', e.target.value)} inputMode="numeric" />
                ) : null}
                <Button variant="quiet" size="sm" aria-label={t('removeKr')} onClick={() => removeKR(o.id, k.id)}><XIcon size={13} /></Button>
              </div>
            ))}
            <div><Button variant="quiet" size="sm" onClick={() => addKR(o.id)}><PlusIcon size={12} /> {t('addKr')}</Button></div>
          </div>
        </div>
      ))}
      <div className="action-bar u-justify-between">
        <Button variant="quiet" size="sm" onClick={addObjective}><PlusIcon size={13} /> {t('addObjective')}</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>{busy ? t('common:saving') : t('common:save')}</Button>
      </div>
    </div>
  );
}

function InitiativesEditor({ strategy, onChanged, onError, onDirty, t }: { strategy: Strategy; onChanged: () => void | Promise<void>; onError: (m: string) => void; /** SPU-4 — see `OverviewEditor`. */ onDirty: (d: boolean) => void; t: TFn }): JSX.Element {
  const [initiatives, setInitiatives] = useState<StrategyInitiative[]>(() => structuredClone(strategy.initiatives));
  const [busy, setBusy] = useState(false);
  const [dirtyBaseline] = useState(() => JSON.stringify(strategy.initiatives));
  const dirty = JSON.stringify(initiatives) !== dirtyBaseline;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const add = (): void => setInitiatives((p) => [...p, { id: uid(), title: '' }]);
  const remove = (id: string): void => setInitiatives((p) => p.filter((i) => i.id !== id));
  const setField = (id: string, field: 'title' | 'ownerUserId', value: string): void => setInitiatives((p) => p.map((i) => (i.id === id ? { ...i, [field]: value } : i)));

  const save = async (): Promise<void> => {
    // R3 — same class as the objectives save: a blank title silently deleted the
    // initiative. Block and say why; removal has its own button.
    const blanks = initiatives.filter((i) => !i.title.trim()).length;
    if (blanks > 0) { onError(t('blankTitlesBlockSave', { count: blanks })); return; }
    setBusy(true);
    try { await updateStrategy(strategy.id, { initiatives }); toast.success(t('toastInitiativesSaved')); await onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  };

  return (
    <div className="u-flex u-flex-col u-gap-3">
      {initiatives.length === 0 ? <StateCard icon={<FlagIcon />} title={t('noInitiatives')} /> : null}
      {initiatives.map((i) => (
        <div key={i.id} className="surface-form">
          <TextField label={t('initiativeTitle')} value={i.title} onChange={(e) => setField(i.id, 'title', e.target.value)} className="u-flex-2" />
          <UserPicker label={t('initiativeOwner')} value={i.ownerUserId ?? ''} onChange={(v) => setField(i.id, 'ownerUserId', v)} orgId={strategy.orgId} className="u-flex-1" />
          <Button variant="quiet" size="sm" aria-label={t('removeInitiative')} onClick={() => remove(i.id)}><TrashIcon size={13} /></Button>
        </div>
      ))}
      <div className="action-bar u-justify-between">
        <Button variant="quiet" size="sm" onClick={add}><PlusIcon size={13} /> {t('addInitiative')}</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>{busy ? t('common:saving') : t('common:save')}</Button>
      </div>
    </div>
  );
}

/**
 * ADR 0235 §D3 — CSV objective import (`objective,keyResult,target,unit`).
 * Server-side parse + caps; the response reports imported/skipped honestly.
 */
function ImportObjectivesBlock({ strategy, onChanged, onError, onDirty, t }: { strategy: Strategy; onChanged: () => void | Promise<void>; onError: (m: string) => void; /** ADR 0598 §Correction 5 — this block holds a DRAFT (the pasted CSV) on a
   *  guarded tab and reported nothing, so a tab switch destroyed it silently.
   *  SPU-4's enumeration walked the four tab editors and stopped. */ onDirty: (d: boolean) => void; t: TFn }): JSX.Element {
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // R2 review — the tracker claimed the over-cap rows are "named per row in `skipped`, the
  // field the panel already renders". The panel rendered the COUNT ("1 rows imported, 2
  // skipped") and never the line/reason pairs, so HV-STR2-4 as written could not pass.
  const [skipped, setSkipped] = useState<Array<{ line: number; reason: string }>>([]);
  // VALUE equality, same rule as the editors: pasting and then clearing the box
  // must not prompt. `run()` clears `csv` on success, so a completed import is
  // clean again without a second signal.
  useEffect(() => { onDirty(csv.trim() !== ''); }, [csv, onDirty]);
  const run = async (): Promise<void> => {
    if (!csv.trim()) return;
    setBusy(true);
    try {
      const r = await importObjectives(strategy.id, csv);
      const summary = t('importResult', { imported: formatNumber(r.imported), skipped: formatNumber(r.skipped.length) });
      setResult(summary);
      setSkipped(r.skipped);
      setCsv('');
      // SPU-1 — the visible `<span role="status">` below used to be the ONLY
      // channel, and it is mounted together with its text, which announces
      // nothing (DESIGN.md:367-375). Three failures, not one: a clean import was
      // silent; when rows WERE skipped the announced string was the count summary
      // and never the per-row REASONS (the part the user has to act on); and a
      // repeat import with identical counts left the `Notice`'s `announce` prop
      // unchanged, so its effect never re-fired.
      //
      // `announce()` is imperative into the always-mounted `GlobalLiveRegion` —
      // it fires per ACTION rather than per render, carries the reasons, and
      // alternates an invisible marker so an identical repeat still speaks.
      announce(r.skipped.length > 0
        ? [summary, ...r.skipped.map((sk) => t('importSkippedRow', { line: sk.line, reason: sk.reason }))].join(' ')
        : summary);
      await onChanged();
    } catch (e) { onError(e instanceof Error ? e.message : t('importFailed')); }
    finally { setBusy(false); }
  };
  return (
    <section className="u-flex u-flex-col u-gap-2" aria-label={t('importTitle')}>
      <div>
        <h3 className="u-m-0 u-fs-13">{t('importTitle')}</h3>
        <p className="muted u-fs-12 u-m-0">{t('importLede')}</p>
      </div>
      <TextareaField label={t('importCsvLabel')} value={csv} onChange={(e) => setCsv(e.target.value)} rows={4} placeholder={'objective,keyResult,target,unit'} />
      <div className="u-flex u-items-center u-gap-2">
        <Button variant="primary" size="sm" disabled={busy || !csv.trim()} onClick={() => void run()}>{busy ? t('common:saving') : t('importAction')}</Button>
        {/* NO live role. The region was mounted with its text, so it announced
            nothing while looking correct in the DOM and passing an attribute-level
            test; `run()` above speaks the result (and the reasons) instead. Adding
            a role here as well would be the DS-8 double region. */}
        {result ? <span className="muted u-fs-12">{result}</span> : null}
      </div>
      {skipped.length > 0 ? (
        /* `announce` deliberately dropped: `run()` speaks the summary AND every
           skip reason in one string. Passing it here too would announce the counts
           a second time and still never speak the reasons. */
        <Notice variant="warning">
          <ul className="u-m-0">
            {skipped.map((sk) => <li key={`${sk.line}-${sk.reason}`}>{t('importSkippedRow', { line: sk.line, reason: sk.reason })}</li>)}
          </ul>
        </Notice>
      ) : null}
    </section>
  );
}

/**
 * ADR 0231 §C1/§P5 — the measurement trail under the objectives editor: per
 * measured KR, the latest confirmed value vs target, an inline human check-in
 * (⇒ confirmed), and agent-PROPOSED rows with one-click confirm/dismiss. One
 * list fetch per open (never per-KR reads — the rate-limit gotcha).
 */
function CheckInsPanel({ strategy, onError, onDirty, t }: { strategy: Strategy; onError: (m: string) => void; /** ADR 0598 §Correction 5 — the per-key-result value + note are a DRAFT on a
   *  guarded tab; this panel reported nothing, so a tab switch destroyed them. */ onDirty: (d: boolean) => void; t: TFn }): JSX.Element | null {
  const [rows, setRows] = useState<StrategyCheckIn[] | null>(null);
  const [draft, setDraft] = useState<Record<string, { value: string; note: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const [failed, setFailed] = useState(false);
  const refresh = useCallback(async () => {
    // R2 STR2-B3 — this comment said "the panel renders its empty state" and the panel
    // does no such thing: `rows` stays `null`, and the STRATUX-1 block below returns the
    // LOADING branch on null. So a failed read was an eternal spinner inside a
    // `role="status"`, with no retry and no error — and the measurement trail it hides
    // includes agent-PROPOSED check-ins awaiting a human decision, which then exist only
    // in the reviews inbox. A past-tense claim that outlived the code it described.
    try { setRows(await listStrategyCheckIns(strategy.id)); setFailed(false); }
    catch { setFailed(true); }
  }, [strategy.id]);
  useEffect(() => { void refresh(); }, [refresh, strategy.updatedAt]);
  // VALUE equality. A NOTE alone counts: it is the half with no numeric tell, so
  // a check keyed on `value` would report a typed explanation as clean. `submit`
  // resets the row's draft on success, which makes it clean again.
  //
  // Placed ABOVE the three early returns below — a hook after a conditional
  // return is a different bug.
  useEffect(() => {
    onDirty(Object.values(draft).some((d) => d.value.trim() !== '' || d.note.trim() !== ''));
  }, [draft, onDirty]);

  const measured = strategy.objectives.flatMap((o) => o.keyResults.filter((k) => k.measure).map((k) => ({ obj: o, kr: k })));
  // SPU-13 — this used to `return null`, so a user who came to record progress
  // found no Check-ins section, no heading and no hint that the prerequisite is
  // setting "Measurement" on a key result. The copy that explains it
  // (`checkinsLede`) rendered only AFTER the precondition was already met, i.e.
  // only to people who no longer needed it. A designed empty state that names the
  // prerequisite is the whole fix.
  if (measured.length === 0) {
    return (
      <section aria-label={t('checkinsTitle')}>
        <h3 className="u-m-0 u-fs-13">{t('checkinsTitle')}</h3>
        <StateCard icon={<FlagIcon />} title={t('checkinsNoMeasuresTitle')} body={t('checkinsNoMeasuresBody')} />
      </section>
    );
  }
  // Designed loading state (grade-ux STRATUX-1): rows===null is the fetch in
  // flight — never flash "no check-ins yet" before the trail has loaded.
  // R2 review — the failure branch used to come FIRST, and `refresh()` runs after every
  // successful `createCheckIn`/`decideCheckIn`: confirm an agent-proposed check-in, have
  // the follow-up read 429, and the whole panel — rows already in memory, the composer,
  // the confirm/dismiss buttons — was replaced by "we could not load the trail". The user
  // reads that as "my confirmation failed" and confirms again. Only a failure with NOTHING
  // to show replaces the panel; otherwise the warning sits ABOVE the trail.
  if (failed && rows === null) {
    return (
      <section aria-label={t('checkinsTitle')}>
        <h3 className="u-m-0 u-fs-13">{t('checkinsTitle')}</h3>
        <Notice variant="warning" announce={t('checkinsLoadFailed')}>
          {t('checkinsLoadFailed')} <Button variant="link" onClick={() => void refresh()}>{t('common:retry')}</Button>
        </Notice>
      </section>
    );
  }
  if (rows === null) {
    return (
      <section aria-label={t('checkinsTitle')}>
        <h3 className="u-m-0 u-fs-13">{t('checkinsTitle')}</h3>
        <p className="muted u-fs-12 u-m-0" role="status">{t('common:loading')}</p>
      </section>
    );
  }

  const byKr = new Map<string, StrategyCheckIn[]>();
  for (const r of rows ?? []) {
    const list = byKr.get(r.krId) ?? [];
    list.push(r);
    byKr.set(r.krId, list);
  }
  const latestConfirmed = (krId: string): StrategyCheckIn | undefined =>
    (byKr.get(krId) ?? []).find((r) => r.status === 'confirmed' && r.value !== undefined);
  const proposed = (krId: string): StrategyCheckIn[] => (byKr.get(krId) ?? []).filter((r) => r.status === 'proposed');

  const submit = async (krId: string): Promise<void> => {
    const d = draft[krId] ?? { value: '', note: '' };
    const value = d.value.trim() === '' ? undefined : Number(d.value);
    if (value !== undefined && !Number.isFinite(value)) { onError(t('checkinValueInvalid')); return; }
    if (value === undefined && !d.note.trim()) return;
    setBusy(krId);
    try {
      await createCheckIn(strategy.id, krId, { ...(value !== undefined ? { value } : {}), ...(d.note.trim() ? { note: d.note.trim() } : {}) });
      setDraft((p) => ({ ...p, [krId]: { value: '', note: '' } }));
      toast.success(t('toastCheckinRecorded'));
      await refresh();
    } catch (e) { onError(e instanceof Error ? e.message : t('checkinFailed')); }
    finally { setBusy(null); }
  };

  const decide = async (checkInId: string, decision: 'confirm' | 'dismiss'): Promise<void> => {
    setBusy(checkInId);
    try {
      await decideCheckIn(strategy.id, checkInId, decision);
      toast.success(t(decision === 'confirm' ? 'toastCheckinConfirmed' : 'toastCheckinDismissed'));
      await refresh();
    }
    catch (e) { onError(e instanceof Error ? e.message : t('checkinFailed')); }
    finally { setBusy(null); }
  };

  return (
    <section className="u-flex u-flex-col u-gap-3" aria-label={t('checkinsTitle')}>
      <div>
        <h3 className="u-m-0 u-fs-13">{t('checkinsTitle')}</h3>
        <p className="muted u-fs-12 u-m-0">{t('checkinsLede')}</p>
      </div>
      {measured.map(({ kr }) => {
        const latest = latestConfirmed(kr.id);
        const pend = proposed(kr.id);
        const d = draft[kr.id] ?? { value: '', note: '' };
        return (
          <div key={kr.id} className="surface-card u-flex u-flex-col u-gap-2 u-py-2">
            <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
              <span className="u-fw-600 u-fs-13">{kr.title}</span>
              {latest?.value !== undefined ? <span className="chip chip--accent u-fs-11">{t('checkinLatest', { value: formatNumber(latest.value) })}</span> : <span className="chip chip--muted u-fs-11">{t('checkinNone')}</span>}
              {kr.measure?.target !== undefined ? <span className="chip chip--muted u-fs-11">{t('checkinTarget', { value: formatNumber(kr.measure.target) })}{kr.measure.unit ? ` ${kr.measure.unit}` : ''}</span> : null}
              {kr.measure?.source ? <span className="chip chip--muted u-fs-11">{t('checkinSource', { source: kr.measure.source.kind })} <InfoTip label={t('checkinSourceInfo')} text={t('checkinSourceTitle')} /></span> : null}
            </div>
            {pend.map((p) => (
              <div key={p.checkInId} className="u-flex u-items-center u-justify-between u-gap-2 u-flex-wrap">
                <span className="u-flex u-items-center u-gap-2 u-flex-wrap">
                  <span className="chip chip--warning u-fs-11">{t('checkinProposed')}</span>
                  <span className="u-fs-12">{p.value !== undefined ? formatNumber(p.value) : ''}{p.note ? ` — ${p.note}` : ''}</span>
                </span>
                <span className="action-bar">
                  <Button variant="primary" size="sm" disabled={busy === p.checkInId} onClick={() => void decide(p.checkInId, 'confirm')}><CheckIcon size={12} /> {t('checkinConfirm')}</Button>
                  <Button variant="quiet" size="sm" disabled={busy === p.checkInId} onClick={() => void decide(p.checkInId, 'dismiss')}><XIcon size={12} /> {t('checkinDismiss')}</Button>
                </span>
              </div>
            ))}
            <div className="surface-form">
              <TextField label={t('checkinValue')} value={d.value} onChange={(e) => setDraft((prev) => ({ ...prev, [kr.id]: { ...d, value: e.target.value } }))} inputMode="decimal" />
              <TextField label={t('checkinNote')} value={d.note} onChange={(e) => setDraft((prev) => ({ ...prev, [kr.id]: { ...d, note: e.target.value } }))} className="u-flex-1" />
              <Button variant="primary" size="sm" disabled={busy === kr.id || (d.value.trim() === '' && d.note.trim() === '')} onClick={() => void submit(kr.id)}>{busy === kr.id ? t('common:saving') : t('checkinSubmit')}</Button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function AlignmentEditor({ strategy, projects, projectsFailed, onChanged, onError, onDirty, t }: { strategy: Strategy; projects: ProjectRef[]; projectsFailed: boolean; onChanged: () => void | Promise<void>; onError: (m: string) => void; /** SPU-4 — see `OverviewEditor`. */ onDirty: (d: boolean) => void; t: TFn }): JSX.Element {
  const [links, setLinks] = useState<StrategyLink[]>(() => structuredClone(strategy.links));
  const [dirtyBaseline] = useState(() => JSON.stringify(strategy.links));
  const dirty = JSON.stringify(links) !== dirtyBaseline;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  // Strategy-gap A3 — the resolved context packet (ONE fetch; never a per-list
  // fan-out) so saved priority links render their idea title + rank/score
  // instead of raw ids. Fail-soft: no packet ⇒ the raw-id fallback below.
  const [ctx, setCtx] = useState<StrategyContextEntry | null>(null);
  // SPU-6 (= code `SPC-12`(B)) — this was the THIRD read on the page and the only
  // one that kept the old `catch(() => {})` shape, which this very file documents
  // at :54-59 as "the most invisible form of swallowing … DOWNSTREAM that emptiness
  // becomes a positive claim". It does here too: with no packet, a priority-idea
  // link renders `listId · cardId` — raw opaque ids — and the rank (#3) and score
  // chips simply disappear, which reads as "this idea has no priority ranking".
  // The fallback stays (a link row with an id beats no row); what changes is that
  // the page now SAYS the resolve failed instead of letting the degraded render
  // speak for it.
  const [ctxFailed, setCtxFailed] = useState(false);
  useEffect(() => {
    let live = true;
    getStrategyDetailContext(strategy.id)
      .then((e) => { if (live) { setCtx(e); setCtxFailed(false); } })
      .catch(() => { if (live) setCtxFailed(true); });
    return () => { live = false; };
  }, [strategy.id, strategy.updatedAt]);
  // Only worth saying when there IS a priority link whose label it would have
  // resolved — otherwise it is noise about a resolve that changed nothing.
  const hasPriorityLink = links.some((l) => l.kind === 'priority-idea' || l.kind === 'priority-list');
  const priorityInfo = (listId: string, cardId?: string): { title: string; computedPriority?: number; rank?: number } | undefined =>
    ctx?.linkedPriorities.find((lp) => lp.listId === listId && (cardId ? lp.cardId === cardId : !lp.cardId));

  const linkedProjectIds = new Set(links.filter((l) => l.kind === 'project').map((l) => (l as { projectId: string }).projectId));
  const addable = projects.filter((p) => !linkedProjectIds.has(p.id));

  const addProject = (): void => { if (projectId) { setLinks((p) => [...p, { kind: 'project', projectId }]); setProjectId(''); } };
  const removeLink = (idx: number): void => setLinks((p) => p.filter((_, i) => i !== idx));

  const save = async (): Promise<void> => {
    setBusy(true);
    try { await replaceLinks(strategy.id, links); toast.success(t('toastAlignmentSaved')); await onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  };

  const proj = (id: string): ProjectRef | undefined => projects.find((p) => p.id === id);

  return (
    <div className="u-flex u-flex-col u-gap-3">
      <p className="muted u-fs-13">{t('alignmentLede')}</p>
      {projectsFailed ? <Notice variant="warning" announce={t('projectsLoadFailed')}>{t('projectsLoadFailed')}</Notice> : null}
      {ctxFailed && hasPriorityLink ? <Notice variant="warning" announce={t('priorityContextLoadFailed')}>{t('priorityContextLoadFailed')}</Notice> : null}
      {links.length === 0 ? <StateCard icon={<FlagIcon />} title={t('noLinks')} /> : (
        <ul className="u-flex u-flex-col u-gap-2 u-list-none u-p-0">
          {links.map((l, idx) => {
            const p = l.kind === 'project' ? proj(l.projectId) : undefined;
            // Priority links resolve through the context packet (title + rank/score);
            // an unsaved or unresolved link keeps the raw-id fallback.
            const pi = l.kind === 'priority-idea' ? priorityInfo(l.listId, l.cardId) : l.kind === 'priority-list' ? priorityInfo(l.listId) : undefined;
            const label = l.kind === 'project' ? (p?.name ?? l.projectId)
              : l.kind === 'priority-idea' ? (pi?.title ?? `${l.listId} · ${l.cardId}`)
              : l.kind === 'priority-list' ? (pi?.title ?? l.listId)
              : l.kind === 'advisory-board' ? l.boardId : l.documentId;
            return (
              <li key={`${l.kind}-${idx}`} className="u-flex u-flex-row u-items-center u-justify-between u-gap-2 surface-card u-py-2">
                <span className="u-flex u-items-center u-gap-2 u-flex-wrap">
                  <LinkIcon size={13} />
                  <span className="chip chip--accent">{t(`linkKind_${l.kind}`)}</span>
                  <span>{label}</span>
                  {p?.status ? <span className="chip chip--muted u-fs-11">{t(`projectStatus_${p.status}`, { defaultValue: p.status })}</span> : null}
                  {p?.health ? <span className={`chip u-fs-11 ${PROJECT_HEALTH_CHIP[p.health] ?? 'chip--muted'}`}>{t(`health_${p.health}`, { defaultValue: p.health })}</span> : null}
                  {typeof pi?.rank === 'number' ? <span className="chip chip--muted u-fs-11" title={t('ideaRankTitle')}>#{pi.rank}</span> : null}
                  {typeof pi?.computedPriority === 'number' ? <span className="chip chip--accent u-fs-11">{t('ideaScore', { score: formatNumber(pi.computedPriority, { maximumFractionDigits: 1 }) })}</span> : null}
                </span>
                <Button variant="quiet" size="sm" aria-label={t('removeLink')} onClick={() => removeLink(idx)}><TrashIcon size={13} /></Button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="surface-form">
        <SelectField label={t('linkProject')} value={projectId} onChange={(e) => setProjectId(e.target.value)} className="u-flex-1">
          {/* STR-G1 — "no more projects" is a CLAIM (every project is already
              linked). A failed read must not make it. */}
          <option value="">{projectsFailed ? t('projectsUnavailable') : addable.length ? t('selectProject') : t('noMoreProjects')}</option>
          {addable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </SelectField>
        <Button variant="quiet" size="sm" disabled={!projectId} onClick={addProject}><PlusIcon size={13} /> {t('addLink')}</Button>
      </div>
      <div className="action-bar u-justify-end">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>{busy ? t('common:saving') : t('saveAlignment')}</Button>
      </div>
    </div>
  );
}
