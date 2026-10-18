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
import { StateCard } from '../ui/StateCard.js';
import { Notice } from '../ui/Notice.js';
import { ClockIcon } from '../ui/icons/index.js';
import { useScopeWriteAccess, writeErrorMessage } from '../lib/writeAccess.js';
import { Link } from 'react-router-dom';

/** ADR 0862 — the loop's typed failure code → what to tell the human. Codes are the
 *  ingest node's `providerRejection` vocabulary (`packs/feature.assistant.nodes`). */
const FAIL_REASON_KEY: Record<string, string> = {
  connection_reauth_required: 'loopFailReauth',
  connection_scope_missing: 'loopFailScope',
  provider_api_disabled: 'loopFailApiDisabled',
  connection_forbidden: 'loopFailForbidden',
  upstream_unavailable: 'loopFailUnavailable',
};
/** The codes the human fixes on the Connections page (mirrors notify.ts RECONNECT_CODES). */
const RECONNECT = new Set(['connection_reauth_required', 'connection_scope_missing', 'connection_forbidden']);

/** WF-COS-4 — reason code → catalog key. A `Record` rather than a ternary chain
 *  so a new reason code on the wire is a compile error here, not silence. */
const SKIP_REASON_KEY: Record<Exclude<NonNullable<AssistantLoop['lastSkipReason']>, 'no-next-fire'>, string> = {
  budget: 'recurringSkipBudget',
  'workflow-unresolved': 'recurringSkipUnresolved',
  'dispatch-error': 'recurringSkipDispatch',
  'feature-disabled': 'recurringSkipFeatureDisabled',
  'plan-lapsed': 'recurringSkipPlanLapsed',
  'actor-inactive': 'recurringSkipActorInactive',
  'agent-paused': 'recurringSkipAgentPaused',
  'policy-denied': 'recurringSkipPolicyDenied',
  'awaiting-approval': 'recurringSkipAwaitingApproval',
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
    return SKIP_REASON_KEY[reason as keyof typeof SKIP_REASON_KEY];
  }
  // Adversarial-review F6 — two DIFFERENT truths, two sentences: no reason on
  // the wire = "no reason was recorded"; a reason we can't map = one WAS
  // recorded, and claiming absence would be the fabrication this arm exists to
  // avoid.
  return reason === undefined ? 'recurringSkipUnknown' : 'recurringSkipUnrecognized';
}

export function RecurringTasksPanel(): JSX.Element {
  const { t } = useTranslation('agents');
  // ADR 0862 — the failure copy lives in the lazy `assistantAction` namespace; read without
  // suspending, and the failure line renders once it has loaded.
  const { t: ta, ready: failCopyReady } = useTranslation('assistantAction', { useSuspense: false });
  const [loops, setLoops] = useState<AssistantLoop[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // RTP-EMPTY-1 (ADR 0779 D7) — a failed READ is not an empty list. The read used to
  // set `loops` to [] on failure, so "No recurring tasks configured." rendered beside
  // the error. `error` also carries write failures, so the read keeps its own flag.
  const [readFailed, setReadFailed] = useState(false);
  // ADR 0787 — enabling/pausing a loop is a workspace WRITE (the route gates it);
  // a Viewer sees the loops and their state, not a button that 403s.
  const canWrite = useScopeWriteAccess('workspace:write');

  const load = useCallback(() => {
    void listLoops()
      .then((l) => { setLoops(l); setReadFailed(false); setError(null); })
      .catch((e: unknown) => { setLoops([]); setReadFailed(true); setError(writeErrorMessage(t, e)); });
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
        toast.error(writeErrorMessage(t, e));
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
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {loops === null ? <StateCard icon={<ClockIcon />} title={t('common:loading')} loading /> : null}
      <ul className="u-grid u-gap-2">
        {(loops ?? []).map((loop) => (
          <li key={loop.loopId} className="u-flex u-wrap u-gap-2 u-items-center">
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
              {/* ADR 0787 D6 — `no-next-fire` is not a dropped fire: the cadence
                  has no further slot, so say THAT, not "did not run". */}
              {loop.enabled && loop.lastSkipReason === 'no-next-fire' ? (
                <span className="u-block u-text-sm u-text-warning">{t('recurringCadenceExhausted')}</span>
              ) : loop.lastSkippedAt ? (
                <span className="u-block u-text-sm u-text-warning">
                  {t('recurringSkipped', {
                    when: formatDateTime(loop.lastSkippedAt),
                    reason: t(skipReasonKey(loop.lastSkipReason)),
                  })}
                </span>
              ) : null}
              {/* ADR 0662 D3 / ADR 0862 — a run that STARTED and FAILED. The server has
                  projected `lastRunStatus` since it.14; nothing rendered it, so a loop
                  failing most of its runs read "Last run …" beside a green On. */}
              {/* ADR 0862 — the loop stopped ITSELF after repeated connection refusals. */}
              {failCopyReady && !loop.enabled && loop.autoPausedCode ? (
                <span className="u-block u-text-sm u-text-warning">
                  {ta('loopAutoPaused', {
                    when: loop.autoPausedAt ? formatDateTime(loop.autoPausedAt) : '',
                    reason: ta(FAIL_REASON_KEY[loop.autoPausedCode] ?? 'loopFailOther'),
                  })}{' '}
                  <Link className="inline-link" to="/connections">{ta('loopReconnect')}</Link>
                </span>
              ) : failCopyReady && loop.lastRunStatus === 'failed' && loop.lastRunAt ? (
                <span className="u-block u-text-sm u-text-warning">
                  {ta('loopLastRunFailed', {
                    when: formatDateTime(loop.lastRunAt),
                    reason: ta(FAIL_REASON_KEY[loop.lastRunErrorCode ?? ''] ?? 'loopFailOther'),
                  })}{' '}
                  {loop.lastRunErrorCode && RECONNECT.has(loop.lastRunErrorCode) ? (
                    <Link className="inline-link" to="/connections">{ta('loopReconnect')}</Link>
                  ) : loop.lastRunId ? (
                    <Link className="inline-link" to={`/runs/${encodeURIComponent(loop.lastRunId)}`}>{ta('loopViewRun')}</Link>
                  ) : null}
                </span>
              ) : null}
            </span>
            <StatusBadge status={loop.enabled ? 'active' : 'paused'} label={loop.enabled ? t('recurringOn') : t('recurringOff')} />
            {canWrite ? (
              <Button
                variant={loop.enabled ? 'secondary' : 'accent'}
                disabled={busy === loop.loopId}
                onClick={() => void toggle(loop)}
              >
                {loop.enabled ? t('recurringPause') : t('recurringEnable')}
              </Button>
            ) : null}
          </li>
        ))}
        {loops !== null && loops.length === 0 && !readFailed ? <li className="muted">{t('recurringEmpty')}</li> : null}
      </ul>
    </article>
  );
}
