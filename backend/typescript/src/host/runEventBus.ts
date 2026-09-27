/**
 * CS-WF-4 (ADR 0326) — cross-instance run-event TICKS over the ONE host-ext
 * pub/sub (the same bus the chat message frames ride — no parallel transport).
 *
 * The run SSE stream's live fan-out was in-process only: a client whose SSE
 * connection landed on a different Cloud Run instance than the one appending
 * events (a conversation run's exchange handled elsewhere; a sweeper
 * re-dispatch) got replay-then-silence and degraded to polling. Each durable
 * append now also publishes a tiny `{seq}` tick keyed by runId; a subscriber
 * on another instance fetches the missed events from DURABLE storage (the
 * source of truth — the tick carries no payload, exactly the chat-frame
 * pattern).
 *
 * Coalesced per run (trailing-edge, TICK_COALESCE_MS) so a chatty node doesn't
 * turn every event into a bus write; a terminal event flushes immediately so
 * run-completion latency stays crisp. Best-effort fire-and-forget: a bus
 * hiccup degrades to the in-proc path + the poll fallback, never breaks the
 * append.
 */
import { publishHostExtEvent, subscribeHostExtEvent } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runEventBus');
const RUN_TICK_PREFIX = 'hostext:run:events:';
const TICK_COALESCE_MS = 100;

interface Pending { timer: ReturnType<typeof setTimeout>; maxSeq: number }
const pending = new Map<string, Pending>();

function flush(runId: string): void {
  const p = pending.get(runId);
  if (!p) return;
  pending.delete(runId);
  clearTimeout(p.timer);
  void publishHostExtEvent(`${RUN_TICK_PREFIX}${runId}`, JSON.stringify({ seq: p.maxSeq })).catch((err: unknown) => {
    log.debug('run_event_tick_publish_failed', { runId, error: err instanceof Error ? err.message : String(err) });
  });
}

/** Publish (coalesced) that `runId` now has durable events up to `seq`.
 *  `terminal` flushes immediately. Never throws. */
export function publishRunEventTick(runId: string, seq: number, terminal = false): void {
  try {
    const p = pending.get(runId);
    if (p) {
      p.maxSeq = Math.max(p.maxSeq, seq);
      if (terminal) flush(runId);
      return;
    }
    const entry: Pending = { maxSeq: seq, timer: setTimeout(() => flush(runId), TICK_COALESCE_MS) };
    pending.set(runId, entry);
    if (terminal) flush(runId);
  } catch { /* best-effort */ }
}

/** Subscribe to a run's ticks (cross-instance). Resolves to the unsubscribe. */
export async function subscribeRunEventTicks(runId: string, onTick: (seq: number) => void): Promise<() => Promise<void>> {
  return subscribeHostExtEvent(`${RUN_TICK_PREFIX}${runId}`, (payload: string) => {
    try {
      const { seq } = JSON.parse(payload) as { seq?: number };
      if (typeof seq === 'number') onTick(seq);
    } catch { /* malformed tick — the poll fallback covers it */ }
  });
}
