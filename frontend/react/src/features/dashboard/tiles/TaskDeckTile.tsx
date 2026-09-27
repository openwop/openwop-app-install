/**
 * Task deck tile (ADR 0377 Wave 1) — the caller's delegated-work deck bucket
 * counts (pending / running / blocked / failed), over the EXISTING task-deck
 * client. Caller-scoped; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { getTaskDeck, type TaskDeck } from '../../../taskDeck/taskDeckClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber } from '../../../i18n/format.js';
import { useTileData } from '../useTileData.js';
import { TileStats } from '../TileStats.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function TaskDeckTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useTileData<TaskDeck>(() => getTaskDeck(), []);

  if (status === 'loading') return <SkeletonRows rows={2} columns={['25%', '25%', '25%', '25%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const count = (bucket: 'pending' | 'running' | 'blocked' | 'failed'): number => data?.buckets[bucket]?.length ?? 0;
  const total = count('pending') + count('running') + count('blocked') + count('failed');
  if (total === 0) return <p className="dash-tile__state muted">{t('taskDeckEmpty')}</p>;

  return (
    <TileStats
      stats={[
        { label: t('taskPending'), value: formatNumber(count('pending')) },
        { label: t('taskRunning'), value: formatNumber(count('running')) },
        { label: t('taskBlocked'), value: formatNumber(count('blocked')) },
        { label: t('taskFailed'), value: formatNumber(count('failed')) },
      ]}
    />
  );
}
