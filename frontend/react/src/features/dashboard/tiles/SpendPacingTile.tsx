/**
 * Spend pacing tile (ADR 0377 Wave 2) — per-campaign budget consumption
 * (`getPacing().rows`: spentPct vs plan) as distribution bars. The honest shape
 * for "spend pacing": no daily series exists in the client (architect ruling —
 * CampaignForecast.projection is a scalar), so pacing is a per-campaign bar,
 * not a fake time series. Org-scoped; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { getPacing, type PacingReport } from '../../campaign-intel/campaignIntelClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatPercent } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileBars } from '../TileBars.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function SpendPacingTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<PacingReport>((orgId) => getPacing(orgId));

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['30%', '55%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const rows = data?.rows ?? [];
  if (status === 'no-org' || rows.length === 0) return <p className="dash-tile__state muted">{t('pacingEmpty')}</p>;

  const bars = rows.slice(0, compact ? 4 : 8).map((r) => ({
    key: r.campaignId,
    label: r.name,
    value: r.spentPct,
    display: formatPercent(r.spentPct / 100),
  }));

  return <TileBars bars={bars} max={100} />;
}
