/**
 * ADR 0949 P2b — an experiment's status as a labelled chip (status is never
 * colour alone, DESIGN.md §5.3). A draft with a locked plan says so; a legacy
 * test says it is read-only here.
 */
import { useTranslation } from 'react-i18next';
import type { Experiment } from './experimentsClient.js';

// DESIGN.md §5.3: running → accent, waiting on a human (a locked plan waiting
// for launch) → warning, paused/stopped → muted, cancelled/abandoned → danger.
const tone: Record<string, string> = {
  running: 'chip chip--accent',
  draft: 'chip chip--muted',
  locked: 'chip chip--warning',
  stopped: 'chip chip--muted',
  abandoned: 'chip chip--danger',
};

export function ExperimentStatusChip({ experiment }: { experiment: Pick<Experiment, 'status' | 'plan' | 'legacy'> }): JSX.Element {
  const { t } = useTranslation('experiments');
  const state = experiment.status === 'draft' && experiment.plan ? 'locked' : experiment.status;
  return (
    <span className="action-bar">
      <span className={tone[state] ?? 'chip'}>{t(`status_${state}`)}</span>
      {experiment.legacy ? <span className="chip chip--muted">{t('legacyChip')}</span> : null}
    </span>
  );
}
