/**
 * Strategy health tile (ADR 0377 Wave 1) — on-track / at-risk / off-track counts
 * over the EXISTING strategy client. Caller-scoped; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { getStrategyHealth, type StrategyHealthRow } from '../../strategy/strategyClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber } from '../../../i18n/format.js';
import { useTileData } from '../useTileData.js';
import { TileStats } from '../TileStats.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function StrategyHealthTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useTileData<StrategyHealthRow[]>(() => getStrategyHealth(), []);

  if (status === 'loading') return <SkeletonRows rows={2} columns={['30%', '30%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = data ?? [];
  if (rows.length === 0) return <p className="dash-tile__state muted">{t('strategyEmpty')}</p>;
  const by = (h: StrategyHealthRow['health']): number => rows.filter((r) => r.health === h).length;

  return (
    <TileStats
      stats={[
        { label: t('strategyOnTrack'), value: formatNumber(by('on-track')) },
        { label: t('strategyAtRisk'), value: formatNumber(by('at-risk')) },
        { label: t('strategyOffTrack'), value: formatNumber(by('off-track')) },
      ]}
    />
  );
}
