/**
 * Notifications tile (ADR 0377 Wave 1) — the caller's unread notifications over
 * the EXISTING notifications client. Poll-on-mount ONLY — deliberately NO SSE
 * inside a tile (Cloud Run slot budget; a dashboard of tiles must never each
 * open a stream — architect pin). Caller-scoped; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { listNotifications } from '../../../notifications/notificationsClient.js';
import type { Notification } from '../../../notifications/types.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import { useTileData } from '../useTileData.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function NotificationsTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const limit = compact ? 4 : 8;
  const { status, data } = useTileData<readonly Notification[]>(
    () => listNotifications({ status: 'unread', limit }),
    [limit],
  );

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '50%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = (data ?? []).map((n) => ({
    key: n.notificationId,
    label: n.title,
    to: '/inbox',
    meta: formatRelativeTime(n.createdAt),
    title: n.message,
  }));
  if (rows.length === 0) return <p className="dash-tile__state muted">{t('notificationsEmpty')}</p>;
  return <TileList rows={rows} />;
}
