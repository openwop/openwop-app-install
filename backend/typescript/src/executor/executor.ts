/**
 * DAG-aware workflow executor.
 *
 * Builds a node-state snapshot from the WorkflowDefinition's nodes +
 * edges, then drains a ready-queue with bounded concurrency. Per-node
 * work (NodeRegistry dispatch, BYOK secret prep, OTel span, event log)
 * is unchanged from the legacy linear executor — only the *order* and
 * *parallelism* are new.
 *
 * Suspend semantics:
 *   - When any node returns `suspended`, that node's state is `suspended`;
 *     the run keeps draining other ready branches.
 *   - When no ready/running nodes remain AND at least one node is
 *     suspended, the run transitions to `waiting-*` (kind = first
 *     suspended node's interrupt kind).
 *
 * Resume semantics (see resumeRun in this module):
 *   - Resolver flips the suspended node to `completed` with the resolved
 *     value mapped onto its `outputs.input` port.
 *   - The scheduler re-enters and drains until the next terminal.
 *
 * Replay determinism: the Layer-2 invocation log (per spec/v1/replay.md)
 * keys outputs on (runId, nodeId, request-hash), so re-execution is
 * idempotent regardless of scheduler order. The canonical post-hoc
 * ordering is `event.sequence` — the executor's single-process event-log
 * writer serializes appends so concurrent completions get monotonic
 * sequence numbers. Multi-process hosts (e.g., Postgres) achieve the
 * same property via a storage-layer monotonic sequence.
 *
 * @see scheduler.ts for the trigger-rule + condition evaluation.
 */

import { runUnderWorkerContract } from '../storage/eventEraAdapter.js';
import { declaredRunCredentialRefs, runAiCredentialRef } from '../host/runCredentials.js';
import { trace, context as otelContext, SpanStatusCode } from '@opentelemetry/api';
import { normaliseEmitArgs } from './normaliseEmitArgs.js';
import { runOwner } from '../host/runOwner.js';
import { getNodeRegistry } from './nodeRegistry.js';
import { readCompactionDecision } from './compaction.js';
import { getEventLog, RunLogClosedError } from './eventLog.js';
import { getSuspendManager } from './suspendManager.js';
import { ensureForkInterrupts } from './forkInterrupts.js';
import { hasCapability } from './runtimeCapabilities.js';
import {
  evaluateModelCapabilityGate,
  buildInsufficientPayload,
  buildSubstitutedPayload,
} from './modelCapabilityGate.js';
import { getModelCapabilityGateConfig } from '../host/modelCapabilityGateConfig.js';
import {
  setRunSecrets,
  getRunSecrets,
  clearRunSecrets,
  stripSecretsFromPersisted,
  nonEnumerableSecretsView,
} from '../byok/ephemeralRunSecrets.js';
import { resolveSecret } from '../byok/secretResolver.js';
import { persistRunArtifact } from '../host/runArtifactStore.js';
import { sanitizeFreeTextDeep } from '../byok/textRedaction.js';
import { OpenwopError } from '../types.js';
import type { Storage } from '../storage/storage.js';
import type {
  EdgeDef,
  NodeContext,
  NodeOutcome,
  WorkflowDefinition,
} from './types.js';
import type { RunRecord } from '../types.js';
import type { ProviderPolicyResolver } from '../host/index.js';
import { createAiProvidersAdapter, AiProviderError, type AiProviderErrorCode } from '../aiProviders/aiProvidersHost.js';
import { createSandboxRunner } from '../host/sandboxAdapter.js';
import { classifyDispatchError } from '../observability/errorRecovery.js';
import { isSideEffectingNode, indexSourceOutcomes, type SourceNodeOutcome } from './sideEffects.js';
import {
  classifyRunTrigger,
  classifyWorkflowKind,
  recordNodeDuration,
  recordReplayServed,
  recordRunStarted,
} from '../observability/metricSeams.js';
import { runWithEffectContext, ReplayEffectError, LeaseLostError, markDispatchLeaseLost, hasLostDispatchLease, type EffectKind, type RunEffectContext } from '../host/runEffectContext.js';
import { isolationMode, resolveIsolationPlan } from '../host/packIsolationPolicy.js';
import { dispatchPackNodeIsolated } from '../host/packIsolationDispatch.js';
import { recordForwardObligation, unwindTerminatedRun } from '../host/compensationRuntime.js';
import { compensationTriggerFor, type TerminalCause, type CompensationTrigger } from '../host/compensationUnwind.js';
import { createLogger } from '../observability/logger.js';
import { buildHostSurfaceBundle, writeMemoryEntryRedacted, MEMORY_DEMO_REF } from '../host/inMemorySurfaces.js';
import { chainIdOfDefinition } from '../host/hostEventDispatcher.js';
import { getInstanceId } from '../host/instanceId.js';
import { makeConnectionSafeFetch } from '../host/connectionInjection.js';
import { makeSlackAdapter } from '../host/slackAdapter.js';
import { makeEmailAdapter } from '../host/emailAdapter.js';
import { makeSmsAdapter } from '../host/smsAdapter.js';
import { makeAdsAdapter } from '../host/adsAdapter.js';
import { makeNotificationAdapter } from '../host/notificationAdapter.js';
import { makeConnectorsAdapter } from '../host/connectorsAdapter.js';
import { makeMcpClient, McpError } from '../host/mcpClient.js';
import { runTraceContext } from '../host/traceContext.js';
import { armRunAbort, notifyRunTerminal, runAbortSignal, runPauseRequest, clearRunPause, noteInterruptedNode, type RunPauseRequest } from './runLifecycle.js';
// ADR 0553 P3 — the terminal-status predicate, taken from the PACKAGE rather
// than re-exported through `host/runCancel.ts`: the executor must not grow an
// import edge into `host/` for a pure predicate, and `runCancel` gets it from
// exactly here, so both halves of the cancel story read one definition.
import { isTerminalRunStatus } from '@openwop/openwop';
import { emitRunFailureNotification } from '../notifications/notify.js';
import { snapshotRunVariables, setRunVariable, hydrateRunVariables } from '../host/variablesRuntime.js';
import { stampRunCostOnTerminal } from '../observability/costEmitter.js';
import { foldWorkflowSpendOnTerminal } from '../host/workflowBudgets.js';
import { scoreOnlineEvalsOnTerminal } from '../host/workflowEvalOnline.js';
import { ensureMintedTemplatesRegistered } from '../host/promptStore.js';
import { interpolateRunInputs, hasInputTokens } from './runInputInterpolation.js';
import { resolveDeclaredInputs, buildNodeCtxInputs } from './nodeCtxInputs.js';

import { setRunAgent, hydrateRunAgent } from '../host/runAgentRuntime.js';
import { hydrateRunChannels } from '../host/channelsRuntime.js';
import { enforceManifestHandoffContract } from './handoffGate.js';
import { SuspendSignal, makeSuspendFn } from './suspendSignal.js';
import { CredentialGateError, nodeOAuthDeclarationOf, runCredentialGate } from '../host/credentialGate.js';
import { beginNodeActivity } from '../host/effectIdentity.js';
import {
  buildGraph,
  buildNodeInputs,
  freshSnapshot,
  inspectDisposition,
  markCompleted,
  markFailed,
  markSuspended,
  maxConcurrentNodes,
  popReady,
  releaseDownstream,
  type SchedulerGraph,
  type SchedulerSnapshot,
} from './scheduler.js';

const log = createLogger('executor');

export interface ExecuteRunResult {
  status: RunRecord['status'];
  /**
   * ADR 0740 — this call was a DUPLICATE DELIVERY of a run another execution
   * already holds (or of a run that is already final). It executed NOTHING and
   * wrote NOTHING — no event, no status, no lease. Like `abandonedLeaseLost`
   * below it is host-internal and deliberately not a wire `status`: the run is
   * fine; this DELIVERY was surplus. `status` is the run's recorded status.
   */
  duplicateDelivery?: true;
  /**
   * ADR 0585 P0b — this process ABANDONED the run because it lost the dispatch
   * lease. Internal to the executor's return; deliberately NOT a `status`,
   * because `RunRecord['status']` is the wire status and "the former owner
   * stopped" is not a state of the RUN — the new owner's run is still going.
   * Inventing a status for it would be a wire change for a host-internal fact.
   */
  abandonedLeaseLost?: true;
  /** Set of node ids that were suspended when the run paused. Replaces the
   *  legacy `pausedAtIndex` field; for purely linear back-compat callers,
   *  pausedAtIndex is also surfaced when exactly one node is suspended. */
  pausedNodeIds?: string[];
  /** Back-compat: index of the suspended node in `definition.nodes`. Only
   *  set for linear (no-edges or implicit-linear) workflows with exactly
   *  one suspended node. */
  pausedAtIndex?: number;
}

/**
 * Emit the canonical terminal-failure event sequence: `node.failed`
 * (when a node was active) → `run.failed` → update run record.
 */
/** RFC 0058 — host wall-clock ceiling per run, in milliseconds. Used as the
 *  upper bound when resolving `RunOptions.configurable.runTimeoutMs` below.
 *
 *  THE SINGLE SOURCE for `capabilities.limits.maxRunDurationMs`:
 *  `routes/discovery.ts` IMPORTS this constant (H97). It used to hold its own
 *  `600_000` literal, and this docblock used to say the two "MUST equal" each
 *  other — an invariant asserted by comments in both files and enforced by
 *  nothing. A reader who checked was told the check existed.
 *
 *  Also the base of `RUN_DISPATCH_LEASE_MS` (this + 120s), so the crashed-
 *  executor recovery SLO derives from it as well. Changing this number changes
 *  a wire claim AND an operational SLO; both now follow automatically. */
export const RUN_DURATION_CEILING_MS = 600_000;

/**
 * Has the wall-clock bound been BREACHED at `nowMs`? (RFC 0058)
 *
 * STRICTLY GREATER, and the strictness is the whole point. `capabilities.md`
 * §"Engine-enforced limits" requires the emitted `cap.breached` payload's
 * `observed` to be "always strictly greater than `limit`" — a limit is not
 * breached until it has been PASSED, not when it is reached.
 *
 * This read `>=` until 2026-08-14. On the tick where the clock landed exactly on
 * the deadline, the breach fired with `observed === limit` and the run-execution
 * bounds conformance scenario reported a true non-conformance. Rare and
 * machine-dependent, so it presented as a flake — I twice attributed it to a
 * loaded machine, and the load hypothesis is backwards: load makes `elapsed`
 * LARGER, which makes `observed > limit` MORE likely to hold, not less. The
 * openwop-conformance steward caught the inverted reasoning and named `>=` as
 * the cause without being able to see this line.
 *
 * The sibling cap gets this right and is the reason the slip is legible as a
 * slip: `nodeExecutionCount + 1 > recursionLimit` is strict, so its `observed`
 * always exceeds its `limit`.
 *
 * A named predicate rather than an inline comparison so the rule is stateable
 * and can be tested at the boundary — the failing value is one specific
 * millisecond, which is exactly the case an integration test will not reliably
 * hit.
 */
export function isRunDurationBreached(nowMs: number, deadlineAtMs: number): boolean {
  return nowMs > deadlineAtMs;
}

/** Dispatch-lease duration (ms) stamped on a run at execution start. Exceeds the
 *  run-duration ceiling by a buffer so a legitimately long-running run is never
 *  swept; only a crashed instance's run (lease expired past this) is re-claimed. */
export const RUN_DISPATCH_LEASE_MS = RUN_DURATION_CEILING_MS + 120_000;

/**
 * How often a live executor RENEWS its dispatch lease while a run is active
 * (ADR 0585 P0).
 *
 * ── WHAT THIS FIXES, and what it deliberately does not ────────────────────
 *
 * Before this, `setRunDispatchLease` had exactly ONE call site — at dispatch —
 * and was never renewed. So the lease was not a liveness signal at all: it
 * answered *"could this run still legitimately be running?"*, never *"is the
 * worker alive?"* That is why it has to be at least as long as the longest legal
 * run, and why a crashed instance's runs are untouchable for 12 minutes.
 *
 * ADR 0585 separates the two questions: the heartbeat answers liveness in
 * seconds, and the advertised `maxRunDurationMs` ceiling keeps answering
 * legitimacy in minutes.
 *
 * **P0 IS PURELY ADDITIVE, and that is what makes it safe to ship alone.** A
 * renewal writes `Date.now() + RUN_DISPATCH_LEASE_MS`, and `Date.now()` only
 * increases, so a renewed expiry is always >= the one it replaces. No run can be
 * reclaimed EARLIER than it is today. P0 buys no recovery speed by itself; it
 * makes P1's shorter reclaim threshold safe, which is the whole point of the
 * ordering. **P1 without P0 is the dangerous direction** — a shorter lease with
 * no renewal declares LIVE long-running runs dead and re-dispatches them, and
 * this host has no effect fencing (`idempotency.crossRegion: single-region`),
 * so the duplicate would be a second refund.
 *
 * ── WHY 30s ───────────────────────────────────────────────────────────────
 *
 * ADR 0585 P1 proposes a reclaim threshold of 5x the heartbeat, targeting ~2.5
 * minutes instead of 12. That fixes this at 30s. It is also a deliberately
 * generous multiple rather than a tight one: the accepted trade-off is that a
 * blocked event loop can delay a renewal and make a live worker look dead, and
 * a tight multiple would make that likely rather than rare.
 */
export const RUN_LEASE_HEARTBEAT_MS = 30_000;

/**
 * Is a lease renewal due at `nowMs`?
 *
 * Extracted as a pure predicate for the reason the H92 window arm and
 * `compensationTriggerFor` were: **the clock is untestable here, the DECISION is
 * not.** A test cannot run a real run past a 12-minute lease, so without this
 * seam the claim "the lease is renewed while the run is alive" would rest on
 * reading the call site — and would stop being true the first time someone
 * reordered an argument, with nothing going red.
 */
export function isLeaseRenewalDue(
  nowMs: number,
  lastRenewedAtMs: number,
  heartbeatMs: number = RUN_LEASE_HEARTBEAT_MS,
): boolean {
  return nowMs - lastRenewedAtMs >= heartbeatMs;
}

export async function emitTerminalFailure(input: {
  storage: Storage;
  runId: string;
  nodeId?: string;
  error: { code: string; message: string };
  /** RFC 0053 — total attempts made before the run died. Absent ⇒ 1 (the node
   *  declared no `config.retry`, so its single attempt was its last). */
  attempts?: number;
  /** RFC 0053 — the node to ATTRIBUTE the dead-letter to, without re-appending
   *  a `node.failed` for it. Distinct from `nodeId` on purpose: by the time
   *  `finalizeRun` dead-letters a drained run, that node already emitted its
   *  own `node.failed`, and reusing `nodeId` here would duplicate it. */
  deadLetterNodeId?: string;
  /** H102 — why the compensation unwind did not complete, when it threw. The
   *  terminal event is emitted REGARDLESS (an unwind failure must not consume
   *  it), so this is how the failure stays visible instead of vanishing with the
   *  exception. Additive on `_errorObject` (`additionalProperties: true`). */
  compensationError?: string;
}): Promise<void> {
  const eventLog = getEventLog();
  // Enrich the canonical {code, message} pair with the BE's recovery
  // classifier output so consumers (e.g., the sample chat UI's
  // ErrorCard) can render a user-safe `userMessage` + a recommended
  // `action` without re-classifying on the FE. Additive per
  // `_errorObject` schema (`additionalProperties: true`); old consumers
  // ignore the new fields. See `observability/errorRecovery.ts` for the
  // classifier authoritative source.
  const classified = classifyDispatchError(
    new AiProviderError(input.error.code as AiProviderErrorCode, input.error.message),
  );
  const enrichedError = {
    ...input.error,
    category: classified.category,
    action: classified.action,
    userMessage: classified.userMessage,
    ...(classified.retryAfterMs !== undefined ? { retryAfterMs: classified.retryAfterMs } : {}),
    ...(input.compensationError !== undefined ? { compensationError: input.compensationError } : {}),
  };
  const errorPayload = stripSecretsFromPersisted({ error: enrichedError });
  if (input.nodeId) {
    await eventLog.append({
      runId: input.runId,
      nodeId: input.nodeId,
      type: 'node.failed',
      // `run-event-payloads.schema.json` §nodeFailed REQUIRES `nodeId` in the
      // PAYLOAD, not merely on the envelope. Emitting it only on the envelope
      // left every `node.failed` payload schema-invalid, and a consumer reading
      // payloads (the RFC 0140 conformance scenario is one) cannot attribute the
      // failure to a node at all. Additive: the envelope field is unchanged.
      payload: { ...errorPayload, nodeId: input.nodeId },
    });
  }
  // RFC 0053 — the run-level dead-letter sink. This is the single terminal
  // choke (finalizeRun's failed branch delegates here too), so every
  // terminally-failed run lands in the sink exactly once.
  //
  // ORDERING: this MUST be appended BEFORE `run.failed`. `observability.md`
  // §"Terminal events" requires the terminal event to be the LAST event in the
  // stream (pinned by `eventOrdering.test.ts` + the streamReconnect
  // post-terminal probe) — the same constraint that forces the RFC 0004
  // memory write to precede `run.completed` in finalizeRun.
  //
  // Emitted for EVERY terminal failure, not only retry-exhausted nodes: the
  // RFC ties dead-lettering to terminal status ("the run's terminal
  // RunSnapshot.status reflects failure") and the sink's purpose is that a
  // poisoned run be inspectable and re-forkable. Restricting it to nodes that
  // happened to declare `config.retry` would miss most real failures and make
  // the capability near-useless. `attempts` reports the truth — 1 when no
  // retry was configured.
  //
  // `reason` is the CLASSIFIED user message, never `error.message`: RFC 0053
  // §C requires a redaction-safe reason, and the raw provider string
  // occasionally echoes BYOK key material (the same hazard that made the
  // failure NOTIFICATION below use the classified text).
  await eventLog.append({
    runId: input.runId,
    type: 'run.dead_lettered',
    payload: {
      runId: input.runId,
      ...(input.deadLetterNodeId ?? input.nodeId
        ? { nodeId: input.deadLetterNodeId ?? input.nodeId }
        : {}),
      reason: classified.userMessage,
      attempts: input.attempts ?? 1,
    },
  });
  await eventLog.append({
    runId: input.runId,
    type: 'run.failed',
    payload: errorPayload,
  });
  await input.storage.updateRun(input.runId, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: input.error,
    // ADR 0476 (review H1) — when the failure names a node, the run row's
    // currentNodeId must be THAT node (hotspots + diagnosis read it).
    ...(input.nodeId ? { currentNodeId: input.nodeId } : {}),
  });
  // ADR 0476 §1 — durable cost stamp at the terminal seam (best-effort).
  // ADR 0482 §2 — the spend-day fold consumes the SAME usd the stamp computed
  // (fire-and-forget; ALL terminal spend counts — the costDaily doctrine).
  const failedSpendUsd = await stampRunCostOnTerminal(input.storage, input.runId);
  void foldWorkflowSpendOnTerminal(input.storage, input.runId, failedSpendUsd);
  // ADR 0480 — online eval scoring (fire-and-forget; production runs only).
  void scoreOnlineEvalsOnTerminal(input.storage, input.runId);
  clearRunSecrets(input.runId);
  notifyRunTerminal(input.runId, 'failed');
  // Fan out a user-visible notification so the bell + /inbox surface
  // the failure without polling. Best-effort — emit failures don't
  // affect the canonical run.failed event log entry. Pass the
  // **classified** userMessage (not raw error.message) so that
  // provider-side strings that occasionally echo BYOK keys never land
  // in the notification message field.
  void emitRunFailureNotification(input.storage, input.runId, {
    code: input.error.code,
    userMessage: classified.userMessage,
  });
}

/**
 * ADR 0554 P2 — the ROOT of a run's sub-run tree.
 *
 * Walks `parentRunId` upward, stopping at a FORK. A fork's `parentRunId` points
 * at the run it forked FROM, which is a different tree entirely: treating it as
 * an ancestor would put the fork's obligations in the source's plan and unwind
 * a run nobody asked about. Bounded, because `dispatchSubWorkflow` already
 * refuses to create a cycle in the persisted ancestor chain, and the loop caps
 * anyway rather than trusting that from here.
 */
async function resolveCompensationRoot(storage: Storage, run: RunRecord): Promise<string> {
  if (run.forkMode !== undefined || typeof run.parentRunId !== 'string') return run.runId;
  let cursor: RunRecord | null = run;
  for (let depth = 0; depth < 32; depth++) {
    const parentId: string | undefined = cursor?.parentRunId;
    if (cursor?.forkMode !== undefined || typeof parentId !== 'string') break;
    const parent: RunRecord | null = await storage.getRun(parentId);
    if (!parent) break;
    cursor = parent;
  }
  return cursor?.runId ?? run.runId;
}

/**
 * Normalize a definition to always have `edges`. Legacy callers that pass
 * `nodes` without `edges` get an implicit linear chain so the scheduler
 * walks them in array order.
 */
function withImplicitEdges(definition: WorkflowDefinition): WorkflowDefinition {
  if (definition.edges && definition.edges.length > 0) return definition;
  // Implicit linear edges for back-compat.
  const linearEdges: EdgeDef[] = [];
  for (let i = 0; i + 1 < definition.nodes.length; i++) {
    const src = definition.nodes[i]!;
    const tgt = definition.nodes[i + 1]!;
    linearEdges.push({
      edgeId: `implicit_${i}`,
      sourceNodeId: src.nodeId,
      targetNodeId: tgt.nodeId,
    });
  }
  return { ...definition, edges: linearEdges };
}

/**
 * Run a single node: resolve module, build ctx, dispatch, emit events.
 * Returns the outcome plus a `'caller-handle-terminal'` discriminator
 * so the scheduler knows whether to mark failed / suspended.
 */
/** CS-WF-3 (ADR 0326) — the node's opted-in retry ceiling. `config.retry.maxAttempts`
 *  (integer ≥ 2, capped at 5); anything else ⇒ 1 (no retry — today's behavior). */
function nodeRetryMaxAttempts(nodeRef: { config?: Record<string, unknown> }): number {
  const r = nodeRef.config?.['retry'];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 1;
  const max = (r as { maxAttempts?: unknown }).maxAttempts;
  return typeof max === 'number' && Number.isInteger(max) && max >= 2 ? Math.min(max, 5) : 1;
}
/** Failure classes retrying cannot fix — semantic refusals + author errors. */
const NON_RETRYABLE_NODE_ERRORS: ReadonlySet<string> = new Set([
  'envelope_refusal', 'validation_error', 'capability_unsupported', 'workflow_invalid', 'recursion_limit_exceeded',
  // ADR 0655 D2 — egress REFUSALS are semantic: a `config.retry` node makes exactly one
  // attempt. Timeouts / request failures / in-flight stay retryable by omission.
  'email_recipient_suppressed', 'email_recipient_erased', 'email_recipient_no_consent',
  'email_provider_unsupported', 'email_egress_guard_missing',
]);
const RETRY_BACKOFF_BASE_MS = 250;
const RETRY_BACKOFF_CAP_MS = 2000;

async function runOneNode(input: {
  storage: Storage;
  run: RunRecord;
  nodeRef: { nodeId: string; typeId: string; config?: Record<string, unknown>; inputs?: Record<string, unknown>; agent?: { agentId: string } };
  inputsByPort: Record<string, unknown>;
  /** ADR 0326 P3a — the node-level attempt (1-based; >1 on a config.retry
   *  re-run). Keys the invocation-log cache per attempt, rides the node ctx
   *  (the OTel span derives node_attempt from it), and is DISTINCT from
   *  dispatchStructured's internal parse-retry loop (those share one node
   *  attempt + one cache key, as before). */
  attempt?: number;
  /** ADR 0326 P3b — replay fork: read the source run's invocation log on
   *  misses (see AdapterScope.replayInvocationsFromRunId). */
  replayInvocationsFromRunId?: string;
  /** ADR 0617 D1a (review BLOCKER-1) — the chain the run's definition was
   *  expanded from, computed ONCE per run body from `definition.metadata` and
   *  threaded onto the surface bundle as `BundleScope.chainId`. */
  chainId?: string;
  /** ADR 0341 — replay fork: the source run's terminal outcomes by nodeId
   *  (ordered per attempt). A side-effecting node reproduces its recorded
   *  outcome instead of executing live; absent record ⇒ fail closed. */
  sourceOutcomes?: Map<string, SourceNodeOutcome[]>;
  policyResolver?: ProviderPolicyResolver;
  /** On a re-invoke resume (interrupt.md §"key field"), the resolution seeded for
   *  this node so `ctx.suspend`/`ctx.interrupt` returns it instead of suspending. */
  suspendResolution?: { resumeKey: string; value: unknown };
}): Promise<
  | {
      kind: 'success';
      outputs: Record<string, unknown>;
      /** ADR 0554 P2 — the effect kinds this execution actually put through the
       *  ADR 0531 guard, measured at the guard itself. Empty when the node made
       *  no guarded effect (including every replay-served outcome). */
      observedEffectKinds: ReadonlySet<EffectKind>;
    }
  | { kind: 'failure'; error: { code: string; message: string } }
  // ADR 0632 — the attempt was aborted by an `immediate` pause: not a failure,
  // no `node.failed` in the log (it would be a false history AND replay poison —
  // a replay fork folds `node.failed` at face value and dead-letters the child).
  | { kind: 'interrupted' }
  | {
      kind: 'suspended';
      interrupt: NonNullable<Extract<NodeOutcome, { status: 'suspended' }>['interrupt']>;
    }
> {
  const tracer = trace.getTracer('openwop.workflow-engine-sample');
  const registry = getNodeRegistry();
  const eventLog = getEventLog();

  const { storage, run, nodeRef, inputsByPort, policyResolver } = input;
  // ADR 0554 P2 — filled by `assertEffectAllowed`'s allow branch during this
  // node's execution, so the compensation obligation is classified by what the
  // node DID rather than by a second typeId allowlist beside sideEffects.ts.
  const observedEffectKinds = new Set<EffectKind>();
  const module = await registry.resolve(nodeRef.typeId);
  if (!module) {
    const error = { code: 'workflow_not_found', message: `node module not registered: ${nodeRef.typeId}` };
    await eventLog.append({
      runId: run.runId,
      nodeId: nodeRef.nodeId,
      type: 'node.failed',
      payload: stripSecretsFromPersisted({ nodeId: nodeRef.nodeId, error }),
    });
    return { kind: 'failure', error };
  }

  // Capability gating per spec/v1/host-capabilities.md §"Refuse on missing".
  // Error code per `rest-endpoints.md §"Common error codes"` +
  // `capabilities.md §"Runtime capabilities"`: a node with unsatisfied
  // requires MUST terminate the run with `error.code: 'capability_not_provided'`
  // (the canonical code). Earlier this file used `host_capability_missing`;
  // that's the legacy alias still in OpenwopErrorCode for back-compat.
  if (module.requires) {
    for (const cap of module.requires) {
      if (!hasCapability(cap)) {
        const error = {
          code: 'capability_not_provided',
          message: `capability ${cap} not provided by host`,
        };
        await eventLog.append({
          runId: run.runId,
          nodeId: nodeRef.nodeId,
          type: 'node.failed',
          payload: stripSecretsFromPersisted({ nodeId: nodeRef.nodeId, error }),
        });
        return { kind: 'failure', error };
      }
    }
  }

  // RFC 0031 §B model-capability dispatch gate. Parallel surface to the
  // host-capability `requires` check above — `requires` gates on host
  // facilities (per `capabilities.runtimeCapabilities[]`); this gate gates
  // on MODEL capabilities (per `capabilities.modelCapabilities.advertised[]`).
  // Evaluated at execute-time against the host's configured default
  // provider; per-call provider mismatch (a node that calls
  // `ctx.callAI({provider: 'openai', ...})` from a host where the default
  // is 'anthropic') is a future refinement requiring `dispatchPlain()`
  // interception. The best-effort gate is honest about its scope:
  // `substitutionSupported: false` by default, so the gate refuses on
  // any unmet capability rather than attempting fallback. Operators that
  // wire the interception flip OPENWOP_MODEL_CAPABILITY_SUBSTITUTION=true.
  // Empty `requiredModelCapabilities` (the common case for non-AI nodes)
  // makes the gate a no-op via the early-return inside evaluateModelCapabilityGate.
  if (module.requiredModelCapabilities && module.requiredModelCapabilities.length > 0) {
    const gateConfig = getModelCapabilityGateConfig();
    const gateInput: Parameters<typeof evaluateModelCapabilityGate>[0] = {
      module: {
        ...(module.requiredModelCapabilities !== undefined ? { requiredModelCapabilities: module.requiredModelCapabilities } : {}),
        ...(module.fallbackModel !== undefined ? { fallbackModel: module.fallbackModel } : {}),
      },
      // AI-GATE-1 — evaluate against the NODE's pinned provider/model when it has
      // one, falling back to the host default. Previously this always used the
      // host-wide default, so a node declaring `requiredModelCapabilities` was
      // checked against a provider it does not use — the declaration looked like a
      // guard and protected nothing. `nodeRef.config` was already in scope; it was
      // simply never read.
      //
      // A chain freezes `provider`/`model` into node config at expansion (ADR 0498),
      // which is exactly the value dispatch will use, so this is the honest input.
      // Non-string/absent ⇒ host default, so non-chain nodes are unaffected.
      activeProvider: typeof nodeRef.config?.provider === 'string' && nodeRef.config.provider
        ? nodeRef.config.provider
        : gateConfig.defaultProvider,
      activeModel: typeof nodeRef.config?.model === 'string' && nodeRef.config.model
        ? nodeRef.config.model
        : gateConfig.defaultModel,
      substitutionSupported: gateConfig.substitutionSupported,
      supportedProviders: gateConfig.supportedProviders,
    };
    const outcome = evaluateModelCapabilityGate(gateInput);
    if (outcome.route === 'substitute') {
      // Emit the substitution event per RFC 0031 §D + §B step 3. The
      // sample's dispatch path does NOT yet honor the fallback at the
      // per-call boundary (operators set OPENWOP_MODEL_CAPABILITY_SUBSTITUTION
      // = true only when they've wired the interception). The event
      // emission is the wire-contract surface; downstream consumers
      // (conformance, replay, observability) read the durable event log
      // regardless of whether the dispatcher physically swapped models.
      await eventLog.append({
        runId: run.runId,
        nodeId: nodeRef.nodeId,
        type: 'model.capability.substituted',
        payload: stripSecretsFromPersisted(buildSubstitutedPayload(outcome, nodeRef.nodeId)),
      });
      // Dispatch proceeds — the node's execute() runs normally.
    } else if (outcome.route === 'refuse') {
      // Emit the insufficient event per RFC 0031 §D + §B step 4 BEFORE
      // failing the node so observability sees the cause-of-refusal
      // ahead of the node.failed event.
      await eventLog.append({
        runId: run.runId,
        nodeId: nodeRef.nodeId,
        type: 'model.capability.insufficient',
        payload: stripSecretsFromPersisted(
          buildInsufficientPayload(outcome, nodeRef.nodeId, gateConfig.defaultProvider, gateConfig.defaultModel),
        ),
      });
      const error = {
        code: 'capability_not_provided',
        message: `model capabilities not satisfied by active provider (${gateConfig.defaultProvider}): missing ${outcome.missingCapabilities.join(', ')}`,
      };
      await eventLog.append({
        runId: run.runId,
        nodeId: nodeRef.nodeId,
        type: 'node.failed',
        payload: stripSecretsFromPersisted({ nodeId: nodeRef.nodeId, error }),
      });
      return { kind: 'failure', error };
    }
    // outcome.route === 'dispatch' — gate satisfied; fall through.
  }

  await storage.updateRun(run.runId, { currentNodeId: nodeRef.nodeId });
  // `run-event-payloads.schema.json` `$defs/nodeStarted` requires `typeId`, and
  // unlike `nodeId` it has NO envelope carrier — `EventRecord` is
  // {eventId, runId, type, nodeId, payload, timestamp, causationId}. Omitting it
  // left a consumer no way to learn WHICH node type ran except by joining back to
  // the workflow definition, which the run outlives: a definition can be edited or
  // archived while the event log stays fixed history. Additive (REP-1); replay
  // compares `type@nodeId`, never payloads, so a new field cannot diverge a fork.
  await eventLog.append({
    runId: run.runId,
    nodeId: nodeRef.nodeId,
    type: 'node.started',
    payload: { nodeId: nodeRef.nodeId, typeId: nodeRef.typeId },
  });

  const rawSecrets = getRunSecrets(run.runId);
  const secretsForCtx = nonEnumerableSecretsView(rawSecrets);
  const aiAdapter = policyResolver
    ? createAiProvidersAdapter({
        runId: run.runId,
        nodeId: nodeRef.nodeId,
        tenantId: run.tenantId,
        // ADR 0396 P4 — thread the run's acting human so the per-user
        // reasoning-directive override can apply (absent for system runs).
        ...(typeof (run.metadata as Record<string, unknown> | undefined)?.actingUserId === 'string'
          ? { actingUserId: String((run.metadata as Record<string, unknown>).actingUserId) }
          : {}),
        ...(run.scopeId ? { scopeId: run.scopeId } : {}),
        attempt: input.attempt ?? 1, // ADR 0326 P3a — per-attempt invocation-log keys
        ...(input.replayInvocationsFromRunId ? { replayInvocationsFromRunId: input.replayInvocationsFromRunId } : {}),
        secrets: rawSecrets,
        // ADR 0712 — the run-level credential rung of the ladder.
        ...(runAiCredentialRef(run.configurable) ? { runCredentialRef: runAiCredentialRef(run.configurable) } : {}),
        policyResolver,
        // RFC 0026 — let the host emit `provider.usage` into the run
        // event log right after each upstream LLM dispatch. Keeps the
        // event correlated with the same nodeId / runId that brackets
        // it with `node.started` / `node.completed`.
        emit: async (type, payload) => {
          const record = await eventLog.append({
            runId: run.runId,
            nodeId: nodeRef.nodeId,
            type,
            payload: stripSecretsFromPersisted(payload),
          });
          return { eventId: record.eventId, sequence: record.sequence };
        },
      })
    : null;
  // ADR 0114 Phase 2 — undefined unless OPENWOP_CODE_EXEC_ENDPOINT is configured.
  const sandboxRunner = createSandboxRunner(run.tenantId); // ADR 0114 Phase 5 — tenant-bound for the exec budget
  const bundleActingUserId = typeof (run.metadata as Record<string, unknown> | undefined)?.actingUserId === 'string'
    ? String((run.metadata as Record<string, unknown>).actingUserId)
    : undefined;
  // RFC 0207 — the W3C trace context the run was CREATED under, stamped on the
  // run row by the creating request (`routes/runs.ts`, a reserved metadata
  // key). Threaded onto the surface bundle, onto `ctx`, and into the MCP client
  // so every outbound MCP request and A2A message this node makes continues the
  // caller's trace. Correlation only; never authority.
  const runTrace = runTraceContext(run.metadata as Record<string, unknown> | undefined);
  const surfaces = buildHostSurfaceBundle({
    tenantId: run.tenantId,
    ...(run.scopeId ? { scopeId: run.scopeId } : {}),
    runId: run.runId,
    ...(runTrace ? { traceContext: runTrace } : {}),
    // ADR 0617 D1a — the run's workflow, so a surface-emitted host event can
    // carry `origin.workflowId` and never re-trigger the workflow executing it;
    // and its chain lineage, so it never triggers a SIBLING instance of the same
    // chain either (review BLOCKER-1 — one from-chain instance per param set).
    workflowId: run.workflowId,
    ...(input.chainId ? { chainId: input.chainId } : {}),
    // ADR 0205 CMSGAP-1 — the run owner's durable principal (same source as
    // ctx.actingUserId, ADR 0024 §4; absent for system runs — the fail-closed
    // signal), so member-scoped narrowing filters (CMS translator grants)
    // apply to feature-surface writes exactly as on the HTTP editor path.
    ...(bundleActingUserId ? { actingUserId: bundleActingUserId } : {}),
  });

  // Fixture-shape input resolution. When the workflow definition's
  // `nodes[i].inputs[port]` carries a reference shape (e.g.,
  // `{type: 'variable', variableName: 'X'}`), resolve against the
  // run's variable bag before merging into inputsByPort. Literal
  // values (non-objects, or objects without a `type` discriminator)
  // pass through unchanged. Resolved per-port values override edge-
  // supplied keys on conflict — the fixture-declared input wins.
  const variableBag = snapshotRunVariables(run.runId);
  // ADR 0597 §Correction 9 — this resolution + unwrap + merge used to be written
  // out here, and `test/strategy-chain-execution.test.ts` carried a hand-written
  // MIRROR of half of it. A test double that models the executor is a second
  // implementation of the executor: it drifts, and nothing runs both. The rule
  // now lives in ONE module that the harness imports.
  const resolvedFixtureInputs = resolveDeclaredInputs(nodeRef.inputs, variableBag);
  const ctxInputs: unknown = buildNodeCtxInputs(inputsByPort, resolvedFixtureInputs);

  // ADR 0024 §4 — the run's acting human + the providers it consented to use.
  const runMeta = (run.metadata ?? {}) as Record<string, unknown>;
  const actingUserId = typeof runMeta.actingUserId === 'string' ? runMeta.actingUserId : undefined;
  const runCfg = (run.configurable ?? {}) as Record<string, unknown>;
  const connectionProviders: string[] = Array.isArray(runCfg.connections)
    ? (runCfg.connections as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];

  // Multi-Agent Shift Phase 1 — rotate `RunSnapshot.agent` to the active
  // worker: a node carrying an authoring-time `agent` pin stamps its
  // AgentRef (verbatim, provenance fields included) onto the run-level
  // projection that `GET /v1/runs/{runId}` serves.
  if (nodeRef.agent && typeof nodeRef.agent.agentId === 'string' && nodeRef.agent.agentId.length > 0) {
    setRunAgent(run.runId, nodeRef.agent);
  }

  // ADR 0553 P2 — bound once so the MCP client's MRTR elicitation resolver and
  // `ctx.suspend` are the SAME primitive: an MRTR ask must be an ordinary
  // interrupt on this node, subject to the same resume, timeout and replay
  // rules, not a second pausing mechanism the run does not know about.
  const suspendFn = makeSuspendFn(nodeRef.nodeId, input.suspendResolution);
  const ctx: NodeContext = {
    // ADR 0632 — surface the run abort signal on the node ctx itself (until now
    // it reached only the MCP client deps below), so `core.delay` and friends can
    // stop on an `immediate` pause instead of sleeping the request out.
    ...(runAbortSignal(run.runId) ? { signal: runAbortSignal(run.runId)! } : {}),
    runId: run.runId,
    nodeId: nodeRef.nodeId,
    tenantId: run.tenantId,
    scopeId: run.scopeId,
    ...(runTrace ? { traceContext: runTrace } : {}),
    inputs: ctxInputs,
    // Resolve `{{inputs.NAME}}` tokens in config from the per-run variable bag
    // (reusable templates — the value arrives per run, not frozen at instantiate).
    // Only rebuild config when a token is actually present (the common case has
    // none — avoid deep-cloning every node's config on every run).
    config: hasInputTokens(nodeRef.config)
      ? interpolateRunInputs(nodeRef.config ?? {}, variableBag)
      : (nodeRef.config ?? {}),
    ...(nodeRef.agent ? { nodeAgent: nodeRef.agent } : {}),
    configurable: run.configurable ?? {},
    // RFC trigger pack (`core.openwop.triggers`) — run-scoped trigger payload.
    // Captured at run start and identical for every node (replay-safe). A
    // trigger-started run carries its payload in `run.metadata.triggerData`
    // (set by the scheduler / kanban / webhook-subscription paths); a manual or
    // builder-issued run falls back to the run's own `inputs`. Trigger entry
    // nodes read `ctx.triggerData`; all other nodes ignore it.
    triggerData:
      run.metadata && (run.metadata as Record<string, unknown>).triggerData !== undefined
        ? (run.metadata as Record<string, unknown>).triggerData
        : run.inputs,
    attempt: input.attempt ?? 1, // ADR 0326 P3a — the span's node_attempt derives from this
    // RFC 0020 §D: propagate the run-level trust boundary onto every
    // node ctx. The MCP server mount (routes/mcp.ts) sets
    // run.metadata.trustBoundary='untrusted' on inbound tools/call so
    // workflow nodes that forward content to LLM surfaces can apply
    // the prompt-injection UNTRUSTED-marker convention.
    trustBoundary:
      run.metadata && (run.metadata as Record<string, unknown>).trustBoundary === 'untrusted'
        ? 'untrusted'
        : 'trusted',
    // ADR 0099 — the per-run compaction decision frozen at run creation; read
    // once here (constant across the run, copied verbatim on :fork).
    compaction: readCompactionDecision(run.metadata),
    secrets: secretsForCtx,
    async emit(type, payload, opts) {
      // ADR 0675 — NORMALISE, and refuse what cannot be normalised.
      //
      // This signature is positional, `emit(type, payload)`. Several packs call
      // it with a SINGLE OBJECT instead — `core.openwop.http` sends
      // `{ type: 'node.progress', data: {…} }`, `core.openwop.a2a` and
      // `core.openwop.agents` send `{ kind: 'node.progress', payload: {…} }`.
      // Nothing rejected that, so the whole object was written into the
      // `events.type` TEXT column and serialised on the way.
      //
      // MEASURED in production 2026-09-14 by `scripts/era2-vendor-type-census.mjs`:
      // 376 rows whose `type` is a serialised envelope, e.g.
      // `{"type":"node.progress","data":{"phase":"retry","attempt":1,…}}`.
      // Nine of the ten grammar-invalid (tenant, type) pairs in the whole log
      // are this one bug, and it is invisible from the source — a scan of
      // `appendEvent({ type: '…' })` literals shows ten well-formed names,
      // because the corrupting write goes through this variable.
      //
      // Fixing only the packs would leave the next one free to do it again, and
      // packs are third-party by design. So the invariant lives HERE: a type is
      // a non-empty string, or the emit is refused. Refusing is the point —
      // a silent accept is what produced 376 unreadable rows, and an event the
      // log cannot name is worth less than an error someone sees.
      const normalised = normaliseEmitArgs(type, payload);
      const record = await eventLog.append({
        runId: run.runId,
        nodeId: nodeRef.nodeId,
        type: normalised.type,
        payload: stripSecretsFromPersisted(normalised.payload),
        // Envelope-level causation chain (RFC 0002 §B) — e.g.,
        // agent.toolReturned.causationId === paired agent.toolCalled.eventId.
        ...(opts?.causationId ? { causationId: opts.causationId } : {}),
      });
      // Surface eventId + sequence so nodes can build causationId chains
      // (RFC 0002 §B). Pre-existing void-returning callers ignore.
      return { eventId: record.eventId, sequence: record.sequence };
    },
    // ADR 0401 P3 — the image caps join the spread (callImageGenerator was
    // never bound here despite the node schema declaring it — the latent gap
    // this closes; edit/upscale are the new siblings).
    ...(aiAdapter ? { callAI: aiAdapter.callAI, callAIWithTools: aiAdapter.callAIWithTools, callSpeechSynthesizer: aiAdapter.callSpeechSynthesizer, callTranscriber: aiAdapter.callTranscriber, callImageGenerator: aiAdapter.callImageGenerator, callImageEditor: aiAdapter.callImageEditor, callImageUpscaler: aiAdapter.callImageUpscaler, callVideoGenerator: aiAdapter.callVideoGenerator } : {}),
    // ADR 0114 Phase 2 — `ctx.runSandboxedCode` present ONLY when a sandbox endpoint
    // is configured (else honest-off `capability_not_provided`, Phase 1 behavior).
    ...(sandboxRunner ? { runSandboxedCode: sandboxRunner } : {}),
    // interrupt.md — the normative awaitable interrupt primitive (+ the `suspend`
    // alias the packs call). Throws a SuspendSignal on first call (caught below →
    // suspended outcome); on a re-invoke resume the seeded resolution is returned.
    interrupt: suspendFn,
    suspend: suspendFn,
    storage: surfaces.storage,
    db: surfaces.db,
    fs: surfaces.fs,
    queueBus: surfaces.queueBus,
    observability: surfaces.observability,
    a2a: surfaces.a2a,
    kanban: surfaces.kanban,
    knowledge: surfaces.knowledge,
    features: surfaces.features,
    chat: surfaces.chat,
    canvas: surfaces.canvas,
    webResearch: surfaces.webResearch,
    launchStudio: surfaces.launchStudio,
    // launch-studio keys context on a user + threads step state through a
    // run-scoped variable bag. The sample host maps the principal to the run
    // tenant; the bag is backed by the variables runtime (replay-safe snapshot).
    userId: run.tenantId,
    // ADR 0024 §4/D2 — the durable human the run acts as (stamped on
    // run.metadata at creation, re-stamped to the forking caller on :fork).
    // Distinct from userId above (tenant, for launch-studio); the Connections
    // broker keys per-user credentials + connections:use on THIS. Absent ⇒
    // system run ⇒ org/user connections fail closed (correct).
    ...(actingUserId ? { actingUserId } : {}),
    // ADR 0189 — connect-to-continue is INTERACTIVE-only: a human chat session
    // created the run (chat transport stamps metadata.chatSessionId) and an
    // acting human exists. Headless runs never carry it, so connector
    // no-connection stays the graceful fail-closed no-op (ADR 0033).
    ...(typeof runMeta.chatSessionId === 'string' && runMeta.chatSessionId && actingUserId
      ? { interactiveSession: true }
      : {}),
    // ADR 0024 §4 / Option C — host-mediated egress + credential injection.
    // ALWAYS provided (RFC 0076 §B: a host that offers `safeFetch` mediates
    // egress itself, and the core HTTP pack prefers it over its own fallback).
    // With an empty `allowedProviders` (a run that did NOT opt into Connections)
    // it is a pure SSRF-guarded fetch with NO credential injection — the form the
    // notebooks YouTube-ingest node requires (ADR 0085; it needs guarded egress
    // to a public host, never a user credential). When the run opted in,
    // `allowedProviders` is non-empty and the same seam injects the acting user's
    // token for an allow-listed, host-matched provider after the pack's sanitize.
    http: {
      safeFetch: makeConnectionSafeFetch({
        storage,
        tenantId: run.tenantId,
        runId: run.runId,
        allowedProviders: connectionProviders,
        ...(actingUserId ? { actingUserId } : {}),
        orgId: run.tenantId, // workspace-root org (orgId === tenantId)
      }),
    },
    // ADR 0024 §4 Phase 3 — integration egress adapters (Slack + email). Always
    // provided (the nodes are explicit); each resolves the acting human's
    // Connection per call and gracefully no-ops when absent.
    slack: makeSlackAdapter({
      storage,
      tenantId: run.tenantId,
      runId: run.runId,
      ...(actingUserId ? { actingUserId } : {}),
      orgId: run.tenantId,
    }),
    ads: makeAdsAdapter({
      storage,
      tenantId: run.tenantId,
      runId: run.runId,
      ...(actingUserId ? { actingUserId } : {}),
      orgId: run.tenantId,
    }),
    email: makeEmailAdapter({
      storage,
      tenantId: run.tenantId,
      runId: run.runId,
      ...(actingUserId ? { actingUserId } : {}),
      orgId: run.tenantId,
    }),
    messaging: makeSmsAdapter({
      storage,
      tenantId: run.tenantId,
      runId: run.runId,
      ...(actingUserId ? { actingUserId } : {}),
      orgId: run.tenantId,
    }),
    notification: makeNotificationAdapter({
      storage,
      tenantId: run.tenantId,
      runId: run.runId,
      ...(actingUserId ? { actingUserId } : {}),
      orgId: run.tenantId,
    }),
    // ADR 0076 / ADR 0037 — the connector invoker, now exposed to nodes. Always
    // provided (the node is explicit); resolves the acting human's Connection per
    // call and fails closed when absent. First consumer: core.bigquery.query.
    connectors: makeConnectorsAdapter({
      storage,
      tenantId: run.tenantId,
      runId: run.runId,
      ...(actingUserId ? { actingUserId } : {}),
      orgId: run.tenantId,
    }),
    variables: {
      get: (name: string): unknown => snapshotRunVariables(run.runId)?.[name],
      set: (name: string, value: unknown): void => setRunVariable(run.runId, name, value),
    },
    // RFC 0020 — host-side MCP. The sample host builds its MCP registry
    // declaratively from workflow definitions (see host/mcpServerRegistry.ts),
    // so `expose` is a stable no-op that returns a synthetic handle. Pack
    // delegates from core.openwop.mcp.expose-* call this and chain on
    // outputs.handle; nothing depends on the handle's identity in v1.
    mcp: {
      expose: async (args) => ({
        handle: `mcp:${run.runId}:${nodeRef.nodeId}`,
        kind: typeof args.kind === 'string' ? args.kind : 'tool',
      }),
      // ADR 0030 — the OUTBOUND client (invokeTool / readResource / listTools /
      // serverStatus), per-user-authed via the Connections broker.
      ...makeMcpClient({
        storage,
        tenantId: run.tenantId,
        runId: run.runId,
        // RFC 0207 §A — the trace the run was CREATED under (persisted on the
        // run row, because the executor runs after the creating request is
        // gone). Every outbound MCP request carries a child of it.
        ...(runTrace ? { traceContext: runTrace } : {}),
        // ADR 0553 P3 — the run-cancellation signal `McpClientDeps.signal` has
        // asked for since ADR 0030 Phase 2b and never received. Read, never
        // armed, here: `executeRunBody` arms exactly one per run, so a node
        // reached outside a run body (a test harness) gets `undefined` and the
        // pre-P3 behaviour rather than a controller nobody will ever fire.
        ...(runAbortSignal(run.runId) ? { signal: runAbortSignal(run.runId)! } : {}),
        ...(actingUserId ? { actingUserId } : {}),
        orgId: run.tenantId,
        // ADR 0553 P2 / RFC 0153 §C.1 — an MRTR `input_required` becomes a
        // `clarification` INTERRUPT on this node, not a live callback. The
        // suspend fn throws on the first call (the run pauses, a human answers)
        // and returns the answer inline on the resumed re-invoke, so the
        // initial call and the retry sit inside ONE node body — which is what
        // makes them one logical invocation (RFC 0150 §B): `beginNodeActivity`
        // rewound the ordinal on resume, so the identity is unchanged and the
        // Layer-2 invocation log dedups the pair.
        elicitationResolver: async (request) => {
          const answer = await suspendFn({
            kind: 'clarification',
            profile: 'openwop-mcp-elicitation',
            resumeKey: `${nodeRef.nodeId}:mcp:${request.key}`,
            prompt: request.message,
            formSchema: request.requestedSchema,
            metadata: { mcp: { inputRequestKey: request.key, mode: request.mode } },
          });
          const resolved = (answer ?? {}) as { action?: unknown; payload?: unknown; content?: unknown };
          const action = resolved.action === 'decline' || resolved.action === 'cancel' ? resolved.action : 'accept';
          const content = (resolved.payload ?? resolved.content ?? {}) as Record<string, unknown>;
          return { action, content };
        },
      }),
    },
    // `core.openwop.triggers` webhook-respond node. The sample executor runs
    // asynchronously (no synchronous request still held open), so the host
    // durably records the intended HTTP reply as a run event — retrievable from
    // the event log and consumable by a synchronous webhook ingress. (Without
    // this the pack falls back to surfacing the reply as node outputs.)
    async respondToWebhook(response) {
      await eventLog.append({
        runId: run.runId,
        nodeId: nodeRef.nodeId,
        type: 'host.webhook.response',
        payload: stripSecretsFromPersisted(response),
      });
    },
  };

  let outcome: NodeOutcome;
  // `observability.md §"Node-level attributes"`: `openwop.node_attempt`
  // is a zero-based retry counter. Sample tier doesn't track retries
  // yet (ctx.attempt is the 1-based one-shot stub at line 302); derive
  // the spec-correct zero-based value from it so the two surfaces stay
  // in sync once real retries land — bumping ctx.attempt will move the
  // span attribute up automatically.
  const span = tracer.startSpan(`openwop.node.${nodeRef.typeId}`, {
    attributes: {
      'openwop.run_id': run.runId,
      // `observability.md §"Run-level attributes"` — spans MUST carry
      // `openwop.workflow_id` for run-scoped roll-ups + filtering.
      'openwop.workflow_id': run.workflowId,
      'openwop.node_id': nodeRef.nodeId,
      'openwop.node_type': nodeRef.typeId,
      'openwop.node_attempt': Math.max(0, (ctx.attempt ?? 1) - 1),
    },
  });
  // ADR 0341 (GC-FORK-2) — a side-effecting node must never FIRE during a
  // replay fork: reproduce the source run's recorded outcome for this
  // attempt (P3a fidelity — the Nth attempt reproduces the Nth outcome), or
  // fail CLOSED when the source never reached it. Pure/LLM nodes keep full
  // live re-execution (LLM calls are invocation-log-served), preserving the
  // spec's re-execute semantics and the RFC 0041 §B divergence machinery.
  let replayServed: NodeOutcome | null = null;
  if (input.sourceOutcomes && isSideEffectingNode(nodeRef.typeId, module)) {
    const recorded = input.sourceOutcomes.get(nodeRef.nodeId)?.[(input.attempt ?? 1) - 1];
    if (recorded?.kind === 'completed') {
      replayServed = { status: 'success', outputs: recorded.outputs ?? {} };
      recordReplayServed('recorded-success');
    } else if (recorded?.kind === 'failed' && recorded.error) {
      replayServed = { status: 'failure', error: recorded.error };
      recordReplayServed('recorded-failure');
    } else {
      replayServed = { status: 'failure', error: { code: 'replay_source_missing', message: `Replay fork: the source run has no recorded outcome for side-effecting node '${nodeRef.nodeId}' (attempt ${input.attempt ?? 1}); a replay never fires a new side effect.` } };
      // ADR 0556 P1 — `source-missing` is the fail-closed arm: the replay
      // reached a side-effecting node the source never executed. This is the
      // metric that makes the ADR 0341 guard's THIRD outcome visible; the other
      // two are ordinary replay traffic. Deliberately NOT folded into
      // `openwop.effect.dispatched` — no effect is dispatched here, and the
      // effect KIND is unknowable because the node never ran, so labelling it
      // would require inventing a value.
      recordReplayServed('source-missing');
    }
    span.setAttribute('openwop.replay_served', true);
  }
  const nodeStartedMs = Date.now();
  // ADR 0531 — the run-scoped effect context for this node execution. Built once
  // and used by BOTH placements: the in-process path wraps `module.execute` in
  // it, and the isolated path hands the very same object to the dispatch record
  // so the broker can re-establish it around each host-call.
  const effectCtx: RunEffectContext = {
    runId: run.runId,
    replaying: Boolean(input.sourceOutcomes),
    observedEffectKinds,
    // ADR 0591 P2 — the RFC 0150 §B identity INPUTS, not an identity. The
    // ledger hands these to `host/effectIdentity.ts`, which stays the single
    // owner of the composition; see that file and `host/effectEscapeLedger.ts`
    // for why a precomputed key here would be a second recipe.
    nodeId: nodeRef.nodeId,
    tenantId: run.tenantId,
    attempt: input.attempt ?? 1,
  };
  // ADR 0555 P1 — WHERE this node runs. Decided here and nowhere else; the
  // refuse arm is a typed node failure, never a quiet fallback to in-process.
  const isolationPlan = resolveIsolationPlan({ mode: isolationMode(), origin: module.packOrigin });
  try {
    // ADR 0531 — establish the run-scoped effect context around EVERY node
    // execution (live and replay alike, so an absent context unambiguously
    // means "not inside a run" rather than "not replaying"). Host effect seams
    // call `assertEffectAllowed()` inside it: a replay that reaches a real
    // effect without having been classified side-effecting fails closed here
    // instead of quietly firing it a second time.
    //
    // The ISOLATED branch is deliberately NOT nested inside it. A worker process
    // does not inherit AsyncLocalStorage — that is the exact limit
    // `runEffectContext.ts`'s header names — so the guard is re-established by
    // the broker, per host-call, on the host side. Wrapping the adapter call
    // here would let the fake in-process adapter inherit the context and make
    // the guard's sabotage test pass for a reason that will not hold in P2.
    // RFC 0199 §C (ADR 0753 D8) — a node that DECLARES an oauth2 credential is
    // checked before it runs: a recorded resolution first, then the live one.
    // Suspends by throwing a `SuspendSignal` (the catch below records it like any
    // other interrupt); a decline/expiry is a typed `CredentialGateError`. Never on
    // a replay-served outcome, which reproduces what the original run recorded.
    const oauthDeclaration = replayServed ? null : nodeOAuthDeclarationOf(nodeRef.config);
    if (oauthDeclaration) {
      await runCredentialGate({
        runId: run.runId,
        nodeId: nodeRef.nodeId,
        tenantId: run.tenantId,
        ...(actingUserId ? { actingUserId } : {}),
        declaration: oauthDeclaration,
        ...(input.suspendResolution ? { suspendResolution: input.suspendResolution } : {}),
        emit: (type, payload) => ctx.emit(type, payload),
      });
    }
    outcome = replayServed ?? (
      isolationPlan.kind === 'refuse'
        ? { status: 'failure', error: { code: isolationPlan.code, message: isolationPlan.message } }
        : isolationPlan.kind === 'isolate'
          ? await dispatchPackNodeIsolated({
              ctx,
              module,
              origin: isolationPlan.origin,
              effectCtx,
              runMetadata: run.metadata as Record<string, unknown> | undefined,
              ...(input.suspendResolution ? { suspendResolution: input.suspendResolution } : {}),
            })
          : await runWithEffectContext(effectCtx, () => module.execute(ctx))
    );
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    if (err instanceof SuspendSignal) {
      // ctx.suspend/ctx.interrupt threw → suspend the run. Tag the interrupt
      // data with the resume key + re-invoke style so the resume path knows to
      // re-run this node (vs the native mark-completed path).
      span.setStatus({ code: SpanStatusCode.OK });
      outcome = {
        status: 'suspended',
        interrupt: {
          kind: err.kind,
          data: { ...err.data, __resumeKey: err.resumeKey, __resumeStyle: 'reinvoke' },
          ...(err.resumeSchema !== undefined ? { resumeSchema: err.resumeSchema } : {}),
        },
      };
    } else {
      const message = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      // Surface a KNOWN host error's stable `.code` (AiProviderError, McpError) so
      // a typed fail-closed reason — e.g. `connector_not_allowed`,
      // `mcp_not_connected` — reaches the node-failure event instead of a generic
      // `internal_error`. Deliberately NOT generalized to any `.code` (that would
      // leak arbitrary internal codes like Node's ENOENT to the wire).
      // ADR 0531 joins this allowlist: the effect-guard backstop's
      // `replay_source_missing` must reach the node-failure event as itself,
      // matching the ADR 0341 fast path's code for the same invariant.
      // ADR 0585 P0b — a lost lease is NOT a node failure and must not be
      // recorded as one. Recording it would give the run a `node.failed` event
      // written by an instance that no longer owns it, and on the failure path
      // that event is what triggers COMPENSATION — firing refund inverses
      // against effects the new owner is legitimately re-executing. Re-throw so
      // the scheduling loop's abandon path handles it, silently.
      if (err instanceof LeaseLostError) throw err;
      const code =
        err instanceof AiProviderError || err instanceof McpError || err instanceof ReplayEffectError || err instanceof CredentialGateError
          ? err.code
          : 'internal_error';
      outcome = { status: 'failure', error: { code, message } };
    }
  } finally {
    span.end();
  }
  // ADR 0556 P1 — step latency. Measured across the guard-wrapped execution
  // only, so the replay-divergence work below (which can issue a storage read)
  // is not charged to the node. `replayed` separates a re-execution from live
  // traffic: a replay's latency distribution is a different population and
  // mixing them makes a p99 mean nothing.
  recordNodeDuration({
    status: outcome.status === 'success' ? 'success' : outcome.status === 'suspended' ? 'suspended' : 'failure',
    replayed: Boolean(input.sourceOutcomes),
    durationMs: Date.now() - nodeStartedMs,
  });

  // RFC 0041 §B Phase 4 — replay-divergence-at-refusal detection.
  //
  // When the current run is a replay-mode fork AND this node's envelope
  // outcome (refusal vs valid) differs from the source run's outcome at
  // the same nodeId, emit `replay.divergedAtRefusal` and force the node
  // to fail with `error.code: 'replay_diverged_at_refusal'`. Silent
  // substitution of the new envelope for the original is non-conformant
  // per RFC 0041 §B + `spec/v1/multi-agent-execution.md` §"Envelope-
  // refusal recovery in replay".
  //
  // Gated on `OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_4=true` — non-
  // Phase-4 hosts MUST NOT emit this event per the schema description on
  // `run-event-payloads.schema.json` §`replayDivergedAtRefusal`.
  const phase4Enabled = process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_4 === 'true';
  const isReplayFork = run.forkMode === 'replay' && typeof run.parentRunId === 'string';

  // Discriminated union — when `diverged: true`, `originalKind` is
  // guaranteed defined. Lets the callers consume `div.originalKind`
  // without non-null assertions.
  type DivergenceResult =
    | { diverged: false }
    | {
        diverged: true;
        originalKind: 'valid' | 'refusal';
        atSequence?: number;
        originalEventId?: string;
      };

  // Per RFC 0041 §B, refusal-divergence applies to LLM-emitting nodes
  // (the only nodes that can carry an "envelope" in the protocol sense).
  // The check below gates on the current node's typeId matching one of
  // the canonical LLM families before treating its source-run completion
  // as evidence of an envelope = valid. Non-LLM nodes never produce an
  // envelope and their `node.completed` events say nothing about
  // envelope shape; including them would create false positives.
  function isLlmNodeTypeId(typeId: string): boolean {
    return /^core\.(ai|llm)\b/.test(typeId);
  }

  async function checkReplayDivergence(replayKind: 'valid' | 'refusal'): Promise<DivergenceResult> {
    if (!phase4Enabled || !isReplayFork || run.parentRunId === undefined) {
      return { diverged: false };
    }
    // Refusal-divergence only applies to LLM-emitting nodes. Non-LLM
    // node types (core.noop, core.script.*, core.subWorkflow, etc.) do
    // not produce envelopes; comparing their `node.completed` events
    // against an envelope-kind would create a false positive.
    if (!isLlmNodeTypeId(nodeRef.typeId)) {
      return { diverged: false };
    }
    // Look up the source run's events at the same nodeId. Two cases:
    //   - source has `envelope.refusal` for nodeId → originalKind = 'refusal'
    //   - source has `node.completed` for nodeId AND this node is an
    //     LLM-family node → originalKind = 'valid' (LLM nodes that
    //     terminate `completed` did so by accepting an envelope per
    //     `core.ai.*` / `core.llm.*` semantics; the `envelope.refusal`
    //     path throws AiProviderError and surfaces as `node.failed`).
    //   - neither → undefined (this LLM node didn't dispatch in the
    //     source run; nothing to compare against; conservative no-divergence).
    try {
      const sourceEvents = await storage.listEvents(run.parentRunId);
      const refusalForNode = sourceEvents.find(
        (e) => e.type === 'envelope.refusal' && e.nodeId === nodeRef.nodeId,
      );
      const completionForNode = sourceEvents.find(
        (e) => e.type === 'node.completed' && e.nodeId === nodeRef.nodeId,
      );
      const sourceKind: 'valid' | 'refusal' | undefined = refusalForNode
        ? 'refusal'
        : completionForNode
          ? 'valid'
          : undefined;
      if (sourceKind === undefined) return { diverged: false }; // can't tell — no envelope event in source
      if (sourceKind === replayKind) return { diverged: false }; // same kind — no divergence
      const sentinel = refusalForNode ?? completionForNode;
      const result: DivergenceResult = {
        diverged: true,
        originalKind: sourceKind,
        ...(sentinel?.sequence !== undefined ? { atSequence: sentinel.sequence } : {}),
        ...(sentinel?.eventId !== undefined ? { originalEventId: sentinel.eventId } : {}),
      };
      return result;
    } catch {
      // Source run not accessible — be conservative and don't emit a
      // divergence event we can't substantiate.
      return { diverged: false };
    }
  }

  if (outcome.status === 'success') {
    // Phase 4: check whether the original run had a refusal at this node.
    // If yes, the replay's success constitutes a divergence (silent
    // substitution direction: original=refusal → replay=valid).
    const div = await checkReplayDivergence('valid');
    if (div.diverged) {
      await eventLog.append({
        runId: run.runId,
        nodeId: nodeRef.nodeId,
        type: 'replay.divergedAtRefusal',
        payload: {
          sourceRunId: run.parentRunId,
          atSequence: div.atSequence ?? 0,
          ...(div.originalEventId ? { originalEventId: div.originalEventId } : {}),
          nodeId: nodeRef.nodeId,
          originalEnvelopeKind: div.originalKind,
          replayEnvelopeKind: 'valid' as const,
        },
      });
      await eventLog.append({
        runId: run.runId,
        nodeId: nodeRef.nodeId,
        type: 'node.failed',
        payload: stripSecretsFromPersisted({ nodeId: nodeRef.nodeId,
          error: {
            code: 'replay_diverged_at_refusal',
            message: `replay diverged at refusal for node ${nodeRef.nodeId}: original=${div.originalKind}, replay=valid`,
          },
        }),
      });
      return {
        kind: 'failure',
        error: {
          code: 'replay_diverged_at_refusal',
          message: `replay diverged at refusal for node ${nodeRef.nodeId}: original=${div.originalKind}, replay=valid`,
        },
      };
    }
    await eventLog.append({
      runId: run.runId,
      nodeId: nodeRef.nodeId,
      type: 'node.completed',
      // `nodeId` rides INSIDE the payload as well as on the envelope:
      // run-event-payloads.schema.json $defs/nodeCompleted requires it
      // (additionalProperties false), consistent with nodeStarted/nodeFailed.
      payload: stripSecretsFromPersisted({ nodeId: nodeRef.nodeId, outputs: outcome.outputs }),
    });
    // Normalize outputs to a Record<string, unknown> for the snapshot.
    const outputsObj =
      outcome.outputs && typeof outcome.outputs === 'object' && !Array.isArray(outcome.outputs)
        ? (outcome.outputs as Record<string, unknown>)
        : { output: outcome.outputs };
    return { kind: 'success', outputs: outputsObj, observedEffectKinds };
  }

  if (outcome.status === 'failure') {
    // Phase 4: when this node failed with `envelope_refusal` AND the
    // original run got a valid envelope at the same nodeId, that's a
    // refusal-divergence. Emit `replay.divergedAtRefusal` + override the
    // error code from `envelope_refusal` to `replay_diverged_at_refusal`.
    if (outcome.error.code === 'envelope_refusal') {
      const div = await checkReplayDivergence('refusal');
      if (div.diverged) {
        await eventLog.append({
          runId: run.runId,
          nodeId: nodeRef.nodeId,
          type: 'replay.divergedAtRefusal',
          payload: {
            sourceRunId: run.parentRunId,
            atSequence: div.atSequence ?? 0,
            ...(div.originalEventId ? { originalEventId: div.originalEventId } : {}),
            nodeId: nodeRef.nodeId,
            originalEnvelopeKind: div.originalKind,
            replayEnvelopeKind: 'refusal' as const,
          },
        });
        const overriddenError = {
          code: 'replay_diverged_at_refusal',
          message: `replay diverged at refusal for node ${nodeRef.nodeId}: original=${div.originalKind}, replay=refusal`,
        };
        await eventLog.append({
          runId: run.runId,
          nodeId: nodeRef.nodeId,
          type: 'node.failed',
          payload: stripSecretsFromPersisted({ nodeId: nodeRef.nodeId, error: overriddenError }),
        });
        return { kind: 'failure', error: overriddenError };
      }
    }
    if (runPauseRequest(run.runId)?.abortedAt !== undefined) {
      // ADR 0632 — an `immediate` pause fired the run abort signal mid-attempt.
      // The node did not fail; it was interrupted. Record nothing for the
      // attempt: the resumed run re-executes it (idempotent per the Layer-2
      // invocation log) and emits its own `node.started`/`node.completed`.
      log.info('node_pause_interrupted', { runId: run.runId, nodeId: nodeRef.nodeId, code: outcome.error.code });
      return { kind: 'interrupted' };
    }
    await eventLog.append({
      runId: run.runId,
      nodeId: nodeRef.nodeId,
      type: 'node.failed',
      payload: stripSecretsFromPersisted({ nodeId: nodeRef.nodeId, error: outcome.error }),
    });
    return { kind: 'failure', error: outcome.error };
  }

  // Suspended.
  return { kind: 'suspended', interrupt: outcome.interrupt };
}

export interface ExecuteRunOptions {
  /**
   * ADR 0740 — the caller ALREADY holds this run's execution claim for this
   * instance, so `executeRun` must not contend for it. Set by the orphan lane
   * only: `claimOrphanedRuns` is itself the atomic claim, and it stamps
   * `dispatch_owner = <this instance>` with a live lease — which is exactly what
   * a duplicate looks like. Without this, recovery would refuse its own
   * re-dispatch. Nothing else may set it: a caller that has not atomically
   * claimed the run and says it has re-opens `WHD-12`.
   */
  executionPreclaimed?: boolean;
  resumeFromNodeIndex?: number;
  /** New-style resume: hydrate the snapshot from these completed nodes. */
  resumeSnapshot?: SerializedSnapshot;
  resumeValue?: unknown;
  /** When resuming, the nodeId whose suspension just resolved. */
  resumeNodeId?: string;
  /** Resume style for the resolved node. `'reinvoke'` (set when the node
   *  suspended via ctx.suspend/ctx.interrupt) re-runs the node with the
   *  resolution seeded so it can shape the result into its real outputs; absent
   *  → the native mark-completed path. interrupt.md §"key field". */
  resumeStyle?: 'reinvoke';
  /** The deterministic resume key the re-invoked ctx.suspend call must match. */
  resumeKey?: string;
  policyResolver?: ProviderPolicyResolver;
  /** ADR 0326 P3b — replay-mode fork: ALSO consult THIS run's Layer-2
   *  invocation log on cache misses (reads only; writes stay on the fork's
   *  own runId so nested forks compose). This is what makes a replay fork
   *  provider-deterministic: without it a fork's fresh runId had zero
   *  recorded invocations and every provider call re-ran live. */
  replayInvocationsFromRunId?: string;
}

/**
 * ADR 0326 P3b — reconstruct a scheduler checkpoint from an event-log PREFIX
 * (the events a fork copied). Completed nodes restore their state + outputs
 * (node.completed payloads carry `{outputs}`); failed nodes restore state +
 * error; a node started but not terminal in the prefix was IN FLIGHT at the
 * checkpoint and is left unset (it re-executes live).
 *
 * ADR 0751 — a node whose prefix ends on an OPEN interrupt (`node.suspended` /
 * `conversation.opened` with no later terminal event) is restored as
 * `'suspended'` with its interrupt kind, instead of refusing the fork. The gate
 * is inherited STATE: it is not re-executed, and the fork's executor re-creates
 * its live interrupt row (`ensureForkInterrupts`). This used to return null and
 * the route answered `501 fork_checkpoint_unsupported`, a refusal neither
 * `runs.md` §Fork nor `replay.md` licenses.
 * Known limitation (recorded in the ADR): side-band variable-bag mutations by
 * prefix nodes do not replay (mid-run mutation is future scope, HVMAP-2).
 */
export function snapshotFromEventPrefix(events: ReadonlyArray<{ type: string; nodeId?: string; payload: unknown }>): SerializedSnapshot {
  const state = new Map<string, string>();
  const outputs = new Map<string, Record<string, unknown>>();
  const errors = new Map<string, { code: string; message: string }>();
  const openKinds = new Map<string, string>();
  for (const ev of events) {
    const nodeId = ev.nodeId;
    if (!nodeId) continue;
    const p = (ev.payload ?? {}) as { outputs?: unknown; error?: { code?: string; message?: string }; kind?: unknown };
    if (ev.type === 'node.completed') {
      state.set(nodeId, 'completed');
      outputs.set(nodeId, (p.outputs && typeof p.outputs === 'object' && !Array.isArray(p.outputs) ? p.outputs : { output: p.outputs }) as Record<string, unknown>);
      openKinds.delete(nodeId);
    } else if (ev.type === 'node.failed') {
      state.set(nodeId, 'failed');
      errors.set(nodeId, { code: p.error?.code ?? 'internal_error', message: p.error?.message ?? 'failed in the forked prefix' });
      openKinds.delete(nodeId);
    } else if (ev.type === 'node.suspended') {
      openKinds.set(nodeId, typeof p.kind === 'string' ? p.kind : (openKinds.get(nodeId) ?? 'approval'));
    } else if (ev.type === 'conversation.opened') {
      if (!openKinds.has(nodeId)) openKinds.set(nodeId, 'conversation');
    }
  }
  for (const [nodeId] of openKinds) state.set(nodeId, 'suspended');
  return {
    schemaVersion: 1,
    nodeState: [...state.entries()],
    nodeOutputs: [...outputs.entries()],
    nodeErrors: [...errors.entries()],
    ...(openKinds.size > 0 ? { suspendedKinds: [...openKinds.entries()] } : {}),
  };
}

/**
 * ADR 0725 — the executor is a BACKGROUND WORKER, whichever request launched it.
 *
 * Twenty-one sites launch `executeRun` (`void executeRun(...)` from route
 * handlers, the sweeper, the trigger bridge, …). A launch from inside a request
 * inherits that request's protocol contract through `AsyncLocalStorage`
 * (`storage/eventEraAdapter.ts` `currentContract()`), so under a major-2
 * `:fork` the executor's own parent-log reads (`memory.written` verbatim copy,
 * the refusal-divergence scan) came back PROJECTED — the child log would then
 * persist a read projection the parent never stored. Byte-safe today only by
 * composition (no copied type has a required envelope id or an alias row); one
 * carry step away from breaking RFC 0041 §C. Entering the worker contract HERE,
 * at the one owner, makes every launch site right by construction — the same
 * move ADR 0650 made for the interval daemons.
 */
/**
 * ADR 0725 — the diagnostic keys a suspending node may record on its
 * `node.suspended` row, carried from the interrupt data. An ALLOWLIST: interrupt
 * data holds approval artifacts and caller content, and the event log is the
 * least revocable place either could land. `reason` is the corpus seat
 * (RFC 0186); `agentId`/`threshold`/`observed` are RFC 0002 CP-1's
 * low-confidence triple and ride the vendor hatch on a major-2 read.
 */
const SUSPEND_DIAGNOSTIC_KEYS = ['reason', 'agentId', 'threshold', 'observed'] as const;
function suspendDiagnostics(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
  const d = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of SUSPEND_DIAGNOSTIC_KEYS) {
    const v = d[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export function executeRun(
  storage: Storage,
  run: RunRecord,
  rawDefinition: WorkflowDefinition,
  options: ExecuteRunOptions = {},
): Promise<ExecuteRunResult> {
  return runUnderWorkerContract(async () => {
    try {
      return await executeRunInner(storage, run, rawDefinition, options);
    } catch (err) {
      // RFC 0194 §A — the run's log was CLOSED under this execution (a cancel
      // appended `run.cancelled` while a node was in flight, and the node then
      // tried to record its own outcome). That is not a failure of this run: it
      // already ended, and the refused append was never written. Report the
      // status the row carries instead of surfacing a dispatch error, which
      // would otherwise reach the fail-closed path.
      if (err instanceof RunLogClosedError) {
        const recorded = (await storage.getRun(run.runId))?.status;
        log.info('run_log_closed_execution_stopped', { runId: run.runId, refused: err.type, closedBy: err.closedBy, recorded });
        return { status: recorded ?? (err.closedBy === 'run.cancelled' ? 'cancelled' : err.closedBy === 'run.failed' ? 'failed' : 'completed') };
      }
      throw err;
    }
  });
}

/** How long a RESUME waits for the execution it succeeds to return (ADR 0740). */
export const RESUME_CLAIM_WAIT_MS = 30_000;
const RESUME_CLAIM_POLL_MS = 250;

type ExecutionClaimOutcome =
  | { outcome: 'claimed' }
  /** Not fenced, by design: proceed exactly as before ADR 0740. */
  | { outcome: 'unfenced'; why: 'preclaimed' | 'missing' | 'unsupported' | 'error' | 'resume-wait-elapsed' }
  | { outcome: 'refused'; reason: 'held' | 'not-runnable'; status?: RunRecord['status'] };

/**
 * ADR 0740 — acquire the execution claim, or say why this delivery must not run.
 *
 * FAILS OPEN on everything except a positive "someone else holds it": a storage
 * that lacks the primitive (24 test files hand `executeRun` a partial Storage), a
 * run row that does not exist, or a claim that THROWS all proceed unfenced, as
 * before. The alternative — refusing to execute when the fence is unavailable —
 * turns a storage blip into a fleet-wide stall, which is the worse failure for
 * an engine whose floor is at-least-once. It is logged at error: a host running
 * without its fence must not look identical to one that has it.
 *
 * A RESUME THAT FINDS THE RUN HELD WAITS instead of being refused. Two gates
 * resolved back to back produce two legitimate `executeRun` calls; the second
 * can arrive while the first is still between `running` and its next suspend.
 * It is a successor, not a duplicate — dropping it would strand a resolved
 * interrupt. It polls until the holder returns; if that never happens inside
 * the window it proceeds unfenced (today's behaviour) and says so.
 */
async function acquireExecutionClaim(storage: Storage, runId: string, isResume: boolean, preclaimed: boolean): Promise<ExecutionClaimOutcome> {
  if (preclaimed) return { outcome: 'unfenced', why: 'preclaimed' };
  if (typeof storage.claimRunExecution !== 'function') return { outcome: 'unfenced', why: 'unsupported' };
  const deadline = Date.now() + (isResume ? RESUME_CLAIM_WAIT_MS : 0);
  for (;;) {
    let claim: Awaited<ReturnType<Storage['claimRunExecution']>>;
    try {
      const now = Date.now();
      claim = await storage.claimRunExecution(runId, getInstanceId(), now, now + RUN_DISPATCH_LEASE_MS);
    } catch (err) {
      log.error('execution_claim_unavailable', {
        runId,
        detail: 'ADR 0740: the execution fence could not be consulted — duplicate-delivery suppression is OFF for this dispatch',
        error: err instanceof Error ? err.message : String(err),
      });
      return { outcome: 'unfenced', why: 'error' };
    }
    if (claim === 'claimed') return { outcome: 'claimed' };
    if (claim === 'missing') return { outcome: 'unfenced', why: 'missing' };
    if (claim === 'not-runnable') {
      const status = (await storage.getRun(runId).catch(() => null))?.status;
      return { outcome: 'refused', reason: 'not-runnable', ...(status ? { status } : {}) };
    }
    // held
    if (!isResume) {
      const status = (await storage.getRun(runId).catch(() => null))?.status;
      return { outcome: 'refused', reason: 'held', ...(status ? { status } : {}) };
    }
    if (Date.now() >= deadline) {
      log.error('resume_claim_wait_elapsed', {
        runId,
        waitedMs: RESUME_CLAIM_WAIT_MS,
        detail: 'ADR 0740: the execution this resume succeeds never returned; proceeding UNFENCED rather than stranding a resolved interrupt',
      });
      return { outcome: 'unfenced', why: 'resume-wait-elapsed' };
    }
    await new Promise((r) => setTimeout(r, RESUME_CLAIM_POLL_MS));
  }
}

async function executeRunInner(
  storage: Storage,
  run: RunRecord,
  rawDefinition: WorkflowDefinition,
  options: ExecuteRunOptions,
): Promise<ExecuteRunResult> {
  const eventLog = getEventLog();
  const suspend = getSuspendManager();
  const definition = withImplicitEdges(rawDefinition);
  // RFC 0124 G3 — a deferred-expanded workflow carries its minted PromptTemplates on
  // metadata; re-register them into THIS instance's prompt store so a lifted
  // `*PromptRef` resolves here (the from-chain mint only populated the expanding
  // instance's in-memory store — a run on another instance/after a restart would
  // otherwise compose an empty prompt). Idempotent + tolerant; no-op for non-deferred.
  ensureMintedTemplatesRegistered(definition.metadata);
  const isResume = options.resumeSnapshot !== undefined || options.resumeFromNodeIndex !== undefined;

  // A REPLAY FORK THAT INHERITED A PREFIX HAS ALREADY STARTED — do not start it again.
  //
  // `POST /runs/{id}:fork` copies the source's events `< fromSeq` into the new
  // run's log verbatim (replay.md §"Replay-from-event-log internals" 3, and the
  // §"Byte-equivalence of the prefix" MUST). That prefix already contains
  // `run.started` at sequence 0. Emitting it again here appended a SECOND
  // `run.started` at sequence `fromSeq`, so the replay's log carried two starts
  // and its observable tail began with an event the source does not have at that
  // position.
  //
  // MEASURED before the fix, source vs replay for `conformance-multi-node` at
  // `fromSeq=5` (three `core.noop` nodes — nothing nondeterministic anywhere):
  //   source #5.. : node.started@c, node.completed@c, memory.written, run.completed
  //   replay #0.. : run.started, node.started@a, …, node.completed@b, run.started#5
  // Every mid-sequence replay therefore reported a spurious `replay.diverged`
  // whose payload carries a fresh random `replayEventId` — which is the ONLY
  // field that differed between two replays of the same source. So the observable
  // "replay is non-deterministic" was not node divergence at all: it was this
  // duplicate lifecycle event manufacturing a divergence record, and the record's
  // own UUID being the thing that varied.
  //
  // WHY BRANCH WAS NEVER AFFECTED, since the asymmetry is the whole bug: a branch
  // fork passes `resumeSnapshot` (routes/runs.ts — ADR 0326 P3b), so `isResume`
  // is already true and this block is skipped. A replay fork passes only
  // `replayInvocationsFromRunId`, because replay must RE-EXECUTE rather than
  // resume from a checkpoint — so it fell through to the start path. The two fork
  // modes disagreed about whether a copied prefix means the run has started.
  //
  // DERIVED from persisted run state rather than a caller-supplied flag: a fork
  // with `parentSeq > 0` copied a prefix by construction, so a future fork-like
  // path cannot forget to pass something. `parentSeq === 0` is a full replay with
  // NO inherited prefix, where `run.started` is correct and matches the source's
  // own sequence 0 — which is exactly why `fromSeq=0` replays always looked fine
  // and only the arbitrary-`fromSeq` scenario could see this.
  // Scoped to `replay` DELIBERATELY. A branch fork also copies a prefix, but
  // replay.md §Modes makes branch "an independent run … NOT deterministic by
  // design", and it already emits `run.resumed` from the resume path below.
  // Widening this to branch would change an unrelated lifecycle for no
  // conformance reason, so branch is left exactly as it is.
  const inheritedStartedPrefix = run.forkMode === 'replay'
    && typeof run.parentRunId === 'string'
    && (run.parentSeq ?? 0) > 0;
  const tracer = trace.getTracer('openwop.workflow-engine-sample');

  // ── ADR 0740 — THE EXECUTION CLAIM. Before ANYTHING is written. ────────────
  //
  // One accepted run can be DELIVERED to this function twice: the `setImmediate`
  // dispatch hint racing a `dispatch_outbox` redelivery, or two instances. The
  // lease stamp further down is unconditional, so both used to execute — one
  // HTTP effect arriving twice, two `run.completed` on one log (`WHD-12`,
  // measured by the RFC 0158 `duplicate-delivery` row). The fence is here, at the
  // execution boundary, because it is the one place EVERY delivery passes and it
  // needs no per-seam work: a delivery that loses the claim never reaches a node.
  const executionClaim = await acquireExecutionClaim(storage, run.runId, isResume, options.executionPreclaimed === true);
  if (executionClaim.outcome === 'refused') {
    log.warn('duplicate_delivery_refused', {
      runId: run.runId,
      instanceId: getInstanceId(),
      reason: executionClaim.reason,
      detail: 'another execution holds this run (or it is already final); executed nothing and wrote nothing',
    });
    return { status: executionClaim.status ?? run.status, duplicateDelivery: true };
  }

  if (inheritedStartedPrefix) {
    // NEITHER `run.started` NOR `run.resumed`. The inherited prefix already
    // carries the start, and the source log has no lifecycle event at `fromSeq`
    // — so any event appended here would be an event the source does not have at
    // that position, which is the very thing §"Byte-equivalence of the prefix"
    // forbids. A replay is a re-execution, not a resume. Status still moves to
    // `running`, which is run STATE rather than a logged event.
    await storage.updateRun(run.runId, { status: 'running' });
  } else if (!isResume) {
    // RFC 0040 / RFC 0083 §C-3: when the run was initiated by an inbound
    // trigger delivery, run.started carries the delivery id as causationId so
    // /ancestry resolves delivery → run. Absent for directly-created runs.
    // RFC 0165 §B / RFC 0048 (ADR 0625): echo the snapshot's owner block so the
    // event log carries the identity the snapshot serves — same projection
    // (`host/runOwner.ts`), so they cannot disagree.
    const ownerEcho = runOwner(run);
    await eventLog.append({ runId: run.runId, type: 'run.started', payload: { workflowId: run.workflowId, ...(ownerEcho ? { owner: ownerEcho } : {}) }, causationId: run.causationId });
    await storage.updateRun(run.runId, { status: 'running' });
    // ADR 0556 P1 — the run's start, and the only point at which BOTH the
    // definition (which carries the chain stamp) and the run row (which carries
    // the trigger) are in hand. The terminal seam is `notifyRunTerminal`, which
    // is given nothing but an id and a status, so the workflow kind and the
    // start instant are remembered here for it. A resume is deliberately NOT a
    // start: it would double-count the run and restart its clock, turning a
    // four-hour approval wait into two short runs.
    recordRunStarted({
      runId: run.runId,
      kind: classifyWorkflowKind({ definition, run }),
      trigger: classifyRunTrigger(run),
    });
  } else {
    await eventLog.append({
      runId: run.runId,
      type: 'run.resumed',
      payload: { resumedAtNode: options.resumeNodeId ?? null },
    });
    await storage.updateRun(run.runId, { status: 'running' });
  }

  // Multi-instance dispatch lease: claim this run for this instance. The lease
  // outlives the maximum legal runtime (run-duration ceiling + buffer), so an
  // alive run is never re-dispatched; once it expires (the owning instance
  // crashed) the `runDispatchSweeper` re-claims and re-runs the run, which is
  // idempotent against the Layer-2 invocation log. Best-effort — a lease write
  // failure must not abort the run.
  // ADR 0740 — when the execution claim above WON, it already stamped the lease
  // atomically; this unconditional stamp is then only the fail-open fallback
  // (no such row, a storage without the primitive, a claim that errored).
  if (executionClaim.outcome !== 'claimed') try {
    await storage.setRunDispatchLease(run.runId, getInstanceId(), Date.now() + RUN_DISPATCH_LEASE_MS);
  } catch (err) {
    // Lease is an availability optimization, not a correctness gate — never
    // abort the run. But a write failure here means a degraded storage layer
    // (the sweeper can't see this run's owner), so surface it for ops (ENG-3).
    log.warn('dispatch_lease_write_failed', {
      runId: run.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Open the run-lifecycle span per `observability.md §"Span naming"`
  // (`openwop.run` or `openwop.run.<phase>`). Carries every required
  // run-level attribute (`observability.md §"Run-level attributes"`)
  // AND is kept active through `context.with` so node spans created
  // downstream (in `runOneNode`) nest under it — trace viewers see
  // the canonical run → node hierarchy without operator-side stitching.
  const runSpan = tracer.startSpan('openwop.run', {
    attributes: {
      'openwop.run_id': run.runId,
      'openwop.workflow_id': run.workflowId,
      'openwop.protocol_version': '1.1',
      ...(run.tenantId ? { 'openwop.tenant_id': run.tenantId } : {}),
      ...(run.scopeId ? { 'openwop.scope_id': run.scopeId } : {}),
    },
  });
  try {
    return await otelContext.with(
      trace.setSpan(otelContext.active(), runSpan),
      () => executeRunBody({ storage, run, definition, options, eventLog, suspend }),
    );
  } finally {
    runSpan.end();
  }
}

interface ExecuteRunBodyInput {
  storage: Storage;
  run: RunRecord;
  definition: WorkflowDefinition;
  options: ExecuteRunOptions;
  eventLog: ReturnType<typeof getEventLog>;
  suspend: ReturnType<typeof getSuspendManager>;
}

async function executeRunBody(input: ExecuteRunBodyInput): Promise<ExecuteRunResult> {
  const { storage, run, definition, options, eventLog, suspend } = input;
  const isResume = options.resumeSnapshot !== undefined || options.resumeFromNodeIndex !== undefined;
  // ENG-3: load this run's variable bag + agent stamp from durable storage
  // before executing. No-ops when already cached (the common in-process path);
  // on a sweeper re-dispatch to another instance they recover the state the
  // crashed instance wrote, instead of running with empty state.
  await hydrateRunVariables(run.runId);
  await hydrateRunAgent(run.runId);
  // CS-WF-1 — channel state gets the same cross-instance recovery.
  await hydrateRunChannels(run.runId);
  // ADR 0554 P2 — the root of this run's SUB-RUN tree, resolved once. The
  // compensation ordinal counter is scoped to it, which is what makes a single
  // descending sort over the ledger the depth-first reverse order RFC 0151 §C
  // requires: a sub-run executes synchronously inside its parent node, so its
  // ordinals fall between the parent effects that bracketed it.
  const compensationRootRunId = await resolveCompensationRoot(storage, run);
  // ADR 0341 — replay fork: fold the SOURCE run's terminal outcomes once
  // (batched drain — the adapters cap listEvents at 1000/page); flagged
  // side-effecting nodes reproduce these instead of executing live.
  let sourceOutcomes: Map<string, SourceNodeOutcome[]> | null = null;
  if (options.replayInvocationsFromRunId) {
    const srcEvents: { type: string; nodeId?: string; payload: unknown }[] = [];
    let fromSeq = -1;
    for (;;) {
      const batch = await storage.listEvents(options.replayInvocationsFromRunId, { fromSeq, limit: 1000 });
      for (const e of batch) { if (e.sequence > fromSeq) fromSeq = e.sequence; srcEvents.push(e); }
      if (batch.length < 1000) break;
    }
    sourceOutcomes = indexSourceOutcomes(srcEvents);
  }
  // Cycle detection + snapshot construction.
  let graph: SchedulerGraph;
  let snapshot: SchedulerSnapshot;
  try {
    graph = buildGraph(definition);
    snapshot = options.resumeSnapshot
      ? hydrateSnapshot(definition, options.resumeSnapshot)
      : freshSnapshot(definition);
  } catch (err) {
    const code = (err as Error & { code?: string }).code ?? 'workflow_invalid';
    const message = err instanceof Error ? err.message : String(err);
    await emitTerminalFailure({ storage, runId: run.runId, error: { code, message } });
    return { status: 'failed' };
  }

  // ctx.suspend/ctx.interrupt resume: nodeId → seeded resolution. The resumed
  // node is re-queued (state 'ready') and runOneNode reads this so the node's
  // ctx.suspend returns the value instead of suspending again (interrupt.md §key).
  const reinvokeResolutions = new Map<string, { resumeKey: string; value: unknown }>();

  // CS-WF-3 (ADR 0326) — bounded node-level retry. Attempt counter per node,
  // per executeRun invocation: retries are a LIVE-execution concern; a replay
  // re-drives the same recorded started/failed/started/completed event
  // sequence through this same loop (identical control flow ⇒ identical
  // observable events), only the backoff sleep is skipped.
  const nodeAttempts = new Map<string, number>();
  // Retry timers pending wake (see the failure branch): the drain loop treats
  // pending>0 as live work (not a stall) and races `retrySignal` in its wait.
  let pendingRetryTimers = 0;
  let retrySignalResolve: () => void = () => {};
  let retrySignal = new Promise<void>((r) => { retrySignalResolve = r; });
  const armRetrySignal = (): void => { retrySignal = new Promise<void>((r) => { retrySignalResolve = r; }); };

  // When resuming from the legacy linear path (`resumeFromNodeIndex`), seed
  // every prior node as completed using `resumeValue` as the seed input on
  // the resume target.
  if (options.resumeFromNodeIndex !== undefined && !options.resumeSnapshot) {
    for (let i = 0; i < options.resumeFromNodeIndex; i++) {
      const id = definition.nodes[i]?.nodeId;
      if (id) {
        snapshot.nodeState.set(id, 'completed');
        snapshot.nodeOutputs.set(id, { output: undefined });
      }
    }
    const resumeNode = definition.nodes[options.resumeFromNodeIndex]?.nodeId;
    if (resumeNode) {
      // Set the previous-node output to the resumed value so the resume target
      // sees it on its `input` port.
      const prev = definition.nodes[options.resumeFromNodeIndex - 1]?.nodeId;
      if (prev) snapshot.nodeOutputs.set(prev, { output: options.resumeValue });
      snapshot.nodeState.set(resumeNode, 'ready');
      releaseDownstream(prev ?? resumeNode, graph, snapshot);
    }
  }

  // Resume-by-snapshot: mark the resumed node as completed with the
  // resolve value. Emit `node.completed` so consumers tracking
  // per-node progress (FE step list, conformance assertions) see the
  // suspended node tick over from "suspended" → "completed" in the
  // event log. Without this, the FE renders the resumed approval /
  // clarification / refinement row as un-checked forever even after
  // the run completes, because `interrupt.resolved` doesn't
  // carry the same semantics (it tells the FE the interrupt is
  // closed, not that the node finished).
  if (options.resumeSnapshot && options.resumeNodeId) {
    // Two-layer redaction at the resume-time persistence boundary:
    //
    //   1. `stripSecretsFromPersisted` strips `__secret:*` reference
    //      tokens (BYOK ephemeral references the executor injects
    //      into node ctx). Structured-payload concern.
    //   2. `sanitizeFreeTextDeep` walks string leaves for
    //      accidentally-pasted upstream API keys. HITL approval
    //      cards carry a free-text `comment` field that users have
    //      pasted into in practice — without this, a paste of
    //      "approved, here's the key sk-... in case" lands the raw
    //      key in the event log.
    //
    // Order matters: `stripSecretsFromPersisted` first (removes
    // ephemeral-secret tokens entirely); `sanitizeFreeTextDeep` second
    // (replaces remaining free-text key shapes in-place).
    // Redact the resume value once at this boundary (BYOK reference tokens +
    // free-text key shapes a HITL approver may have pasted) before it flows
    // anywhere. Applies to BOTH resume styles.
    const safeResumeValue = sanitizeFreeTextDeep(stripSecretsFromPersisted(options.resumeValue));
    if (options.resumeStyle === 'reinvoke') {
      // ctx.suspend/ctx.interrupt node: re-run it with the resolution seeded so
      // it shapes the result into its real output ports. Re-queue as 'ready';
      // the draining loop re-invokes it and handles success/re-suspend/failure.
      reinvokeResolutions.set(options.resumeNodeId, { resumeKey: options.resumeKey ?? options.resumeNodeId, value: safeResumeValue });
      snapshot.nodeState.set(options.resumeNodeId, 'ready');
    } else {
      // Native return-and-resume node: map the (redacted) resume value onto the
      // node's `input` port and mark it completed without re-running.
      const outputs = { output: safeResumeValue };
      snapshot.nodeOutputs.set(options.resumeNodeId, outputs);
      snapshot.nodeState.set(options.resumeNodeId, 'completed');
      await eventLog.append({
        runId: run.runId,
        nodeId: options.resumeNodeId,
        type: 'node.completed',
        payload: stripSecretsFromPersisted({ nodeId: options.resumeNodeId, outputs }),
      });
      releaseDownstream(options.resumeNodeId, graph, snapshot);
    }
  }

  // ADR 0326 P3b — a checkpoint-snapshot resume (a branch fork's copied
  // prefix) hydrates settled node states with NO single resume target, so
  // nothing has released the prefix's downstream yet: re-derive readiness
  // from every settled node. `releaseDownstream` is idempotent and only
  // promotes pending nodes whose triggers are already satisfied, so this is
  // a pure re-derivation. (Interrupt resumes always carry `resumeNodeId`
  // and release through the branches above — this path is fork-only.)
  const isForkCheckpointResume = options.resumeSnapshot !== undefined && options.resumeNodeId === undefined;
  if (isForkCheckpointResume) {
    for (const id of snapshot.order) {
      const s = snapshot.nodeState.get(id);
      if (s === 'completed' || s === 'failed' || s === 'skipped') releaseDownstream(id, graph, snapshot);
    }
  }

  // Resolve all required secrets up-front (only on initial run; resumes
  // already have the run-secrets bundle in the ephemeral store). A fork's
  // checkpoint resume is a NEW run id with no ephemeral bundle — its suffix
  // nodes still need their credentialRefs resolved (ADR 0326 P3b).
  if (!isResume || isForkCheckpointResume) {
    try {
      await prepareRunSecrets(run, definition);
    } catch (err) {
      const code = err instanceof OpenwopError ? err.code : 'internal_error';
      const message = err instanceof Error ? err.message : String(err);
      await emitTerminalFailure({ storage, runId: run.runId, error: { code, message } });
      return { status: 'failed' };
    }

    // RFC 0003 §D — handoff-schema enforcement at dispatch. When the
    // workflow binds a manifest agent (`metadata.requiresAgentId`), the
    // bound agent's task/return handoff contract is validated against the
    // run inputs BEFORE any node executes: an off-contract task payload
    // (or a simulated off-schema return) fails the run with a structured
    // `handoff_*_schema_violation` error rather than silently dispatching
    // or persisting off-contract data. See `executor/handoffGate.ts`.
    const handoff = await enforceManifestHandoffContract({
      definition,
      runInputs: run.inputs,
      tenantId: run.tenantId,
    });
    if (!handoff.ok) {
      await emitTerminalFailure({
        storage,
        runId: run.runId,
        ...(handoff.nodeId !== undefined ? { nodeId: handoff.nodeId } : {}),
        error: handoff.error,
      });
      return { status: 'failed' };
    }
  }

  const maxConcurrency = maxConcurrentNodes();
  const nodeById = new Map(definition.nodes.map((n) => [n.nodeId, n]));
  // ADR 0617 D1a (review BLOCKER-1) — the run's chain lineage, read once from
  // the definition (the run row carries no chain stamp) for the surface bundle.
  const runChainId = chainIdOfDefinition(definition);
  /** In-flight node tasks. Set lets us race them with Promise.race when
   *  no new ready nodes are available — replaces the 5ms busy-wait poll
   *  used in earlier revisions. */
  const inflight = new Set<Promise<void>>();
  /** Per-node interrupt kind, captured at suspension time so finalizeRun
   *  can map kind → waiting-* status (approval → 'waiting-approval',
   *  cancellation → 'paused', else 'waiting-input'). */
  const suspendedKinds = new Map<string, string>();
  // ADR 0751 — the kinds were PERSISTED with the snapshot (`persistSnapshot`) and
  // never read back, so a resume that left a second gate open ended the run as
  // `waiting-input` whatever that gate was. Hydrate them for every node the
  // resumed snapshot still holds suspended.
  for (const [id, kind] of options.resumeSnapshot?.suspendedKinds ?? []) {
    if (snapshot.nodeState.get(id) === 'suspended') suspendedKinds.set(id, kind);
  }
  // ADR 0751 — a fork that inherited an OPEN gate re-creates its live interrupt
  // row before anything can report the run as waiting on it.
  if (isForkCheckpointResume) {
    const suspendedIds = [...snapshot.nodeState.entries()].filter(([, st]) => st === 'suspended').map(([id]) => id);
    const forked = await ensureForkInterrupts({ storage, suspend, run, suspendedNodeIds: suspendedIds });
    if (forked.unrecoverable.length > 0) {
      await emitTerminalFailure({
        storage,
        runId: run.runId,
        error: {
          code: 'fork_interrupt_unavailable',
          message: `the fork inherited open gate(s) ${forked.unrecoverable.join(', ')} whose source interrupt could not be found on this run's ancestry`,
        },
      });
      return { status: 'failed' };
    }
    for (const [id, kind] of forked.kinds) suspendedKinds.set(id, kind);
    // ADR 0755 (WIT-FORK-5) — the success path was silent; only the failure was visible.
    if (forked.recreated.length > 0) {
      log.info('fork_gate_recreated', { runId: run.runId, parentRunId: run.parentRunId, gates: forked.kinds.map(([nodeId, kind]) => ({ nodeId, kind })) });
    }
  }

  /** Per `run-options.md §recursionLimit` + `observability.md §cap.breached`:
   *  count node executions; emit `cap.breached {kind: 'node-executions'}`
   *  + transition the run to `failed` with `error.code:
   *  'recursion_limit_exceeded'` when configured cap is exceeded. The cap
   *  is `run.configurable.recursionLimit` (per spec) or `unset`/0/negative
   *  → no cap. */
  let nodeExecutionCount = 0;
  const recursionLimitRaw = (run.configurable as Record<string, unknown> | undefined)?.recursionLimit;
  const recursionLimit = typeof recursionLimitRaw === 'number' && recursionLimitRaw > 0
    ? recursionLimitRaw
    : Number.POSITIVE_INFINITY;

  /** Per RFC 0058 — wall-clock run bound. The effective deadline is
   *  `min(configurable.runTimeoutMs, host ceiling)`; the host ceiling always
   *  applies once advertised (`run-options.md §runTimeoutMs`: "Absent ⇒ only
   *  the host ceiling applies"). Measured from drain start ≈ `run.started`;
   *  time a run spends suspended for human input does not count against it
   *  (the clock is re-anchored when the executor re-enters on resume). On
   *  breach we emit `cap.breached {kind:'run-duration'}` then `run.failed`
   *  with `error.code:'run_timeout'`, mirroring the node-executions path. */
  const runTimeoutRaw = (run.configurable as Record<string, unknown> | undefined)?.runTimeoutMs;
  const requestedTimeoutMs = typeof runTimeoutRaw === 'number' && runTimeoutRaw > 0 ? runTimeoutRaw : undefined;
  const effectiveTimeoutMs = requestedTimeoutMs !== undefined
    ? Math.min(requestedTimeoutMs, RUN_DURATION_CEILING_MS)
    : RUN_DURATION_CEILING_MS;
  const runStartMs = Date.now();
  const runDeadlineAt = runStartMs + effectiveTimeoutMs;
  // ADR 0553 P3 — arm the run's cancellation signal for the whole body, so an
  // in-flight outbound request (today: `ctx.mcp.*`) learns about an RFC 0094
  // cancel or a deadline breach WHILE it is in flight. The loop below only sees
  // the deadline BETWEEN nodes and never re-reads the run row, so before this
  // there was nothing a node body could observe. Armed here rather than at each
  // adapter: one signal per run is the point.
  armRunAbort(run.runId, runDeadlineAt);

  /**
   * Which RFC 0151 trigger a terminal failure should unwind under.
   *
   * `finalizeRun` called `unwindTerminatedRun` with no trigger, so EVERY unwind
   * was labelled `node-failure` — including one caused by a cap breach. That is
   * wrong in both directions: a policy declaring `['cap-breach']` did not unwind
   * on the breach it named, and a policy declaring `['node-failure']` unwound on
   * a breach its author never asked about.
   */
  let terminalCause: TerminalCause | undefined;

  /**
   * ADR 0585 P0b — leave the run to its new owner, writing NOTHING.
   *
   * Deliberately not `emitTerminalFailure` and deliberately not
   * `unwindTerminatedRun`. This process is no longer authoritative for this
   * run, and both would be actively harmful:
   *
   *  - a terminal event is a LOST UPDATE on a row the new owner is also
   *    writing, plus a spurious `run.failed` in a log it is appending to; and
   *  - an unwind would fire compensation INVERSES — refunds, on this host —
   *    against effects the new owner is legitimately re-executing.
   *
   * The correct disposition for a losing executor is silence. The run is not
   * failed; it is somebody else's.
   */
  const abandonLostLease = async (): Promise<ExecuteRunResult> => {
    log.warn('run_abandoned_lease_lost', {
      runId: run.runId,
      instanceId: getInstanceId(),
      detail: 'another instance owns this run; wrote no terminal state and ran no compensation',
    });
    // `running` is what this process last knew the run to be, and it is still
    // true from the new owner's side. We are not asserting a transition.
    return { status: 'running', abandonedLeaseLost: true };
  };

  const breachRunDuration = async (): Promise<ExecuteRunResult> => {
    // RFC 0058 §A: the breach is "when the deadline PASSES", so `observed` MUST
    // be strictly greater than `limit`. #3222 made the batch-loop check strict
    // (`isRunDurationBreached`), but the deadline TIMER below can win the race
    // exactly ON the boundary (and Node timers may fire up to ~1ms early
    // relative to Date.now()), which minted `observed === limit` — the
    // `run-execution-bounds-shape` scenario's exact assertion. Wait out the
    // boundary HERE, at the one place the event is minted, so every caller
    // inherits the invariant instead of each re-checking.
    while (!isRunDurationBreached(Date.now(), runDeadlineAt)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    const observed = Date.now() - runStartMs;
    // Per RFC 0058 §C the breach event PRECEDES run.failed (same ordering the
    // node-executions breach relies on). `limit` = resolved ms, `observed` =
    // elapsed ms; both recorded so replay/:fork reuse them verbatim.
    await eventLog.append({
      runId: run.runId,
      type: 'cap.breached',
      payload: { kind: 'run-duration', limit: effectiveTimeoutMs, observed },
    });
    // RFC 0151 §B — unwind BEFORE the run is marked terminal.
    //
    // This path never reaches `finalizeRun`, so it never reached the only call
    // to `unwindTerminatedRun` either: a run that committed compensable effects
    // and then blew its duration cap left every obligation stranded at
    // `requested` forever, while a policy naming `cap-breach` — the trigger this
    // IS — sat unused. The unwind runs first so the plan exists before the run
    // reaches a terminal state, matching the ordering `finalizeRun` uses.
    // H102's guard, applied here too — and this site NEEDS it because of a change
    // in this very PR. Before H58d the cap-breach path never reached an unwind,
    // so nothing here could throw; H58d gives it obligations (correctly), and the
    // throw path arrives with them. `unwindTerminatedRun` -> `resolveObligation`
    // throws on a stale view, an illegal transition, and — since the ADR 0554 P4
    // CAS — CONTENTION. Unguarded, any of those would propagate past
    // `emitTerminalFailure` below and the cap breach would lose its terminal event
    // entirely: a run that stopped, with no `run.failed` and no dead-letter row.
    //
    // Found in review by openwop-app-54, who checked all five unwind call sites
    // this PR touches rather than only the one H102 fixed. The other four were
    // already guarded (`unwindCancelledRun`, and `runDispatch`/`runDispatchSweeper`
    // via `unwindOnDispatchTerminal`); this was the only inconsistency, and it was
    // one I introduced.
    //
    // RECORD, DO NOT SWALLOW: the error rides the terminal event's existing
    // payload, so the cap breach says WHY the unwind did not complete.
    let compensationError: string | undefined;
    try {
      await unwindTerminatedRun({ storage, run, definition, trigger: compensationTriggerFor('run-duration-cap') });
    } catch (unwindErr) {
      compensationError = unwindErr instanceof Error ? unwindErr.message : String(unwindErr);
    }
    await emitTerminalFailure({
      storage,
      runId: run.runId,
      ...(compensationError !== undefined ? { compensationError } : {}),
      error: {
        code: 'run_timeout',
        message: `Run exceeded effective runTimeoutMs=${effectiveTimeoutMs}ms (elapsed ${observed}ms).`,
      },
    });
    return { status: 'failed' };
  };

  function launch(nodeId: string): void {
    const nodeRef = nodeById.get(nodeId);
    const task = (async () => {
      if (!nodeRef) {
        markFailed(nodeId, { code: 'internal_error', message: `node ${nodeId} not in definition` }, snapshot);
        return;
      }
      // Cap check BEFORE execution. The +1 is "this attempt would be
      // execution #N+1." Spec wants the breach event to PRECEDE
      // run.failed (per `cap-breach` conformance assertion).
      if (nodeExecutionCount + 1 > recursionLimit) {
        await eventLog.append({
          runId: run.runId,
          nodeId,
          type: 'cap.breached',
          payload: {
            kind: 'node-executions',
            // Per `run-event-payloads.schema.json §capBreached.nodeId`:
            // duplicate nodeId in the payload so consumers reading the
            // event log JSON don't have to cross-reference the
            // RunEventDoc envelope's nodeId field.
            nodeId,
            limit: recursionLimit,
            observed: nodeExecutionCount + 1,
          },
        });
        // The run is about to fail because a CAP was breached, not because a
        // node's own work failed. `finalizeRun` cannot tell the difference from
        // the disposition alone, so it is recorded here.
        terminalCause = 'node-executions-cap';
        markFailed(nodeId, {
          code: 'recursion_limit_exceeded',
          message: `Run exceeded configurable.recursionLimit=${recursionLimit} at node '${nodeId}'.`,
        }, snapshot);
        return;
      }
      nodeExecutionCount++;
      // ADR 0549 P3 / RFC 0150 §B — the node body is about to run, so its
      // logical-invocation ordinals restart at 0. Without this a body that
      // re-enters at the same attempt (a HITL suspend/resume re-runs the
      // handler from the top) would allocate ordinal 1 for the effect it had
      // already performed as ordinal 0, mint a fresh identity, and fire it a
      // second time.
      beginNodeActivity(run.runId, nodeId, nodeAttempts.get(nodeId) ?? 1);
      const inputsByPort = buildNodeInputs(nodeId, graph, snapshot, run.inputs);
      const out = await runOneNode({
        storage,
        run,
        nodeRef,
        inputsByPort,
        attempt: nodeAttempts.get(nodeId) ?? 1, // ADR 0326 P3a — real attempt threading
        ...(runChainId ? { chainId: runChainId } : {}),
        ...(options.replayInvocationsFromRunId ? { replayInvocationsFromRunId: options.replayInvocationsFromRunId } : {}),
        ...(sourceOutcomes ? { sourceOutcomes } : {}),
        ...(options.policyResolver ? { policyResolver: options.policyResolver } : {}),
        ...(reinvokeResolutions.has(nodeId) ? { suspendResolution: reinvokeResolutions.get(nodeId)! } : {}),
      });
      if (out.kind === 'success') {
        markCompleted(nodeId, out.outputs, snapshot);
        // ADR 0554 P2 — the forward effect COMMITTED, so if its author declared
        // an inverse (RFC 0151 §B) the run now owes one. Recorded here rather
        // than at the effect seam because the DECLARATION hangs on the node, and
        // recorded before anything downstream can fail, so a later failure finds
        // a complete plan. The ordinal counter is scoped to the ROOT run, which
        // is what makes the reverse order depth-first through sub-runs.
        await recordForwardObligation({
          run,
          node: nodeRef,
          observedEffectKinds: out.observedEffectKinds,
          outputs: out.outputs,
          rootRunId: compensationRootRunId,
          // RFC 0151 §B (S36) — the mint needs the POLICY, because
          // `waiveRequiresApproval`'s default is the POST-escalation
          // `requiresApproval` and §B stamps it at mint time.
          ...(definition.settings?.compensation ? { policy: definition.settings.compensation } : {}),
        });
        releaseDownstream(nodeId, graph, snapshot, (skippedId, reason) =>
          // ADR 0208 — a routing branch that doesn't fire otherwise leaves no
          // trace; surface WHY a node was skipped (false condition vs upstream).
          log.debug('node_skipped', { runId: run.runId, nodeId: skippedId, reason, by: nodeId }),
        );
        // ADR 0083 follow-up — capture a MID-GRAPH deliverable as a durable artifact at
        // completion. A node that declares an `outputRole` is an explicit deliverable; Seam B
        // only captures TERMINAL nodes, so an asset produced mid-flow (e.g. a rendered PDF that
        // then feeds a notify) would be dropped. Scope to mid-graph (has outgoing edges) — a
        // terminal outputRole node is already captured by Seam B. Best-effort, replay-safe
        // (deterministic key, no event); skipped on a replay fork. Captured here (not at
        // finalizeRun) so the deliverable survives even if a LATER node fails.
        const hasOutgoing = (graph.outgoing.get(nodeId)?.length ?? 0) > 0;
        if (nodeRef.outputRole && hasOutgoing && run.forkMode !== 'replay') {
          await persistRunArtifact({
            tenantId: run.tenantId,
            runId: run.runId,
            nodeId,
            role: 'deliverable',
            output: unwrapSingleOutput(out.outputs),
            now: new Date().toISOString(),
          });
        }
      } else if (out.kind === 'interrupted') {
        noteInterruptedNode(run.runId, nodeId);
        // ADR 0632 — the node stopped because an `immediate` pause fired the
        // abort signal, not because it failed: it goes back to `ready` and is
        // re-executed on resume (idempotent per the Layer-2 invocation log).
        snapshot.nodeState.set(nodeId, 'ready');
        log.info('node_pause_aborted', { runId: run.runId, nodeId });
      } else if (out.kind === 'failure') {
        // CS-WF-3 (ADR 0326) — bounded, OPT-IN node retry. A node whose config
        // declares `retry: { maxAttempts: N }` (host-honored config key — node
        // config is host-side, not wire) is re-queued up to N total attempts
        // for retryable failure classes. Each attempt emits its own
        // node.started/node.failed pair (existing event vocabulary — the log IS
        // the attempt record; `observability.md` attempt spans remain a
        // follow-up), the recursion cap still bounds total executions, and the
        // exponential backoff is skipped on replay (events, not wall-clock,
        // carry determinism).
        const maxAttempts = nodeRetryMaxAttempts(nodeRef);
        const attempt = nodeAttempts.get(nodeId) ?? 1;
        if (attempt < maxAttempts && !NON_RETRYABLE_NODE_ERRORS.has(out.error.code)) {
          nodeAttempts.set(nodeId, attempt + 1);
          log.info('node_retry_scheduled', { runId: run.runId, nodeId, attempt: attempt + 1, maxAttempts, code: out.error.code });
          // Grade-code fix (2026-07-09 session grade): backoff must NOT hold a
          // concurrency slot — the task ends NOW (freeing the slot) and a timer
          // flips the node back to 'ready' + wakes the drain loop. Replay uses
          // a 0ms timer (identical control flow; no wall-clock dependence).
          const backoffMs = run.forkMode === 'replay' ? 0 : Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1), RETRY_BACKOFF_CAP_MS);
          pendingRetryTimers += 1;
          setTimeout(() => {
            pendingRetryTimers -= 1;
            snapshot.nodeState.set(nodeId, 'ready');
            retrySignalResolve();
          }, backoffMs);
          return;
        }
        markFailed(nodeId, out.error, snapshot);
        // ADR 0476 (review H1) — `currentNodeId` is stamped at node START, so
        // under parallel branches a failed run's row pointed at the LAST-
        // STARTED node, not the failing one — poisoning the fleet hotspot
        // aggregation AND the runs.diagnose grounding. Re-stamp at terminal
        // node failure so the row names the node that actually failed.
        // Best-effort: attribution must never break execution.
        await storage.updateRun(run.runId, { currentNodeId: nodeId }).catch(() => {});
        releaseDownstream(nodeId, graph, snapshot, (skippedId, reason) =>
          // ADR 0208 — a routing branch that doesn't fire otherwise leaves no
          // trace; surface WHY a node was skipped (false condition vs upstream).
          log.debug('node_skipped', { runId: run.runId, nodeId: skippedId, reason, by: nodeId }),
        );
      } else {
        // ADR 0083 — persist the gate's upstream output as a durable run-artifact and bind
        // its artifactId onto the interrupt so the approval card / Reviews rail can open the
        // full preview (reviewProjection.artifactBinding reads data.artifactId). Best-effort,
        // replay-safe (deterministic key, no event emitted); skipped on a replay-mode fork
        // (the original run's artifacts are canonical, mirroring the memory-write gate).
        let interruptData: unknown = out.interrupt.data;
        // RFC 0199 §E.3 — a `credential` ask has no gate content to preview, and its
        // `CredentialData` is closed: binding a preview artifact onto it would make
        // the wire payload invalid.
        if (run.forkMode !== 'replay' && out.interrupt.kind !== 'credential') {
          const preview = await persistRunArtifact({
            tenantId: run.tenantId,
            runId: run.runId,
            nodeId,
            role: 'gate-preview',
            output: inputsByPort,
            now: new Date().toISOString(),
          });
          if (preview && interruptData && typeof interruptData === 'object' && !Array.isArray(interruptData)) {
            interruptData = { ...(interruptData as Record<string, unknown>), artifactId: preview.artifactId, revisionId: preview.revisionId };
          }
        }
        const interrupt = await suspend.createInterrupt({
          runId: run.runId,
          nodeId,
          kind: out.interrupt.kind,
          data: interruptData,
          resumeSchema: out.interrupt.resumeSchema,
        });
        await eventLog.append({
          runId: run.runId,
          nodeId,
          type: 'node.suspended',
          // ADR 0725 — `reason` is a seated field on `nodeSuspended` (RFC 0186):
          // carried from the interrupt data when the node named one (the
          // low-confidence gate's `reason: 'low-confidence'`), so the record says
          // WHY it suspended without a second hand-rolled row.
          // ADR 0725 (CORRECTED) — the DIAGNOSTIC keys the suspending node named,
          // carried onto the single `node.suspended` row. RFC 0002 CP-1 requires
          // `{reason, agentId, threshold, observed}` on the low-confidence suspend
          // (`agentConfidenceEscalation` asserts all four), which the first cut of
          // this change dropped when it removed the mock agent's duplicate
          // hand-emitted row: the duplicate was the defect (no `interruptId`, two
          // rows for one suspension), its ENRICHMENT was not. An ALLOWLIST, not a
          // spread: interrupt data carries approval artifacts and caller content,
          // which must not reach the log. `reason` is seated on `nodeSuspended`;
          // the other three are undeclared, so a major-2 read boxes them under
          // `vendor.openwop-app` (RFC 0185 §C) and the v1 read keeps them flat.
          payload: stripSecretsFromPersisted({ interruptId: interrupt.interruptId, kind: interrupt.kind, ...suspendDiagnostics(interruptData) }),
        });
        if (interrupt.kind === 'credential') {
          // RFC 0199 §E.3 — the `credential` ask is a closed wire object
          // (`suspend-request` + `CredentialData`), so it is written as exactly
          // that: the engine's own `__resume*` routing keys stay on the stored
          // record and never reach the event. (This host records other kinds as
          // `node.suspended` only; that wider gap is ADR 0753's, not this kind's.)
          const { __resumeKey: _rk, __resumeStyle: _rs, ...credentialData } = (interruptData ?? {}) as Record<string, unknown>;
          await eventLog.append({
            runId: run.runId,
            nodeId,
            type: 'interrupt.requested',
            payload: { kind: 'credential', key: nodeId, data: credentialData, resumeSchema: interrupt.resumeSchema },
          });
        }
        suspendedKinds.set(nodeId, out.interrupt.kind);
        markSuspended(nodeId, snapshot);
      }
    })();
    // ADR 0585 P0b — a LeaseLostError must never REJECT this task. The
    // scheduling loop awaits `Promise.race(inflight)`, so a rejection escapes
    // `executeRunBody`, escapes `executeRun`, and lands in
    // `dispatchRunInBackground`'s catch — which marks the run FAILED. That is
    // precisely the write a losing owner must not make.
    //
    // Swallowed here, deliberately: the guard already recorded the loss, and
    // the loop's `hasLostDispatchLease` check abandons on its next turn. The
    // node simply stops; it is not failed, because this process is no longer
    // the one entitled to say so.
    const guarded = task.catch((err: unknown) => {
      if (err instanceof LeaseLostError) {
        log.warn('node_stopped_lease_lost', { runId: run.runId, nodeId, effectKind: err.effectKind });
        return;
      }
      throw err;
    });
    // Self-remove on settle so Promise.race doesn't see completed tasks.
    const wrapped = guarded.finally(() => { inflight.delete(wrapped); });
    inflight.add(wrapped);
  }

  /**
   * ADR 0585 P0 — the executor's liveness heartbeat.
   *
   * Renewal rides the SCHEDULING LOOP rather than a `setInterval`, deliberately.
   * The ADR's own falsifiability note names the failure a timer would have: on
   * Cloud Run with `cpu-throttling=true` a suspended instance stops executing
   * timers, so a timer-driven heartbeat would stop renewing for a run that is
   * merely throttled — the false-dead case, and this host has already been
   * bitten by a detached continuation that never resumed. A renewal that happens
   * where work happens cannot claim liveness the process does not have.
   *
   * `await`ed, not fire-and-forget, for the same reason: a detached write is
   * exactly what CPU throttling drops. The cost is bounded — one storage write
   * per `RUN_LEASE_HEARTBEAT_MS`, not per loop turn.
   *
   * Best-effort on failure, matching the dispatch-time write: the lease is an
   * availability optimisation, never a correctness gate, so a storage blip must
   * not abort a healthy run. It IS logged — a silent renewal failure would mean
   * a live run's lease lapsing with nothing to read afterwards.
   */
  let lastLeaseRenewalAt = Date.now();
  const renewDispatchLeaseIfDue = async (): Promise<void> => {
    const now = Date.now();
    if (!isLeaseRenewalDue(now, lastLeaseRenewalAt)) return;
    // Advance BEFORE the await: a slow or failing write must not queue a renewal
    // on every subsequent loop turn.
    lastLeaseRenewalAt = now;
    try {
      // ADR 0585 P0b — CONDITIONAL on still being the owner. The unconditional
      // `setRunDispatchLease` is correct at dispatch (we are claiming) and a
      // defect as a heartbeat: a reclaimed-then-resumed instance would take the
      // run BACK from its new owner and self-renew, and the sweeper would then
      // see a healthy lease and never re-reclaim.
      const stillOurs = await storage.renewRunDispatchLeaseIfOwner(
        run.runId, getInstanceId(), Date.now() + RUN_DISPATCH_LEASE_MS,
      );
      if (!stillOurs) {
        // The renewal we were making anyway IS the liveness probe — no extra
        // read buys this. Publish it to the effect guard so the next seam this
        // process reaches refuses rather than double-fires.
        markDispatchLeaseLost(run.runId);
        log.error('dispatch_lease_lost', {
          runId: run.runId,
          instanceId: getInstanceId(),
          detail: 'run was reclaimed by another instance; abandoning without writing terminal state',
        });
      }
    } catch (err) {
      // A FAILED WRITE IS NOT A LOST LEASE, and conflating them would be the
      // worse error: a storage blip would make a healthy owner abandon a run
      // nobody else has claimed. Degraded storage keeps the old behaviour —
      // warn and carry on.
      log.warn('dispatch_lease_renew_failed', {
        runId: run.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /**
   * Drain ready queue with bounded concurrency. Returns when no more nodes
   * can run without external input.
   */
  while (true) {
    // RFC 0058 — trip the wall-clock bound before scheduling more work.
    if (isRunDurationBreached(Date.now(), runDeadlineAt)) return await breachRunDuration();

    await renewDispatchLeaseIfDue();

    // ADR 0632 — the PAUSE drain point. A pause request (in-process, or the
    // durable copy on the run row when another instance took the request)
    // stops the scheduler from launching anything more; once nothing is in
    // flight the run transitions to `paused` with its ready set recorded, and
    // this process returns — resume re-enters through `executeRun`.
    const pauseReq = runPauseRequest(run.runId) ?? await readPersistedPauseRequest(storage, run.runId);
    if (pauseReq && inflight.size === 0) {
      return await pauseRun({ storage, run, snapshot, suspendedKinds, request: pauseReq });
    }
    const slots = pauseReq ? 0 : Math.max(0, maxConcurrency - inflight.size);
    const batch = slots > 0 ? popReady(slots, snapshot) : [];

    if (batch.length === 0 && inflight.size === 0 && pendingRetryTimers === 0) {
      const disp = inspectDisposition(snapshot, graph, 0);
      if (disp.done) {
        return await finalizeRun({
          storage, run, snapshot, graph, definition, disposition: disp, suspendedKinds, nodeAttempts,
          ...(terminalCause ? { compensationTrigger: compensationTriggerFor(terminalCause) } : {}),
        });
      }
      await emitTerminalFailure({
        storage,
        runId: run.runId,
        error: { code: 'internal_error', message: 'scheduler stalled — no ready, no running, no suspended' },
      });
      return { status: 'failed' };
    }

    if (batch.length === 0) {
      // No newly-ready nodes; wait for one in-flight node to settle so we
      // can re-evaluate readiness. Promise.race resolves as soon as any
      // pending task settles (Note: .finally already removed it from the
      // set by the time we re-enter the loop). RFC 0058: race that wait
      // against the remaining deadline so a single long-running node can't
      // blow past the wall-clock bound unbounded.
      const remaining = Math.max(0, runDeadlineAt - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadlineHit = new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), remaining);
      });
      // ADR 0585 P0 — wake for the heartbeat too, or a SINGLE long-running node
      // starves renewal: the loop parks here until that node settles, which can
      // be the entire run-duration ceiling. Harmless today (the lease already
      // outlives the ceiling, so P0 is additive either way) and load-bearing for
      // P1, whose shorter reclaim threshold would otherwise declare a run with
      // one slow node dead. Found by reading the loop rather than by a test —
      // no P0 test can fail on it, because P0 cannot reclaim anything early.
      let beat: ReturnType<typeof setTimeout> | undefined;
      const heartbeatDue = new Promise<false>((resolve) => {
        beat = setTimeout(() => resolve(false), RUN_LEASE_HEARTBEAT_MS);
      });
      // With ONLY retry timers pending (no inflight tasks), Promise.race over
      // an empty set never settles — the retry signal is the wake source.
      const settled = inflight.size > 0
        ? Promise.race(inflight).then(() => false as const)
        : new Promise<false>(() => { /* no inflight — retrySignal/deadline wake us */ });
      const retried = retrySignal.then(() => false as const);
      const timedOut = await Promise.race([settled, retried, deadlineHit, heartbeatDue]);
      if (timer) clearTimeout(timer);
      if (beat) clearTimeout(beat);
      armRetrySignal(); // consumed-or-not, re-arm for the next wait
      if (timedOut) return await breachRunDuration();
      continue;
    }

    // ADR 0585 P0b — do not START new work for a run this process has lost.
    // The heartbeat above is the detector; this is the cheapest place to act on
    // it, because it is per-BATCH rather than per-effect and costs a `Set.has`.
    //
    // It closes the schedule-ahead case: without it, a process that learned of
    // the loss would keep launching nodes until something happened to reach an
    // effect seam. It does NOT close the node already in flight at resume —
    // that one is caught at the seam, and if it has no seam it is harmless.
    if (hasLostDispatchLease(run.runId)) return await abandonLostLease();

    for (const nodeId of batch) launch(nodeId);
  }
}

/** The durable copy of a pause request (`run.metadata.pauseRequest`), for a
 *  scheduler on an instance that did not take the request. */
async function readPersistedPauseRequest(storage: Storage, runId: string): Promise<RunPauseRequest | undefined> {
  const row = await storage.getRun(runId);
  const req = (row?.metadata as Record<string, unknown> | undefined)?.pauseRequest;
  return req && typeof req === 'object' ? (req as RunPauseRequest) : undefined;
}

/** ADR 0632 — the `running → paused` transition, once nothing is in flight. */
async function pauseRun(input: {
  storage: Storage; run: RunRecord; snapshot: SchedulerSnapshot;
  suspendedKinds: Map<string, string>; request: RunPauseRequest;
}): Promise<ExecuteRunResult> {
  const { storage, run, snapshot, suspendedKinds } = input;
  // Read the LATEST in-process request: `abortRunForPause` / `noteInterruptedNode`
  // replace the map entry after the loop captured `input.request`.
  const request = runPauseRequest(run.runId) ?? input.request;
  const interruptedNodeId = request.interruptedNodeIds?.[0];
  const pausedNodeIds = [...snapshot.nodeState.entries()].filter(([, st]) => st === 'ready').map(([id]) => id);
  await persistSnapshot(storage, run.runId, snapshot, suspendedKinds);
  const pausedAt = new Date().toISOString();
  const row = await storage.getRun(run.runId);
  const meta = { ...((row?.metadata as Record<string, unknown> | undefined) ?? {}) };
  delete meta.pauseRequest;
  meta.pausedAt = pausedAt;
  meta.pausedNodeIds = pausedNodeIds;
  await storage.updateRun(run.runId, { status: 'paused', metadata: meta as never });
  // Registry spelling (`schemas/v2/run-event-payloads.schema.json`, closed):
  // `drain` | `interrupt`; the request keeps the openapi spelling.
  await getEventLog().append({
    runId: run.runId,
    type: 'run.paused',
    payload: {
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
      // Bus ruling `b787` (rc.52): the payload ECHOES the request's word —
      // `immediate | drain-current-node`. The registry's former `drain | interrupt`
      // was an invented vocabulary with a false v1 citation and is gone at rc.52.
      drainPolicy: request.drainPolicy,
      ...(interruptedNodeId !== undefined ? { interruptedNodeId } : {}),
    },
  });
  clearRunPause(run.runId);
  log.info('run_paused', { runId: run.runId, drainPolicy: request.drainPolicy, pausedNodeIds });
  return { status: 'paused' };
}

async function finalizeRun(input: {
  storage: Storage;
  run: RunRecord;
  snapshot: SchedulerSnapshot;
  graph: SchedulerGraph;
  definition: WorkflowDefinition;
  disposition: ReturnType<typeof inspectDisposition>;
  suspendedKinds: Map<string, string>;
  /** RFC 0053 — per-node attempt counts, so the dead-letter row can report how
   *  many attempts the failing node actually consumed. */
  nodeAttempts: Map<string, number>;
  /** RFC 0151 §B — which trigger this terminal failure unwinds under. Absent
   *  means an ordinary node failure; a cap breach names itself. */
  compensationTrigger?: CompensationTrigger;
}): Promise<ExecuteRunResult> {
  const { storage, run, snapshot, definition, disposition, suspendedKinds } = input;
  const eventLog = getEventLog();

  // ── ADR 0553 P3 / ADR 0554 P2: a run that ALREADY reached terminal keeps the
  // status it reached ──────────────────────────────────────────────────────
  //
  // Every branch below writes `storage.updateRun(..., { status })` — `completed`,
  // `failed`, or a `waiting-*` — and none of them looked at what the row says
  // now. `run` is the in-memory record captured at run START, so it cannot
  // know: an RFC 0094 cancel (`host/runCancel.ts` → `cancelRunAndCascade`)
  // lands on the ROW while this function's caller is still draining nodes. The
  // result was that a run cancelled mid-flight flipped back to `completed` the
  // moment its last node finished — the cancel was accepted, audited, and then
  // silently undone.
  //
  // This is the same seam H50 named as the "finalizeRun-bypass choke": the
  // failure is not that the write is wrong, it is that NOTHING re-reads the row
  // between the cancel and the write.
  //
  // Guarded ONCE at the top rather than at each write, because the event
  // appends happen BEFORE the status writes — a per-write guard would still
  // have emitted `run.completed` into the log of a cancelled run, which is a
  // worse lie than the status itself (the event stream is the durable record).
  //
  // **This narrows the window; it does not close it, and saying so matters.**
  // `Storage.updateRun` has no compare-and-swap, so a cancel that lands between
  // this read and the write below still wins the write and loses the status —
  // a legal-transition check is not a CAS. Making it atomic needs a
  // status-conditional write on the storage interface, which is a lifecycle
  // change and deliberately out of scope here. The unguarded version lost the
  // status for the ENTIRE duration of the final node; this one loses it only
  // for the microseconds between a read and a write.
  const recordedStatus = (await storage.getRun(run.runId))?.status;
  if (recordedStatus !== undefined && isTerminalRunStatus(recordedStatus) && recordedStatus !== disposition.status) {
    log.info('finalize_skipped_terminal_run', { runId: run.runId, recorded: recordedStatus, would: disposition.status });
    // No cast: `ExecuteRunResult['status']` IS `RunRecord['status']`, so one was
    // never needed — and a gratuitous cast is how a genuine mismatch gets
    // silenced later.
    return { status: recordedStatus };
  }

  if (disposition.status === 'completed') {
    // Aggregate the outputs of every node with no outgoing edges (terminal
    // nodes) as the run's output. For pure-linear workflows this matches the
    // legacy executor exactly.
    const terminals = definition.nodes
      .map((n) => n.nodeId)
      .filter((id) => (input.graph.outgoing.get(id)?.length ?? 0) === 0)
      .filter((id) => snapshot.nodeState.get(id) === 'completed');
    let output: unknown;
    if (terminals.length === 1) {
      const terminalOutputs = snapshot.nodeOutputs.get(terminals[0]!);
      output = unwrapSingleOutput(terminalOutputs);
    } else if (terminals.length > 1) {
      output = Object.fromEntries(
        terminals.map((id) => [id, unwrapSingleOutput(snapshot.nodeOutputs.get(id))]),
      );
    }
    // RFC 0004 demo: the host writes a run-summary to the tenant's memory on
    // completion (the "session-end write" the spec sanctions). Best-effort —
    // a memory write must never fail the run.
    //
    // Ordering: this MUST happen BEFORE the `run.completed` append.
    // observability.md §"Terminal events" requires the terminal event to be
    // the LAST event in the stream (pinned by eventOrdering.test.ts and the
    // streamReconnect post-terminal reconnect probe) — appending
    // `memory.written` after `run.completed` violates that contract.
    //
    // RFC 0057 §D (replay determinism): skip this on a `replay`-mode fork.
    // Re-executing a recorded run MUST NOT mint a new `memoryId` or re-emit
    // `memory.written` — the original run's event is the canonical recorded
    // fact. `branch`-mode forks are genuinely new runs and legitimately write
    // (and attribute) their own memory.
    if (run.forkMode !== 'replay') {
    // ADR 0083 — persist each terminal node's output as a durable run-artifact so the chat
    // completion card + the Library can preview/open it. Best-effort, replay-safe
    // (deterministic key, no event), BEFORE the run.completed append (terminal-event order).
    for (const id of terminals) {
      await persistRunArtifact({
        tenantId: run.tenantId,
        runId: run.runId,
        nodeId: id,
        role: 'deliverable',
        output: unwrapSingleOutput(snapshot.nodeOutputs.get(id)),
        now: new Date().toISOString(),
      });
    }
    try {
      const preview = JSON.stringify(output ?? null);
      const summaryTags = ['run-summary', `run-id:${run.runId}`, `workflow:${run.workflowId}`];
      // SR-1 (`agent-memory.md` §SR-1) — this content embeds a slice of the
      // run's OUTPUT, which can carry a value the run's BYOK vault resolved, so
      // it MUST go through the redacting chokepoint rather than the bare write.
      // Safe here because `clearRunSecrets(run.runId)` runs later in this same
      // finalisation path — the per-run keyring is still live at this point.
      const summaryRow = await writeMemoryEntryRedacted(
        run.tenantId,
        MEMORY_DEMO_REF,
        {
          // Deterministic id (DUR-2, ADR 0195): a crash-retry / re-dispatch of
          // the same run UPSERTS this row in the durable store instead of
          // accreting duplicate summaries across restarts.
          id: `runsummary:${run.runId}`,
          content:
            `Run ${run.runId} of "${run.workflowId}" completed` +
            (preview && preview !== 'null' ? ` → ${preview.slice(0, 280)}` : '.'),
          tags: summaryTags,
        },
        run.runId,
      );
      // RFC 0057 — attribute the write on the event log (content-free:
      // identifiers + non-secret tags only; never the entry content). This is
      // a host session-end write, so `nodeId` is omitted per RFC 0057 §B. The
      // host advertises capabilities.memory.attribution.emitsWriteEvents.
      await eventLog.append({
        runId: run.runId,
        type: 'memory.written',
        payload: { memoryRef: MEMORY_DEMO_REF, memoryId: summaryRow.id, tags: summaryTags },
      });
    } catch {
      /* memory is a demo surface; never block run completion */
    }
    } else if (typeof run.parentRunId === 'string') {
      // RFC 0057 §"Why the spec was silent" — on replay the `memory.written`
      // event is "re-read from the log, never regenerated": the durable write
      // is suppressed (no new memoryId, no row), but the recorded fact is
      // replayed VERBATIM into the fork's log so the observable sequence stays
      // byte-equivalent per RFC 0041 §C (regenerating would embed the fork's
      // runId in memoryId/tags and break equivalence). Session-end writes only
      // (no nodeId, RFC 0057 §B) — node-attributed writes replay with their node.
      try {
        const parentEvents = await storage.listEvents(run.parentRunId);
        for (const ev of parentEvents) {
          if (ev.type === 'memory.written' && ev.nodeId === undefined) {
            await eventLog.append({ runId: run.runId, type: 'memory.written', payload: ev.payload });
          }
        }
      } catch {
        /* best-effort, like the live write */
      }
    }
    await eventLog.append({
      runId: run.runId,
      type: 'run.completed',
      // `outputs`, PLURAL: $defs/runCompleted is { outputs, durationMs } in BOTH the
      // v1 and v2 payload schemas. This host emitted `output` for its whole life;
      // v1's `additionalProperties: true` tolerated it and v2's `false` exposed it
      // (v2-payload-registry-closed). Stored era-2 events keep `output` -- readers
      // accept both (`outputs ?? output`); nothing historical is rewritten.
      // `outputs` MUST be an object (both schemas type it so). A workflow whose
      // terminal value is a scalar or an array is wrapped as `{ output }` -- the
      // same normalisation node outputs get (`outputsObj` above). Under the old
      // `{ output }` key no type applied because the key was not the schema's;
      // `test/run-event-payload-conformance` caught the scalar fixture the moment
      // the key became real.
      payload: stripSecretsFromPersisted({
        outputs: output !== null && typeof output === 'object' && !Array.isArray(output)
          ? (output as Record<string, unknown>)
          : { output },
      }),
    });
    await storage.updateRun(run.runId, { status: 'completed', completedAt: new Date().toISOString() });
    // ADR 0476 §1 — durable cost stamp at the terminal seam (best-effort).
    // ADR 0482 §2 — the spend-day fold consumes the SAME usd the stamp computed.
    const completedSpendUsd = await stampRunCostOnTerminal(storage, run.runId);
    void foldWorkflowSpendOnTerminal(storage, run.runId, completedSpendUsd);
    // ADR 0480 — online eval scoring (fire-and-forget; production runs only).
    void scoreOnlineEvalsOnTerminal(storage, run.runId);
    clearRunSecrets(run.runId);
    notifyRunTerminal(run.runId, 'completed');
    return { status: 'completed' };
  }
  if (disposition.status === 'failed') {
    const failedNodeId = disposition.failedNodeId;
    const err = (failedNodeId ? snapshot.nodeErrors.get(failedNodeId) : undefined) ?? {
      code: 'internal_error',
      message: 'unknown node failure',
    };
    // ADR 0554 P2 — the run failed AFTER committing effects, so unwind what it
    // owes BEFORE the terminal event. `observability.md` §"Terminal events"
    // requires `run.failed` to be the LAST event in the stream, and it is also
    // the honest order: the unwind happens while the run is dying.
    //
    // No `compensating` run status is set, and that is deliberate — RFC 0151 §D
    // keeps the forward `status` untouched and carries the unwind on a separate
    // `compensationStatus` rollup. A run ending `status: failed` with every
    // inverse discharged is the SUCCESSFUL outcome here.
    // H102 — the unwind MUST NOT be able to consume the terminal event.
    //
    // `unwindTerminatedRun` -> `resolveObligation` throws on three conditions:
    // a stale view, an illegal transition, and (since the ADR 0554 P4 CAS)
    // CONTENTION — eight lost compare-and-swaps on one obligation. This call was
    // unguarded, and the nearest enclosing `catch` is ~520 lines above, so any of
    // those threw straight past `emitTerminalFailure` below: the run lost its
    // `run.failed` event AND its dead-letter attribution, and the only trace that
    // it ended at all was its absence.
    //
    // Tonight's recurring shape — an early failure consuming the step behind it —
    // and here the consumed step is the one that tells every consumer the run is
    // over. The hazard PREDATES the CAS (stale-view could already do it); what the
    // CAS added is a LOAD-TRIGGERED path to a throw that was previously reachable
    // only by operator race, which makes it likeliest during recovery under
    // contention — exactly when the terminal event matters most.
    //
    // RECORD, DO NOT SWALLOW. Losing the compensation failure to save the terminal
    // event just moves the hole. The error rides `emitTerminalFailure`'s existing
    // payload (`_errorObject` is `additionalProperties: true`, the same additivity
    // the classifier enrichment below already relies on), so the terminal event
    // says WHY the unwind did not complete instead of the failure vanishing.
    let compensationError: string | undefined;
    try {
      await unwindTerminatedRun({
        storage, run, definition,
        trigger: input.compensationTrigger ?? compensationTriggerFor('node-failure'),
      });
    } catch (unwindErr) {
      compensationError = unwindErr instanceof Error ? unwindErr.message : String(unwindErr);
    }
    // RFC 0053 — name the failing node + its attempt count on the dead-letter
    // row. `node.failed` was already appended when the node died, so pass only
    // the dead-letter attribution, not `nodeId` (which would re-append it).
    await emitTerminalFailure({
      storage,
      runId: run.runId,
      error: err,
      ...(failedNodeId ? { deadLetterNodeId: failedNodeId, attempts: input.nodeAttempts.get(failedNodeId) ?? 1 } : {}),
      ...(compensationError !== undefined ? { compensationError } : {}),
    });
    return { status: 'failed' };
  }
  // Waiting on suspended branch(es).
  const suspendedIds = [...snapshot.nodeState.entries()]
    .filter(([, s]) => s === 'suspended')
    .map(([id]) => id);
  const firstSuspended = disposition.suspendedNodeId ?? suspendedIds[0]!;
  const interruptKind = inferWaitingKind(firstSuspended, suspendedKinds);
  await storage.updateRun(run.runId, { status: interruptKind, currentNodeId: firstSuspended });
  // Persist scheduler snapshot for resume.
  await persistSnapshot(storage, run.runId, snapshot, suspendedKinds);
  // Back-compat: also surface pausedAtIndex for legacy callers when the
  // workflow is purely linear and exactly one node is suspended.
  // Defensive: a registered fixture/pack edge may carry `id` instead of
  // `edgeId` (the corpus fixture shape) — `.startsWith` on undefined here
  // crashed the WHOLE suspend disposition, converting a correct suspension
  // into run.failed (found via conformance-multi-agent-confidence-escalation).
  // linearShape=false is the safe degradation: pausedAtIndex is legacy-only.
  const linearShape = (input.definition.edges ?? []).every((e) => typeof e.edgeId === 'string' && e.edgeId.startsWith('implicit_'));
  const pausedAtIndex =
    suspendedIds.length === 1 && linearShape
      ? input.definition.nodes.findIndex((n) => n.nodeId === firstSuspended)
      : undefined;
  return {
    status: interruptKind,
    pausedNodeIds: suspendedIds,
    ...(pausedAtIndex !== undefined && pausedAtIndex >= 0 ? { pausedAtIndex } : {}),
  };
}

function inferWaitingKind(
  nodeId: string,
  suspendedKinds: Map<string, string>,
): RunRecord['status'] {
  const kind = suspendedKinds.get(nodeId);
  if (kind === 'approval') return 'waiting-approval';
  if (kind === 'cancellation') return 'paused';
  if (kind === 'external-event') return 'waiting-external';
  return 'waiting-input';
}

function unwrapSingleOutput(outputs?: Record<string, unknown>): unknown {
  if (!outputs) return undefined;
  if ('output' in outputs && Object.keys(outputs).length === 1) return outputs.output;
  return outputs;
}

/* ─── Snapshot persistence (for resume) ─────────────────────── */

/** Persisted scheduler snapshot. The version tag lets a future schema
 *  change (e.g., adding per-node attempt counters) refuse incompatible
 *  resume rather than silently producing wrong state. Sample is in-memory
 *  so this only matters across in-process re-init, but the discipline
 *  prevents the bug class from leaking into the host storage shape. */
export interface SerializedSnapshot {
  schemaVersion: 1;
  nodeState: Array<[string, string]>;
  nodeOutputs: Array<[string, Record<string, unknown>]>;
  nodeErrors: Array<[string, { code: string; message: string }]>;
  /** Per-node interrupt kind, mirrored from `suspendedKinds`. */
  suspendedKinds?: Array<[string, string]>;
}

async function persistSnapshot(
  storage: Storage,
  runId: string,
  snapshot: SchedulerSnapshot,
  suspendedKinds: Map<string, string>,
): Promise<void> {
  const ser: SerializedSnapshot = {
    schemaVersion: 1,
    nodeState: [...snapshot.nodeState.entries()].map(([k, v]) => [k, v]),
    nodeOutputs: [...snapshot.nodeOutputs.entries()],
    nodeErrors: [...snapshot.nodeErrors.entries()],
    suspendedKinds: [...suspendedKinds.entries()],
  };
  await storage.updateRun(runId, { schedulerSnapshot: JSON.stringify(ser) as never });
}

function hydrateSnapshot(
  definition: WorkflowDefinition,
  ser: SerializedSnapshot,
): SchedulerSnapshot {
  if (ser.schemaVersion !== 1) {
    throw Object.assign(
      new Error(`unsupported scheduler snapshot version: ${(ser as { schemaVersion: number }).schemaVersion}`),
      { code: 'unsupported_snapshot_version' },
    );
  }
  const fresh = freshSnapshot(definition);
  for (const [id, s] of ser.nodeState) fresh.nodeState.set(id, s as never);
  for (const [id, o] of ser.nodeOutputs) fresh.nodeOutputs.set(id, o);
  for (const [id, e] of ser.nodeErrors) fresh.nodeErrors.set(id, e);
  return fresh;
}

/* ─── Secret prep (unchanged from linear executor) ─────────── */

async function prepareRunSecrets(run: RunRecord, definition: WorkflowDefinition): Promise<void> {
  // In OPENWOP_BYOK_EPHEMERAL=true mode the resolver needs the run's
  // tenant so it can find the right per-session bucket. Anon runs get
  // a session-derived tenant id ('anon:<sid>'); bearer-authed runs
  // pass the bearer's body.tenantId (still global in non-ephemeral
  // mode).
  const scope = { tenantId: run.tenantId };
  const required = new Map<string, string>();
  for (const node of definition.nodes) {
    const cfgRefs = (node.config?.credentialRefs as string[] | undefined) ?? [];
    for (const ref of cfgRefs) {
      const value = await resolveSecret(ref, scope);
      if (value) required.set(ref, value);
    }
  }
  // ADR 0712 — `declaredRunCredentialRefs` is the one reader: the host-set
  // `credentialRefs[]` AND the wire's `configurable.ai.credentialRef`.
  const cfgRefs = declaredRunCredentialRefs(run.configurable);
  for (const ref of cfgRefs) {
    // Managed credential refs (`managed:*`) are sentinels for the
    // server-held-key path in providers/managedProvider.ts — the node
    // (chat-responder / aiProvidersHost) detects the prefix and routes
    // dispatch through a different pipeline that owns its own
    // credential lookup, sign-in gating, and daily cap enforcement.
    // The resolver doesn't know about these refs (they live in the
    // shared byok_secrets table, not the per-tenant byok_tenant_secrets),
    // so skip resolution entirely. Authority for "is this actually
    // usable?" stays with the managed-dispatch path, which surfaces
    // `managed_unavailable` / `sign_in_required` / `daily_limit_reached`
    // at call time.
    if (ref.startsWith('managed:')) continue;
    const value = await resolveSecret(ref, scope);
    if (value) required.set(ref, value);
    else {
      throw new OpenwopError(
        'credential_unavailable',
        `Required credential ${ref} not resolved by host`,
        400,
        { credentialRef: ref },
      );
    }
  }
  if (required.size > 0) {
    setRunSecrets(run.runId, Object.fromEntries(required));
  }
}
