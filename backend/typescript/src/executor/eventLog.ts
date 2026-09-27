/**
 * Event log singleton. Wires the executor's emit calls to the storage
 * adapter's atomic-sequence appendEvent.
 *
 * As of P3.3 every method is async — the underlying Storage interface
 * is async-native (Promise-returning). Callers `await`.
 */

import { randomUUID } from 'node:crypto';
import type { EventRecord } from '../types.js';
import type { Storage } from '../storage/storage.js';
import { publishRunEventTick } from '../host/runEventBus.js';
import { isForwardExecutionEvent, RunLogClosedError } from '../storage/runLogClosure.js';

/** Terminal run events flush the cross-instance tick immediately (CS-WF-4). */
const TERMINAL_TICK_TYPES: ReadonlySet<string> = new Set(['run.completed', 'run.failed', 'run.cancelled']);

/**
 * RFC 0194 §A — the per-process FAST PATH of the closed-log rule. The rule and
 * the error live in `storage/runLogClosure.ts`; the STORE is the authority
 * (it holds across instances). This refuses without a round-trip once THIS
 * process has appended a run's terminal event.
 */
const MAX_CLOSED_RUNS = 10_000;
const closedRuns = new Map<string, string>(); // runId → the terminal type that closed it
function markClosed(runId: string, type: string): void {
  if (closedRuns.size >= MAX_CLOSED_RUNS) {
    const oldest = closedRuns.keys().next();
    if (!oldest.done) closedRuns.delete(oldest.value);
  }
  closedRuns.set(runId, type);
}

export { RunLogClosedError };

let backend: Storage | null = null;

const subscribers = new Set<(event: EventRecord) => void>();

export function setEventLogBackend(storage: Storage): void {
  backend = storage;
}

export function getEventLog() {
  return {
    /**
     * `timestamp` is for exactly ONE caller: the `:fork` handler copying a
     * source run's inherited prefix (`routes/runs.ts`). `persistence.md`
     * §"The reader rule" says `timestamp` passes through untouched, and the
     * corpus asserts it on the fork's prefix — copying an event while stamping
     * it `now` rewrites history into the copy.
     *
     * A LIVE append must never set it. Nothing a node can reach passes it:
     * `ctx.emit` goes through `normaliseEmitArgs` and the executor, neither of
     * which forwards a timestamp, so this is not a forgery seam for workflow
     * code — it is a copy seam for one host-side loop.
     */
    async append(input: { runId: string; type: string; nodeId?: string; payload?: unknown; causationId?: string; timestamp?: string }): Promise<EventRecord> {
      if (!backend) throw new Error('EventLog backend not installed');
      const closedBy = closedRuns.get(input.runId);
      if (closedBy !== undefined && isForwardExecutionEvent(input.type)) {
        throw new RunLogClosedError(input.runId, input.type, closedBy);
      }
      const record = await backend.appendEvent({
        eventId: randomUUID(),
        runId: input.runId,
        type: input.type,
        nodeId: input.nodeId,
        payload: input.payload ?? null,
        timestamp: input.timestamp ?? new Date().toISOString(),
        causationId: input.causationId,
      });
      // A terminal append closes the log, marked only once it is durable. The
      // store applies the same rule to every append, including the `:fork` copy
      // seam, so a fork whose copied prefix holds the source's terminal event
      // cannot run forward either (that would be a second terminal).
      if (TERMINAL_TICK_TYPES.has(input.type)) markClosed(input.runId, input.type);
      // Best-effort fanout to in-process subscribers (SSE, webhooks).
      for (const sub of subscribers) {
        try {
          sub(record);
        } catch {
          /* swallow — subscriber failures must not abort the append */
        }
      }
      // CS-WF-4 (ADR 0326) — cross-instance tick (coalesced, best-effort):
      // an SSE connection on ANOTHER instance learns new events exist and
      // fetches them from durable storage. Terminal events flush immediately.
      publishRunEventTick(record.runId, record.sequence, TERMINAL_TICK_TYPES.has(record.type));
      return record;
    },
    async list(runId: string, opts?: { fromSeq?: number; limit?: number; contract?: 1 | 2 }): Promise<readonly EventRecord[]> {
      if (!backend) throw new Error('EventLog backend not installed');
      return await backend.listEvents(runId, opts);
    },
    async getMaxSequence(runId: string): Promise<number> {
      if (!backend) throw new Error('EventLog backend not installed');
      return await backend.getMaxSequence(runId);
    },
    subscribe(fn: (event: EventRecord) => void): () => void {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}
