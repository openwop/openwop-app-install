/**
 * Knowledge base tile (ADR 0377 Wave 1) — collection/document/chunk counts over
 * the EXISTING kb client. Org-scoped via `useOrgResource`; owns no data.
 */
import { useTranslation } from 'react-i18next';
import { listCollections, type KbCollection } from '../../kb/kbClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileStats } from '../TileStats.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function KbOverviewTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<KbCollection[]>((orgId) => listCollections(orgId));

  if (status === 'loading') return <SkeletonRows rows={2} columns={['30%', '30%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const cols = data ?? [];
  if (status === 'no-org' || cols.length === 0) return <p className="dash-tile__state muted">{t('kbEmpty')}</p>;

  return (
    <TileStats
      stats={[
        { label: t('kbCollections'), value: formatNumber(cols.length) },
        { label: t('kbDocuments'), value: formatNumber(cols.reduce((a, c) => a + c.documentCount, 0)) },
        { label: t('kbChunks'), value: formatNumber(cols.reduce((a, c) => a + c.chunkCount, 0)) },
      ]}
    />
  );
}
