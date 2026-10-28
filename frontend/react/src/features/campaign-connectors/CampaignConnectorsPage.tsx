/**
 * Campaign Performance page (ADR 0159, Phase 3). Import ad-platform CSV exports
 * onto a unified metric schema and see KPI rollups per platform, on the shared ui/
 * cohesion layer. A distinct ad-metrics domain (spend/ROAS), NOT page analytics
 * (ADR 0018) — composed honestly, not forked. Live sync (Meta/Google) reads a
 * 7-day look-back through the acting user's connection (ADR 0907 D3).
 *
 * @see docs/adr/0159-campaign-studio-connectors-performance.md
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Modal } from '../../ui/Modal.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { TextField, TextareaField, SelectField } from '../../ui/Field.js';
import { ActivityIcon, PlusIcon } from '../../ui/icons/index.js';
import { formatNumber, formatCurrency, formatTime } from '../../i18n/format.js';
import {
  importCsv, getKpi, listOrgs, syncNow, AD_PLATFORMS, FeatureDisabledError,
  listPixels, upsertPixel, removePixel, PIXEL_PLATFORMS, type PixelConfig, type PixelPlatform,
  getSyncStatus, listConversions, dispatchConversions, getPlatformStatus, getConversionHealth, type LiveSyncPlatform, type ConversionHealth,
  type KpiSummary, type AdPlatform, type ImportResult, type OrgRef, type SyncResult,
} from './campaignConnectorsClient.js';
import { SyncSettingsCard } from './SyncSettingsCard.js';
import { CatalogFeedCard } from './CatalogFeedCard.js';

type TFn = ReturnType<typeof useTranslation>['t'];
const fmt = (n: number): string => formatNumber(Math.round(n));
// CMPUX-15: currency is threaded from the KPI read model (no hardcoded USD).
const money = (n: number, currency: string): string => formatCurrency(n, currency, { maximumFractionDigits: 0 });
// CC-G2 — when the org's campaigns span several currencies, `kpi.currency` is a
// neutral DEFAULT, not a fact, and there is no FX — so these totals are not in
// any single currency. Labelling them `$` states something false; an unlabelled
// figure plus a note does not.
// R2 CC-SP-2 — UNKNOWN currency (no evidence anywhere) renders unlabelled too:
// the size-0 branch used to claim `$` with confidence.
const orgMoney = (n: number, kpi: KpiSummary): string =>
  (kpi.currencyMixed === true || kpi.currencyKnown === false) ? formatNumber(Math.round(n)) : money(n, kpi.currency);
const roas = (n: number): string => `${formatNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`;

export function CampaignConnectorsPage(): JSX.Element {
  const { t } = useTranslation('campaign-connectors');
  const { t: tc } = useTranslation('common');
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [orgsFailed, setOrgsFailed] = useState(false);
  const [orgId, setOrgId] = useState('');
  const [kpi, setKpi] = useState<KpiSummary | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [lastImport, setLastImport] = useState<ImportResult | null>(null);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);
  const [syncBusy, setSyncBusy] = useState<LiveSyncPlatform | null>(null);
  // ADR 0907 D2 — only the readers the server says may read get a button.
  const [livePlatforms, setLivePlatforms] = useState<LiveSyncPlatform[]>([]);
  const [liveConversions, setLiveConversions] = useState<PixelPlatform[]>([]);
  // A failed read falls back to what is live on every backend — the ADR 0215
  // readers and the ADR 0297 Meta sender; an empty list would hide working
  // actions as if none existed.
  useEffect(() => {
    void getPlatformStatus()
      .then((s) => { setLivePlatforms(s.liveSync); setLiveConversions(s.liveConversions); })
      .catch(() => { setLivePlatforms(['meta', 'google']); setLiveConversions(['meta']); });
  }, []);

  const runSync = async (platform: LiveSyncPlatform): Promise<void> => {
    if (!orgId || syncBusy) return;
    setSyncBusy(platform);
    setError(null);
    try { setLastSync(await syncNow(orgId, platform)); await refresh(orgId); }
    catch (e) { setError(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setSyncBusy(null); }
  };

  // CC-R2-1 — the noOrg claim below must never ride a failed orgs read
  // (the BRAND-R2-1 shape, fixed cluster-wide this round).
  useEffect(() => { void listOrgs().then((o) => { setOrgs(o); setOrgsFailed(false); setOrgId((cur) => cur || o[0]?.orgId || ''); }).catch(() => setOrgsFailed(true)); }, []);

  // R2 CC-SP-11 — a failed KPI read left `kpi === null` forever = an eternal
  // "Loading…" beside the error notice. CC-SP-10 — a per-invocation guard (an
  // old org's slower read must not land under the new org) and a full reset so
  // the previous org's KPI/import/sync notices never present as the new org's.
  const [kpiFailed, setKpiFailed] = useState(false);
  // R2 CC-SP-13 — when each platform's live sync last landed (absent = never;
  // failure keeps it absent rather than claiming freshness).
  const [syncStatus, setSyncStatus] = useState<Array<{ platform: string; lastSyncAt: string }>>([]);
  const seqRef = useRef(0);
  const refresh = useCallback(async (org: string) => {
    const seq = ++seqRef.current;
    setKpi(null); setKpiFailed(false); setSyncStatus([]);
    if (!org) return;
    void getSyncStatus(org).then((s) => { if (seq === seqRef.current) setSyncStatus(s); }).catch(() => { /* freshness line stays absent */ });
    try { const k = await getKpi(org); if (seq === seqRef.current) { setKpi(k); setDisabled(false); setError(null); } } // a later success clears the sticky banner (review m1)
    catch (e) {
      if (seq !== seqRef.current) return;
      if (e instanceof FeatureDisabledError) { setDisabled(true); return; }
      setKpiFailed(true);
      setError(e instanceof Error ? e.message : t('actionFailed'));
    }
  }, [t, seqRef]);
  useEffect(() => {
    // Org switch: the previous org's notices are not facts about this org.
    setLastImport(null); setLastSync(null); setError(null);
    void refresh(orgId);
  }, [orgId, refresh]);

  if (disabled) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<ActivityIcon size={22} />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </div>
    );
  }

  return (
    <div data-walkthrough="campaign-performance.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')}
        actions={orgId ? (
          <div className="u-flex u-gap-2">
            {livePlatforms.map((p) => (
              <Button key={p} variant="secondary" size="sm" disabled={syncBusy !== null} aria-busy={syncBusy === p} onClick={() => void runSync(p)}>
                <ActivityIcon size={13} /> {syncBusy === p ? t('syncing') : t('syncPlatform', { platform: t(`platform_${p}`, { defaultValue: p }) })}
              </Button>
            ))}
            <Button variant="primary" size="sm" onClick={() => setImportOpen(true)}><PlusIcon size={13} /> {t('importCsv')}</Button>
          </div>
        ) : undefined} />
      {error ? <Notice variant="error">{error}</Notice> : null}
      {lastSync ? (
        <Notice variant={lastSync.outcome === 'synced' ? ((lastSync.failures?.length ?? 0) > 0 ? 'warning' : 'success') : 'info'}>
          {lastSync.outcome === 'synced'
            ? t('syncSummary', { since: lastSync.since ?? lastSync.date ?? '', until: lastSync.until ?? lastSync.date ?? '', campaigns: lastSync.campaigns ?? 0, imported: lastSync.imported ?? 0, deduped: lastSync.deduped ?? 0, failures: lastSync.failures?.length ?? 0 })
            : lastSync.outcome === 'cooldown'
              ? t('syncCooldown', { retryAt: lastSync.retryAtIso ? formatTime(lastSync.retryAtIso) : '' })
              : lastSync.outcome === 'no_accounts' ? t('syncNoAccounts')
                : lastSync.outcome === 'not_verified' ? t('syncNotVerified') : t('syncNoDispatches')}
          {lastSync.outcome === 'synced' && lastSync.truncated ? <p className="u-m-0 u-mt-1 u-fs-13">{t('syncTruncated')}</p> : null}
          {/* R2 CC-SP-5 — the failure REASONS were fetched and dropped; a
              count alone gives the operator nothing to act on. */}
          {(lastSync.failures?.length ?? 0) > 0 ? (
            <ul className="u-m-0 u-mt-1 u-fs-13">
              {lastSync.failures!.slice(0, 5).map((f, i) => <li key={`${f.adAccountId ?? f.platformCampaignId ?? ''}-${i}`}><code>{f.adAccountId ?? f.platformCampaignId}</code>: {f.reason}</li>)}
              {lastSync.failures!.length > 5 ? <li>{t('syncMoreFailures', { count: lastSync.failures!.length - 5 })}</li> : null}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      {lastImport ? (
        <Notice variant={lastImport.invalid > 0 ? 'warning' : 'success'}>
          {t('importedSummary', { imported: lastImport.imported, deduped: lastImport.deduped, invalid: lastImport.invalid })}
          {/* R2 CC-SP-4 — the per-row reasons were fetched and DISCARDED: a
              partial import said only "N skipped", leaving the operator to
              re-diff their own CSV. */}
          {lastImport.issues.length > 0 ? (
            <ul className="u-m-0 u-mt-1 u-fs-13">
              {lastImport.issues.slice(0, 8).map((i, idx) => (
                // row 0 = a once-per-import summary, not a real row (review nit).
                <li key={idx}>{i.row > 0 ? `${t(i.severity === 'error' ? 'importIssueError' : 'importIssueWarning', { row: i.row })} ` : ''}{i.message}</li>
              ))}
              {lastImport.issues.length > 8 ? <li>{t('importMoreIssues', { count: lastImport.issues.length - 8 })}</li> : null}
            </ul>
          ) : null}
        </Notice>
      ) : null}

      {orgs.length === 0 ? (
        orgsFailed ? (
          <StateCard announce icon={<ActivityIcon size={22} />} title={tc('loadFailedTitle')} body={tc('loadFailedBody')} />
        ) : (
        <StateCard icon={<ActivityIcon size={22} />} title={t('noOrgTitle')} body={t('noOrgBody')} />
        )
      ) : (
        <>
          {orgs.length > 1 ? (
            <div className="u-mb-4">
              <SelectField label={t('fieldOrg')} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
              </SelectField>
            </div>
          ) : null}

          {kpi !== null && kpi.currencyMixed === true ? <Notice variant="info">{t('currencyMixedNote')}</Notice> : null}
          {/* ADR 0907 D3 — a platform that cannot report revenue/conversions is
              left out of those totals and of ROAS/CPA; say so, never a silent 0. */}
          {kpi !== null && kpi.unreported && (kpi.unreported.revenue > 0 || kpi.unreported.conversions > 0)
            ? <Notice variant="info">{t('unreportedNote', { revenue: kpi.unreported.revenue, conversions: kpi.unreported.conversions })}</Notice> : null}
          {kpiFailed ? (
            <StateCard announce icon={<ActivityIcon size={22} />} title={tc('loadFailedTitle')} body={tc('loadFailedBody')}
              action={<Button variant="secondary" size="sm" onClick={() => void refresh(orgId)}>{tc('retry')}</Button>} />
          ) : kpi === null ? (
            <StateCard icon={<ActivityIcon size={20} />} title={t('loading')} loading />
          ) : kpi.recordCount === 0 ? (
            <StateCard icon={<ActivityIcon size={22} />} title={t('emptyTitle')} body={t('emptyBody')}
              action={<Button variant="primary" size="sm" onClick={() => setImportOpen(true)}><PlusIcon size={13} /> {t('importCsv')}</Button>} />
          ) : (
            <>
              <div className="u-flex u-gap-3 u-mb-4 u-flex-wrap">
                <KpiCard label={t('kpiSpend')} value={orgMoney(kpi.totals.spend, kpi)} />
                <KpiCard label={t('kpiImpressions')} value={fmt(kpi.totals.impressions)} />
                <KpiCard label={t('kpiClicks')} value={fmt(kpi.totals.clicks)} />
                <KpiCard label={t('kpiConversions')} value={fmt(kpi.totals.conversions)} />
                <KpiCard label={t('kpiRevenue')} value={orgMoney(kpi.totals.revenue, kpi)} />
                <KpiCard label={t('kpiRoas')} value={roas(kpi.totals.roas)} />
              </div>

              <section className="surface-card">
                <h2 className="u-mt-0 u-fs-15">{t('byPlatformTitle')}</h2>
                <div className="table-scroll table--stack">
                <table className="u-w-full">
                  <thead>
                    <tr className="muted u-fs-13">
                      <th scope="col" className="u-text-left u-py-2">{t('colPlatform')}</th>
                      <th scope="col" className="u-text-right u-py-2">{t('kpiSpend')}</th>
                      <th scope="col" className="u-text-right u-py-2">{t('kpiClicks')}</th>
                      <th scope="col" className="u-text-right u-py-2">{t('kpiConversions')}</th>
                      <th scope="col" className="u-text-right u-py-2">{t('kpiRoas')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kpi.byPlatform.map((p) => (
                      <tr key={p.platform}>
                        <td className="u-py-2"><span className="data-stack-label">{t('colPlatform')}</span><span className="chip chip--muted">{t(`platform_${p.platform}`, { defaultValue: p.platform })}</span></td>
                        <td className="u-text-right u-py-2"><span className="data-stack-label">{t('kpiSpend')}</span>{orgMoney(p.spend, kpi)}</td>
                        <td className="u-text-right u-py-2"><span className="data-stack-label">{t('kpiClicks')}</span>{fmt(p.clicks)}</td>
                        <td className="u-text-right u-py-2"><span className="data-stack-label">{t('kpiConversions')}</span>{fmt(p.conversions)}</td>
                        <td className="u-text-right u-py-2"><span className="data-stack-label">{t('kpiRoas')}</span>{roas(p.roas)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                {kpi.dateRange ? <p className="u-fs-13 muted u-mt-3">{t('dateRange', { start: kpi.dateRange.start, end: kpi.dateRange.end, count: kpi.recordCount })}</p> : null}
                {/* R2 CC-SP-13 — freshness: a broken sync must not look active. */}
                {syncStatus.length > 0 ? (
                  <p className="u-fs-13 muted u-mt-1 u-mb-0">
                    {t('lastSyncedLine', { platforms: syncStatus.map((s) => `${t(`platform_${s.platform}`, { defaultValue: s.platform })} ${formatTime(s.lastSyncAt)}`).join(' · ') })}
                  </p>
                ) : null}
              </section>

              <PixelsCard orgId={orgId} liveConversions={liveConversions} />
            </>
          )}
          {/* ADR 0907 D3 — outside the KPI branch: an org with no rows yet is
              exactly the one that needs to point the sync at its ad account. */}
          {kpi !== null || kpiFailed ? <SyncSettingsCard orgId={orgId} platforms={livePlatforms} onSynced={() => void refresh(orgId)} /> : null}
          {/* ADR 0952 D6 — the product feed from the commerce catalog. */}
          {kpi !== null || kpiFailed ? <CatalogFeedCard orgId={orgId} /> : null}
        </>
      )}

      {importOpen ? (
        <ImportModal t={t} orgId={orgId}
          onClose={() => setImportOpen(false)}
          onDone={async (r) => { setImportOpen(false); setLastImport(r); await refresh(orgId); }}
          onError={setError} />
      ) : null}
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="surface-card u-flex-1">
      <div className="u-fs-13 muted">{label}</div>
      <div className="u-fw-600 u-fs-18">{value}</div>
    </div>
  );
}

function ImportModal({ t, orgId, onClose, onDone, onError }: { t: TFn; orgId: string; onClose: () => void; onDone: (r: ImportResult) => void; onError: (m: string) => void }): JSX.Element {
  const [csv, setCsv] = useState('');
  const [platform, setPlatform] = useState<AdPlatform>('google');
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    setBusy(true);
    try { onDone(await importCsv(orgId, csv, platform)); }
    catch (e) { onError(e instanceof Error ? e.message : t('actionFailed')); setBusy(false); }
  };
  return (
    <Modal label={t('importCsv')} onClose={onClose} showClose>
      <h2 className="u-mt-0">{t('importCsv')}</h2>
      <p className="muted">{t('importHint')}</p>
      <form onSubmit={(e) => { e.preventDefault(); if (csv.trim() && !busy) void submit(); }}>
        <SelectField label={t('defaultPlatform')} value={platform} onChange={(e) => setPlatform(e.target.value as AdPlatform)}>
          {AD_PLATFORMS.map((p) => <option key={p} value={p}>{t(`platform_${p}`, { defaultValue: p })}</option>)}
        </SelectField>
        <TextareaField label={t('csvLabel')} help={t('csvHelp')} value={csv} rows={8} onChange={(e) => setCsv(e.target.value)} required />
        <div className="action-bar u-flex u-gap-2 u-justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>{t('common:cancel')}</Button>
          <Button type="submit" variant="primary" size="sm" disabled={!csv.trim() || busy}>{t('import')}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** ADR 0297 D1 / FNL-UX-3 — per-org pixel configs (Meta/Google/TikTok). The
 *  PUBLIC read is marketing-consent-gated server-side; this card is the
 *  operator config surface. */
/** `event = customers/<cid>/conversionActions/<id>` lines → map; bad lines are
 *  returned so the form can say which, rather than dropping them silently. */
function parseActionLines(text: string): { map: Record<string, string>; bad: string[] } {
  const map: Record<string, string> = {};
  const bad: string[] = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^([^=]+?)\s*=\s*(customers\/\d+\/conversionActions\/\d+)$/.exec(line);
    if (m) map[m[1]!.trim()] = m[2]!; else bad.push(line);
  }
  return { map, bad };
}

function PixelsCard({ orgId, liveConversions }: { orgId: string; liveConversions: readonly PixelPlatform[] }): JSX.Element | null {
  const { t } = useTranslation('campaign-connectors');
  const [pixels, setPixels] = useState<PixelConfig[] | null>(null);
  const [platform, setPlatform] = useState<PixelPlatform>('meta');
  const [pixelId, setPixelId] = useState('');
  // ADR 0907 D5 — Google conversions upload to a customer, per conversion action.
  const [googleCustomerId, setGoogleCustomerId] = useState('');
  const [actionLines, setActionLines] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // R2 CC-SP-1 — a failed pixels read rendered "No pixels configured." as fact
  // (the flagship FAILED-READ-AS-EMPTY). CC-SP-10 — latest-wins across org
  // switches.
  const [pixelsFailed, setPixelsFailed] = useState(false);
  // R2 CC-SP-6 — the conversions relay queue was write-only: publicly-accepted
  // conversions queued with NO dispatch consumer anywhere, waited forever, and
  // then the retention purge silently dropped user-submitted data. Depth shown
  // + a real Dispatch action over the existing route.
  const [queuedCount, setQueuedCount] = useState<number | null>(null);
  // ADR 0907 D7 — per-platform delivery health; `null` = not loaded or failed
  // (the card is simply absent then — never a fabricated all-clear).
  const [health, setHealth] = useState<ConversionHealth | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    if (!orgId) return;
    const seq = ++loadSeq.current;
    setPixelsFailed(false);
    void listConversions(orgId)
      .then((c) => { if (seq === loadSeq.current) { const q = c.filter((x) => x.status === 'queued').length; setQueuedCount(c.length >= 200 ? Math.max(q, 200) : q); } }) // the read caps at 200 — never claim an exact count past it
      .catch(() => { if (seq === loadSeq.current) setQueuedCount(null); }); // absent, never a false zero
    void getConversionHealth(orgId)
      .then((h) => { if (seq === loadSeq.current) setHealth(h); })
      .catch(() => { if (seq === loadSeq.current) setHealth(null); });
    try { const rows = await listPixels(orgId); if (seq === loadSeq.current) setPixels(rows); }
    catch { if (seq === loadSeq.current) { setPixels([]); setPixelsFailed(true); } }
  }, [orgId]);
  useEffect(() => { setPixels(null); setQueuedCount(null); setHealth(null); void load(); }, [load]);

  const runDispatch = async (): Promise<void> => {
    if (dispatching) return;
    setDispatching(true);
    setSaveError(null);
    try {
      const { sent, dropped = 0, held = 0, expired = 0 } = await dispatchConversions(orgId);
      // R2 review fold-in (M2) — `sent: 0` is NOT a success: it means every
      // send failed or no dispatchable pixel matched. A success toast here was
      // the failed-as-success family on the surface this round added.
      if (sent > 0) toast.success(t('conversionsDispatched', { count: sent }));
      else toast.info(t('conversionsDispatchedNone'));
      // ADR 0907 D7 — rows the consent re-check stopped are reported, not hidden.
      if (dropped > 0 || held > 0) toast.info(t('conversionsConsentOutcome', { dropped, held }));
      if (expired > 0) toast.info(t('conversionHealthExpired', { count: expired }));
      await load();
    }
    catch (e) { setSaveError(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setDispatching(false); }
  };

  const save = async (): Promise<void> => {
    if (!pixelId.trim() || busy) return;
    let googleFields: { googleCustomerId?: string; conversionActions?: Record<string, string> | null } = {};
    if (platform === 'google') {
      const { map, bad } = parseActionLines(actionLines);
      if (bad.length > 0) { setSaveError(t('conversionActionsBadLines', { lines: bad.slice(0, 3).join('; ') })); return; }
      googleFields = { ...(googleCustomerId.trim() ? { googleCustomerId: googleCustomerId.trim() } : {}), conversionActions: Object.keys(map).length > 0 ? map : null };
    }
    setBusy(true);
    setSaveError(null);
    try { await upsertPixel(orgId, { platform, pixelId: pixelId.trim(), ...googleFields }); setPixelId(''); setGoogleCustomerId(''); setActionLines(''); await load(); }
    catch (e) { setSaveError(e instanceof Error ? e.message : t('actionFailed')); } // GT-2: never swallow a failed save
    finally { setBusy(false); }
  };

  const remove = async (px: PixelConfig): Promise<void> => {
    const platformName = t(`platform_${px.platform}`, { defaultValue: px.platform });
    if (!(await confirm({ title: t('removePixelConfirm', { platform: platformName }), body: t('removePixelConfirmBody'), danger: true, confirmLabel: t('common:delete') }))) return;
    setBusy(true);
    setSaveError(null);
    try { await removePixel(orgId, px.platform); await load(); }
    catch (e) { setSaveError(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  };

  if (!orgId) return null;
  return (
    <section className="surface-card u-mt-4">
      <h2 className="u-mt-0 u-fs-15">{t('pixelsTitle')}</h2>
      <p className="muted u-fs-13">{t('pixelsHint')}</p>
      <form className="u-flex u-gap-2 u-items-end u-flex-wrap" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <SelectField label={t('pixelPlatform')} value={platform} onChange={(e) => setPlatform(e.target.value as PixelPlatform)}>
          {PIXEL_PLATFORMS.map((pf) => <option key={pf} value={pf}>{t(`platform_${pf}`, { defaultValue: pf })}</option>)}
        </SelectField>
        <TextField
          label={t('pixelIdLabel')}
          help={t('pixelIdHelp')}
          value={pixelId}
          onChange={(e) => setPixelId(e.target.value)}
          placeholder={t('pixelIdPlaceholder')}
          autoComplete="off"
          spellCheck={false}
        />
        {platform === 'google' ? (
          <>
            <TextField label={t('googleCustomerIdLabel')} help={t('googleCustomerIdHelp')} value={googleCustomerId}
              onChange={(e) => setGoogleCustomerId(e.target.value)} autoComplete="off" spellCheck={false} />
            <TextareaField label={t('conversionActionsMapLabel')} help={t('conversionActionsMapHelp')} value={actionLines} rows={3}
              onChange={(e) => setActionLines(e.target.value)} spellCheck={false} />
          </>
        ) : null}
        <Button type="submit" variant="primary" size="sm" disabled={busy || !pixelId.trim()}>{t('savePixel')}</Button>
      </form>
      {saveError ? <p className="field-error u-mt-2" role="alert">{saveError}</p> : null}
      {pixelsFailed ? (
        <p className="muted u-fs-13 u-mt-3 u-mb-0" role="alert">{t('pixelsLoadFailed')}</p>
      ) : pixels && pixels.length > 0 ? (
        <ul className="u-m-0 u-mt-3">
          {pixels.map((px) => (
            <li key={px.platform} className="u-flex u-items-center u-gap-2">
              <span className="chip chip--muted">{t(`platform_${px.platform}`, { defaultValue: px.platform })}</span>
              <code>{px.pixelId}</code>
              {/* R2 CC-SP-12 — `active` was fetched and discarded: an inactive
                  pixel rendered identically to a live one. */}
              {px.active === false ? <span className="chip chip--warning">{t('pixelInactive')}</span> : null}
              {px.platform === 'google' ? (
                <span className="muted u-fs-13">{t('googleActionsMapped', { count: Object.keys(px.conversionActions ?? {}).length })}</span>
              ) : null}
              {/* ADR 0907 D2 — a pixel whose conversion sender is not verified yet
                  receives no server-side conversions; say so beside it. */}
              {!liveConversions.includes(px.platform) ? <span className="chip chip--muted">{t('conversionsNotVerified')}</span> : null}
              {/* CC-G1 — removing a pixel silently stops conversion tracking for
                  that platform, outward-facing and easy not to notice. It had
                  neither a confirmation nor a catch: a failed delete left the row
                  in place with no message, right beside a save handler whose own
                  comment reads "never swallow a failed save". */}
              <Button variant="quiet" disabled={busy} onClick={() => void remove(px)} aria-label={t('removePixelLabel', { platform: px.platform })}>{t('common:delete')}</Button>
            </li>
          ))}
        </ul>
      ) : <p className="muted u-fs-13 u-mt-3 u-mb-0">{t('noPixels')}</p>}
      {queuedCount !== null && queuedCount > 0 ? (
        <div className="u-flex u-items-center u-gap-2 u-mt-3">
          <span className="chip chip--warning">{t('conversionsQueued', { count: queuedCount })}</span>
          {/* R2 review fold-in (M2) — the dispatch route only sends through the
              conversion senders that are LIVE (ADR 0907 D2: Meta, plus TikTok /
              Google once verified); without one the button "succeeded" with 0
              sent. The predicate is the server's own list. */}
          <Button variant="secondary" size="sm"
            disabled={dispatching || !(pixels ?? []).some((p) => p.active !== false && liveConversions.includes(p.platform))}
            aria-busy={dispatching} onClick={() => void runDispatch()}>
            {dispatching ? t('dispatching') : t('dispatchConversionsCta')}
          </Button>
        </div>
      ) : null}
      {health && health.platforms.some((p) => p.configured) ? (
        <div className="u-mt-3">
          <h3 className="u-fs-14 u-mb-1">{t('conversionHealthTitle')}</h3>
          <p className="muted u-fs-13 u-mt-0">{t('conversionHealthHint')}{health.capped ? ` ${t('conversionHealthCapped')}` : ''}</p>
          {(health.expired ?? 0) > 0 ? <p className="u-fs-13 u-mt-0">{t('conversionHealthExpired', { count: health.expired })}</p> : null}
          <ul className="u-m-0">
            {health.platforms.filter((p) => p.configured).map((p) => (
              <li key={p.platform} className="u-flex u-items-center u-gap-2 u-flex-wrap u-fs-13">
                <span className="chip chip--muted">{t(`platform_${p.platform}`, { defaultValue: p.platform })}</span>
                {p.live
                  ? <span>{t('conversionHealthCounts', { delivered: p.delivered, pending: p.pending })}</span>
                  : <span className="muted">{t('conversionsNotVerified')}</span>}
                {p.lastError ? <span className="chip chip--warning" title={p.lastError.error}>{t('conversionHealthLastError', { error: p.lastError.error, at: formatTime(p.lastError.at) })}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

