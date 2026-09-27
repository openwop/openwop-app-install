/**
 * Team workload tile (ADR 0377 Wave 3) — open cards per assignee across all
 * boards, in ONE request (`listBoardsWithCards` — the same anti-N+1 read the
 * agents dashboard uses) rendered as distribution bars. Admin-tier (matches
 * the admin-gated /boards the data comes from). Owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { listBoardsWithCards, type KanbanBoardWithCards } from '../../../kanban/kanbanClient.js';
import { listProfiles } from '../../profiles/profilesClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { useTileData } from '../useTileData.js';
import { TileBars } from '../TileBars.js';
import type { DashboardTileProps } from '../tileTypes.js';

interface WorkloadData { boards: KanbanBoardWithCards[]; names: Map<string, string> }

// DASH-U3 (grade-ux): resolve assignee ids to display names via ONE parallel
// caller-scoped listProfiles() (profiles are optional — fall back to the id).
async function loadWorkload(): Promise<WorkloadData> {
  const [boards, profiles] = await Promise.all([
    listBoardsWithCards(),
    listProfiles().catch(() => []),
  ]);
  const names = new Map(profiles.filter((p) => p.displayName).map((p) => [p.userId, p.displayName!]));
  return { boards, names };
}

export default function TeamWorkloadTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useTileData<WorkloadData>(() => loadWorkload(), []);

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['30%', '55%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const counts = new Map<string, number>();
  for (const b of data?.boards ?? []) {
    for (const c of b.cards) {
      if (c.completedAt) continue; // open work only
      const who = c.assigneeId ?? c.assigneeRole ?? t('workloadUnassigned');
      counts.set(who, (counts.get(who) ?? 0) + 1);
    }
  }
  const bars = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, compact ? 4 : 8)
    .map(([who, n]) => ({ key: who, label: data?.names.get(who) ?? who, value: n }));
  if (bars.length === 0) return <p className="dash-tile__state muted">{t('workloadEmpty')}</p>;
  return <TileBars bars={bars} />;
}
