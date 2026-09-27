/**
 * KickTodo "Progress" tile (ADR 0452) — day X of Y + activities completed for
 * the participant's primary active enrollment, a projection over the EXISTING
 * `kicktodoClient` (`listEnrollments` + `getProgress`). Owns no data (ADR 0082);
 * read-only, deep-links `/progress`. Toggle-gated (`kicktodo-core`).
 *
 * Honesty: the progress view exposes day/duration + completed/total activities
 * — NOT a "streak" (no such field), so this tile shows real progress, never a
 * fabricated streak count.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listEnrollments, getProgress, type ProgressView } from '../../../client/kicktodoClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function KickTodoProgressTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const [progress, setProgress] = useState<ProgressView | null | 'none'>(null);
  const [state, setState] = useState<'ok' | 'error' | 'signed-out'>('ok');

  useEffect(() => {
    let live = true;
    (async () => {
      const active = (await listEnrollments()).find((e) => e.state === 'active');
      if (!active) { if (live) setProgress('none'); return; }
      const p = await getProgress(active.id);
      if (live) setProgress(p);
    })().catch((e: unknown) => {
      if (!live) return;
      setState(/\b40[13]\b/.test(e instanceof Error ? e.message : '') ? 'signed-out' : 'error');
    });
    return () => { live = false; };
  }, []);

  if (progress === null && state === 'ok') return <SkeletonRows rows={compact ? 1 : 2} columns={['60%', '40%']} />;
  if (state === 'signed-out') return <p className="dash-tile__state muted">{t('kicktodoSignedOut')}</p>;
  if (state === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  if (progress === 'none') return <p className="dash-tile__state muted">{t('kicktodoProgressEmpty')}</p>;

  const p = progress!;
  const pct = p.totalRequiredActivities > 0
    ? Math.round((p.completedActivities / p.totalRequiredActivities) * 100)
    : 0;
  return (
    <Link to="/progress" className="dash-tile__body u-block" title={t('kicktodoProgressTitle')}>
      <p className="dash-tile__row-main u-m-0">{t('kicktodoProgressDay', { day: p.currentDay, total: p.durationDays })}</p>
      <p className="dash-tile__row-meta muted u-m-0">
        {t('kicktodoProgressActivities', { done: p.completedActivities, total: p.totalRequiredActivities, pct })}
      </p>
    </Link>
  );
}
