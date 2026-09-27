/**
 * Production status tile (ADR 0377 Wave 2) — production plans by lifecycle
 * status as distribution bars. Org-scoped; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { listPlans, type ProductionPlan, type PlanStatus } from '../../production/productionClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileBars } from '../TileBars.js';
import type { DashboardTileProps } from '../tileTypes.js';

const STATUSES: readonly PlanStatus[] = ['draft', 'approved', 'in_production', 'completed'];

export default function ProductionStatusTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<ProductionPlan[]>((orgId) => listPlans(orgId));

  if (status === 'loading') return <SkeletonRows rows={3} columns={['30%', '55%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const plans = data ?? [];
  if (status === 'no-org' || plans.length === 0) return <p className="dash-tile__state muted">{t('productionEmpty')}</p>;

  const bars = STATUSES
    .map((s) => ({ key: s, label: t(`planStatus_${s}`), value: plans.filter((p) => p.status === s).length }))
    .filter((b) => b.value > 0);

  return <TileBars bars={bars} />;
}
