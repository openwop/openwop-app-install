/**
 * Suggested automations tile (ADR 0377 Wave 1) — ambient work-graph workflow
 * suggestions awaiting review, over the EXISTING work-graph client. Org-scoped
 * via `useOrgResource`; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { listSuggestions, type WorkflowSuggestion } from '../../ambient-work-graph/workGraphClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function SuggestedAutomationsTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<WorkflowSuggestion[]>((orgId) => listSuggestions(orgId));

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '25%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const rows = (data ?? [])
    .filter((s) => s.status === 'suggested')
    .slice(0, compact ? 4 : 8)
    .map((s) => ({
      key: s.suggestionId,
      label: s.sampleGoal ?? s.toolSequence.join(' → '),
      to: '/work-patterns',
      meta: t('seenTimes', { n: s.count }),
    }));
  if (status === 'no-org' || rows.length === 0) return <p className="dash-tile__state muted">{t('suggestionsEmpty')}</p>;
  return <TileList rows={rows} />;
}
