/**
 * Run activity tile (ADR 0844) — every recent run in one list, status first,
 * filterable to what needs attention. Replaces the running-only "Active runs"
 * tile as a default: a list that only shows in-flight runs is empty most of the
 * time and hides the failures a person actually came to see.
 *
 * Reads the shared runs read (`runsWindow.ts`) — no request of its own.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { RunListItem } from '../../../client/runsClient.js';
import { Button } from '../../../ui/Button.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { StatusBadge } from '../../../ui/StatusBadge.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import { useEffectiveAccessState, isAdminCaller } from '../../../client/useEffectiveAccess.js';
import { useTileData } from '../useTileData.js';
import { durationMs, formatDuration, isFailed, isRunning, isWaiting, readRecentRuns } from '../runsWindow.js';
import type { DashboardTileProps } from '../tileTypes.js';

type Filter = 'all' | 'attention' | 'running';
const FILTERS: Filter[] = ['all', 'attention', 'running'];

export function filterRuns(rows: readonly RunListItem[], filter: Filter): RunListItem[] {
  if (filter === 'attention') return rows.filter((r) => isFailed(r.status) || isWaiting(r.status));
  if (filter === 'running') return rows.filter((r) => isRunning(r.status));
  return [...rows];
}

export default function RunActivityTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const [filter, setFilter] = useState<Filter>('all');
  const { status, data } = useTileData<RunListItem[]>(() => readRecentRuns(), []);
  // `/runs` and `/runs/:id` are admin-tier routes; a member gets the list
  // without links rather than a link to an "administrator access" page.
  const canOpenRuns = isAdminCaller(useEffectiveAccessState().access);

  if (status === 'loading') return <SkeletonRows rows={compact ? 4 : 6} columns={['18%', '52%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const all = data ?? [];
  if (all.length === 0) return <p className="dash-tile__state muted">{t('activityEmpty')}</p>;

  const rows = filterRuns(all, filter).slice(0, compact ? 6 : 10);

  return (
    <div className="u-flex u-flex-col u-gap-2">
      <div className="segmented dash-activity__filters" role="group" aria-label={t('activityFilterLabel')}>
        {FILTERS.map((f) => (
          <Button key={f} variant="primary" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t(`activityFilter_${f}`)}
          </Button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="dash-tile__state muted">{t(`activityNone_${filter}`)}</p>
      ) : (
        <ul className="dash-activity u-list-none u-m-0 u-p-0">
          {rows.map((r) => {
            const d = durationMs(r);
            const cells = (
              <>
                <StatusBadge status={r.status} label={t(`runStatus_${r.status.toLowerCase()}`, { defaultValue: r.status })} className="dash-activity__badge" />
                <span className="dash-activity__name u-truncate" title={r.workflowId}>{r.workflowId}</span>
                <span className="dash-activity__meta muted">{d !== null ? formatDuration(d) : ''}</span>
                <span className="dash-activity__meta muted">{r.startedAt ? formatRelativeTime(r.startedAt) : ''}</span>
              </>
            );
            return (
              <li key={r.runId}>
                {canOpenRuns
                  ? <Link to={`/runs/${encodeURIComponent(r.runId)}`} className="dash-activity__row">{cells}</Link>
                  : <div className="dash-activity__row">{cells}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {canOpenRuns ? <Link to="/runs" className="dash-tile__more">{t('activitySeeAll')}</Link> : null}
    </div>
  );
}
