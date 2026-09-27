/**
 * Recent notebooks tile (ADR 0377 Wave 1) — most-recently-updated research
 * notebooks over the EXISTING notebooks client. Caller-scoped; owns no data.
 */
import { useTranslation } from 'react-i18next';
import { listNotebooks, type Notebook } from '../../notebooks/notebooksClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import { useTileData } from '../useTileData.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function RecentNotebooksTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useTileData<Notebook[]>(() => listNotebooks(), []);

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '40%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = [...(data ?? [])]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, compact ? 4 : 8)
    // A notebook IS a project (facet:'notebook') — n.id is the project id, and the
    // notebook surface is the project's Sources tab (ADR 0084 correction; the
    // standalone /notebooks route was withdrawn and 404s).
    .map((n) => ({ key: n.id, label: n.name, to: `/projects/${n.id}?tab=sources`, meta: formatRelativeTime(n.updatedAt) }));
  if (rows.length === 0) return <p className="dash-tile__state muted">{t('notebooksEmpty')}</p>;
  return <TileList rows={rows} />;
}
