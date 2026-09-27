/**
 * The Operations hub console (ADR 0395 Phase D + E). Composes, never rebuilds:
 * inline System-health + DLQ sections (each ONE batched superadmin read — a
 * non-superadmin sees the honest operator-only notice, not a broken panel)
 * plus the admin-tail console links (Phase E — webhook health, usage
 * analytics, runs inspector, model router, heartbeat governance; the
 * sitemap-admin + imagegen-quota panels are deferred per the ADR 0395
 * implementation record — trigger: first operator request):
 * every linked surface keeps its OWN route + gate (the D3 rule — the hub never
 * silently inherits a weaker tier; usage-analytics deliberately links out to
 * its `workspace:read` standalone route rather than embedding it here).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Notice, StateCard, TextField } from '../../ui/index.js';
import { formatDurationSeconds, formatNumber, formatPercent } from '../../i18n/format.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { getDlqSummary, getHealthSummary, getOutboxSummary, getSloSummary, redriveOutboxIntent, replayDlqMessage, OperationsRequestError, type DlqSummary, type HealthSummary, type OutboxSummary, type SloRow, type SloSummary } from '../../client/operationsClient.js';
import { AdminPageHeader } from '../../chrome/AdminPageHeader.js';

const REFRESH_MS = 30_000;

/**
 * ADR 0556 P2 — an SLO row's state as a chip class.
 *
 * `empty`, `unknown` and `not_projectable` all render MUTED rather than
 * success, and that is the load-bearing choice on this panel. Each of them
 * means "this objective is not currently being judged", and a green chip would
 * make all three read as "met" — the direction an operations console must never
 * be wrong in. Only a row that was actually computed and actually met earns
 * success.
 */
function sloStateChip(state: SloRow['state']): string {
  if (state === 'healthy') return 'chip chip--success';
  if (state === 'breaching') return 'chip chip--danger';
  if (state === 'stale' || state === 'degraded') return 'chip chip--warning';
  return 'chip chip--muted';
}

/** The i18n key for a row state. A total map, so a new backend state renders as
 *  its own word rather than falling through to a neighbouring one. */
function sloStateKey(state: SloRow['state']): string {
  switch (state) {
    case 'healthy': return 'sloStateHealthy';
    case 'breaching': return 'sloStateBreaching';
    case 'stale': return 'sloStateStale';
    case 'degraded': return 'sloStateDegraded';
    case 'empty': return 'sloStateEmpty';
    case 'unknown': return 'sloStateUnknown';
    case 'not_projectable': return 'sloStateNotProjectable';
    default: return 'sloStateUnknown';
  }
}

/**
 * Ratios as percentages, durations in seconds, counts bare — all through
 * `i18n/format`, so the separators and the unit label localize with the rest of
 * the app rather than being hard-coded English.
 *
 * `Infinity` is a REAL reading here, not a bug: the quantile estimator returns
 * it when observations exceed the largest bucket the metric catalog declares.
 * It is rendered as `∞` rather than being formatted, because `Intl` gives it a
 * percent or unit suffix that reads as a measured quantity when the point is
 * that the measurement ran off the end of the instrument.
 */
function formatSloValue(value: number, unit: SloRow['unit']): string {
  if (!Number.isFinite(value)) return '∞';
  if (unit === 'ratio') return formatPercent(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (unit === 'seconds') return formatDurationSeconds(value, 0);
  return formatNumber(value);
}

export function OperationsHubPage(): JSX.Element {
  const { t } = useTranslation('operations');
  const { t: tn } = useTranslation('nav');
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [dlq, setDlq] = useState<DlqSummary | null>(null);
  // UX-OPS-1 — per-panel outcome, so one read's failure never speaks for the
  // other. This replaces a single global `operatorOnly`, which made a DLQ-only
  // 403 claim operator-only for the Health panel the caller could actually read.
  const [healthForbidden, setHealthForbidden] = useState(false);
  const [dlqForbidden, setDlqForbidden] = useState(false);
  const [healthFailed, setHealthFailed] = useState(false);
  const [dlqFailed, setDlqFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // ADR 0551 P2 — dispatch outbox. THIRD independent read, with the same
  // per-panel outcome state as the other two: a 403 here must not claim the
  // health panel is operator-only, and a failure here must not render as an
  // empty queue.
  const [outbox, setOutbox] = useState<OutboxSummary | null>(null);
  const [outboxForbidden, setOutboxForbidden] = useState(false);
  const [outboxFailed, setOutboxFailed] = useState(false);
  const [redriveReason, setRedriveReason] = useState('');
  // ADR 0556 P2 — SLO objectives + alerts. FOURTH independent read, with the
  // same per-panel outcome state as the three above, for the same reason: a 403
  // here must not claim the health panel is operator-only, and a failed read
  // must never render as "every objective is fine".
  const [slo, setSlo] = useState<SloSummary | null>(null);
  const [sloForbidden, setSloForbidden] = useState(false);
  const [sloFailed, setSloFailed] = useState(false);

  const load = useCallback(async () => {
    // UX-OPS-1 — these are two INDEPENDENT reads, and `Promise.all` made either
    // one poison the other. Two concrete failures:
    //   • DLQ 500s while health is fine → the catch runs, `health` is never set,
    //     and the Health panel renders `StateCard loading` FOREVER (the `!health`
    //     branch) beside an error notice. A health console stuck on "loading" is
    //     a lie about its own state.
    //   • DLQ 403s for a tenant admin who CAN read health → operatorOnly went
    //     global, so both panels claimed operator-only. The header comment says a
    //     non-superadmin should see "the honest operator-only notice, not a broken
    //     panel" — over-applying it to a panel they're allowed to see is its own
    //     dishonesty.
    // allSettled + per-panel state: each panel reports what ITS read did.
    const [h, d, o, s] = await Promise.allSettled([getHealthSummary(), getDlqSummary(), getOutboxSummary(), getSloSummary()]);
    const forbidden = (r: PromiseSettledResult<unknown>): boolean =>
      r.status === 'rejected' && r.reason instanceof OperationsRequestError && r.reason.status === 403;
    // Detected structurally by status (GRADE-UX: never by message text).
    setHealthForbidden(forbidden(h));
    setDlqForbidden(forbidden(d));
    setOutboxForbidden(forbidden(o));
    setSloForbidden(forbidden(s));
    if (h.status === 'fulfilled') setHealth(h.value);
    if (d.status === 'fulfilled') setDlq(d.value);
    if (o.status === 'fulfilled') setOutbox(o.value);
    if (s.status === 'fulfilled') setSlo(s.value);
    setHealthFailed(h.status === 'rejected' && !forbidden(h));
    setDlqFailed(d.status === 'rejected' && !forbidden(d));
    setOutboxFailed(o.status === 'rejected' && !forbidden(o));
    setSloFailed(s.status === 'rejected' && !forbidden(s));
    const realError = [h, d, o, s].find((r) => r.status === 'rejected' && !forbidden(r));
    setError(
      realError && realError.status === 'rejected'
        ? (realError.reason instanceof Error ? realError.reason.message : String(realError.reason))
        : null,
    );
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const onReplay = async (tenantId: string, subject: string, messageId: string): Promise<void> => {
    if (!(await confirm({ title: t('replayConfirmTitle'), body: t('replayConfirmBody'), confirmLabel: t('replayConfirm') }))) return;
    setBusy(true);
    try {
      await replayDlqMessage(tenantId, subject, messageId);
      toast.success(t('replayDone'));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('replayFailed'));
    } finally { setBusy(false); }
  };

  const onRedrive = async (runId: string): Promise<void> => {
    if (!redriveReason.trim()) return;
    if (!(await confirm({ title: t('redriveConfirmTitle'), body: t('redriveConfirmBody'), confirmLabel: t('redriveConfirm') }))) return;
    setBusy(true);
    try {
      await redriveOutboxIntent(runId, redriveReason.trim());
      toast.success(t('redriveDone'));
      setRedriveReason('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('redriveFailed'));
    } finally { setBusy(false); }
  };

  return (
    <div className="page-shell" data-walkthrough="operations.page">
      <AdminPageHeader
        eyebrow={tn('groupSystemOperations', { defaultValue: 'System operations' })}
        title={t('hubTitle')}
        actions={<Button variant="secondary" size="sm" disabled={busy} onClick={() => void load()}>{t('refresh')}</Button>}
      />
      {error ? <Notice variant="error">{error}</Notice> : null}

      <section>
        <h2>{t('healthHeading')}</h2>
        {healthForbidden ? (
          <StateCard title={t('operatorOnlyTitle')} body={t('operatorOnlyBody')} />
        ) : healthFailed && !health ? (
          // UX-OPS-1 — a failed read is NOT "still loading".
          <StateCard announce title={t('healthUnavailableTitle')} body={t('healthUnavailableBody')} />
        ) : !health ? (
          <StateCard loading title={t('loading')} />
        ) : (
          <article className="surface-card">
            {/* DESIGN.md §4.6 `stale`. `healthFailed && !health` above only
                catches a failure with NOTHING to show. When a refresh fails and
                we still hold the previous answer, the panel falls through to
                here and would render last-known numbers as if they were live —
                on a health console that is the same lie as an empty state, just
                better dressed. Say the numbers are last-known; do NOT discard
                them, because they are still the most recent truth we have. */}
            {healthFailed ? <Notice variant="warning" announce={t('healthStale')}>{t('healthStale')}</Notice> : null}
            <header className="action-bar">
              <span className={health.status === 'ready' ? 'chip chip--success' : 'chip chip--danger'}>{health.status === 'ready' ? t('statusReady') : t('statusDegraded')}</span>
              <span className="chip chip--muted">v{health.version}</span>
              {health.perInstance ? <span className="chip chip--warning">{t('perInstanceCaveat')}</span> : null}
            </header>
            {/* GRADE-UX 2026-07-17 — pass/fail is a WORD in the chip, never
                color alone (WCAG 1.4.1). */}
            <p>
              <span className={health.checks.storage.ok ? 'chip chip--success' : 'chip chip--danger'}>{t('checkStorage')} · {health.checks.storage.ok ? t('checkOk') : t('checkFailed')}</span>{' '}
              <span className={health.checks.config.ok ? 'chip chip--success' : 'chip chip--danger'}>{t('checkConfig')} · {health.checks.config.ok ? t('checkOk') : t('checkFailed')}</span>{' '}
              {/* Web search — REPORTED, never gating (routes/health.ts), so this
                  chip is never `danger`: an unconfigured host is healthy, just
                  limited to demo results. THREE states, not two — `probeError`
                  means the vault could not be read, and showing that as "not
                  configured" would tell an operator who HAD set the key that they
                  had not. Guarded because older revisions omit the field entirely;
                  a missing check must not render as a false negative. */}
              {health.checks.webSearch ? (
                <>
                  <span
                    className={health.checks.webSearch.configured ? 'chip chip--success' : health.checks.webSearch.probeError ? 'chip chip--warning' : 'chip chip--muted'}
                    {...(health.checks.webSearch.probeError ? { title: health.checks.webSearch.probeError } : {})}
                  >
                    {t('checkWebSearch')} · {health.checks.webSearch.configured
                      ? t('webSearchConfigured', { source: health.checks.webSearch.source ?? '' })
                      : health.checks.webSearch.probeError
                        ? t('webSearchUnknown')
                        : t('webSearchAbsent')}
                  </span>{' '}
                </>
              ) : null}
              <span className="chip chip--muted">{t('sseStreams', { n: health.sse.totalStreams, max: health.sse.max })}</span>{' '}
              <span className="chip chip--muted">{t('ipBudget', { n: health.rateLimits.ipReqsPerMin })}</span>
              {health.rateLimits.ipReadReqsPerMin !== undefined ? (
                <>{' '}<span className="chip chip--muted">{t('ipReadBudget', { n: health.rateLimits.ipReadReqsPerMin })}</span></>
              ) : null}
            </p>
            {/* UX-OPS-2 — the server computes a per-provider readiness block and
                this console used to drop it. It is frequently the ONLY explanation
                for `degraded` while storage + config are both ok, and the backend
                surfaces it precisely because an unconfigured managed provider
                "used to be invisible until a user ran a workflow"
                (routes/health.ts). Same word-not-colour rule as the checks above. */}
            {health.checks.managedProviders && health.checks.managedProviders.length > 0 ? (
              <p>
                {health.checks.managedProviders.map((p) => (
                  <span
                    key={p.providerId}
                    className={p.ready ? 'chip chip--success' : 'chip chip--danger'}
                    {...(p.detail ? { title: p.detail } : {})}
                  >
                    {p.providerId} · {p.ready ? t('checkOk') : t('checkFailed')}
                  </span>
                ))}
              </p>
            ) : null}
          </article>
        )}
      </section>

      <section>
        <h2>{t('dlqHeading')}</h2>
        {dlqForbidden ? (
          <StateCard title={t('operatorOnlyTitle')} body={t('operatorOnlyBody')} />
        ) : dlqFailed && !dlq ? (
          // UX-OPS-1 — critically, this must NOT fall through to `dlqEmpty`
          // ("nothing is dead-lettered"). On a health console, an unread queue
          // reported as an empty queue is the whole bug class in one line.
          <StateCard announce title={t('dlqUnavailableTitle')} body={t('dlqUnavailableBody')} />
        ) : !dlq ? (
          <StateCard loading title={t('loading')} />
        ) : dlq.subjects.length === 0 ? (
          <StateCard title={t('dlqEmpty')} body={t('dlqEmptyHint')} />
        ) : (
          <>
          {/* Same §4.6 `stale` case as the health panel above. */}
          {dlqFailed ? <Notice variant="warning" announce={t('dlqStale')}>{t('dlqStale')}</Notice> : null}
          {dlq.backend === 'memory' ? <Notice variant="warning">{t('dlqPerInstanceNotice')}</Notice> : null}
          <div className="card-grid">
            {dlq.subjects.map((s) => (
              <article key={`${s.tenantId}:${s.subject}`} className="surface-card">
                <header className="action-bar">
                  <strong>{s.subject}</strong>
                  <span className="chip chip--danger">{t('dlqDepth', { n: s.depth })}</span>
                  <span className="chip chip--muted">{s.tenantId}</span>
                </header>
                {s.reasons.length > 0 ? <p>{t('dlqReasons', { reasons: s.reasons.join(', ') })}</p> : null}
                <ul>
                  {s.messageIds.slice(0, 5).map((id) => (
                    <li key={id} className="action-bar">
                      <span className="chip chip--muted">{id}</span>
                      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onReplay(s.tenantId, s.subject, id)}>{t('replay')}</Button>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          </>
        )}
      </section>

      {/* ADR 0551 P2 — durable dispatch outbox. The intent to START an accepted
          run is a row here; a `dead` row is a run nobody ever started, which is
          the most consequential thing on this page. Same three-state honesty as
          the panels above: forbidden ≠ failed ≠ empty. */}
      <section>
        <h2>{t('outboxHeading')}</h2>
        {outboxForbidden ? (
          <StateCard title={t('operatorOnlyTitle')} body={t('operatorOnlyBody')} />
        ) : outboxFailed && !outbox ? (
          // Critically NOT the empty state: an unread queue reported as an empty
          // queue is the whole bug class, and here it would read as "every
          // accepted run started fine".
          <StateCard announce title={t('outboxUnavailableTitle')} body={t('outboxUnavailableBody')} />
        ) : !outbox ? (
          <StateCard loading title={t('loading')} />
        ) : (
          <article className="surface-card">
            {outboxFailed ? <Notice variant="warning" announce={t('outboxStale')}>{t('outboxStale')}</Notice> : null}
            <header className="action-bar">
              <span className="chip chip--muted">{t('outboxPending', { n: outbox.counts.pending })}</span>
              <span className={outbox.counts.dead > 0 ? 'chip chip--danger' : 'chip chip--success'}>{t('outboxDead', { n: outbox.counts.dead })}</span>
              {outbox.oldestPendingAgeS !== null ? (
                <span className="chip chip--muted">{t('outboxOldest', { n: outbox.oldestPendingAgeS })}</span>
              ) : null}
              <span className="chip chip--muted">{t('outboxFleetWide')}</span>
            </header>
            {outbox.counts.dead === 0 ? (
              <p>{t('outboxHealthy')}</p>
            ) : (
              <>
                {outbox.deadSample.truncated ? <Notice variant="warning">{t('outboxTruncated', { n: outbox.deadSample.limit })}</Notice> : null}
                {/* The reason is REQUIRED by the route and lands on the row, so
                    the queue itself records why an exhausted budget was
                    overridden. Typed once, then applied to whichever rows the
                    operator redrives. */}
                <TextField
                  label={t('redriveReasonLabel')}
                  help={t('redriveReasonHelp')}
                  required
                  type="text"
                  value={redriveReason}
                  placeholder={t('redriveReasonPlaceholder')}
                  onChange={(e) => setRedriveReason(e.target.value)}
                />
                <ul>
                  {outbox.dead.map((row) => (
                    <li key={row.runId} className="action-bar">
                      <span className="chip chip--muted">{row.runId}</span>
                      <span className="chip chip--muted">{row.workflowId}</span>
                      <span className="chip chip--warning">{t('outboxAttempts', { n: row.attempts })}</span>
                      {row.lastError ? <span className="chip chip--danger" title={row.lastError}>{t('lastErrorShort')}</span> : null}
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy || !redriveReason.trim()}
                        onClick={() => void onRedrive(row.runId)}
                      >
                        {t('redrive')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </article>
        )}
      </section>

      {/* ADR 0556 P2 — service level objectives + the alerts derived from them.
          Five distinct states, and keeping them apart IS the feature:

            forbidden        — not an operator
            failed           — the read did not answer (never "all fine")
            collector off    — `source: 'unavailable'`, so nothing can be read.
                               This is the one most easily mistaken for health:
                               a host with no local-scrape reader records every
                               blocked effect it suffers and can report none.
            empty            — the reader is on and nothing has been measured
            measured         — rows, each with its own state chip

          No chart library, per ADR 0556's decision that Operations projects
          telemetry rather than becoming a second tracing UI: a number, a target
          and a word carry every one of these rows. */}
      <section>
        <h2>{t('sloHeading')}</h2>
        {sloForbidden ? (
          <StateCard title={t('operatorOnlyTitle')} body={t('operatorOnlyBody')} />
        ) : sloFailed && !slo ? (
          <StateCard announce title={t('sloUnavailableTitle')} body={t('sloUnavailableBody')} />
        ) : !slo ? (
          <StateCard loading title={t('loading')} />
        ) : slo.source === 'unavailable' ? (
          // UNKNOWN — deliberately its own card and not an empty state. The
          // difference an operator must be able to see is "nothing has gone
          // wrong yet" versus "this host cannot tell you whether anything has".
          <StateCard title={t('sloCollectorOffTitle')} body={t('sloCollectorOffBody')} />
        ) : slo.rows.every((r) => r.state === 'empty' || r.state === 'not_projectable') ? (
          <StateCard title={t('sloEmptyTitle')} body={t('sloEmptyBody')} />
        ) : (
          <article className="surface-card">
            {/* DESIGN.md §4.6 `stale` — a refresh failed and we still hold the
                previous answer. Say the numbers are last-known; do not discard
                them, because they remain the most recent truth available. */}
            {sloFailed ? <Notice variant="warning" announce={t('sloStale')}>{t('sloStale')}</Notice> : null}
            <header className="action-bar">
              <span className={slo.alerts.length === 0 ? 'chip chip--success' : 'chip chip--danger'}>
                {slo.alerts.length === 0 ? t('sloNoAlerts') : t('sloAlertCount', { n: slo.alerts.length })}
              </span>
              {slo.window.seconds !== null ? <span className="chip chip--muted">{t('sloWindow', { n: slo.window.seconds })}</span> : null}
              {/* Always shown. `docs/SLO.md` declares a 28-day rolling,
                  fleet-wide window and this is neither — a panel that omits
                  that reads as attainment. */}
              <span className="chip chip--warning">{t('sloPerInstance')}</span>
              {/* The cardinality ceiling. Silent in the SDK — it folds series
                  away with no warning — so if it ever bites, the panel says so
                  rather than showing confident numbers over a population that
                  no longer means what its label says. */}
              {slo.series.overflowed ? (
                <span className="chip chip--danger">{t('sloOverflowed', { n: slo.series.count, max: slo.series.limit })}</span>
              ) : null}
            </header>

            {slo.alerts.length > 0 ? (
              <>
                <h3>{t('sloAlertsHeading')}</h3>
                <ul>
                  {slo.alerts.map((a) => (
                    <li key={`${a.id}:${a.kind}`} className="action-bar">
                      {/* Severity is a WORD in the chip, never colour alone
                          (WCAG 1.4.1) — the same rule the health checks follow. */}
                      <span className={a.severity === 'page' ? 'chip chip--danger' : 'chip chip--warning'}>
                        {a.severity === 'page' ? t('sloSeverityPage') : t('sloSeverityTicket')}
                      </span>
                      <span className="chip chip--muted">{a.id}</span>
                      <span>{a.summary}</span>
                      {/* The runbook is a repo path, not a URL — the host does
                          not serve docs — so it is shown rather than linked. A
                          dead link would be worse than a path an operator can
                          open in the checkout. */}
                      <code>{a.runbook}</code>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <h3>{t('sloObjectivesHeading')}</h3>
            <ul>
              {slo.rows.map((r) => (
                <li key={r.id} className="action-bar">
                  <span className="chip chip--muted">{r.id}</span>
                  <span className={sloStateChip(r.state)}>{t(sloStateKey(r.state))}</span>
                  <span>{r.sli}</span>
                  <span className="chip chip--muted">
                    {t('sloTarget', { cmp: r.comparison === 'at_least' ? '≥' : '≤', value: formatSloValue(r.target, r.unit) })}
                  </span>
                  {r.thresholdS !== undefined ? (
                    <span className="chip chip--muted">{t('sloWithin', { value: formatSloValue(r.thresholdS, 'seconds') })}</span>
                  ) : null}
                  {r.observed !== null ? (
                    <span className="chip chip--muted">{t('sloObserved', { value: formatSloValue(r.observed, r.unit) })}</span>
                  ) : null}
                  {/* Which number answered. The dispatch rows read the queue
                      TABLE while their documented metric is a gauge, and an
                      operator comparing this panel to the one above needs to
                      know they are the same number and not two. */}
                  {r.source === 'dispatch-outbox-stats' ? (
                    <span className="chip chip--muted">{t('sloFromQueueTable')}</span>
                  ) : null}
                  {/* A ratio over three samples is not evidence, and the panel
                      says the count rather than leaving it to be inferred. */}
                  {r.sampleCount > 0 ? <span className="chip chip--muted">{t('sloSamples', { n: r.sampleCount })}</span> : null}
                  {r.caveat ? <span className="chip chip--warning" title={r.caveat}>{t('sloEstimated')}</span> : null}
                  {r.reason ? <span className="chip chip--muted" title={r.reason}>{t('sloWhyNot')}</span> : null}
                </li>
              ))}
            </ul>
          </article>
        )}
      </section>

      <section>
        <h2>{t('consolesHeading')}</h2>
        <div className="card-grid">
          <article className="surface-card">
            <h3><Link to="/operations/webhooks">{t('opsWebhooksConsole')}</Link></h3>
            <p>{t('opsWebhooksConsoleHint')}</p>
          </article>
          <article className="surface-card">
            <h3><Link to="/usage">{t('usageConsole')}</Link></h3>
            <p>{t('usageConsoleHint')}</p>
          </article>
          <article className="surface-card">
            <h3><Link to="/runs">{t('runsConsole')}</Link></h3>
            <p>{t('runsConsoleHint')}</p>
          </article>
          <article className="surface-card">
            <h3><Link to="/model-router">{t('modelRouterConsole')}</Link></h3>
            <p>{t('modelRouterConsoleHint')}</p>
          </article>
          <article className="surface-card">
            <h3><Link to="/admin">{t('governanceConsole')}</Link></h3>
            <p>{t('governanceConsoleHint')}</p>
          </article>
        </div>
      </section>
    </div>
  );
}
