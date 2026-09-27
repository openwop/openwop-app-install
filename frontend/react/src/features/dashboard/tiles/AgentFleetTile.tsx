/**
 * Agent fleet tile (ADR 0377 Wave 1) — recent agent-attributed runs across the
 * roster (the fleet feed), over the EXISTING roster client. ONE bounded call
 * (architect trim: no roster+activity pair, no per-agent loop). Caller-scoped;
 * owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { getFleetActivity, type AgentActivityItem } from '../../../agents/rosterClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { useTileData } from '../useTileData.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function AgentFleetTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const limit = compact ? 4 : 8;
  const { status, data } = useTileData<{ items: AgentActivityItem[] }>(
    () => getFleetActivity({ limit }),
    [limit],
  );

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['65%', '45%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = (data?.items ?? []).map((a) => ({
    key: a.runId,
    label: a.persona ? `${a.persona} — ${a.workflowId}` : a.workflowId,
    to: `/runs/${a.runId}`,
    meta: a.status,
  }));
  if (rows.length === 0) return <p className="dash-tile__state muted">{t('fleetEmpty')}</p>;
  return <TileList rows={rows} />;
}
