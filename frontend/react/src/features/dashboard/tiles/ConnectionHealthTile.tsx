/**
 * Connection health tile (ADR 0377 Wave 4) — provider connections by status
 * over the EXISTING connections client. Admin-tier ops tile (the /ops-strip
 * decision resolved to admin-tier tiles in the ONE catalog — no second surface).
 */
import { useTranslation } from 'react-i18next';
import { listConnections, type Connection } from '../../connections/connectionsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { useTileData } from '../useTileData.js';
import { TileBars } from '../TileBars.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function ConnectionHealthTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useTileData<Connection[]>(() => listConnections(), []);

  if (status === 'loading') return <SkeletonRows rows={2} columns={['30%', '55%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const conns = data ?? [];
  if (conns.length === 0) return <p className="dash-tile__state muted">{t('connectionsEmpty')}</p>;

  const counts = new Map<string, number>();
  for (const c of conns) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  const bars = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => ({ key: s, label: s, value: n }));

  return <TileBars bars={bars} />;
}
