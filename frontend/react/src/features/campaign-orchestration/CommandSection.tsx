/**
 * ADR 0960 D1/D3/D5 — the campaign's Command section on the campaign detail.
 *
 * A projection, never a second run viewer: the runs, live nodes and open gates
 * come from the campaign's command snapshot (polled every 10 s); choosing a run
 * shows the builder's own canvas read-only (`RunGraphView`, lazy) painted live,
 * with the existing `RunHandoffMap` and `RunStepInspector` beside it, and the run
 * page one link away. Every status is a labeled chip. A failed read is said,
 * never shown as an empty campaign. Lazy-loaded by the campaign detail.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { RunEventDoc } from '@openwop/openwop';
import { Button } from '../../ui/Button.js';
import { InlineState } from '../../ui/InlineState.js';
import { Notice } from '../../ui/Notice.js';
import { formatDateTime, formatRelativeTime } from '../../i18n/format.js';
import { RunHandoffMap } from '../../runs/RunHandoffMap.js';
import { RunStepInspector } from '../../runs/RunStepInspector.js';
import { getCommand, getCommandRunDefinition, type CommandSnapshot } from './campaignStudioClient.js';
import { ReplayPanel } from './ReplayPanel.js';

const RunGraphView = lazy(() => import('../../runs/RunGraphView.js').then((m) => ({ default: m.RunGraphView })));

const POLL_MS = 10_000;

type Load = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; snap: CommandSnapshot };
type Picked = { runId: string } & ({ kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; workflowId: string; definition: unknown });

/** Status → chip class; the label is always printed beside the color. */
function chipFor(status: string): string {
  if (status === 'completed') return 'chip chip--success';
  if (status === 'failed' || status === 'cancelled') return 'chip chip--danger';
  if (status.startsWith('waiting') || status === 'suspended' || status === 'paused') return 'chip chip--warning';
  return 'chip chip--muted';
}

export function CommandSection({ campaignId }: { campaignId: string }): JSX.Element {
  return <CommandForCampaign key={campaignId} campaignId={campaignId} />;
}

function CommandForCampaign({ campaignId }: { campaignId: string }): JSX.Element {
  const { t } = useTranslation('campaign-orchestration');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [picked, setPicked] = useState<Picked | null>(null);
  const [events, setEvents] = useState<RunEventDoc[]>([]);
  const [pollFailed, setPollFailed] = useState(false);
  const snapshotRequest = useRef(0);
  const definitionRequest = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++snapshotRequest.current;
    try {
      const snap = await getCommand(campaignId);
      if (request !== snapshotRequest.current) return;
      setLoad({ kind: 'ready', snap }); setPollFailed(false);
    } catch {
      if (request !== snapshotRequest.current) return;
      // A failed poll after a good read keeps what was shown and says so.
      setPollFailed(true);
      setLoad((prev) => (prev.kind === 'ready' ? prev : { kind: 'failed' }));
    }
  }, [campaignId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const pick = async (runId: string): Promise<void> => {
    const request = ++definitionRequest.current;
    setEvents([]);
    setPicked({ runId, kind: 'loading' });
    try {
      const d = await getCommandRunDefinition(campaignId, runId);
      if (request !== definitionRequest.current) return;
      setPicked({ runId, kind: 'ready', workflowId: d.workflowId, definition: d.definition });
    } catch {
      if (request !== definitionRequest.current) return;
      setPicked({ runId, kind: 'failed' });
    }
  };

  const status = (s: string): string => t(`commandStatus_${s.replace(/[^a-z]/g, '_')}`, { defaultValue: s });
  const lastSeq = events.length ? events[events.length - 1]?.sequence ?? 0 : 0;

  return (
    <section className="surface-card u-mb-4" aria-labelledby="campaign-command">
      <h3 id="campaign-command" className="u-mt-0">{t('commandTitle')}</h3>
      <p className="muted u-mt-0">{t('commandLede')}</p>
      {load.kind === 'loading' ? <InlineState kind="loading" message={t('commandLoading')} /> : null}
      {load.kind === 'failed' ? (
        <InlineState kind="failed" announce={t('commandLoadFailed')} announcePolite message={t('commandLoadFailed')}
          action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('commandRetry')}</Button>} />
      ) : null}
      {load.kind === 'ready' && pollFailed ? <Notice variant="warning" announce={t('commandLoadFailed')}>{t('commandLoadFailed')} <Button variant="link" onClick={() => void refresh()}>{t('commandRetry')}</Button></Notice> : null}
      {load.kind === 'ready' ? (
        <>
          <h4 className="u-mb-1">{t('commandGates')}</h4>
          {load.snap.gates.length === 0 ? <p className="muted u-mt-0">{t('commandNoGates')}</p> : (
            <ul className="u-list-none u-p-0 u-m-0 u-mb-3" aria-label={t('commandGates')}>
              {load.snap.gates.map((g) => (
                <li key={g.interruptId} className="u-flex u-items-center u-gap-2 u-mb-1">
                  <span className="chip chip--warning">{t(`commandGateKind_${g.kind.replace(/[^a-z]/g, '_')}`, { defaultValue: g.kind })}</span>
                  <span>{g.nodeId}</span>
                  <span className="muted u-fs-13">{t('commandGateWaiting', { since: formatRelativeTime(g.createdAt) })}</span>
                  <Link className="inline-link u-fs-13" to={`/runs/${encodeURIComponent(g.runId)}`}>{t('commandOpenRun')}</Link>
                </li>
              ))}
            </ul>
          )}
          <h4 className="u-mb-1">{t('commandRuns')}</h4>
          {load.snap.runs.length === 0 ? <p className="muted u-mt-0">{t('commandNoRuns')}</p> : (
            <ul className="u-list-none u-p-0 u-m-0 u-mb-3" aria-label={t('commandRuns')}>
              {load.snap.runs.map((r) => (
                <li key={r.runId} className="u-flex u-items-center u-gap-2 u-mb-1">
                  <span className={chipFor(r.status)}>{status(r.status)}</span>
                  <span className="chip chip--muted">{t(`commandRole_${r.role}`, { defaultValue: r.role })}</span>
                  <span className="u-truncate">{r.workflowId}</span>
                  <span className="muted u-fs-13">{formatDateTime(r.startedAt)}</span>
                  <Button variant="secondary" size="sm" aria-pressed={picked?.runId === r.runId} onClick={() => void pick(r.runId)}>
                    {t('commandShowGraph')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {load.snap.runsTruncated || load.snap.nodesTruncated || load.snap.gatesTruncated ? <p className="muted u-fs-13">{t('commandTruncated')}</p> : null}
          <p className="muted u-fs-13">{t('commandUnavailable')}</p>
        </>
      ) : null}
      {picked ? (
        <div className="u-mt-3">
          {picked.kind === 'loading' ? <InlineState kind="loading" message={t('commandGraphLoading')} /> : null}
          {picked.kind === 'failed' ? <Notice variant="error" announce={t('commandGraphFailed')}>{t('commandGraphFailed')}</Notice> : null}
          {picked.kind === 'ready' ? (
            <>
              <Suspense fallback={<InlineState kind="loading" message={t('commandGraphLoading')} />}>
                <RunGraphView runId={picked.runId} workflowId={picked.workflowId} definition={picked.definition} onEvents={setEvents}
                  labels={{ loading: t('commandGraphLoading'), unrenderable: t('commandGraphUnrenderable'), openRun: t('commandOpenRun'), aria: t('commandGraphAria'), eventsFailed: t('commandGraphEventsFailed') }} />
              </Suspense>
              {/* The keyboard- and screen-reader-reachable alternative to the canvas (ADR 0960 matrix #10). */}
              {load.kind === 'ready' && load.snap.nodes.some((n) => n.runId === picked.runId) ? (
                <ul className="u-list-none u-p-0 u-m-0 u-mt-2 u-mb-2" aria-label={t('commandSteps')}>
                  {load.snap.nodes.filter((n) => n.runId === picked.runId).map((n) => (
                    <li key={n.nodeId} className="u-flex u-items-center u-gap-2 u-mb-1">
                      <span className={chipFor(n.status)}>{t(`commandNode_${n.status}`)}</span>
                      <span>{n.nodeId}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ReplayPanel runId={picked.runId} runStatus={load.kind === 'ready' ? load.snap.runs.find((r) => r.runId === picked.runId)?.status : undefined} />
              <RunHandoffMap events={events} />
              {events.length ? <RunStepInspector events={events} seq={lastSeq} /> : null}
              <Link className="inline-link" to={`/runs/${encodeURIComponent(picked.runId)}`}>{t('commandOpenRun')}</Link>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
