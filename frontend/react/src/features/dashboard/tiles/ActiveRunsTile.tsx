/**
 * Active runs tile (ADR 0375 Phase 2) — a compact projection over the EXISTING
 * runs client (`listMyRuns`). Owns no data of its own (ADR 0082). Default export
 * so the registry can lazy-load it.
 *
 * Issue 4511 — `listMyRuns` is the WORKSPACE's runs, and run pages are
 * admin-tier. A member sees only the runs they started (`readMyRuns`), as text.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listMyRuns, type RunListItem } from '../../../client/runsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import { useEffectiveAccessState, isAdminCaller } from '../../../client/useEffectiveAccess.js';
import { isRunning, readMyRuns } from '../runsWindow.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function ActiveRunsTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [error, setError] = useState(false);
  const { access, resolved } = useEffectiveAccessState();
  const isAdmin = isAdminCaller(access);

  useEffect(() => {
    if (!resolved) return;
    const ctl = new AbortController();
    const limit = compact ? 4 : 8;
    const read = isAdmin
      ? listMyRuns({ status: 'running', limit, signal: ctl.signal })
      : readMyRuns().then((rows) => rows.filter((r) => isRunning(r.status)).slice(0, limit));
    read
      .then((rows) => { if (!ctl.signal.aborted) setRuns(rows); })
      .catch((e) => { if (e?.name !== 'AbortError' && !ctl.signal.aborted) { setRuns([]); setError(true); } });
    return () => ctl.abort();
  }, [compact, isAdmin, resolved]);

  if (runs === null) return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '55%', '60%']} />;
  if (error) return <p className="dash-tile__state muted">{t('tileError')}</p>;
  if (runs.length === 0) return <p className="dash-tile__state muted">{t('activeRunsEmpty')}</p>;

  return (
    <ul className="dash-tile__list u-list-none u-m-0 u-p-0">
      {runs.map((r) => (
        <li key={r.runId} className="dash-tile__row">
          {isAdmin ? (
            <Link to={`/runs/${r.runId}`} className="dash-tile__row-main u-truncate" title={r.workflowId}>
              {r.workflowId}
            </Link>
          ) : (
            <span className="dash-tile__row-main u-truncate" title={r.workflowId}>{r.workflowId}</span>
          )}
          {r.startedAt ? <span className="dash-tile__row-meta muted">{formatRelativeTime(r.startedAt)}</span> : null}
        </li>
      ))}
    </ul>
  );
}
