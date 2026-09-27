/**
 * Recent conversations tile (ADR 0375 Phase 2) — a compact projection over the
 * EXISTING chat-sessions client (`listChatSessions`). Owns no data (ADR 0082).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listChatSessions, type ChatSessionHeader } from '../../../client/chatSessionsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function RecentConversationsTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const [sessions, setSessions] = useState<ChatSessionHeader[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    listChatSessions()
      .then((s) => { if (live) setSessions(s.slice(0, compact ? 4 : 8)); })
      .catch(() => { if (live) { setSessions([]); setError(true); } });
    return () => { live = false; };
  }, [compact]);

  if (sessions === null) return <SkeletonRows rows={compact ? 3 : 5} columns={['65%', '50%', '55%']} />;
  if (error) return <p className="dash-tile__state muted">{t('tileError')}</p>;
  if (sessions.length === 0) return <p className="dash-tile__state muted">{t('recentConversationsEmpty')}</p>;

  return (
    <ul className="dash-tile__list u-list-none u-m-0 u-p-0">
      {sessions.map((s) => (
        <li key={s.sessionId} className="dash-tile__row">
          <Link to={`/chat?conversation=${encodeURIComponent(s.sessionId)}`} className="dash-tile__row-main u-truncate" title={s.title}>
            {s.title || t('untitledConversation')}
          </Link>
          <span className="dash-tile__row-meta muted">{formatRelativeTime(s.updatedAt)}</span>
        </li>
      ))}
    </ul>
  );
}
