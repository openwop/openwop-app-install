/**
 * Campaigns in flight tile (ADR 0377 Wave 1) — most-recent marketing campaigns
 * over the EXISTING campaign-studio client. Org-scoped via `useOrgResource`.
 */
import { useTranslation } from 'react-i18next';
import { listCampaigns, type MarketingCampaign } from '../../campaign-orchestration/campaignStudioClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function CampaignsInFlightTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<MarketingCampaign[]>((orgId) => listCampaigns(orgId));

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = [...(data ?? [])]
    .filter((c) => c.status !== 'archived')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, compact ? 4 : 8)
    .map((c) => ({ key: c.id, label: c.name, to: '/campaigns', meta: c.status }));
  if (status === 'no-org' || rows.length === 0) return <p className="dash-tile__state muted">{t('campaignsEmpty')}</p>;
  return <TileList rows={rows} />;
}
