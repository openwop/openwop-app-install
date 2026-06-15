/**
 * ADR 0035 / RFC 0100 — durable A2A Task persistence.
 *
 * RFC 0100 ("Async / Durable A2A Tasks") makes the `a2a-integration.md`
 * §"State projection" mapping DURABLE: when a host advertises
 * `a2a.durableTasks`, it MUST persist an `A2ATaskState` per backing run so a
 * caller that disconnected can `tasks/get` later and see the live state
 * (`working` / `input-required` / `completed` …), `tasks/resubscribe` to the
 * update stream, and register a push-config that fires (SSRF-guarded) on the
 * terminal/blocking transitions.
 *
 * This is the PERSISTED form of the forward projection that
 * `a2a-integration.md` already specifies — this module adds no new mapping; it
 * persists the one already FINAL. The record is content-free of run internals
 * beyond what A2A needs (no inputs/outputs/artifacts/credential material; per
 * RFC 0100 §2 + the SR-1 trust boundary). It is backed by the same
 * `DurableCollection` every other host-extension store uses — NOT a parallel
 * task store — so the projected Task is durable across caller disconnect, host
 * restart within retention, and HITL pauses, and is correct across instances.
 *
 * @see RFCS/0100-async-durable-a2a-tasks.md  §1 (capability) §2 (record) §3 (lifecycle) §4 (push)
 * @see spec/v1/a2a-integration.md  §"State projection (forward)"
 * @see docs/adr/0035-async-durable-a2a-tasks.md
 */

import { DurableCollection } from './hostExtPersistence.js';
import { isDeniedWebhookHost } from './webhookEgressGuard.js';

/**
 * The A2A v0.3 JSON-RPC wire form of `TaskState` (lowercase-hyphen — the
 * spelling the wire/persisted form uses per `a2a-integration.md`
 * §"Wire-shape spelling drift"). `auth-required` is carried for reverse-
 * direction fidelity (RFC 0100 Unresolved-Q4); the forward projection never
 * emits it (openwop v1 has no `auth` interrupt — drift point #3).
 */
export type A2aTaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected';

/** A2A clients see the same `INPUT_REQUIRED` for both approval and
 *  clarification (a2a-integration.md drift point #2 — lossy). RFC 0100 §2
 *  codifies the disambiguator under `Task.metadata.openwop.interrupt.kind`. */
export type A2aInterruptKind = 'approval' | 'clarification';

/** A caller-registered A2A push-notification target (RFC 0100 §2 `PushConfig`). */
export interface A2aPushConfig {
  /** Push target. Validated through the RFC 0093 webhook-egress SSRF guard
   *  before any delivery (no private/loopback/link-local). */
  url: string;
  /** OPTIONAL — a truncated/salted digest of the caller's push-auth token
   *  (NEVER the raw token; the SR-1 rule of RFC 0083's `secretFingerprint`).
   *  The A2A push HMAC details stay inside the A2A layer. */
  tokenFingerprint?: string;
}

/**
 * The persisted durable Task projection (RFC 0100 §2 `A2ATaskState`). Carries
 * NO run inputs/outputs/artifacts inline — artifacts project to A2A `Artifact`s
 * over the A2A transport, not into this record.
 */
export interface A2aTaskRecord {
  /** The A2A `Task.id`. MUST equal the backing `runId` (a2a-integration.md §2). */
  taskId: string;
  /** The backing OpenWOP run. Bound 1:1 to `taskId`. */
  runId: string;
  /** The A2A `context_id` (the run tag `a2a:ctx_*`), when the caller supplied one. */
  contextId?: string;
  /** The projected A2A state (lowercase-hyphen wire form). */
  state: A2aTaskState;
  /** Present iff `state == 'input-required'` — disambiguates drift point #2. */
  interruptKind?: A2aInterruptKind;
  /** ISO-8601. */
  updatedAt: string;
  pushConfig?: A2aPushConfig;
}

/**
 * The forward projection `a2a-integration.md` §"State projection (forward)"
 * specifies, restated here as the host's run-status → durable-TaskState map.
 * RFC 0100 persists this table verbatim; it adds no mapping.
 *
 *   pending           → submitted
 *   running           → working
 *   paused            → working          (drift #1 — A2A has no manual pause)
 *   waiting-approval   → input-required   (interruptKind: approval)
 *   waiting-input      → input-required   (interruptKind: clarification)
 *   completed          → completed
 *   failed             → failed
 *   cancelled          → canceled         (spelling drift)
 */
export function projectRunStatusToTaskState(
  status:
    | 'pending'
    | 'running'
    | 'paused'
    | 'waiting-approval'
    | 'waiting-input'
    | 'completed'
    | 'failed'
    | 'cancelled',
): { state: A2aTaskState; interruptKind?: A2aInterruptKind } {
  switch (status) {
    case 'pending':
      return { state: 'submitted' };
    case 'running':
    case 'paused':
      return { state: 'working' };
    case 'waiting-approval':
      return { state: 'input-required', interruptKind: 'approval' };
    case 'waiting-input':
      return { state: 'input-required', interruptKind: 'clarification' };
    case 'completed':
      return { state: 'completed' };
    case 'failed':
      return { state: 'failed' };
    case 'cancelled':
      return { state: 'canceled' };
  }
}

/** The transitions a push fires on without polling (RFC 0100 §4 floor). */
const PUSH_TRANSITION_STATES: ReadonlySet<A2aTaskState> = new Set([
  'input-required',
  'completed',
  'failed',
  'canceled',
]);

/** Terminal states — a durable Task in one of these no longer advances. */
export function isTerminalTaskState(state: A2aTaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected';
}

const tasks = new DurableCollection<A2aTaskRecord>('a2a:task', (t) => t.taskId);

/** Read the persisted durable Task, or null when none exists (RFC 0100 §3 —
 *  `tasks/get` returns live state after disconnect; not-found when no record). */
export async function getA2aTask(taskId: string): Promise<A2aTaskRecord | null> {
  return tasks.get(taskId);
}

/**
 * The outbound projection (a2a-integration.md §3) of one persisted record into
 * an A2A `Task` envelope — the same shape `tasks/get` returns and a
 * `TaskStatusUpdateEvent` carries. `metadata.openwop.interrupt.kind` is the
 * codified disambiguator (RFC 0100 §2); A2A clients ignore unknown metadata.
 */
export function projectTaskRecordToA2aTask(rec: A2aTaskRecord): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (rec.state === 'input-required' && rec.interruptKind) {
    metadata.openwop = { interrupt: { kind: rec.interruptKind } };
  }
  const task: Record<string, unknown> = {
    kind: 'task',
    id: rec.taskId,
    status: { state: rec.state, timestamp: rec.updatedAt },
  };
  if (rec.contextId) task.contextId = rec.contextId;
  if (Object.keys(metadata).length > 0) task.metadata = metadata;
  return task;
}

/** An A2A `TaskStatusUpdateEvent` (a2a-integration.md §3) for one transition. */
export function taskStatusUpdateEvent(rec: A2aTaskRecord, final: boolean): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (rec.state === 'input-required' && rec.interruptKind) {
    metadata.openwop = { interrupt: { kind: rec.interruptKind } };
  }
  const evt: Record<string, unknown> = {
    kind: 'status-update',
    taskId: rec.taskId,
    status: { state: rec.state, timestamp: rec.updatedAt },
    final,
  };
  if (rec.contextId) evt.contextId = rec.contextId;
  if (Object.keys(metadata).length > 0) evt.metadata = metadata;
  return evt;
}

export class A2aPushUrlDeniedError extends Error {
  readonly code = 'OPENWOP_A2A_PUSH_EGRESS_DENIED';
  constructor(url: string) {
    super(`a2a push config rejected: ${url} targets a private/loopback/link-local host (RFC 0100 §4 / RFC 0093 §A.1)`);
    this.name = 'A2aPushUrlDeniedError';
  }
}

/**
 * Validate a caller-supplied push URL through the RFC 0093 webhook-egress SSRF
 * guard (RFC 0100 §4 — a push URL is the same SSRF surface as a webhook).
 * Throws `A2aPushUrlDeniedError` for a private/loopback/link-local target or a
 * non-http(s) scheme.
 */
export function assertPushUrlAllowed(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new A2aPushUrlDeniedError(url);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new A2aPushUrlDeniedError(url);
  }
  if (isDeniedWebhookHost(parsed.hostname)) {
    throw new A2aPushUrlDeniedError(url);
  }
}

/** A pluggable push sink so the firing path is testable without real egress. */
export type A2aPushSink = (config: A2aPushConfig, event: Record<string, unknown>) => void | Promise<void>;

let pushSink: A2aPushSink | null = null;
/** Wire the push delivery sink (best-effort; never throws into the caller). */
export function setA2aPushSink(sink: A2aPushSink | null): void {
  pushSink = sink;
}

/**
 * Upsert one durable Task state and, when the transition is push-eligible and a
 * push-config is registered, fire a push (RFC 0100 §4). The push body is a
 * `TaskStatusUpdateEvent` carrying the same content-free projection as the
 * persisted record (SR-1 — no run-internal content). Push delivery is
 * best-effort; a sink failure never fails the state transition.
 */
export async function upsertA2aTask(
  next: Omit<A2aTaskRecord, 'updatedAt'> & { updatedAt?: string },
): Promise<A2aTaskRecord> {
  if (next.pushConfig) assertPushUrlAllowed(next.pushConfig.url);
  const rec: A2aTaskRecord = { ...next, updatedAt: next.updatedAt ?? new Date().toISOString() };
  await tasks.put(rec);
  if (rec.pushConfig && pushSink && PUSH_TRANSITION_STATES.has(rec.state)) {
    try {
      await pushSink(rec.pushConfig, taskStatusUpdateEvent(rec, isTerminalTaskState(rec.state)));
    } catch {
      /* best-effort push — a delivery failure does not roll back the durable state */
    }
  }
  return rec;
}

/**
 * Register/replace the push-config for an existing durable Task (RFC 0100 §4).
 * Validates the URL through the SSRF guard before persisting. Returns the
 * updated record, or null when the Task does not exist.
 */
export async function setA2aTaskPushConfig(taskId: string, config: A2aPushConfig): Promise<A2aTaskRecord | null> {
  assertPushUrlAllowed(config.url);
  const existing = await tasks.get(taskId);
  if (!existing) return null;
  const rec: A2aTaskRecord = { ...existing, pushConfig: config, updatedAt: new Date().toISOString() };
  await tasks.put(rec);
  return rec;
}

/** Test-only: drop every persisted durable Task. */
export async function __resetA2aTaskStore(): Promise<void> {
  await tasks.__clear();
}
