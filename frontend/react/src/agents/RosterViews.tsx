/**
 * Roster Card + shared cells — the grid cell of the §4.5 collection-view canon
 * for the Standing Agent Roster (`/roster`, RFC 0086/0087).
 *
 * The page's `<ViewToggle>` switches between the sortable `<DataTable>` (`list`)
 * and a `.card-grid` of `<RosterCard>` (`grid`). Unlike the templates library the
 * roster row is NOT a navigation link — it carries inline governance actions
 * (flip autonomy, open the guardrails profile, delete). So the card is a
 * `.surface-card` container with those same buttons inside (the AdvisoryBoardCard
 * shape), never a `<Link>` wrapper. The `autonomyBadge` helper is shared by both
 * the card and the table's Autonomy column so grid and list never diverge.
 * Composes existing primitives only — no new CSS.
 */

import { Button } from '../ui/Button.js';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { TFunction } from 'i18next';
import { StatusBadge } from '../ui/StatusBadge.js';
import { IconButton } from '../ui/IconButton.js';
import { ShieldIcon, TrashIcon } from '../ui/icons/index.js';
import type { RosterEntry } from './rosterClient.js';

/** Autonomy → a labelled StatusBadge tone (status semantics come from the badge,
 *  never an inline color). `review` is a held/needs-sign-off posture → amber;
 *  `auto` runs immediately → completed/green. Shared by the card + table column. */
export function autonomyBadge(level: RosterEntry['autonomyLevel'], t: TFunction): JSX.Element {
  if (level === 'review') return <StatusBadge status="waiting-approval" label={t('rosterLevelReview')} />;
  if (level === 'guided') return <StatusBadge status="paused" label={t('rosterLevelGuided')} />;
  return <StatusBadge status="completed" label={t('rosterLevelAuto')} />;
}

/** The handlers a roster card/row needs — the page owns the actual client calls. */
export interface RosterActions {
  onToggleAutonomy: (r: RosterEntry) => void;
  onProfile: (r: RosterEntry) => void;
  onDeleteRequest: (r: RosterEntry) => void;
}

const autonomyOf = (r: RosterEntry): 'auto' | 'guided' | 'review' => r.autonomyLevel ?? 'auto';

export function RosterCard({ entry: r, onToggleAutonomy, onProfile, onDeleteRequest }: { entry: RosterEntry } & RosterActions): JSX.Element {
  const { t } = useTranslation('agents');
  return (
    <div className="surface-card u-grid u-gap-2">
      <div className="u-flex u-items-baseline u-gap-2 u-wrap">
        <Link className="inline-link" to={`/agents/${encodeURIComponent(r.rosterId)}`}><strong className="u-fs-14">{r.persona}</strong></Link>
        <span className="muted u-fs-12">{r.rosterId}{r.enabled ? '' : t('rosterDisabled')}</span>
        <span className="u-ml-auto">{autonomyBadge(r.autonomyLevel, t)}</span>
      </div>
      <code className="roster-wf-code u-fs-11">{r.agentRef.agentId}</code>
      {r.workflows.length > 0 ? (
        <div className="u-flex u-gap-2 u-wrap">
          {r.workflows.map((w) => <span key={w} className="chip chip--muted">{w}</span>)}
        </div>
      ) : <span className="muted u-fs-13">{t('rosterNoWorkflows')}</span>}
      <div className="action-bar u-items-center u-gap-2">
        <Button
          variant="secondary" className="u-fs-12"
          onClick={() => onToggleAutonomy(r)}
          title={autonomyOf(r) === 'review' ? t('rosterSetAutoTitle') : t('rosterSetReviewTitle')}
        >
          {autonomyOf(r) === 'review' ? t('rosterSetAuto') : t('rosterSetReview')}
        </Button>
        <Button
          variant="secondary" className="u-fs-12 u-flex u-items-center u-gap-1 u-ml-auto"
          onClick={() => onProfile(r)}
          title={t('rosterProfileTitle', { persona: r.persona })}
        >
          <ShieldIcon size={13} aria-hidden /> {t('rosterProfile')}
        </Button>
        <IconButton
          label={t('rosterDeletePersona', { persona: r.persona })}
          icon={<TrashIcon size={15} />}
          onClick={() => onDeleteRequest(r)}
        />
      </div>
    </div>
  );
}
