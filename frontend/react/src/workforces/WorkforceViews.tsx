/**
 * Workforce Card + Row — the two cells of the §4.5 collection-view canon
 * (rule 11) for the /workforces gallery. The Card fills a `.card-grid` and
 * KEEPS the page's signature visuals intact — the autonomy `.wf-track` (trust
 * journey) + the `.wf-outcome-*` headline outcome. The Row fills a
 * `.surface-card.list-view` as a dense SUMMARY: it OMITS the full track (that's
 * the card's job) and shows the current autonomy stage as a compact chip
 * instead. Both derive their sub-line + the autonomy stage from the SAME
 * helpers below, so the grid and list views never diverge.
 */

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { AlertIcon, BoxesIcon } from '../ui/icons/index.js';
import { AutonomyTrack } from './AutonomyTrack.js';
import { journeyIndex, journeyLabelKey, statusChipClass } from './labels.js';
import type { Workforce } from '../client/workforcesClient.js';

/** What needs a human + the headline outcome, per workforce (mirrors the
 *  gallery page's WfSignals — declared locally so the two cells share it). */
export interface WfSignals {
  openApprovals: number;
  eligible: boolean;
  policyViolations: number;
  /** Share cleared without escalating to a human (1 − escalationRate); null = no runs. */
  handledShare: number | null;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** The contextual one-liner from REAL fields — the workforce's plain-language
 *  purpose statement. Shared by Card + Row. */
export function workforceSubLine(wf: Workforce): string {
  return wf.purpose.statement;
}

/** The current trust-journey stage label (Watching → Assisting → Running on
 *  its own). Shared by Card (the rail's current stop) + Row (a compact chip). */
export function workforceStageLabel(wf: Workforce, t: TFunction): string {
  return t(journeyLabelKey(wf.status));
}

/** Attention chips (awaiting-approval / ready-for-more / policy-issues),
 *  shared so the card and the dense row read the same way (rule 6). */
function WorkforceSignalChips({ signals, t }: { signals: WfSignals; t: TFunction }): JSX.Element | null {
  if (!(signals.openApprovals > 0 || signals.eligible || signals.policyViolations > 0)) return null;
  return (
    <>
      {signals.openApprovals > 0 ? (
        <span className="chip chip--warning"><AlertIcon size={12} aria-hidden /> {t('awaitingApprovalChip', { count: signals.openApprovals })}</span>
      ) : null}
      {signals.eligible ? <span className="chip chip--success">{t('readyForMoreChip')}</span> : null}
      {signals.policyViolations > 0 ? (
        <span className="chip chip--danger"><AlertIcon size={12} aria-hidden /> {t('policyIssuesChip', { count: signals.policyViolations })}</span>
      ) : null}
    </>
  );
}

export function WorkforceCard({ wf, signals }: { wf: Workforce; signals: WfSignals | null }): JSX.Element {
  const { t } = useTranslation('workforces');
  return (
    <Link
      to={`/workforces/${encodeURIComponent(wf.workforceId)}`}
      className="surface-card wfgallery-card-link"
    >
      <div className="action-bar u-justify-between u-items-baseline">
        <h3 className="u-m-0">{wf.name}</h3>
        <span className="muted u-fs-13 u-nowrap">{t('agentsCount', { count: wf.agents.length })}</span>
      </div>
      <p className="wfgallery-statement">{workforceSubLine(wf)}</p>

      <AutonomyTrack status={wf.status} compact />

      {signals == null ? null /* couldn't load — don't claim a state */
        : signals.handledShare === null ? (
          <p className="muted wfgallery-noruns">{t('noRunsYet')}</p>
        ) : (
          <div>
            <span className="wf-outcome-n">{pct(signals.handledShare)}</span>
            <span className="wf-outcome-l wfgallery-outcome-inline">{t('clearedWithoutEscalation')}</span>
          </div>
        )}

      {signals ? (
        <div className="action-bar u-gap-2 u-wrap u-mt-1-5">
          <WorkforceSignalChips signals={signals} t={t} />
        </div>
      ) : null}
    </Link>
  );
}

export function WorkforceRow({ wf, signals }: { wf: Workforce; signals: WfSignals | null }): JSX.Element {
  const { t } = useTranslation('workforces');
  const href = `/workforces/${encodeURIComponent(wf.workforceId)}`;
  const stage = workforceStageLabel(wf, t);
  // Compact autonomy stage chip — colour-matched to the lifecycle status, same
  // as the gallery card + detail header (rule 7). The full rail stays on the card.
  const stageChip = statusChipClass(wf.status);
  return (
    <div className="list-row">
      <Link to={href} className="list-row-id" title={t('openWorkforce', { name: wf.name })}>
        <BoxesIcon size={18} aria-hidden />
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{wf.name}</span>
          </span>
          <span className="list-row-sub">{workforceSubLine(wf)}</span>
        </span>
      </Link>
      <div className="list-row-meta">
        <span className={stageChip} title={t('autonomyStageTitle')}>
          {t('autonomyStageChip', { stage, n: journeyIndex(wf.status) + 1 })}
        </span>
        {signals == null ? null : (
          <>
            {signals.handledShare !== null ? (
              <span className="chip chip--muted">{t('clearedChip', { pct: pct(signals.handledShare) })}</span>
            ) : null}
            <WorkforceSignalChips signals={signals} t={t} />
          </>
        )}
      </div>
      <div className="list-row-actions action-bar">
        <Link to={href} className="secondary btn-sm">{t('openWorkforceAction')}</Link>
      </div>
    </div>
  );
}
