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

import { createHash, randomBytes } from 'node:crypto';
import type { RunStatus } from '../types.js';
import { DurableCollection } from './hostExtPersistence.js';
import { assertEgressUrlAllowed, EgressUrlRejectedError } from './webhookEgressGuard.js';
import { openPushAuthorization, pushCredentialAad, sealPushAuthorization } from './a2aPushCredential.js';
import { createLogger } from '../observability/logger.js';
import { taskStatusUpdateEvent10 } from './a2aCodec10.js';

const log = createLogger('host.a2aTaskStore');

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
export type A2aInterruptKind = 'approval' | 'clarification' | 'credential';

/** A caller-registered A2A push-notification target (RFC 0100 §2 `PushConfig`). */
export interface A2aPushConfig {
  /** Push target. Validated through the RFC 0093 webhook-egress SSRF guard
   *  before any delivery (no private/loopback/link-local). */
  url: string;
  /** OPTIONAL — a truncated/salted digest of the caller's push-auth token
   *  (NEVER the raw token; the SR-1 rule of RFC 0083's `secretFingerprint`).
   *  A2A 1.0.1 §4.3.3 defines no push signing (RFC 0214 Editorial); the
   *  credential a push carries is {@link sealedAuthorization}. */
  tokenFingerprint?: string;
  /**
   * RFC 0214 §A — the destination credential the client registered, as the
   * `Authorization` value a delivery to `url` carries, SEALED
   * (`a2aPushCredential.ts`). Never returned to a caller ({@link publicPushConfig}),
   * never logged, and dropped when the task reaches a terminal state.
   */
  sealedAuthorization?: string;
  /** CHAN-F7 / RFC 0214 — the config's id, for 1.0 Get/List/Delete. Never encodes a
   *  tenant, workspace or principal: the client's own `id` when it is a plain token,
   *  else a random `pnc_` id. Absent on configs stored before it existed. */
  id?: string;
  /** CHAN-F7 — the protocol the config was registered over. A `1.0` config's push
   *  body is a 1.0 `StreamResponse` as `application/a2a+json` (RFC 0214 §C); a 0.3
   *  (or older, unmarked) config keeps the 0.3 `TaskStatusUpdateEvent` its client
   *  reads. */
  protocol?: '1.0' | '0.3';
}

/** What a registration supplies: the target plus the PLAINTEXT credential, which
 *  {@link setA2aTaskPushConfig} seals before anything is persisted. */
export interface A2aPushRegistration {
  url: string;
  tokenFingerprint?: string;
  /** The `Authorization` value (`pushAuthorizationFrom`), plaintext, in memory only. */
  authorization?: string;
  /** CHAN-F7 — see {@link A2aPushConfig.id} / {@link A2aPushConfig.protocol}. */
  id?: string;
  protocol?: '1.0' | '0.3';
}

/** The push config as a caller may see it: the target, never the credential. */
export function publicPushConfig(cfg: A2aPushConfig): Omit<A2aPushConfig, 'sealedAuthorization'> {
  return {
    url: cfg.url,
    ...(cfg.tokenFingerprint !== undefined ? { tokenFingerprint: cfg.tokenFingerprint } : {}),
    ...(cfg.id !== undefined ? { id: cfg.id } : {}),
    ...(cfg.protocol !== undefined ? { protocol: cfg.protocol } : {}),
  };
}

/** A record with its push credential removed — what a caller-facing read returns. */
export function publicTaskRecord(rec: A2aTaskRecord): A2aTaskRecord {
  if (!rec.pushConfig) return rec;
  return { ...rec, pushConfig: publicPushConfig(rec.pushConfig) };
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
  /** Present iff `state` is `input-required` or `auth-required` — disambiguates
   *  drift point #2; `credential` ⇔ `auth-required` (RFC 0199 §D.1). */
  interruptKind?: A2aInterruptKind;
  /** RFC 0199 §D.1 — the `auth-required` status message: names the provider and
   *  carries `connectUrl` (the out-of-band means A2A §7.6.1 requires). */
  statusMessage?: string;
  /** ISO-8601. */
  updatedAt: string;
  pushConfig?: A2aPushConfig;
  /**
   * ADR 0552 P2 / `a2a-integration.md` §E — the tenant of record, resolved from
   * the AUTHENTICATED principal at creation and never from the request's
   * `tenant` hint. Every later read re-authorizes against this binding.
   *
   * OPTIONAL for one reason only: records written before P2 have none, and the
   * 0.3 read path keeps serving them (see {@link readableBy}). The 1.0 read
   * path does not — an unbound record is unreadable at 1.0 rather than readable
   * by everyone, so the back-compat arm cannot quietly become the live one.
   */
  tenantId?: string;
  /**
   * The authenticated remote principal that opened the task (ADR 0552 decision
   * 5). Recorded for attribution and for the §E re-authorization; not projected
   * onto the wire.
   */
  principalId?: string;
  /**
   * The protocol version the task was OPENED under. A recorded fact, not a
   * re-negotiated one (ADR 0552 matrix row 9) — a task opened at 0.3 stays a
   * 0.3-era task even when read through the 1.0 interface, which the §D.4
   * bijection makes lossless in both directions.
   */
  protocolVersion?: string;
}

/**
 * §E — may `tenantId` read this record?
 *
 * `strict` is the 1.0 rule: the record MUST carry a tenant binding and it MUST
 * match. `legacy` is the 0.3 rule, which additionally admits a record with NO
 * binding — the pre-P2 rows, which were never tenant-scoped and whose ids are
 * derived (`a2a:<agentId>`) rather than run ids.
 *
 * Both arms are exercised by `a2a-tenant-binding.test.ts`. Naming the arm at
 * the call site is the point: a single permissive resolver that quietly serves
 * the legacy arm forever is how a migration never finishes.
 */
export function readableBy(rec: A2aTaskRecord, tenantId: string, mode: 'strict' | 'legacy'): boolean {
  if (rec.tenantId !== undefined) return rec.tenantId === tenantId;
  return mode === 'legacy';
}

/**
 * The forward projection `a2a-integration.md` §"State projection (forward)"
 * specifies, restated here as the host's run-status → durable-TaskState map.
 * RFC 0100 persists this table verbatim; it adds no mapping.
 *
 *   pending           → submitted
 *   running           → working
 *   paused            → working          (drift #1 — A2A has no manual pause)
 *   cancelling        → working          (RFC 0094 §B, until terminal)
 *   waiting-approval   → input-required   (interruptKind: approval)
 *   waiting-input      → input-required   (interruptKind: clarification)
 *   waiting-external   → input-required   (interruptKind: clarification)
 *   completed          → completed
 *   failed             → failed
 *   cancelled          → canceled         (spelling drift)
 *
 * ADR 0552 P2 — the parameter is now the full `RunStatus` union rather than a
 * hand-narrowed copy of it. The copy was missing `waiting-external`, so the
 * ONE run status that had no row here was also the one the compiler could not
 * warn about; `a2a-integration.md` §D.4 lists it alongside the other two
 * interrupt states under drift #2, and it now has its row.
 *
 * That widening is what caught `cancelling` when the SDK pin moved 1.2.0 →
 * 1.7.0: RFC 0094 §B added it to `RunStatus` and the switch stopped being
 * exhaustive. It projects to `working`, NOT `canceled` — `a2a-integration.md`
 * §D.4 groups it with `running`/`paused` "until terminal", and §"Operational
 * mapping" spells out the same rule for `CancelTask` (`TASK_STATE_WORKING`
 * while `cancelling`, `TASK_STATE_CANCELED` once `cancelled`). Projecting it
 * to `canceled` would report a TERMINAL task state (`isTerminalTaskState`)
 * for a run that is still advancing, retiring the push transition before the
 * real terminal arrives — and mislabelling a cancel that ultimately fails.
 */
export function projectRunStatusToTaskState(
  status: RunStatus,
  openInterrupt?: { kind: string; data: unknown },
): { state: A2aTaskState; interruptKind?: A2aInterruptKind; statusMessage?: string } {
  // RFC 0199 §D.1 — a run suspended on a `credential` interrupt is AUTH_REQUIRED,
  // not an untyped input-required: the peer must not answer it in band.
  if (status === 'waiting-input' && openInterrupt?.kind === 'credential') {
    const data = (openInterrupt.data ?? {}) as { provider?: unknown; scopes?: unknown; connectUrl?: unknown };
    const provider = typeof data.provider === 'string' ? data.provider : 'the provider';
    const scopes = Array.isArray(data.scopes) ? data.scopes.filter((x): x is string => typeof x === 'string') : [];
    const url = typeof data.connectUrl === 'string' ? data.connectUrl : '';
    return {
      state: 'auth-required',
      interruptKind: 'credential',
      statusMessage: `Authorize ${provider}${scopes.length ? ` (${scopes.join(' ')})` : ''}: ${url}`,
    };
  }
  switch (status) {
    case 'pending':
      return { state: 'submitted' };
    case 'running':
    case 'paused':
    case 'cancelling':
      return { state: 'working' };
    case 'waiting-approval':
      return { state: 'input-required', interruptKind: 'approval' };
    case 'waiting-input':
    case 'waiting-external':
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
  // RFC 0199 §D.1 — the peer must learn it has to send its user out of band.
  'auth-required',
  'completed',
  'failed',
  'canceled',
]);

/** Terminal states — a durable Task in one of these no longer advances. */
export function isTerminalTaskState(state: A2aTaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected';
}

/**
 * The index slice pre-P2 rows land in.
 *
 * `DurableCollection` requires `tenantOf` to return a non-empty string for
 * EVERY row (`idxKey` throws otherwise — FU-DATA-4, so a defective write fails
 * loud instead of minting a `…:undefined:…` slice), and the pre-P2 A2A task
 * rows carry no tenant. Returning a sentinel puts them in a slice no tenant id
 * can name, so the backfill succeeds and `listA2aTasksForTenant` never returns
 * them to anyone — the unbound rows stay readable by id under the `legacy` arm
 * of {@link readableBy}, and invisible to enumeration.
 */
const UNBOUND_TENANT_SLICE = '~a2a-unbound';

// `tenantOf` (ADR 0552 P2) buys the BOUNDED per-tenant read `ListTasks` needs.
// The alternative — `list()` plus an in-memory tenant filter — is an O(all
// tenants) scan on a peer-reachable operation, which is the shape of the
// run-snapshot scan incident this repo already paid for. Ids stay unchanged
// (they are run ids, RFC 0100), so this adds a secondary index and migrates
// nothing.
const tasks = new DurableCollection<A2aTaskRecord>(
  'a2a:task',
  (t) => t.taskId,
  undefined,
  (t) => t.tenantId ?? UNBOUND_TENANT_SLICE,
);

/** Read the persisted durable Task, or null when none exists (RFC 0100 §3 —
 *  `tasks/get` returns live state after disconnect; not-found when no record). */
export async function getA2aTask(taskId: string): Promise<A2aTaskRecord | null> {
  return tasks.get(taskId);
}

/**
 * `a2a-integration.md` §E — read a durable Task the caller is entitled to.
 *
 * Returns null both for "no such task" and for "a task in another tenant",
 * ON PURPOSE: §E requires cross-tenant lookups to be INDISTINGUISHABLE from
 * not-found, so `GetTask` / `CancelTask` / `SubscribeToTask` cannot be used to
 * enumerate ids. A `forbidden` answer would confirm the id exists, which is the
 * disclosure the rule forbids. The caller maps null to `TaskNotFoundError`.
 */
export async function getA2aTaskFor(
  taskId: string,
  tenantId: string,
  mode: 'strict' | 'legacy',
): Promise<A2aTaskRecord | null> {
  const rec = await tasks.get(taskId);
  if (!rec) return null;
  return readableBy(rec, tenantId, mode) ? rec : null;
}

/**
 * `a2a-integration.md` §D.1 `ListTasks` — every durable Task the caller may
 * read, bounded to that tenant's index slice. §E: "cross-tenant runs MUST NOT
 * appear", which here is structural — a foreign row is not in the slice.
 */
export async function listA2aTasksForTenant(tenantId: string): Promise<A2aTaskRecord[]> {
  if (!tenantId || tenantId === UNBOUND_TENANT_SLICE) return [];
  return tasks.listForTenantIndexed(tenantId);
}

/**
 * RFC 0150 §A via `a2a-integration.md` §D.2 — the `messageId` idempotency
 * index: "a repeated `SendMessage` with the same (peer principal, `messageId`)
 * MUST NOT create a second run".
 *
 * A separate keyed collection rather than a scan over tasks: the lookup is on
 * the boundary call's identity, not on the task's, and a scan would be O(tenant)
 * on the hot submission path (the run-snapshot incident this repo already paid
 * for once). Same `DurableCollection` machinery — no second task table, per the
 * ADR 0552 boundaries row.
 */
interface A2aMessageClaim {
  claimKey: string;
  taskId: string;
  updatedAt: string;
  /**
   * Denormalized out of `claimKey` so ADR 0284 tenant teardown can REACH this
   * row. `purgeTenantRows` finds a row either through the collection's
   * `tenantOf` or through a JSON `tenantId` probe — a claim whose tenant lived
   * only inside a composite key would satisfy neither, and the row would
   * survive the teardown that deleted the task it points at. That is the
   * `tenantTeardownClaim` in `subject-erasure-coverage.test.ts` being TRUE
   * rather than asserted.
   */
  tenantId: string;
}
const messageClaims = new DurableCollection<A2aMessageClaim>('a2a:msgclaim', (c) => c.claimKey);

/**
 * The claim's storage key: a SHA-256 of the NUL-joined triple, never the raw
 * join. The raw join put `0x00` INTO the key, and Postgres text columns reject
 * that byte, so on a Postgres-backed host every A2A 1.0 `SendMessage` failed
 * with `-32603 invalid byte sequence for encoding "UTF8": 0x00`. MEASURED on
 * app.openwop.dev (suite 2.43.1 major-1 cut, 2026-09-28). The memory and SQLite
 * stores accept the byte, which is why no local test caught it. The NUL
 * separator is kept INSIDE the digest, so distinct triples cannot collide by
 * concatenation (`a` + `bc` vs `ab` + `c`). Exported for its test.
 */
export function claimKeyFor(tenantId: string, principalId: string, messageId: string): string {
  return createHash('sha256').update(`${tenantId}\u0000${principalId}\u0000${messageId}`).digest('hex');
}

/** The task a previous `SendMessage` with this identity opened, if any. */
export async function getA2aMessageClaim(
  tenantId: string,
  principalId: string,
  messageId: string,
): Promise<string | null> {
  const rec = await messageClaims.get(claimKeyFor(tenantId, principalId, messageId));
  return rec?.taskId ?? null;
}

/** Bind `(tenant, principal, messageId)` to the task it opened. */
export async function setA2aMessageClaim(
  tenantId: string,
  principalId: string,
  messageId: string,
  taskId: string,
): Promise<void> {
  await messageClaims.put({
    claimKey: claimKeyFor(tenantId, principalId, messageId),
    taskId,
    tenantId,
    updatedAt: new Date().toISOString(),
  });
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
  // ADR 0607 — delegates to the ONE ordered egress predicate. This function
  // previously carried its own copy that rejected a non-http(s) scheme and a
  // denied host but ACCEPTED plaintext `http:`, i.e. the exact shape
  // `routes/webhooks.ts` carried before ADR 0606 — which its own docblock above
  // predicts, since "a push URL is the same SSRF surface as a webhook".
  //
  // `honorDevFlag: false` is deliberate and MUST NOT be relaxed to match the
  // webhook posture: `SECURITY/invariants.yaml` `a2a-push-egress-ssrf` has a
  // conformance leg asserting a private push url is refused, and it runs in the
  // same process as `webhook-signed-delivery`, which requires the flag ON. A
  // shared flag posture would make the two mutually unsatisfiable.
  try {
    assertEgressUrlAllowed(url, { honorDevFlag: false });
  } catch (e) {
    if (e instanceof EgressUrlRejectedError) throw new A2aPushUrlDeniedError(url);
    throw e;
  }
}


/**
 * One delivery's target: the registered URL and, when the client registered
 * one, the opened `Authorization` value (RFC 0214 §A). Lives only for the call.
 */
export interface A2aPushTarget {
  url: string;
  authorization?: string;
  /** CHAN-F7 — `application/a2a+json` for a 1.0 config's `StreamResponse`; absent ⇒ `application/json`. */
  contentType?: string;
}

/**
 * What a delivery attempt came to. Carries no credential and no URL, so it is
 * safe to log and to hand back. `redirect` is a 3xx, which RFC 0214 §B and
 * `interop.md` §"A2A push delivery" make a failed delivery.
 */
export interface A2aPushOutcome {
  delivered: boolean;
  status?: number;
  reason?: 'redirect' | 'http_status' | 'network' | 'egress_denied';
}

/** A pluggable push sink so the firing path is testable without real egress. */
export type A2aPushSink = (
  target: A2aPushTarget,
  event: Record<string, unknown>,
) => void | A2aPushOutcome | Promise<void | A2aPushOutcome>;

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
 *
 * RFC 0214 §A: the push carries the registered destination credential, and the
 * credential is discarded once the task is terminal — the record written for a
 * terminal state never holds it, and that state's push (the final one) is
 * attempted with the value opened before the write.
 */
export async function upsertA2aTask(
  next: Omit<A2aTaskRecord, 'updatedAt'> & { updatedAt?: string },
): Promise<A2aTaskRecord> {
  if (next.pushConfig) assertPushUrlAllowed(next.pushConfig.url);
  const terminal = isTerminalTaskState(next.state);
  const sealed = next.pushConfig?.sealedAuthorization;
  const rec: A2aTaskRecord = { ...next, updatedAt: next.updatedAt ?? new Date().toISOString() };
  if (terminal && rec.pushConfig && sealed !== undefined) rec.pushConfig = publicPushConfig(rec.pushConfig);
  await tasks.put(rec);
  if (rec.pushConfig && pushSink && PUSH_TRANSITION_STATES.has(rec.state)) {
    // Logged fields name the task, state and outcome only: never the URL (a
    // client may put a secret in its query) and never the credential.
    try {
      const authorization = sealed !== undefined
        ? await openPushAuthorization(sealed, pushCredentialAad(rec.tenantId, rec.taskId))
        : undefined;
      // CHAN-F7 / RFC 0214 §C — a 1.0 config gets a 1.0 `StreamResponse`
      // (`statusUpdate` member) as `application/a2a+json`; a 0.3 config keeps the
      // 0.3 `TaskStatusUpdateEvent` its client parses.
      const v10 = rec.pushConfig.protocol === '1.0';
      const outcome = await pushSink(
        {
          url: rec.pushConfig.url,
          ...(authorization !== undefined ? { authorization } : {}),
          ...(v10 ? { contentType: A2A_10_MEDIA_TYPE } : {}),
        },
        v10 ? { statusUpdate: taskStatusUpdateEvent10(rec) } : taskStatusUpdateEvent(rec, terminal),
      );
      if (outcome && !outcome.delivered) {
        log.warn('a2a_push_delivery_failed', {
          taskId: rec.taskId,
          state: rec.state,
          reason: outcome.reason ?? 'unknown',
          ...(outcome.status !== undefined ? { status: outcome.status } : {}),
        });
      }
    } catch (e) {
      /* best-effort push — a delivery failure does not roll back the durable state */
      log.warn('a2a_push_delivery_failed', {
        taskId: rec.taskId,
        state: rec.state,
        reason: e instanceof Error ? e.name : 'unknown',
      });
    }
  }
  return rec;
}

/**
 * Register/replace the push-config for an existing durable Task (RFC 0100 §4).
 * Validates the URL through the SSRF guard before persisting, and seals the
 * registered credential (RFC 0214 §A) before it reaches the store. A
 * registration on a task that is already terminal keeps no credential: no push
 * is owed, so there is nothing to carry it to. Returns the updated record, or
 * null when the Task does not exist.
 */
export async function setA2aTaskPushConfig(taskId: string, config: A2aPushRegistration): Promise<A2aTaskRecord | null> {
  assertPushUrlAllowed(config.url);
  const existing = await tasks.get(taskId);
  if (!existing) return null;
  const pushConfig: A2aPushConfig = {
    url: config.url,
    ...(config.tokenFingerprint !== undefined ? { tokenFingerprint: config.tokenFingerprint } : {}),
    ...(config.id !== undefined ? { id: config.id } : {}),
    ...(config.protocol !== undefined ? { protocol: config.protocol } : {}),
  };
  if (config.authorization !== undefined && !isTerminalTaskState(existing.state)) {
    pushConfig.sealedAuthorization = await sealPushAuthorization(
      config.authorization,
      pushCredentialAad(existing.tenantId, taskId),
    );
  }
  const rec: A2aTaskRecord = { ...existing, pushConfig, updatedAt: new Date().toISOString() };
  await tasks.put(rec);
  return rec;
}

/** CHAN-F7 / RFC 0214 — the A2A 1.0 media type a 1.0 push body is sent as. */
export const A2A_10_MEDIA_TYPE = 'application/a2a+json';

/** CHAN-F7 — a client-chosen config id is kept only when it is a plain token. */
const CONFIG_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** The id a new config gets: the client's own plain id, else a random one that
 *  encodes nothing (RFC 0214: never a tenant, workspace or principal). */
export function pushConfigIdFor(clientId: unknown): string {
  return typeof clientId === 'string' && CONFIG_ID_RE.test(clientId) ? clientId : `pnc_${randomBytes(8).toString('hex')}`;
}

/** CHAN-F7 — the task's push config with that id, or null (no config, another id,
 *  or a legacy config with no id, which no client could have named). */
export async function getA2aTaskPushConfig(taskId: string, configId?: string): Promise<A2aPushConfig | null> {
  const rec = await tasks.get(taskId);
  const cfg = rec?.pushConfig;
  if (!cfg) return null;
  if (configId !== undefined && cfg.id !== configId) return null;
  return cfg;
}

/**
 * CHAN-F7 / RFC 0214 §A — delete the task's push config (its sealed credential
 * goes with it: discard on delete). Idempotent: a config that is already gone, or
 * an id that is not this task's, deletes nothing and is not an error. With no id,
 * the task's one config is deleted. Returns whether a config was removed.
 */
export async function deleteA2aTaskPushConfig(taskId: string, configId?: string): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const rec = await tasks.get(taskId);
    if (!rec?.pushConfig) return false;
    if (configId !== undefined && rec.pushConfig.id !== configId) return false;
    const { pushConfig: _dropped, ...rest } = rec;
    void _dropped;
    if (await tasks.compareAndSwap(rec, { ...rest, updatedAt: new Date().toISOString() })) return true;
  }
  return false;
}

/** Test-only: drop every persisted durable Task. */
export async function __resetA2aTaskStore(): Promise<void> {
  await tasks.__clear();
  await messageClaims.__clear();
}
