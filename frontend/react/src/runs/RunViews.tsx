/**
 * Run Card + shared flag chip — the grid cell of the §4.5 collection-view canon
 * for the Runs index. The page's `<ViewToggle>` switches between the sortable
 * `<DataTable>` (`list`) and a `.card-grid` of `<RunCard>` (`grid`).
 *
 * A run row navigates to its detail, so the whole card is a `<Link>` — the runId
 * renders as plain `<code>` (a nested <Link> inside the card link would be
 * invalid). The `<RunFlagChip>` review marker is shared by both the card and the
 * table's Run column so grid and list never diverge. Composes existing
 * primitives only — no new CSS.
 */

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { StatusBadge } from '../ui/StatusBadge.js';
import { FlagIcon } from '../ui/icons/index.js';
import { formatDateTime } from '../i18n/format.js';
import type { RunListItem } from '../client/runsClient.js';

/** The amber/danger "flagged for review" chip — shared by the card + table column. */
export function RunFlagChip({ flagged, reason }: { flagged: boolean; reason: string }): JSX.Element | null {
  const { t } = useTranslation('runs');
  if (!flagged) return null;
  return (
    <span className="chip chip--danger runs-review-flag" title={t('flaggedForReviewTitle', { reasons: reason })}>
      <FlagIcon size={10} /> {t('reviewChip')}
    </span>
  );
}

export function RunCard({ run: r, flagged, flagReason }: { run: RunListItem; flagged: boolean; flagReason: string }): JSX.Element {
  return (
    <Link to={`/runs/${r.runId}`} className="surface-card u-grid u-gap-2">
      <div className="u-flex u-items-baseline u-gap-2 u-wrap">
        <code className="u-fs-13">{r.runId.slice(0, 8)}…</code>
        <span className="u-ml-auto"><StatusBadge status={r.status} /></span>
      </div>
      <span className="muted u-fs-12">{r.workflowId}</span>
      <div className="u-flex u-items-center u-gap-2 u-wrap u-fs-11 muted">
        <span>{r.startedAt ? formatDateTime(r.startedAt) : '—'}</span>
        <span className="u-ml-auto"><RunFlagChip flagged={flagged} reason={flagReason} /></span>
      </div>
    </Link>
  );
}
