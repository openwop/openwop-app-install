/**
 * Workforce ops tile (ADR 0377 Wave 1) — the governed workforces roster over the
 * EXISTING workforces client. LIST projection only (architect pin: per-workforce
 * metrics would be N+1 — depth stays on /workforces). Caller-scoped; owns no data.
 */
import { useTranslation } from 'react-i18next';
import { listWorkforces, type Workforce } from '../../../client/workforcesClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { useTileData } from '../useTileData.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function WorkforceOpsTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useTileData<Workforce[]>(() => listWorkforces(), []);

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['65%', '35%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = (data ?? []).slice(0, compact ? 4 : 8).map((w) => ({
    key: w.workforceId,
    label: w.name,
    to: '/workforces',
    meta: w.status,
    title: w.purpose.statement,
  }));
  if (rows.length === 0) return <p className="dash-tile__state muted">{t('workforcesEmpty')}</p>;
  return <TileList rows={rows} />;
}
