/**
 * ADR 0556 P1 — the label domains, and the ONE place a runtime value becomes a
 * metric label.
 *
 * P0 built the catalog and the cardinality guard; this is the other half the
 * guard cannot supply. `guardAttributes` refuses a label whose NAME is wrong.
 * It cannot refuse a label whose name is fine and whose VALUE is a customer
 * string — `outcome: err.message` passes the guard and takes the collector down
 * exactly the same way. So every dimension below is produced by a classifier
 * that maps into a closed set and folds everything else onto a sentinel
 * (`unknown`, `other`, `error`).
 *
 * WHY ONE MODULE RATHER THAN A HELPER PER SEAM. The classifiers are the
 * reviewable surface: reading this file tells you the complete set of values
 * every metric can take, which is the question an operator sizing a collector
 * actually asks. Spread across ten call sites, that answer requires ten greps
 * and is exactly how a `${provider}_${status}` sneaks in.
 *
 * Emission helpers live here too so a seam's instrumentation is one typed call
 * and cannot pass an attribute bag the catalog does not declare.
 *
 * Everything imported here is `import type` on purpose: this module is imported
 * BY the seams it measures (executor, host, routes), so a value import would
 * close a cycle. Instrumentation must not change module-load order.
 */

import type { Attributes } from '@opentelemetry/api';
import { addCount, recordValue, setGauge } from './metrics.js';
import type { EffectKind } from '../host/runEffectContext.js';
import type { IdempotentClaim, IdempotentEndpoint } from '../host/idempotentResponse.js';
import type { CompensationShape, CompensationState } from '../host/compensationLedger.js';
import type { RunTerminalStatus } from '../executor/runLifecycle.js';
import type { InterruptRecord, RunRecord } from '../types.js';
import type { WorkflowDefinition } from '../executor/types.js';

/* ── run + step ───────────────────────────────────────────────────────────── */

/**
 * How the workflow this run executes was authored.
 *
 * `chain` and `builtin` are the two shapes CLAUDE.md's chains-or-stacks
 * doctrine names; `stack` is a run started from a kanban card. `unknown` is
 * load-bearing rather than a fallback for laziness — see `recordRunTerminal`,
 * where a run this process did not start cannot be classified and saying so is
 * the honest answer.
 */
export type WorkflowKind = 'chain' | 'stack' | 'builtin' | 'unknown';

/** Run-metadata `source` values that mean "this run came off a kanban stack". */
const STACK_SOURCES = new Set(['kanban', 'kanban-card', 'agent-board']);

/**
 * Classify a run's workflow shape from facts already in hand.
 *
 * The chain stamp lives on the DEFINITION's metadata
 * (`workflowChainPackLoader` writes `source: 'workflow-chain-pack'`), not on
 * the run row, so a caller without the definition can only reach `stack` or
 * `unknown`. That asymmetry is why this takes both.
 */
export function classifyWorkflowKind(input: {
  definition?: Pick<WorkflowDefinition, 'metadata'> | null;
  run?: Pick<RunRecord, 'metadata'> | null;
}): WorkflowKind {
  const defMeta = input.definition?.metadata as Record<string, unknown> | undefined;
  if (defMeta?.source === 'workflow-chain-pack') return 'chain';
  const runMeta = input.run?.metadata as Record<string, unknown> | undefined;
  const runSource = typeof runMeta?.source === 'string' ? runMeta.source : undefined;
  if (runSource && STACK_SOURCES.has(runSource)) return 'stack';
  if (input.definition) return 'builtin';
  return 'unknown';
}

/**
 * How a run was started. Peer/tenant strings never reach this — a caller's
 * `metadata.source` is checked against the served set and folded to `other`.
 */
export type RunTrigger = 'api' | 'schedule' | 'trigger' | 'agent' | 'kanban' | 'mcp' | 'other';

const TRIGGERS: Record<string, RunTrigger> = {
  api: 'api',
  schedule: 'schedule',
  scheduled: 'schedule',
  heartbeat: 'schedule',
  trigger: 'trigger',
  webhook: 'trigger',
  agent: 'agent',
  'agent-dispatch': 'agent',
  kanban: 'kanban',
  'kanban-card': 'kanban',
  'agent-board': 'kanban',
  mcp: 'mcp',
  'mcp-server-mount': 'mcp',
};

export function classifyRunTrigger(run: Pick<RunRecord, 'metadata'> | null | undefined): RunTrigger {
  const meta = run?.metadata as Record<string, unknown> | undefined;
  const raw = typeof meta?.source === 'string' ? meta.source : undefined;
  if (!raw) return 'api';
  return TRIGGERS[raw] ?? 'other';
}

/**
 * The in-process registry of run starts.
 *
 * `notifyRunTerminal(runId, status)` is the single owner of "a run reached
 * terminal", and it is deliberately given nothing but the id and the status —
 * so the duration and the workflow kind have to be carried from the start.
 *
 * BOUNDED, and process-local by construction. A run whose start this process
 * did not observe (a cold start between start and terminal, or a terminal
 * driven by a different instance) is reported with NO duration and
 * `workflow_kind: 'unknown'`. Fabricating a duration from `run.createdAt` would
 * be the wrong number — that clock includes the queue wait — and fabricating a
 * kind would be a guess an operator cannot tell from a measurement.
 *
 * Same eviction shape as `runEffectContext`'s per-run tally, for the same
 * reason: a per-run map with no ceiling is an unbounded process leak.
 */
interface RunStartFacts {
  readonly kind: WorkflowKind;
  readonly startedAtMs: number;
}
const runStarts = new Map<string, RunStartFacts>();
const MAX_TRACKED_RUNS = 10_000;

/** Emit `openwop.run.started` and remember what the terminal seam will need. */
export function recordRunStarted(input: {
  runId: string;
  kind: WorkflowKind;
  trigger: RunTrigger;
  nowMs?: number;
}): void {
  runStarts.delete(input.runId);
  runStarts.set(input.runId, { kind: input.kind, startedAtMs: input.nowMs ?? Date.now() });
  while (runStarts.size > MAX_TRACKED_RUNS) {
    const oldest = runStarts.keys().next();
    if (oldest.done) break;
    runStarts.delete(oldest.value);
  }
  addCount('openwop.run.started', 1, { workflow_kind: input.kind, trigger: input.trigger });
}

/**
 * Emit `openwop.run.completed`, and `openwop.run.duration` when — and only
 * when — this process saw the run start.
 *
 * Wall-clock by design: a run suspended on a human approval for an hour took an
 * hour, and an SLO on "how long until a workflow finishes" is the number a user
 * experiences, not the CPU time it consumed.
 */
export function recordRunTerminal(runId: string, status: RunTerminalStatus, nowMs?: number): void {
  const facts = runStarts.get(runId);
  runStarts.delete(runId);
  const kind: WorkflowKind = facts?.kind ?? 'unknown';
  addCount('openwop.run.completed', 1, { workflow_kind: kind, status });
  if (facts) {
    recordValue('openwop.run.duration', Math.max(0, ((nowMs ?? Date.now()) - facts.startedAtMs) / 1000), {
      workflow_kind: kind,
      status,
    });
  }
}

/** Test seam — the registry is process-local state, so suites must not inherit it. */
/**
 * WHOPS-2 — record how long an outbound webhook delivery waited before its FIRST
 * attempt.
 *
 * `delayMs` is milliseconds at the call site and SECONDS on the wire: the metric
 * declares `unit: 's'` and its buckets top out at 900, so passing milliseconds
 * would put every observation in the overflow bucket and make the objective read
 * 100%-breaching forever — a monitor that is always red is the same as no monitor.
 *
 * `outcome` is the only label, and deliberately so: `subscriptionId` is unbounded
 * cardinality on a host-wide SLO and a subscriber `url` can carry a token in its
 * query string.
 */
export function recordWebhookFirstAttemptDelay(delayMs: number, outcome: 'delivered' | 'failed'): void {
  recordValue('openwop.webhook.first_attempt_delay', Math.max(0, delayMs) / 1000, { outcome });
}

export function _resetRunStartsForTest(): void {
  runStarts.clear();
}

/** Terminal disposition of ONE node execution attempt. */
export type NodeOutcomeStatus = 'success' | 'failure' | 'suspended';

export function recordNodeDuration(input: {
  status: NodeOutcomeStatus;
  replayed: boolean;
  durationMs: number;
}): void {
  recordValue('openwop.node.duration', Math.max(0, input.durationMs) / 1000, {
    status: input.status,
    // Booleans are legal OTel attribute values and are the smallest possible
    // domain — two series, never a string that could drift to "yes"/"1".
    replayed: input.replayed,
  });
}

/* ── replay + effects ─────────────────────────────────────────────────────── */

/** What the ADR 0341 fast path found in the source run for a side-effecting node. */
export type ReplayServedOutcome = 'recorded-success' | 'recorded-failure' | 'source-missing';

export function recordReplayServed(outcome: ReplayServedOutcome): void {
  addCount('openwop.replay.node.served', 1, { outcome });
}

/**
 * An effect the ADR 0531 backstop let through — it actually left this host.
 *
 * Distinct metric from the block below, and deliberately so: `allowed` is the
 * steady state and `blocked` is a bug report. Sharing one counter with an
 * `outcome` label invites an alert on a ratio, and the ratio is meaningless —
 * any non-zero block count is actionable regardless of how much traffic ran.
 */
export function recordEffectAllowed(effectKind: EffectKind): void {
  addCount('openwop.effect.dispatched', 1, { effect_kind: effectKind, outcome: 'allowed' });
}

export function recordEffectBlocked(effectKind: EffectKind): void {
  addCount('openwop.effect.blocked', 1, { effect_kind: effectKind });
}

/* ── authorization ────────────────────────────────────────────────────────── */

/**
 * ADR 0556 P4 — an authorization decision at a host authority seam.
 *
 * The gap this closes is named in ADR 0556's own §"Not done" list: the decision
 * facts were on the span and in the durable audit chain, and NOWHERE a
 * dashboard or alert could read them. A span is sampled and an audit row is a
 * per-decision record you have to query; neither answers "are denials rising
 * right now", which is the only question an operator asks at 3am.
 *
 * BOTH labels are closed sets, which is what makes this safe under the P0
 * cardinality lint:
 *   - `outcome` is the seam's own `'attempt' | 'allow' | 'deny'`;
 *   - `issuer_class` is `ISSUER_CLASSES` (`spiffe | mtls | cloud | oauth | oidc
 *     | api-key | anonymous`) — the RFC 0154 §D CLASS, never the issuer URL. A
 *     URL identifies a deployment and is unbounded; that distinction already
 *     governs the audit fact and it governs the metric for the same reason.
 *   - `'unattributed'` covers facts carrying no verified workload identity.
 *     Most do not, and folding them into `anonymous` would state something
 *     false: `anonymous` is a verified anonymous issuer, not an absent one.
 *
 * ONE counter with an `outcome` label here, rather than the split
 * allowed/blocked pair above — and the difference is deliberate. A denial is
 * NOT a bug report: refusing an unauthorized caller is the system working, so
 * the meaningful signal really is the RATIO (a denial rate that moves), which
 * is exactly what makes a shared counter right here and wrong there.
 */
export function recordAuthzDecision(
  outcome: 'attempt' | 'allow' | 'deny',
  issuerClass: string | undefined,
): void {
  addCount('openwop.authz.decision', 1, { outcome, issuer_class: issuerClass ?? 'unattributed' });
}

/* ── idempotency ──────────────────────────────────────────────────────────── */

/**
 * ADR 0549's five claim outcomes.
 *
 * > CORRECTION to ADR 0556 §"Inbound dependency". That section lists
 * > `reclaimed` alongside `claimed`, but `IdempotentClaim` has no such member:
 * > taking over an expired lease returns `{ outcome: 'claimed' }`, so the two
 * > were indistinguishable to every caller. `reclaimed` is the RECOVERY signal
 * > the P1 gate asks for — a live holder cannot outlive its lease, so a reclaim
 * > means a holder DIED mid-request — and a metric that cannot see it would
 * > report the most interesting event as routine. The storage adapters now set
 * > an explicit `reclaimed: true` on that branch.
 */
export type IdempotencyOutcome = 'claimed' | 'reclaimed' | 'replay' | 'in-flight' | 'mismatch';

/** The claim result as a label. One owner, so the two participating routes
 *  cannot disagree about what `claimed`-with-`reclaimed` is called. */
export function idempotencyOutcomeOf(claim: IdempotentClaim): IdempotencyOutcome {
  if (claim.outcome !== 'claimed') return claim.outcome;
  return claim.reclaimed ? 'reclaimed' : 'claimed';
}

export function recordIdempotencyClaim(endpoint: IdempotentEndpoint, outcome: IdempotencyOutcome): void {
  addCount('openwop.idempotency.claim', 1, { endpoint, outcome });
}

/* ── interrupts ───────────────────────────────────────────────────────────── */

/** How an interrupt left the open state. */
export type InterruptResolution =
  | 'accepted'
  | 'rejected'
  | 'skipped'
  | 'timeout'
  | 'timer'
  | 'cascaded';

export function recordInterruptCreated(kind: InterruptRecord['kind']): void {
  addCount('openwop.interrupt.created', 1, { interrupt_kind: kind });
}

/**
 * Age at resolution. Takes the record's own `createdAt` rather than a caller's
 * stopwatch so a resolution driven by a daemon on another instance still
 * measures the real wait.
 */
export function recordInterruptResolved(
  record: Pick<InterruptRecord, 'kind' | 'createdAt'>,
  resolution: InterruptResolution,
  resolvedAtIso?: string,
): void {
  const createdMs = Date.parse(record.createdAt);
  const resolvedMs = resolvedAtIso ? Date.parse(resolvedAtIso) : Date.now();
  // An unparseable timestamp yields NaN, and NaN in a histogram poisons the
  // bucket sums for every other observation. Drop the measurement rather than
  // record a lie; the counter above still says the interrupt existed.
  if (!Number.isFinite(createdMs) || !Number.isFinite(resolvedMs)) return;
  recordValue('openwop.interrupt.age', Math.max(0, resolvedMs - createdMs) / 1000, {
    interrupt_kind: record.kind,
    resolution,
  });
}

/* ── compensation (RFC 0151) ──────────────────────────────────────────────── */

export function recordCompensationObligation(effectKind: EffectKind, shape: CompensationShape): void {
  addCount('openwop.compensation.obligation', 1, { effect_kind: effectKind, shape });
}

export function recordCompensationResolved(effectKind: EffectKind, state: CompensationState): void {
  addCount('openwop.compensation.resolved', 1, { effect_kind: effectKind, state });
}

/**
 * ADR 0554 P3 — one operator recovery action.
 *
 * `outcome` is a CLOSED set and each member is a distinct operational fact:
 *   `applied`  — the action ran and the ledger moved.
 *   `denied`   — RBAC/authority refused it (403), or SoD refused the approval.
 *   `conflict` — the actor lost a concurrent race (409, stale view).
 *   `pending`  — a high-risk waive is parked behind an approval and has NOT
 *                been applied. Folding this into `applied` would report waives
 *                that nobody has authorized yet.
 */
export type CompensationRecoveryOutcome = 'applied' | 'denied' | 'conflict' | 'pending';

export function recordCompensationRecovery(action: string, outcome: CompensationRecoveryOutcome): void {
  addCount('openwop.compensation.recovery', 1, { action, outcome });
}

/* ── A2A / MCP ────────────────────────────────────────────────────────────── */

/**
 * The A2A methods this host SERVES. A peer supplies the string, so anything not
 * on this list is `unknown` — one series for every unrecognised method, however
 * many a scanner invents.
 */
const A2A_METHODS = new Set([
  'agent/getCard',
  'message/send',
  'tasks/get',
  'tasks/resubscribe',
  'tasks/pushNotificationConfig/set',
]);

export function classifyA2aMethod(method: unknown): string {
  return typeof method === 'string' && A2A_METHODS.has(method) ? method : 'unknown';
}

/** A2A request dispositions, mapped from the JSON-RPC error code. */
export type A2aOutcome =
  | 'ok'
  | 'invalid_request'
  | 'method_not_found'
  | 'invalid_params'
  | 'not_found'
  | 'internal_error';

const A2A_ERROR_CODES: Record<number, A2aOutcome> = {
  [-32600]: 'invalid_request',
  [-32601]: 'method_not_found',
  [-32602]: 'invalid_params',
  [-32603]: 'internal_error',
  [-32001]: 'not_found',
};

export function classifyA2aOutcome(errorCode: number | undefined): A2aOutcome {
  if (errorCode === undefined) return 'ok';
  return A2A_ERROR_CODES[errorCode] ?? 'internal_error';
}

export function recordA2aRequest(method: unknown, outcome: A2aOutcome): void {
  addCount('openwop.a2a.request', 1, { method: classifyA2aMethod(method), outcome });
}

/** The MCP methods this host serves inbound or issues outbound. */
const MCP_METHODS = new Set([
  'initialize',
  'ping',
  'logging/setLevel',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'completion/complete',
  'sampling/createMessage',
  'elicitation/create',
]);

export function classifyMcpMethod(method: unknown): string {
  return typeof method === 'string' && MCP_METHODS.has(method) ? method : 'unknown';
}

/**
 * MCP dispositions. The inbound half maps JSON-RPC codes; the outbound half maps
 * `McpError.code`, which is already a closed union — but it is folded here so a
 * new member cannot reach a metric before someone has looked at it.
 */
export type McpOutcome =
  | 'ok'
  | 'invalid_request'
  | 'method_not_found'
  | 'invalid_params'
  | 'internal_error'
  | 'unauthorized'
  | 'not_connected'
  | 'not_allowed'
  | 'timeout'
  | 'transport_error'
  | 'remote_error';

const MCP_ERROR_CODES: Record<number, McpOutcome> = {
  [-32700]: 'invalid_request',
  [-32600]: 'invalid_request',
  [-32601]: 'method_not_found',
  [-32602]: 'invalid_params',
  [-32603]: 'internal_error',
};

export function classifyMcpRpcOutcome(errorCode: number | undefined): McpOutcome {
  if (errorCode === undefined) return 'ok';
  return MCP_ERROR_CODES[errorCode] ?? 'internal_error';
}

const MCP_CLIENT_CODES: Record<string, McpOutcome> = {
  server_not_found: 'not_allowed',
  insecure_mcp_endpoint: 'not_allowed',
  connector_not_allowed: 'not_allowed',
  mcp_not_connected: 'not_connected',
  mcp_timeout: 'timeout',
  mcp_request_failed: 'transport_error',
  mcp_bad_response: 'transport_error',
  mcp_response_too_large: 'transport_error',
  mcp_error: 'remote_error',
};

export function classifyMcpClientOutcome(err: unknown): McpOutcome {
  const code = (err as { code?: unknown } | null)?.code;
  return (typeof code === 'string' && MCP_CLIENT_CODES[code]) || 'transport_error';
}

export function recordMcpRequest(direction: 'inbound' | 'outbound', method: unknown, outcome: McpOutcome): void {
  addCount('openwop.mcp.request', 1, { direction, method: classifyMcpMethod(method), outcome });
}

/** Version-negotiation dispositions, shared by both protocols. */
export type VersionDisposition = 'absent' | 'served' | 'unsupported' | 'mismatch';

/**
 * The profile this host SERVED for the request — closed set, never peer-supplied.
 *
 * `none` covers the dispositions where nothing was served (a refused version,
 * or a request that never reached a codec), so the label is always present and
 * an absent value never has to be inferred from a missing series.
 */
export type ServedProfile =
  | 'a2a-1.0'
  | 'a2a-0.3-legacy'
  | 'mcp-2026-07-28'
  | 'mcp-2025-06-18-legacy'
  | 'none';

export function recordProtocolVersion(
  protocol: 'a2a' | 'mcp',
  disposition: VersionDisposition,
  profile: ServedProfile = 'none',
): void {
  addCount('openwop.protocol.version', 1, { protocol, disposition, profile });
}

/* ── sandbox ──────────────────────────────────────────────────────────────── */

/** Which isolation mechanism ran the code. Operator-configured, four values. */
export type SandboxRuntime = 'vm' | 'code-api' | 'wasi' | 'e2b';

/**
 * Sandbox dispositions, unified across four adapters with four private error
 * vocabularies. The union is what an operator alerts on: `escape_attempt` is a
 * security signal, `resource_exhausted` and `timeout` are capacity signals, and
 * collapsing them into "failed" would put those on one line.
 */
export type SandboxOutcome =
  | 'ok'
  | 'timeout'
  | 'resource_exhausted'
  | 'capability_denied'
  | 'escape_attempt'
  | 'validation_error'
  | 'content_too_long'
  | 'transport_error'
  | 'error';

const SANDBOX_CODES: Record<string, SandboxOutcome> = {
  sandbox_timeout: 'timeout',
  sandbox_capability_denied: 'capability_denied',
  capability_not_provided: 'capability_denied',
  sandbox_escape_attempt: 'escape_attempt',
  sandbox_memory_exceeded: 'resource_exhausted',
  resource_exhausted: 'resource_exhausted',
  validation_error: 'validation_error',
  content_too_long: 'content_too_long',
  sandbox_error: 'error',
};

/**
 * Classify a thrown sandbox failure.
 *
 * `sandbox_transport_error` is special-cased: the Code-API adapter reports an
 * abort as `code: 'sandbox_transport_error', message: 'sandbox_timeout'` so the
 * endpoint location never leaks into the message. Reading only the code would
 * file every sandbox timeout as a network fault — the opposite of the capacity
 * signal it is.
 */
export function classifySandboxError(err: unknown): SandboxOutcome {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'sandbox_transport_error') {
    const message = err instanceof Error ? err.message : '';
    return message === 'sandbox_timeout' ? 'timeout' : 'transport_error';
  }
  return (typeof code === 'string' && SANDBOX_CODES[code]) || 'error';
}

export function recordSandboxExecution(runtime: SandboxRuntime, outcome: SandboxOutcome): void {
  addCount('openwop.sandbox.execution', 1, { runtime, outcome });
}

/* ── pack isolation (ADR 0555 P2) ─────────────────────────────────────────── */

/**
 * Which adapter ran the pack node. Closed: the adapter ids, plus nothing.
 * A new adapter adds a member HERE, so the label domain cannot grow by an
 * adapter simply naming itself.
 */
export type PackIsolationAdapterId = 'node-child-process' | 'fake-in-process';

/**
 * How an isolated dispatch ended.
 *
 * `timeout` / `memory_exceeded` are CAPACITY signals and `crashed` is a
 * reliability one; `adapter_unavailable` and `spawn_failed` are the two ways
 * the host could not isolate at all, which an operator must be able to alert on
 * separately because they mean untrusted packs are being REFUSED rather than
 * contained. Collapsing them into `failed` would hide an outage as a workload
 * property.
 */
export type PackIsolationOutcome =
  | 'ok'
  | 'suspended'
  | 'failed'
  | 'timeout'
  | 'memory_exceeded'
  | 'crashed'
  | 'spawn_failed'
  | 'adapter_unavailable'
  /** Refused before spawning: concurrency x heap exceeds the memory budget. */
  | 'budget_unsafe';

export function recordPackIsolation(adapter: PackIsolationAdapterId, outcome: PackIsolationOutcome): void {
  addCount('openwop.pack.isolation.dispatch', 1, { adapter, outcome });
}

/* ── model providers ──────────────────────────────────────────────────────── */

/** Provider ids this host dispatches to. `compat` is one label, not one per base URL. */
const PROVIDERS = new Set(['anthropic', 'openai', 'google', 'minimax', 'compat', 'mock']);

export function classifyProvider(provider: string): string {
  return PROVIDERS.has(provider) ? provider : 'other';
}

/**
 * Provider outcomes are the 15 canonical `aiProviders` error codes plus `ok`.
 * The code set is fixed by `spec/v1/host-capabilities.md`, so it is bounded by
 * the spec rather than by a list kept here — but an unrecognised value still
 * folds to `error`, because a spec revision must not be able to move a metric's
 * cardinality without anyone deciding to.
 */
const PROVIDER_ERROR_CODES = new Set([
  'provider_not_supported', 'provider_policy_denied', 'byok_required',
  'byok_required_but_unresolved', 'model_not_supported', 'model_not_allowed',
  'provider_rate_limited', 'provider_timed_out', 'provider_unavailable',
  'invalid_request', 'content_too_long', 'host_capability_missing',
  'internal_error', 'speech_synthesis_failed', 'transcription_failed',
]);

export function classifyProviderOutcome(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && PROVIDER_ERROR_CODES.has(code) ? code : 'error';
}

export function recordProviderCall(provider: string, outcome: string): void {
  addCount('openwop.provider.call', 1, { provider: classifyProvider(provider), outcome });
}

/* ── assurance freshness (ADR 0550) ───────────────────────────────────────── */

export type AttestationState = 'valid' | 'invalid' | 'absent' | 'unreadable';

/**
 * Age of the attestation manifest at read time.
 *
 * Recorded only when the manifest carries a parseable `issuedAt`: `absent` and
 * `unreadable` have no age, and a zero would read as "issued just now" — the
 * most reassuring possible value for the most alarming possible state.
 */
export function recordAttestationAge(input: {
  state: AttestationState;
  environmentClass: string;
  issuedAt?: string;
  nowMs?: number;
}): void {
  if (!input.issuedAt) return;
  const issuedMs = Date.parse(input.issuedAt);
  if (!Number.isFinite(issuedMs)) return;
  recordValue('openwop.attestation.age', Math.max(0, (input.nowMs ?? Date.now()) - issuedMs) / 1000, {
    state: input.state,
    environment_class: ['local', 'staging', 'production'].includes(input.environmentClass)
      ? input.environmentClass
      : 'unknown',
  });
}

/* ── dispatch outbox (ADR 0551 P2) ────────────────────────────────────────── */

/**
 * What a leased worker DID with one dispatch intent.
 *
 * Closed by construction — these are the five terminal branches of
 * `sweepDispatchOutbox`, and the classifier lives here rather than at the call
 * site so the complete set is readable in one place.
 *
 *  - `dispatched`  the run was still `pending` with no live lease, so
 *                  `executeRun` was invoked. The steady state on a recovery.
 *  - `discharged`  the intent was already satisfied — the run left `pending`,
 *                  or an instance holds a live dispatch lease. This is the
 *                  duplicate-delivery refusal, and it is HEALTHY.
 *  - `run-missing` the run was deleted or retention-swept out from under the
 *                  intent. Also healthy; the row would otherwise re-deliver
 *                  against nothing forever.
 *  - `retried`     the row could not be discharged and went back on the queue
 *                  with the attempt counted.
 *  - `dead`        attempts exhausted. The one outcome that leaves a row behind
 *                  for the redrive surface, and the one worth alerting on.
 */
export type OutboxOutcome = 'dispatched' | 'discharged' | 'run-missing' | 'retried' | 'dead';

/** Which lane of the one dispatch daemon acted. Two values, forever — the
 *  boundaries table forbids a third (no second executor, no second daemon). */
export type DispatchLane = 'outbox' | 'orphan';

export function recordDispatchRecovery(lane: DispatchLane, outcome: OutboxOutcome): void {
  addCount('openwop.dispatch.lease.recovered', 1, { lane, outcome });
}

/**
 * The backlog observation, taken once per sweeper pass.
 *
 * Both gauges are SET from the same read so depth and oldest-age can never
 * disagree about which moment they describe — two separate reads a tick apart
 * would let an operator see a zero depth next to a ten-minute oldest age and
 * reasonably conclude the instrumentation is broken.
 *
 * `oldestPendingCreatedAt: null` (an empty queue) records **0**, and that is
 * safe here in a way it is NOT for the attestation age above. There the zero
 * would be a fabricated reading standing in for "no manifest"; here an empty
 * queue genuinely has an oldest age of zero, and skipping the emission would
 * leave the last non-zero value as the newest sample the exporter ever saw —
 * a drained backlog that looks permanently stuck.
 */
export function recordOutboxBacklog(stats: {
  pending: number;
  dead: number;
  oldestPendingCreatedAt: string | null;
  nowMs?: number;
}): void {
  setGauge('openwop.dispatch.outbox.depth', stats.pending, { state: 'pending' });
  setGauge('openwop.dispatch.outbox.depth', stats.dead, { state: 'dead' });
  const oldestMs = stats.oldestPendingCreatedAt ? Date.parse(stats.oldestPendingCreatedAt) : NaN;
  const ageS = Number.isFinite(oldestMs) ? Math.max(0, (stats.nowMs ?? Date.now()) - oldestMs) / 1000 : 0;
  setGauge('openwop.dispatch.outbox.oldest_age', ageS);
}

/* ── reusable Kanban WorkItem dispatch (ADR 0738 P6) ─────────────────────── */

/**
 * Outcome of a core WorkItem delivery decision. This is deliberately about the
 * Kanban aggregate's eligibility/delivery boundary, not the eventual workflow
 * execution — normal run metrics own that lifecycle. The closed union prevents
 * a canvas, workflow, error string, or board id from becoming metric cardinality.
 */
export type KanbanWorkItemDeliveryOutcome =
  | 'started'
  | 'not-eligible'
  | 'deferred'
  | 'workflow-unresolved'
  | 'retried'
  | 'dead-lettered'
  | 'failed';

export function recordKanbanWorkItemDelivery(
  mode: 'manual' | 'auto',
  outcome: KanbanWorkItemDeliveryOutcome,
): void {
  addCount('openwop.kanban.work_item.delivery', 1, { mode, outcome });
}

/* ── HTTP ─────────────────────────────────────────────────────────────────── */

/** `2xx`-style class. Never the raw status: 5 series instead of ~40. */
export function statusClassOf(status: number): string {
  if (!Number.isFinite(status) || status < 100 || status > 599) return 'unknown';
  return `${Math.floor(status / 100)}xx`;
}

/**
 * Record one HTTP server request.
 *
 * `route` MUST be the express route TEMPLATE (`/v1/runs/:runId`), never the
 * resolved path — the catalog's own description says so and `path` is in
 * FORBIDDEN_LABELS, so a resolved path would be dropped by the guard and the
 * measurement would silently lose its only useful dimension. An unmatched
 * request has no template and is `unmatched`, one series for every 404 a
 * scanner produces.
 */
export function recordHttpRequest(input: {
  route: string | undefined;
  method: string;
  status: number;
  durationMs: number;
  /** ADR 0556 P2 — is this a long-lived SSE connection? Decided by the rate
   *  limiter's predicate, never re-derived here: an EventStream's duration is a
   *  session length, and the latency objectives filter it out on this label. */
  stream: boolean;
}): void {
  const attrs: Attributes = {
    route: input.route ?? 'unmatched',
    method: classifyHttpMethod(input.method),
    status_class: statusClassOf(input.status),
    stream: input.stream,
  };
  recordValue('openwop.http.server.duration', Math.max(0, input.durationMs) / 1000, attrs);
}

/** Node's HTTP parser accepts ~34 methods, so `req.method` is bounded — but it
 *  is bounded by a dependency rather than by us, and this app serves six. */
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export function classifyHttpMethod(method: string): string {
  const upper = method.toUpperCase();
  return HTTP_METHODS.has(upper) ? upper : 'other';
}
