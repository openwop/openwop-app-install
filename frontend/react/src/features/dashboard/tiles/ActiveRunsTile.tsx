/**
 * Active runs tile (ADR 0375 Phase 2) — a compact projection over the EXISTING
 * runs client (`listMyRuns`). Owns no data of its own (ADR 0082). Default export
 * so the registry can lazy-load it.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listMyRuns, type RunListItem } from '../../../client/runsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function ActiveRunsTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    listMyRuns({ status: 'running', limit: compact ? 4 : 8, signal: ctl.signal })
      .then(setRuns)
      .catch((e) => { if (e?.name !== 'AbortError') { setRuns([]); setError(true); } });
    return () => ctl.abort();
  }, [compact]);

  if (runs === null) return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '55%', '60%']} />;
  if (error) return <p className="dash-tile__state muted">{t('tileError')}</p>;
  if (runs.length === 0) return <p className="dash-tile__state muted">{t('activeRunsEmpty')}</p>;

  return (
    <ul className="dash-tile__list u-list-none u-m-0 u-p-0">
      {runs.map((r) => (
        <li key={r.runId} className="dash-tile__row">
          <Link to={`/runs/${r.runId}`} className="dash-tile__row-main u-truncate" title={r.workflowId}>
            {r.workflowId}
          </Link>
          {r.startedAt ? <span className="dash-tile__row-meta muted">{formatRelativeTime(r.startedAt)}</span> : null}
        </li>
      ))}
    </ul>
  );
}
