/**
 * Replay divergence detection (replay.md §"Failure surfaces" + §C).
 *
 * `mode: "replay"` re-executes a run from `fromSeq` (default 0). For a
 * DETERMINISTIC workflow the re-executed observable event sequence MUST match
 * the original's; if it doesn't, the host emits a `replay.diverged` event so an
 * operator can audit what changed (a model's behavior shifted, a tool returned
 * different bytes, etc.). This is the contract that lets the host honestly
 * advertise `capabilities.replay.supported = true`.
 *
 * "Observable" here is the structural run/node/decision lifecycle — NOT the
 * recorded-fact or cost events (`memory.written`, `provider.usage`, …) whose
 * ids/timestamps are fixed history and re-emitted, not regenerated
 * (replay.md L112). Comparing those would false-positive on benign ordering.
 */

import type { EventRecord } from '../types.js';

/** The structural lifecycle events whose ordered sequence defines a run's
 *  observable behavior for replay-determinism purposes. */
const OBSERVABLE_TYPES: ReadonlySet<string> = new Set([
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'node.started',
  'node.completed',
  'node.failed',
  'node.skipped',
  'node.suspended',
  'node.resumed',
  'approval.requested',
  'approval.granted',
  'approval.rejected',
  'approval.overridden',
  'clarification.requested',
  'clarification.resolved',
  'interrupt.requested',
  'interrupt.resolved',
]);

export interface DivergenceResult {
  diverged: boolean;
  /** Index into the observable sequence where source + replay first differ. */
  index?: number;
  /** `type@nodeId` the source produced at `index` (undefined = source ran out). */
  expected?: string;
  /** `type@nodeId` the replay produced at `index` (undefined = replay ran out). */
  actual?: string;
  originalEventId?: string;
  replayEventId?: string;
}

function key(e: EventRecord): string {
  return `${e.type}@${e.nodeId ?? ''}`;
}

/**
 * Compare the observable (structural) event sequences of a source run and its
 * replay. Returns the first divergence, or `{ diverged: false }`.
 */
export function compareObservableSequences(
  source: readonly EventRecord[],
  replay: readonly EventRecord[],
): DivergenceResult {
  const so = source.filter((e) => OBSERVABLE_TYPES.has(e.type));
  const ro = replay.filter((e) => OBSERVABLE_TYPES.has(e.type));
  const n = Math.max(so.length, ro.length);
  for (let i = 0; i < n; i++) {
    const s = so[i];
    const r = ro[i];
    const sk = s ? key(s) : undefined;
    const rk = r ? key(r) : undefined;
    if (sk !== rk) {
      return {
        diverged: true,
        index: i,
        ...(sk !== undefined ? { expected: sk } : {}),
        ...(rk !== undefined ? { actual: rk } : {}),
        ...(s ? { originalEventId: s.eventId } : {}),
        ...(r ? { replayEventId: r.eventId } : {}),
      };
    }
  }
  return { diverged: false };
}

/** Minimal append surface (matches the executor event log). */
interface EventAppender {
  append(input: {
    runId: string;
    type: string;
    nodeId?: string;
    payload: unknown;
    causationId?: string;
  }): Promise<unknown>;
}

interface EventReader {
  listEvents(runId: string, opts?: { fromSeq?: number; limit?: number }): Promise<readonly EventRecord[]>;
}

/**
 * After a replay run completes, compare its observable sequence against the
 * source (from `fromSeq` onward) and emit `replay.diverged` on the replay run
 * if they differ. Returns the divergence result (informational; non-blocking
 * per replay.md §"Failure surfaces").
 */
export async function detectAndRecordReplayDivergence(
  reader: EventReader,
  appender: EventAppender,
  sourceRunId: string,
  replayRunId: string,
  fromSeq: number,
): Promise<DivergenceResult> {
  // The comparison covers the events the replay RE-EXECUTES — `sequence >= fromSeq`
  // (`replay.md` §Endpoint) — but the storage cursor is EXCLUSIVE (`sequence >
  // fromSeq`), so the cursor for "at or after fromSeq" is `fromSeq - 1`. Passing
  // `fromSeq` straight through dropped the event AT the boundary; with 0-based
  // numbering (RFC 0171 §A.3) that is `run.started` on a full replay, so every
  // deterministic full replay reported `replay.diverged`.
  const source = await reader.listEvents(sourceRunId, { fromSeq: fromSeq - 1 });
  // THE SAME CURSOR ON BOTH SIDES — this line used to read the replay from the
  // BEGINNING while the source was read from `fromSeq`, and the asymmetry made a
  // spurious divergence unavoidable on every mid-sequence replay.
  //
  // A replay fork's log is `[inherited prefix 0..fromSeq-1] ++ [re-executed tail]`
  // (§"Replay-from-event-log internals" 3). Reading it from 0 therefore put the
  // PREFIX's `run.started` at replay index 0 and compared it against the source's
  // event at `fromSeq` — so the comparison reported `expected node.started@c,
  // actual run.started` for a run whose nodes are three `core.noop`s and could not
  // diverge from anything.
  //
  // The fix above this one (the duplicate `run.started`, executor.ts) was
  // necessary but NOT sufficient, and the two are easy to conflate: removing the
  // duplicate leaves the tail correct, while this read still starts 5 events too
  // early. Both had to move for a mid-sequence replay to compare like with like.
  //
  // Note the comment on the source line: it records fixing exactly this
  // off-by-one on the SOURCE side, and the replay side was left as it was. A
  // half-applied fix reads as a considered asymmetry, which is why it survived.
  const replay = await reader.listEvents(replayRunId, { fromSeq: fromSeq - 1 });
  const result = compareObservableSequences(source, replay);
  if (result.diverged) {
    await appender.append({
      runId: replayRunId,
      type: 'replay.diverged',
      payload: {
        // `$defs/replayDiverged` requires `sourceRunId` + `atSequence`; this
        // payload carried NEITHER (REP-3). `sourceRunId` has no envelope carrier
        // — the envelope's `runId` is the REPLAY run — so the event announced a
        // divergence without naming what it diverged FROM.
        sourceRunId,
        // ADR 0725 — `atSequence` is `integer ≥ 0` and `originalEventId` an
        // eventId on the def; a `null` under either was a type violation, not
        // an absence. Absent keys are absent.
        ...(typeof result.index === 'number' ? { atSequence: result.index } : {}),
        ...(result.originalEventId !== undefined ? { originalEventId: result.originalEventId } : {}),
        ...(result.replayEventId !== undefined ? { replayEventId: result.replayEventId } : {}),
        // `divergencePoint` was REMOVED rather than retained. Canonically it is a
        // `RunEventType` STRING naming which event-emission diverged (RFC 0027 §F,
        // e.g. "prompt.composed"); this host emitted a numeric sequence index
        // under the same name — a semantic AND type collision on a field the
        // corpus defines, which is worse than omitting it, because a conformant
        // consumer reading it gets an integer where an event name is specified.
        // The number it carried is exactly `atSequence`, now emitted correctly.
        // Safe to drop: nothing reads it (`runs.ts` logs `div.index` directly,
        // not the payload), and it was never conformant to begin with.
        ...(result.expected !== undefined ? { expected: result.expected } : {}),
        ...(result.actual !== undefined ? { actual: result.actual } : {}),
      },
    });
  }
  return result;
}
