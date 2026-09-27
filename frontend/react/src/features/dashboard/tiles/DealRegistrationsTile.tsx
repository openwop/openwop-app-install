/**
 * Deal registrations tile (ADR 0377 Wave 1) — partner deal registrations over
 * the EXISTING dealers client. Org-scoped via `useOrgResource`; owns no data.
 */
import { useTranslation } from 'react-i18next';
import { listRegistrations, type DealRegistration } from '../../dealers/dealersClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function DealRegistrationsTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<DealRegistration[]>((orgId) => listRegistrations(orgId));

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['65%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = [...(data ?? [])]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, compact ? 4 : 8)
    .map((r) => ({ key: r.regId, label: r.dealTitle, to: '/dealers', meta: r.status, title: r.companyName }));
  if (status === 'no-org' || rows.length === 0) return <p className="dash-tile__state muted">{t('dealsEmpty')}</p>;
  return <TileList rows={rows} />;
}
