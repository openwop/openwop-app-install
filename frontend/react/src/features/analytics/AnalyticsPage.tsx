/**
 * Analytics (host-extension product feature — ADR 0018).
 *
 * Gates on useFeatureAccess('analytics'). An org picker → summary cards (events,
 * sessions, pageviews, conversions) → top paths + UTM sources → recent events.
 * Read-only reporting over the authed surface; ingest is the public beacon.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../ui/Button.js';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../i18n/format.js';
import { useFormat } from '../../i18n/useFormat.js';
import { InlineState } from '../../ui/InlineState.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton.js';
import { KeyFigureBand, type KeyFigureItem } from '../../ui/KeyFigure.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { AnalyticsEventCard, EventTypeBadge, EventDetail, TYPE_LABEL } from './AnalyticsViews.js';
// StatusBadge/TYPE_STATUS now live in AnalyticsViews (shared by the card + column).
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ActivityIcon, GlobeIcon, LockIcon } from '../../ui/icons/index.js';
import { getEvents, getSummary, listOrgs, type AnalyticsComparison, type AnalyticsEvent, type AnalyticsSummary, type AnalyticsWindow, type Org , getNavReport, type NavReport , getTrend, type TrendPoint } from './analyticsClient.js';

/** Figure key → event-type filter. 'events'/'sessions' are non-filtering totals. */
const FIGURE_FILTER: Record<string, AnalyticsEvent['type'] | undefined> = {
  pageviews: 'pageview',
  conversions: 'conversion',
};

export function AnalyticsPage(): JSX.Element {
  const { t } = useTranslation('analytics');
  const f = useFormat();
  const access = useFeatureAccess('analytics');
  // `.catch(() => setOrgs([]))` rendered the "No organizations — create one
  // first" instruction over a failed read, and left `orgId` '' so the page's
  // own read never started. Both facts, one value.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [comparison, setComparison] = useState<AnalyticsComparison | null>(null);
  // ANL-UX-2 — the org's first-ever recorded event. `undefined` means this org
  // has NEVER reported (the honest "not installed" case); a value means the
  // beacon demonstrably works, which is the only basis on which this page may
  // say so. It counts web-vital telemetry too, so a vitals-only site reads as
  // connected rather than as never installed.
  const [firstEventAt, setFirstEventAt] = useState<string | undefined>(undefined);
  // ANL-UX-2 R2 — the ABSENCE GUARD. `firstEventAt === undefined` was treated as
  // PROOF of "never reported", but an omitted field is also what a new SPA sees
  // from an older backend (or a stale cached summary) — so the honest zero-state
  // was liable to tell a tenant with real history that analytics is not
  // installed, the exact inverse of the claim ANL-UX-2 removed. `lifetime` is
  // always sent by a backend that knows; ITS absence means "unknown", and
  // unknown is not "never".
  const [historyKnown, setHistoryKnown] = useState(false);
  // null = loading · 'error' = read failed (say so; never "No events.") · array = loaded.
  const [events, setEvents] = useState<AnalyticsEvent[] | 'error' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trend, setTrend] = useState<TrendPoint[] | 'error' | null>(null);

  // "Stats are filters" (§2): the active figure tile scopes Recent events.
  const [activeFigure, setActiveFigure] = useState<string | null>(null);
  // AN-G1 — the reporting WINDOW. Both reads were unconditionally all-time and
  // the page never said so, so "Events 12,431" read as recent when it was the
  // lifetime total. Default to 30 days (what an analytics view is normally
  // asked); "All time" stays available and is exactly the old behaviour.
  const [days, setDays] = useState<AnalyticsWindow>(30);

  // List/grid collection view for the Recent-events stream (§4.5 canon),
  // persisted per-user. `list` keeps the sortable table (the default).
  const [view, setView] = useViewMode('analytics-events', 'list');

  // R2 AN-SP-3 — sequence-stamped: an org/window switch mid-flight must never
  // paint the previous selection's data under the new header (the
  // NavTelemetrySection always had this guard; the main load didn't).
  const loadSeq = useRef(0);
  const load = useCallback((org: string, window: AnalyticsWindow) => {
    const seq = ++loadSeq.current;
    const fresh = (): boolean => seq === loadSeq.current;
    setSummary(null); setEvents(null); setError(null); setActiveFigure(null); setComparison(null); setTrend(null); setFirstEventAt(undefined); setHistoryKnown(false);
    void getSummary(org, window)
      .then(({ summary: s, comparison: c, firstEventAt: first, lifetime }) => {
        if (!fresh()) return;
        setSummary(s); setComparison(c ?? null); setFirstEventAt(first); setHistoryKnown(lifetime !== undefined);
      })
      .catch((e) => { if (fresh()) setError(e instanceof Error ? e.message : ''); });
    // AN-R2-1 — a failed events read must not impersonate "No events.": the
    // 'error' sentinel renders a distinct unavailable line (the kbItems /
    // quality-signals precedent), never the empty-state claim.
    void getEvents(org, window).then((ev) => { if (fresh()) setEvents(ev); }).catch(() => { if (fresh()) setEvents('error'); });
    // R2 AN-R2-1 — the trend chart (windowed views only; a failed read hides
    // the chart rather than faking a flat line).
    if (window !== undefined) {
      void getTrend(org, window).then((tr) => { if (fresh()) setTrend(tr); }).catch(() => { if (fresh()) setTrend('error'); });
    }
  }, []);
  useEffect(() => { if (orgId) load(orgId, days); }, [orgId, days, load]);

  const eventColumns: DataColumn<AnalyticsEvent>[] = useMemo(() => [
    {
      key: 'type', header: t('colType'), width: '120px',
      sortValue: (e) => e.type,
      render: (e) => <EventTypeBadge type={e.type} />,
    },
    {
      key: 'detail', header: t('colDetail'), width: '1fr',
      sortValue: (e) => e.path ?? e.name ?? e.utm?.source ?? '',
      render: (e) => <EventDetail event={e} />,
    },
    {
      key: 'ts', header: t('colWhen'), align: 'right', width: '200px', cellClassName: 'muted',
      sortValue: (e) => e.ts,
      render: (e) => <span title={e.ts}>{f.dateTime(e.ts)}</span>,
    },
  ], [t, f]);

  const pathColumns: DataColumn<{ path: string; count: number }>[] = useMemo(() => [
    { key: 'path', header: t('colPath'), width: '1fr', sortValue: (r) => r.path, render: (r) => <code>{r.path}</code> },
    { key: 'count', header: t('colViews'), align: 'right', width: '100px', cellClassName: 'u-tabular', sortValue: (r) => r.count, render: (r) => f.number(r.count) },
  ], [t, f]);

  const sourceColumns: DataColumn<{ source: string; count: number }>[] = useMemo(() => [
    { key: 'source', header: t('colSource'), width: '1fr', sortValue: (r) => r.source, render: (r) => r.source },
    { key: 'count', header: t('colHits'), align: 'right', width: '100px', cellClassName: 'u-tabular', sortValue: (r) => r.count, render: (r) => f.number(r.count) },
  ], [t, f]);

  // ADR 0018 CWV fold-in — the Web Vitals p75 table. rating→chip (color-never-alone:
  // the rating label carries the meaning). CLS is unitless; the rest are ms.
  const vitalColumns: DataColumn<{ metric: string; p75: number; rating: 'good' | 'needs-improvement' | 'poor'; count: number }>[] = useMemo(() => [
    { key: 'metric', header: t('vitalMetric'), width: '1fr', sortValue: (r) => r.metric, render: (r) => <code>{r.metric}</code> },
    { key: 'p75', header: t('vitalP75'), align: 'right', width: '120px', cellClassName: 'u-tabular', sortValue: (r) => r.p75, render: (r) => (r.metric === 'CLS' ? f.number(r.p75) : t('vitalMs', { n: f.number(r.p75) })) },
    { key: 'rating', header: t('vitalRating'), width: '160px', sortValue: (r) => r.rating, render: (r) => <span className={`chip ${r.rating === 'good' ? 'chip--success' : r.rating === 'poor' ? 'chip--danger' : 'chip--warning'}`}>{t(`rating_${r.rating}`)}</span> },
    { key: 'count', header: t('vitalSamples'), align: 'right', width: '100px', cellClassName: 'u-tabular', sortValue: (r) => r.count, render: (r) => f.number(r.count) },
  ], [t, f]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <>
      {/* AN-G1 — every figure below is scoped to this window, so it sits with
          the org picker: the two together say WHOSE data and OVER WHAT. */}
      <select
        value={days === undefined ? 'all' : String(days)}
        onChange={(e) => setDays(e.target.value === 'all' ? undefined : (Number(e.target.value) as AnalyticsWindow))}
        className="u-w-auto"
        aria-label={t('windowPickerLabel')}
      >
        <option value="7">{t('window7')}</option>
        <option value="30">{t('window30')}</option>
        <option value="90">{t('window90')}</option>
        <option value="all">{t('windowAll')}</option>
      </select>
      <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('orgPickerLabel')}>
        {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
      </select>
    </>
  ) : undefined;

  // AN-G3 — "+12% vs prior 30 days" under each figure. A zero prior with a
  // non-zero current is "new" (no percentage of zero); both-zero says nothing.
  //
  // ANL-UX-3 — `prior` is `number | undefined`, and an UNDEFINED prior renders
  // NOTHING. `comparison.uniqueVisitors` is conditionally omitted by the route
  // whenever the prior window holds no hashed rows — i.e. every tenant whose
  // prior window predates the ADR 0569 deployment — and the caller used to
  // coalesce that absence with `?? 0`, which took the `prior === 0` branch and
  // printed "new vs prior 30 days": a growth claim minted from a window where
  // the dimension did not exist. Absent is not zero.
  const deltaFor = (current: number, prior: number | undefined): Pick<KeyFigureItem, 'sub' | 'subTone'> => {
    if (!comparison) return {};
    if (prior === undefined) return {};
    if (prior === 0) {
      return current > 0 ? { sub: t('deltaNew', { days: comparison.days }), subTone: 'neutral' } : {};
    }
    const pct = Math.round(((current - prior) / prior) * 100);
    if (pct === 0) return { sub: t('deltaFlat', { days: comparison.days }), subTone: 'neutral' };
    return {
      sub: t('deltaVsPrior', { pct: `${pct > 0 ? '+' : ''}${f.number(pct)}%`, days: comparison.days }),
      subTone: pct > 0 ? 'up' : 'down',
    };
  };
  const figures: KeyFigureItem[] = summary
    ? [
        { key: 'events', label: t('figureEvents'), value: f.number(summary.total), ...deltaFor(summary.total, comparison?.total ?? 0) },
        // ADR 0569 — "daily uniques (cookieless)". Rendered ONLY when the
        // dimension exists (the operator opt-out or pre-deployment history ⇒
        // counts only, and the tile honestly disappears rather than showing 0).
        ...(summary.uniqueVisitors !== undefined
          ? [{ key: 'visitors', label: t('figureVisitors'), value: f.number(summary.uniqueVisitors), ...deltaFor(summary.uniqueVisitors, comparison?.uniqueVisitors) } satisfies KeyFigureItem]
          : []),
        // ANL-UX-15 — the server OMITS `sessions` when no row in the window carried a
        // sessionKey (a confident 0 was a claim about un-keyed traffic); render only what it sent.
        ...(summary.sessions !== undefined
          ? [{ key: 'sessions', label: t('figureSessions'), value: f.number(summary.sessions), ...deltaFor(summary.sessions, comparison?.sessions) } satisfies KeyFigureItem]
          : []),
        { key: 'pageviews', label: t('figurePageviews'), value: f.number(summary.byType.pageview), ...deltaFor(summary.byType.pageview, comparison?.pageviews ?? 0) },
        { key: 'conversions', label: t('figureConversions'), value: f.number(summary.byType.conversion), ...deltaFor(summary.byType.conversion, comparison?.conversions ?? 0) },
      ]
    : [];

  const filterType = activeFigure ? FIGURE_FILTER[activeFigure] : undefined;
  const visibleEvents = (Array.isArray(events) ? events : [])
    .filter((e) => (filterType ? e.type === filterType : true))
    .slice(0, 25);

  // Toggle a figure as a filter; non-filtering tiles (events/sessions) just clear.
  const onFigureToggle = (key: string): void => {
    setActiveFigure((cur) => (cur === key ? null : FIGURE_FILTER[key] ? key : null));
  };

  // ANL-UX-1 — the two sections below are read SEPARATELY from the summary, so
  // they are rendered separately too. `error && !summary` used to replace the
  // whole body with the failure card, discarding a trend and an events list
  // that had loaded FINE — DESIGN.md:325-330 names that direction explicitly
  // ("replacing real data with 'couldn't load' when we still hold the previous
  // answer is dishonest in the opposite direction"), and §4.6's `partial` row
  // requires the failure be scoped to the panel that failed. The tracker
  // recorded this as closed (XAN-0) and the fix had only replaced a permanent
  // skeleton with a retry card.
  // ANL-UX-18 — a failed trend read used to fall into the same blank as "<2 points"
  // and all-time; it is its own (polite) failed state now.
  const trendSection = trend === 'error'
    ? <InlineState kind="failed" message={t('trendUnavailable')} announce={t('trendUnavailable')} announcePolite />
    : days !== undefined && Array.isArray(trend) && trend.length > 1
      ? <TrendChart points={trend} days={days} />
      : null;

  const eventsSection = (
    <section className="surface-card u-flex u-flex-col u-gap-2">
      <div className="action-bar u-justify-between">
        <h2 className="u-label-sm">
          {filterType ? t('recentEventsHeadingFiltered', { type: t(TYPE_LABEL[filterType]) }) : t('recentEventsHeading')}
          {/* R2 AN-SP-6 — the stream is a SAMPLE (newest 100, shown 25)
              and the figures above are full counts; without this label
              "Conversions 14" above an empty filtered stream read as a
              contradiction. */}
          <span className="muted u-fs-12"> · {t('streamSampleNote')}</span>
        </h2>
        <ViewToggle value={view} onChange={setView} />
      </div>
      {visibleEvents.length === 0 ? (
        !events ? (
          <SkeletonRows rows={6} columns={[120, '1fr', 200]} />
        ) : events === 'error' ? (
          <InlineState kind="failed" message={t('eventsUnavailable')} announce={t('eventsUnavailable')} announcePolite />
        ) : (
          <InlineState kind="empty" message={filterType ? t('emptyEventsFiltered', { type: t(TYPE_LABEL[filterType]) }) : t('emptyEvents')} />
        )
      ) : view === 'grid' ? (
        <div className="card-grid">
          {visibleEvents.map((e) => <AnalyticsEventCard key={e.eventId} event={e} />)}
        </div>
      ) : (
        <DataTable stack
          rows={visibleEvents}
          rowKey={(e) => e.eventId}
          columns={eventColumns}
          caption={t('captionRecentEvents')}
          initialSort={{ key: 'ts', dir: 'desc' }}
        />
      )}
    </section>
  );

  // ANL-UX-2 — the zero-state, decided from a WIRE SIGNAL rather than asserted.
  // `total === 0` alone cannot distinguish "the snippet was never pasted" from
  // "a quiet month" from "every visitor declined consent" from "all traffic was
  // web-vital telemetry, which `total` excludes" — yet the page confidently
  // claimed "The beacon is connected". `firstEventAt` is what actually
  // discriminates: absent ⇒ this org has never recorded anything.
  const zeroState = (): JSX.Element => {
    if (firstEventAt === undefined) {
      // ANL-UX-2 R2 — only claim "never installed" when the backend actually
      // TOLD us the org has no history. Without `lifetime` we do not know, and
      // "we don't know" is its own state, not a licence to assert the worse one.
      if (!historyKnown) {
        // `announce`: this is a DEGRADED read, not a plain empty — the page is
        // reporting that a signal did not arrive. A sighted user reads that in
        // the copy; without `announce` a screen-reader user gets the silent swap
        // (`check-failure-card-announce`), which reads as "nothing to report" —
        // the very conflation this branch exists to prevent.
        return <StateCard announce icon={<ActivityIcon />} title={t('historyUnknownTitle')} body={t('historyUnknownBody')} />;
      }
      return <StateCard icon={<ActivityIcon />} title={t('noAnalyticsTitle')} body={t('noAnalyticsBody')} />;
    }
    if (days !== undefined) {
      // R2 AN-SP-2 kept: zero events in the WINDOW is not "no analytics yet" —
      // and now the "it IS reporting" half is backed by `firstEventAt`.
      return (
        <StateCard
          icon={<ActivityIcon />}
          title={t('noEventsInWindowTitle', { days })}
          body={t('noEventsInWindowBody', { since: f.date(firstEventAt) })}
          action={<Button variant="secondary" onClick={() => setDays(undefined)}>{t('showAllTime')}</Button>}
        />
      );
    }
    // All time, zero business events, but the beacon HAS reported ⇒ the only
    // traffic was web-vital telemetry (`total` excludes it by design).
    return <StateCard icon={<ActivityIcon />} title={t('noBusinessEventsTitle')} body={t('noBusinessEventsBody', { since: f.date(firstEventAt) })} />;
  };

  return (
    <div data-walkthrough="analytics.page" className="page-stack">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={days === undefined ? t('ledeAllTime') : t('ledeWindow', { days })}
        actions={orgPicker}
      />
      {/* ANL-UX-6 — the localized headline ALWAYS leads (the raw client message used to be
          the whole notice, so `loadFailed` ×4 was dead copy); the transport detail is secondary. */}
      {error !== null ? <Notice variant="error" announce={t('loadFailed')}>{t('loadFailed')}{error ? ` — ${error}` : ''}</Notice> : null}

      {/* HG-4 — the noun and the branch ORDER (failed → zero-orgs → children) are
          `OrgSelectionState`'s now, and taking the rest as CHILDREN is what makes
          that order unskippable. This page had it inverted: the skeleton was
          checked ABOVE the zero-org branch, which reads as a live defect only
          because `!orgs` is false for `[]`. Both org states must stay above the
          summary skeleton — `load()` is gated on `orgId`, so with no organization
          the summary read never starts and `summary` never leaves `null`. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<GlobeIcon />}>
      {error && !summary ? (
        // R2 AN-SP-1 — a failed summary read used to leave a PERMANENT
        // skeleton. The Notice above carries the message; here we stop
        // pretending to load and offer retry.
        // ANL-UX-1 — and the failure is now SCOPED: the trend and the events
        // stream are separate reads, so what loaded is still shown.
        <div className="page-stack">
          <StateCard
            announce
            icon={<ActivityIcon />}
            title={t('summaryFailedTitle')}
            body={t('summaryFailedBody')}
            action={<Button variant="secondary" onClick={() => load(orgId, days)}>{t('common:retry')}</Button>}
          />
          {trendSection}
          {eventsSection}
        </div>
      ) : !summary ? <SkeletonRows rows={4} columns={[120, '1fr', 200]} /> : summary.total === 0 ? (
        zeroState()
      ) : (
        <div className="page-enter page-stack">
          {trendSection}
          <KeyFigureBand
            figures={figures}
            activeKey={activeFigure}
            onToggle={onFigureToggle}
            ariaLabel={t('summaryBandLabel')}
          />
          {/* ADR 0569 §3 — the disclosure names the mechanism: cookieless,
              daily-rotating, cross-day identity impossible, and WHEN uniques
              began (they cannot be backfilled — the UI must not imply history). */}
          {summary.uniqueVisitors !== undefined ? (
            <p className="muted u-fs-12 u-m-0">
              {t('visitorsDisclosure', { since: summary.uniqueVisitorsSince ? f.date(summary.uniqueVisitorsSince) : '—' })}
            </p>
          ) : null}

          <section className="surface-card u-flex u-flex-col u-gap-2">
            <h2 className="u-label-sm">{t('topPathsHeading')}</h2>
            {summary.topPathsTotal !== undefined && summary.topPathsTotal > summary.topPaths.length ? (
              <p className="u-m-0 u-fs-12 muted">{t('topListTruncated', { shown: summary.topPaths.length, total: summary.topPathsTotal })}</p>
            ) : null}
            <DataTable stack
              rows={summary.topPaths}
              rowKey={(p) => p.path}
              columns={pathColumns}
              caption={t('captionTopPaths')}
              initialSort={{ key: 'count', dir: 'desc' }}
              empty={<InlineState kind="empty" message={t('emptyTopPaths')} />}
            />
          </section>

          <section className="surface-card u-flex u-flex-col u-gap-2">
            <h2 className="u-label-sm">{t('acquisitionHeading')}</h2>
            {summary.utmSourcesTotal !== undefined && summary.utmSourcesTotal > summary.utmSources.length ? (
              <p className="u-m-0 u-fs-12 muted">{t('topListTruncated', { shown: summary.utmSources.length, total: summary.utmSourcesTotal })}</p>
            ) : null}
            <DataTable stack
              rows={summary.utmSources}
              rowKey={(s) => s.source}
              columns={sourceColumns}
              caption={t('captionUtmSources')}
              initialSort={{ key: 'count', dir: 'desc' }}
              empty={<InlineState kind="empty" message={t('emptyUtmSources')} />}
            />
          </section>

          {summary.vitals && summary.vitals.length > 0 ? (
            <section className="surface-card u-flex u-flex-col u-gap-2">
              <h2 className="u-label-sm">{t('vitalsHeading')}</h2>
              <p className="u-label-sm u-text-muted">{t('vitalsHint')}</p>
              <DataTable stack
                rows={summary.vitals}
                rowKey={(v) => v.metric}
                columns={vitalColumns}
                caption={t('captionVitals')}
                initialSort={{ key: 'metric', dir: 'asc' }}
              />
            </section>
          ) : null}

          {eventsSection}
        </div>
      )}
      </OrgSelectionState>
      <NavTelemetrySection />
    </div>
  );
}

/** ADR 0512 — the tenant-scoped workspace-navigation aggregate. Renders ONLY
 *  when the `workspace-nav-telemetry` sub-toggle is on (default off); the
 *  report is member-visible by design — transparency is part of the
 *  disclosure posture. Counts only: route pattern × source. */
function NavTelemetrySection(): JSX.Element | null {
  const { t } = useTranslation('analytics');
  const { enabled } = useFeatureAccess('workspace-nav-telemetry');
  const [report, setReport] = useState<NavReport | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    getNavReport().then((r) => { if (live) setReport(r); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [enabled]);
  if (!enabled) return null;
  return (
    <section className="surface-card u-flex u-flex-col u-gap-2 u-p-4">
      <h2 className="u-label-sm">{t('navReportHeading')}</h2>
      <p className="u-m-0 u-fs-12 muted">{t('navReportHint', { weeks: report?.weeks?.length ? report.weeks.length : 6 })}</p>
      {failed ? (
        <InlineState kind="failed" message={t('navReportUnavailable')} announce={t('navReportUnavailable')} announcePolite />
      ) : report === null ? (
        <InlineState kind="loading" message={t('navReportLoading')} />
      ) : report.rows.length === 0 ? (
        <InlineState kind="empty" message={t('navReportEmpty')} />
      ) : (
        <table className="u-w-full">
          <caption className="sr-only">{t('navReportHeading')}</caption>
          <thead>
            <tr><th className="u-text-left">{t('navColRoute')}</th><th className="u-text-left">{t('navColSource')}</th><th className="u-text-right">{t('navColCount')}</th></tr>
          </thead>
          <tbody>
            {report.rows.slice(0, 40).map((r) => (
              <tr key={`${r.route}-${r.source}`}>
                <td className="u-mono u-fs-12">{r.route}</td>
                <td className="u-fs-12">{r.source}</td>
                <td className="u-text-right u-tabular">{formatNumber(r.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report && report.rows.length > 40 ? (
        <p className="muted u-fs-12 u-m-0">{t('navReportTruncated', { shown: 40, total: formatNumber(report.rows.length) })}</p>
      ) : null}
    </section>
  );
}

/** R2 AN-R2-1 — the table-stakes trend: pageviews per UTC day over the window,
 *  as an accessible inline SVG (no chart library — the ui/ precedent for the
 *  crm-meter/funnel bars). The data table IS the accessible alternative: the
 *  svg is aria-hidden and a visually-hidden summary carries the numbers. */
function TrendChart({ points, days }: { points: import('./analyticsClient.js').TrendPoint[]; days: number }): JSX.Element {
  const { t } = useTranslation('analytics');
  const w = 640; const h = 120; const pad = 4;
  const max = Math.max(...points.map((p) => p.pageviews), 1);
  const x = (i: number): number => pad + (i * (w - pad * 2)) / Math.max(points.length - 1, 1);
  const y = (v: number): number => h - pad - (v * (h - pad * 2)) / max;
  // SVG path coordinates, not user-facing numbers (check-i18n bans toFixed
  // outside format.ts): round to one decimal arithmetically.
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${r1(x(i))},${r1(y(p.pageviews))}`).join(' ');
  const total = points.reduce((acc, p) => acc + p.pageviews, 0);
  // ANL-UX-5 — the right-edge dip is TODAY still running, not a collapse in
  // traffic, and it is permanent: every load of every window has it. Nothing
  // said so. The server now marks the bucket, and the note is rendered for
  // everyone (not only screen-reader users) because the misreading is visual.
  const partial = points.some((p) => p.partial);
  return (
    <div className="surface-card u-p-4 u-grid u-gap-2">
      <div className="u-flex u-items-center u-gap-2">
        <h2 className="u-fs-14 u-m-0">{t('trendTitle')}</h2>
        <span className="muted u-fs-12">{t('trendLede', { days })}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="an-trend" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <path d={path} fill="none" stroke="var(--clay)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      {/* The chart's total is CALENDAR-day-bucketed while the Pageviews key
          figure above is a ROLLING window — two answers to two questions, so
          the copy names the basis instead of letting them read as one number
          that disagrees with itself. */}
      {partial ? <p className="muted u-fs-12 u-m-0">{t('trendPartialNote')}</p> : null}
      <span className="sr-only">{t('trendSrSummary', { days, total: formatNumber(total), peak: formatNumber(max) })}</span>
    </div>
  );
}

