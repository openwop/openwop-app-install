/**
 * Recurring tasks (ADR 0023) — the Chief of Staff's perception loops, surfaced
 * at the bottom of its agent workspace page. These are the agent's standing
 * recurring work (calendar/drive ingestion, the morning briefing); each is a
 * real RFC 0052 scheduler job carrying the agent's rosterId, so it also appears
 * in the Schedules tab. This panel adds the loop-specific affordance: a labelled
 * enable/disable toggle with the human description + last/next run.
 *
 * Only meaningful for the Chief of Staff (the only agent that owns named loops),
 * so the workspace page renders it solely for `roleKey === 'chief-of-staff'`.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listLoops, setLoopEnabled, type AssistantLoop } from '../features/assistant/assistantClient.js';
import { StatusBadge } from '../ui/StatusBadge.js';
import { toast } from '../ui/toast.js';
import { formatDateTime } from '../i18n/format.js';

export function RecurringTasksPanel(): JSX.Element {
  const { t } = useTranslation('agents');
  const [loops, setLoops] = useState<AssistantLoop[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void listLoops()
      .then(setLoops)
      .catch((e) => setError(e instanceof Error ? e.message : t('recurringLoadError')));
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const toggle = useCallback(
    async (loop: AssistantLoop) => {
      setBusy(loop.loopId);
      try {
        await setLoopEnabled(loop.loopId, !loop.enabled);
        toast.success(loop.enabled ? t('recurringPaused', { label: loop.label }) : t('recurringEnabled', { label: loop.label }));
        load();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : t('recurringUpdateError'));
      } finally {
        setBusy(null);
      }
    },
    [load, t],
  );

  return (
    <article className="surface-card u-grid u-gap-2">
      <header>
        <h2>{t('recurringTitle')}</h2>
        <p className="muted">
          {t('recurringLede')}
        </p>
      </header>
      {error ? <p className="muted">{error}</p> : null}
      <ul className="u-grid u-gap-2">
        {(loops ?? []).map((loop) => (
          <li key={loop.loopId} className="u-flex u-gap-2 u-items-center">
            <span className="u-flex-1">
              <strong>{loop.label}</strong>
              <span className="muted u-block">{loop.description}</span>
              <span className="muted u-block u-text-sm">
                {loop.lastRunAt ? t('recurringLastRun', { when: formatDateTime(loop.lastRunAt) }) : t('recurringNeverRun')}
                {loop.enabled && loop.nextFireAt ? t('recurringNext', { when: formatDateTime(loop.nextFireAt) }) : ''}
              </span>
            </span>
            <StatusBadge status={loop.enabled ? 'active' : 'paused'} label={loop.enabled ? t('recurringOn') : t('recurringOff')} />
            <button
              type="button"
              className={loop.enabled ? 'secondary' : 'btn-accent'}
              disabled={busy === loop.loopId}
              aria-pressed={loop.enabled}
              onClick={() => void toggle(loop)}
            >
              {loop.enabled ? t('recurringPause') : t('recurringEnable')}
            </button>
          </li>
        ))}
        {loops !== null && loops.length === 0 ? <li className="muted">{t('recurringEmpty')}</li> : null}
      </ul>
    </article>
  );
}
