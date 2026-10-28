/**
 * The campaign detail page (ADR 0941 D5): deep-linkable at
 * `/campaign-studio/campaigns/:campaignId`, the shell the program's per-campaign
 * surfaces (the ADR 0960 cockpit) grow into. It moved here from an in-page view on
 * the campaigns list (ADR 0158 Phase 3), keeping every fact that view showed, and
 * adds the ADR 0941 P1/P2 reads: the linked catalog products (with a picker over
 * the campaign org's commerce catalog), the attention flags, and the links read.
 *
 * Honest states throughout (DESIGN.md §4.6): a failed read is a failure, a
 * feature that is off says so, and neither is ever drawn as "nothing linked".
 *
 * @see docs/adr/0941-campaign-studio-program-and-canonical-campaign.md
 */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { InlineState } from '../../ui/InlineState.js';
import { Modal } from '../../ui/Modal.js';
import { SelectField } from '../../ui/Field.js';
import { useFeatureVisible } from '../../featureToggles/FeatureAccessContext.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { formatCurrencyMinor, formatDateTime, formatNumber } from '../../i18n/format.js';
import { ArrowLeftIcon, MegaphoneIcon, PackageIcon, SparklesIcon } from '../../ui/icons/index.js';
import { listProducts, type Product } from '../commerce/commerceClient.js';
import { CampaignLedgerSection } from './CampaignLedgerSection.js';
import { StatusChip } from './CampaignStatusChip.js';
import {
  getCampaign, getCampaignLinks, updateCampaign, listOrgs, listDispatches,
  FeatureDisabledError, CAMPAIGN_STATUSES, CAMPAIGN_STRATEGIST_AGENT,
  type MarketingCampaign, type CampaignStatus, type AdDispatch, type CampaignLinks, type CampaignProductRef, type LinkSection,
} from './campaignStudioClient.js';

const CommandSection = lazy(() => import('./CommandSection.js').then((m) => ({ default: m.CommandSection })));
const CampaignVariantsSection = lazy(() => import('./CampaignVariantsSection.js').then((m) => ({ default: m.CampaignVariantsSection })));
const AutopilotSection = lazy(() => import('../campaign-autopilot/AutopilotSection.js').then((m) => ({ default: m.AutopilotSection })));
const AutonomyPolicyPanel = lazy(() => import('./autonomy/AutonomyPolicyPanel.js'));
const VetoWindowsSection = lazy(() => import('./autonomy/VetoWindowsSection.js'));

type TFn = ReturnType<typeof useTranslation>['t'];

export function CampaignDetailPage(): JSX.Element {
  const { campaignId = '' } = useParams();
  return <CampaignDetail key={campaignId} campaignId={campaignId} />;
}

// A new route gets a new state owner. Late responses from the previous
// campaign can only settle its unmounted instance, never the current page.
function CampaignDetail({ campaignId }: { campaignId: string }): JSX.Element {
  const { t } = useTranslation('campaign-orchestration');
  const { t: tc } = useTranslation('common');
  const navigate = useNavigate();
  const featureVisible = useFeatureVisible();
  const [campaign, setCampaign] = useState<MarketingCampaign | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'failed' | 'disabled'>('loading');
  const { orgs, orgsFailed, retry: retryOrgs } = useOrgSelection(listOrgs, state === 'ready');
  const orgName = orgs?.find((org) => org.orgId === campaign?.orgId)?.name;
  const [parentName, setParentName] = useState<string | undefined>(undefined);
  const [links, setLinks] = useState<CampaignLinks | null>(null);
  const [linksFailed, setLinksFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLinks = useCallback(async (id: string) => {
    setLinksFailed(false);
    try { setLinks(await getCampaignLinks(id)); } catch { setLinks(null); setLinksFailed(true); }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const c = await getCampaign(campaignId);
      setCampaign(c); setState('ready');
      void loadLinks(c.id);
      if (c.parentCampaignId) void getCampaign(c.parentCampaignId).then((p) => setParentName(p.name)).catch(() => setParentName(undefined));
    } catch (e) {
      if (e instanceof FeatureDisabledError) { setState('disabled'); return; }
      // The route answers a missing campaign and one the caller cannot read with
      // the same 404; this page says "not found" for both and "failed" for the rest.
      setState(e instanceof Error && /not found/i.test(e.message) ? 'missing' : 'failed');
    }
  }, [campaignId, loadLinks]);
  useEffect(() => { void load(); }, [load]);

  const back = (): void => { void navigate('/campaigns'); };
  const run = (): void => { void navigate(`/?agent=${encodeURIComponent(CAMPAIGN_STRATEGIST_AGENT)}`); };

  if (state === 'loading') return <StateCard icon={<MegaphoneIcon size={20} />} title={t('loadingCampaign')} loading />;
  if (state === 'disabled') return <StateCard icon={<MegaphoneIcon size={22} />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  if (state === 'missing' || state === 'failed' || !campaign) {
    return (
      <StateCard announce={state === 'failed'} icon={<MegaphoneIcon size={22} />}
        title={state === 'missing' ? t('campaignNotFoundTitle') : tc('loadFailedTitle')}
        body={state === 'missing' ? t('campaignNotFoundBody') : tc('loadFailedBody')}
        action={<Button variant="secondary" size="sm" onClick={back}><ArrowLeftIcon size={14} /> {t('backToCampaigns')}</Button>} />
    );
  }

  return (
    <div>
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      <CampaignHeader t={t} campaign={campaign} onBack={back} onRun={run} onChanged={(c) => setCampaign(c)} onError={setError} />
      {/* R2 CO-SP-8 — facts the payload already carried and the detail threw
          away: objective, org, dates, the (cycle-checked!) parent reference.
          CO-SP-7 — the planned budget, WITH its ISO currency when recorded
          (formatCurrencyMinor derives the currency's own decimals, so JPY-class
          amounts don't misrender 100×); labeled bare when currency is absent. */}
      {campaign.objective ? <p className="muted u-mt-0">{campaign.objective}</p> : null}
      {orgsFailed ? <InlineState kind="failed" message={t('orgNameFailed')} announce={t('orgNameFailed')} announcePolite
        action={<Button variant="link" size="sm" onClick={retryOrgs}>{tc('retry')}</Button>} /> : null}
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
          <div className="u-flex u-items-center u-gap-2 u-mb-2"><SparklesIcon size={16} aria-hidden /> <h2 className="u-m-0 u-fs-16">{t('kernelTitle')}</h2></div>
          <p className="u-fw-600 u-mb-1">{campaign.kernel.headline}</p>
          <p className="muted u-mt-0">{campaign.kernel.supportingStatement}</p>
          {campaign.kernel.proofPoints.length ? <ul>{campaign.kernel.proofPoints.map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
          <p className="u-fs-13"><strong>{t('kernelCta')}:</strong> {campaign.kernel.primaryCta} · <strong>{t('kernelTone')}:</strong> {campaign.kernel.tone}</p>
        </section>
      ) : (
        <Notice variant="info">{t('noKernel')} <Button variant="link" onClick={run}>{t('runWithStrategist')}</Button></Notice>
      )}

      <section className="surface-card u-mb-4">
        <h2 className="u-mt-0 u-fs-16">{t('channelsTitle')}</h2>
        {campaign.channels.length === 0 ? <p className="muted">{t('noChannels')}</p> : (
          <div className="list-row-name-line">{campaign.channels.map((c) => <span key={c} className="chip chip--muted">{t(`channel_${c}`, { defaultValue: c })}</span>)}</div>
        )}
      </section>


      <AttentionNotice t={t} campaign={campaign} onChanged={(c) => setCampaign(c)} onError={setError} />

      <ProductsSection t={t} campaign={campaign} links={links} linksFailed={linksFailed}
        onSaved={(c) => { setCampaign(c); void loadLinks(c.id); }} onRetry={() => void loadLinks(campaign.id)} />

      <Suspense fallback={<InlineState kind="loading" message={tc('loading')} />}>
        <VetoWindowsSection campaignId={campaign.id} />
        <AutonomyPolicyPanel scope={{ kind: 'campaign', campaignId: campaign.id }} />
      </Suspense>

      {featureVisible('campaign-autopilot') ? <Suspense fallback={null}><AutopilotSection key={campaign.id} campaignId={campaign.id} /></Suspense> : null}
      <Suspense fallback={null}><CommandSection key={campaign.id} campaignId={campaign.id} /></Suspense>
      {featureVisible('campaign-orchestration.variant-factory') ? <Suspense fallback={null}><CampaignVariantsSection key={campaign.id} campaignId={campaign.id} /></Suspense> : null}
      <CampaignLedgerSection campaignId={campaign.id} />

      <LaunchState t={t} campaign={campaign} />

      <LinkedWork t={t} links={links} linksFailed={linksFailed} onRetry={() => void loadLinks(campaign.id)} />
    </div>
  );
}

function CampaignHeader({ t, campaign, onBack, onRun, onChanged, onError }: { t: TFn; campaign: MarketingCampaign; onBack: () => void; onRun: () => void; onChanged: (c: MarketingCampaign) => void; onError: (m: string) => void }): JSX.Element {
  const [statusBusy, setStatusBusy] = useState(false);
  const setStatus = async (status: CampaignStatus): Promise<void> => {
    if (statusBusy) return;
    setStatusBusy(true);
    try { onChanged(await updateCampaign(campaign.id, { status })); }
    catch (e) { onError(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setStatusBusy(false); }
  };
  return (
    <div className="action-bar u-flex u-items-center u-gap-2 u-mb-4">
      <Button variant="quiet" size="sm" onClick={onBack}><ArrowLeftIcon size={14} /> {t('backToCampaigns')}</Button>
      <h1 className="u-m-0 u-flex-1 u-fs-18">{campaign.name}</h1>
      <StatusChip status={campaign.status} t={t} />
      <SelectField label={t('statusLabel')} disabled={statusBusy} value={campaign.status} onChange={(e) => void setStatus(e.target.value as CampaignStatus)} className="u-mb-0">
        {CAMPAIGN_STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
      </SelectField>
      <Button variant="primary" size="sm" onClick={onRun}><SparklesIcon size={13} /> {t('runWithStrategist')}</Button>
    </div>
  );
}

/** ADR 0941 D3 — the flags the system raised (a linked product was deleted). */
function AttentionNotice({ t, campaign, onChanged, onError }: { t: TFn; campaign: MarketingCampaign; onChanged: (c: MarketingCampaign) => void; onError: (m: string) => void }): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const flags = campaign.attention ?? [];
  if (flags.length === 0) return null;
  const dismiss = async (): Promise<void> => {
    setBusy(true);
    try { onChanged(await updateCampaign(campaign.id, { attention: [] })); }
    catch (e) { onError(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  };
  return (
    <Notice variant="warning">
      <p className="u-m-0 u-fw-600">{t('attentionTitle', { count: flags.length })}</p>
      <ul className="u-mt-1 u-mb-2">
        {flags.map((f) => <li key={`${f.reason}:${f.productId}`}>{t('attention_product_deleted', { productId: f.productId, when: formatDateTime(f.at) })}</li>)}
      </ul>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void dismiss()}>{t('attentionDismiss')}</Button>
    </Notice>
  );
}

/** ADR 0941 D3 — the catalog products this campaign sells, with a picker over
 *  the campaign org's commerce catalog. The server re-checks every ref. */
function ProductsSection({ t, campaign, links, linksFailed, onSaved, onRetry }: { t: TFn; campaign: MarketingCampaign; links: CampaignLinks | null; linksFailed: boolean; onSaved: (c: MarketingCampaign) => void; onRetry: () => void }): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const section = links?.products;
  return (
    <section className="surface-card u-mb-4" aria-labelledby="campaign-products-title">
      <div className="u-flex u-items-center u-gap-2 u-mb-2">
        <PackageIcon size={16} aria-hidden />
        <h2 id="campaign-products-title" className="u-m-0 u-flex-1 u-fs-16">{t('productsTitle')}</h2>
        {section?.status !== 'unavailable' ? <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>{t('productsEdit')}</Button> : null}
      </div>
      {linksFailed || section?.status === 'failed' ? (
        <InlineState kind="failed" message={t('productsFailed')} action={<Button variant="link" onClick={onRetry}>{t('retry')}</Button>} />
      ) : !section ? (
        <InlineState kind="loading" />
      ) : section.status === 'unavailable' ? (
        <p className="muted u-m-0">{t('productsCommerceOff')}</p>
      ) : section.items.length === 0 ? (
        <InlineState kind="empty" message={t('productsEmpty')} />
      ) : (
        <ul className="u-list-none u-m-0 u-p-0">
          {section.items.map((p) => (
            <li key={p.productId} className="list-row">
              <span className="list-row-name u-fw-600">{p.state === 'linked' ? p.name : p.productId}</span>
              <span className="list-row-name-line">
                <span className={`chip ${p.role === 'primary' ? 'chip--accent' : 'chip--muted'}`}>{t(`productRole_${p.role}`)}</span>
                {p.state === 'missing' ? <span className="chip chip--warning">{t('linkMissing')}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {pickerOpen ? <ProductPicker t={t} campaign={campaign} onClose={() => setPickerOpen(false)} onSaved={(c) => { setPickerOpen(false); onSaved(c); }} /> : null}
    </section>
  );
}

type RoleChoice = '' | CampaignProductRef['role'];

function ProductPicker({ t, campaign, onClose, onSaved }: { t: TFn; campaign: MarketingCampaign; onClose: () => void; onSaved: (c: MarketingCampaign) => void }): JSX.Element {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, RoleChoice>>(() =>
    Object.fromEntries((campaign.productRefs ?? []).map((r) => [r.productId, r.role])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // The catalog of the CAMPAIGN's org: a product of another client cannot be linked.
    void listProducts(campaign.orgId)
      .then((p) => { if (live) setProducts(p); })
      .catch(() => { if (live) { setProducts([]); setLoadError(t('productsCatalogFailed')); } });
    return () => { live = false; };
  }, [campaign.orgId, t]);
  const refs: CampaignProductRef[] = Object.entries(choice)
    .filter((e): e is [string, CampaignProductRef['role']] => e[1] === 'primary' || e[1] === 'secondary')
    .map(([productId, role]) => ({ productId, role }));
  const primaries = refs.filter((r) => r.role === 'primary').length;
  const save = async (): Promise<void> => {
    if (primaries > 1) { setError(t('productsOnePrimary')); return; }
    setBusy(true); setError(null);
    try { onSaved(await updateCampaign(campaign.id, { productRefs: refs })); }
    catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); setBusy(false); }
  };
  return (
    <Modal label={t('productsPickerTitle')} onClose={() => { if (!busy) onClose(); }} showClose error={error ?? loadError}>
      <h2 className="u-mt-0">{t('productsPickerTitle')}</h2>
      <p className="muted">{t('productsPickerHint')}</p>
      <form onSubmit={(e) => { e.preventDefault(); if (!busy) void save(); }}>
        {products === null ? <InlineState kind="loading" />
          : products.length === 0 && !loadError ? <InlineState kind="empty" message={t('productsCatalogEmpty')} />
          : (
            <ul className="u-list-none u-m-0 u-p-0">
              {products.map((p) => (
                <li key={p.productId} className="list-row">
                  <span className="list-row-name">{p.name}</span>
                  <SelectField label={t('productsRoleFor', { name: p.name })} value={choice[p.productId] ?? ''} className="u-mb-0"
                    onChange={(e) => setChoice((cur) => ({ ...cur, [p.productId]: e.target.value as RoleChoice }))}>
                    <option value="">{t('productRole_none')}</option>
                    <option value="primary">{t('productRole_primary')}</option>
                    <option value="secondary">{t('productRole_secondary')}</option>
                  </SelectField>
                </li>
              ))}
            </ul>
          )}
        {primaries > 1 ? <p className="u-fs-13" role="alert">{t('productsOnePrimary')}</p> : null}
        <div className="action-bar u-flex u-gap-2 u-justify-end">
          <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>{t('common:cancel')}</Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy || products === null || primaries > 1}>{t('productsSave')}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** ADR 0941 D1/P2 — the records that point up at this campaign, read through
 *  each owner. Each row says linked, off, or failed; never a silent empty. */
function LinkedWork({ t, links, linksFailed, onRetry }: { t: TFn; links: CampaignLinks | null; linksFailed: boolean; onRetry: () => void }): JSX.Element {
  type Row = { key: string; label: string; section: LinkSection<unknown> | undefined; names: (s: { items: unknown[] }) => string[] };
  const rows: Row[] = links ? [
    // The funnels section arrives with ADR 0948 (the funnel owns the edge); no row until the host sends it.
    ...(links.funnels ? [{ key: 'funnels', label: t('linksFunnels'), section: links.funnels, names: () => links.funnels?.status === 'ok' ? links.funnels.items.map((f) => f.state === 'linked' ? (f.name ?? f.funnelId) : t('linkMissingNamed', { id: f.funnelId })) : [] }] : []),
    { key: 'plans', label: t('linksPlans'), section: links.plans, names: () => [] },
    { key: 'emailSends', label: t('linksEmailSends'), section: links.emailSends, names: () => [] },
    { key: 'adDispatches', label: t('linksAdDispatches'), section: links.adDispatches, names: () => [] },
    { key: 'opsAssets', label: t('linksOpsAssets'), section: links.opsAssets, names: () => links.opsAssets.status === 'ok' ? links.opsAssets.items.map((a) => a.label) : [] },
    { key: 'runs', label: t('linksRuns'), section: links.runs, names: () => [] },
  ] : [];
  return (
    <section className="surface-card u-mb-4" aria-labelledby="campaign-links-title">
      <h2 id="campaign-links-title" className="u-mt-0 u-fs-16">{t('linksTitle')}</h2>
      {linksFailed ? <InlineState kind="failed" message={t('linksFailed')} action={<Button variant="link" onClick={onRetry}>{t('retry')}</Button>} />
        : !links ? <InlineState kind="loading" />
        : (
          <ul className="u-list-none u-m-0 u-p-0">
            {rows.map((r) => (
              <li key={r.key} className="list-row">
                <span className="list-row-name u-fw-600">{r.label}</span>
                <span className="list-row-name-line u-fs-13">
                  {r.section?.status === 'ok' ? (
                    <>
                      <span className="chip chip--muted">{t('linksCount', { count: r.section.items.length })}</span>
                      {r.names(r.section).slice(0, 3).map((n) => <span key={n} className="muted">{n}</span>)}
                      {r.key === 'plans' && links.plans.status === 'ok' ? links.plans.items.slice(0, 3).map((p) => (
                        <Link key={p.canvasId} className="btn-link" to={`/campaign-studio/plans/${encodeURIComponent(p.canvasId)}`}>{t('linksOpenPlan')}</Link>
                      )) : null}
                    </>
                  ) : r.section?.status === 'unavailable' ? <span className="muted">{t('linksFeatureOff')}</span>
                    : <span className="chip chip--danger">{t('linksSectionFailed')}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
    </section>
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
        <h2 className="u-m-0 u-flex-1 u-fs-16">{t('launchTitle')}</h2>
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
