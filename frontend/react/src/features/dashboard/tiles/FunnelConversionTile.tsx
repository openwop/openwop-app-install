/**
 * Funnel conversion tile (ADR 0375 Phase 3) — per-step conversion of the org's
 * first published funnel, over the EXISTING funnels client (two-hop: `listFunnels`
 * → `getFunnelStats`). Admin-tier, gated by the `funnels` toggle. Org-scoped; owns
 * no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { listFunnels, getFunnelStats, type FunnelStats, type Funnel } from '../../funnels/funnelsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatPercent } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileBars } from '../TileBars.js';
import { sharedRead } from '../sharedRead.js';
import type { DashboardTileProps } from '../tileTypes.js';

interface FunnelView { funnel: Funnel; stats: FunnelStats }

async function loadFirstFunnel(orgId: string): Promise<FunnelView | null> {
  const funnels = await listFunnels(orgId);
  const chosen = funnels.find((f) => f.status === 'published') ?? funnels[0];
  if (!chosen) return null;
  const stats = await getFunnelStats(orgId, chosen.funnelId);
  return { funnel: chosen, stats };
}

export default function FunnelConversionTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<FunnelView | null>((orgId) => sharedRead(`funnel-first:${orgId}`, () => loadFirstFunnel(orgId)));

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 4} columns={['60%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  if (status === 'no-org' || !data) return <p className="dash-tile__state muted">{t('funnelEmpty')}</p>;

  const steps = data.stats.steps.slice(0, compact ? 4 : 6);
  if (steps.length === 0) return <p className="dash-tile__state muted">{t('funnelEmpty')}</p>;

  // ADR 0377 Wave 2 — progressive render: stepped view-bars at full size (same fetch).
  if (!compact) {
    return (
      <TileBars
        bars={steps.map((s) => ({
          key: s.stepId,
          label: s.name ?? s.kind,
          value: s.views,
          display: s.conversion === null ? '—' : formatPercent(s.conversion),
        }))}
      />
    );
  }

  return (
    <ul className="dash-tile__list u-list-none u-m-0 u-p-0" aria-label={data.funnel.name}>
      {steps.map((s) => (
        <li key={s.stepId} className="dash-tile__row">
          <span className="dash-tile__row-main u-truncate" title={s.name}>{s.name ?? s.kind}</span>
          <span className="dash-tile__row-meta muted">{s.conversion === null ? '—' : formatPercent(s.conversion)}</span>
        </li>
      ))}
    </ul>
  );
}
