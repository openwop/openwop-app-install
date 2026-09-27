/**
 * Analytics event Card + shared cells — the grid cell of the §4.5 collection-view
 * canon for the Recent-events stream. The page's `<ViewToggle>` switches between
 * the sortable `<DataTable>` (`list`) and a `.card-grid` of `<AnalyticsEventCard>`
 * (`grid`). The Top-paths / UTM-source rankings deliberately stay plain tables —
 * they are ranked mini-tables, not a browsable collection.
 *
 * `<EventTypeBadge>` and `<EventDetail>` are shared by both the card and the
 * table's columns so grid and list never diverge. Events have no detail route, so
 * the card is a non-interactive display `.surface-card` (no Link, no buttons).
 * Composes existing primitives only — no new CSS.
 */

import { useTranslation } from 'react-i18next';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { useFormat } from '../../i18n/useFormat.js';
import type { AnalyticsEvent } from './analyticsClient.js';

/** Maps an event type to the StatusBadge tone (entity status, not a plain chip). */
export const TYPE_STATUS: Record<AnalyticsEvent['type'], string> = {
  conversion: 'completed',
  pageview: 'running',
  event: 'paused',
};

/** Event-type enum → its translation key (display labels only). */
export const TYPE_LABEL: Record<AnalyticsEvent['type'], 'typePageview' | 'typeEvent' | 'typeConversion'> = {
  pageview: 'typePageview',
  event: 'typeEvent',
  conversion: 'typeConversion',
};

export function EventTypeBadge({ type }: { type: AnalyticsEvent['type'] }): JSX.Element {
  const { t } = useTranslation('analytics');
  return <StatusBadge status={TYPE_STATUS[type]} label={t(TYPE_LABEL[type])} />;
}

/** The path / name / UTM-source detail line — shared by the card + table column. */
export function EventDetail({ event: e }: { event: AnalyticsEvent }): JSX.Element {
  const { t } = useTranslation('analytics');
  if (e.path) return <code>{e.path}</code>;
  return <span>{e.name ?? (e.utm?.source ? t('utmDetail', { source: e.utm.source }) : t('emDash'))}</span>;
}

export function AnalyticsEventCard({ event: e }: { event: AnalyticsEvent }): JSX.Element {
  const f = useFormat();
  return (
    <div className="surface-card u-grid u-gap-2">
      <div className="u-flex u-items-baseline u-gap-2 u-wrap">
        <EventTypeBadge type={e.type} />
        <span className="muted u-fs-11 u-ml-auto" title={e.ts}>{f.dateTime(e.ts)}</span>
      </div>
      <div className="u-fs-13"><EventDetail event={e} /></div>
    </div>
  );
}
