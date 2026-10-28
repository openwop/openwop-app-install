/**
 * ADR 0960 D4 — "Replay this run" and "Fork from here" for one campaign run.
 *
 * Replay is the existing `:fork` (mode `replay`): deterministic, LLM calls served
 * from the invocation log and side-effect steps reproducing the source outcome,
 * so it spends, sends and publishes nothing. When the replay ends, the panel
 * reads `:diff` against the source and says whether every step matched — the
 * only expected difference is who started each run (`run.started`).
 *
 * A branch fork RE-EXECUTES effects. ADR 0960 D4 requires ADR 0942's fork
 * posture (every external effect held for approval on a branch fork) before the
 * cockpit offers one, so the button is disabled with that reason.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { RunDiffResponse } from '@openwop/openwop';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { InlineState } from '../../ui/InlineState.js';
import { bound, client, forkRun, getRun } from '../../client/runsClient.js';

/** RFC 0054 `GET /v1/runs/{runId}:diff?against=`. Kept here, not in the eagerly
 *  loaded runs client, so the entry chunk does not carry it. */
export async function diffRuns(runId: string, against: string): Promise<RunDiffResponse | null> {
  return client.runs.diff(await bound(runId), await bound(against));
}

type Replay =
  | { kind: 'idle' }
  | { kind: 'running'; forkId?: string }
  | { kind: 'done'; forkId: string; matched: boolean; divergedAtSeq: number | null }
  | { kind: 'failed'; forkId?: string };

const TERMINAL = ['completed', 'failed', 'cancelled'];
const POLL_MS = 1_000;
const MAX_POLLS = 300;

/** True when the replay matched: no step differs and the end states agree. The
 *  fork's own `run.started` (its owner) is the one expected difference. */
export function replayMatched(diff: RunDiffResponse): boolean {
  const onlyStart = diff.eventDiffs.every((d) => {
    const a = (d as { aEvent?: { type?: string } }).aEvent?.type;
    const b = (d as { bEvent?: { type?: string } }).bEvent?.type;
    return a === 'run.started' && b === 'run.started';
  });
  return onlyStart && Object.keys(diff.stateDiff ?? {}).length === 0;
}

export function ReplayPanel({ runId, runStatus }: { runId: string; runStatus?: string | undefined }): JSX.Element {
  return <ReplayForRun key={runId} runId={runId} runStatus={runStatus} />;
}

function ReplayForRun({ runId, runStatus }: { runId: string; runStatus?: string | undefined }): JSX.Element {
  const { t } = useTranslation('campaign-orchestration');
  const [replay, setReplay] = useState<Replay>({ kind: 'idle' });
  // One replay per click (the ADR 0772 run-page precedent): a ref holds before React re-renders.
  const inFlight = useRef(false);
  // Polling stops when the panel goes away (another run picked, the page left).
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const finished = runStatus !== undefined && TERMINAL.includes(runStatus);

  const start = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setReplay({ kind: 'running' });
    let forkId: string | undefined;
    try {
      forkId = (await forkRun(runId, { fromSeq: 0, mode: 'replay' })).runId;
      if (!alive.current) return;
      setReplay({ kind: 'running', forkId });
      let status = '';
      for (let i = 0; i < MAX_POLLS && !TERMINAL.includes(status); i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (!alive.current) return;
        status = (await getRun(forkId)).status;
      }
      if (!TERMINAL.includes(status)) throw new Error('replay still running');
      if (!alive.current) return;
      const diff = await diffRuns(runId, forkId);
      if (!diff) throw new Error('no diff');
      if (!alive.current) return;
      setReplay({ kind: 'done', forkId, matched: replayMatched(diff), divergedAtSeq: diff.divergedAtSeq });
    } catch {
      if (!alive.current) return;
      setReplay({ kind: 'failed', ...(forkId ? { forkId } : {}) });
    } finally {
      inFlight.current = false;
    }
  };

  const forkLink = (id: string) => <Link className="inline-link" to={`/runs/${encodeURIComponent(id)}`}>{t('replayOpenFork')}</Link>;

  return (
    <div className="u-mt-2 u-mb-2">
      <div className="u-flex u-gap-2 u-items-center u-wrap">
        <Button variant="secondary" size="sm" disabled={!finished || replay.kind === 'running'} onClick={() => void start()}>
          {replay.kind === 'running' ? t('replayRunning') : t('replayRun')}
        </Button>
        <Button variant="secondary" size="sm" disabled aria-describedby={`fork-reason-${runId}`}>{t('replayBranch')}</Button>
        <span id={`fork-reason-${runId}`} className="muted u-fs-13">{t('replayBranchDisabled')}</span>
      </div>
      {!finished ? <p className="muted u-fs-13">{t('replayNeedsFinished')}</p> : null}
      {replay.kind === 'running' ? <InlineState kind="loading" message={t('replayRunning')} /> : null}
      {replay.kind === 'done' && replay.matched ? (
        <Notice variant="success" announce={t('replayMatched')}>{t('replayMatched')} {forkLink(replay.forkId)}</Notice>
      ) : null}
      {replay.kind === 'done' && !replay.matched ? (
        <Notice variant="warning" announce={t('replayDiverged', { seq: replay.divergedAtSeq ?? 0 })}>
          {t('replayDiverged', { seq: replay.divergedAtSeq ?? 0 })} {forkLink(replay.forkId)}
        </Notice>
      ) : null}
      {replay.kind === 'failed' ? (
        <Notice variant="error" announce={t('replayFailed')}>{t('replayFailed')} {replay.forkId ? forkLink(replay.forkId) : null}</Notice>
      ) : null}
    </div>
  );
}
