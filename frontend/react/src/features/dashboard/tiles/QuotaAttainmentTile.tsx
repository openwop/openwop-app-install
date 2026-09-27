/**
 * Quota attainment tile (ADR 0377 Wave 2) — top territories' attainment vs
 * quota as distribution bars. Two FIXED calls (listModels → activeModelId →
 * getAttainment; architect-approved, not N+1). Org-scoped; owns no data.
 */
import { useTranslation } from 'react-i18next';
import { listModels, getAttainment, type TerritoryAttainment } from '../../territories/territoriesClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatPercent } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileBars } from '../TileBars.js';
import type { DashboardTileProps } from '../tileTypes.js';

async function loadAttainment(orgId: string): Promise<TerritoryAttainment[] | null> {
  const { activeModelId } = await listModels(orgId);
  if (!activeModelId) return null; // no active model ⇒ designed empty state
  const res = await getAttainment(orgId, activeModelId);
  return res.territories;
}

export default function QuotaAttainmentTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<TerritoryAttainment[] | null>((orgId) => loadAttainment(orgId));

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['30%', '55%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const terrs = (data ?? []).filter((x) => x.attainment !== null);
  if (status === 'no-org' || terrs.length === 0) return <p className="dash-tile__state muted">{t('attainmentEmpty')}</p>;

  const bars = [...terrs]
    .sort((a, b) => (b.attainment ?? 0) - (a.attainment ?? 0))
    .slice(0, compact ? 4 : 8)
    .map((x) => ({
      key: x.territoryId,
      label: x.name,
      value: (x.attainment ?? 0) * 100,
      display: formatPercent(x.attainment ?? 0),
    }));

  return <TileBars bars={bars} max={100} />;
}
