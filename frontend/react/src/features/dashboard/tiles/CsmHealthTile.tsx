/**
 * Account health tile (ADR 0377 Wave 1) — the lowest-health customer-success
 * accounts over the EXISTING csm client. Shows raw scores (no invented health
 * bands — the CSM page owns that semantics). Caller-scoped; owns no data.
 *
 * ADR 0582 §6 — `healthScore` is OPTIONAL on the wire and absent means NEVER
 * MEASURED. This tile used to sort on it directly, so an unmeasured account
 * (which the store defaulted to 50, or which a broken CRM fan-in scored 100)
 * took a position in the at-risk ranking it had not earned. Unmeasured accounts
 * are now excluded from the ranking and reported as their own line, so a
 * measurement outage makes the tile say MORE, not less.
 */
import { useTranslation } from 'react-i18next';
import { listAccounts, type Account } from '../../csm/csmClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber } from '../../../i18n/format.js';
import { useTileData } from '../useTileData.js';
import { TileList } from '../TileList.js';
import { sharedRead } from '../sharedRead.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function CsmHealthTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useTileData<Account[]>(() => sharedRead('csm-accounts', () => listAccounts()), []);

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '25%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const accounts = data ?? [];
  const measured = accounts.filter((a) => a.healthScore !== undefined && !a.healthMeasureFailedAt);
  const unmeasured = accounts.length - measured.length;
  const rows = [...measured]
    .sort((a, b) => (a.healthScore as number) - (b.healthScore as number)) // lowest health first — the at-risk view
    .slice(0, compact ? 4 : 8)
    .map((a) => ({ key: a.accountId, label: a.name, to: '/csm', meta: formatNumber(a.healthScore as number) }));
  // An unmeasured account is not a healthy one. Say so rather than ranking it.
  if (unmeasured > 0) {
    rows.push({ key: '__unmeasured', label: t('csmUnmeasured', { count: unmeasured }), to: '/csm?health=unscored', meta: '—' });
  }
  if (rows.length === 0) return <p className="dash-tile__state muted">{t('csmEmpty')}</p>;
  return <TileList rows={rows} />;
}
