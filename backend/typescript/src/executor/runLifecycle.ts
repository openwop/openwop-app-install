/**
 * In-process pub/sub for run-terminal notifications.
 *
 * Sites that need to know when a run reaches a terminal state
 * (`run.completed`, `run.failed`, `run.cancelled`) register here. The
 * executor's terminal-emission paths call `notifyRunTerminal(runId,
 * status)` exactly once per run — this module is the SINGLE owner of
 * "a run reached terminal"; do not stand up a sibling seam elsewhere.
 *
 * Two subscription shapes, deliberately distinct:
 *
 *   - `onRunTerminal(runId, fn)` — PER-RUN, SYNCHRONOUS, fire-once,
 *     auto-unsubscribing. You must know the runId in advance. The sync
 *     contract is load-bearing: the rate-limit middleware (P0.4)
 *     releases the "concurrent runs" slot through it rather than
 *     relying on the 60s TTL safety-net called out in `rateLimit.ts`,
 *     and making it async would change slot-release timing.
 *
 *   - `onAnyRunTerminal(key, fn)` — GLOBAL, ASYNC, keyed, best-effort
 *     (ADR 0535). Fires for EVERY terminal run, so a subscriber that
 *     cannot know the runId ahead of time — or whose registration
 *     would not survive a cold start — still reacts. Same contract as
 *     the `host/*Lifecycle.ts` family: keyed registration (repeat boots
 *     overwrite rather than accumulate), idempotent bounded handlers,
 *     fan-out that never throws.
 *
 * Listeners auto-unsubscribe after firing — a run's terminal event is
 * fire-once. Re-registering on the same runId after a fire is harmless
 * but ignored (the runId is no longer tracked once it fires). Global
 * subscribers persist for the process lifetime.
 *
 * Pure in-process: a Cloud Run cold start drops every pending PER-RUN
 * subscriber. That's fine for the rate limiter — its state is also
 * per-process, so a cold start re-balances everything together. It is
 * NOT fine for durable work owned by a global subscriber, which is why
 * `onAnyRunTerminal` consumers must ALSO be reachable by a reconciling
 * read (ADR 0535: the heartbeat pass re-checks its own in-flight cards),
 * rather than treating this fan-out as a delivery guarantee. A process
 * that dies inside the terminal-emit window fires nothing, on any
 * instance.
 */

import { recordRunTerminal } from '../observability/metricSeams.js';

/** The terminal disposition a run reached. */
export type RunTerminalStatus = 'completed' | 'failed' | 'cancelled';

type Listener = () => void;
type GlobalListener = (runId: string, status: RunTerminalStatus) => Promise<void> | void;

const listeners = new Map<string, Set<Listener>>();
const globalListeners = new Map<string, GlobalListener>();

export function onRunTerminal(runId: string, fn: Listener): void {
  let s = listeners.get(runId);
  if (!s) { s = new Set(); listeners.set(runId, s); }
  s.add(fn);
}

// ── ADR 0553 P3: the run's cancellation signal ──────────────────────────────
//
// A run could be cancelled (`host/runCancel.ts` → `notifyRunTerminal`) and an
// in-flight outbound request would never learn of it: the drain loop only
// checks the RFC 0058 wall-clock deadline BETWEEN nodes and never re-reads the
// run row, so a node body had nothing to observe. `McpClientDeps.signal` has
// existed since ADR 0030 Phase 2b and consumed the abort in six places, but
// nothing ever supplied one — a dormant seam, documented as such in
// `mcpClient.ts`.
//
// It lives HERE rather than in a new module because the fact it needs is
// exactly the one this file already owns and calls itself the single owner of.
// A sibling "run abort registry" would be a second answer to "is this run
// still going", and the two would drift the first time a terminal path was
// added to one and not the other.

const aborters = new Map<string, AbortController>();
/** Bound: a run that dies without reaching terminal must not leak a controller
 *  for the process lifetime. Evict oldest-first, like the MCP result cache. */
const MAX_ABORTERS = 2_000;

/**
 * The signal for `runId`, armed to fire when the run reaches ANY terminal state
 * — or when `deadlineAtMs` passes, whichever is first.
 *
 * Aborting on every terminal status, not only `cancelled`, is deliberate. By
 * the time a run is `completed` or `failed` nothing of its should still be in
 * flight, so an abort is a no-op in the normal case and a leak-stopper in the
 * abnormal one (a `subscribeResource` window can outlive its run by minutes).
 * The CALLER decides what an abort means: `mcpClient` distinguishes a run
 * cancellation from a timeout by consulting this signal first, so the typed
 * outcome is `mcp_cancelled` rather than a misreported `mcp_timeout`.
 *
 * Idempotent: repeated calls for one run return the same signal, so every node
 * of a run shares one cancellation fact.
 */
export function armRunAbort(runId: string, deadlineAtMs?: number): AbortSignal {
  const existing = aborters.get(runId);
  if (existing) return existing.signal;
  const controller = new AbortController();
  if (aborters.size >= MAX_ABORTERS) {
    const oldest = aborters.keys().next();
    if (!oldest.done) aborters.delete(oldest.value);
  }
  aborters.set(runId, controller);
  onRunTerminal(runId, () => {
    aborters.delete(runId);
    if (!controller.signal.aborted) controller.abort(new Error('run reached terminal'));
  });
  if (deadlineAtMs !== undefined) {
    const remaining = deadlineAtMs - Date.now();
    // A deadline already in the past aborts immediately rather than scheduling
    // a timer for a negative delay (which `setTimeout` would fire on the next
    // tick anyway, but only after the caller had already started work).
    if (remaining <= 0) controller.abort(new Error('run deadline elapsed'));
    else {
      const timer = setTimeout(() => { if (!controller.signal.aborted) controller.abort(new Error('run deadline elapsed')); }, remaining);
      // Never hold the process open for a deadline nobody is waiting on.
      timer.unref?.();
    }
  }
  return controller.signal;
}

/** The armed signal for `runId`, or `undefined` when nothing armed one. Read by
 *  node adapters; deliberately does NOT arm, so a stray read cannot create a
 *  controller for a run the executor is not driving. */
/**
 * ADR 0632 — an operator PAUSE request (`runs.md` §Pause and resume), held
 * in-process beside the durable copy on `run.metadata.pauseRequest`. The
 * scheduler reads it at its dispatch point; `immediate` additionally fires the
 * run's abort signal so nodes that observe `ctx.signal` stop, then DROPS the
 * aborter so a resumed `executeRun` arms a fresh one (an AbortController cannot
 * be un-aborted; leaving it would abort every resumed node on entry).
 */
export interface RunPauseRequest {
  reason?: string;
  drainPolicy: 'immediate' | 'drain-current-node';
  requestedAt: string;
  /** Set once `immediate` has fired the abort — the scheduler uses it to tell a
   *  pause-aborted node (reset to ready) from a genuine failure. */
  abortedAt?: string;
  /** ADR 0632 / rc.52 — the in-flight attempt(s) an `immediate` pause cut. The
   *  record of the interruption is `run.paused` itself (`interruptedNodeId`);
   *  there is deliberately NO node-level event for the cut attempt. */
  interruptedNodeIds?: string[];
}

export function noteInterruptedNode(runId: string, nodeId: string): void {
  const req = pauseRequests.get(runId);
  if (!req) return;
  pauseRequests.set(runId, { ...req, interruptedNodeIds: [...(req.interruptedNodeIds ?? []), nodeId] });
}
const pauseRequests = new Map<string, RunPauseRequest>();
export function requestRunPause(runId: string, req: RunPauseRequest): void { pauseRequests.set(runId, req); }
export function runPauseRequest(runId: string): RunPauseRequest | undefined { return pauseRequests.get(runId); }
export function clearRunPause(runId: string): void { pauseRequests.delete(runId); }
export function abortRunForPause(runId: string): boolean {
  const c = aborters.get(runId);
  if (!c) return false;
  aborters.delete(runId);
  if (!c.signal.aborted) c.abort(new Error('run paused'));
  const req = pauseRequests.get(runId);
  if (req) pauseRequests.set(runId, { ...req, abortedAt: new Date().toISOString() });
  return true;
}

export function runAbortSignal(runId: string): AbortSignal | undefined {
  return aborters.get(runId)?.signal;
}

/**
 * Register (idempotently, keyed) a global handler run for EVERY terminal
 * run. Handlers must be idempotent and bounded — the same run can be
 * observed again by a reconciling read, and a slow handler delays no
 * caller but does hold the process.
 */
export function onAnyRunTerminal(key: string, fn: GlobalListener): void {
  globalListeners.set(key, fn);
}

/**
 * Announce a run's terminal state. Per-run listeners run synchronously
 * (the caller's slot release depends on it); global listeners are
 * dispatched fire-and-forget so a slow or throwing consumer can never
 * delay or fail the terminal path that produced the event.
 */
export function notifyRunTerminal(runId: string, status: RunTerminalStatus): void {
  // ADR 0556 P1 — emitted HERE, synchronously, rather than from an
  // `onAnyRunTerminal` subscriber. The global fan-out is fire-and-forget, and
  // this app has already been bitten once by a detached continuation that Cloud
  // Run never resumed under CPU throttling (the SPA-shell refresh wedge). A
  // terminal counter that silently stops incrementing on a throttled instance
  // is worse than none: it reads as a traffic drop.
  //
  // This is also why the emission is not in the three CALLERS. There are three
  // today and RFC-driven work keeps adding terminal paths; the module header
  // says this function is the single owner of "a run reached terminal", so the
  // metric rides the same guarantee rather than a list someone must remember.
  recordRunTerminal(runId, status);
  const s = listeners.get(runId);
  if (s) {
    listeners.delete(runId);
    for (const fn of s) {
      try { fn(); } catch { /* listener errors must not block other listeners */ }
    }
  }
  if (globalListeners.size > 0) void fireAnyRunTerminal(runId, status);
}

/** Global fan-out. Never throws; a consumer's failure is its own problem.
 *  Exported so tests can await the fan-out deterministically instead of
 *  racing the fire-and-forget dispatch in `notifyRunTerminal`. */
export async function fireAnyRunTerminal(runId: string, status: RunTerminalStatus): Promise<number> {
  let ran = 0;
  for (const fn of globalListeners.values()) {
    try { await fn(runId, status); ran += 1; } catch { /* a consumer's reaction must not affect the run */ }
  }
  return ran;
}

/** Test seam. */
export function _resetRunLifecycle(): void {
  listeners.clear();
  globalListeners.clear();
  aborters.clear();
}
