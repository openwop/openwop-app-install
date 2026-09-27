/**
 * ADR 0552 P2 — the A2A **1.0** codec: pure translation between the 1.0 wire
 * and this host's version-neutral A2A semantics.
 *
 * `spec/v1/a2a-integration.md` §"A2A 1.0 versioned composition" §D is the
 * contract, field by field. Everything here is a restatement of a row in D.1
 * (operations), D.3 (`Part`), D.4 (`Task` / `TaskState`) or D.7 (errors) — this
 * module adds no mapping of its own, exactly as `a2aTaskStore.ts` adds none to
 * the 0.3 projection it persists.
 *
 * THE ONE THING TO UNDERSTAND HERE (§D.4). The persisted `A2aTaskState` KEEPS
 * the 0.3 lowercase-hyphen vocabulary as the canonical stored form; the 1.0
 * interface renders it through a **bijection** at the boundary. One stored
 * vocabulary, two wire spellings — so a durable record written under 0.3 reads
 * correctly under 1.0 and vice versa, and there is no migration to get wrong.
 * The bijection is total in both directions and pinned by a test that walks
 * every member (`a2a-codec-1-0.test.ts`); the compiler holds the forward half
 * via the exhaustive `Record`, and the reverse half is derived from the same
 * table rather than typed a second time.
 *
 * 1.0 also removed two things a 0.3 decoder leans on, and both removals are
 * load-bearing here:
 *   - the `kind` discriminator on `Part` and on `StreamResponse` — a decoder
 *     MUST discriminate by MEMBER PRESENCE (`'text' in part`), never by `kind`;
 *   - the streaming `final` boolean — terminality is signalled by the state.
 *
 * @see spec/v1/a2a-integration.md §"A2A 1.0 versioned composition" §D.1–§D.7
 * @see https://github.com/a2aproject/A2A/blob/v1.0.0/specification/a2a.proto
 */

import type { A2aTaskRecord, A2aTaskState } from './a2aTaskStore.js';

/** The 1.0 `TaskState` enum (`TASK_STATE_*`), as published at `a2a.proto@v1.0.0`. */
export type A2aTaskState10 =
  | 'TASK_STATE_UNSPECIFIED'
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_AUTH_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_REJECTED';

/**
 * §D.4 — the stored (0.3) vocabulary → the 1.0 wire spelling.
 *
 * Typed as an exhaustive `Record<A2aTaskState, …>` on purpose: adding a member
 * to `A2aTaskState` without deciding its 1.0 spelling is then a COMPILE error,
 * not a runtime `undefined` that ships a task with no state. `TASK_STATE_
 * UNSPECIFIED` is deliberately absent from the range — §D.4 says it is "never
 * emitted", so it has no stored pre-image.
 */
const STORED_TO_WIRE_10: Record<A2aTaskState, A2aTaskState10> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  'input-required': 'TASK_STATE_INPUT_REQUIRED',
  'auth-required': 'TASK_STATE_AUTH_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
  rejected: 'TASK_STATE_REJECTED',
};

/** The inverse, DERIVED from the table above so the two halves cannot disagree. */
const WIRE_10_TO_STORED: ReadonlyMap<string, A2aTaskState> = new Map(
  (Object.entries(STORED_TO_WIRE_10) as Array<[A2aTaskState, A2aTaskState10]>).map(([stored, wire]) => [wire, stored]),
);

/** §D.4 forward — the stored state as a 1.0 `TaskState`. */
export function toWireState10(state: A2aTaskState): A2aTaskState10 {
  return STORED_TO_WIRE_10[state];
}

/**
 * §D.4 reverse — a 1.0 `TaskState` back to the stored vocabulary, for the host
 * acting as an A2A CLIENT reading a peer's task. `TASK_STATE_UNSPECIFIED` and
 * any value outside the enum return null: a state the host cannot name is not
 * silently coerced to `working` (which is how "the peer is still going" and
 * "we could not read the peer's answer" become the same fact).
 */
export function fromWireState10(wire: string): A2aTaskState | null {
  return WIRE_10_TO_STORED.get(wire) ?? null;
}

/** Every stored state, for the bijection test and for exhaustive iteration. */
export const STORED_TASK_STATES: readonly A2aTaskState[] = Object.keys(STORED_TO_WIRE_10) as A2aTaskState[];

/** §D.1 — the operations of the 1.0 JSON-RPC binding this host serves. */
export const A2A_10_METHODS = {
  sendMessage: 'SendMessage',
  sendStreamingMessage: 'SendStreamingMessage',
  getTask: 'GetTask',
  listTasks: 'ListTasks',
  cancelTask: 'CancelTask',
  subscribeToTask: 'SubscribeToTask',
  createPushConfig: 'CreateTaskPushNotificationConfig',
  getPushConfig: 'GetTaskPushNotificationConfig',
  listPushConfigs: 'ListTaskPushNotificationConfigs',
  deletePushConfig: 'DeleteTaskPushNotificationConfig',
  getExtendedCard: 'GetExtendedAgentCard',
} as const;

/**
 * §D.7 — the upstream 1.0 error catalogue, JSON-RPC codes. Named rather than
 * spelled inline so a mis-typed number is a compile error at the one call site
 * that owns it, and so `a2a-codec-1-0.test.ts` can assert the numbers against
 * the spec table in one place.
 */
export const A2A_10_ERROR = {
  TASK_NOT_FOUND: { code: -32001, reason: 'TASK_NOT_FOUND' },
  TASK_NOT_CANCELABLE: { code: -32002, reason: 'TASK_NOT_CANCELABLE' },
  PUSH_NOTIFICATION_NOT_SUPPORTED: { code: -32003, reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED' },
  UNSUPPORTED_OPERATION: { code: -32004, reason: 'UNSUPPORTED_OPERATION' },
  CONTENT_TYPE_NOT_SUPPORTED: { code: -32005, reason: 'CONTENT_TYPE_NOT_SUPPORTED' },
  INVALID_AGENT_RESPONSE: { code: -32006, reason: 'INVALID_AGENT_RESPONSE' },
  EXTENDED_AGENT_CARD_NOT_CONFIGURED: { code: -32007, reason: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED' },
  EXTENSION_SUPPORT_REQUIRED: { code: -32008, reason: 'EXTENSION_SUPPORT_REQUIRED' },
  VERSION_NOT_SUPPORTED: { code: -32009, reason: 'VERSION_NOT_SUPPORTED' },
} as const;

export type A2a10ErrorName = keyof typeof A2A_10_ERROR;

/** A2A 1.0.1 §9.5 / §10.6 — the `ErrorInfo` identity every A2A error carries. */
export const A2A_ERROR_DOMAIN = 'a2a-protocol.org';
export const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';

/** One `google.rpc.ErrorInfo`, rendered as a ProtoJSON `Any`. */
export type ErrorInfo10 = {
  '@type': typeof ERROR_INFO_TYPE;
  reason: string;
  domain: string;
  metadata?: Record<string, string>;
};

/**
 * ADR 0744 — the JSON-RPC `error.data` of an A2A 1.0 error.
 *
 * A2A 1.0.1 §9.5: `data` is "an array of objects, each containing a `@type`
 * key, using ProtoJSON `Any`", and SHOULD carry `google.rpc.ErrorInfo`. The
 * 2.36.x suite's fake peer and this host both emitted a bare `{ reason }`
 * object, which a strict a2a-js / a2a-python client reads as no reason at
 * all. `metadata` is `map<string,string>` upstream, so a list value (the
 * version refusal's `supportedVersions`) travels comma-joined (openwop TODO.md
 * decision D1).
 */
export function errorData10(reason: string, metadata?: Record<string, string>, domain: string = A2A_ERROR_DOMAIN): ErrorInfo10[] {
  return [
    {
      '@type': ERROR_INFO_TYPE,
      reason,
      domain,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  ];
}

/**
 * §D.7 — the host as A2A **client**: how a peer's `reason` projects onto the
 * canonical OpenWOP error envelope (`rest-endpoints.md` §Error codes) when the
 * failure crosses an OpenWOP boundary.
 *
 * A raw upstream body would leave an OpenWOP caller parsing a foreign protocol
 * to learn its own request was rejected. Note the deliberate asymmetry the spec
 * names in §D.7's closing paragraph and RFC 0152 UQ4: upstream error DETAILS
 * are **dropped, not redacted in place** — only the closed `reason` (and, for a
 * version error, `supportedVersions[]`) crosses. See {@link projectPeerError10}.
 */
const PEER_REASON_TO_OPENWOP_CODE: Readonly<Record<string, string>> = {
  TASK_NOT_FOUND: 'not_found',
  TASK_NOT_CANCELABLE: 'run_terminal',
  PUSH_NOTIFICATION_NOT_SUPPORTED: 'capability_required',
  UNSUPPORTED_OPERATION: 'capability_required',
  CONTENT_TYPE_NOT_SUPPORTED: 'validation_error',
  INVALID_AGENT_RESPONSE: 'validation_error',
  EXTENDED_AGENT_CARD_NOT_CONFIGURED: 'not_found',
  EXTENSION_SUPPORT_REQUIRED: 'validation_error',
  VERSION_NOT_SUPPORTED: 'interop_version_unsupported',
};

/** The projection of one peer failure onto the canonical envelope. */
export interface ProjectedPeerError10 {
  /** The canonical `rest-endpoints.md` code. */
  code: string;
  /** The closed upstream `reason`, when the peer named one this host knows. */
  reason?: string;
  /** Only for a version failure — the peer's own `supportedVersions[]`. */
  supportedVersions?: readonly string[];
}

/**
 * Project a peer's 1.0 JSON-RPC error onto the canonical OpenWOP envelope code
 * (§D.7, right-hand column), DROPPING everything the spec does not let across.
 *
 * What survives: the closed `reason` (only when it is one of the nine upstream
 * names — an unrecognised string is a foreign token, not a fact), and
 * `supportedVersions[]` for a version failure. What does NOT survive, by
 * construction rather than by filtering: the peer's `message`, its
 * `data.domain`, and every other member of `data`. This function never reads
 * them, so there is no redaction rule to get wrong later.
 */
/**
 * ADR 0744 — read a peer's `error.data` in either shape: the upstream `Any[]`
 * (A2A 1.0.1 §9.5 — the `ErrorInfo` element's `reason` and
 * `metadata.supportedVersions`, comma-joined) or the legacy bare object this
 * host and the 2.36.x suite peer emitted (`{ reason, supportedVersions[] }`).
 * Only those two members are read; everything else stays unread.
 */
function peerErrorDetail(raw: unknown): { reason?: unknown; supportedVersions?: unknown } {
  if (Array.isArray(raw)) {
    const info = raw.find(
      (d): d is { reason?: unknown; metadata?: unknown } =>
        typeof d === 'object' && d !== null && (d as { '@type'?: unknown })['@type'] === ERROR_INFO_TYPE,
    );
    if (!info) return {};
    const md = typeof info.metadata === 'object' && info.metadata !== null ? (info.metadata as { supportedVersions?: unknown }) : {};
    return { reason: info.reason, supportedVersions: md.supportedVersions };
  }
  if (typeof raw === 'object' && raw !== null) return raw as { reason?: unknown; supportedVersions?: unknown };
  return {};
}

export function projectPeerError10(err: unknown): ProjectedPeerError10 {
  const e = (err ?? {}) as { code?: unknown; data?: unknown };
  const data = peerErrorDetail(e.data);
  const byReason = typeof data.reason === 'string' && data.reason in PEER_REASON_TO_OPENWOP_CODE ? data.reason : undefined;
  // Fall back to the numeric code when the peer omitted `data.reason` — the
  // numbers are as normative as the names in the §D.7 table.
  const byCode =
    byReason === undefined && typeof e.code === 'number'
      ? (Object.entries(A2A_10_ERROR).find(([, v]) => v.code === e.code)?.[1].reason ?? undefined)
      : undefined;
  const reason = byReason ?? byCode;
  const code = reason !== undefined ? PEER_REASON_TO_OPENWOP_CODE[reason]! : 'upstream_error';
  const versions =
    reason !== 'VERSION_NOT_SUPPORTED'
      ? undefined
      : Array.isArray(data.supportedVersions)
        ? data.supportedVersions.filter((v): v is string => typeof v === 'string')
        : typeof data.supportedVersions === 'string'
          ? data.supportedVersions.split(',').map((v) => v.trim()).filter((v) => v !== '')
          : undefined;
  return {
    code,
    ...(reason !== undefined ? { reason } : {}),
    ...(versions !== undefined ? { supportedVersions: versions } : {}),
  };
}

/**
 * §D.3 — one `Part`, decoded from the 1.0 `oneof` by MEMBER PRESENCE.
 *
 * 1.0 removed the `kind` discriminator, so a decoder that switches on `kind`
 * reads every 1.0 part as unknown and silently drops it. The order below is the
 * §D.3 table's order; `data` is checked with `in` because a legitimate
 * structured part may be `null`.
 */
export type DecodedPart10 =
  | { member: 'text'; text: string }
  | { member: 'raw'; raw: string; mediaType?: string; filename?: string }
  | { member: 'url'; url: string; mediaType?: string; filename?: string }
  | { member: 'data'; data: unknown }
  | { member: 'unknown' };

export function decodePart10(part: unknown): DecodedPart10 {
  if (part === null || typeof part !== 'object') return { member: 'unknown' };
  const p = part as Record<string, unknown>;
  const mediaType = typeof p.mediaType === 'string' ? p.mediaType : undefined;
  const filename = typeof p.filename === 'string' ? p.filename : undefined;
  if (typeof p.text === 'string') return { member: 'text', text: p.text };
  if (typeof p.raw === 'string') {
    return { member: 'raw', raw: p.raw, ...(mediaType ? { mediaType } : {}), ...(filename ? { filename } : {}) };
  }
  if (typeof p.url === 'string') {
    return { member: 'url', url: p.url, ...(mediaType ? { mediaType } : {}), ...(filename ? { filename } : {}) };
  }
  if ('data' in p) return { member: 'data', data: p.data };
  return { member: 'unknown' };
}

/**
 * The text a 1.0 `Message` carries, for the run input.
 *
 * ONLY `text` members contribute. A `url` part is a REFERENCE and §D.3 forbids
 * auto-fetching it (dereferencing is an RFC 0079 egress decision); a `raw` part
 * is bytes that MUST NOT be inlined into the run event log. Concatenating
 * either into the prompt is how a "reference, never auto-fetched" becomes an
 * SSRF and a payload-bound event log.
 */
export function messageText10(message: unknown): string {
  const parts = (message as { parts?: unknown[] } | undefined)?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => {
      const decoded = decodePart10(p);
      return decoded.member === 'text' ? decoded.text : '';
    })
    .join('')
    .trim();
}

/** §D.3 outbound — a text `Part` in the 1.0 oneof shape (no `kind`). */
export function textPart10(text: string): Record<string, unknown> {
  return { text };
}

/** §D.3 outbound — a `data` `Part` (structured JSON; `data` may legitimately be any JSON value). */
export function dataPart10(data: unknown, mediaType = 'application/json'): Record<string, unknown> {
  return { data, mediaType };
}

/**
 * RFC 0205 §B.5 (ADR 0746) — a conversation turn's opaque `content` as A2A
 * `Part`s, or `undefined` when the turn gets no `parts` (legal: §B.7 — a turn
 * without `parts` stays valid on emission, replay and fork).
 *
 *   - a string                          → one `text` Part;
 *   - a `ContentPart[]` of ONLY text    → one `text` Part per element;
 *   - a `ContentPart[]` with any media  → `undefined`. A `raw` Part would copy the
 *     base64 into the event log a second time (the inbound rule above: bytes are
 *     never inlined into the run log), a `url` Part would publish a reference
 *     whose authorization this seam cannot state (§A.3), and dropping only the
 *     media would make the A2A reading of the turn say something the turn did
 *     not. Omitting is the one honest option;
 *   - any other JSON value              → one `data` Part;
 *   - `null` / `undefined`              → `undefined` (nothing to carry).
 *
 * Pure and deterministic, so a replayed turn derives byte-equal parts.
 */
export function partsFromTurnContent(content: unknown): Record<string, unknown>[] | undefined {
  if (content === null || content === undefined) return undefined;
  if (typeof content === 'string') return [textPart10(content)];
  if (Array.isArray(content) && content.length > 0 && content.every(isTypedContentPart)) {
    if (!content.every((p) => p.type === 'text' && typeof p.text === 'string')) return undefined;
    return content.map((p) => textPart10(p.text as string));
  }
  return [dataPart10(content)];
}

/** A host `ContentPart` element (`providers/dispatch.ts`) — structural, no import back into the exchange pipeline. */
function isTypedContentPart(p: unknown): p is { type: string; text?: unknown } {
  if (p === null || typeof p !== 'object') return false;
  const t = (p as { type?: unknown }).type;
  return t === 'text' || t === 'image' || t === 'file' || t === 'audio';
}

/** RFC 0205 §A.2 — the input to one A2A `Artifact` this host serves as `application/a2a+json`. */
export interface Artifact10Input {
  artifactId: string;
  name?: string;
  description?: string;
  /** Exactly one content member: structured JSON (`data`) or text with its media type. */
  body: { kind: 'data'; data: unknown } | { kind: 'text'; text: string; mediaType: string };
  /** `metadata.openwop.artifactTypeId` — only a value in the `typeId` grammar reaches the wire. */
  artifactTypeId?: string;
}

/** `ids.schema.json#/$defs/typeId` (v2), without the reference-only `@x.y.z` pin. */
const TYPE_ID_RE = /^[a-z][a-z0-9_-]*(\.[a-z][a-zA-Z0-9_-]*)+$/;

/**
 * RFC 0205 §A.2 / §D — an A2A 1.0 `Artifact`. No `url` Part is ever produced
 * (§A.3): the payload is inlined as `data`/`text`, so nothing in the body can
 * resolve beyond the caller's `artifacts:read` authorization.
 * `metadata.openwop.schemaVersion` is deliberately absent — this host's
 * artifact-type registry carries no schema version, and a stated one would be
 * invented (ADR 0746 D4).
 */
export function artifact10(input: Artifact10Input): Record<string, unknown> {
  const part = input.body.kind === 'data'
    ? dataPart10(input.body.data)
    : { text: input.body.text, mediaType: input.body.mediaType };
  const typeId = input.artifactTypeId !== undefined && TYPE_ID_RE.test(input.artifactTypeId) && input.artifactTypeId.length <= 256
    ? input.artifactTypeId
    : undefined;
  return {
    artifactId: input.artifactId,
    ...(input.name ? { name: input.name } : {}),
    ...(input.description ? { description: input.description } : {}),
    parts: [part],
    ...(typeId ? { metadata: { openwop: { artifactTypeId: typeId } } } : {}),
  };
}

/** §D.2 — the 1.0 `Role` enum. Both roles enter the run as untrusted content. */
export type A2aRole10 = 'ROLE_USER' | 'ROLE_AGENT';

/** One 1.0 `Message` this host emits (history entries, `status.message`). */
export interface Message10Input {
  messageId: string;
  role: A2aRole10;
  text: string;
  taskId?: string;
  contextId?: string;
}

export function message10(input: Message10Input): Record<string, unknown> {
  return {
    messageId: input.messageId,
    role: input.role,
    parts: [textPart10(input.text)],
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
  };
}

/**
 * §D.4 — project one persisted record into a 1.0 `Task`.
 *
 * Differences from the 0.3 projection (`projectTaskRecordToA2aTask`) that are
 * NOT cosmetic:
 *   - no `kind: 'task'` (removed in 1.0; a decoder discriminates structurally);
 *   - `status.state` in `TASK_STATE_*` via the bijection;
 *   - `artifacts[]` / `history[]` are present and EMPTY unless the caller
 *     supplies them, because §D.4 makes them part of the shape while §D.5 and
 *     the SR-1 trust boundary forbid run-internal transcripts, tool I/O and
 *     `agent.*` reasoning from appearing in either.
 *
 * `metadata.openwop.interrupt` is the RFC 0100 carrier, and §D.4 says it is the
 * only normative member of `Task.metadata` — so nothing else is added here.
 */
export function projectTaskRecordToA2aTask10(
  rec: A2aTaskRecord,
  extras?: { history?: readonly Record<string, unknown>[]; artifacts?: readonly Record<string, unknown>[] },
): Record<string, unknown> {
  const task: Record<string, unknown> = {
    id: rec.taskId,
    status: statusOf10(rec),
    artifacts: [...(extras?.artifacts ?? [])],
    history: [...(extras?.history ?? [])],
  };
  if (rec.contextId) task.contextId = rec.contextId;
  if ((rec.state === 'input-required' || rec.state === 'auth-required') && rec.interruptKind) {
    task.metadata = { openwop: { interrupt: { kind: rec.interruptKind } } };
  }
  return task;
}

/** `TaskStatus` — with RFC 0199 §D.1's message when AUTH_REQUIRED carries one
 *  (A2A §7.6.1: "MUST include a TaskStatus message explaining the required
 *  authorization"). The id is derived, so a re-read is byte-stable. */
function statusOf10(rec: A2aTaskRecord): Record<string, unknown> {
  return {
    state: toWireState10(rec.state),
    ...(rec.state === 'auth-required' && rec.statusMessage
      ? { message: message10({ messageId: `${rec.taskId}:auth-required`, role: 'ROLE_AGENT', text: rec.statusMessage, taskId: rec.taskId, ...(rec.contextId ? { contextId: rec.contextId } : {}) }) }
      : {}),
    timestamp: rec.updatedAt,
  };
}

/**
 * §D.5 — a 1.0 `TaskStatusUpdateEvent` (the `statusUpdate` member of the
 * `StreamResponse` oneof).
 *
 * There is deliberately NO `final` flag: 1.0 removed it and "terminality is
 * signalled by the state itself". Re-adding one would give a peer two sources
 * of truth for the same fact, which is how a stream ends early on one and late
 * on the other.
 */
export function taskStatusUpdateEvent10(rec: A2aTaskRecord): Record<string, unknown> {
  const evt: Record<string, unknown> = {
    taskId: rec.taskId,
    status: statusOf10(rec),
  };
  if (rec.contextId) evt.contextId = rec.contextId;
  if ((rec.state === 'input-required' || rec.state === 'auth-required') && rec.interruptKind) {
    evt.metadata = { openwop: { interrupt: { kind: rec.interruptKind } } };
  }
  return evt;
}
