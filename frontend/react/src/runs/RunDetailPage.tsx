import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import type { RunSnapshot, RunEventDoc, StreamMode } from '@openwop/openwop';
import { cancelRun, deleteRun, forkRun, getDebugBundle, getRun, pollEvents } from '../client/runsClient.js';
import { subscribeToRun } from '../client/streamsClient.js';
import { listOpenInterrupts, type OpenInterrupt } from '../client/interruptsClient.js';
import { listAnnotations, type Annotation } from '../client/feedbackClient.js';
import { StatusBadge } from '../ui/StatusBadge.js';
import { handleTablistKeyDown } from '../ui/rovingTabs.js';
import { EventStreamView } from '../streams/EventStreamView.js';
import { RunTimeline } from './RunTimeline.js';
import { RunStepInspector } from './RunStepInspector.js';
import { RunAgentTrace } from './RunAgentTrace.js';
import { RunHandoffMap } from './RunHandoffMap.js';
import { RunCostPanel } from './RunCostPanel.js';
import { RunProvenancePanel } from './RunProvenancePanel.js';
import { RunAnalyticsPanel } from './RunAnalyticsPanel.js';
import { RunFeedback } from './RunFeedback.js';
import { RunOpsPanel } from './RunOpsPanel.js';
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

function fmtTime(iso?: string): string {
  return iso ? formatDateTime(iso) : '—';
}

export function RunDetailPage() {
  const { t } = useTranslation('runs');
  const { runId = '' } = useParams();
  const nav = useNavigate();
  // §C3/§D — when this run was opened from a fork, carry a back-reference to
  // the source so a reviewer can navigate to the feedback that motivated it.
  const [searchParams] = useSearchParams();
  const forkedFrom = searchParams.get('from');
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [events, setEvents] = useState<RunEventDoc[]>([]);
  const [activeInterrupt, setActiveInterrupt] = useState<OpenInterrupt | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [error, setError] = useState<string | null>(null);
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
  // host doesn't advertise capabilities.feedback, so this is a safe no-op there.
  const refreshAnnotations = useCallback(async () => {
    if (!runId) return;
    try {
      setAnnotations(await listAnnotations(runId));
    } catch {
      /* non-fatal — the quality panel just stays empty */
    }
  }, [runId]);

  // Initial snapshot + replay buffered events + open-interrupt fetch.
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getRun(runId);
        if (!cancelled) setSnapshot(snap);
        const polled = await pollEvents(runId, 0);
        if (!cancelled) setEvents([...polled.events]);
        await refreshInterrupts();
        if (!cancelled) await refreshAnnotations();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, refreshInterrupts, refreshAnnotations]);

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
    const targetNodeId = decodeURIComponent(hash.slice('#node-'.length));
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
      inspector?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
            ['run.completed', 'run.failed', 'run.cancelled', 'node.suspended', 'node.interrupt.resolved'].includes(ev.type)
          ) {
            getRun(runId).then(setSnapshot).catch(() => undefined);
          }
          // On terminal events, re-poll the full event log via REST. The
          // SSE stream may not carry every event family the panels read
          // (cost / reasoning / handoff); the authoritative log backfills
          // anything the live stream missed so the panels are complete.
          if (['run.completed', 'run.failed', 'run.cancelled'].includes(ev.type)) {
            pollEvents(runId, 0)
              .then((p) => setEvents([...p.events]))
              .catch(() => undefined);
          }
          // Interrupt-related transitions trigger an authenticated refetch
          // because the public event payload no longer carries the resume token.
          if (['node.suspended', 'node.interrupt.resolved'].includes(ev.type)) {
            refreshInterrupts();
          }
          return next;
        });
      },
      onError: () => setError('Event stream connection error (will reconnect)'),
    });
    return () => sub.close();
  }, [runId, refreshInterrupts, streamMode]);

  async function onCancel() {
    if (!runId) return;
    try {
      await cancelRun(runId, 'cancelled from sample UI');
      const snap = await getRun(runId);
      setSnapshot(snap);
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

  async function onForkFrom(seq: number) {
    if (!runId) return;
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
    <section aria-labelledby="rundetail-heading">
      <div className="u-mb-3">
        <Link to="/runs" className="u-fs-12 u-ink-3">
          <ArrowLeftIcon size={12} /> Runs
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

        {!snapshot && !error && (
          <div className="rundetail-summary-loading" aria-busy="true" aria-label={t('loadingRun')}>
            <Skeleton width="42%" />
            <Skeleton width="68%" />
            <Skeleton width="54%" />
          </div>
        )}

        {snapshot && (
          <dl className="rundetail-summary">
            <dt>{t('workflowFieldLabel')}</dt>
            <dd><code>{snapshot.workflowId}</code></dd>
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

        {snapshot?.error?.message && (
          <Notice variant="error">
            <strong>{snapshot.error.code ?? t('runErrorFallback')}:</strong> {snapshot.error.message}
          </Notice>
        )}

        {snapshot && (
          <details className="rundetail-raw">
            <summary>{t('rawSnapshotSummary')}</summary>
            <pre>{JSON.stringify(snapshot, null, 2)}</pre>
          </details>
        )}

        <div className="action-bar">
          <button className="secondary" onClick={onCancel} disabled={!snapshot || isTerminal}>
            {t('cancelRun')}
          </button>
          <button
            className="secondary"
            onClick={() => { window.location.href = `/compare?a=${encodeURIComponent(runId)}`; }}
            title={t('compareRunTitle')}
          >
            {t('compareEllipsis')}
          </button>
          <button
            className="secondary"
            onClick={onDownloadDebugBundle}
            disabled={!snapshot}
            title={t('downloadBundleTitle')}
          >
            {t('downloadBundle')}
          </button>
          <button
            className="secondary u-text-danger"
            onClick={onDelete}
            title={t('deleteRunHistoryTitle')}
          >
            {t('deleteRun')}
          </button>
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

      <RunAnalyticsPanel events={events} annotations={annotations} />
      <RunProvenancePanel events={events} snapshot={snapshot} />
      <RunFeedback runId={runId} onRecorded={refreshAnnotations} />
      <RunCostPanel events={events} />
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
      <RunMemoryPanel runId={runId} events={events} status={snapshot?.status} />

      <div className="card">
        <div className="u-flex u-items-center u-gap-2 u-wrap">
          <h2 className="u-flex-1">Event stream</h2>
          <label className="muted u-fs-12 u-iflex u-items-center u-gap-1">
            mode
            <select
              value={streamMode}
              onChange={(e) => setStreamMode(e.target.value as StreamMode)}
              title="SSE stream mode — re-subscribes on change"
            >
              <option value="updates">updates</option>
              <option value="values">values</option>
              <option value="messages">messages</option>
              <option value="debug">debug</option>
            </select>
          </label>
          <div className="segmented" role="tablist" aria-label={t('eventViewAria')} onKeyDown={handleTablistKeyDown}>
            <button
              type="button"
              role="tab"
              aria-selected={eventView === 'timeline'}
              tabIndex={eventView === 'timeline' ? 0 : -1}
              className={eventView === 'timeline' ? '' : 'secondary'}
              onClick={() => setEventView('timeline')}
            >
              Timeline
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={eventView === 'log'}
              tabIndex={eventView === 'log' ? 0 : -1}
              className={eventView === 'log' ? '' : 'secondary'}
              onClick={() => setEventView('log')}
            >
              Log
            </button>
          </div>
        </div>
        {eventView === 'timeline' ? (
          <RunTimeline events={events} onForkFrom={onForkFrom} onSelectSeq={setPlayheadSeq} />
        ) : (
          <EventStreamView events={events} onForkFrom={onForkFrom} />
        )}
      </div>

      {eventView === 'timeline' && playheadSeq != null && (
        <RunStepInspector events={events} seq={playheadSeq} onForkFrom={onForkFrom} />
      )}
    </section>
  );
}
