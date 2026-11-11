/** ADR 1081 — fleet-shared, reusable core Kanban delivery health. */
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice, StateCard } from '../../ui/index.js';
import type { KanbanWorkItemDeliveryOutcome, KanbanWorkItemDeliverySummary } from '../../client/operationsClient.js';

export interface KanbanDeliveryPanelProps {
  summary: KanbanWorkItemDeliverySummary | null;
  forbidden: boolean;
  failed: boolean;
  onRetry: () => void;
}

const OUTCOMES: readonly KanbanWorkItemDeliveryOutcome[] = [
  'started',
  'retried',
  'dead-lettered',
  'not-eligible',
  'deferred',
  'workflow-unresolved',
];

function outcomeKey(outcome: KanbanWorkItemDeliveryOutcome): string {
  switch (outcome) {
    case 'started': return 'kanbanDeliveryOutcomeStarted';
    case 'retried': return 'kanbanDeliveryOutcomeRetried';
    case 'dead-lettered': return 'kanbanDeliveryOutcomeDeadLettered';
    case 'not-eligible': return 'kanbanDeliveryOutcomeNotEligible';
    case 'deferred': return 'kanbanDeliveryOutcomeDeferred';
    case 'workflow-unresolved': return 'kanbanDeliveryOutcomeWorkflowUnresolved';
  }
}

function outcomeClass(outcome: KanbanWorkItemDeliveryOutcome, count: number): string {
  if (outcome === 'dead-lettered' && count > 0) return 'chip chip--danger';
  if ((outcome === 'retried' || outcome === 'workflow-unresolved') && count > 0) return 'chip chip--warning';
  if (outcome === 'started' && count > 0) return 'chip chip--success';
  return 'chip chip--muted';
}

/**
 * The Operations hub owns the request lifecycle and gives this panel its
 * independent result. Keeping the outcome labels closed and the body aggregate
 * only means the display is useful for every canvas type without projecting a
 * card, workflow input, tenant, user, or error message.
 */
export function KanbanDeliveryPanel({ summary, forbidden, failed, onRetry }: KanbanDeliveryPanelProps): JSX.Element {
  const { t } = useTranslation('operations');
  if (forbidden) return <StateCard title={t('operatorOnlyTitle')} body={t('operatorOnlyBody')} />;
  if (failed && !summary) {
    return (
      <StateCard
        announce
        title={t('kanbanDeliveryUnavailableTitle')}
        body={t('kanbanDeliveryUnavailableBody')}
        action={<Button variant="secondary" onClick={onRetry}>{t('refresh')}</Button>}
      />
    );
  }
  if (!summary) return <StateCard loading title={t('loading')} />;

  const hasConcern = summary.queue.deadLettered > 0 || summary.outcomes['dead-lettered'] > 0;
  const hasRetry = summary.outcomes.retried > 0 || summary.outcomes['workflow-unresolved'] > 0;
  return (
    <article className="surface-card">
      {failed ? <Notice variant="warning" announce={t('kanbanDeliveryStale')}>{t('kanbanDeliveryStale')}</Notice> : null}
      <header className="action-bar">
        <span className={hasConcern ? 'chip chip--danger' : hasRetry ? 'chip chip--warning' : 'chip chip--success'}>
          {hasConcern ? t('kanbanDeliveryAttention') : hasRetry ? t('kanbanDeliveryRecovering') : t('kanbanDeliveryHealthy')}
        </span>
        <span className="chip chip--muted">{t('kanbanDeliveryFleetWide')}</span>
        <span className="chip chip--muted">{t('kanbanDeliveryQueueWaiting', { n: summary.queue.pending })}</span>
        <span className="chip chip--muted">{t('kanbanDeliveryQueueClaimed', { n: summary.queue.claimed })}</span>
        <span className={summary.queue.deadLettered > 0 ? 'chip chip--danger' : 'chip chip--success'}>
          {t('kanbanDeliveryQueueDead', { n: summary.queue.deadLettered })}
        </span>
        {summary.queue.oldestPendingAgeS !== null ? (
          <span className="chip chip--muted">{t('kanbanDeliveryOldestPending', { n: summary.queue.oldestPendingAgeS })}</span>
        ) : null}
      </header>
      <p>{t('kanbanDeliveryOutcomeWindow')}</p>
      <ul className="action-bar" aria-label={t('kanbanDeliveryOutcomesAria')}>
        {OUTCOMES.map((outcome) => (
          <li key={outcome} className={outcomeClass(outcome, summary.outcomes[outcome])}>
            {t(outcomeKey(outcome), { n: summary.outcomes[outcome] })}
          </li>
        ))}
      </ul>
    </article>
  );
}
