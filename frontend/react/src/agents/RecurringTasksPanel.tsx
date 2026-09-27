/**
 * Recurring tasks (ADR 0023) — the Chief of Staff's perception loops, surfaced
 * at the bottom of its agent workspace page. These are the agent's standing
 * recurring work (calendar/drive ingestion, the morning briefing); each is a
 * real RFC 0052 scheduler job carrying the agent's rosterId, so it also appears
 * in the Schedules tab. This panel adds the loop-specific affordance: a labelled
 * enable/disable toggle with the human description + last/next run.
 *
 * WHO SEES IT (corrected, AST-UX-2 2026-08-19). This docblock used to say "only
 * meaningful for the Chief of Staff … rendered solely for
 * `roleKey === 'chief-of-staff'`", and that sentence was the stale rule
 * propagating: the loops belong to the `assistant` CAPABILITY, which any roster
 * agent can carry (ADR 0023 §Correction, `features/assistant/capability.ts`).
 * The workspace page now gates on the capability (`AssistantControlPanels`),
 * keeping the roleKey only as the documented bootstrap fallback. The loops
 * themselves are TENANT-scoped, not agent-scoped — `listLoops` reads the
 * tenant's scheduler jobs — so this panel shows the same three loops on every
 * capability-carrying agent, by design ("no Iris's graph, only the tenant
 * work-graph").
 */
import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listLoops, setLoopEnabled, type AssistantLoop } from '../features/assistant/assistantClient.js';
import { StatusBadge } from '../ui/StatusBadge.js';
import { toast } from '../ui/toast.js';
import { formatDateTime } from '../i18n/format.js';

/** WF-COS-4 — reason code → catalog key. A `Record` rather than a ternary chain
 *  so a new reason code on the wire is a compile error here, not silence. */
const SKIP_REASON_KEY: Record<NonNullable<AssistantLoop['lastSkipReason']>, string> = {
  budget: 'recurringSkipBudget',
  'workflow-unresolved': 'recurringSkipUnresolved',
  'dispatch-error': 'recurringSkipDispatch',
};

/**
 * WF-COS-4 (round 2) — resolve the wire value to a catalog key WITHOUT
 * fabricating and without going silent. The first version was
 * `SKIP_REASON_KEY[loop.lastSkipReason ?? 'dispatch-error']`, which had both
 * failure modes the panel exists to avoid:
 *   - a note carrying NO reason rendered "the run could not be started" — an
 *     invented diagnosis, on the surface whose whole point is not claiming
 *     things that did not happen;
 *   - nothing validates the wire string against the union (it is a plain
 *     `lastSkipReason?: '…'` on the client type, so any server value survives
 *     the cast), and an unknown code indexed to `undefined` → `t(undefined)`
 *     → an empty reason inside "Did not run {when} — ", i.e. exactly the
 *     silence the `Record` was chosen to prevent.
 * The compile-time exhaustiveness of `SKIP_REASON_KEY` is kept; this adds the
 * runtime arm the type system cannot cover, because the value crosses a wire.
 */
function skipReasonKey(reason: string | undefined): string {
  if (reason !== undefined && Object.prototype.hasOwnProperty.call(SKIP_REASON_KEY, reason)) {
    return SKIP_REASON_KEY[reason as NonNullable<AssistantLoop['lastSkipReason']>];
  }
  // Adversarial-review F6 — two DIFFERENT truths, two sentences: no reason on
  // the wire = "no reason was recorded"; a reason we can't map = one WAS
  // recorded, and claiming absence would be the fabrication this arm exists to
  // avoid.
  return reason === undefined ? 'recurringSkipUnknown' : 'recurringSkipUnrecognized';
}

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
              {/* WF-COS-4 — a fire that consumed its slot and produced NO run.
                  `lastRunAt` alone reads as "it is working"; it used to be
                  stamped BEFORE dispatch, so a dropped fire showed "last run:
                  just now" next to a link to a run from hours earlier. Rendered
                  as plain text rather than an announcing Notice: this panel is
                  read on demand, and the page's single polite slot is not the
                  place for a per-row status (noticeSweepTranche). */}
              {loop.lastSkippedAt ? (
                <span className="u-block u-text-sm u-text-warning">
                  {t('recurringSkipped', {
                    when: formatDateTime(loop.lastSkippedAt),
                    reason: t(skipReasonKey(loop.lastSkipReason)),
                  })}
                </span>
              ) : null}
            </span>
            <StatusBadge status={loop.enabled ? 'active' : 'paused'} label={loop.enabled ? t('recurringOn') : t('recurringOff')} />
            <Button
              variant={loop.enabled ? 'secondary' : 'accent'}
              disabled={busy === loop.loopId}
              aria-pressed={loop.enabled}
              onClick={() => void toggle(loop)}
            >
              {loop.enabled ? t('recurringPause') : t('recurringEnable')}
            </Button>
          </li>
        ))}
        {loops !== null && loops.length === 0 ? <li className="muted">{t('recurringEmpty')}</li> : null}
      </ul>
    </article>
  );
}
