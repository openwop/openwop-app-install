/**
 * Upcoming agenda tile (ADR 0377 Wave 3) — the linear agenda type: dated items
 * merged from TWO fixed caller-relevant sources (scheduled agent chats'
 * `nextRunAt` + my assigned cards' `dueAt`), soonest first. Sources load via
 * Promise.allSettled so a toggled-off/failed source contributes nothing instead
 * of blanking the tile. The kanban source is CALLER-scoped and must not be
 * gated on org resolution (grade-code fix S4 — a no-org caller still sees
 * their due cards; only the scheduled source needs an org). Kanban rows carry
 * NO link — /boards is admin-tier and this tile is workspace (no dead-end
 * affordance, ADR 0377 rule).
 */
import { useTranslation } from 'react-i18next';
import { listScheduledChats } from '../../../client/scheduledChatsClient.js';
import { listAssignedToMe } from '../../../kanban/kanbanClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import { useDashboardOrg } from '../useDashboardOrg.js';
import { useTileData } from '../useTileData.js';
import { TileList, type TileRow } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

interface AgendaItem { key: string; label: string; at: string; to?: string | undefined; title?: string | undefined }

async function loadAgenda(orgId: string | null): Promise<AgendaItem[]> {
  const [sched, mine] = await Promise.allSettled([
    orgId ? listScheduledChats(orgId) : Promise.resolve([]),
    listAssignedToMe(),
  ]);
  const items: AgendaItem[] = [];
  if (sched.status === 'fulfilled') {
    for (const s of sched.value) {
      if (s.enabled && s.nextRunAt) {
        items.push({ key: `sched:${s.chatId}`, label: s.agentId, at: s.nextRunAt, to: `/chat?conversation=${encodeURIComponent(s.conversationId)}`, title: s.prompt });
      }
    }
  }
  if (mine.status === 'fulfilled') {
    for (const c of mine.value) {
      if (!c.terminal && c.dueAt) items.push({ key: `card:${c.id}`, label: c.title, at: c.dueAt, title: c.boardName });
    }
  }
  return items.sort((a, b) => (a.at < b.at ? -1 : 1));
}

export default function UpcomingAgendaTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { orgId, loading: orgLoading } = useDashboardOrg();
  // Org failure/absence degrades to the caller-scoped source only (never blanks).
  const { status, data } = useTileData<AgendaItem[]>(
    () => (orgLoading ? Promise.resolve([]) : loadAgenda(orgId)),
    [orgLoading, orgId],
  );

  if (status === 'loading' || orgLoading) return <SkeletonRows rows={compact ? 3 : 5} columns={['65%', '40%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows: TileRow[] = (data ?? []).slice(0, compact ? 4 : 8).map((i) => ({
    key: i.key, label: i.label, to: i.to, meta: formatRelativeTime(i.at), title: i.title,
  }));
  if (rows.length === 0) return <p className="dash-tile__state muted">{t('agendaEmpty')}</p>;
  return <TileList rows={rows} />;
}
