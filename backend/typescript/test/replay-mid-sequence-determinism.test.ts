import { describe, expect, it } from 'vitest';

import { detectAndRecordReplayDivergence } from '../src/executor/replayDivergence.js';
import type { EventRecord } from '../src/types.js';

/**
 * Mid-sequence replay determinism — the three defects that made
 * `POST /runs/{id}:fork` with `mode: replay, fromSeq > 0` answer 501.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `replay-divergence.test.ts`.
 *
 * That file tests `compareObservableSequences`, the PURE comparison — and it was
 * correct throughout. The defect was in its CALLER: the source was read from
 * `fromSeq` while the replay was read from 0, so the two arrays handed to a
 * working function were misaligned before it ever ran. Every test of the
 * mechanism passed while the wiring was wrong, which is the failure mode this
 * codebase keeps finding. So this file tests the SEAM
 * (`detectAndRecordReplayDivergence`), where the cursors actually live.
 */
function ev(runId: string, seq: number, type: string, nodeId?: string): EventRecord {
  return {
    eventId: `${runId}-e${seq}`,
    runId,
    sequence: seq,
    type,
    ...(nodeId ? { nodeId } : {}),
    payload: {},
    timestamp: new Date(seq * 1000).toISOString(),
  };
}

/**
 * The shape a real mid-sequence replay produces, per replay.md
 * §"Replay-from-event-log internals" 3: the fork's log is the inherited prefix
 * `[0, fromSeq)` copied verbatim, followed by the re-executed tail. Modelled
 * exactly, because the bug was invisible to any model that omitted the prefix.
 */
const SOURCE: EventRecord[] = [
  ev('src', 0, 'run.started'),
  ev('src', 1, 'node.started', 'a'),
  ev('src', 2, 'node.completed', 'a'),
  ev('src', 3, 'node.started', 'b'),
  ev('src', 4, 'node.completed', 'b'),
  ev('src', 5, 'node.started', 'c'),
  ev('src', 6, 'node.completed', 'c'),
  ev('src', 7, 'run.completed'),
];

const FROM_SEQ = 5;

/** Prefix copied verbatim, then the tail re-executed from the fork point. */
const FAITHFUL_REPLAY: EventRecord[] = [
  ...SOURCE.slice(0, FROM_SEQ).map((e) => ({ ...e, runId: 'rep', eventId: `rep-e${e.sequence}` })),
  ev('rep', 5, 'node.started', 'c'),
  ev('rep', 6, 'node.completed', 'c'),
  ev('rep', 7, 'run.completed'),
];

function readerFor(logs: Record<string, EventRecord[]>) {
  return {
    // Mirrors the storage contract the real reader has: the `fromSeq` cursor is
    // EXCLUSIVE. Getting this wrong in the double is the one way this test could
    // pass while production stays broken, so it is modelled, not simplified.
    async listEvents(runId: string, opts?: { fromSeq?: number; limit?: number }) {
      const all = logs[runId] ?? [];
      const after = opts?.fromSeq;
      const sliced = typeof after === 'number' ? all.filter((e) => (e.sequence ?? 0) > after) : all;
      return typeof opts?.limit === 'number' ? sliced.slice(0, opts.limit) : sliced;
    },
  };
}

function appenderSpy() {
  const appended: { type: string; payload: unknown }[] = [];
  return {
    appended,
    async append(input: { type: string; payload: unknown }) {
      appended.push({ type: input.type, payload: input.payload });
      return undefined;
    },
  };
}

describe('mid-sequence replay divergence detection compares like with like', () => {
  it('a faithful mid-sequence replay reports NO divergence and appends NO event', async () => {
    const appender = appenderSpy();
    const result = await detectAndRecordReplayDivergence(
      readerFor({ src: SOURCE, rep: FAITHFUL_REPLAY }),
      appender,
      'src',
      'rep',
      FROM_SEQ,
    );

    expect(
      result.diverged,
      `a replay that reproduced the source exactly was reported as diverged: expected=${String(result.expected)} `
        + `actual=${String(result.actual)}. Before the fix this ALWAYS fired at mid-sequence, because the replay was `
        + 'read from 0 (so its first event was the inherited prefix\'s `run.started`) while the source was read from '
        + '`fromSeq` — the comparison never saw the same position on both sides.',
    ).toBe(false);
    expect(appender.appended, 'a spurious `replay.diverged` was appended to a faithful replay').toEqual([]);
  });

  it('a replay that re-runs the WHOLE workflow after the prefix IS caught', async () => {
    // Defect 1 in isolation: no snapshot, so execution restarted at node `a`
    // instead of resuming at the fork point. The tail begins `node.started@a`.
    const restarted: EventRecord[] = [
      ...SOURCE.slice(0, FROM_SEQ).map((e) => ({ ...e, runId: 'rep', eventId: `rep-e${e.sequence}` })),
      ev('rep', 5, 'node.started', 'a'),
      ev('rep', 6, 'node.completed', 'a'),
    ];
    const appender = appenderSpy();
    const result = await detectAndRecordReplayDivergence(
      readerFor({ src: SOURCE, rep: restarted }), appender, 'src', 'rep', FROM_SEQ,
    );
    expect(result.diverged).toBe(true);
    expect(result.expected).toBe('node.started@c');
    expect(result.actual).toBe('node.started@a');
    expect(appender.appended.map((a) => a.type)).toEqual(['replay.diverged']);
  });

  it('a replay that re-emits `run.started` over the inherited prefix IS caught', async () => {
    // Defect 2 in isolation: the duplicate lifecycle event lands at `fromSeq`,
    // so the tail carries an event the source does not have at that position.
    const doubleStarted: EventRecord[] = [
      ...SOURCE.slice(0, FROM_SEQ).map((e) => ({ ...e, runId: 'rep', eventId: `rep-e${e.sequence}` })),
      ev('rep', 5, 'run.started'),
      ev('rep', 6, 'node.started', 'c'),
    ];
    const appender = appenderSpy();
    const result = await detectAndRecordReplayDivergence(
      readerFor({ src: SOURCE, rep: doubleStarted }), appender, 'src', 'rep', FROM_SEQ,
    );
    expect(result.diverged).toBe(true);
    expect(result.expected).toBe('node.started@c');
    expect(result.actual).toBe('run.started@');
  });

  it('full replay (`fromSeq = 0`) still compares the whole log', async () => {
    // The regression risk of the cursor fix: `fromSeq - 1` is `-1` here, which
    // must include sequence 0 rather than dropping it. A full replay was the
    // ONLY case that worked before, so it is the case a careless fix breaks.
    const full = SOURCE.map((e) => ({ ...e, runId: 'rep', eventId: `rep-e${e.sequence}` }));
    const appender = appenderSpy();
    const result = await detectAndRecordReplayDivergence(
      readerFor({ src: SOURCE, rep: full }), appender, 'src', 'rep', 0,
    );
    expect(result.diverged, 'an identical full replay must not diverge').toBe(false);
    expect(appender.appended).toEqual([]);
  });
});
