import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { Link } from 'react-router-dom';
import type { RunEventDoc } from '@openwop/openwop';
import { cancelRun, deleteRun, listMyRuns, pollEvents, type RunListItem } from '../client/runsClient.js';
import { PageHeader } from '../ui/PageHeader.js';
import { StatusBadge } from '../ui/StatusBadge.js';
import { StateCard } from '../ui/StateCard.js';
import { Notice } from '../ui/Notice.js';
import { Skeleton } from '../ui/Skeleton.js';
import { subscribeToRun } from '../client/streamsClient.js';
import { RunAgentTrace } from './RunAgentTrace.js';
import { RunHandoffMap } from './RunHandoffMap.js';
import { AlertIcon, ActivityIcon, TrashIcon } from '../ui/icons/index.js';

// "Mission Control" — RFC 0055/0056 NOT required. This page is a pure
// composition of surfaces the protocol + app already expose: it polls
// `listMyRuns` for in-flight runs (left rail) and multiplexes each
// selected run's existing SSE stream (`subscribeToRun`) into the
// already-shipped `RunHandoffMap` + `RunAgentTrace` views. See
// plans/app-ux-enhancements.md §A1.

const TERMINAL = ['completed', 'failed', 'cancelled'];
const ACTIVE_POLL_MS = 5_000;

/** In-flight = anything the engine hasn't marked terminal. */
function isActive(status: string): boolean {
  return !TERMINAL.includes(status);
}

/** HITL-blocked runs awaiting a human turn — surfaced with an attention chip. */
function needsAttention(status: string): boolean {
  return status.startsWith('waiting') || status === 'suspended' || status === 'paused';
}

export function CommandCenterPage() {
  const { t } = useTranslation('runs');
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  // Poll the active-run list so finished runs drop off and new ones
  // appear without a manual refresh — the "live mission control" feel
  // without needing a tenant-wide event firehose (which the protocol
  // doesn't expose). Per-run liveness comes from SSE below.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      try {
        const list = await listMyRuns({ limit: 40 });
        if (cancelled) return;
        const active = list.filter((r) => isActive(r.status));
        setRuns(active);
        setListError(null);
        // Auto-select the first active run on first load so the detail
        // pane isn't empty. Don't clobber an explicit user selection.
        setSelectedRunId((cur) => cur ?? active[0]?.runId ?? null);
      } catch (err) {
        if (!cancelled) setListError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoadedOnce(true);
          timer = setTimeout(tick, ACTIVE_POLL_MS);
        }
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const selectedListItem = runs.find((r) => r.runId === selectedRunId) ?? null;

  // Float runs that need a human to the top of the rail so the eye is pulled
  // to what's blocked — mission-control triage, not a flat list. Stable within
  // each group (the poll already returns newest-first).
  const sortedRuns = [...runs].sort(
    (a, b) => Number(needsAttention(b.status)) - Number(needsAttention(a.status)),
  );
  const attentionCount = runs.filter((r) => needsAttention(r.status)).length;

  // Per-run kill (cancel) / delete. Both drop the run from the active view;
  // selection clears if the acted-on run was selected. The 5s poll reconciles.
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function runAction(runId: string, fn: () => Promise<void>) {
    setBusyRunId(runId);
    setActionError(null);
    try {
      await fn();
      setRuns((prev) => prev.filter((r) => r.runId !== runId));
      setSelectedRunId((cur) => (cur === runId ? null : cur));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRunId(null);
    }
  }

  const onCancel = (runId: string) => runAction(runId, () => cancelRun(runId, 'cancelled from Mission Control'));
  const onDelete = async (runId: string) => {
    if (!(await confirm({ title: t('deleteRunConfirm'), danger: true, confirmLabel: t('common:delete') }))) return;
    void runAction(runId, () => deleteRun(runId));
  };

  return (
    <section>
      <PageHeader
        eyebrow={t('missionEyebrow')}
        title={t('missionControlTitle')}
        lede={t('missionControlLede')}
        actions={
          <span className="muted u-fs-12" aria-live="polite">
            {t('activeCount', { count: runs.length })}
            {attentionCount > 0 ? ` · ${t('needAttentionCount', { count: attentionCount })}` : ''}
          </span>
        }
      />
      {listError && <Notice variant="error">{listError}</Notice>}
      {actionError && <Notice variant="error">{actionError}</Notice>}

      <div className="command-center">
        <aside className="command-center-rail" aria-label={t('activeRunsLabel')}>
          {!loadedOnce ? (
            // First-fetch placeholder so the rail reads as loading-on-purpose,
            // not a blank gate, while listMyRuns resolves.
            Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="surface-card u-grid u-gap-2" aria-hidden="true">
                <div className="u-flex u-items-center u-gap-2">
                  <Skeleton width={72} />
                  <Skeleton width={56} height={16} radius={999} />
                </div>
                <Skeleton width="80%" />
              </div>
            ))
          ) : runs.length === 0 ? (
            <StateCard
              icon={<ActivityIcon size={20} />}
              title={t('noActiveRunsTitle')}
              body={t('noActiveRunsBody')}
              action={<Link className="primary" to="/builder">{t('newWorkflowRun')}</Link>}
            />
          ) : (
            sortedRuns.map((r) => {
              const isSel = r.runId === selectedRunId;
              const busy = busyRunId === r.runId;
              return (
                <div key={r.runId} className={`surface-card cc-run${isSel ? ' cc-run--selected' : ''}`}>
                  <button
                    type="button"
                    className="cc-run-select"
                    onClick={() => setSelectedRunId(r.runId)}
                    aria-pressed={isSel}
                  >
                    <span className="cc-run-top">
                      <code>{r.runId.slice(0, 8)}…</code>
                      <StatusBadge status={r.status} />
                    </span>
                    <span className="cc-run-wf" title={r.workflowId}>{r.workflowId}</span>
                    {needsAttention(r.status) && (
                      <span className="chip chip--warning chip--pulse">
                        <span aria-hidden="true"><AlertIcon size={12} /></span>
                        {t('awaitingHumanInput')}
                      </span>
                    )}
                  </button>
                  <div className="action-bar">
                    <button type="button" className="secondary btn-sm" disabled={busy} onClick={() => onCancel(r.runId)} title={t('cancelRunTitle')}>
                      {busy ? '…' : t('common:cancel')}
                    </button>
                    <button
                      type="button"
                      className="secondary btn-sm"
                      disabled={busy}
                      onClick={() => onDelete(r.runId)}
                      title={t('deleteRunTitle')}
                      aria-label={t('deleteRunAria')}
                    >
                      <span aria-hidden="true"><TrashIcon size={14} /></span>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </aside>

        <div className="command-center-detail">
          {selectedRunId ? (
            <RunWatch
              key={selectedRunId}
              runId={selectedRunId}
              fallbackStatus={selectedListItem?.status}
            />
          ) : (
            loadedOnce && runs.length > 0 && (
              <StateCard
                icon={<ActivityIcon size={20} />}
                title={t('selectRunTitle')}
                body={t('selectRunBody')}
              />
            )
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Live detail for one run: seeds from the REST event log, then streams
 * SSE `updates` into the existing handoff/trace views. Mirrors the
 * subscription discipline in RunDetailPage (dedupe by sequence, relaxed
 * idle/absolute timeouts for long HITL waits, close on unmount).
 */
function RunWatch({ runId, fallbackStatus }: { runId: string; fallbackStatus?: string | undefined }) {
  const { t } = useTranslation('runs');
  const [events, setEvents] = useState<RunEventDoc[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Seed with the authoritative log so switching to a run shows its
    // current trace immediately, not just events from now on.
    void pollEvents(runId, 0)
      .then((p) => { if (!cancelled) setEvents([...p.events]); })
      .catch(() => undefined);

    const sub = subscribeToRun(runId, {
      modes: ['updates'],
      idleTimeoutMs: 5 * 60_000,
      absoluteTimeoutMs: 30 * 60_000,
      onEvent: (ev) => {
        setEvents((prev) => {
          if (prev.some((e) => e.sequence === ev.sequence)) return prev;
          return [...prev, ev].sort((a, b) => a.sequence - b.sequence);
        });
      },
      onError: () => setStreamError(t('streamConnectionError')),
    });

    return () => {
      cancelled = true;
      sub.close();
    };
  }, [runId, t]);

  // Derive status from the event log (seeded + live), so an already-finished
  // run selected from a stale rail entry still reads its true terminal state
  // rather than defaulting to "running".
  const terminalEvent = events.find((e) => ['run.completed', 'run.failed', 'run.cancelled'].includes(e.type));
  const status = (terminalEvent ? terminalEvent.type.slice('run.'.length) : fallbackStatus) ?? 'running';
  const live = !TERMINAL.includes(status);
  const hasActivity = events.some((e) => e.type.startsWith('agent.') || e.type.startsWith('runOrchestrator.') || e.type.startsWith('core.workflowChain.'));

  return (
    <>
      <div className="surface-card">
        <div className="u-flex u-items-center u-gap-2 u-wrap">
          <h2 className="u-m-0 u-flex-1">
            {t('runLabel')} <code>{runId.slice(0, 8)}…</code>
            <StatusBadge status={status} className="u-ml-2" />
          </h2>
          {live && (
            <span className="chip chip--accent chip--pulse" title={t('streamingLive')}>
              <span aria-hidden="true"><ActivityIcon size={12} /></span>
              {t('live')}
            </span>
          )}
          <Link to={`/runs/${runId}`}>{t('openFullDetail')}</Link>
        </div>
        {streamError && <div className="u-mt-2"><Notice variant="error">{streamError}</Notice></div>}
      </div>

      {hasActivity ? (
        <>
          <RunHandoffMap events={events} />
          <RunAgentTrace events={events} />
        </>
      ) : (
        <StateCard
          loading={live}
          icon={<ActivityIcon size={20} />}
          title={live ? t('waitingForAgentActivity') : t('noAgentActivityTitle')}
          body={live ? t('waitingForAgentActivityBody') : t('noAgentActivityBody')}
        />
      )}
    </>
  );
}
