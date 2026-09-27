/**
 * Commissions tile (ADR 0377 Wave 1) — statement counts by status over the
 * EXISTING sales-commissions client. Counts only — statements are per-currency,
 * so summing totals across them would be dishonest (the commissions page owns
 * per-currency presentation). Org-scoped via `useOrgResource`.
 */
import { useTranslation } from 'react-i18next';
import { listStatements, type CommissionStatement } from '../../sales-commissions/commissionsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileStats } from '../TileStats.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function CommissionsTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<CommissionStatement[]>((orgId) => listStatements(orgId));

  if (status === 'loading') return <SkeletonRows rows={2} columns={['30%', '30%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const rows = data ?? [];
  if (status === 'no-org' || rows.length === 0) return <p className="dash-tile__state muted">{t('commissionsEmpty')}</p>;

  const by = (s: CommissionStatement['status']): number => rows.filter((r) => r.status === s).length;
  return (
    <TileStats
      stats={[
        { label: t('commissionsDraft'), value: formatNumber(by('draft')) },
        { label: t('commissionsApproved'), value: formatNumber(by('approved')) },
        { label: t('commissionsPaid'), value: formatNumber(by('paid')) },
      ]}
    />
  );
}
