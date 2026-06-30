/**
 * Analytics (host-extension product feature — ADR 0018).
 *
 * Gates on useFeatureAccess('analytics'). An org picker → summary cards (events,
 * sessions, pageviews, conversions) → top paths + UTM sources → recent events.
 * Read-only reporting over the authed surface; ingest is the public beacon.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton.js';
import { KeyFigureBand, type KeyFigureItem } from '../../ui/KeyFigure.js';
import { DataTable, DensityToggle, type DataColumn } from '../../ui/DataTable.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ActivityIcon, GlobeIcon, LockIcon } from '../../ui/icons/index.js';
import { getEvents, getSummary, listOrgs, type AnalyticsEvent, type AnalyticsSummary, type Org } from './analyticsClient.js';

/** Maps an event type to the StatusBadge tone (entity status, not a plain chip). */
const TYPE_STATUS: Record<AnalyticsEvent['type'], string> = {
  conversion: 'completed',
  pageview: 'running',
  event: 'paused',
};

/** Figure key → event-type filter. 'events'/'sessions' are non-filtering totals. */
const FIGURE_FILTER: Record<string, AnalyticsEvent['type'] | undefined> = {
  pageviews: 'pageview',
  conversions: 'conversion',
};

/** Event-type enum → its translation key (display labels only). */
const TYPE_LABEL: Record<AnalyticsEvent['type'], 'typePageview' | 'typeEvent' | 'typeConversion'> = {
  pageview: 'typePageview',
  event: 'typeEvent',
  conversion: 'typeConversion',
};

export function AnalyticsPage(): JSX.Element {
  const { t } = useTranslation('analytics');
  const f = useFormat();
  const access = useFeatureAccess('analytics');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [events, setEvents] = useState<AnalyticsEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // "Stats are filters" (§2): the active figure tile scopes Recent events.
  const [activeFigure, setActiveFigure] = useState<string | null>(null);

  // Row density (comfortable/compact), persisted per-user.
  const [density, setDensity] = useState<'comfortable' | 'compact'>(() => {
    try { return localStorage.getItem('openwop.analytics.density') === 'compact' ? 'compact' : 'comfortable'; } catch { return 'comfortable'; }
  });
  useEffect(() => { try { localStorage.setItem('openwop.analytics.density', density); } catch { /* ignore */ } }, [density]);

  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [access.enabled]);

  const load = useCallback((org: string) => {
    setSummary(null); setEvents(null); setError(null); setActiveFigure(null);
    void getSummary(org).then(setSummary).catch((e) => setError(e instanceof Error ? e.message : t('loadFailed')));
    void getEvents(org).then(setEvents).catch(() => setEvents([]));
  }, [t]);
  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);

  const eventColumns: DataColumn<AnalyticsEvent>[] = useMemo(() => [
    {
      key: 'type', header: t('colType'), width: '120px',
      sortValue: (e) => e.type,
      render: (e) => <StatusBadge status={TYPE_STATUS[e.type]} label={t(TYPE_LABEL[e.type])} />,
    },
    {
      key: 'detail', header: t('colDetail'), width: '1fr',
      sortValue: (e) => e.path ?? e.name ?? e.utm?.source ?? '',
      render: (e) => (e.path ? <code>{e.path}</code> : <span>{e.name ?? (e.utm?.source ? t('utmDetail', { source: e.utm.source }) : t('emDash'))}</span>),
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

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  const figures: KeyFigureItem[] = summary
    ? [
        { key: 'events', label: t('figureEvents'), value: f.number(summary.total) },
        { key: 'sessions', label: t('figureSessions'), value: f.number(summary.sessions) },
        { key: 'pageviews', label: t('figurePageviews'), value: f.number(summary.byType.pageview) },
        { key: 'conversions', label: t('figureConversions'), value: f.number(summary.byType.conversion) },
      ]
    : [];

  const filterType = activeFigure ? FIGURE_FILTER[activeFigure] : undefined;
  const visibleEvents = (events ?? [])
    .filter((e) => (filterType ? e.type === filterType : true))
    .slice(0, 25);

  // Toggle a figure as a filter; non-filtering tiles (events/sessions) just clear.
  const onFigureToggle = (key: string): void => {
    setActiveFigure((cur) => (cur === key ? null : FIGURE_FILTER[key] ? key : null));
  };

  return (
    <div className="page-stack">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <SkeletonRows rows={4} columns={[120, '1fr', 200]} /> : orgs.length === 0 ? (
        <StateCard icon={<GlobeIcon />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : !summary ? <SkeletonRows rows={4} columns={[120, '1fr', 200]} /> : summary.total === 0 ? (
        <StateCard icon={<ActivityIcon />} title={t('noAnalyticsTitle')} body={t('noAnalyticsBody')} />
      ) : (
        <div className="page-enter page-stack">
          <KeyFigureBand
            figures={figures}
            activeKey={activeFigure}
            onToggle={onFigureToggle}
            ariaLabel={t('summaryBandLabel')}
          />

          <section className="surface-card u-flex u-flex-col u-gap-2">
            <h2 className="u-label-sm">{t('topPathsHeading')}</h2>
            <DataTable
              rows={summary.topPaths}
              rowKey={(p) => p.path}
              columns={pathColumns}
              density={density}
              caption={t('captionTopPaths')}
              initialSort={{ key: 'count', dir: 'desc' }}
              empty={<p className="muted">{t('emptyTopPaths')}</p>}
            />
          </section>

          <section className="surface-card u-flex u-flex-col u-gap-2">
            <h2 className="u-label-sm">{t('acquisitionHeading')}</h2>
            <DataTable
              rows={summary.utmSources}
              rowKey={(s) => s.source}
              columns={sourceColumns}
              density={density}
              caption={t('captionUtmSources')}
              initialSort={{ key: 'count', dir: 'desc' }}
              empty={<p className="muted">{t('emptyUtmSources')}</p>}
            />
          </section>

          <section className="surface-card u-flex u-flex-col u-gap-2">
            <div className="action-bar u-justify-between">
              <h2 className="u-label-sm">
                {filterType ? t('recentEventsHeadingFiltered', { type: t(TYPE_LABEL[filterType]) }) : t('recentEventsHeading')}
              </h2>
              <DensityToggle value={density} onChange={setDensity} />
            </div>
            <DataTable
              rows={visibleEvents}
              rowKey={(e) => e.eventId}
              columns={eventColumns}
              density={density}
              caption={t('captionRecentEvents')}
              initialSort={{ key: 'ts', dir: 'desc' }}
              empty={
                !events ? (
                  <SkeletonRows rows={6} columns={[120, '1fr', 200]} />
                ) : (
                  <p className="muted">{filterType ? t('emptyEventsFiltered', { type: t(TYPE_LABEL[filterType]) }) : t('emptyEvents')}</p>
                )
              }
            />
          </section>
        </div>
      )}
    </div>
  );
}
