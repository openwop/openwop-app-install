/**
 * Mentions inbox tile (ADR 0377 Wave-3 deferral closed 2026-07-17) — channels
 * with unseen @mentions of you (mention-first), then other unread channels.
 * The deferral's "no read-only source" premise went stale: the channel LIST now
 * carries the caller's per-channel unread/mention counts (joined server-side
 * from the ADR 0192 D6 read markers — one existing call, zero new state).
 * Rows deep-link to the channel's conversation in chat (channels have no page
 * of their own — /channels redirects home). Caller-scoped; owns no data.
 */
import { useTranslation } from 'react-i18next';
import { listJoinableChannels, type ChannelListEntry } from '../../../client/channelsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { useTileData } from '../useTileData.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function MentionsInboxTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useTileData<ChannelListEntry[]>(() => listJoinableChannels(), []);

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['65%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = (data ?? [])
    .filter((c) => c.joined && ((c.mentionCount ?? 0) > 0 || (c.unreadCount ?? 0) > 0))
    .sort((a, b) => (b.mentionCount ?? 0) - (a.mentionCount ?? 0) || (b.unreadCount ?? 0) - (a.unreadCount ?? 0))
    .slice(0, compact ? 4 : 8)
    .map((c) => ({
      key: c.conversationId,
      label: c.channel?.name ?? c.conversationId,
      to: `/chat?conversation=${encodeURIComponent(c.conversationId)}`,
      meta: (c.mentionCount ?? 0) > 0
        ? t('mentionsCount', { n: c.mentionCount })
        : t('unreadCount', { n: c.unreadCount }),
    }));
  if (rows.length === 0) return <p className="dash-tile__state muted">{t('mentionsEmpty')}</p>;
  return <TileList rows={rows} />;
}
