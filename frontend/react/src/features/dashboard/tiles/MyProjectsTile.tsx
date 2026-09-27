/**
 * My projects tile (ADR 0377 Wave 1) — the caller's projects over the EXISTING
 * projects client. Caller-scoped; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { listProjects, type Project } from '../../projects/projectsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { useTileData } from '../useTileData.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function MyProjectsTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useTileData<Project[]>(() => listProjects(), []);

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '40%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = (data ?? []).slice(0, compact ? 4 : 8).map((p) => ({
    key: p.id,
    label: p.name,
    to: '/projects',
    meta: p.workflows.length > 0 ? t('projectWorkflows', { n: p.workflows.length }) : undefined,
  }));
  if (rows.length === 0) return <p className="dash-tile__state muted">{t('projectsEmpty')}</p>;
  return <TileList rows={rows} />;
}
