/**
 * Live promotions tile (ADR 0377 Wave 1) — active promotions over the EXISTING
 * promotions client. Org-scoped via `useOrgResource`; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { listPromotions, type Promotion } from '../../promotions/promotionsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function LivePromotionsTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<Promotion[]>((orgId) => listPromotions(orgId).then((r) => r.promotions));

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = (data ?? [])
    .filter((p) => p.active)
    .slice(0, compact ? 4 : 8)
    .map((p) => ({ key: p.promotionId, label: p.name, to: '/promotions', meta: p.type }));
  if (status === 'no-org' || rows.length === 0) return <p className="dash-tile__state muted">{t('promotionsEmpty')}</p>;
  return <TileList rows={rows} />;
}
