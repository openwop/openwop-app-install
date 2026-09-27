/**
 * Campaign Studio page (ADR 0158, Phase 3). Lists marketing campaigns + a detail
 * view (read-only messaging kernel, channels, editable status) on the shared ui/
 * cohesion layer. Running a campaign happens through the one chat scoped to the
 * Campaign Strategist agent (ADR 0058 — deep-link, no second chat). Finalize a
 * confirmed brief into a campaign from the picker. NOT a metrics dashboard
 * (intelligence is ADR 0160) — the "build ON orchestration" rule.
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Modal } from '../../ui/Modal.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { SelectField } from '../../ui/Field.js';
import { IconButton } from '../../ui/IconButton.js';
import { toast } from '../../ui/toast.js';
import { formatCurrencyMinor, formatDateTime, formatNumber } from '../../i18n/format.js';
import { MegaphoneIcon, PlusIcon, TrashIcon, SparklesIcon, ArrowLeftIcon } from '../../ui/icons/index.js';
import {
  listCampaigns, finalizeBrief, updateCampaign, deleteCampaign, listBriefs, listOrgs, listDispatches,
  FeatureDisabledError, CAMPAIGN_STATUSES, CAMPAIGN_STRATEGIST_AGENT,
  type MarketingCampaign, type CampaignStatus, type BriefRef, type OrgRef, type AdDispatch,
} from './campaignStudioClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];

export function CampaignStudioPage(): JSX.Element {
  const { t } = useTranslation('campaign-orchestration');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
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
  const [selected, setSelected] = useState<string | null>(null);
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

  const current = useMemo(() => campaigns?.find((c) => c.id === selected) ?? null, [campaigns, selected]);

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

  if (current) {
    // R2 CO-SP-3 — the error Notice used to render ONLY in the list branch, so a
    // failed status change from the detail view showed the user nothing (the
    // select visually snapped back, silently). `announce` speaks the mutation.
    return (
      <div>
        {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
        <CampaignDetail t={t} campaign={current}
          orgName={orgs.find((o) => o.orgId === current.orgId)?.name}
          parentName={current.parentCampaignId ? campaigns?.find((c) => c.id === current.parentCampaignId)?.name : undefined}
          onBack={() => { setSelected(null); void refresh(); }} onChanged={refresh} onError={setError}
          onRun={() => navigate(`/?agent=${encodeURIComponent(CAMPAIGN_STRATEGIST_AGENT)}`)} />
      </div>
    );
  }

  return (
    <div data-walkthrough="campaigns.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')}
        actions={(
          <div className="u-flex u-gap-2">
            <Button variant="secondary" size="sm" onClick={() => navigate(`/?agent=${encodeURIComponent(CAMPAIGN_STRATEGIST_AGENT)}`)}><SparklesIcon size={13} /> {t('runWithStrategist')}</Button>
            {/* ADR 0267 / CDP-E — author a lifecycle journey on the EXISTING builder
                canvas (journeys ARE workflows, ADR 0222 — no second canvas); seeds
                the AI author with the journey node steps. */}
            <Button variant="secondary" size="sm" onClick={() => navigate('/builder', { state: { workGraphSeed: {
              name: 'Customer journey',
              toolSequence: ['Segment-entered trigger', 'Wait (timer)', 'Check eligibility', 'Send email', 'Branch on engagement (split)'],
              sampleGoal: 'A lifecycle journey: enroll a contact when they enter a segment, wait, check consent + frequency, send, then split on engagement',
            } } })}><SparklesIcon size={13} /> {t('designJourney')}</Button>
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
              <button type="button" className="list-row-id" onClick={() => setSelected(c.id)}>
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

      {finalizeOpen ? <FinalizeModal t={t} orgs={orgs} orgsFailed={orgsFailed} onClose={() => setFinalizeOpen(false)} onDone={async (c) => { setFinalizeOpen(false); toast.success(t('finalizeSuccess', { name: c.name })); await refresh(); setSelected(c.id); }} /> : null}
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

function StatusChip({ status, t }: { status: CampaignStatus; t: TFn }): JSX.Element {
  // `completed` is a TERMINAL state (grade-ux): the clay accent (chip--accent)
  // reads as active/flow — a finished campaign should read settled, so → muted.
  const cls = status === 'active' ? 'chip--success' : status === 'completed' ? 'chip--muted' : status === 'paused' ? 'chip--warning' : 'chip--muted';
  return <span className={`chip ${cls}`}>{t(`status_${status}`)}</span>;
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

function CampaignDetail({ t, campaign, orgName, parentName, onBack, onChanged, onError, onRun }: { t: TFn; campaign: MarketingCampaign; orgName?: string | undefined; parentName?: string | undefined; onBack: () => void; onChanged: () => Promise<void>; onError: (m: string) => void; onRun: () => void }): JSX.Element {
  const [statusBusy, setStatusBusy] = useState(false);
  const setStatus = async (status: CampaignStatus): Promise<void> => {
    if (statusBusy) return;
    setStatusBusy(true);
    try {
      try { await updateCampaign(campaign.id, { status }); await onChanged(); } catch (e) { onError(e instanceof Error ? e.message : t('actionFailed')); }
    } finally { setStatusBusy(false); }
  };
  return (
    <div>
      <div className="action-bar u-flex u-items-center u-gap-2 u-mb-4">
        <Button variant="quiet" size="sm" onClick={onBack}><ArrowLeftIcon size={14} /> {t('backToCampaigns')}</Button>
        <h2 className="u-m-0 u-flex-1">{campaign.name}</h2>
        <SelectField label={t('statusLabel')} disabled={statusBusy} value={campaign.status} onChange={(e) => void setStatus(e.target.value as CampaignStatus)} className="u-mb-0">
          {CAMPAIGN_STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
        </SelectField>
        <Button variant="primary" size="sm" onClick={onRun}><SparklesIcon size={13} /> {t('runWithStrategist')}</Button>
      </div>

      {/* R2 CO-SP-8 — facts the payload already carried and the detail threw
          away: objective, org, dates, the (cycle-checked!) parent reference.
          CO-SP-7 — the planned budget, WITH its ISO currency when recorded
          (formatCurrencyMinor derives the currency's own decimals, so JPY-class
          amounts don't misrender 100×); labeled bare when currency is absent. */}
      {campaign.objective ? <p className="muted u-mt-0">{campaign.objective}</p> : null}
      <p className="u-fs-13 muted u-mt-0">
        {orgName ? <span>{t('factOrg', { org: orgName })} · </span> : null}
        {campaign.createdAt ? <span>{t('factCreated', { when: formatDateTime(campaign.createdAt) })}</span> : null}
        {campaign.updatedAt ? <span> · {t('factUpdated', { when: formatDateTime(campaign.updatedAt) })}</span> : null}
        {parentName ? <span> · {t('factParent', { name: parentName })}</span> : null}
        {campaign.budget?.totalMinor !== undefined ? (
          <span> · {campaign.budget.currency
            ? t('plannedBudget', { amount: formatCurrencyMinor(campaign.budget.totalMinor, campaign.budget.currency) })
            : t('plannedBudgetNoCurrency', { amount: formatNumber(campaign.budget.totalMinor) })}</span>
        ) : null}
      </p>

      {campaign.kernel ? (
        <section className="surface-card u-mb-4">
          <div className="u-flex u-items-center u-gap-2 u-mb-2"><SparklesIcon size={16} /> <h3 className="u-m-0">{t('kernelTitle')}</h3></div>
          <p className="u-fw-600 u-mb-1">{campaign.kernel.headline}</p>
          <p className="muted u-mt-0">{campaign.kernel.supportingStatement}</p>
          {campaign.kernel.proofPoints.length ? <ul>{campaign.kernel.proofPoints.map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
          <p className="u-fs-13"><strong>{t('kernelCta')}:</strong> {campaign.kernel.primaryCta} · <strong>{t('kernelTone')}:</strong> {campaign.kernel.tone}</p>
        </section>
      ) : (
        <Notice variant="info">{t('noKernel')} <Button variant="link" onClick={onRun}>{t('runWithStrategist')}</Button></Notice>
      )}

      <section className="surface-card u-mb-4">
        <h3 className="u-mt-0">{t('channelsTitle')}</h3>
        {campaign.channels.length === 0 ? <p className="muted">{t('noChannels')}</p> : (
          <div className="list-row-name-line">{campaign.channels.map((c) => <span key={c} className="chip chip--muted">{t(`channel_${c}`, { defaultValue: c })}</span>)}</div>
        )}
      </section>

      <LaunchState t={t} campaign={campaign} />
    </div>
  );
}

/** Launch state (campaign gap plan §5B B5): where each enabled channel's output
 *  lands (drafts in the owning surface — this posture is deliberate, a human
 *  publishes there) + the REAL ads dispatch ledger (PAUSED platform campaigns). */
function LaunchState({ t, campaign }: { t: TFn; campaign: MarketingCampaign }): JSX.Element {
  const [dispatches, setDispatches] = useState<AdDispatch[] | null>(null);
  // R2 CO-SP-1 (Blocker) — a failed ledger read used to render "No live ad
  // dispatches yet", making real paused platform campaigns WITH BUDGETS
  // invisible while the empty copy asserted the false thing. A failure is a
  // failure; the round-1 comment at the top of this file names this exact
  // pattern for the campaigns list.
  const [dispatchesFailed, setDispatchesFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setDispatchesFailed(false);
    void listDispatches(campaign.id).then((d) => { if (live) setDispatches(d); }).catch(() => { if (live) { setDispatches(null); setDispatchesFailed(true); } });
    return () => { live = false; };
  }, [campaign.id]);

  const TARGETS: Record<string, { to: string; label: string } | undefined> = {
    landing_page: { to: '/cms', label: t('openCms') },
    email_sequence: { to: '/email', label: t('openEmail') },
    creative_briefs: { to: '/documents', label: t('openDocuments') },
    social_posts: { to: '/documents', label: t('openDocuments') },
  };

  return (
    <section className="surface-card u-mb-4">
      <div className="u-flex u-items-center u-gap-2 u-mb-1">
        <h3 className="u-m-0 u-flex-1">{t('launchTitle')}</h3>
        {campaign.version !== undefined ? <span className="chip chip--muted">{t('revisionLabel', { version: campaign.version })}</span> : null}
      </div>
      <p className="muted u-mt-0 u-fs-13">{t('launchHint')}</p>
      <ul className="u-list-none u-m-0 u-p-0">
        {campaign.channels.map((c) => {
          const target = TARGETS[c];
          return (
            <li key={c} className="list-row">
              <span className="list-row-name u-fw-600">{t(`channel_${c}`, { defaultValue: c })}</span>
              {c === 'ad_variants' ? (
                dispatchesFailed ? <Notice variant="error" announce={t('dispatchesFailed')}>{t('dispatchesFailed')}</Notice>
                : dispatches === null ? <span className="muted u-fs-13">{t('loadingDispatches')}</span>
                : dispatches.length === 0 ? <span className="muted u-fs-13">{t('noDispatches')}</span>
                : (
                  <ul className="u-list-none u-m-0 u-p-0" aria-label={t('dispatchListLabel')}>
                    {/* R2 / CO-R2-1 — the "Created paused" chip is a claim about
                        DISPATCH TIME, not a live platform read; say so once. */}
                    <li className="u-fs-13 muted u-py-1">{t('ledgerStatusHint')}</li>
                    {dispatches.map((d) => (
                      // ORCH-G2 — the ledger row carries the platform-side name,
                      // the DAILY BUDGET, the ad account and when it was
                      // dispatched. All four were dropped, leaving an opaque
                      // platform id as the only fact about a real, live (paused)
                      // ad campaign. The budget is money and the account is where
                      // to go act on it.
                      <li key={`${d.platform}:${d.platformCampaignId}`} className="u-py-1">
                        <span className="list-row-name-line">
                          <span className="chip chip--muted">{t(`platform_${d.platform}`, { defaultValue: d.platform })}</span>
                          <span className="chip chip--warning">{t('dispatchPaused')}</span>
                          {d.campaignName ? <span className="u-fs-13 u-fw-600">{d.campaignName}</span> : null}
                        </span>
                        <span className="list-row-name-line u-fs-13 muted">
                          {/* No currency rides the dispatch ledger, so the amount
                              renders as RAW MINOR UNITS and says so — a `/100`
                              here assumed 2-decimal currencies, so a JPY-class
                              account's budget showed 100× low under a label
                              vouching for the account's currency (review R2). */}
                          {d.dailyBudgetMinor !== undefined
                            ? <span>{t('dispatchDailyBudget', { amount: formatNumber(d.dailyBudgetMinor) })}</span>
                            : null}
                          <span>{t('dispatchCreated', { when: formatDateTime(d.createdAt) })}</span>
                          {d.adAccountId ? <span>{t('dispatchAccount', { account: d.adAccountId })}</span> : null}
                          {/* R2 CO-SP-8 — the ad-set and ad ids are the other
                              two-thirds of the platform address an operator
                              needs to act on this object. */}
                          <code>{d.platformCampaignId}</code>
                          {d.platformAdSetId ? <code>{d.platformAdSetId}</code> : null}
                          {d.platformAdId ? <code>{d.platformAdId}</code> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )
              ) : target ? (
                <span className="list-row-name-line">
                  <span className="chip chip--muted">{t('draftTarget')}</span>
                  <Link className="btn-link u-fs-13" to={target.to}>{target.label}</Link>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
