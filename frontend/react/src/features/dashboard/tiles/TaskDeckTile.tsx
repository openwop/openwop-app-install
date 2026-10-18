/**
 * Task deck tile (ADR 0377 Wave 1) — the caller's delegated-work deck bucket
 * counts (pending / running / blocked / delegated / failed — the server's counts,
 * ADR 0902 D6), over the EXISTING task-deck
 * client. Caller-scoped; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { bucketCount, getTaskDeck, type TaskDeck } from '../../../taskDeck/taskDeckClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber } from '../../../i18n/format.js';
import { useTileData } from '../useTileData.js';
import { TileStats } from '../TileStats.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function TaskDeckTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useTileData<TaskDeck>(() => getTaskDeck(), []);

  if (status === 'loading') return <SkeletonRows rows={2} columns={['20%', '20%', '20%', '20%', '20%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  // ADR 0902 D6 — the server's count, not the (capped) card list's length.
  const count = (bucket: 'pending' | 'running' | 'blocked' | 'delegated' | 'failed'): number => (data ? bucketCount(data, bucket) : 0);
  // TD2UX-4 — delegated work counts as active (it used to be left out of the tile).
  const total = count('pending') + count('running') + count('blocked') + count('delegated') + count('failed');
  if (total === 0) return <p className="dash-tile__state muted">{t('taskDeckEmpty')}</p>;

  return (
    <TileStats
      stats={[
        { label: t('taskPending'), value: formatNumber(count('pending')) },
        { label: t('taskRunning'), value: formatNumber(count('running')) },
        { label: t('taskBlocked'), value: formatNumber(count('blocked')) },
        { label: t('taskDelegated'), value: formatNumber(count('delegated')) },
        { label: t('taskFailed'), value: formatNumber(count('failed')) },
      ]}
    />
  );
}
