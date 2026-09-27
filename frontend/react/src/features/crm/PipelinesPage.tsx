/**
 * Pipeline & stage configuration — /crm/pipelines?org=<orgId> (CRM-UX-2).
 *
 * `POST/PATCH/DELETE …/crm/orgs/:orgId/pipelines` have shipped since ADR 0008
 * with ZERO frontend consumers: `crmOrgClient` exported `listPipelines` alone.
 * The consequence was not cosmetic — the deals board's columns were whatever the
 * backend seeded, and the Reports tab's headline weighted forecast multiplies
 * each stage's amount by a PROBABILITY no user could see or change. This is the
 * ADR 0488 built-but-unreachable class, and this page is the missing consumer.
 *
 * WHY A ROUTE AND NOT A NINTH TAB. CRM already ships the app's widest tablist
 * (CRM-UX-5); pipeline config is an occasional administrative act, not a
 * collection you browse. It follows the record-page precedent instead — org
 * context rides `?org=`, and the Deals tab links here.
 *
 * ── The one honesty rule this page turns on ─────────────────────────────────
 * The server REFUSES (409) to delete a pipeline that still has deals, or to drop
 * a stage that still has deals. So the UI reads the org's deals to say WHICH
 * removals are safe. When that read fails we do not render a confident zero —
 * `dealsFailed` says the counts are unknown and every control stays enabled, so
 * the server (the authority) answers instead of this page guessing. A disabled
 * control always names why and where to go next; a refusal with no exit is a
 * defect.
 *
 * ── MEDIUM-1: the deals read is a LOWER BOUND, not an authority ─────────────
 * `listDeals(orgId)` goes through `GET …/crm/orgs/:orgId/deals`, which passes
 * the CALLER as the viewer into `filterVisibleCrmRecords` — and the
 * `territories` feature registers that resolver. So the rows this page counts
 * are the deals THIS USER may see. The server's own integrity guards
 * (`anyDealsOnPipeline`, `listDealsOnStages`) call `listDeals` with NO viewer.
 * The two therefore disagree for any user whose territory excludes deals.
 *
 * The fix is (b) of the two options: never render a confident zero and never
 * promise a removal is safe. A count > 0 is still trustworthy (a lower bound
 * above zero is certainly above zero), so it still blocks and still names its
 * exit. A count of zero renders NOTHING — no "0 deals" chip, no implied
 * guarantee — and the attempt simply proceeds so the SERVER answers; its 409 is
 * then translated here rather than pasted through as wire English.
 *
 * Option (a) — an authoritative, viewer-less count route — was rejected, and
 * not merely as extra work: a per-stage true count tells this user exactly how
 * many deals exist outside their territory, which is the fact `territories`
 * exists to withhold. A refusal is allowed to be less informative than the
 * truth; a UI is not allowed to leak the truth to route around it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Notice } from '../../ui/Notice.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { formatNumber } from '../../i18n/format.js';
import { ColumnsIcon, ChevronUpIcon, ChevronDownIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import {
  CrmRequestError,
  PIPELINE_MAX,
  createPipeline,
  deletePipeline,
  listDeals,
  listPipelines,
  updatePipeline,
  type Deal,
  type Pipeline,
  type PipelineStage,
} from './crmOrgClient.js';
import { crmActionError } from './crmUiHelpers.js';

/** A stage being edited. `stageId` is absent for a stage the user just added —
 *  its absence is what tells the server to mint one (and what keeps an existing
 *  stage's deals attached when it IS present). `key` is render-identity only. */
interface StageDraft {
  key: string;
  stageId?: string;
  name: string;
  /** Held as a STRING so the field can be empty mid-typing without snapping to
   *  0 — the number-field lesson from the round-2 forms pass. */
  probability: string;
}

function newKey(): string {
  return crypto.randomUUID?.() ?? `k${Math.random()}`;
}

function toDrafts(stages: readonly PipelineStage[]): StageDraft[] {
  return stages.map((s) => ({ key: newKey(), stageId: s.stageId, name: s.name, probability: String(s.probability) }));
}

export function PipelinesPage(): JSX.Element {
  const { t } = useTranslation('crm');
  const { t: tc } = useTranslation('common');
  const crm = useFeatureAccess('crm');
  const [search] = useSearchParams();
  const orgId = search.get('org') ?? '';

  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [dealsFailed, setDealsFailed] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!orgId) return;
    setFailed(false);
    void listPipelines(orgId)
      .then(setPipelines)
      // HIGH-1 — UNKNOWN (`null`), never `[]`. `failed` is cleared
      // synchronously above, so a stale `[]` rendered the "No pipelines yet"
      // card for the whole RETRY request.
      .catch(() => { setPipelines(null); setFailed(true); });
  }, [orgId]);

  // A SEPARATE read (CRM-UX-9's rule): retrying the pipelines list must not
  // clobber a stage edit in progress, and vice-versa.
  const loadDeals = useCallback(() => {
    if (!orgId) return;
    setDealsFailed(false);
    void listDeals(orgId)
      .then(setDeals)
      .catch(() => { setDeals(null); setDealsFailed(true); });
  }, [orgId]);

  useEffect(() => { load(); loadDeals(); }, [load, loadDeals]);

  /** deals-per-stage, or `null` when the deals read failed (NOT zero). */
  const dealsByStage = useMemo<Map<string, number> | null>(() => {
    if (deals === null) return null;
    const counts = new Map<string, number>();
    for (const d of deals) counts.set(d.stageId, (counts.get(d.stageId) ?? 0) + 1);
    return counts;
  }, [deals]);
  const dealsByPipeline = useMemo<Map<string, number> | null>(() => {
    if (deals === null) return null;
    const counts = new Map<string, number>();
    for (const d of deals) counts.set(d.pipelineId, (counts.get(d.pipelineId) ?? 0) + 1);
    return counts;
  }, [deals]);

  const add = useCallback(async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      // `stages: []` is meaningful on the wire: the server seeds its DEFAULT_STAGES,
      // which the editor below then makes editable. It is not "no stages".
      await createPipeline(orgId, { name: newName.trim(), stages: [] });
      setNewName('');
      load();
      toast.success(t('pipelineCreated'));
    } catch (e) { toast.error(crmActionError(e, 'addFailed')); } finally { setBusy(false); }
  }, [orgId, newName, load, t]);

  const remove = useCallback(async (p: Pipeline) => {
    if (!(await confirm({
      title: t('pipelineDeleteConfirm', { name: p.name }),
      body: t('pipelineDeleteBody'),
      danger: true,
      confirmLabel: tc('delete'),
    }))) return;
    try {
      await deletePipeline(orgId, p.pipelineId);
      toast.success(t('pipelineDeleted'));
      load(); loadDeals();
    } catch (e) {
      // MEDIUM-1 — the 409 is the AUTHORITY answering a question this page's
      // territory-filtered count could not. Say it in the user's language,
      // with the same exit the blocked control offers; the raw server string
      // is English-only and names no way forward.
      toast.error(e instanceof CrmRequestError && e.status === 409
        ? t('pipelineDeleteRefused')
        : crmActionError(e, 'deleteFailed'));
    }
  }, [orgId, load, loadDeals, t, tc]);

  // LOW-7 — `data-walkthrough` rides EVERY branch, not just the happy one (the
  // `CompanyDetailPage` precedent). A walkthrough step anchored here otherwise
  // has no target while the toggle resolves, when the feature is off, or when
  // the link arrived without `?org=` — the three moments it most needs one.
  if (crm.loading) return <div data-walkthrough="crm-pipelines.page"><Skeleton /></div>;
  if (!crm.enabled) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="crm-pipelines.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }
  if (!orgId) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="crm-pipelines.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('pipelinesTitle')} />
        <StateCard icon={<ColumnsIcon />} title={t('missingOrgTitle')} body={t('missingOrgBody')} />
        <Link to="/crm?tab=deals">{t('backToCrm')}</Link>
      </section>
    );
  }

  return (
    <section className="u-grid u-gap-4" data-walkthrough="crm-pipelines.page">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('pipelinesTitle')}
        lede={t('pipelinesLede')}
        actions={<Link to="/crm?tab=deals" className="btn-ghost">{t('backToCrm')}</Link>}
      />

      {/* The deals read is a SECONDARY read here: it only decides which removals
          are known-safe. Name its failure rather than letting every stage read
          as "0 deals — safe to remove" (§4.6). */}
      {dealsFailed ? (
        // `announce` is not decoration here: the ONLY other signal that the
        // counts are unknown is the ABSENCE of the "N deals" chips, and an
        // absence is silent to a screen reader — which is exactly how a
        // non-sighted operator would end up believing every stage is empty.
        // `warning`, so it announces politely (a failed load, not a failed act).
        <Notice variant="warning" announce={t('pipelineDealCountsUnavailable')}>{t('pipelineDealCountsUnavailable')}</Notice>
      ) : (
        // MEDIUM-1 — even a SUCCESSFUL deals read is scoped to what this user
        // may see, so the counts below are a floor. Saying so once here is
        // what keeps an enabled Remove from reading as a promise.
        <p className="muted u-fs-12 u-m-0">{t('pipelineDealCountsScope')}</p>
      )}

      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('pipelineNameLabel')}</span>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={PIPELINE_MAX.name} placeholder={t('pipelineNamePlaceholder')} />
        </label>
        <Button variant="primary" type="submit" disabled={busy || !newName.trim()}>{t('pipelineCreate')}</Button>
        <p className="muted u-fs-12 u-m-0 u-w-full">{t('pipelineCreateHint')}</p>
      </form>

      {/* HIGH-1 — the FAILURE branch is checked before the skeleton: on a
          failure `pipelines` is `null`, so a skeleton-first order would hide
          the card behind a spinner that never resolves. */}
      {failed ? (
        <StateCard
          announce
          icon={<ColumnsIcon />}
          title={tc('loadFailedTitle')}
          body={tc('loadFailedBody')}
          action={<Button variant="secondary" onClick={load}>{tc('retry')}</Button>}
        />
      ) : pipelines === null ? (
        <Skeleton />
      ) : pipelines.length === 0 ? (
        <StateCard icon={<ColumnsIcon />} title={t('pipelinesEmptyTitle')} body={t('pipelinesEmptyBody')} />
      ) : (
        <ul className="u-grid u-gap-4 u-list-none u-p-0 u-m-0">
          {pipelines.map((p) => (
            <li key={p.pipelineId}>
              <PipelineEditor
                orgId={orgId}
                pipeline={p}
                dealsByStage={dealsByStage}
                pipelineDealCount={dealsByPipeline?.get(p.pipelineId) ?? null}
                onSaved={(next) => setPipelines((cur) => (cur ?? []).map((x) => (x.pipelineId === next.pipelineId ? next : x)))}
                onDelete={() => void remove(p)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One pipeline's card. Owns its OWN draft so a sibling's save (or the list
 *  reload behind it) never resets an edit in progress — the CRM-UX-9 rule. */
function PipelineEditor({ orgId, pipeline, dealsByStage, pipelineDealCount, onSaved, onDelete }: {
  orgId: string;
  pipeline: Pipeline;
  /** `null` = the deal counts are UNKNOWN (a failed read), never zero. */
  dealsByStage: Map<string, number> | null;
  pipelineDealCount: number | null;
  onSaved: (next: Pipeline) => void;
  onDelete: () => void;
}): JSX.Element {
  const { t } = useTranslation('crm');
  const { t: tc } = useTranslation('common');
  const [name, setName] = useState(pipeline.name);
  const [stages, setStages] = useState<StageDraft[]>(() => toDrafts(pipeline.stages));
  const [busy, setBusy] = useState(false);

  const stageDeals = useCallback((stageId?: string): number | null => {
    if (dealsByStage === null) return null;   // unknown, not zero
    if (!stageId) return 0;                   // a stage the user just added has none
    return dealsByStage.get(stageId) ?? 0;
  }, [dealsByStage]);

  const patchStage = (key: string, patch: Partial<StageDraft>): void =>
    setStages((cur) => cur.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const move = (index: number, delta: number): void =>
    setStages((cur) => {
      const next = [...cur];
      const target = index + delta;
      if (target < 0 || target >= next.length) return cur;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  const removeStage = (key: string): void => setStages((cur) => cur.filter((s) => s.key !== key));
  const addStage = (): void => setStages((cur) => (cur.length >= PIPELINE_MAX.stages ? cur : [...cur, { key: newKey(), name: '', probability: '0' }]));

  // MEDIUM-2 — a blank name on an EXISTING stage is a VALIDATION ERROR, never a
  // removal. `save` used to `.filter((s) => s.name)` over every draft, so a
  // stage whose name the user cleared mid-retype simply vanished from
  // `patch.stages` — and `updatePipeline` treats an absent `stageId` as
  // removed, so the server DELETED it outright (it had no deals, so the
  // referential guard let it through): no confirm, no toast, no signal, and
  // straight past the guarded "Remove" control that exists for exactly this.
  // `pipelineNeedsAStage` never caught it — that only fires when EVERY stage
  // is blank. Removal stays the explicit control; this is a typo.
  const blankExisting = stages.findIndex((s) => s.stageId !== undefined && s.name.trim() === '');

  const save = useCallback(async () => {
    if (!name.trim()) return;
    if (blankExisting >= 0) {
      toast.error(t('stageNameRequired', { position: blankExisting + 1 }));
      return;
    }
    const clean = stages
      // A stage the user ADDED and left blank was never saved, so dropping it
      // removes nothing — that is the one case the old filter got right.
      .filter((s) => s.stageId !== undefined || s.name.trim() !== '')
      .map((s) => ({
        ...(s.stageId ? { stageId: s.stageId } : {}),
        name: s.name.trim(),
        // An empty/garbage box is 0, not NaN — the server clamps to 0–100 anyway,
        // but sending NaN would serialize to `null` and read as "unspecified".
        probability: Number.isFinite(Number(s.probability)) ? Math.max(0, Math.min(100, Math.round(Number(s.probability)))) : 0,
      }));
    if (clean.length === 0) { toast.error(t('pipelineNeedsAStage')); return; }
    setBusy(true);
    try {
      const next = await updatePipeline(orgId, pipeline.pipelineId, { name: name.trim(), stages: clean });
      setStages(toDrafts(next.stages)); // adopt the server's ids for newly-minted stages
      setName(next.name);
      onSaved(next);
      toast.success(t('pipelineSaved'));
    } catch (e) {
      // MEDIUM-1 — a dropped stage that still holds a deal this user cannot
      // see comes back as a 409. Translate it; the raw string is wire English.
      toast.error(e instanceof CrmRequestError && e.status === 409
        ? t('stageRemoveRefused')
        : crmActionError(e, 'saveFailed'));
    } finally { setBusy(false); }
  }, [orgId, pipeline.pipelineId, name, stages, blankExisting, onSaved, t]);

  const deleteBlocked = pipelineDealCount !== null && pipelineDealCount > 0;

  return (
    <form className="surface-card u-p-4 u-grid u-gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
        <label className="u-grid u-gap-1 u-flex-1">
          <span className="u-label-sm">{t('pipelineNameLabel')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={PIPELINE_MAX.name} />
        </label>
        {/* MEDIUM-1 — only a POSITIVE count is rendered. A zero from this
            territory-filtered read is not a fact about the pipeline, and "0
            deals" beside an enabled Delete reads as a guarantee this page
            cannot give. */}
        {pipelineDealCount !== null && pipelineDealCount > 0 ? (
          <span className="chip chip--muted">{t('pipelineDealCount', { count: pipelineDealCount })}</span>
        ) : null}
      </div>

      <div className="u-grid u-gap-2">
        <span className="u-label-sm">{t('pipelineStagesLabel')}</span>
        <p className="muted u-fs-12 u-m-0">{t('pipelineProbabilityHint')}</p>
        <ul className="u-grid u-gap-2 u-list-none u-p-0 u-m-0">
          {stages.map((s, i) => {
            const count = stageDeals(s.stageId);
            const removeBlocked = count !== null && count > 0;
            const stageLabel = s.name || t('stageUnnamed');
            return (
              <li key={s.key} className="u-flex u-gap-2 u-flex-wrap u-items-end">
                <label className="u-grid u-gap-1 u-flex-1">
                  <span className="u-label-sm">{t('stageNameLabel', { position: i + 1 })}</span>
                  <input
                    value={s.name}
                    maxLength={PIPELINE_MAX.stageName}
                    onChange={(e) => patchStage(s.key, { name: e.target.value })}
                    placeholder={t('stageNamePlaceholder')}
                    {...(blankExisting === i ? { 'aria-invalid': true, 'aria-describedby': `stage-name-error-${s.key}` } : {})}
                  />
                </label>
                <label className="u-grid u-gap-1 is-narrow">
                  <span className="u-label-sm">{t('stageProbabilityLabel', { name: stageLabel })}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    inputMode="numeric"
                    value={s.probability}
                    onChange={(e) => patchStage(s.key, { probability: e.target.value })}
                  />
                </label>
                {/* Deal count as a LABELED chip — never a colour alone (§5.3).
                    MEDIUM-1: a POSITIVE count only; a zero from the filtered
                    read is not a fact this page may assert. */}
                {count !== null && count > 0 ? <span className="chip chip--muted">{t('stageDealCount', { count })}</span> : null}
                <span className="action-bar">
                  <Button variant="quiet" size="sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t('stageMoveUpLabel', { name: stageLabel })}>
                    <ChevronUpIcon size={14} />
                  </Button>
                  <Button variant="quiet" size="sm" onClick={() => move(i, 1)} disabled={i === stages.length - 1} aria-label={t('stageMoveDownLabel', { name: stageLabel })}>
                    <ChevronDownIcon size={14} />
                  </Button>
                  <Button variant="quiet" size="sm" onClick={() => removeStage(s.key)} disabled={removeBlocked} aria-label={t('stageRemoveLabel', { name: stageLabel })}>
                    {tc('remove')}
                  </Button>
                </span>
                {/* The refusal names its own exit — a disabled control with no
                    stated way forward is the defect this avoids. LOW-5: it
                    named the WHY but not the WHERE, unlike its sibling on the
                    pipeline Delete below; the link is the exit. */}
                {removeBlocked ? (
                  <span className="muted u-fs-12 u-w-full">
                    {t('stageRemoveBlockedHint', { count })}{' '}
                    <Link to="/crm?tab=deals">{t('pipelineDeleteBlockedLink')}</Link>
                  </span>
                ) : null}
                {/* MEDIUM-2 — name the FIELD, inline, not just in the toast the
                    Save press raises. */}
                {blankExisting === i ? (
                  <span id={`stage-name-error-${s.key}`} className="muted u-fs-12 u-w-full">{t('stageNameRequired', { position: i + 1 })}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="action-bar">
          <Button variant="secondary" size="sm" onClick={addStage} disabled={stages.length >= PIPELINE_MAX.stages}>{t('stageAdd')}</Button>
          {stages.length >= PIPELINE_MAX.stages ? <span className="muted u-fs-12">{t('stagesCapReached', { max: formatNumber(PIPELINE_MAX.stages) })}</span> : null}
        </div>
      </div>

      <div className="action-bar">
        <Button variant="primary" type="submit" disabled={busy || !name.trim()}>{tc('save')}</Button>
        <Button variant="quiet" type="button" onClick={onDelete} disabled={deleteBlocked}>{tc('delete')}</Button>
        {deleteBlocked ? (
          <span className="muted u-fs-12">
            {t('pipelineDeleteBlockedHint', { count: pipelineDealCount })}{' '}
            <Link to="/crm?tab=deals">{t('pipelineDeleteBlockedLink')}</Link>
          </span>
        ) : null}
      </div>
    </form>
  );
}
