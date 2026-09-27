import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { scrollBehavior } from '../ui/motion.js';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import type { RunSnapshot, RunEventDoc, StreamMode } from '@openwop/openwop';
import { cancelRun, deleteRun, forkRun, getDebugBundle, getRun, pollEvents, setRunPinned } from '../client/runsClient.js';
import { subscribeToRun } from '../client/streamsClient.js';
import { listOpenInterrupts, type OpenInterrupt } from '../client/interruptsClient.js';
import { listAnnotations, type Annotation } from '../client/feedbackClient.js';
import { StatusBadge } from '../ui/StatusBadge.js';
import { getRunRevision, type RunRevisionInfo } from '../workflows/workflowsClient.js';
import { handleTablistKeyDown } from '../ui/rovingTabs.js';
import { EventStreamView } from '../streams/EventStreamView.js';
import { RunTimeline } from './RunTimeline.js';
import type { EventReadState } from '../streams/EventReadState.js';
import { RunStepInspector } from './RunStepInspector.js';
import { RunAgentTrace } from './RunAgentTrace.js';
import { RunHandoffMap } from './RunHandoffMap.js';
import { RunCostPanel } from './RunCostPanel.js';
import { RunProvenancePanel } from './RunProvenancePanel.js';
import { RunAnalyticsPanel } from './RunAnalyticsPanel.js';
import { RunFeedback } from './RunFeedback.js';
import { RunOpsPanel } from './RunOpsPanel.js';
import { RunCompensationPanel } from './RunCompensationPanel.js';
import { RunMemoryPanel } from './RunMemoryPanel.js';
import { RunConversationPanel } from './RunConversationPanel.js';
import { RenderInterrupt } from '../interrupts/RenderInterrupt.js';
import { Notice } from '../ui/Notice.js';
import { Skeleton } from '../ui/Skeleton.js';
import { ArrowLeftIcon } from '../ui/icons/index.js';
import { formatDuration } from './format.js';
import { formatDateTime } from '../i18n/format.js';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { isInterruptResolvedEvent } from '../chat/lib/interruptResolvedEvent';

/**
 * ADR 0655 D10 — the email egress refusal codes the run page explains (see
 * runs/i18n `nodeErrorHint_*`), each with the page that can ACT on it.
 *
 * ADR 0657 D7 (CONS-UX-25) — `email_recipient_erased` used to send the operator
 * to the suppressions panel on `/email`, where an erased subject does not
 * appear: erasure is a consent-console fact (a tombstone the Consent page can
 * show, and that only its re-admit control can lift). One map, so a code's
 * destination is declared beside the code instead of assumed by the render.
 */
const EMAIL_NODE_ERROR_HINT_LINKS: ReadonlyMap<string, { to: string; labelKey: 'nodeErrorHintEmailLink' | 'nodeErrorHintConsentLink' }> = new Map([
  ['email_recipient_suppressed', { to: '/email', labelKey: 'nodeErrorHintEmailLink' }],
  ['email_recipient_erased', { to: '/consent', labelKey: 'nodeErrorHintConsentLink' }],
  ['email_recipient_no_consent', { to: '/email', labelKey: 'nodeErrorHintEmailLink' }],
  ['email_send_in_flight', { to: '/email', labelKey: 'nodeErrorHintEmailLink' }],
  ['email_not_connected', { to: '/email', labelKey: 'nodeErrorHintEmailLink' }],
  ['email_egress_guard_missing', { to: '/email', labelKey: 'nodeErrorHintEmailLink' }],
]);

function fmtTime(iso?: string): string {
  return iso ? formatDateTime(iso) : '—';
}

export function RunDetailPage() {
  const { t } = useTranslation('runs');
  const { t: tCommon } = useTranslation('common');
  const { runId = '' } = useParams();
  const nav = useNavigate();
  // §C3/§D — when this run was opened from a fork, carry a back-reference to
  // the source so a reviewer can navigate to the feedback that motivated it.
  const [searchParams] = useSearchParams();
  const forkedFrom = searchParams.get('from');
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  // ADR 0474 — the revision pin chip (fail-soft; absent for legacy runs).
  const [revisionInfo, setRevisionInfo] = useState<RunRevisionInfo | null>(null);
  useEffect(() => { if (runId) void getRunRevision(runId).then(setRevisionInfo).catch(() => {}); }, [runId]);
  const [events, setEvents] = useState<RunEventDoc[]>([]);
  // ADR 0600 §1 (`ISU-24`) — the event views branch on `events.length === 0` to
  // render "No events yet", a positive claim about the RUN. `[]` is also what a
  // still-in-flight read and a THROWN read look like from here, so the outcome
  // of the read travels with the array instead of being inferred from it.
  const [eventsRead, setEventsRead] = useState<EventReadState>('loading');
  const [activeInterrupt, setActiveInterrupt] = useState<OpenInterrupt | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationsFailed, setAnnotationsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // UX_UPGRADE-runs P2 — a failed post-event refresh must not read as a fresh
  // view. The SSE feed keeps flowing, but the snapshot/log the panels render is
  // now stale; say so and offer a retry instead of silently under-reporting.
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [eventView, setEventView] = useState<'timeline' | 'log'>('timeline');
  const [streamMode, setStreamMode] = useState<StreamMode>('updates');
  // §A4 playhead — the timeline-selected sequence drives the step inspector.
  const [playheadSeq, setPlayheadSeq] = useState<number | null>(null);

  const refreshInterrupts = useCallback(async () => {
    if (!runId) return;
    try {
      const open = await listOpenInterrupts(runId);
      setActiveInterrupt(open.length > 0 ? (open[open.length - 1] ?? null) : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [runId]);

  // §C2 — annotation quality signals. listAnnotations resolves to [] when the
  // host doesn't advertise capabilities.feedback (capability-absent is a real
  // answer). RUN-R2-1 — an UNEXPECTED failure now throws instead of fabricating
  // []; record it so the analytics panel can say "unavailable" rather than
  // silently omitting its quality section.
  const refreshAnnotations = useCallback(async () => {
    if (!runId) return;
    try {
      setAnnotations(await listAnnotations(runId));
      setAnnotationsFailed(false);
    } catch {
      setAnnotationsFailed(true);
    }
  }, [runId]);

  // Initial snapshot + replay buffered events + open-interrupt fetch.
  //
  // ADR 0600 §1 — `eventsRead` is set on BOTH exits of the event read, and the
  // `getRun` failure counts as a failed event read too: it throws before
  // `pollEvents` is ever called, so the log is just as unread as if the poll
  // itself had thrown. Leaving it at `'loading'` there would have made the
  // spinner permanent, which is the same lie in a slower costume.
  //
  // A `prev === 'ready' ? prev : 'failed'` guard was written here first, to stop
  // a LATER read's failure from retroactively unreading a good event log — and
  // it was UNREACHABLE: `refreshInterrupts` and `refreshAnnotations` each own
  // their catch, so nothing after `pollEvents` resolves can throw to this one.
  // A sabotage of the guard came back green, which is how it was found. The
  // property is real and asserted (`eventReadHonesty.test.tsx`); the guard that
  // appeared to hold it was decoration, and decoration that looks like a safety
  // is the exact class ADR 0599 retired three times.
  const [loadNonce, setLoadNonce] = useState(0);
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    (async () => {
      if (!cancelled) setEventsRead('loading');
      try {
        const snap = await getRun(runId);
        if (!cancelled) setSnapshot(snap);
        const polled = await pollEvents(runId, 0);
        if (!cancelled) { setEvents([...polled.events]); setEventsRead('ready'); }
        await refreshInterrupts();
        if (!cancelled) await refreshAnnotations();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setEventsRead('failed');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, loadNonce, refreshInterrupts, refreshAnnotations]);

  // Hash-driven node deep-link: `/runs/<id>#node-<nodeId>` sets the
  // playhead to the matching `node.completed` event's sequence and
  // scrolls the step inspector into view. Used by the chat surface's
  // `WorkflowCompletionCard` to open a terminal node's artifact panel
  // in a new tab — the modal preview is the in-chat affordance; this
  // is the "give me the full run-detail context" affordance.
  useEffect(() => {
    if (events.length === 0) return;
    const hash = window.location.hash;
    if (!hash.startsWith('#node-')) return;
    // The hash is user-controlled URL input — a malformed percent sequence
    // (e.g. `#node-%`) must be a no-op deep-link, not a URIError that
    // error-boundaries the page.
    let targetNodeId: string;
    try {
      targetNodeId = decodeURIComponent(hash.slice('#node-'.length));
    } catch {
      return;
    }
    // Pick the LAST `node.completed` for this nodeId so a node that
    // ran multiple times (retries, loops) selects the terminal attempt.
    const ev = [...events].reverse().find(
      (e) => e.type === 'node.completed' && e.nodeId === targetNodeId,
    );
    if (!ev) return;
    setPlayheadSeq(ev.sequence);
    // Defer the scroll until the inspector has rendered with the new
    // playhead — the inspector mounts conditionally on `playheadSeq`.
    requestAnimationFrame(() => {
      const inspector = document.querySelector<HTMLElement>('[data-run-step-inspector]');
      inspector?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    });
  }, [events]);

  // Subscribe to live SSE events.
  useEffect(() => {
    if (!runId) return;
    const sub = subscribeToRun(runId, {
      modes: [streamMode],
      // Run-watching can be long and idle between nodes (HITL waits,
      // slow providers). Relax the default 30s idle / 120s absolute
      // timeouts so the live overlay / panels keep painting; the idle
      // timer still resets on every event so a genuinely hung stream
      // is still caught.
      idleTimeoutMs: 5 * 60_000,
      absoluteTimeoutMs: 30 * 60_000,
      onEvent: (ev) => {
        setEvents((prev) => {
          // Dedupe by sequence; events arriving out-of-order keep monotone order.
          if (prev.some((e) => e.sequence === ev.sequence)) return prev;
          const next = [...prev, ev].sort((a, b) => a.sequence - b.sequence);
          // Refresh snapshot whenever a terminal or transition event arrives.
          if (
            ['run.completed', 'run.failed', 'run.cancelled', 'node.suspended'].includes(ev.type) || isInterruptResolvedEvent(ev.type)
          ) {
            getRun(runId).then((s) => { setSnapshot(s); setRefreshFailed(false); }).catch(() => setRefreshFailed(true));
          }
          // On terminal events, re-poll the full event log via REST. The
          // SSE stream may not carry every event family the panels read
          // (cost / reasoning / handoff); the authoritative log backfills
          // anything the live stream missed so the panels are complete.
          if (['run.completed', 'run.failed', 'run.cancelled'].includes(ev.type)) {
            pollEvents(runId, 0)
              .then((p) => setEvents([...p.events]))
              .catch(() => setRefreshFailed(true));
          }
          // Interrupt-related transitions trigger an authenticated refetch
          // because the public event payload no longer carries the resume token.
          if (ev.type === 'node.suspended' || isInterruptResolvedEvent(ev.type)) {
            refreshInterrupts();
          }
          return next;
        });
      },
      onError: () => setError(t('eventStreamConnError')),
    });
    return () => sub.close();
  }, [runId, refreshInterrupts, streamMode, t]);

  async function onCancel() {
    if (!runId) return;
    try {
      await cancelRun(runId, 'cancelled from run detail');
      const snap = await getRun(runId);
      setSnapshot(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onTogglePin() {
    if (!runId || !snapshot) return;
    const next = !(snapshot as RunSnapshot & { pinned?: boolean }).pinned;
    try {
      await setRunPinned(runId, next);
      setSnapshot(await getRun(runId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDelete() {
    if (!runId) return;
    if (!(await confirm({ title: t('deleteRunConfirm'), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteRun(runId);
      nav('/runs');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDownloadDebugBundle() {
    if (!runId) return;
    try {
      const bundle = await getDebugBundle(runId);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `openwop-run-${runId}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** ADR 0600 §1 — the failure card's exit. Re-runs the whole initial load. */
  const retryEventRead = useCallback(() => {
    setError(null);
    setLoadNonce((n) => n + 1);
  }, []);

  async function onForkFrom(seq: number) {
    if (!runId) return;
    // `replay.md` §`branch`: a branch fork RE-EXECUTES side-effecting nodes live
    // for sequences >= fromSeq, so "branching past an already-executed payment
    // or notification will perform it again. This is by design" — and the same
    // paragraph adds that it "is easy to miss, and a host advertising
    // `sideEffectSuppression: 'recorded-outcome'` makes no claim about it. A
    // host SHOULD surface this in any operator-facing fork UI."
    //
    // This is that surface. It is NOT a `danger` dialog: a branch fork is a
    // legitimate, frequently-correct action, and styling it as destructive
    // would train operators to click through the warning that matters. The copy
    // names the consequence (effects run AGAIN) rather than asking a generic
    // "are you sure", because the thing the operator cannot see is exactly what
    // re-runs.
    if (
      !(await confirm({
        title: t('forkBranchConfirmTitle'),
        body: t('forkBranchConfirmBody'),
        confirmLabel: t('forkBranchConfirmAction'),
      }))
    ) {
      return;
    }
    try {
      const res = await forkRun(runId, { fromSeq: seq, mode: 'branch' });
      // Carry the source run as a back-reference (RFC 0056 §D) so the forked
      // run's page can link back to where the fork was motivated.
      window.location.href = `/runs/${res.runId}?from=${encodeURIComponent(res.sourceRunId)}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!runId) return <Notice variant="error">{t('noRunIdInUrl')}</Notice>;

  const duration =
    snapshot?.startedAt && snapshot.completedAt
      ? formatDuration(Date.parse(snapshot.completedAt) - Date.parse(snapshot.startedAt))
      : null;
  const isTerminal = snapshot ? ['completed', 'failed', 'cancelled'].includes(snapshot.status) : false;

  return (
    <section data-walkthrough="runs.page" aria-labelledby="rundetail-heading">
      <div className="u-mb-3">
        <Link to="/runs" className="u-fs-12 u-ink-3">
          <ArrowLeftIcon size={12} /> {t('backToRuns')}
        </Link>
      </div>

      <div className="surface-card rundetail-head-card">
        {forkedFrom && (
          <p className="muted rundetail-forked-from">
            {t('forkedFromPrefix')}{' '}
            <Link to={`/runs/${forkedFrom}`} className="inline-link"><code>{forkedFrom.slice(0, 8)}…</code></Link>
          </p>
        )}
        <div className="rundetail-head">
          <div className="rundetail-head-titles">
            <p className="rundetail-eyebrow">{t('runLabel')}</p>
            <h1 id="rundetail-heading" className="rundetail-title"><code>{runId}</code></h1>
          </div>
          {snapshot && <StatusBadge status={snapshot.status} />}
        </div>

        {error && <Notice variant="error">{error}</Notice>}
        {refreshFailed && (
          <Notice variant="warning" announce={t('runRefreshFailed')}>
            {t('runRefreshFailed')}{' '}
            <Button
              variant="secondary" size="sm"
              onClick={() => {
                if (!runId) return;
                setRefreshFailed(false);
                getRun(runId).then(setSnapshot).catch(() => setRefreshFailed(true));
                pollEvents(runId, 0).then((p) => setEvents([...p.events])).catch(() => setRefreshFailed(true));
              }}
            >
              {tCommon('retry')}
            </Button>
          </Notice>
        )}

        {!snapshot && !error && (
          <div role="status" className="rundetail-summary-loading" aria-busy="true" aria-label={t('loadingRun')}>
            <Skeleton width="42%" />
            <Skeleton width="68%" />
            <Skeleton width="54%" />
          </div>
        )}

        {snapshot && (
          <dl className="rundetail-summary">
            <dt>{t('workflowFieldLabel')}</dt>
            <dd><code>{snapshot.workflowId}</code></dd>
            {revisionInfo?.definitionRevision ? (
              <>
                <dt>{t('summaryRevision')}</dt>
                <dd className="u-flex u-items-center u-gap-2 u-wrap">
                  <code title={revisionInfo.definitionRevision}>{revisionInfo.definitionRevision.slice(0, 8)}</code>
                  {revisionInfo.definitionResolvedFrom === 'head' ? (
                    <span className="chip chip--warning u-fs-10" title={t('summaryRevisionHeadResolvedTitle')}>{t('summaryRevisionHeadResolved')}</span>
                  ) : revisionInfo.headMoved ? (
                    <span className="chip chip--muted u-fs-10" title={t('summaryRevisionHeadMovedTitle')}>{t('summaryRevisionHeadMoved')}</span>
                  ) : (
                    <span className="chip chip--muted u-fs-10">{t('summaryRevisionAsRun')}</span>
                  )}
                </dd>
              </>
            ) : null}
            {revisionInfo?.launch === 'draft' || revisionInfo?.debug || revisionInfo?.redriveOf ? (
              <>
                <dt>{t('summaryProvenance')}</dt>
                <dd className="u-flex u-items-center u-gap-2 u-wrap">
                  {revisionInfo.launch === 'draft' ? (
                    <span className="chip chip--muted u-fs-10" title={t('summaryDraftRunTitle')}>{t('summaryDraftRun')}</span>
                  ) : null}
                  {revisionInfo.debug ? (
                    <span className="chip chip--muted u-fs-10" title={t('summaryDebugRunTitle', { node: revisionInfo.debug.fromNodeId ?? '' })}>{t('summaryDebugRun')}</span>
                  ) : null}
                  {revisionInfo.redriveOf ? (
                    <Link className="chip chip--muted u-fs-10" to={`/runs/${encodeURIComponent(revisionInfo.redriveOf)}`} title={t('summaryRedriveOfTitle')}>
                      {t('summaryRedriveOf')}
                    </Link>
                  ) : null}
                </dd>
              </>
            ) : null}
            <dt>{t('summaryStarted')}</dt>
            <dd>{fmtTime(snapshot.startedAt)}</dd>
            {snapshot.completedAt ? (
              <>
                <dt>{t('summaryCompleted')}</dt>
                <dd>{fmtTime(snapshot.completedAt)}{duration ? ` · ${duration}` : ''}</dd>
              </>
            ) : snapshot.currentNodeId ? (
              <>
                <dt>{t('summaryCurrentNode')}</dt>
                <dd><code>{snapshot.currentNodeId}</code></dd>
              </>
            ) : null}
            {snapshot.parentRunId && (
              <>
                <dt>{t('summaryParentRun')}</dt>
                <dd>
                  <Link to={`/runs/${snapshot.parentRunId}`} className="inline-link">
                    <code>{snapshot.parentRunId.slice(0, 8)}…</code>
                  </Link>
                </dd>
              </>
            )}
          </dl>
        )}

        {/* ADR 0600 §3 (`ISU-27`) — this Notice is CONDITIONALLY MOUNTED, so its
            inline `role="alert"` branch is the one `ui/Notice.tsx:6-28` says
            must not be treated as established: a region that arrives already
            containing its text announces approximately nothing. `announce`
            delegates to the single mounted region instead (assertive, because
            `variant="error"`). The message is the CODE, not the server's raw
            error blob — that is noise read aloud and it changes on every retry. */}
        {snapshot?.error?.message && (
          <Notice
            variant="error"
            announce={t('runFailedAnnounce', { code: snapshot.error.code ?? t('runErrorFallback') })}
          >
            <strong>{snapshot.error.code ?? t('runErrorFallback')}:</strong> {snapshot.error.message}
            {/* ADR 0655 D10 (EM-UX-25) — an email egress refusal is a decision the operator
                can act on; the raw code alone read as noise. Explained only for codes the
                catalog knows; everything else stays the code + message. */}
            {(() => {
              const hint = snapshot.error.code ? EMAIL_NODE_ERROR_HINT_LINKS.get(snapshot.error.code) : undefined;
              return hint ? (
                <p className="u-m-0 u-fs-12">
                  {t(`nodeErrorHint_${snapshot.error.code}`)}{' '}
                  <Link to={hint.to}>{t(hint.labelKey)}</Link>
                </p>
              ) : null;
            })()}
          </Notice>
        )}

        {snapshot && (
          <details className="rundetail-raw">
            <summary>{t('rawSnapshotSummary')}</summary>
            <pre>{JSON.stringify(snapshot, null, 2)}</pre>
          </details>
        )}

        {(() => {
          const snap = snapshot as (RunSnapshot & { pinned?: boolean; removalAt?: string }) | null;
          if (!snap || !isTerminal) return null;
          if (snap.pinned) return <Notice variant="info">{t('retentionPinned')}</Notice>;
          if (snap.removalAt) return <Notice variant="info">{t('retentionNote', { date: fmtTime(snap.removalAt) })}</Notice>;
          return null;
        })()}

        <div className="action-bar">
          <Button variant="secondary" onClick={onCancel} disabled={!snapshot || isTerminal}>
            {t('cancelRun')}
          </Button>
          {/* Grade-ux #4 — cancelled runs debug too (a cancel mid-flight is
              as much a "why did this stop here" as a failure). */}
          {snapshot && (snapshot.status === 'failed' || snapshot.status === 'cancelled') && snapshot.workflowId ? (
            <Button
              variant="secondary"
              onClick={() => nav(`/builder/${encodeURIComponent(snapshot.workflowId)}?debugRun=${encodeURIComponent(runId)}`)}
              title={t('debugInBuilderTitle')}
            >
              {t('debugInBuilder')}
            </Button>
          ) : null}
          {isTerminal ? (
            <Button
              variant="secondary"
              onClick={onTogglePin}
              aria-pressed={Boolean((snapshot as RunSnapshot & { pinned?: boolean } | null)?.pinned)}
              title={t('retentionPinTitle')}
            >
              {(snapshot as RunSnapshot & { pinned?: boolean } | null)?.pinned ? t('retentionUnpin') : t('retentionPin')}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => { window.location.href = `/compare?a=${encodeURIComponent(runId)}`; }}
            title={t('compareRunTitle')}
          >
            {t('compareEllipsis')}
          </Button>
          <Button
            variant="secondary"
            onClick={onDownloadDebugBundle}
            disabled={!snapshot}
            title={t('downloadBundleTitle')}
          >
            {t('downloadBundle')}
          </Button>
          <Button
            variant="danger"
            onClick={onDelete}
            title={t('deleteRunHistoryTitle')}
          >
            {t('deleteRun')}
          </Button>
        </div>
      </div>

      <RenderInterrupt
        runId={runId}
        active={activeInterrupt}
        onResolved={async () => {
          const snap = await getRun(runId);
          setSnapshot(snap);
          await refreshInterrupts();
        }}
      />

      <RunAnalyticsPanel
        events={events}
        annotations={annotations}
        annotationsUnavailable={annotationsFailed}
        eventsUnavailable={eventsRead === 'failed'}
      />
      <RunProvenancePanel events={events} snapshot={snapshot} />
      <RunFeedback runId={runId} onRecorded={refreshAnnotations} />
      {/* ADR 0482 §6 — the terminal costByNode stamp rides the snapshot; the
          panel falls back to the loaded provider.usage events pre-stamp. */}
      <RunCostPanel
        events={events}
        costByNode={(snapshot as (RunSnapshot & { costByNode?: Record<string, number> }) | null)?.costByNode}
      />
      <RunHandoffMap events={events} />
      <RunAgentTrace events={events} />
      <RunConversationPanel
        events={events}
        activeInterrupt={activeInterrupt}
        onResolved={async () => {
          const snap = await getRun(runId);
          setSnapshot(snap);
          await refreshInterrupts();
        }}
      />
      <RunOpsPanel runId={runId} events={events} />
      {/* ADR 0554 P3 — the obligation timeline + gated recovery actions. Sits
          beside RunOpsPanel because both are the run's operations surface; the
          ROUTES it calls are Operations routes, per ADR 0554's boundaries
          table. It owns its own read and its own permission gate, so it fails
          independently of the rest of this page. */}
      <RunCompensationPanel runId={runId} />
      <RunMemoryPanel runId={runId} events={events} status={snapshot?.status} />

      <div className="card">
        <div className="u-flex u-items-center u-gap-2 u-wrap">
          <h2 className="u-flex-1">{t('eventStreamHeading')}</h2>
          <label className="muted u-fs-12 u-iflex u-items-center u-gap-1">
            {t('streamModeLabel')}
            <select
              value={streamMode}
              onChange={(e) => setStreamMode(e.target.value as StreamMode)}
              title={t('streamModeTitle')}
            >
              <option value="updates">updates</option>
              <option value="values">values</option>
              <option value="messages">messages</option>
              <option value="debug">debug</option>
            </select>
          </label>
          <div className="segmented" role="tablist" aria-label={t('eventViewAria')} onKeyDown={handleTablistKeyDown}>
            <Button
              role="tab"
              aria-selected={eventView === 'timeline'}
              tabIndex={eventView === 'timeline' ? 0 : -1}
              // Selection is `aria-selected` + the `.segmented` rule, not a
              // variant: a segmented control has no CTA, and `.segmented > button`
              // resets every variant anyway (grade-ux DS-SEG-2).
              variant="secondary"
              onClick={() => setEventView('timeline')}
            >
              {t('eventViewTimeline')}
            </Button>
            <Button
              role="tab"
              aria-selected={eventView === 'log'}
              tabIndex={eventView === 'log' ? 0 : -1}
              variant="secondary"
              onClick={() => setEventView('log')}
            >
              {t('eventViewLog')}
            </Button>
          </div>
        </div>
        {eventView === 'timeline' ? (
          <RunTimeline
            events={events}
            onForkFrom={onForkFrom}
            onSelectSeq={setPlayheadSeq}
            readState={eventsRead}
            onRetry={retryEventRead}
          />
        ) : (
          <EventStreamView
            events={events}
            onForkFrom={onForkFrom}
            readState={eventsRead}
            onRetry={retryEventRead}
          />
        )}
      </div>

      {eventView === 'timeline' && playheadSeq != null && (
        <RunStepInspector events={events} seq={playheadSeq} onForkFrom={onForkFrom} />
      )}
    </section>
  );
}
