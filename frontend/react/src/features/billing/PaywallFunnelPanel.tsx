/**
 * Paywall funnel (monetization strategy §8) — the operator's per-bundle view of
 * lock views → upgrade clicks → plan refusals → checkouts started → completed →
 * active grants, across every workspace, over 7, 30 or 90 UTC days, under a
 * "This week vs last week" header (`GET …/admin/funnel/weekly`, the same numbers
 * the operator's weekly notice sends).
 *
 * Superadmin only: `BillingPage` renders it only for a superadmin, and the read
 * (`GET …/billing/admin/funnel`) refuses anyone else server-side. Lazy-loaded
 * (its own chunk); strings live in the lazy `billing` namespace.
 *
 * HONEST BY CONSTRUCTION: a rate with nothing to divide by renders "—", never
 * 0%; demo-mode checkouts are named and excluded; a failed read says so.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber, formatPercent } from '../../i18n/format.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import {
  getPaywallFunnel, getPaywallFunnelWeekly,
  type PaywallFunnel, type PaywallFunnelBundle, type PaywallFunnelWeekly, type PaywallFunnelWeekTotals,
} from './billingClient.js';

const WINDOWS = [7, 30, 90] as const;
type Window = (typeof WINDOWS)[number];
const WINDOW_LABEL: Record<Window, string> = { 7: 'funnelDays7', 30: 'funnelDays30', 90: 'funnelDays90' };

const WEEK_ROWS: Array<{ key: keyof PaywallFunnelWeekTotals; label: string }> = [
  { key: 'impressions', label: 'funnelWeekViews' },
  { key: 'clicks', label: 'funnelWeekClicks' },
  { key: 'refusals', label: 'funnelWeekRefusals' },
  { key: 'checkoutsStarted', label: 'funnelWeekStarted' },
  { key: 'checkoutsCompleted', label: 'funnelWeekCompleted' },
  { key: 'grantsStarted', label: 'funnelColNewGrants' },
  { key: 'grantsEnded', label: 'funnelColCancels' },
];

/** "This week vs last week": its own read, so a failure never hides the funnel. */
function WeekOverWeek(): JSX.Element {
  const { t } = useTranslation('billing');
  const [week, setWeek] = useState<PaywallFunnelWeekly | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(false);
    void getPaywallFunnelWeekly()
      .then((w) => { if (live) setWeek(w); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [attempt]);
  type Row = (typeof WEEK_ROWS)[number];
  const change = (r: Row): string => {
    if (!week) return '';
    const now = week.current.totals[r.key];
    const before = week.previous.totals[r.key];
    if (before === 0) return now === 0 ? t('funnelWeekSame') : t('funnelWeekNew');
    const c = week.change[r.key];
    return c === null ? t('funnelNoRate') : formatPercent(c, { maximumFractionDigits: 0, signDisplay: 'exceptZero' });
  };
  const columns: DataColumn<Row>[] = [
    { key: 'metric', header: t('funnelWeekColMetric'), render: (r) => t(r.label), rowHeader: true },
    { key: 'now', header: t('funnelWeekColNow'), render: (r) => formatNumber(week?.current.totals[r.key] ?? 0), align: 'right' },
    { key: 'before', header: t('funnelWeekColBefore'), render: (r) => formatNumber(week?.previous.totals[r.key] ?? 0), align: 'right' },
    { key: 'change', header: t('funnelWeekColChange'), render: change, align: 'right' },
  ];
  return (
    <div className="u-grid u-gap-2">
      <h3 className="u-fs-14 u-m-0">{t('funnelWeekTitle')}</h3>
      <p className="u-m-0 u-text-sm muted">{t('funnelWeekIntro')}</p>
      {failed ? (
        <Notice variant="warning" announce={t('funnelWeekLoadFailed')}>
          {t('funnelWeekLoadFailed')}{' '}
          <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>{t('retry')}</Button>
        </Notice>
      ) : !week ? <Skeleton /> : (
        <>
          <div className="table-scroll">
            <DataTable columns={columns} rows={WEEK_ROWS} rowKey={(r) => r.key} density="compact" caption={t('funnelWeekCaption')} stackHeaders />
          </div>
          {week.bundles.length > 0 ? (
            <ul className="u-list-plain u-m-0 u-p-0 u-grid u-gap-1">
              {week.bundles.map((b) => (
                <li key={b.bundleId} className="u-text-sm">{t('funnelWeekBundle', { bundle: b.bundleId, started: formatNumber(b.grantsStarted), ended: formatNumber(b.grantsEnded) })}</li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

export function PaywallFunnelPanel(): JSX.Element {
  const { t } = useTranslation('billing');
  const [days, setDays] = useState<Window>(7);
  const [data, setData] = useState<PaywallFunnel | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback((d: Window) => {
    let live = true;
    setBusy(true);
    void getPaywallFunnel(d)
      .then((f) => { if (live) { setData(f); setError(null); } })
      .catch((e: unknown) => { if (live) setError(e ?? new Error('paywall funnel read failed')); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, []);
  useEffect(() => load(days), [load, days]);

  const n = (v: number): string => formatNumber(v);
  const pct = (v: number | null): string => (v === null ? t('funnelNoRate') : formatPercent(v, { maximumFractionDigits: 1 }));
  const columns: DataColumn<PaywallFunnelBundle>[] = [
    { key: 'bundle', header: t('funnelColBundle'), render: (b) => b.bundleId, sortValue: (b) => b.bundleId, rowHeader: true },
    { key: 'views', header: t('funnelColViews'), render: (b) => n(b.impressions), sortValue: (b) => b.impressions, align: 'right' },
    { key: 'clicks', header: t('funnelColClicks'), render: (b) => n(b.clicks), sortValue: (b) => b.clicks, align: 'right' },
    { key: 'ctr', header: t('funnelColCtr'), render: (b) => pct(b.clickThroughRate), sortValue: (b) => b.clickThroughRate, align: 'right' },
    { key: 'refusals', header: t('funnelColRefusals'), render: (b) => n(b.refusals), sortValue: (b) => b.refusals, align: 'right' },
    { key: 'refused', header: t('funnelColRefusedWorkspaces'), render: (b) => n(b.refusedTenants), sortValue: (b) => b.refusedTenants, align: 'right' },
    { key: 'started', header: t('funnelColStarted'), render: (b) => n(b.checkoutsStarted), sortValue: (b) => b.checkoutsStarted, align: 'right' },
    { key: 'completed', header: t('funnelColCompleted'), render: (b) => n(b.checkoutsCompleted), sortValue: (b) => b.checkoutsCompleted, align: 'right' },
    { key: 'conversion', header: t('funnelColConversion'), render: (b) => pct(b.checkoutCompletionRate), sortValue: (b) => b.checkoutCompletionRate, align: 'right' },
    { key: 'newGrants', header: t('funnelColNewGrants'), render: (b) => n(b.grantsStarted), sortValue: (b) => b.grantsStarted, align: 'right' },
    { key: 'cancels', header: t('funnelColCancels'), render: (b) => n(b.grantsEnded), sortValue: (b) => b.grantsEnded, align: 'right' },
    { key: 'grants', header: t('funnelColGrants'), render: (b) => n(b.activeGrants), sortValue: (b) => b.activeGrants, align: 'right' },
  ];

  return (
    <section className="surface-card u-p-4 u-grid u-gap-3" aria-labelledby="billing-funnel-title" aria-busy={busy}>
      <div className="action-bar u-justify-between u-items-center">
        <h2 id="billing-funnel-title" className="u-fs-16 u-m-0">{t('funnelTitle')}</h2>
        <div className="action-bar" role="group" aria-label={t('funnelWindow')}>
          {WINDOWS.map((w) => (
            <Button key={w} variant={w === days ? 'primary' : 'secondary'} size="sm" aria-pressed={w === days} onClick={() => setDays(w)}>
              {t(WINDOW_LABEL[w])}
            </Button>
          ))}
        </div>
      </div>
      <WeekOverWeek />
      <p className="u-m-0 u-text-sm muted">{t('funnelIntro', { days })}</p>
      {days === 90 ? <p className="u-m-0 u-text-sm muted">{t('funnelCoverage')}</p> : null}
      {error && !data ? (
        <Notice variant="warning" announce={t('funnelLoadFailed')}>
          {t('funnelLoadFailed')} {loadErrorMessage(t, error)}{' '}
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => { load(days); }}>{t('retry')}</Button>
        </Notice>
      ) : !data ? <Skeleton /> : (
        <>
          <p className="u-m-0 u-text-sm">
            {t('funnelTotals', {
              impressions: n(data.totals.impressions), clicks: n(data.totals.clicks), refusals: n(data.totals.refusals),
              started: n(data.totals.checkoutsStarted), completed: n(data.totals.checkoutsCompleted),
            })}
          </p>
          <div className="table-scroll">
            <DataTable
              columns={columns}
              rows={data.bundles}
              rowKey={(b) => b.bundleId}
              density="compact"
              caption={t('funnelCaption')}
              stackHeaders
              empty={<p className="u-m-0 u-p-3 muted">{t('funnelEmpty')}</p>}
            />
          </div>
          {data.plans.length > 0 ? (
            <ul className="u-list-plain u-m-0 u-p-0 u-grid u-gap-1">
              {data.plans.map((p) => (
                <li key={p.tier} className="u-text-sm">
                  {t('funnelPlanRow', { plan: t(`plan_${p.tier}`, { defaultValue: p.tier }), active: n(p.active), started: n(p.checkoutsStarted), completed: n(p.checkoutsCompleted) })}
                </li>
              ))}
            </ul>
          ) : null}
          {data.totals.demoCheckouts > 0 ? <p className="u-m-0 u-text-sm muted">{t('funnelDemo', { n: n(data.totals.demoCheckouts) })}</p> : null}
        </>
      )}
    </section>
  );
}
