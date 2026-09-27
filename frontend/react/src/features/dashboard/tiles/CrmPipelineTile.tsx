/**
 * CRM pipeline tile (ADR 0375 Phase 3) — a glance at open/won/win-rate from the
 * EXISTING crm reports client (`getPipelineReport`). Admin-tier, gated by the
 * `crm` toggle. Org-scoped; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { getPipelineReport, type PipelineReport } from '../../crm/crmReportsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber, formatPercent } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileStats } from '../TileStats.js';
import { TileBars } from '../TileBars.js';
import { sharedRead } from '../sharedRead.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function CrmPipelineTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<PipelineReport>((orgId) => sharedRead(`crm-pipeline:${orgId}`, () => getPipelineReport(orgId)));

  if (status === 'loading') return <SkeletonRows rows={2} columns={['30%', '30%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  if (status === 'no-org' || !data) return <p className="dash-tile__state muted">{t('crmPipelineEmpty')}</p>;

  const { totals } = data;
  return (
    <div>
      <TileStats
        stats={[
          { label: t('crmOpen'), value: formatNumber(totals.openCount) },
          { label: t('crmWon'), value: formatNumber(totals.wonCount) },
          { label: t('crmWinRate'), value: totals.winRate === null ? '—' : formatPercent(totals.winRate) },
        ]}
      />
      {/* ADR 0377 Wave 2 — progressive render: per-stage bars at full size (same fetch). */}
      {!compact && data.perStage.length > 0 ? (
        <div className="u-mt-3">
          <TileBars bars={data.perStage.map((s) => ({ key: s.stageId, label: s.name, value: s.count }))} />
        </div>
      ) : null}
    </div>
  );
}
