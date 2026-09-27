/**
 * Internal types shared across the workflow-engine sample backend.
 *
 * Wire-shape types (CreateRunRequest, RunSnapshot, RunEventDoc, etc.)
 * come from `@openwop/openwop`. This module adds the host-internal
 * shapes — Principal, RunRecord, EventRecord, InterruptRecord — that
 * the storage adapters and route handlers pass between themselves.
 */

import type {
  CreateRunRequest,
  ErrorEnvelope,
  RunStatus,
  StreamMode,
} from '@openwop/openwop';

export type { CreateRunRequest, ErrorEnvelope, RunStatus, StreamMode };

/**
 * ADR 0601 — HOW this principal authenticated, stamped at the ONE boundary that
 * knows (`middleware/auth.ts`, plus `routes/mcp.ts` for the conformance seam).
 *
 * This exists because `principalId` is an IDENTITY, not an AUTHORITY, and the
 * two are not interchangeable for every credential the host accepts. Membership
 * rows are keyed on a caller's RBAC subject (`user:<id>` / `oidc:<sub>`), so a
 * member lookup keyed on `principalId` can only ever match the cookie/OIDC
 * lanes: an API-key principal is minted as `bearer:<first 8 chars of the key>`
 * or `apikey:<keyId>`, neither of which is a subject anyone could seed a member
 * row for (and the first of which changes on rotation).
 *
 * A consumer that must answer "what may this caller DO" reads this discriminant
 * instead of pattern-matching the id string. Pattern-matching a prefix is a
 * heuristic over a value some other module chose; this is provenance recorded by
 * the module that made the choice.
 */
export type PrincipalAuth =
  /** Cookie session bound to a durable user, or an OIDC bearer. `principalId` IS
   *  the RBAC subject, so membership resolution is meaningful. */
  | { kind: 'subject' }
  /** Anonymous cookie session (`session:<sid>` in an `anon:<sid>` tenant). Never
   *  a member of anything; authority comes from the single-principal rules. */
  | { kind: 'anon' }
  /** An operator credential configured in the host's own environment
   *  (`OPENWOP_API_KEYS`). Whoever set it IS the deployment operator, so it acts
   *  as the tenant's own principal in the tenant the config pinned it to. */
  | { kind: 'env-key' }
  /** A self-service ADR 0270 `owk_` key: a DELEGATION. `issuer` is the RBAC
   *  subject that minted it (`ApiKeyRecord.createdBy`) and `scopes` are the
   *  key's own declared scopes — empty meaning "undeclared", not "none". */
  | { kind: 'api-key'; issuer: string; scopes: readonly string[] }
  /** The `OPENWOP_TEST_SEAM_ENABLED` conformance principal. Deliberately carries
   *  no authority of its own. */
  | { kind: 'test-seam' };

/** Synthetic principal returned by the stub auth middleware. */
export interface Principal {
  /** Opaque principal identifier (Bearer-token claim or stub-derived). */
  principalId: string;
  /** Tenants this principal may operate under. Empty array = no access. */
  tenants: readonly string[];
  /** Bearer token presented (sample only — never log in production). */
  token: string;
  /** ADR 0601 — the credential provenance (see `PrincipalAuth`). Optional: a
   *  principal minted outside the auth boundary carries none, and an authority
   *  resolver that finds none MUST fall back to subject resolution (fail-closed
   *  for a credential lane, never open). */
  auth?: PrincipalAuth;
}

/** Persisted run record. Wire shape derives from this via projection. */
export interface RunRecord {
  runId: string;
  workflowId: string;
  tenantId: string;
  scopeId?: string;
  status: RunStatus;
  inputs: unknown;
  metadata: Record<string, unknown>;
  configurable: Record<string, unknown>;
  callbackUrl?: string;
  idempotencyKey?: string;
  parentRunId?: string;
  parentSeq?: number;
  forkMode?: 'replay' | 'branch';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** ADR 0371 — precomputed retention deadline (completedAt + TTL), stamped by
   *  the storage layer when a patch carries a terminal status. The sweeper
   *  range-scans this; definition overrides/pins re-validate at sweep time. */
  removalAt?: string;
  error?: { code: string; message: string };
  /** Current node, when in a running/waiting state. */
  currentNodeId?: string;
  /** Serialized DAG scheduler snapshot — populated when the run pauses on
   *  one or more suspended branches. JSON-encoded `SerializedSnapshot`
   *  (see executor/executor.ts). Absent for non-DAG (legacy linear) runs. */
  schedulerSnapshot?: string;
  /** RFC 0040 / RFC 0083 §C-3 — optional id of the event/delivery that caused
   *  this run. When set, it is stamped as `run.started`'s `causationId` so
   *  `/ancestry` resolves the cause → run (e.g. a trigger delivery → run). */
  causationId?: string;
  /** Multi-instance dispatch lease. Set by `executeRun` at start to the
   *  instance id that is executing the run; the lease (`dispatchLeaseExpiresAt`,
   *  epoch ms) outlives the max legal runtime, so an alive run is never
   *  re-dispatched. The `runDispatchSweeper` re-dispatches `pending`/`running`
   *  runs whose lease has expired (the owning instance crashed). Cleared
   *  implicitly: terminal/`waiting-*` status excludes a run from the sweep. */
  dispatchOwner?: string | null;
  dispatchLeaseExpiresAt?: number | null;
  /** `spec/v2/core/persistence.md` §"The era key" — `eventLogSchemaVersion`,
   *  the per-run key naming the vocabulary this run's event log is written in.
   *  `3` = the v2 era (v2 event-type names stored verbatim); ABSENT = the v1
   *  era, which reads as `2` and is never backfilled. The only writer is the
   *  storage seat (`storage/eventEraAdapter.ts`), which stamps `3` on every
   *  run this host creates; no route or service sets it. */
  eventLogSchemaVersion?: number;
}

/** Persisted run event with monotonic sequence per run. */
export interface EventRecord {
  eventId: string;
  runId: string;
  sequence: number;
  type: string;
  nodeId?: string;
  payload: unknown;
  timestamp: string;
  causationId?: string;
  /** `spec/v2/core/events.md` §"The envelope" (RFC 0171 §A, RFC 0172 §B axis 5)
   *  — the PER-EVENT schema version, REQUIRED on a major-2 `RunEventDoc` and
   *  OPTIONAL in the v1 schema. It is NOT a stored column: this host has never
   *  versioned an event payload, so every event it has ever written is version
   *  `1` and a column would hold one constant forever. The value is supplied at
   *  the storage seat (`storage/eventEraAdapter.ts`) on a major-2 read, the same
   *  place and the same way `persistence.md` §"The era key" lets a host
   *  synthesize `eventLogSchemaVersion` for a run that predates it. A producer
   *  that starts versioning a payload sets the field and the seat leaves it
   *  alone. */
  schemaVersion?: number;
}

/** Persisted RFC 0056 annotation (a per-run side-resource — NOT a replayable
 *  event-log entry). `correction`/`note` are stored already secret-redacted. */
export interface AnnotationRecord {
  annotationId: string;
  runId: string;
  tenantId: string;
  /** Full annotation document (annotation.schema.json shape), redacted. */
  payload: unknown;
  createdAt: string;
}

/** Persisted interrupt awaiting resolution. */
export interface InterruptRecord {
  interruptId: string;
  runId: string;
  nodeId: string;
  kind: 'approval' | 'clarification' | 'refinement' | 'cancellation' | 'external-event' | 'conversation' | 'timer' | 'tour-step' | 'walkthrough-step' | 'credential';
  /** Signed token usable via POST /v1/interrupts/{token}. */
  token: string;
  data: unknown;
  resumeSchema?: Record<string, unknown>;
  createdAt: string;
  /** Token expiry (RFC 0093 §B.1) — minted at creation; default 30 min
   *  (`OPENWOP_INTERRUPT_TOKEN_TTL_SEC`), capped at the interrupt's own
   *  `timeoutMs` deadline when one exists. Past this instant the signed-token
   *  endpoints refuse with `410 interrupt_expired`. Optional only for
   *  pre-migration rows (treated as non-expiring). */
  expiresAt?: string;
  /** Set when resolved. */
  resolvedAt?: string;
  resolvedValue?: unknown;
}

/** Persisted webhook subscription. */
export interface WebhookSubscriptionRecord {
  subscriptionId: string;
  /** Owning tenant (RFC 0093 §A.3) — established by the registration-time
   *  membership gate; scopes list/delete AND delivery fanout. Pre-RFC rows
   *  are migrated to `'default'`. */
  tenantId: string;
  url: string;
  events: readonly string[];
  tags?: readonly string[];
  /** HMAC-SHA256 secret, SEALED at rest via the BYOK KMS envelope when KMS is
   *  configured (`host/webhookSecretCodec.ts` — always sealed in the
   *  enterprise/auth posture, whose boot guard mandates KMS); plaintext only
   *  in the local/demo posture (legacy rows pass through on read). */
  secret: string;
  createdAt: string;
  /**
   * The protocol major this subscriber speaks, stamped from the negotiated
   * contract at REGISTRATION and fixed for the subscription's lifetime
   * (ADR 0629 / `spec/v2/core/versioning.md` §5).
   *
   * WHY THE SUBSCRIPTION AND NOT THE EVENT. Under major 2 a runId is the
   * tenant-bound `<tenantId>/<opaque>` projection, and `run-event.schema.json`
   * binds `runId` to that grammar by `$ref` — so a v2 delivery carrying a bare
   * uuid is non-conformant. But a delivery is not a response to a versioned
   * request: it is an EMISSION, with no header to negotiate from. The only
   * major a subscriber has ever seen ids in is the one it registered under.
   *
   * ABSENT MEANS 1, and that is the load-bearing half. Every row written
   * before this field existed, and every `/v1/webhooks` registration, keeps
   * receiving the bare id it receives today — projecting unconditionally would
   * silently rewrite the identifiers live v1 integrations correlate on, which
   * is the same defect (an id the receiver cannot match) in the other
   * direction.
   */
  protocolMajor?: 1 | 2;
  /**
   * RFC 0201 §B — the signature schemes the dispatcher applies, fixed at
   * registration. ABSENT MEANS `["v1"]`: every row written before ADR 0747 and
   * every registration that did not send the field is a non-opted subscription,
   * and RFC 0201 §B.8 binds it to today's behaviour byte for byte (no
   * `webhook-*` headers, no verification, no rotation). Present only when the
   * registration carried the field.
   */
  signatureAlgorithms?: readonly string[];
  /** RFC 0201 §E — the secret a rotation replaced, in the same at-rest form as
   *  `secret`. It signs ONLY while `previousSecretExpiresAt` is in the future;
   *  past that instant it is inert even though the row still holds it
   *  (§E.20 "the previous secret MUST NOT sign anything"). */
  previousSecret?: string;
  /** Epoch ms — end of the rotation overlap. */
  previousSecretExpiresAt?: number;
  /** Epoch ms — the most recent rotation. */
  rotatedAt?: number;
}

/**
 * Durable webhook-delivery queue row. Each subscription that matches an emitted
 * event gets one row; the background worker (`webhookWorker.ts`) claims due
 * rows, POSTs the signed delivery, and either marks it `delivered` or reschedules
 * it with exponential backoff until `maxAttempts` is reached (then `dead`).
 *
 * The claim lease (`claimedBy` + `claimExpiresAt`) makes the queue
 * multi-instance-safe: a crashed worker's lease expires and another instance
 * re-claims the row, so deliveries survive a process crash rather than being
 * dropped (the prior `setImmediate` fire-and-forget path lost them).
 */
export interface WebhookDeliveryRecord {
  deliveryId: string;
  subscriptionId: string;
  /** Exact subscription id emitted on the delivery wire. Major-2 rows carry
   *  the tenant-bound form; absent on historical/major-1 rows means the stored
   *  `subscriptionId` remains the wire value. Persisted because a retry after
   *  restart must emit the same deduplication key as its first attempt. */
  wireSubscriptionId?: string | null;
  /** Owning tenant of the subscription, stamped at enqueue (RFC 0215 §A.3,
   *  ADR 0752 P2) so the dispatcher can bound one tenant's in-flight attempts.
   *  NULL on rows enqueued before the column existed: those are not tenant-capped. */
  tenantId?: string | null;
  url: string;
  /** ADR 0747 — WRITTEN, NO LONGER READ. The worker signs with the
   *  SUBSCRIPTION's secrets at send time, because a secret copied at enqueue
   *  would keep signing after an RFC 0201 §E rotation retired it (§E.20). The
   *  column is still written so a rollback to a revision that reads it keeps
   *  delivering. Original doc follows.
   *
   *  HMAC-SHA256 secret captured at enqueue time. (CORRECTED WHD-16: this used
   *  to say "the subscription may be deleted before delivery"; deleting a
   *  subscription now removes its PENDING rows, so a delivery never outlives
   *  its subscription — the capture keeps an in-flight claim signable.) Carries the subscription's AT-REST form —
   *  sealed when KMS is configured; the worker opens it at signing time. */
  secret: string;
  eventType: string;
  /** The exact JSON body to POST (a serialized EventRecord). */
  payload: string;
  status: 'pending' | 'delivered' | 'dead';
  attempts: number;
  maxAttempts: number;
  /** Epoch ms; a row is due when `status === 'pending'` AND `nextAttemptAt <= now`. */
  nextAttemptAt: number;
  /** Claim lease: worker id + expiry (epoch ms). A due row whose lease is absent or expired is re-claimable. */
  claimedBy?: string | null;
  claimExpiresAt?: number | null;
  lastError?: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * ADR 0551 P1 — one durable dispatch intent, keyed by the run it starts.
 *
 * The row is appended in the SAME atomic storage operation that makes the run
 * visible, so `HTTP 201` means both the run and the intent to start it are
 * durable. `setImmediate(executeRun)` is now only a WAKEUP HINT: if the process
 * dies before it fires, this row is what makes the run start anyway.
 *
 * Identity is `runId` (PRIMARY KEY), so a second append for the same run is a
 * write error rather than a second delivery.
 *
 * A completed row is DELETED rather than marked terminal (the ADR 0549
 * `releaseIdempotentResponse` reasoning): the table is a queue, and a queue that
 * only ever grows is a defect. `dead` is the one retained state — attempts
 * exhausted, kept for the operator surface ADR 0551 P2 owns.
 */
export interface DispatchOutboxRecord {
  runId: string;
  tenantId: string;
  workflowId: string;
  status: 'pending' | 'dead';
  attempts: number;
  /** Epoch ms; a row is due when `status === 'pending'` AND `nextAttemptAt <= now`. */
  nextAttemptAt: number;
  /** Claim lease: worker id + expiry (epoch ms). A due row whose lease is absent or expired is re-claimable. */
  claimedBy?: string | null;
  claimExpiresAt?: number | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * ADR 0551 P2 — the whole-queue facts an operator surface and the backlog
 * metrics need, computed by the adapter rather than by counting a listing.
 *
 * A listing is capped, so counting one under-reports exactly when the queue is
 * in trouble — the "counts computed over a capped sample must SAY so" problem
 * the Operations webhook summary already carries. These are unbounded
 * aggregates, so the numbers are true at any depth.
 *
 * `oldestPendingCreatedAt` is the row's CREATION time, not its `nextAttemptAt`:
 * the question the oldest-age signal answers is "how long has an accepted run
 * been waiting for someone to start it", and a rescheduled row's next attempt
 * is always near-future no matter how long it has been stuck.
 */
export interface DispatchOutboxStats {
  pending: number;
  dead: number;
  /** ISO-8601 `createdAt` of the oldest PENDING row, or null when there is none. */
  oldestPendingCreatedAt: string | null;
}

/** Idempotency key replay entry. */
export interface IdempotencyRecord {
  key: string;
  responseBody: string;
  responseStatus: number;
  createdAt: string;
}

/** Persisted chat-session header. Mirrors the FE `ChatSession` minus
 *  the messages array (kept in a separate table for unbounded growth +
 *  paged loads). Tied to a tenantId so the host-extension routes
 *  can scope listings by tenant. Sample-grade: no per-user concept;
 *  all sessions for a tenant are visible to that tenant's principal. */
export interface ChatSessionRecord {
  sessionId: string;
  tenantId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Cached count; updated on append/reset. Sample-grade — caller-
   *  authoritative count is `listChatSessionMessages(sessionId).length`. */
  messageCount: number;
  /** ADR 0151 — title provenance, gating auto-titling so it runs ONCE and never
   *  clobbers a manual rename. `'default'` (or absent) = the substring placeholder,
   *  still auto-titleable; `'auto'` = an LLM title was written (don't re-run);
   *  `'user'` = the user renamed it (never overwrite). Additive; legacy/absent ⇒
   *  treated as `'default'`. */
  titleSource?: 'default' | 'auto' | 'user';
}

/** One message inside a chat session. Content is a JSON string (the
 *  FE's ChatMessage shape carries multimodal content, thoughts, agent
 *  events, citations, etc. — we don't shred them into columns). */
export interface ChatMessageRecord {
  messageId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'workflow_run';
  /** Serialized ChatMessage minus the id (the id is on this row). */
  content: string;
  /** Serialized meta (provider, model, tokens, error, citations, etc.)
   *  — null when the bubble has no meta (user turns, system banners). */
  meta: string | null;
  /** The subjectRef of the principal that AUTHORED (appended) this message —
   *  SERVER-STAMPED from the authenticated caller, never client-supplied (ADR
   *  0102 Phase 2). Authorizes in-place edits: only the author or the session
   *  owner/manager may UPDATE a message, so a member of a shared chat can't
   *  overwrite another's. `null` for legacy rows (pre-migration) + anon appends
   *  ⇒ owner-writable. */
  authorSubject: string | null;
  createdAt: string;
}

/** Run-create request augmented with the resolved principal. */
export interface InternalCreateRunRequest extends CreateRunRequest {
  workflowId: string;
  tenantId: string;
}

/**
 * Notification surface (PR #143).
 *
 * Persisted per-tenant inbox of action-needed signals. Each row is one
 * notification. The wire shape mirrors this almost exactly, modulo the
 * snake_case → camelCase translation done by the row mapper.
 *
 * `type` is a dotted-namespace string. Today's emitters use:
 *   - `openwop-app.workflow.approval-needed` — HITL interrupt opened (action: resume the run)
 *   - `workflow.input_needed`    — clarification/refinement interrupt
 *   - `workflow.failed`          — run terminated with an error
 *   - `system.alert`             — operator-level signal
 *
 * The set is open — clients render unknown types via a generic shape.
 */
export type NotificationType =
  | 'openwop-app.workflow.approval-needed'
  | 'workflow.input_needed'
  | 'workflow.failed'
  | 'workflow.completed'
  | 'system.alert'
  // ADR 0049 — a kanban card was assigned to a person (addressed notification,
  // delivered via the ADR 0050 `recipientUserId` channel).
  | 'task.assigned'
  // ADR 0074 — a review (interrupt/approval) changed state. NOT an inbox
  // notification: emitted via the emitter's non-persisted `signal()` path as a
  // tenant-broadcast cache hint for the live review-status store. Never
  // inserted into Storage, never web-pushed, excluded from action-needed.
  | 'review.updated';

export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export type NotificationStatus = 'unread' | 'read' | 'archived';

export interface NotificationRecord {
  notificationId: string;
  tenantId: string;
  /**
   * ADR 0050 — per-recipient targeting. When set, this is an **addressed**
   * notification visible only to that user (within `tenantId`); when absent
   * it is a **broadcast** notification visible to the whole tenant/workspace
   * (the pre-0050 behavior, unchanged). The two channels coexist; this is NOT
   * a user-only model — see ADR 0050.
   */
  recipientUserId?: string;
  /**
   * ADR 0050 Phase 3 — role-addressed broadcast. When set (and `recipientUserId`
   * is absent) the notification is visible only to tenant members who HOLD this
   * RBAC role (ADR 0006/0015 workspace-root roles), resolved at read time. A row
   * with `recipientRole` set is NEVER a plain broadcast — a member lacking the
   * role does not see it (default-deny). Examples: billing/quota → `admin`/`owner`.
   */
  recipientRole?: string;
  type: NotificationType | string;
  priority: NotificationPriority;
  status: NotificationStatus;
  title: string;
  message: string;
  /** Workflow-run pointer when the notification is run-scoped. */
  runId?: string;
  workflowId?: string;
  nodeId?: string;
  interruptId?: string;
  /** SPA deep-link the notification clicks through to. */
  actionUrl?: string;
  /** Arbitrary per-type payload — kind, resumeSchema digest, etc. */
  metadata?: Record<string, unknown>;
  createdAt: string;
  readAt?: string;
  archivedAt?: string;
}

/**
 * Web Push subscription record (RFC 8030). One row per browser/device
 * per tenant — a user with two laptops + a phone produces three rows.
 *
 * `endpoint` + `p256dhKey` + `authKey` are the three opaque values the
 * browser handed us at subscribe time. The `web-push` library uses all
 * three to encrypt the payload before delivering to the user agent.
 * Treated like credentials: anyone with all three can push to that
 * browser, so we serve them only over auth'd routes and never log
 * verbatim.
 */
export interface PushSubscriptionRecord {
  subscriptionId: string;
  tenantId: string;
  /** ADR 0050 — the user who registered this device. Lets addressed
   *  notifications push only to their recipient's devices. Absent on rows
   *  registered before the migration (legacy) — those receive broadcasts only,
   *  never addressed notifications (a null owner can't be safely matched). */
  userId?: string;
  endpoint: string;
  p256dhKey: string;
  authKey: string;
  userAgent?: string;
  createdAt: string;
  lastUsedAt?: string;
}

/**
 * User-authored agent record (phase E1, 2026-05-28).
 *
 * Persisted shape backing `POST /v1/host/openwop-app/agents`. On boot the
 * app reads every row and registers it with the in-process
 * `AgentRegistry` (RFC 0070); the existing `GET /v1/agents` /
 * `/v1/agents/:agentId` inventory routes then project both
 * pack-installed and user-authored agents through the same surface.
 *
 * `agentId` shape: `user.<tenantId>.<personaSlug>` — the `user.`
 * prefix avoids collision with pack ids (always begin with the pack
 * name). Per-tenant scoping means `user.acme.code-reviewer` and
 * `user.beta.code-reviewer` can coexist.
 */
export interface UserAgentRecord {
  agentId: string;
  tenantId: string;
  persona: string;
  label?: string;
  description?: string;
  modelClass: string;
  systemPrompt: string;
  toolAllowlist: string[];
  memoryShape: {
    scratchpad: boolean;
    conversation: boolean;
    longTerm: boolean;
  };
  confidenceThreshold?: number;
  createdAt: string;
}

/**
 * Rich, host-local product configuration attached to a standing agent —
 * the "enterprise digital work twin" property set (ADR 0031). NON-NORMATIVE:
 * this is host-extension config under `/v1/host/openwop-app/agents/:id/profile`; it
 * is explicitly NOT a field on the RFC 0003 agent manifest wire shape, and no
 * OpenWOP client consumes it. `GET /v1/agents` keeps returning the normative
 * manifest projection unchanged — the profile is a separate, additive read.
 *
 * Single-source-of-truth discipline (ADR 0031 §Decision): `workflows[]` and
 * `schedules[]` are NOT duplicated here — they remain owned by
 * `RosterEntry.workflows` and the scheduler. The profile carries role/behavior
 * config only.
 *
 * @see docs/adr/0031-agent-profile-and-seeding.md
 * @see src/host/agentProfileService.ts
 */
/**
 * Core agent capabilities that any named agent may ACTIVATE via its profile
 * (David's architecture law, 2026-06-13): every capability lives at the
 * core-agent level and is turned on per named agent — never hardcoded to one
 * `roleKey`. `assistant` is the operating-rhythm capability (structured memory
 * graph + perception loops + action drafting/approval, ADR 0023) that the
 * Chief of Staff (Iris) historically embodied; it is now activatable on ANY
 * agent (e.g. Executive Operations). `knowledge` (ADR 0038) is the per-agent
 * knowledge & memory capability — bound KB collections (cited) + the agent's
 * private RFC-0004 memory namespace, composed into dispatch retrieval. The union
 * grows as new capabilities are extracted to the core level.
 *
 * ADR 0045/0048 — `capabilities[]` is the "what a subject can DO" axis, ORTHOGONAL
 * to the subject `kind` ("what it IS", `host/subject.ts`). `cognition` names the
 * agent's inherent ability to take model turns (dispatch) — implied by an agent's
 * `kind:'agent'` projection (gating dispatch on the flag is a deferred follow-on,
 * ADR 0048, to avoid regressing existing agents). `advisor` names eligibility for
 * an advisory board (ADR 0040) — a capability, NOT a kind (an advisor is an agent).
 */
/**
 * ADR 0442 (KickBot) — `coaching` names an agent's operating rhythm as a
 * persistent guide: it coordinates a participant's daily plan, explains the next
 * step, and helps recovery (PRD §6.8). Like `cognition`'s gating (ADR 0048), the
 * RUNTIME that reads this flag lands incrementally — P1 ships the capability +
 * its by-capability resolver (`features/kicktodo-core/coachingCapability.ts`),
 * P2/P5 wire the daily-coach presentation and specialist dispatch that consume
 * it. It lives at the CORE level, activated per named agent via
 * `AgentProfile.capabilities` — never fused to a `roleKey` (David's law); KickBot
 * is just the agent that activates it.
 *
 * ADR 0458 (Challenge Author) — `challenge-authoring` names an agent that drives
 * the Challenge Factory: it converses a creator through a challenge concept and
 * ignites the `challenge-factory` workflow through its assigned workflows. Like
 * `coaching`, it lives at the CORE level and is activated per named agent via
 * `AgentProfile.capabilities` — never fused to a `roleKey` (David's law); the
 * pack's Challenge Author persona is just the agent that activates it. The
 * runtime that reads it lands incrementally — P1 provisions the capability + the
 * per-tenant named agent (`features/kicktodo-creator/challengeAuthoringCapability.ts`).
 */
export type AgentCapabilityId = 'assistant' | 'knowledge' | 'cognition' | 'advisor' | 'deep-investigation' | 'coaching' | 'challenge-authoring';

export interface AgentProfile {
  /** The owning agent's id — `rosterId` (preferred, for standing agents) or
   *  the definition-level `agentId`. Also the `DurableCollection` key. */
  profileId: string;
  tenantId: string;
  /** Role template key, e.g. `finance-close`. Mirrors `RosterEntry.roleKey`. */
  roleKey: string;
  /** Core agent capabilities this named agent has ACTIVATED. The runtime gates
   *  capability behavior (e.g. the assistant loops/approvals) on this list —
   *  NEVER on `roleKey`. Absent/empty ⇒ no core capabilities activated. */
  capabilities?: AgentCapabilityId[];
  /** ADR 0442 P3 — how this agent's long-term/knowledge MEMORY namespace is
   *  keyed when it recalls memory into a turn (a HOST-LOCAL profile field —
   *  deliberately NOT on the wire-frozen `memoryShape`, which is
   *  `additionalProperties:false` per RFC 0003/0004). Default `'agent'` = the
   *  shared `agent:<profileId>` scope (every existing agent — byte-identical to
   *  before). `'per-user'` = the ACTING participant's OWN `user:<subject>` scope,
   *  so a standing agent shared across a cohort tenant recalls each participant's
   *  own memory and NEVER another user's (the ADR 0442 F1 isolation invariant).
   *  Resolved generically by `resolveAgentMemoryScope` — no agent-id special-case
   *  (David's law). Fail-closed: `per-user` with no acting user recalls nothing,
   *  never the shared scope. */
  memoryScope?: 'agent' | 'per-user';
  department?: { departmentId: string; name: string; roleId?: string; roleName?: string };
  /** Free-form per-twin config (thresholds, calendars, approval matrices). */
  configParameters?: Record<string, unknown>;
  /** Advisory access controls (day-1: metadata only; ADR 0031 open-question 1). */
  permissions?: { read: string[]; write: string[]; never: string[] };
  /** Action types that always require human approval. */
  hitl?: string[];
  escalation?: { contacts: string[]; triggers: string[] };
  channels?: { approval?: string; delivery?: string };
  adminControls?: string[];
  riskCompliance?: string[];
  /** Connections provider ids that gate activation (ADR 0033). */
  requiredConnections?: string[];
  /** Per-agent knowledge & memory bindings (ADR 0038 — additive). Present only
   *  when the agent has the `knowledge` capability activated + a user has bound a
   *  source. `collectionIds` references EXISTING KB collections (cited docs,
   *  ADR 0011 — no new collection type); `memoryWritable` allows user-curated
   *  notes to flow into the agent's RFC-0004 memory namespace (`agent:<id>`);
   *  `retrieval` tunes how bound knowledge is composed into dispatch. */
  knowledge?: {
    collectionIds?: string[];
    memoryWritable?: boolean;
    retrieval?: { topK?: number; sources?: ('kb' | 'memory')[] };
  };
  /** ADR 0044 — the digital-twin LINK: this agent is a twin of `userId` (an
   *  opaque `user:<id>` principal). Set by an admin/owner; grants NO memory access
   *  by itself. Cross-subject recall additionally requires a user-issued
   *  `TwinGrant` (host-owned, `twinService`) — the link is configuration, the
   *  grant is authorization. Phase 1 (ADR 0044) stores the link + grant only; the
   *  fenced recall composition is Phase 2. */
  twin?: { userId: string; linkedBy: string; linkedAt: string };
  /** Success/analytics metric keys. */
  metrics?: string[];
  autonomy: {
    /** The enforced roster level — may be derived from `specLevel` via the
     *  ADR 0031 mapping table when not explicitly set. */
    level: 'auto' | 'guided' | 'review';
    /** The spec's four-level model — kept for provenance/display. */
    specLevel: 'draft-only' | 'recommend' | 'execute-with-approval' | 'autonomous-within-policy';
    /** Allowlisted actions when `level === 'auto'` — makes "autonomous within
     *  policy" honest (anything off-list falls back to review). */
    withinPolicyActions?: string[];
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * Canonical openwop error codes used inside the sample. Wire shape is
 * `ErrorEnvelope`; the route handlers map host-internal exceptions to
 * these codes via `mapErrorToEnvelope()`.
 */
export type OpenwopErrorCode =
  | 'invalid_request'
  // ADR 0621 — live-session revocation (host-ext, never on the wire). The three
  // 401 refusals a durable-user session can receive per request, the two 503
  // authority faults (D6 / the unregistered seam), and the D7 self-lockout refusal.
  | 'account_disabled'
  | 'account_erased'
  | 'session_revoked'
  | 'session_authority_unavailable'
  | 'session_authority_unregistered'
  | 'self_lockout'
  | 'validation_error'
  | 'unauthenticated'
  | 'forbidden'
  | 'forbidden_tenant'
  | 'forbidden_scope'
  | 'not_found'
  | 'workflow_not_found'
  | 'run_not_found'
  | 'interrupt_not_found'
  | 'interrupt_already_resolved'
  | 'interrupt_gone'
  // RFC 0093 §B.1 — signed-token surface only: token past `expiresAt` (410).
  | 'interrupt_expired'
  | 'invalid_interrupt_token'
  | 'idempotency_key_conflict'
  // `idempotency.md` §"Concurrent duplicates" naming note (2026-08-18, SP-03):
  // the spec named no mismatch error until v1.5, so implementations diverged.
  // `idempotency_key_mismatch` is canonical — the only spelling already present
  // in more than one shipped artifact (the gRPC mapping + the published SDK) —
  // and the suite asserts it. THIS host was the "tier-1 host emitting
  // `idempotency_key_replay_mismatch`" that note names; H63 is the move.
  | 'idempotency_key_mismatch'
  // `spec/v2/core/idempotency.md` §"Layer 1" (RFC 0170 §D.3) — an
  // `Idempotency-Key` outside `^[A-Za-z0-9._~-]{22,128}$`. Major 2 only:
  // narrowing the v1 wire's free-form key would be a new refusal on a shipped
  // contract. `400`, and MUST NOT be cached.
  | 'idempotency_key_invalid'
  // `spec/v2/core/identity.md` §5 (RFC 0170 §D.1) — a tenant-bound id whose
  // tenant segment is not the caller's. `403`, and the refusal MUST NOT
  // disclose whether the resource exists (`runs.md` §Identity).
  | 'id_tenant_mismatch'
  // `spec/v2/core/identity.md` §4 (RFC 0170 §E.1) — a resume token outside the
  // `ow2.<alg>.<kid>.<payload>.<mac>` grammar, or carrying an `alg` this host
  // does not advertise, a `kid` it does not hold, or a MAC that does not
  // verify. `401`, one code for all four states.
  | 'interrupt_token_invalid'
  // RFC 0199 §B.3/§B.4/§E.2 (ADR 0753 P3) — an MCP-reach provider whose discovered
  // metadata does not verify against its manifest (or its pin); no authorization
  // URL is issued. `422`, not retriable.
  | 'connection_auth_metadata_mismatch'
  // ADR 0549 P4 — the in-flight code, paired with `details.retryAfter`.
  // `idempotency.md` §"Concurrent duplicates": when a second request arrives on
  // a live claim, the server MAY block and return the same response, or MAY
  // answer `409 Conflict` with `{ error: "idempotency_in_flight", message,
  // details: { retryAfter } }`. This host chooses the 409 — and once it does,
  // that BODY SHAPE is prescribed, not optional. It previously answered
  // `idempotency_key_conflict` with no `retryAfter`, so a caller was told
  // "conflict" with no indication that waiting is the correct response.
  //
  // TWO CORRECTIONS, both to claims made here without checking (2026-08-18):
  //
  //  1. This comment cited `idempotency.md:62`. That line is the Layer-1 record
  //     digest/state rule and says nothing about concurrency; the in-flight
  //     contract is §"Concurrent duplicates". A precise-looking citation is
  //     trusted more than prose, so a wrong one is worse than none.
  //  2. It also called the old answer unsafe because it echoed the caller's key
  //     — "§F: keys MUST NOT reach logs, and an error body is a logged surface".
  //     FALSE on this host. Measured: `middleware/errorEnvelope.ts:111` logs
  //     only path/method/message/stack and fires ONLY for non-`OpenwopError`
  //     failures, so an `OpenwopError` envelope is never logged and `details`
  //     reaches no log line; `observability/metrics.ts:76` already lists
  //     `idempotencyKey` in `FORBIDDEN_LABELS`; and no response-body logging
  //     middleware exists. §F binds logs and spans. An error body returned to
  //     the caller WHO SUPPLIED THE KEY is neither, and tells them nothing they
  //     did not send.
  //
  // So `details.idempotencyKey` stays. Removing it on a rationale that does not
  // apply would be a small dishonesty of its own. (Caught by openwop-app-54,
  // who went to reuse the reasoning and verified it first.)
  | 'idempotency_in_flight'
  | 'host_capability_missing'
  | 'capability_not_provided'
  // `capabilities.md` §"Unsupported capability — refusal contract" names a
  // CLOSED set of refusal codes: `validation_error` (broadest),
  // `capability_required` ("specific — preferred when the host wants to be
  // unambiguous"), or `not_found`. This host had only the broad one, so an
  // author whose workflow was refused for a MISSING CAPABILITY could not tell
  // that apart from a malformed document — the two need different fixes.
  // Added for RFC 0151's `settings.compensation` refusal (ADR 0554 P2), whose
  // schema names this code explicitly; it is the general code, not a
  // compensation one.
  | 'capability_required'
  | 'credential_required'
  | 'credential_forbidden'
  // RFC 0121 §B.8 — a subscription-mode credential MUST bind at `user` scope;
  // a tenant/workspace binding is forbidden (the subscription-scope safety rail).
  | 'credential_scope_forbidden'
  // RFC 0122 — self-hosted runner: no owning-subject runner is registered for a
  // dispatch (retriable; a runner may (re)connect). See host/selfHostedRunner.ts.
  | 'runner_unavailable'
  // ADR 0187 — application-layer egress firewall: the target host is denied by
  // the tenant's egress policy (or the always-on SSRF baseline). See host/egressPolicy.ts.
  | 'egress_blocked'
  // RFC 0129 / ADR 0290 — data-residency admission control: a run-create request
  // pinned a `residency.region` this host does not advertise. Fail-closed at 422;
  // no run is created (routes/runs.ts + features/cdp/dataResidency.ts).
  | 'residency_unavailable'
  // Host-ext (ADR 0217 / gap plan B3): a money-adjacent commerce mutation met the
  // tenant's commerce-spend approval threshold — a PendingApproval was parked in the
  // reviews inbox; retry the same call after the human decision (409, details carry
  // { approvalId, approvalStatus }).
  | 'approval_required'
  // Host-ext (CONS-4 / WF-CONS-1), same shape as `approval_required` above: a
  // destructive compliance action (DSAR subject erasure, retention purge) was
  // refused because the tenant is under a LEGAL HOLD. GDPR Art. 17(3)(b)/(e)
  // makes a hold override erasure, so this is a refusal the operator must SEE
  // — 409 with `details: { held: true, reason, since }`, never a silent skip or
  // a 200 that reads as "erased". The exit is named: lift the hold, retry.
  | 'legal_hold'
  // ADR 0657 D10 — the erasure tombstone is a WRITE barrier: a consent write on an
  // erased subject is refused (409) until an administrator re-admits them; a public
  // writer racing a DSAR must never re-insert the record it just lost its CAS to.
  | 'subject_erased'
  // ADR 0657 D5 — the consent store could not be READ on a public lane: 503, never a
  // 500 and never "recorded" (the analytics beacon).
  | 'consent_unreadable'
  | 'credential_unavailable'
  // Managed-provider preflight in POST /v1/runs (routes/runs.ts): an
  // anon caller submitting a workflow that pins any node to a
  // `managed:*` credentialRef. Same code the managed dispatch path
  // emits at chat-node execution time, just surfaced earlier.
  | 'sign_in_required'
  /** `runs.md` §Fork — a fromSeq naming no event in the source log (422).
   *  Registered in `spec/v2/errors.json`, so it travels UNPREFIXED; the retired
   *  `fork_invalid_seq` was ours and namespaced to `openwop-app.*`. */
  | 'fork_from_seq_unsupported'
  | 'fork_point_invalid'
  | 'fork_unsupported_mode'
  // Honest-split refusal for `mode: 'replay'` with `fromSeq > 0` (501):
  // this sample supports deterministic replay only as a full re-execution
  // from sequence 0 (see routes/runs.ts :fork + discovery `replay.modes`).
  // (`fork_checkpoint_unsupported` REMOVED, ADR 0751: a fork at a suspended
  // checkpoint re-creates the gate instead of refusing — no spec licensed the 501.)
  // ADR 0751 — a fork whose inherited open gate names a source interrupt that is
  // missing or outside its ancestry fails closed on this code (a node.failed-style
  // run failure, never a request refusal).
  | 'fork_interrupt_unavailable'
  | 'rate_limited'
  | 'unsupported_stream_mode'
  | 'internal_error'
  // Pack-registry codes per spec/v1/node-packs.md §"Registry HTTP API"
  | 'invalid_pack_name'
  | 'invalid_pack_scope'
  | 'invalid_version'
  | 'invalid_body'
  | 'pack_not_found'
  | 'signature_not_available'
  // RFC 0025 — additional publish-error codes surfaced by the
  // test-mode mirror namespace `/v1/packs-test/*` (mirror of the
  // production publish surface). The full 19-code catalog is also
  // documented at node-packs.md §"PUT /v1/packs/{name}/-/{version}.tgz".
  | 'tarball_gunzip_failed'
  | 'tarball_too_large'
  // RFC 0177 §A.1 / §B.1 — the two install-time refusals `spec/v2/core/packs.md`
  // requires of a major-2 host. `pack_runtime_requirement_unmet` is deliberately
  // NOT reused: packs.md says it "remains a runtime-requirement code and MUST
  // NOT be used for the protocol major".
  | 'pack_engine_unsupported'
  | 'pack_peer_dependency_undefined'
  | 'tarball_manifest_missing'
  | 'tarball_manifest_too_large'
  | 'tarball_manifest_not_json'
  | 'tarball_entry_missing'
  | 'tarball_entry_too_large'
  | 'tarball_path_traversal'
  | 'tarball_tar_parse_failed'
  | 'invalid_manifest'
  | 'manifest_mismatch'
  | 'manifest_name_mismatch'
  | 'manifest_version_mismatch'
  | 'pack_integrity_failure'
  | 'unsupported_runtime'
  | 'conflict'
  // ADR 0305 grade pass — the canvas optimistic-concurrency conflict (409), so the
  // editor's stale-save path is a typed envelope, never a 500 internal_error.
  | 'canvas_version_conflict'
  // ADR 0359 Phase 6 — an external write to a live `canvas.document` room (409):
  // no generic apply path for an XmlFragment, so the veto is typed + honest.
  | 'canvas_room_live'
  | 'version_conflict'
  // ADR 0592 §7 — CMS AI translation produced unusable model output after the
  // ONE bounded error-fed repair (502): a typed failure, never success-with-
  // empty (the authoring-path invariant).
  | 'translation_invalid'
  | 'unpublish_window_expired'
  // Webhook codes per spec/v1/webhooks.md
  | 'webhook_url_rejected'
  // RFC 0201 §D.14 — an opted-in registration whose endpoint did not echo the
  // verification challenge (400, non-retriable; `spec/v2/errors.json`).
  | 'webhook_endpoint_unverified'
  | 'subscription_not_found'
  // Connection-pack codes per spec/v1/connection-packs.md (RFC 0095)
  | 'connection_pack_credential_material'
  | 'connection_provider_unresolved'
  | 'connection_provider_conflict'
  // RFC 0157 (× RFC 0151 §B) — chain-expansion refusals, named in
  // `spec/v1/workflow-chain-packs.md` §"Error codes" as codes a host operating
  // on workflow-chain packs MUST use. They are TOP-LEVEL codes here rather than
  // `details.code` under a generic `validation_error`: the two failures need
  // different author fixes (reconcile a policy vs. delete one of two
  // contradictory node declarations), and burying them would leave the flat
  // envelope unable to tell them apart. Joining the closed union is also what
  // makes a new code a compile error at every exhaustive switch rather than a
  // silent 500.
  //
  /** HTTP 409. The chain declares a `compensation` policy and the parent
   *  workflow already carries a `settings.compensation` that is not deep-equal.
   *  Expansion MUST NOT merge — `details.chainId`. */
  | 'chain_compensation_policy_conflict'
  /** HTTP 400, non-retriable. A fragment node declares BOTH
   *  `irreversibleEffect: true` and a `compensation` — an effect cannot both
   *  have and lack an inverse. `details.nodeId` + `details.chainId`. */
  | 'chain_irreversible_with_compensation'
  // v2 charter Phase 4 (P4-C) — `spec/v2/errors.json` row `event_type_unmapped`
  // (500, since 2.0, RFC 0176 §A.3: "a run whose log the host cannot translate
  // is not readable"). Raised at the storage seat when an era-2 row carries a
  // type the codemap does not name on its v1 side and that has no vendor prefix.
  | 'event_type_unmapped'
  // RFC 0021 §"Trust boundary" / RFC 0209 §C.12 (ADR 0749) — an approval bound
  // to an A2UI surface that untrusted content touched cannot be resolved (403).
  // Not in the v2 registry, so major 2 carries it vendor-prefixed.
  | 'untrusted_content_blocks_approval';

/**
 * The envelope as this host BUILDS it — before `v2ErrorCode` translation.
 *
 * SDK 2.x narrowed `ErrorEnvelope.error` to `ErrorCode | VendorErrorCode`: the
 * 97 registered spec codes, or a dotted vendor code. This host's internal
 * vocabulary is neither. It is the v1 spelling plus host-extension codes
 * (`run_not_found`, `forbidden_scope`, the ADR 0621 session codes), and 14 of
 * its 21 members are in neither set.
 *
 * That is not a wire defect, and MEASURED on the live host it is not reaching
 * the wire: `GET /runs/<missing>` answers `run_not_found` under major 1 and
 * `not_found` under major 2, because `middleware/protocolVersion.ts`
 * translates at the emitter — a registered code passes through, a known v1
 * spelling is aliased onto its registered twin, and anything else is
 * namespaced `openwop-app.<code>`, which is exactly the SDK's
 * `VendorErrorCode` shape.
 *
 * So the SDK type is correct about the WIRE and wrong about this struct. The
 * two are different values either side of `v2ErrorCode`, and conflating them
 * is what the 1.7→2.1 bump surfaced. Typing the pre-translation envelope as
 * the post-translation one would have needed a cast, and a cast here would
 * have silenced a correct narrowing rather than answering it.
 */
export interface HostErrorEnvelope {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export class OpenwopError extends Error {
  constructor(
    public readonly code: OpenwopErrorCode,
    message: string,
    public readonly httpStatus: number = 500,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OpenwopError';
  }

  /** The PRE-translation envelope — see `middleware/errorEnvelope.ts`'s
   *  `HostErrorEnvelope`. `this.code` is the host vocabulary, which
   *  `v2ErrorCode` maps onto a registered or vendor-namespaced code at the
   *  emitter; the SDK's `ErrorEnvelope` describes that output, not this one. */
  toEnvelope(): HostErrorEnvelope {
    return {
      error: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}
