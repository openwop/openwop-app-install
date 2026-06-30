/**
 * RFC 0118 — parallel sub-workflow fan-out + join (`core.dispatch` `fanOutPolicy: 'parallel'`).
 * The load-bearing, host-agnostic JOIN-FOLD semantics + the bounded-concurrency coordinator,
 * plus the capability advertisement and the registration cross-field validator. This is the
 * single source of truth shared by the discovery advertisement (`dispatchCapability()`), the
 * conformance witness seam (`routes/dispatchFanOut.ts`), and — when executor integration lands
 * (ADR 0154) — the real `core.dispatch` parallel path.
 *
 * The normative core of RFC 0118 is `foldJoin()`: given the children's terminal outcomes in the
 * parent host's observed wall-clock order, it computes `joinOutcome`/counts/`mergeOrder` per the
 * `joinPolicy` (`mode` × `onChildFailure`). `mergeOrder` is the replay-deterministic tiebreak —
 * recorded at terminal-fold time, never recomputed from child timestamps.
 *
 * @see RFCS/0118-parallel-subworkflow-fan-out-and-join.md
 * @see spec/v1/node-packs.md §"core.dispatch parallel fan-out and join (RFC 0118)"
 * @see schemas/dispatch-config.schema.json, run-event-payloads.schema.json ($defs.dispatchFanOut/Join)
 */

export type FanOutPolicy = 'sequential' | 'reject' | 'parallel';
export type JoinMode = 'wait-all' | 'quorum' | 'first' | 'race';
export type OnChildFailure = 'collect' | 'fail-fast' | 'absorb';
export type ChildStatus = 'completed' | 'failed' | 'cancelled';
export type JoinOutcome = 'satisfied' | 'failed' | 'partial';

export interface JoinPolicy {
  mode?: JoinMode;
  quorum?: number;
  onChildFailure?: OnChildFailure;
}

export interface DispatchFanOutConfig {
  fanOutPolicy?: FanOutPolicy;
  maxConcurrency?: number;
  joinPolicy?: JoinPolicy;
}

/** A child run's terminal, captured in the parent host's observed terminal ORDER.
 *  `workflowId`/`childVariables`/`error` are additive (the witness seam folds the bare
 *  `{childRunId, status}`); the executor arm populates them so the post-join fold can apply
 *  `outputMapping` in `mergeOrder` and emit the `{workflowId, childRunId, childStatus, error?}`
 *  node output (RFC 0118 §D). */
export interface ChildTerminal {
  childRunId: string;
  status: ChildStatus;
  /** The dispatched child workflow id (for the node-output `children[]`). */
  workflowId?: string;
  /** The child's terminal variable bag — the source for `outputMapping`, applied post-join. */
  childVariables?: Record<string, unknown>;
  /** Present when the child failed at runtime (surfaced on `children[].error`). */
  error?: { code: string; message: string };
}

export interface JoinResult {
  joinOutcome: JoinOutcome;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  /** childRunIds in observed wall-clock terminal order (replay-deterministic merge tiebreak). */
  mergeOrder: string[];
}

/** The host's hard ceiling on concurrent children (advertised as `dispatch.maxFanOut`). */
export const HOST_MAX_FAN_OUT = 16;

/** Effective concurrency = min(config.maxConcurrency ?? ∞, host maxFanOut). Always ≥ 1. */
export function effectiveConcurrency(maxConcurrency: number | undefined, maxFanOut = HOST_MAX_FAN_OUT): number {
  const a = maxConcurrency && maxConcurrency > 0 ? maxConcurrency : Number.POSITIVE_INFINITY;
  const b = maxFanOut > 0 ? maxFanOut : Number.POSITIVE_INFINITY;
  const eff = Math.min(a, b);
  return Number.isFinite(eff) ? eff : Math.max(1, maxFanOut);
}

/**
 * RFC 0118 join-fold. `terminals` MUST already be in observed terminal order. `mode` decides WHEN
 * the join is satisfied; `onChildFailure` decides how a non-`completed` child affects the node.
 * `mode`/`onChildFailure` are orthogonal axes (RFC 0118 §D).
 */
export function foldJoin(terminals: readonly ChildTerminal[], joinPolicy: JoinPolicy = {}): JoinResult {
  const mode: JoinMode = joinPolicy.mode ?? 'wait-all';
  const onChildFailure: OnChildFailure = joinPolicy.onChildFailure ?? 'collect';
  const completedCount = terminals.filter((t) => t.status === 'completed').length;
  const failedCount = terminals.filter((t) => t.status === 'failed').length;
  const cancelledCount = terminals.filter((t) => t.status === 'cancelled').length;
  const mergeOrder = terminals.map((t) => t.childRunId);
  const nonCompleted = failedCount + cancelledCount;

  // `fail-fast`: the first child to reach failed/cancelled fails the node (and cancels the rest,
  // modeled by the caller short-circuiting dispatch). Any non-completed terminal ⇒ failed.
  if (onChildFailure === 'fail-fast' && nonCompleted > 0) {
    return { joinOutcome: 'failed', completedCount, failedCount, cancelledCount, mergeOrder };
  }

  // Whether the completion CONDITION (`mode`) is met by the observed terminals.
  const modeSatisfied = (() => {
    switch (mode) {
      case 'wait-all':
        return true; // caller only folds once every child is terminal
      case 'quorum':
        return joinPolicy.quorum !== undefined && completedCount >= joinPolicy.quorum;
      case 'first':
        return completedCount >= 1;
      case 'race':
        return terminals.length >= 1; // first terminal of ANY kind
      default:
        return false;
    }
  })();

  if (!modeSatisfied) {
    // e.g. quorum unreachable — the node fails.
    return { joinOutcome: 'failed', completedCount, failedCount, cancelledCount, mergeOrder };
  }

  // Mode satisfied. `satisfied` when nothing was discarded/failed; `partial` when ≥1 non-completed
  // child rode through under collect/absorb (the node still SUCCEEDS).
  const joinOutcome: JoinOutcome = nonCompleted > 0 ? 'partial' : 'satisfied';
  return { joinOutcome, completedCount, failedCount, cancelledCount, mergeOrder };
}

/** A function that dispatches one child and resolves to its terminal. */
export type DispatchChild = (workerId: string, index: number) => Promise<ChildTerminal>;

export interface FanOutEvents {
  /** `core.dispatch.fanOut` — emitted when the parallel wave begins. */
  fanOut?: (e: { fanOutPolicy: 'parallel'; childCount: number; maxConcurrency?: number; joinMode: JoinMode }) => void;
  /** `core.dispatch.join` — emitted when the join is satisfied (or fails). */
  join?: (e: JoinResult) => void;
}

export interface FanOutOutput extends JoinResult {
  /** Per-child terminals in observed terminal order (the dispatch node's `children[]` output). */
  children: ChildTerminal[];
}

/**
 * Run a `fanOutPolicy: 'parallel'` wave: dispatch every `nextWorkerIds[i]` concurrently bounded by
 * the effective concurrency, fold the terminals in observed order via `foldJoin`, and emit the
 * `core.dispatch.fanOut`/`join` events. Pure coordination — the caller supplies how a child is
 * actually dispatched (`dispatchChild`), so the same logic serves the conformance seam and the
 * real executor path.
 */
export async function runParallelFanOut(args: {
  nextWorkerIds: readonly string[];
  config: DispatchFanOutConfig;
  dispatchChild: DispatchChild;
  events?: FanOutEvents;
  maxFanOut?: number;
}): Promise<FanOutOutput> {
  const { nextWorkerIds, config, dispatchChild, events } = args;
  const joinPolicy = config.joinPolicy ?? {};
  const joinMode: JoinMode = joinPolicy.mode ?? 'wait-all';
  const childCount = nextWorkerIds.length;
  const eff = effectiveConcurrency(config.maxConcurrency, args.maxFanOut ?? HOST_MAX_FAN_OUT);

  events?.fanOut?.({ fanOutPolicy: 'parallel', childCount, ...(Number.isFinite(eff) ? { maxConcurrency: eff } : {}), joinMode });

  // Bounded-concurrency dispatch: a queued child starts as each in-flight child terminates (the
  // host MUST NOT drop children above the ceiling). Terminals are collected in OBSERVED order.
  const terminals: ChildTerminal[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= nextWorkerIds.length) return;
      terminals.push(await dispatchChild(nextWorkerIds[i]!, i));
    }
  }
  const lanes = Math.max(1, Math.min(eff, nextWorkerIds.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));

  const join = foldJoin(terminals, joinPolicy);
  events?.join?.(join);
  return { ...join, children: terminals };
}

/** A registration-time cross-field validation error (RFC 0118 §registration MUSTs). */
export interface DispatchValidationError {
  code: 'validation_error';
  message: string;
}

/**
 * Cross-field MUSTs an honest host enforces at `POST /v1/workflows` for a `core.dispatch` config
 * (RFC 0118). Independent of fan-out support: `joinPolicy` is meaningful ONLY under `parallel`,
 * and `quorum` mode REQUIRES a `quorum` field. A host that does NOT advertise
 * `dispatch.fanOutSupported` additionally rejects `fanOutPolicy: 'parallel'` itself
 * (`fanOutSupported` arg = false). Returns null when the config is well-formed.
 */
export function validateDispatchFanOutConfig(
  config: DispatchFanOutConfig,
  fanOutSupported: boolean,
): DispatchValidationError | null {
  const parallel = config.fanOutPolicy === 'parallel';
  if (config.joinPolicy !== undefined && !parallel) {
    return { code: 'validation_error', message: "joinPolicy is meaningful only when fanOutPolicy is 'parallel'" };
  }
  if (parallel && !fanOutSupported) {
    return { code: 'validation_error', message: "fanOutPolicy 'parallel' requires capabilities.dispatch.fanOutSupported: true" };
  }
  if (parallel && config.joinPolicy?.mode === 'quorum') {
    const q = config.joinPolicy.quorum;
    if (q === undefined || !Number.isInteger(q) || q < 1) {
      return { code: 'validation_error', message: "joinPolicy.mode 'quorum' requires an integer quorum >= 1" };
    }
  }
  return null;
}

/** The `dispatch` capability family advertised at the `/.well-known/openwop` document root
 *  (RFC 0118 + RFC 0073 §document-root). Single source of truth for advertise/serve parity. */
export function dispatchCapability(): {
  supported: true;
  fanOutSupported: true;
  fanOutPolicies: readonly FanOutPolicy[];
  joinModes: readonly JoinMode[];
  onChildFailureModes: readonly OnChildFailure[];
  maxFanOut: number;
} {
  // HONESTY (advertise only what's behaviorally honored — capabilities.md, fails
  // OPENWOP_REQUIRE_BEHAVIOR otherwise): this host advertises ONLY `wait-all`. The
  // short-circuit modes (`quorum`/`first`/`race`) and `onChildFailure:'fail-fast'` require
  // cancelling in-flight children per the interrupt-profiles.md parent-child cascade, but
  // `executor/subWorkflowDispatcher.ts` ALWAYS awaits a child to terminal with no mid-run
  // cancel hook (ENG-9). `foldJoin` implements all four modes (ready for when child
  // cancellation lands); they are simply not advertised/accepted at registration yet.
  //
  // `onChildFailureModes` (RFC 0118 §seam amendment, openwop#789) gates the SECOND join axis
  // (`mode` × `onChildFailure`), mirroring `joinModes`. We advertise `['collect','absorb']`
  // because both are genuinely honored — neither short-circuits nor cancels losers, so neither
  // needs the cancellation the executor lacks; `fail-fast` is omitted (it would). Per the
  // amendment a host that does NOT advertise this descriptor MUST reject `fail-fast`/`absorb`
  // (absent ⇒ `['collect']`); advertising it makes our real divergence author-discoverable
  // rather than an undiscoverable registration footgun.
  return {
    supported: true,
    fanOutSupported: true,
    fanOutPolicies: ['sequential', 'reject', 'parallel'],
    joinModes: ['wait-all'],
    onChildFailureModes: ['collect', 'absorb'],
    maxFanOut: HOST_MAX_FAN_OUT,
  };
}
