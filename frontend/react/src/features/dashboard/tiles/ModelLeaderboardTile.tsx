/**
 * Model leaderboard tile (ADR 0377 Wave 1) — top models by confidence score/win-rate from
 * captured feedback, over the EXISTING evals client. Org-scoped via
 * `useOrgResource`; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { fetchLeaderboard, type LeaderboardRow } from '../../../client/evalsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatPercent } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function ModelLeaderboardTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<LeaderboardRow[]>((orgId) => fetchLeaderboard(orgId));

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['65%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = [...(data ?? [])]
    // ADR 0986 D3 — the server's confidence-aware score, not the retired Elo.
    .sort((a, b) => b.score - a.score)
    .slice(0, compact ? 4 : 8)
    // ADR 0718 D1 — the CONSOLE, not `/leaderboard`. That path is owned by
    // `kicktodo-engagement` (tier:'site'), and `App.tsx` selects a site-tier route by
    // path BEFORE the router runs — so it pre-empts the admin-tier evals route
    // regardless of manifest order. A row labelled with a MODEL name used to land on
    // the gamification board.
    .map((r) => ({ key: r.key, label: r.model, to: '/models?tab=leaderboard', meta: t('leaderboardTileMeta', { score: formatPercent(r.score), count: r.raters }) }));
  if (status === 'no-org' || rows.length === 0) return <p className="dash-tile__state muted">{t('leaderboardEmpty')}</p>;
  return <TileList rows={rows} />;
}
