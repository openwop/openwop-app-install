/**
 * Recent media tile (ADR 0377 Wave 1) — most-recently-updated media assets over
 * the EXISTING media client. Org-scoped via `useOrgResource`; owns no data.
 */
import { useTranslation } from 'react-i18next';
import { listAssets, type MediaAsset } from '../../media/mediaClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function RecentMediaTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<MediaAsset[]>((orgId) => listAssets(orgId));

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '40%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = [...(data ?? [])]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, compact ? 4 : 8)
    .map((m) => ({ key: m.assetId, label: m.name, to: '/media', meta: formatRelativeTime(m.updatedAt) }));
  if (status === 'no-org' || rows.length === 0) return <p className="dash-tile__state muted">{t('mediaEmpty')}</p>;
  return <TileList rows={rows} />;
}
