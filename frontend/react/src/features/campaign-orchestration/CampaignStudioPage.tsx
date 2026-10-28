/**
 * Campaign Studio page (ADR 0158, Phase 3). Lists marketing campaigns; a row opens
 * the deep-linkable detail (`CampaignDetailPage`, ADR 0941 D5) on the shared ui/
 * cohesion layer. Running a campaign happens through the one chat scoped to the
 * Campaign Strategist agent (ADR 0058 — deep-link, no second chat). Finalize a
 * confirmed brief into a campaign from the picker. NOT a metrics dashboard
 * (intelligence is ADR 0160) — the "build ON orchestration" rule.
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 */
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { StatusChip } from './CampaignStatusChip.js';
import { Modal } from '../../ui/Modal.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { SelectField } from '../../ui/Field.js';
import { IconButton } from '../../ui/IconButton.js';
import { toast } from '../../ui/toast.js';
import { MegaphoneIcon, PlusIcon, TrashIcon, SparklesIcon } from '../../ui/icons/index.js';
import {
  listCampaigns, finalizeBrief, deleteCampaign, listBriefs, listOrgs,
  FeatureDisabledError, CAMPAIGN_STATUSES, CAMPAIGN_STRATEGIST_AGENT, FUNNEL_ARCHITECT_AGENT, campaignDetailPath,
  type MarketingCampaign, type CampaignStatus, type BriefRef, type OrgRef,
} from './campaignStudioClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];

export function CampaignStudioPage(): JSX.Element {
  const { t } = useTranslation('campaign-orchestration');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const funnelsAccess = useFeatureAccess('funnels');
  const [campaigns, setCampaigns] = useState<MarketingCampaign[] | null>(null);
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [disabled, setDisabled] = useState(false);
  // A failed campaign read left the list at its previous value and drew "No campaigns
  // yet — finalize a confirmed brief into a campaign", i.e. an instruction to create
  // work that may already exist.
  const [campaignsFailed, setCampaignsFailed] = useState(false);
  // R2 CO-SP-12 — a failed orgs read used to be swallowed, silently hiding the
  // finalize modal's org selector (all orgs' briefs quietly mixed).
  const [orgsFailed, setOrgsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<MarketingCampaign | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setError(null); // CBC-5: a later success clears the sticky banner
    setCampaignsFailed(false);
    try { setCampaigns(await listCampaigns()); }
    catch (e) { if (e instanceof FeatureDisabledError) { setDisabled(true); setCampaigns([]); return; } setCampaignsFailed(true); setError(e instanceof Error ? e.message : t('actionFailed')); }
  }, [t]);
  useEffect(() => { void refresh(); void listOrgs().then(setOrgs).catch(() => setOrgsFailed(true)); }, [refresh]);

  // §4.5 collection kit (DESIGN.md rule 13): gated name/objective search + status facet → separate memo.
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | CampaignStatus>('');
  const visibleCampaigns = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (campaigns ?? []).filter((c) =>
      (!q || c.name.toLowerCase().includes(q) || (c.objective ?? '').toLowerCase().includes(q))
      && (!statusFilter || c.status === statusFilter));
  }, [campaigns, query, statusFilter]);
  const clearFilters = useCallback(() => { setQuery(''); setStatusFilter(''); }, []);

  if (disabled) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<MegaphoneIcon size={22} />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </div>
    );
  }

  return (
    <div data-walkthrough="campaigns.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')}
        actions={(
          <div className="action-bar">
            <Button variant="secondary" size="sm" onClick={() => navigate(`/?agent=${encodeURIComponent(CAMPAIGN_STRATEGIST_AGENT)}`)}><SparklesIcon size={13} /> {t('runWithStrategist')}</Button>
            {/* ADR 0267 / CDP-E — author a lifecycle journey on the EXISTING builder
                canvas (journeys ARE workflows, ADR 0222 — no second canvas); seeds
                the AI author with the journey node steps. */}
            <Button variant="secondary" size="sm" onClick={() => navigate('/builder', { state: { workGraphSeed: {
              name: 'Customer journey',
              toolSequence: ['Segment-entered trigger', 'Wait (timer)', 'Check eligibility', 'Send email', 'Branch on engagement (split)'],
              sampleGoal: 'A lifecycle journey: enroll a contact when they enter a segment, wait, check consent + frequency, send, then split on engagement',
            } } })}><SparklesIcon size={13} /> {t('designJourney')}</Button>
            {/* ADR 0948 P3a — design a funnel with the Funnel Architect, in the one chat; only
                where the funnels feature is on (its tools are refused otherwise). */}
            {funnelsAccess.enabled ? <Button variant="quiet" size="sm" onClick={() => navigate(`/?agent=${encodeURIComponent(FUNNEL_ARCHITECT_AGENT)}`)}>{t('designFunnelWithArchitect')}</Button> : null}
            {campaigns && campaigns.length > 0 ? <Button variant="primary" size="sm" onClick={() => setFinalizeOpen(true)}><PlusIcon size={13} /> {t('finalizeBrief')}</Button> : null}
          </div>
        )} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {campaigns && campaigns.length > 3 ? (
        <div className="filterbar u-mb-3" role="group" aria-label={t('filterGroup')}>
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('filterCampaignsPlaceholder')}
            aria-label={t('filterCampaignsAria')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="ui-input filterbar-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | CampaignStatus)} aria-label={t('filterStatusLabel')}>
            <option value="">{t('allStatuses')}</option>
            {CAMPAIGN_STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
          </select>
        </div>
      ) : null}
      {campaigns === null ? (
        <StateCard icon={<MegaphoneIcon size={20} />} title={t('loading')} loading />
      ) : campaignsFailed ? (
        <StateCard announce icon={<MegaphoneIcon size={22} />} title={tc('loadFailedTitle')} body={tc('loadFailedBody')} />
      ) : campaigns.length === 0 ? (
        <StateCard icon={<MegaphoneIcon size={22} />} title={t('emptyTitle')} body={t('emptyBody')}
          action={<Button variant="primary" size="sm" onClick={() => setFinalizeOpen(true)}><PlusIcon size={13} /> {t('finalizeBrief')}</Button>} />
      ) : visibleCampaigns.length === 0 ? (
        <StateCard icon={<MegaphoneIcon size={22} />} title={t('noMatchTitle')} body={t('noMatchBody')}
          action={<Button variant="secondary" size="sm" onClick={clearFilters}>{t('clearFilters')}</Button>} />
      ) : (
        <ul className="surface-card list-view u-list-none u-m-0">
          {visibleCampaigns.map((c) => (
            <li key={c.id} className="list-row">
              <button type="button" className="list-row-id" onClick={() => navigate(campaignDetailPath(c.id))}>
                <span className="list-row-name-wrap">
                  <span className="list-row-name-line"><span className="list-row-name u-fw-600">{c.name}</span><StatusChip status={c.status} t={t} /></span>
                  {c.objective ? <span className="u-fs-13 muted">{c.objective}</span> : null}
                </span>
              </button>
              <div className="list-row-name-line">
                {c.kernel ? <span className="chip chip--success">{t('hasKernel')}</span> : null}
                <span className="chip chip--muted">{t('channelsCount', { count: c.channels.length })}</span>
              </div>
              <IconButton label={t('common:delete')} icon={<TrashIcon size={15} />} className="ghost btn-sm" onClick={() => setConfirmDelete(c)} />
            </li>
          ))}
        </ul>
      )}

      {finalizeOpen ? <FinalizeModal t={t} orgs={orgs} orgsFailed={orgsFailed} onClose={() => setFinalizeOpen(false)} onDone={(c) => { setFinalizeOpen(false); toast.success(t('finalizeSuccess', { name: c.name })); navigate(campaignDetailPath(c.id)); }} /> : null}
      {confirmDelete ? (
        // R2 CO-SP-10 — `busy` blocks the double-submit window (the second
        // DELETE 404'd invisibly). CO-SP-3 — on failure the dialog CLOSES so
        // the error Notice above isn't hidden behind the scrim.
        <ConfirmDialog title={t('deleteTitle')} body={t('deleteBody')} confirmLabel={t('common:delete')} danger busy={deleting}
          onConfirm={async () => {
            setDeleting(true);
            try { await deleteCampaign(confirmDelete.id); setConfirmDelete(null); await refresh(); }
            catch (e) { setConfirmDelete(null); setError(e instanceof Error ? e.message : t('actionFailed')); }
            finally { setDeleting(false); }
          }}
          onCancel={() => setConfirmDelete(null)} />
      ) : null}
    </div>
  );
}

function FinalizeModal({ t, orgs, orgsFailed, onClose, onDone }: { t: TFn; orgs: OrgRef[]; orgsFailed: boolean; onClose: () => void; onDone: (c: MarketingCampaign) => void }): JSX.Element {
  const [orgId, setOrgId] = useState(orgs[0]?.orgId ?? '');
  const [briefs, setBriefs] = useState<BriefRef[] | null>(null);
  // R2 CO-SP-2 — a failed briefs read is a FAILURE, never "No briefs found"
  // (the swallow also ate feature-disabled, so brief-less and briefs-off read
  // identically and the user went off to recreate work).
  const [briefsFailed, setBriefsFailed] = useState(false);
  // A toggled-off campaign-brief feature is a DESIGNED state, not a transient
  // failure — "close and retry" would be a lie there (review fold-in).
  const [briefsOff, setBriefsOff] = useState(false);
  const [briefId, setBriefId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // R2 CO-SP-4 — the selection RESETS on an org switch (the old `cur || …`
    // kept org A's brief selected while org B rendered, and submit would have
    // finalized the wrong org's brief). `live` drops a stale response from a
    // fast org flip (the LaunchState shape).
    let live = true;
    setBriefs(null); setBriefsFailed(false); setBriefsOff(false); setBriefId('');
    void listBriefs(orgId || undefined)
      .then((b) => { if (!live) return; setBriefs(b); setBriefId(b.find((x) => x.kernel)?.id ?? ''); })
      .catch((e) => { if (live) { setBriefs([]); setBriefsFailed(true); setBriefsOff(e instanceof FeatureDisabledError); } });
    return () => { live = false; };
  }, [orgId]);

  const submit = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { onDone(await finalizeBrief(briefId)); }
    // R2 CO-SP-3 — the failure renders INSIDE the dialog (Modal's error region);
    // it used to mount a Notice behind the scrim.
    catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); setBusy(false); }
  };
  return (
    <Modal label={t('finalizeBrief')} onClose={() => { if (!busy) onClose(); }} showClose error={error ?? (briefsFailed ? (briefsOff ? t('briefsDisabled') : t('briefsFailed')) : null)}>
      <h2 className="u-mt-0">{t('finalizeBrief')}</h2>
      <p className="muted">{t('finalizeHint')}</p>
      {orgsFailed ? <p className="muted u-fs-13">{t('orgsFailedHint')}</p> : null}
      <form onSubmit={(e) => { e.preventDefault(); if (briefId && !busy) void submit(); }}>
        {orgs.length > 1 ? (
          <SelectField label={t('fieldOrg')} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            <option value="">{t('allOrgs')}</option>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </SelectField>
        ) : null}
        <SelectField label={t('fieldBrief')} value={briefId} onChange={(e) => setBriefId(e.target.value)} required>
          {briefsFailed || briefs === null || briefs.length === 0 ? <option value="">{briefsFailed ? t('briefsFailedOption') : briefs === null ? t('loadingBriefs') : t('noBriefs')}</option>
            // R2 CO-SP-12 — a kernel-less brief 409s at finalize; it is listed
            // (so the user knows it exists) but not selectable. The hidden
            // placeholder keeps the control sane when every brief is disabled
            // (controlled value '' would otherwise match nothing).
            : [<option key="" value="" disabled hidden />, ...briefs.map((b) => <option key={b.id} value={b.id} disabled={!b.kernel}>{b.name} — {b.kernel ? t('briefReady') : t('briefNotReady')}</option>)]}
        </SelectField>
        <div className="action-bar u-flex u-gap-2 u-justify-end">
          <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>{t('common:cancel')}</Button>
          <Button type="submit" variant="primary" size="sm" disabled={!briefId || busy}>{t('finalize')}</Button>
        </div>
      </form>
    </Modal>
  );
}
