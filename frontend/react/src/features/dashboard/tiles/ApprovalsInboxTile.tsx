/**
 * Approvals inbox tile (ADR 0377 Wave 1) — the tenant's pending-approval queue
 * (ADR 0066: backend visibility-filters per kind/caller), over the EXISTING
 * approvals client. The single highest-utility cross-cutting tile: many features
 * feed this one queue. Caller-scoped; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { listApprovals, type PendingApproval } from '../../../agents/approvalsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import { useTileData } from '../useTileData.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function ApprovalsInboxTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useTileData<PendingApproval[]>(() => listApprovals('pending'), []);

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '50%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = (data ?? []).slice(0, compact ? 4 : 8).map((a) => ({
    key: a.approvalId,
    label: a.cardTitle || a.pageTitle || a.strategyTitle || a.proposal,
    // ADR 0593 (CMSAU-15) — this tile was the ONE surface that read `pageTitle`,
    // and it sent every row to the agents ROSTER, where no approval surface is
    // mounted (the inbox lives on `/profile`, the decide list on `/inbox`). A
    // content-publish row now deep-links to the page it is about — the same
    // affordance both inboxes gained; everything else reaches a decide surface.
    to: a.kind === 'content-publish' && a.orgId && a.pageId
      ? `/cms/p/${encodeURIComponent(a.orgId)}/${encodeURIComponent(a.pageId)}`
      : '/inbox',
    meta: formatRelativeTime(a.createdAt),
    title: a.proposal,
  }));
  if (rows.length === 0) return <p className="dash-tile__state muted">{t('approvalsEmpty')}</p>;
  return <TileList rows={rows} />;
}
