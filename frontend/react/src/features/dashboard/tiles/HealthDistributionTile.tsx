/**
 * Health distribution tile (ADR 0377 Wave 2) — CSM account health scores as a
 * 5-band histogram. Bands are NUMERIC ("0–19" … "80–100"), never semantic
 * names — presentation, not invented semantics (architect pin). Caller-scoped;
 * owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { listAccounts, type Account } from '../../csm/csmClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { useTileData } from '../useTileData.js';
import { TileBars } from '../TileBars.js';
import { sharedRead } from '../sharedRead.js';
import type { DashboardTileProps } from '../tileTypes.js';

const BANDS = [
  { key: 'b0', label: '0–19', lo: 0, hi: 20 },
  { key: 'b20', label: '20–39', lo: 20, hi: 40 },
  { key: 'b40', label: '40–59', lo: 40, hi: 60 },
  { key: 'b60', label: '60–79', lo: 60, hi: 80 },
  { key: 'b80', label: '80–100', lo: 80, hi: 101 },
] as const;

export default function HealthDistributionTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useTileData<Account[]>(() => sharedRead('csm-accounts', () => listAccounts()), []);

  if (status === 'loading') return <SkeletonRows rows={3} columns={['30%', '55%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const accounts = data ?? [];
  if (accounts.length === 0) return <p className="dash-tile__state muted">{t('csmEmpty')}</p>;

  // ADR 0582 §6 — a histogram that silently drops unmeasured rows would show a
  // shrinking, healthier-looking distribution as measurement degrades. The
  // unmeasured band is a named bar, so the failure is the thing that GROWS.
  const measured = accounts.filter((a) => a.healthScore !== undefined && !a.healthMeasureFailedAt);
  const bars: Array<{ key: string; label: string; value: number }> = BANDS.map((b) => ({
    key: b.key,
    label: b.label,
    value: measured.filter((a) => (a.healthScore as number) >= b.lo && (a.healthScore as number) < b.hi).length,
  }));
  const unmeasured = accounts.length - measured.length;
  if (unmeasured > 0) bars.push({ key: 'unmeasured', label: t('csmBandUnmeasured'), value: unmeasured });

  return <TileBars bars={bars} />;
}
