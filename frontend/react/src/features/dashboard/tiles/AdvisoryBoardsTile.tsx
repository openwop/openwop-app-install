/**
 * Advisory boards tile (ADR 0377 Wave 1) — the caller's advisory boards over the
 * EXISTING advisory-board client. Caller-scoped; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { listBoards, type AdvisoryBoard } from '../../advisory-board/advisoryBoardClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { useTileData } from '../useTileData.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function AdvisoryBoardsTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useTileData<AdvisoryBoard[]>(() => listBoards(), []);

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '35%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = (data ?? []).slice(0, compact ? 4 : 8).map((b) => ({
    key: b.boardId,
    label: b.name,
    to: '/advisors',
    meta: t('advisorCount', { n: b.advisors.length }),
  }));
  if (rows.length === 0) return <p className="dash-tile__state muted">{t('advisoryEmpty')}</p>;
  return <TileList rows={rows} />;
}
