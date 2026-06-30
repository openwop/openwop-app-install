/**
 * The autonomy track — the signature visual of /workforces.
 *
 * A 3-stop rail showing where a workforce is on its trust journey:
 * Watching → Assisting → Running on its own. Past stops are filled, the
 * current stop is filled + emphasized, future stops are hollow. This single
 * metaphor replaces the shadow/piloting/production + review/guided/auto jargon
 * for the operator. Token-only styling lives in global.css (`.wf-track*`).
 */
import { useTranslation } from 'react-i18next';
import { JOURNEY, journeyIndex, journeyLabelKey } from './labels.js';
import type { WorkforceStatus } from '../client/workforcesClient.js';

export function AutonomyTrack({ status, compact = false }: { status: WorkforceStatus; compact?: boolean }): JSX.Element {
  const { t } = useTranslation('workforces');
  const current = journeyIndex(status);
  return (
    <div className={`wf-track${compact ? ' wf-track--compact' : ''}`} role="img" aria-label={t('trackAriaLabel', { label: t(journeyLabelKey(JOURNEY[current]!.status)), stage: current + 1, total: JOURNEY.length })}>
      {JOURNEY.map((step, i) => {
        const state = i < current ? 'is-done' : i === current ? 'is-current' : 'is-future';
        return (
          <div className="wf-track-node" key={step.status}>
            {i > 0 ? <span className={`wf-track-seg${i <= current ? ' is-done' : ''}`} aria-hidden /> : null}
            <span className="wf-track-stop">
              <span className={`wf-track-dot ${state}`} aria-hidden />
              <span className={`wf-track-label${i === current ? ' is-current' : ''}`}>{t(journeyLabelKey(step.status))}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
