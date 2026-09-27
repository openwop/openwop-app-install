/**
 * Upcoming scheduled agents tile (ADR 0375 Phase 3) — enabled scheduled agent
 * chats (ADR 0125) sorted by next fire time, over the EXISTING scheduled-chats
 * client. Org-scoped via the shared `useOrgResource`; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listScheduledChats, type ScheduledChat } from '../../../client/scheduledChatsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function ScheduledAgentsTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<ScheduledChat[]>((orgId) => listScheduledChats(orgId));

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['65%', '55%', '50%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  if (status === 'no-org') return <p className="dash-tile__state muted">{t('scheduledAgentsEmpty')}</p>;

  const upcoming = (data ?? [])
    .filter((s) => s.enabled && s.nextRunAt)
    .sort((a, b) => (a.nextRunAt! < b.nextRunAt! ? -1 : 1))
    .slice(0, compact ? 4 : 8);
  if (upcoming.length === 0) return <p className="dash-tile__state muted">{t('scheduledAgentsEmpty')}</p>;

  return (
    <ul className="dash-tile__list u-list-none u-m-0 u-p-0">
      {upcoming.map((s) => (
        <li key={s.chatId} className="dash-tile__row">
          <Link to={`/chat?conversation=${encodeURIComponent(s.conversationId)}`} className="dash-tile__row-main u-truncate" title={s.prompt}>
            {s.agentId}
          </Link>
          <span className="dash-tile__row-meta muted">{formatRelativeTime(s.nextRunAt!)}</span>
        </li>
      ))}
    </ul>
  );
}
