/**
 * ADR 0531 — run-scoped effect context: the fail-closed backstop behind the
 * ADR 0341 replay side-effect guarantee.
 *
 * ADR 0341 stops a side-effecting node from FIRING during a replay fork by
 * classifying it (`executor/sideEffects.ts`) and serving the source run's
 * recorded outcome instead. That guard is an ALLOWLIST keyed on node typeId,
 * and #2871 proved allowlists drift: 55 chain nodes were retargeted onto a
 * typeId the list did not match, silently leaving protection while their
 * docblock claimed otherwise. Nothing failed — a replay would have re-notified.
 *
 * This module is the structural backstop. The executor establishes an ambient
 * context around EVERY node execution; each host effect seam calls
 * `assertEffectAllowed()` before doing the deed. A node that reaches an effect
 * during a replay WITHOUT having been classified now fails loudly instead of
 * quietly doing it twice.
 *
 * The two mechanisms are NOT redundant, and the difference is load-bearing:
 *
 *   - The typeId fast path SERVES the recorded outcome — the node never runs,
 *     and the replay reproduces the correct observable output.
 *   - This backstop can only THROW — it fires mid-execution, when there is no
 *     outcome left to serve.
 *
 * So a backstop firing is a BUG REPORT ("this typeId belongs in the fast
 * path"), not a steady state. It emits a counter to say so.
 *
 * ADR 0533 adds the OTHER half a peer can interrogate: the guard's allow branch
 * tallies escaped effects per run, and `GET /v1/host/sample/replay/effect-count`
 * reads that tally. `host-sample-test-seams.md` §20 requires the counter to sit
 * at the SAME seam as the guard — a counter elsewhere measures something the
 * guard does not protect — which is why it lives in this file rather than in
 * the route.
 *
 * Context is established on every node execution, live AND replay, so an
 * ABSENT context unambiguously means "not inside a run" (an HTTP route, a
 * daemon sweep) and is legitimately allowed. Were the context set only during
 * replays, "absent" would silently mean "not replaying" — the same fail-open
 * shape this module exists to remove. `test/run-effect-context.test.ts` pins
 * that the executor always establishes it.
 *
 * Deferred effects are safe by construction: the guard fires at ENQUEUE, which
 * happens inside the run's async context. The webhook/schedule workers that
 * deliver later run outside it, but the enqueue decision was already gated.
 *
 * LIMIT, stated because it is the tripwire for this whole design: AsyncLocalStorage
 * propagates through `await`, but NOT across a process/worker boundary. Pack
 * nodes execute in-process today (`packs/tarballLoader.ts` dynamic `import`), so
 * they inherit the context. If pack execution ever moves out-of-process (RFC 0035
 * sandbox execution, RFC 0008 WASM ABI), this backstop degrades SILENTLY to no
 * guard and the host side of that boundary must re-establish it.
 * `test/run-effect-context.test.ts` asserts the backstop fires for a
 * PACK-LOADED node specifically — that assertion is what would go red.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';
import { createLogger } from '../observability/logger.js';
import { recordEffectAllowed, recordEffectBlocked } from '../observability/metricSeams.js';
import { recordAuthorityAction } from './authorityContext.js';

const log = createLogger('replay.effectGuard');

/**
 * The kinds of external effect the host brokers. One per GUARDED seam — this
 * union is deliberately the exact set of seams that call the guard, so a
 * member with no call site is dead code, not aspiration.
 *
 * DELIBERATELY NOT GUARDED (ADR 0531 / ADR 0533 §Dispositions). Each of these
 * is a considered decision, not an omission; the reasons differ and matter:
 *
 *   - `host/obligationLedger.ts` `accrue()` — already replay-idempotent via a
 *     deterministic `rowKey` (first-write-wins). Deterministic keying is a
 *     STRONGER property than fail-closed: a replay re-accruing is a correct
 *     no-op today, and a guard would turn that into a throw. RFC 0140
 *     §"Implementation notes" says this in as many words.
 *   - `host/capabilityToken.ts` `mintToken()` — a pure generator, not an
 *     effect; the durable write lives in each calling feature. Its
 *     `randomBytes` minting IS non-deterministic under replay, but the residue
 *     is unused rows rather than an outward effect. Guarding the generator
 *     would be guarding the wrong function.
 *   - `providers/dispatch*.ts` (LLM, image, video, speech provider calls) —
 *     EXEMPT BY RULE, not by oversight. `replay.md` §"Side-effect suppression
 *     in replay" rule 4 requires LLM calls to re-execute live, served from the
 *     invocation log via the content-addressed secondary key that survives a
 *     fork (ADR 0326 P3a/b). Guarding them would fail-close the very nodes the
 *     spec requires to stay live, and would make RFC 0041 divergence detection
 *     vacuously green. `geminiFileApi.ts` rides the same exemption — its upload
 *     and delete are steps INSIDE one such provider call.
 *   - `routes/webhooks.ts` `deliverToSubscribers` — STILL not guarded here, but
 *     the reason narrowed on 2026-08-18 (H72). It fires from `eventLog.append`
 *     with no node to fail closed, and a guard would throw inside a swallowed
 *     best-effort subscriber (`eventLog.ts` catches and discards), suppressing
 *     silently rather than failing loudly — the fail-open shape this module
 *     exists to remove. Those grounds hold.
 *     What did NOT hold was the third ground this comment used to give — "a
 *     replay is a distinct run whose events are genuinely new". `replay.md`
 *     §"Host-initiated fan-out is an external effect" now forbids exactly that:
 *     outbound delivery MUST be suppressed for a replay fork's re-emitted
 *     events, unconditionally. So the suppression is real, it just lives at the
 *     BOUNDARY inside `deliverToSubscribers` (keyed on `run.forkMode`) instead
 *     of in this guard. See ADR 0533 § "Correction — 2026-08-18".
 */
export type EffectKind =
  | 'network-egress'
  | 'notification'
  | 'email'
  | 'payment'
  | 'dispatch'
  | 'blob-write';

export interface RunEffectContext {
  readonly runId: string;
  /** True when this execution is a replay/branch fork re-executing history. */
  readonly replaying: boolean;
  /**
   * ADR 0554 P2 — the effect kinds this node execution ACTUALLY put through the
   * guard's allow branch. The executor supplies a fresh set per node and reads
   * it back to classify the compensation obligation the node's RFC 0151 §B
   * declaration owes.
   *
   * Measured, not inferred. Classifying from the node's typeId would be a
   * second allowlist beside `executor/sideEffects.ts`, and #2871 is the record
   * of what those cost: 55 nodes drifted off one and nothing went red. The set
   * is filled at the SAME call the guard makes, so it cannot describe an effect
   * that did not happen or miss one that did.
   *
   * Absent for callers that do not care (every pre-existing call site).
   */
  readonly observedEffectKinds?: Set<EffectKind>;
  /**
   * ADR 0591 P2 — the remaining INPUTS to the RFC 0150 §B v2 logical effect
   * identity, so a durable per-identity escape row can be written at an async
   * effect seam.
   *
   * THESE ARE INPUTS, NOT AN IDENTITY, and the distinction is the whole design.
   * `host/effectIdentity.ts` is the single owner of the composition
   * (`tenantId ‖ runId ‖ nodeId ‖ logicalInvocationOrdinal ‖ providerKey`) and
   * says so. Carrying a precomputed key here would be a SECOND identity recipe
   * beside it — the exact failure that file exists to prevent, and a worse
   * version of the ADR 0554 drift, because two recipes disagree silently while
   * two copies of a field only go stale. So the context carries the raw fields
   * and the ledger calls the one owner.
   *
   * Optional because the guard is also reached from places that are not a node
   * execution (HTTP routes, daemon sweeps). Those have no logical identity and
   * belong to no run — the same rule `recordEffectEscape` already follows.
   */
  readonly nodeId?: string;
  readonly tenantId?: string;
  readonly attempt?: number;
}

const storage = new AsyncLocalStorage<RunEffectContext>();

/**
 * Establish the ambient context for one node execution. The executor wraps
 * `module.execute(ctx)` in this — see `executor/executor.ts`.
 */
export function runWithEffectContext<T>(ctx: RunEffectContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The current run's effect context, or `undefined` outside a node execution. */
export function currentEffectContext(): RunEffectContext | undefined {
  return storage.getStore();
}

/**
 * Thrown by `assertEffectAllowed`. A dedicated class rather than an
 * `OpenwopError` on purpose: this never travels as an HTTP error envelope. The
 * executor recognises it and converts it to a NODE FAILURE carrying
 * `error.code: 'replay_source_missing'` — the same code the ADR 0341 fast path
 * emits, so both halves of the invariant surface identically to the run event
 * log, the divergence machinery, and the conformance suite.
 *
 * The executor's catch deliberately allowlists which error classes may surface
 * their `.code` (rather than generalising to any `.code`, which would leak
 * internal codes like Node's `ENOENT` to the wire) — this class joins
 * `AiProviderError` and `McpError` on that list.
 */
export class ReplayEffectError extends Error {
  readonly code = 'replay_source_missing' as const;
  constructor(
    message: string,
    readonly effectKind: EffectKind,
  ) {
    super(message);
    this.name = 'ReplayEffectError';
  }
}

/**
 * Fail closed if this effect would fire during a replay.
 *
 * Called by each host effect seam BEFORE the effect. Outside a run (no ambient
 * context) this is a no-op — routes and daemons are not replays.
 *
 * @throws ReplayEffectError when a replay reaches an unclassified effect.
 */
export function assertEffectAllowed(effectKind: EffectKind, detail?: string): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  if (ctx.replaying) {
    // A replay reached a real effect. The node was not classified side-effecting
    // (or it would have been served its recorded outcome and never executed), so
    // this is a gap in `executor/sideEffects.ts` — log it as one.
    log.error('ADR 0531: a replay reached an unclassified effect seam — add this node to sideEffects.ts', {
      runId: ctx.runId,
      effectKind,
      ...(detail ? { detail } : {}),
    });
    // Also mark the ACTIVE NODE SPAN, so a firing is visible in the trace next to
    // the node that caused it — not only in a log line someone has to correlate.
    // `trace.getActiveSpan()` is the established idiom here (`observability/
    // llmSpans.ts`, `costEmitter.ts`); the executor's per-node span is active at
    // this point because the seam is called from inside `module.execute`.
    //
    // > CORRECTED (ADR 0556 P1). This said "NOT an OTel counter: this host
    // > wires traces + logs and has NO metrics pipeline … Until one exists, the
    // > alerting surface is the structured log". ADR 0556 P0 built that
    // > pipeline, and P1 emits the counter below. The LOG STAYS: it carries
    // > `runId` and `detail`, which are exactly the unbounded fields a metric
    // > label may never hold, so the two are complementary rather than
    // > redundant — the counter says an alert should fire, the log says which
    // > run to look at.
    trace.getActiveSpan()?.setAttribute('openwop.replay_effect_blocked', effectKind);
    // ADR 0556 P1 — and the counter this comment used to say could not exist.
    // A blocked effect is the one signal here an operator must be able to ALERT
    // on, and an alert on a log line is a text search over a different retention
    // model. It is a separate metric from the allow branch on purpose: any
    // non-zero value is actionable, so it must never be readable as a ratio.
    recordEffectBlocked(effectKind);
    throw new ReplayEffectError(
      `Replay fork: a '${effectKind}' effect was attempted during replay by a node with no recorded outcome${detail ? ` (${detail})` : ''}; a replay never fires a new side effect.`,
      effectKind,
    );
  }
  // ADR 0585 P0b — LAST GATE BEFORE THE EFFECT ESCAPES: does this process still
  // own the run? Placed here, after the replay branch and before every counter,
  // because this is the single synchronous chokepoint each effect seam calls,
  // and because an effect from a former owner must not be counted as an escape
  // of this run — the new owner's tallies are the real ones.
  //
  // Cheap by construction: a `Set.has` on a flag the HEARTBEAT wrote. The guard
  // stays synchronous, so no seam call site changes.
  if (hasLostDispatchLease(ctx.runId)) {
    log.error('ADR 0585 P0b: refusing an effect from an instance that lost the dispatch lease', {
      runId: ctx.runId,
      effectKind,
      ...(detail ? { detail } : {}),
    });
    trace.getActiveSpan()?.setAttribute('openwop.lease_lost_effect_blocked', effectKind);
    // Same counter as the replay block: from the operator's side both are "an
    // effect the host refused to let escape", and any non-zero value is
    // actionable. The log line carries which run.
    recordEffectBlocked(effectKind);
    throw new LeaseLostError(ctx.runId, effectKind);
  }
  // ADR 0533 — the effect is ALLOWED to proceed, so from here it escapes the
  // host. Count it against the run whose node performed it.
  recordEffectEscape(ctx.runId);
  // ADR 0554 P2 — and record WHAT kind, for the node's compensation obligation.
  // Same call, same branch: the classification can never describe an effect the
  // guard did not let through.
  ctx.observedEffectKinds?.add(effectKind);
  // ADR 0556 P1 — the same escape, aggregated. THREE consumers of one allow
  // branch, and none is derivable from the others: the per-run tally above is
  // keyed by `runId` (a forbidden metric label), the set above is per-NODE and
  // feeds one obligation, and this is the host-wide rate an operator alerts on.
  // They sit together on purpose — an effect counted by one and not the others
  // is a divergence no test would notice.
  recordEffectAllowed(effectKind);
  // ADR 0556 P3 / RFC 0154 §D — and WHO. The decision that "every outbox/A2A/
  // MCP/sandbox/compensation action records both actor and workload identities"
  // lands here for the effect seam, on the same allow branch as everything
  // above, for the same reason: a record attached anywhere else could describe
  // an effect the guard refused. Content-free (opaque ids, enums, a depth) and a
  // no-op when the run carries no workload identity — most do not, and
  // inventing one for them would make the record say something false.
  recordAuthorityAction('effect', 'allow');
}

/* ------------------------------------------------------------------------- *
 * ADR 0533 — the per-run effect counter (`host-sample-test-seams.md` §20)
 * ------------------------------------------------------------------------- */

/**
 * Per-run tally of effects that ESCAPED this host, read by
 * `GET /v1/host/sample/replay/effect-count?runId=…`.
 *
 * WHY IT LIVES IN THIS FILE, AND NOWHERE ELSE. `host-sample-test-seams.md` §20
 * requires the counter to sit at the SAME seam as the rule-5(b) default-deny
 * guard: "a counter placed anywhere else measures a different thing than the
 * guard protects, and a green scenario would prove nothing about the guard."
 * `assertEffectAllowed` IS that seam — every guarded egress/notification/email
 * chokepoint calls it — so the counter is a single `recordEffectEscape` call on
 * its allow branch. Adding a guarded seam therefore also adds it to the count;
 * the two can never drift apart, because there is only one call site for both.
 *
 * SEMANTICS, stated precisely because the scenario's non-vacuity depends on it:
 *
 *   - It counts an effect the guard ALLOWED THROUGH — i.e. one that actually
 *     left. §20's "counts effects attempted at the seam, not effects that
 *     succeeded upstream" is about the far end: a fired-then-failed outbound
 *     call still counts, "because the observable escape already happened". A
 *     guard-DENIED attempt is the opposite case — nothing escaped — so counting
 *     it would report an effect that provably did not occur, and would red the
 *     scenario against a host whose backstop worked exactly as specified.
 *   - It is monotonic non-decreasing per `runId` within the retention window
 *     below, and attributed to the run whose node performed the effect: a
 *     replayed run that WRONGLY fires increments the REPLAY's count, never the
 *     source's, because `ctx.runId` is the executing run's id.
 *   - Effects performed outside a node execution (HTTP routes, daemon sweeps)
 *     have no ambient context and are not counted — they belong to no run.
 *
 * The counter runs unconditionally (the env gate is on the READ route, not on
 * the bookkeeping) so the number the seam reports is the number production
 * behavior produced, never a test-mode approximation. Cost is one integer per
 * run, bounded below.
 */
const effectCounts = new Map<string, number>();

/**
 * Retention bound. `effectCounts` is process-local and would otherwise grow
 * once per run forever. Insertion-ordered eviction keeps the newest
 * `MAX_TRACKED_RUNS`; a run evicted after this many DISTINCT later runs reads
 * back as `0`, which is the one place monotonicity is not eternal. The
 * conformance scenario reads a run's count seconds after starting it, so it
 * never approaches the bound.
 */
const MAX_TRACKED_RUNS = 10_000;

/**
 * ADR 0585 P0b — runs this process has LOST THE DISPATCH LEASE for.
 *
 * ── WHY A PER-RUN MAP AND NOT A FIELD ON `RunEffectContext` ───────────────
 *
 * The obvious design is a flag on the ambient context. It does not work here,
 * for two structural reasons: `RunEffectContext` is entirely `readonly`, and
 * the executor builds a FRESH ONE PER NODE (`executor.ts`, inside
 * `runOneNode`). The heartbeat that learns of the loss runs in the SCHEDULING
 * LOOP, outside any node's AsyncLocalStorage scope — it has no handle on the
 * current context, and a flag written to one node's context would not survive
 * to the next.
 *
 * So the signal lives where `effectCounts` already lives: a process-local map
 * keyed by `runId`, written by the heartbeat and read synchronously by the
 * guard. Deliberately the same shape as its neighbour rather than a second
 * mechanism beside it — including the retention bound, which that map learned
 * the hard way and which this one would otherwise need to learn again.
 *
 * ── WHAT THIS IS AND IS NOT ───────────────────────────────────────────────
 *
 * NOT effect fencing. It cannot un-fire an effect already in flight, and a
 * CPU-throttled instance executes nothing at all — heartbeat included — so on
 * resume it continues mid-`module.execute` and can reach a seam before the next
 * renewal proves the loss. What it does is convert UNBOUNDED duplicate
 * execution into AT MOST the effects of the one node already in flight at
 * resume. RFC 0150 §D is the fix that makes the window zero.
 */
const lostLeaseRuns = new Set<string>();

/** Same bound, same reason, same eviction discipline as `effectCounts`. */
const MAX_TRACKED_LOST_LEASES = 10_000;

/**
 * Thrown at the effect chokepoint when this process no longer owns the run.
 *
 * A distinct type from `ReplayEffectError` because the dispositions differ:
 * a replay-effect is a CLASSIFICATION BUG in `sideEffects.ts` and the run
 * should fail loudly; a lost lease is CORRECT operation of the recovery path,
 * and the losing executor must abandon QUIETLY — writing no terminal state and
 * running no compensation, because the new owner owns both.
 */
export class LeaseLostError extends Error {
  constructor(readonly runId: string, readonly effectKind: EffectKind) {
    super(
      `Dispatch lease lost: run '${runId}' was reclaimed by another instance; ` +
      `refusing to let a '${effectKind}' effect escape from the former owner.`,
    );
    this.name = 'LeaseLostError';
  }
}

/** Record that this process lost `runId`. Called by the executor's heartbeat. */
export function markDispatchLeaseLost(runId: string): void {
  lostLeaseRuns.delete(runId);
  lostLeaseRuns.add(runId);
  while (lostLeaseRuns.size > MAX_TRACKED_LOST_LEASES) {
    const oldest = lostLeaseRuns.values().next();
    if (oldest.done) break;
    lostLeaseRuns.delete(oldest.value);
  }
}

/** Has this process lost `runId`? Synchronous by construction — the guard is. */
export function hasLostDispatchLease(runId: string): boolean {
  return lostLeaseRuns.has(runId);
}

/** Test seam only: forget every recorded loss. */
export function __resetLostDispatchLeasesForTest(): void {
  lostLeaseRuns.clear();
}

function recordEffectEscape(runId: string): void {
  const next = (effectCounts.get(runId) ?? 0) + 1;
  // Re-insert so eviction order tracks last-write, not first-write.
  effectCounts.delete(runId);
  effectCounts.set(runId, next);
  while (effectCounts.size > MAX_TRACKED_RUNS) {
    const oldest = effectCounts.keys().next();
    if (oldest.done) break;
    effectCounts.delete(oldest.value);
  }
}

/**
 * Effects that escaped during `runId`. `0` for a run that performed none AND
 * for an unknown run — the seam cannot distinguish them, and does not need to:
 * "no effect escaped" is the same answer either way.
 */
export function effectCountForRun(runId: string): number {
  return effectCounts.get(runId) ?? 0;
}

/** Test-only reset so suites do not inherit each other's tallies. */
export function __resetEffectCountsForTest(): void {
  effectCounts.clear();
}
