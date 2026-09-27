/**
 * Outbound MCP client (ADR 0030) — `ctx.mcp.{invokeTool,readResource,listTools,
 * serverStatus}`. Calls an EXTERNAL MCP server over JSON-RPC/HTTP with the run's
 * acting human's per-user Connection token. The missing other half of RFC 0020
 * (which only lets the host be exposed AS a server).
 *
 * Per-call pipeline (authz → resolve → invoke → mark):
 *   1. `serverId` → a `reach:'mcp'` Connections provider whose manifest carries
 *      `mcpServer.url` (host-curated — an author NEVER supplies a URL). Else
 *      `server_not_found`.
 *   2. Governance gate (ADR 0028 `isProviderAllowed`) — fail-closed.
 *   3. Per-user credential (ADR 0024 `resolveConnectionCredential`,
 *      `connections:use` enforced) — no connection ⇒ `mcp_not_connected`.
 *      EXCEPT an OPERATOR-managed server (H21, `mcpOperatorServer.ts`), which
 *      has no per-user Connection by construction: its bearer comes from the
 *      operator's BYOK ref, failing closed to the same typed error.
 *   4. JSON-RPC POST with `Authorization: Bearer`, over the RFC 0093 dispatcher
 *      (SSRF + pinned resolution), no-redirect, bounded timeout.
 *   5. Stamp `run.metadata.connectionUse[]` (RFC 0079) on success.
 *   6. Mark the result `untrustedContent` (ADR 0027 — external tool output is the
 *      `prompt-injection-mcp-marker` boundary; the pack wraps it for the LLM).
 *
 * ── ADR 0553 P2: the client speaks the CURRENT revision ────────────────────
 *
 * Every outbound call now declares its revision three ways that MUST agree
 * (RFC 0153 §B): the `MCP-Protocol-Version` header, `Mcp-Method`, and
 * `params._meta`'s `protocolVersion` + `clientCapabilities`. A conversation
 * opens at `advertisedMcpProtocolVersion()` and is only ever lowered
 * EXPLICITLY: a peer answering `UnsupportedProtocolVersionError` (`-32022`)
 * makes this client select a revision from `data.supported[]` that it also
 * lists, re-issue under THAT revision, and report it — the invariant
 * `mcp-version-no-silent-downgrade`. When the intersection is empty the call
 * fails closed with `interop_version_unsupported` carrying `requested` +
 * `supported[]`; it is never retried header-less, which is what "silently
 * proceed under a lower revision" would look like in this file.
 *
 * MRTR (§C.1) replaces the peer's ability to call back. A tool that answers
 * `resultType: "input_required"` gets its `inputRequests` resolved by the run's
 * own elicitation path (a `clarification` interrupt in production; a
 * programmatic answer under the §23 seam), and the ORIGINAL request is retried
 * with `inputResponses` + the `requestState` echoed byte-exactly. The initial
 * call and its retries are ONE logical invocation (RFC 0150 §B), so the
 * executor's Layer-2 invocation log dedups them as a unit and a replay returns
 * the recorded outcome instead of re-issuing anything.
 *
 * SECURITY: token host-side only (never node config / events / run doc / log);
 * endpoint manifest-curated; three fail-closed gates. A peer's `_meta`,
 * extension settings and `requestState` are OPAQUE (§D/§E): they are echoed
 * where the protocol requires and read nowhere else, and the value this client
 * returns has a CLOSED shape with no channel for them — a peer cannot widen a
 * run's scopes or advance an approval by decorating a result.
 */

import { createHash } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { ReplayEffectError } from './runEffectContext.js';
import { createLogger } from '../observability/logger.js';
import { classifyMcpClientOutcome, recordMcpRequest } from '../observability/metricSeams.js';
import {
  advertisedMcpProtocolVersion,
  servesMcpVersion,
  MCP_CURRENT_VERSION,
  MCP_ERR_UNSUPPORTED_VERSION,
  MCP_LEGACY_VERSION,
  MCP_METHOD_HEADER,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_CLIENT_INFO,
  MCP_META_PROTOCOL_VERSION,
  MCP_META_SERVER_INFO,
  MCP_NAME_HEADER,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_SUPPORTED_VERSIONS,
  versionForMcpProfile,
  type McpProtocolVersion,
} from './mcpProfile.js';
import { mcpAuditTarget, recordMcpAudit, type McpAuditOutcome, type McpAuditReason } from './mcpAudit.js';
import { readMcpCache, writeMcpCache, type McpCacheScopeKey } from './mcpClientCache.js';
import { childOf, traceFields, traceHeaders, type TraceContext } from './traceContext.js';
import { resolveSubjectScopesUnion } from './accessControlService.js';
import type { Storage } from '../storage/storage.js';
import { getProvider } from '../features/connections/providerRegistry.js';
import { getConnection, resolveConnectionCredential } from '../features/connections/connectionsService.js';
import { isProviderAllowed } from './governanceService.js';
import { resolveOperatorMcpCredential } from './mcpOperatorServer.js';
import { webhookEgressDispatcher, webhookPrivateEgressAllowedFor } from './webhookEgressGuard.js';
import { stampConnectionUse } from './connectionInjection.js';
import { recordAuthorityAction } from './authorityContext.js';

const log = createLogger('connections.mcp');

/** May a NON-https MCP endpoint be called? Only under the webhook-family
 *  relaxation, and — since WHD-19 — only for exactly this origin when the
 *  relaxation is the allowlist rather than the blanket flag. */
function plaintextMcpRelaxed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return webhookPrivateEgressAllowedFor(parsed);
}
const DEFAULT_TIMEOUT_MS = 15_000;
// subscribe-resource (ADR 0030 Phase 2b) — bounded in-band change-detection
// polling (NOT a persistent connection / daemon). The node blocks for the window,
// emitting on each detected change, like `logListener`. Every knob is clamped to a
// host ceiling so an author-supplied config can't turn the node into an
// egress-amplification / slot-holding DoS — the caps live HERE, not in the pack
// (the pack is one edit from threading author `config` through, as `logListener`
// already does).
const DEFAULT_SUBSCRIBE_DURATION_MS = 60_000;
const MAX_SUBSCRIBE_DURATION_MS = 10 * 60_000; // 10 min hard ceiling
const DEFAULT_SUBSCRIBE_POLL_MS = 5_000;
const MIN_SUBSCRIBE_POLL_MS = 100; // cadence floor (the per-read budget is separate — see MIN_SUBSCRIBE_READ_TIMEOUT_MS)
const DEFAULT_SUBSCRIBE_MAX_EVENTS = 100;
const MAX_SUBSCRIBE_MAX_EVENTS = 1_000;
// A poll's READ budget, decoupled from the cadence: a fast 100 ms cadence must NOT
// imply a 100 ms request timeout (that guarantees `mcp_timeout` on a real network).
const MIN_SUBSCRIBE_READ_TIMEOUT_MS = 2_000;
// Gate failures (misconfig: unknown server / not allow-listed / not connected /
// insecure endpoint) can NEVER succeed on retry; a transient failure can.
const GATE_ERROR_CODES = new Set(['server_not_found', 'insecure_mcp_endpoint', 'connector_not_allowed', 'mcp_not_connected']);

/**
 * §C.1 "the host MUST bound the number of rounds (host policy) so a server
 * cannot spin a run indefinitely". Three is generous for a form-filling round
 * trip and small enough that a hostile peer cannot hold a node open.
 */
const MAX_MRTR_ROUNDS = 3;

/** Abort-aware sleep: resolves early (does not reject) when `signal` fires, so a
 *  cancelled run leaves the poll loop promptly instead of waiting out the window. */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
const sha256 = (v: unknown): string => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v ?? null)).digest('hex');

/** §C.1 — an `elicitation/create` the peer put in `inputRequests`. */
export interface McpElicitationRequest {
  readonly key: string;
  readonly mode: string;
  readonly message: string;
  readonly requestedSchema: Record<string, unknown>;
}

/** The upstream `ElicitResult` this client puts in `inputResponses[key]`. */
export interface McpElicitResult {
  readonly action: 'accept' | 'decline' | 'cancel';
  readonly content?: Record<string, unknown>;
}

/**
 * How the run answers an MRTR elicitation. In production this suspends the node
 * with a `clarification` interrupt and a human answers it; the §23 conformance
 * seam supplies a programmatic answer instead. When ABSENT, an `input_required`
 * result is a TYPED FAILURE — never a silent fall back to the legacy live
 * `elicitation/create` callback, which §C forbids in as many words.
 */
export type McpElicitationResolver = (req: McpElicitationRequest) => Promise<McpElicitResult>;

export interface McpClientDeps {
  storage: Storage;
  tenantId: string;
  /** The run this MCP use is stamped on (ADR 0030 provenance). OPTIONAL (ADR 0258): a
   *  RUNLESS caller (the UCP buyer's discover/search/checkout, which are not executor runs)
   *  omits it — the connection-use stamp is then skipped and the caller records its own
   *  audit (`recordCommerceAction`). `stampConnectionUse` already no-ops a missing run, so
   *  this is purely to avoid a wasted `getRun` on a synthetic id. */
  runId?: string;
  actingUserId?: string;
  orgId?: string;
  /** Optional run-cancellation signal. When supplied, an aborted run cancels an
   *  in-flight request AND exits the subscribe poll loop.
   *
   *  WIRED as of ADR 0553 P3 / H53 (`9b2af4839`): `armRunAbort` in
   *  `executor/runLifecycle.ts` arms the signal and `notifyRunTerminal` fires
   *  it, so a cancelled or deadline-breached run aborts an in-flight MCP call
   *  with `mcp_cancelled` and sends the courtesy `notifications/cancelled`.
   *  This docblock said "currently dormant — wiring it is the tracked remaining
   *  gap" until 2026-08-18, four commits after it stopped being true.
   *
   *  KNOWN LIMIT, recorded rather than implied: the abort registry is a module
   *  Map (`runLifecycle.ts:76`), so it is PROCESS-LOCAL. A cancel served by one
   *  instance does not abort a call in flight on another; closing that needs the
   *  cross-instance signal ADR 0551 P3's harness is the prerequisite for. */
  signal?: AbortSignal;
  /** RFC 0207 §A — the W3C trace context this MCP use continues. Every outbound
   *  request carries a CHILD of it in BOTH carriers: `params._meta.traceparent`
   *  (the SHOULD, and the only carrier that exists on stdio) and the HTTP
   *  `traceparent` header. Absent ⇒ no carrier is sent, which is what a run
   *  started with no inbound trace honestly is. Correlation only: it is never
   *  read as tenant, principal or scope. */
  traceContext?: TraceContext;
  /** §C.1 — how an MRTR `input_required` is answered. */
  elicitationResolver?: McpElicitationResolver;
  /**
   * `_meta.clientCapabilities` for every call. `elicitation` is added
   * automatically when a resolver is present, because declaring a capability
   * the host cannot honour is the same class of lie as advertising a version:
   * upstream MUST NOT send a request for an undeclared capability, so declaring
   * it is a promise to answer.
   */
  clientCapabilities?: Record<string, unknown>;
  /**
   * TEST-SEAM ONLY (`host-sample-test-seams.md` §23). Bypasses the connector
   * manifest / governance / credential gates so the suite can point the REAL
   * client at its own fake server. Refused unless `OPENWOP_TEST_SEAM_ENABLED`,
   * so the bypass cannot exist on a production boot. Everything after
   * resolution — negotiation, headers, `_meta`, MRTR, caching — is the
   * production path, which is exactly what §23's non-vacuity clause requires.
   */
  directEndpoint?: { url: string; bearer?: string };
}

/** Carries a stable `code` so a failed MCP call surfaces a typed node error. */
export class McpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** Boundary-projection detail (§B): `requested` + `supported[]` for a
     *  revision failure, so the route can emit `interop_version_unsupported`
     *  without the caller parsing a foreign protocol's error body. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

interface McpResult {
  tools?: unknown[];
  content?: unknown;
  structuredContent?: unknown;
  contents?: Array<{ mimeType?: string; text?: string; blob?: string; uri?: string }>;
  isError?: boolean;
  serverInfo?: { name?: string; version?: string };
  // `protocolVersion` is the peer's `initialize` reply (ADR 0553 P1). It was
  // absent from this type, which is WHY the field could be silently dropped:
  // the code read `result.serverInfo` and nothing ever named the version, so
  // there was no type error to notice.
  protocolVersion?: string;
  /** Current revision (§B/§C/§D). */
  resultType?: string;
  inputRequests?: Record<string, { method?: string; params?: Record<string, unknown> }>;
  requestState?: unknown;
  ttlMs?: unknown;
  cacheScope?: unknown;
  supportedVersions?: unknown;
  _meta?: Record<string, unknown>;
}

interface JsonRpcResult {
  result?: McpResult;
  error?: { code?: number; message?: string; data?: { supported?: unknown; requested?: unknown; requiredCapabilities?: unknown } };
}

let rpcSeq = 0;

type FetchResponse = Awaited<ReturnType<typeof undiciFetch>>;

/** Cap on the buffered response bytes (JSON or SSE) — a malicious/buggy server
 *  can't balloon host memory within the request timeout. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Read a response body as text, aborting once it exceeds the byte cap. Used for
 *  the `application/json` path so a giant body is rejected instead of fully
 *  buffered by `res.json()` (which has no cap). */
async function readCappedText(res: FetchResponse): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let out = '';
  try {
    for (;;) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        throw new McpError(err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'mcp_timeout' : 'mcp_request_failed', err instanceof Error ? err.message : String(err));
      }
      if (value) out += decoder.decode(value, { stream: true });
      if (out.length > MAX_RESPONSE_BYTES) throw new McpError('mcp_response_too_large', `response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out;
}

/** Parse a single `application/json` JSON-RPC response (size-capped). */
async function readJsonJsonRpc(res: FetchResponse): Promise<JsonRpcResult> {
  const text = await readCappedText(res);
  try {
    return JSON.parse(text) as JsonRpcResult;
  } catch {
    throw new McpError('mcp_bad_response', `MCP server returned non-JSON (${res.status})`);
  }
}

/** The index of the next SSE frame boundary (LF `\n\n` OR CRLF `\r\n\r\n`), or -1.
 *  The SSE spec permits either line ending, so we accept both. */
function nextFrameBoundary(buf: string): { idx: number; len: number } {
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  if (lf === -1) return crlf === -1 ? { idx: -1, len: 0 } : { idx: crlf, len: 4 };
  if (crlf === -1) return { idx: lf, len: 2 };
  return lf < crlf ? { idx: lf, len: 2 } : { idx: crlf, len: 4 };
}

/**
 * Parse a `text/event-stream` JSON-RPC response (MCP Streamable HTTP). Reads SSE
 * frames incrementally and returns the first message that is the RESPONSE to our
 * request (`id` match, or any `result`/`error`-shaped frame) — skipping
 * server-pushed notifications / comments — then cancels the stream so the
 * connection releases.
 *
 * §B removed SSE RESUMABILITY (`Last-Event-ID`) in the current revision: a
 * broken response stream loses the in-flight request and the client MUST
 * re-issue with a NEW JSON-RPC id. This client already does exactly that — it
 * has never attempted resumption, and a re-issue mints a fresh `id` from
 * `rpcSeq` while the effect identity (RFC 0150 §B) stays the invocation's, so
 * the re-issue is deduped as the same logical invocation.
 */
async function readSseJsonRpc(res: FetchResponse, expectId: number): Promise<JsonRpcResult> {
  const reader = res.body?.getReader();
  if (!reader) throw new McpError('mcp_bad_response', 'SSE response had no body');
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        // A timeout/abort during the read surfaces with the same typed code as a
        // timeout on the initial fetch.
        throw new McpError(err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'mcp_timeout' : 'mcp_request_failed', err instanceof Error ? err.message : String(err));
      }
      if (value) buf += decoder.decode(value, { stream: true });
      if (buf.length > MAX_RESPONSE_BYTES) throw new McpError('mcp_response_too_large', `SSE response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      for (;;) {
        const { idx, len } = nextFrameBoundary(buf);
        if (idx === -1) break;
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + len);
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice('data:'.length).trim())
          .join('\n');
        if (!data) continue;
        let msg: JsonRpcResult & { id?: unknown };
        try {
          msg = JSON.parse(data) as JsonRpcResult & { id?: unknown };
        } catch {
          continue; // skip a non-JSON frame (SSE comment / partial)
        }
        if (msg.id === expectId || msg.result !== undefined || msg.error !== undefined) return msg;
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new McpError('mcp_bad_response', 'SSE stream ended without a JSON-RPC response');
}

/**
 * The revision this client is currently speaking to each peer, keyed by ORIGIN.
 * Keyed by origin rather than connector id because the revision is a property of
 * the endpoint, and two connectors can point at one server.
 *
 * An entry is only ever written from an EXPLICIT negotiation outcome — a peer's
 * `-32022` naming what it supports. Nothing writes a lower revision because a
 * call happened to fail, which is how a silent downgrade would get in.
 */
const negotiated = new Map<string, McpProtocolVersion>();

/** Test seam: forget every negotiated revision. */
export function _resetMcpNegotiation(): void {
  negotiated.clear();
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * ADR 0553 P3 — a resolved peer, plus the two things the manifest declares
 * ABOUT it. Both are optional and both are FLOORS when present: an absent pin
 * means the pre-P3 behaviour, a present one can only ever refuse.
 */
interface McpTarget {
  /** The connector id this peer was resolved from — the audit `target` and the
   *  label every refusal below is attributed to. */
  readonly serverId: string;
  readonly url: string;
  readonly secret: string;
  readonly provenance?: unknown;
  /** `mcpServer.profile` resolved to its revision. A downgrade below it is refused. */
  readonly pinnedRevision?: McpProtocolVersion;
  /** `mcpServer.audience` — what the bearer for this server must be minted for. */
  readonly audience?: string;
}

/**
 * The audience a bearer token asserts, or `null` when it asserts none THIS HOST
 * CAN READ.
 *
 * The distinction matters and is why this returns `null` rather than
 * `undefined` on a parse failure: a manifest that declares an audience and a
 * token whose audience cannot be read is a REFUSAL, not a pass. Allowing an
 * unreadable token through would make the whole guard unable to fail on the
 * commonest credential shape there is — an opaque OAuth bearer — and a gate
 * that cannot fail is indistinguishable from no gate.
 *
 * Only the JWT `aud` claim is read, and only structurally: this is not a
 * verification (the peer verifies its own tokens) but a CONFUSED-DEPUTY check —
 * "is the thing I am about to spend even addressed to the party I am about to
 * spend it at". Signature validity is irrelevant to that question; a forged
 * token with the wrong `aud` is refused for the same reason a real one is.
 */
function readTokenAudience(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { aud?: unknown };
    if (typeof claims.aud === 'string' && claims.aud !== '') return claims.aud;
    // RFC 7519 allows an array; a token is addressed to a party if that party
    // is IN the array, so the check below needs the whole list. Joined with a
    // separator no audience URI can contain, and compared member-wise by the
    // caller.
    if (Array.isArray(claims.aud)) {
      const auds = claims.aud.filter((v): v is string => typeof v === 'string' && v !== '');
      return auds.length > 0 ? auds.join(' ') : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Does a token's asserted audience (possibly a space-joined list) name `want`? */
function audienceMatches(asserted: string, want: string): boolean {
  return asserted === want || asserted.split(' ').includes(want);
}

/** Report of one MRTR round trip, for the §23 seam and for node observability. */
export interface McpMrtrReport {
  inputRequiredSeen: boolean;
  retried: boolean;
  requestStateEchoed: boolean;
}

export function makeMcpClient(deps: McpClientDeps): {
  invokeTool(serverId: string, toolName: string, args: unknown, opts?: { timeoutMs?: number }): Promise<{ result: unknown; structuredContent?: unknown; isError: boolean; untrustedContent: true; negotiatedVersion: string; mrtr?: McpMrtrReport }>;
  readResource(serverId: string, uri: string, opts?: { timeoutMs?: number }): Promise<{ content: unknown; mimeType: string; untrustedContent: true }>;
  listTools(serverId: string): Promise<{ tools: unknown[] }>;
  /** `protocolVersion` is the PEER's reported MCP revision — from
   *  `server/discover` under the current profile, from the `initialize` reply on
   *  a legacy peer, absent when the peer stated none. */
  serverStatus(serverId: string, opts?: { timeoutMs?: number }): Promise<{ available: boolean; name?: string; version?: string; protocolVersion?: string }>;
  subscribeResource(
    spec: { serverId: string; uri: string },
    onEvent: (event: { uri: string; content: unknown; mimeType: string; untrustedContent: true }) => void | Promise<void>,
    opts?: { durationMs?: number; pollIntervalMs?: number; maxEvents?: number },
  ): Promise<void>;
} {
  /** What this client declares it can do, on every request (§B). */
  function clientCapabilities(): Record<string, unknown> {
    const declared = { ...(deps.clientCapabilities ?? {}) };
    if (deps.elicitationResolver && declared.elicitation === undefined) declared.elicitation = {};
    return declared;
  }

  /** The shared per-call pipeline. Throws McpError (typed) on any gate/RPC
   *  failure; stamps provenance on success unless `stamp` is false (a health
   *  probe authenticates but isn't a data "use"). */
  async function call(serverId: string, method: string, params: Record<string, unknown>, timeoutMs: number, stamp = true): Promise<McpResult | undefined> {
    // ADR 0556 P1 — one counter for the whole outbound pipeline, wrapped rather
    // than placed at each gate. Every gate below throws a typed `McpError`, so
    // the classification is complete by construction: adding a gate cannot add
    // an uncounted exit. `serverId` is a label nowhere — it is operator-curated
    // today but the connector registry is data, and a metric must not inherit
    // its cardinality from a table someone can add rows to.
    try {
      const result = await callUnmetered(serverId, method, params, timeoutMs, stamp);
      recordMcpRequest('outbound', method, 'ok');
      return result.result;
    } catch (err) {
      recordMcpRequest('outbound', method, classifyMcpClientOutcome(err));
      throw err;
    }
  }

  /** ADR 0553 P3 — one content-free audit row for an MCP decision. */
  async function audit(
    method: string,
    serverId: string,
    outcome: McpAuditOutcome,
    reason: McpAuditReason,
    startedAtMs: number,
    name?: string,
  ): Promise<void> {
    await recordMcpAudit({
      tenantId: deps.tenantId,
      direction: 'outbound',
      method,
      target: mcpAuditTarget(serverId, name),
      principal: deps.actingUserId ?? 'system',
      outcome,
      reason,
      durationMs: Date.now() - startedAtMs,
    });
  }

  /**
   * ADR 0553 P3 — the manifest-declared audience gate, applied to a RESOLVED
   * credential before it is put on the wire.
   *
   * This is the confused-deputy boundary: `resolveTarget` binds a credential
   * and a URL by the SAME `serverId`, which stops the obvious cross-wiring, but
   * it cannot see whether the credential the broker handed back was actually
   * minted for this peer. A token issued for server A and stored (or refreshed,
   * or misconfigured) under server B's connection is a live cross-spend, and
   * the only party that knows what a token was addressed to is the token.
   */
  async function assertAudience(
    serverId: string,
    method: string,
    secret: string,
    audience: string | undefined,
    startedAtMs: number,
  ): Promise<void> {
    if (audience === undefined || audience === '') return;
    const asserted = secret ? readTokenAudience(secret) : null;
    if (asserted === null) {
      await audit(method, serverId, 'audience_refused', 'audience_unreadable', startedAtMs);
      throw new McpError('mcp_token_audience_mismatch', `the credential for '${serverId}' asserts no readable audience, and this server declares one`, {
        protocol: 'mcp',
        reason: 'audience_unreadable',
      });
    }
    if (!audienceMatches(asserted, audience)) {
      await audit(method, serverId, 'audience_refused', 'audience_mismatch', startedAtMs);
      // NEITHER the token nor its asserted audience appears in the message or
      // the details. An `aud` claim names a real host and, joined to the
      // refusal, tells a reader which OTHER peer this credential is good for —
      // which is the exact fact an attacker probing a confused deputy wants.
      throw new McpError('mcp_token_audience_mismatch', `the credential for '${serverId}' was not minted for this server's declared audience`, {
        protocol: 'mcp',
        reason: 'audience_mismatch',
      });
    }
  }

  /** Resolve the peer through the three production gates, or the §23 seam. */
  async function resolveTarget(serverId: string): Promise<McpTarget> {
    if (deps.directEndpoint) {
      if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
        throw new McpError('server_not_found', 'direct MCP endpoints require the test seam');
      }
      return { serverId, url: deps.directEndpoint.url, secret: deps.directEndpoint.bearer ?? '' };
    }
    // 1. Resolve server from the host-curated manifest (no author URL).
    const manifest = getProvider(serverId);
    const url = manifest?.reach === 'mcp' ? manifest.mcpServer?.url : undefined;
    if (!url) throw new McpError('server_not_found', `no MCP server registered for '${serverId}'`);
    // ADR 0553 P3 — the declared profile/audience. An UNKNOWN profile name is a
    // hard failure, not an ignored field: silently dropping a pin the operator
    // wrote (a typo, a profile from a newer RFC revision) would leave the call
    // running under the preferred revision while the manifest says otherwise,
    // which is a silent downgrade authored in configuration rather than code.
    const declaredProfile = manifest?.mcpServer?.profile;
    const pinnedRevision = declaredProfile === undefined ? undefined : versionForMcpProfile(declaredProfile);
    if (declaredProfile !== undefined && pinnedRevision === undefined) {
      throw new McpError('server_not_found', `MCP server '${serverId}' declares an unknown profile`);
    }
    const audience = manifest?.mcpServer?.audience;
    // WHD-19 — URL-aware: the blanket flag OR this exact origin in
    // OPENWOP_WEBHOOK_ALLOW_ORIGINS (the conformance lane allowlists the suite's
    // MCP fake server and nothing else). An unparseable url is never relaxed.
    if (!url.startsWith('https://') && !plaintextMcpRelaxed(url)) {
      throw new McpError('insecure_mcp_endpoint', 'MCP endpoint must be https');
    }
    // 2. Governance (ADR 0028) — fail-closed.
    if (!(await isProviderAllowed(deps.tenantId, serverId))) {
      throw new McpError('connector_not_allowed', `connector '${serverId}' is not allow-listed`);
    }
    // 3. Credential.
    //
    // H21 — an OPERATOR-managed server (`host/mcpOperatorServer.ts`) has no
    // per-user Connection row by construction, so its bearer comes from the
    // operator's BYOK ref instead. The branch keys on the REGISTERED manifest's
    // `operatorManaged` marker, which only `operatorMcpManifest` sets; every
    // other provider takes the unchanged ADR 0024 path below. Both lanes fail
    // closed to the SAME typed error — a missing operator token can no more
    // produce an unauthenticated call than a missing Connection can.
    if (manifest?.operatorManaged === true) {
      const secret = await resolveOperatorMcpCredential(serverId);
      if (secret === null) {
        throw new McpError('mcp_not_connected', `operator MCP server '${serverId}' has no resolvable credential`);
      }
      // RFC 0079 provenance is still stamped — an operator-managed call must
      // not be an UNATTRIBUTED one. There is no connection row, so the id is
      // synthetic and marked as such; `operatorManaged` is what tells a reader
      // the credential came from operator config rather than a user's consent.
      return {
        serverId,
        url,
        secret,
        ...(pinnedRevision ? { pinnedRevision } : {}),
        ...(audience ? { audience } : {}),
        provenance: {
          connectionId: `operator:${serverId}`,
          provider: serverId,
          operatorManaged: true,
          scopeChecked: true, // the ADR 0028 governance gate above
          ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
        },
      };
    }
    // 3b. Per-user credential (ADR 0024).
    const cred = await resolveConnectionCredential({
      tenantId: deps.tenantId,
      provider: serverId,
      ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
      ...(deps.orgId ? { orgId: deps.orgId } : {}),
    });
    if (!cred) throw new McpError('mcp_not_connected', `no Connection for '${serverId}' (acting user)`);
    return {
      serverId,
      url,
      secret: cred.secret,
      ...(pinnedRevision ? { pinnedRevision } : {}),
      ...(audience ? { audience } : {}),
      provenance: cred.provenance,
    };
  }

  /**
   * ONE wire request under ONE revision. Everything §B governs about what this
   * host puts toward a peer is built here and nowhere else — which is why the
   * §23 seam drives this same function rather than hand-writing a header.
   */
  /**
   * The §B header set for ONE request. Extracted at P3 so `wireCall` and
   * `wireNotify` cannot drift: a cancellation notification that carried a
   * different `MCP-Protocol-Version` from the request it cancels would be
   * refused `-32020` by a conforming peer, and a second inline header literal
   * is exactly how that happens.
   */
  function buildHeaders(target: { secret: string }, revision: McpProtocolVersion, method: string, params: Record<string, unknown>, trace?: TraceContext | null): Record<string, string> {
    const headers: Record<string, string> = {
      // RFC 0207 §A — the HTTP carrier. Sent under EVERY revision: `_meta` does
      // not exist in 2025-06-18, so on a legacy peer this header is the only
      // carrier, and it conforms on its own.
      ...traceHeaders(trace),
      'content-type': 'application/json',
      // Advertise both response formats (MCP Streamable HTTP): the server may
      // answer with `application/json` OR a `text/event-stream` SSE stream.
      accept: 'application/json, text/event-stream',
      [MCP_PROTOCOL_VERSION_HEADER]: revision,
      [MCP_METHOD_HEADER]: method,
    };
    if (target.secret) headers.authorization = `Bearer ${target.secret}`;
    const name = params.name ?? params.uri;
    // `Mcp-Name` is REQUIRED on these three and meaningless elsewhere. Sent only
    // when the value is plain ASCII: upstream's Base64 sentinel encoding for
    // non-ASCII names is not implemented, and sending a raw non-ASCII header
    // value would be a header a conforming peer refuses.
    if ((method === 'tools/call' || method === 'prompts/get' || method === 'resources/read') && typeof name === 'string' && /^[\x20-\x7e]*$/.test(name)) {
      headers[MCP_NAME_HEADER] = name;
    }
    return headers;
  }

  /** The §B self-describing body for ONE request. */
  function buildBody(revision: McpProtocolVersion, params: Record<string, unknown>, trace?: TraceContext | null): Record<string, unknown> {
    // Under the current revision every request self-describes. A legacy peer
    // gets no `_meta` — the key does not exist in 2025-06-18 and adding it would
    // be a shape a legacy server has no obligation to tolerate.
    return revision === MCP_CURRENT_VERSION
      ? {
          ...params,
          _meta: {
            [MCP_META_PROTOCOL_VERSION]: revision,
            [MCP_META_CLIENT_CAPABILITIES]: clientCapabilities(),
            [MCP_META_CLIENT_INFO]: { name: 'openwop-host', version: '1' },
            // RFC 0207 §A / `mcp-integration.md` §D — the named OpenTelemetry
            // mapping, UNPREFIXED (`traceparent` / `tracestate`). This is the
            // SHOULD carrier: it names the MCP request rather than the
            // transport hop, and it is the only one that exists on stdio.
            ...traceFields(trace),
            // The caller's own `_meta` still wins: a node that set a key
            // explicitly is not overridden by a host stamp.
            ...((params._meta ?? {}) as Record<string, unknown>),
          },
        }
      : params;
  }

  /** A fresh child of the run's trace context for ONE outbound request — the
   *  same trace id in both carriers, a span id unique to this request. */
  function traceForRequest(): TraceContext | null {
    return deps.traceContext ? childOf(deps.traceContext) : null;
  }

  /**
   * Classify a transport failure, distinguishing a RUN CANCELLATION from a
   * timeout.
   *
   * Both surface as an aborted fetch, and before P3 both became `mcp_timeout` —
   * so a cancelled run reported that its peer was slow. `AbortSignal.timeout`
   * rejects with `TimeoutError` and a run cancel with `AbortError`, but the
   * authoritative fact is the run's own signal, so that is what is checked
   * first.
   */
  function transportError(err: unknown): McpError {
    // H81 — a REPLAY-GUARD refusal is not a transport failure, and must not be
    // dressed as one. `webhookEgressDispatcher()` calls `assertEffectAllowed`,
    // so on a replaying run the throw comes from ADR 0531's guard, not from the
    // peer — the peer was never contacted. Wrapping it produced
    // `mcp_request_failed`, which the executor's allowlist then surfaced as the
    // node-failure code, so a correct safety refusal reached the wire claiming
    // the remote server had failed.
    //
    // That also FALSIFIED an invariant stated in `executor.ts`: "the effect-
    // guard backstop's `replay_source_missing` must reach the node-failure
    // event as itself". True on every other effect path; false here, because
    // `McpError` is on the same allowlist and shadowed it.
    //
    // Exactly the defect this function's own docblock describes one layer up —
    // "before P3 both became `mcp_timeout`, so a cancelled run reported that
    // its peer was slow". Same shape, different cause: classify by what
    // actually happened, not by where it was caught.
    if (err instanceof ReplayEffectError) throw err;
    if (deps.signal?.aborted) return new McpError('mcp_cancelled', 'run cancelled while the MCP request was in flight');
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return new McpError('mcp_timeout', err instanceof Error ? err.message : String(err));
    return new McpError('mcp_request_failed', err instanceof Error ? err.message : String(err));
  }

  /**
   * ADR 0553 P3 — tell the peer an in-flight request is cancelled.
   *
   * WHY THIS EXISTS AND WHY IT IS BEST-EFFORT. §B made streams per-request and
   * removed resumability: "a broken response stream loses the in-flight request",
   * so aborting the HTTP request IS the transport-level cancellation and the
   * server "has no obligation to remember the pending request" (§C.1). The
   * notification is the courtesy on top — it lets a peer that is mid-work stop
   * spending, which the abort alone does not guarantee it notices.
   *
   * It can therefore NEVER affect the outcome. It is fired on a fresh
   * timeout-only signal (the run's signal is already aborted, so reusing it
   * would abort the cancel), hard-bounded well under the request timeout, and
   * every failure — including a peer answering `-32601` because it does not
   * implement the notification — is swallowed. A cancel that could hang on the
   * telling of it would be worse than a cancel that says nothing.
   *
   * NOT sent for the MRTR gather window: §C.1 is explicit that a run cancelled
   * between an `input_required` and its retry sends the server nothing, because
   * there is no request in flight to cancel. That path throws `mcp_cancelled`
   * without coming through here, and a test pins the difference.
   */
  const CANCEL_NOTIFY_TIMEOUT_MS = 2_000;
  async function wireNotifyCancelled(target: McpTarget, revision: McpProtocolVersion, requestId: number): Promise<void> {
    const method = 'notifications/cancelled';
    const params: Record<string, unknown> = { requestId, reason: 'run cancelled' };
    // RFC 0207 — the courtesy notification is an outbound MCP request too, so
    // it carries its own child of the run's trace.
    const trace = traceForRequest();
    try {
      await undiciFetch(target.url, {
        method: 'POST',
        headers: buildHeaders(target, revision, method, params, trace),
        body: JSON.stringify({ jsonrpc: '2.0', method, params: buildBody(revision, params, trace) }),
        dispatcher: webhookEgressDispatcher(),
        redirect: 'error',
        signal: AbortSignal.timeout(CANCEL_NOTIFY_TIMEOUT_MS),
      });
    } catch (err) {
      log.info('mcp_cancel_notify_failed', { origin: originOf(target.url), error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  async function wireCall(
    target: McpTarget,
    revision: McpProtocolVersion,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<JsonRpcResult> {
    // ADR 0553 P3 — the audience gate sits HERE, at the single choke where a
    // bearer is attached to an outbound request, rather than at the three
    // resolve sites. A gate placed next to resolution is a gate a fourth caller
    // can be added around; this one cannot be bypassed without also bypassing
    // the request.
    const startedAtMs = Date.now();
    await assertAudience(target.serverId, method, target.secret, target.audience, startedAtMs);
    const id = ++rpcSeq;
    // RFC 0207 §A — ONE child per wire request, so the `_meta` carrier and the
    // HTTP header name the same span. Computed here and passed to both
    // builders rather than minted inside each, which would send two span ids
    // for one request.
    const trace = traceForRequest();
    const headers = buildHeaders(target, revision, method, params, trace);
    const body = buildBody(revision, params, trace);
    // A per-request timeout, combined with the optional run-cancellation signal so
    // an aborted run also cancels an in-flight request (not just the poll gap).
    // ADR 0556 P3 / RFC 0154 §D — actor + workload behind this outbound call.
    // The credential below is a STORED per-user Connection secret, never the
    // inbound request's bearer; the record says which identities authorized its
    // use without touching the secret itself.
    recordAuthorityAction('mcp', 'attempt');
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = deps.signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([timeoutSignal, deps.signal]) : timeoutSignal;
    // Was the run ALREADY cancelled before this request left? If so nothing is
    // in flight and there is nothing to cancel-notify — telling a peer to
    // abandon a request it never received is a message about a request that
    // does not exist. (Measured: without this the pre-aborted case sent
    // `notifications/cancelled` for an id the peer had never seen.)
    const preAborted = deps.signal?.aborted === true;
    let res: FetchResponse;
    try {
      res = await undiciFetch(target.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: body }),
        dispatcher: webhookEgressDispatcher(),
        redirect: 'error',
        signal,
      });
    } catch (err) {
      const failure = transportError(err);
      if (failure.code === 'mcp_cancelled' && !preAborted) await wireNotifyCancelled(target, revision, id);
      throw failure;
    }
    try {
      return (res.headers.get('content-type') ?? '').includes('text/event-stream')
        ? await readSseJsonRpc(res, id)
        : await readJsonJsonRpc(res);
    } catch (err) {
      // A cancel that lands mid-BODY is the same cancel — the request is still
      // in flight from the peer's point of view, so it gets the same telling.
      // `readSse`/`readCapped` classify their own aborts, which is why the
      // re-classification here goes through the run signal rather than the
      // error they produced.
      if (deps.signal?.aborted) {
        await wireNotifyCancelled(target, revision, id);
        throw new McpError('mcp_cancelled', 'run cancelled while reading the MCP response');
      }
      throw err;
    }
  }

  /**
   * §B version selection with NO SILENT DOWNGRADE.
   *
   * The peer's `-32022` is the only thing that lowers a revision, the chosen
   * one must be in `data.supported[]` AND in this host's own
   * `protocolVersions`, and every subsequent call to that origin carries the
   * selected revision in the header and in `_meta`. An empty intersection is a
   * typed, projectable failure — never a header-less retry.
   */
  async function negotiatedCall(
    target: McpTarget,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ body: JsonRpcResult; revision: McpProtocolVersion }> {
    const startedAtMs = Date.now();
    const origin = originOf(target.url);
    // ADR 0553 P3 — a manifest pin OVERRIDES a remembered negotiation as well as
    // the preferred default. It has to: `negotiated` is process-global and keyed
    // by origin, so without this a downgrade agreed for an UNPINNED connector
    // pointing at the same host would silently become the opening revision for
    // the pinned one. Two connectors, one origin, one map — the pin is the only
    // thing that distinguishes them.
    const opening = target.pinnedRevision ?? negotiated.get(origin) ?? advertisedMcpProtocolVersion();
    let body = await wireCall(target, opening, method, params, timeoutMs);
    if (body.error?.code !== MCP_ERR_UNSUPPORTED_VERSION) return { body, revision: opening };

    const peerSupports = Array.isArray(body.error.data?.supported)
      ? (body.error.data?.supported as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    // ADR 0553 P3 — WITH A PIN THERE IS NO SELECTION STEP AT ALL.
    //
    // The P2 behaviour below is "explicit downgrade": the peer named what it
    // supports, we pick the best shared revision and report it, which satisfies
    // `mcp-version-no-silent-downgrade` because nothing is hidden. But explicit
    // is not the same as SANCTIONED. An operator who pinned `mcp-2026-07-28`
    // declared that this peer is talked to under the current profile — with
    // MRTR, stateless routing and no live callbacks — and a peer that answers
    // `-32022` naming only the legacy revision is not that peer any more,
    // whether it was swapped, downgraded, or was never the intended server.
    // Proceeding would be a downgrade the operator did not authorize, arrived at
    // one honest step at a time.
    if (target.pinnedRevision !== undefined) {
      log.info('mcp_pinned_downgrade_refused', { origin, pinned: target.pinnedRevision, peerSupports });
      await audit(method, target.serverId, 'downgrade_refused', 'pinned_profile_not_offered', startedAtMs);
      throw new McpError('interop_version_unsupported', `peer does not offer the revision '${target.serverId}' is pinned to`, {
        protocol: 'mcp',
        requested: target.pinnedRevision,
        supported: peerSupports,
      });
    }
    // Our order is the preference order; the peer's list is the constraint.
    const selected = MCP_SUPPORTED_VERSIONS.find((v) => peerSupports.includes(v));
    if (!selected || selected === opening) {
      await audit(method, target.serverId, 'version_refused', 'unsupported_revision', startedAtMs);
      throw new McpError('interop_version_unsupported', `peer does not support any revision this host serves`, {
        protocol: 'mcp',
        requested: opening,
        supported: peerSupports,
      });
    }
    log.info('mcp_version_downgraded_explicitly', { origin, from: opening, to: selected, peerSupports });
    negotiated.set(origin, selected);
    body = await wireCall(target, selected, method, params, timeoutMs);
    return { body, revision: selected };
  }

  async function callUnmetered(
    serverId: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    stamp = true,
  ): Promise<{ result?: McpResult; revision: McpProtocolVersion }> {
    const target = await resolveTarget(serverId);
    const { body, revision } = await negotiatedCall(target, method, params, timeoutMs);
    if (body.error) {
      log.warn('mcp jsonrpc error', { serverId, method, code: body.error.code });
      if (body.error.code === MCP_ERR_UNSUPPORTED_VERSION) {
        throw new McpError('interop_version_unsupported', body.error.message ?? 'unsupported MCP revision', {
          protocol: 'mcp',
          requested: revision,
          supported: Array.isArray(body.error.data?.supported) ? body.error.data?.supported : [...MCP_SUPPORTED_VERSIONS],
        });
      }
      throw new McpError('mcp_error', body.error.message ?? `MCP error ${body.error.code}`);
    }
    // 5. Provenance on a real use (not a health probe). Skipped for a RUNLESS caller
    //    (ADR 0258) — no run to stamp; the caller keeps its own audit trail.
    if (stamp && deps.runId && target.provenance !== undefined) {
      await stampConnectionUse(deps.storage, deps.runId, target.provenance as Parameters<typeof stampConnectionUse>[2]);
    }
    return { result: body.result, revision };
  }

  /**
   * §D/G4 — the caller's RIGHTS, digested into the cache key.
   *
   * H57 CORRECTION. This used to be `sha256([tenantId, orgId, actingUserId,
   * serverId])` — the same four facts the key already carries as its own
   * fields, restated. It therefore carried NO authorization material at all:
   * a `private` tools list gathered under one set of roles and one credential
   * kept being served to that identity for the whole `ttlMs` after the roles
   * changed or the Connection was revoked or re-consented. §D's TTL is a
   * freshness hint about the SERVER's data; it was never a statement about the
   * caller's rights.
   *
   * Two components, both re-derived from the store on EVERY read:
   *
   *   (a) the principal's effective scopes (`resolveSubjectScopesUnion`, the
   *       same resolver the route gates use) plus its `basis` — so losing
   *       membership entirely (`basis: 'none'`) is a different key from holding
   *       zero scopes as a member;
   *   (b) which credential the call rides and whether that credential has
   *       moved: `connectionId`, the scope axis, and — for a user/org
   *       Connection — the row's `updatedAt`, granted `scopes`, and
   *       `externalSubject`.
   *
   * Re-deriving per read is what makes this correct on a SECOND INSTANCE: a
   * member row edited elsewhere is a different key here on the next read, with
   * no signal exchanged. The eager invalidator is the same-instance half.
   *
   * `updatedAt` is the honest rotation proxy, stated because it is not exact:
   * a Connection carries no version counter, so this over-invalidates (any row
   * touch is a miss) and never under-invalidates. Over-invalidation costs one
   * wire call; the converse would serve a list gathered under a credential the
   * user has since replaced.
   *
   * OPERATOR-MANAGED servers (H21) have no Connection row by construction —
   * their bearer comes from operator BYOK config. They contribute the synthetic
   * id and the `operator` marker, and a rotation of that operator secret is NOT
   * observable here. Recorded as a known limit rather than papered over.
   */
  async function authorizationFingerprint(serverId: string): Promise<string> {
    const parts: string[] = [deps.tenantId, deps.orgId ?? '', deps.actingUserId ?? '', serverId];
    if (deps.actingUserId) {
      const { scopes, basis } = await resolveSubjectScopesUnion(deps.tenantId, deps.actingUserId);
      parts.push(`basis:${basis}`, sha256([...scopes].map(String).sort()));
    } else {
      // No acting user: a RUNLESS/system caller. It has no member row to
      // change, so there is nothing to re-derive — but say which case this is
      // rather than leaving an empty slot that a subject could collide with.
      parts.push('basis:no-subject', '');
    }
    const target = await resolveTarget(serverId);
    const prov = (target.provenance ?? {}) as {
      connectionId?: string;
      scopeAxis?: string;
      operatorManaged?: boolean;
    };
    const connectionId = prov.connectionId ?? '';
    parts.push(connectionId, prov.scopeAxis ?? '', prov.operatorManaged === true ? 'operator' : 'connection');
    if (connectionId !== '' && prov.operatorManaged !== true) {
      const row = await getConnection(deps.tenantId, connectionId);
      parts.push(row?.updatedAt ?? '', [...(row?.scopes ?? [])].sort().join(' '), row?.externalSubject ?? '');
    }
    return sha256(parts);
  }

  /** §D cache key — the WHOLE authorization context, not the endpoint. */
  async function cacheKey(serverId: string, revision: string, discoveryRevision: string): Promise<McpCacheScopeKey> {
    const manifest = getProvider(serverId);
    const url = deps.directEndpoint?.url ?? (manifest?.reach === 'mcp' ? manifest.mcpServer?.url : undefined) ?? serverId;
    return {
      tenantId: deps.tenantId,
      ...(deps.orgId ? { orgId: deps.orgId } : {}),
      ...(deps.actingUserId ? { principalId: deps.actingUserId } : {}),
      serverOrigin: originOf(url),
      revision,
      discoveryRevision,
      // G4: the caller's RIGHTS, not the server's data. Anything that changes
      // what this caller may see changes the key, so a grant or revoke misses
      // rather than serving a stale `private` list.
      scopeFingerprint: await authorizationFingerprint(serverId),
    };
  }

  /**
   * ADR 0553 P3 — the peer's ADVERTISED revision, as a digest of its
   * `server/discover` answer.
   *
   * Digested rather than stored, for two reasons. It is a cache-key component,
   * so it must be a fixed-width string a peer cannot inflate; and it must change
   * when ANY authorization-relevant part of the peer's self-description changes,
   * not only when the protocol revision does. `supportedVersions` alone would
   * miss a peer that added a capability or was redeployed as a different server
   * at the same origin, which is precisely the "stale entry served after the
   * peer's revision changed" case.
   *
   * `instructions` is deliberately IN: it is a model-facing string, so a peer
   * that changes it has changed what a run will be told, and continuing to serve
   * a tool list gathered under the old one is serving a stale authorization
   * context.
   */
  function discoveryRevisionOf(discovered: McpResult | undefined): string {
    if (!discovered) return '';
    return sha256([
      Array.isArray(discovered.supportedVersions) ? discovered.supportedVersions : [],
      (discovered as { capabilities?: unknown }).capabilities ?? null,
      (discovered as { instructions?: unknown }).instructions ?? null,
      discovered._meta?.[MCP_META_SERVER_INFO] ?? null,
    ]);
  }

  /** A call pinned to one revision — the legacy fallback probe's only user. */
  async function callAtRevision(
    serverId: string,
    revision: McpProtocolVersion,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<McpResult | undefined> {
    const target = await resolveTarget(serverId);
    // ADR 0553 P3 — this function exists for exactly ONE caller: `serverStatus`
    // falling back to the legacy `initialize` handshake when `server/discover`
    // does not answer. That fallback is a REVISION CHANGE, and under a manifest
    // pin it is the silent downgrade the pin exists to forbid — reached not
    // through a peer's `-32022` (which `negotiatedCall` now refuses) but through
    // a probe that never consults the negotiation path at all. It was the
    // second door on the same room.
    if (target.pinnedRevision !== undefined && target.pinnedRevision !== revision) {
      throw new McpError('interop_version_unsupported', `'${serverId}' is pinned to a profile that does not include ${revision}`, {
        protocol: 'mcp',
        requested: target.pinnedRevision,
        supported: [revision],
      });
    }
    const body = await wireCall(target, revision, method, params, timeoutMs);
    if (body.error) throw new McpError('mcp_error', body.error.message ?? `MCP error ${body.error.code}`);
    return body.result;
  }

  return {
    async invokeTool(serverId, toolName, args, opts) {
      const startedAtMs = Date.now();
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const baseParams: Record<string, unknown> = { name: toolName, arguments: args ?? {} };
      const mrtr: McpMrtrReport = { inputRequiredSeen: false, retried: false, requestStateEchoed: false };
      let params = baseParams;
      let rounds = 0;
      for (;;) {
        const target = await resolveTarget(serverId);
        let body: JsonRpcResult;
        let revision: McpProtocolVersion;
        try {
          ({ body, revision } = await negotiatedCall(target, 'tools/call', params, timeoutMs));
          if (body.error) {
            if (body.error.code === MCP_ERR_UNSUPPORTED_VERSION) {
              throw new McpError('interop_version_unsupported', body.error.message ?? 'unsupported MCP revision', {
                protocol: 'mcp',
                requested: revision,
                supported: Array.isArray(body.error.data?.supported) ? body.error.data?.supported : [...MCP_SUPPORTED_VERSIONS],
              });
            }
            throw new McpError('mcp_error', body.error.message ?? `MCP error ${body.error.code}`);
          }
          recordMcpRequest('outbound', 'tools/call', 'ok');
        } catch (err) {
          recordMcpRequest('outbound', 'tools/call', classifyMcpClientOutcome(err));
          throw err;
        }
        if (deps.runId && target.provenance !== undefined) {
          await stampConnectionUse(deps.storage, deps.runId, target.provenance as Parameters<typeof stampConnectionUse>[2]);
        }
        const result = body.result;
        if (result?.resultType !== 'input_required') {
          // 6. External tool output is untrusted (ADR 0027) — the pack wraps it. Also surface
          //    `structuredContent` (a tool with an outputSchema returns its typed result
          //    there, not in `content`) so callers of structured-output tools — e.g. Google
          //    Calendar `create_event` returning the new event `id` (ADR 0466) — can read it
          //    without parsing free-text content blocks. Additive; still untrusted.
          //
          //    The shape is CLOSED (§D/§E `mcp-extension-no-authority`): the peer's
          //    `_meta`, extension settings and `requestState` have no field to arrive in,
          //    so a decorated result cannot widen this run's scopes or advance an approval.
          return {
            result: result?.content ?? result ?? null,
            ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
            isError: result?.isError === true,
            untrustedContent: true,
            negotiatedVersion: revision,
            ...(mrtr.inputRequiredSeen ? { mrtr } : {}),
          };
        }
        // ── MRTR (§C.1) ──
        mrtr.inputRequiredSeen = true;
        if (revision !== MCP_CURRENT_VERSION) {
          // A legacy peer has no business answering `input_required`; honouring
          // it would be reading current-profile semantics off a legacy wire.
          throw new McpError('mcp_error', 'peer returned input_required under a revision that does not define it');
        }
        if (rounds >= MAX_MRTR_ROUNDS) {
          throw new McpError('mcp_mrtr_rounds_exceeded', `peer asked for input more than ${MAX_MRTR_ROUNDS} times for one invocation`);
        }
        if (deps.signal?.aborted) {
          // §C.1 Cancellation: a cancelled run issues NO retry and sends the
          // server nothing. The server has no obligation to remember the round.
          //
          // ADR 0553 P3 — note this path deliberately does NOT go through
          // `wireNotifyCancelled`. There is no request in flight here: the peer
          // already answered `input_required` and is waiting for a retry that
          // will never come. §C.1 says "nothing is sent to the server" for
          // exactly this window, and a `notifications/cancelled` naming a
          // request the peer has already completed would be a lie about which
          // round-trip was abandoned.
          await audit('tools/call', serverId, 'cancelled', 'run_cancelled', startedAtMs, toolName);
          throw new McpError('mcp_cancelled', 'run cancelled before the MRTR retry');
        }
        const resolver = deps.elicitationResolver;
        if (!resolver) {
          throw new McpError('mcp_input_required_unresolvable', 'peer asked for input and this run has no elicitation path');
        }
        const inputResponses: Record<string, unknown> = {};
        for (const [key, request] of Object.entries(result.inputRequests ?? {})) {
          const method = request?.method;
          if (method !== 'elicitation/create') {
            // §C: `sampling/createMessage` and `roots/list` are only sendable to
            // a client that DECLARED them, and this host declares neither. A peer
            // that sends one anyway gets a typed failure, never a live callback.
            throw new McpError('mcp_error', `peer requested an undeclared input capability: ${String(method)}`);
          }
          const p = request.params ?? {};
          inputResponses[key] = await resolver({
            key,
            mode: typeof p.mode === 'string' ? p.mode : 'form',
            message: typeof p.message === 'string' ? p.message : 'Additional input is required.',
            requestedSchema: (p.requestedSchema ?? {}) as Record<string, unknown>,
          });
        }
        // Checked AGAIN, after the gather. §C.1's cancellation rule is about
        // what reaches the SERVER, and the whole reason a gather takes time is
        // that a human is answering — which is exactly the window a cancel
        // arrives in. Checking only before the gather would leave the retry to
        // fire into an aborted signal and surface as a transport failure, which
        // is a different (and misleading) outcome.
        if (deps.signal?.aborted) {
          await audit('tools/call', serverId, 'cancelled', 'run_cancelled', startedAtMs, toolName);
          throw new McpError('mcp_cancelled', 'run cancelled while gathering MRTR input');
        }
        // The retry: a NEW JSON-RPC id (minted by `wireCall`), the SAME `name` +
        // `arguments`, `inputResponses` for every key, and `requestState` echoed
        // EXACTLY — opaque, never parsed, never modified, absent if it was absent.
        params = { ...baseParams, inputResponses, ...(result.requestState !== undefined ? { requestState: result.requestState } : {}) };
        mrtr.retried = true;
        mrtr.requestStateEchoed = result.requestState !== undefined;
        rounds += 1;
      }
    },
    async readResource(serverId, uri, opts) {
      const result = await call(serverId, 'resources/read', { uri }, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const first = result?.contents?.[0];
      return { content: first?.text ?? first?.blob ?? null, mimeType: first?.mimeType ?? '', untrustedContent: true };
    },
    async listTools(serverId) {
      // §D — cacheable, and ONLY under the full authorization-context key.
      const target = await resolveTarget(serverId);
      const revision = target.pinnedRevision ?? negotiated.get(originOf(target.url)) ?? advertisedMcpProtocolVersion();

      // ── ADR 0553 P3: validate the peer's self-description BEFORE tools reach
      // a run ────────────────────────────────────────────────────────────────
      //
      // The ADR's decision text is "the client sends version/method/name headers
      // and validates the peer's self-description before exposing tools to a
      // run", and P2 shipped only the first half. `server/discover` is that
      // self-description (§B: a current-profile server MUST implement it), and
      // it does double duty here — the answer both VALIDATES the peer and
      // supplies the cache key's advertised-revision component, so there is one
      // round trip and one fact, not a validation that agrees with a cache
      // populated from somewhere else.
      //
      // Legacy peers have no `server/discover`; under the legacy revision the
      // component is a constant, which is honest rather than a fabricated
      // digest — a legacy peer advertises no revision to key on.
      let discoveryRevision: string | undefined = 'legacy';
      if (revision === MCP_CURRENT_VERSION) {
        // THE DISCOVERY ANSWER IS NEVER CACHED, and that is the load-bearing
        // decision in this block rather than an oversight.
        //
        // The first cut cached it under the peer's own `ttlMs` (the suite's
        // fake server offers an hour), which is defensible protocol behaviour —
        // the peer is the authority on how long its self-description holds. It
        // is also the exact hole this key component exists to close: with a
        // cached description, a peer that redeployed inside that window was
        // still keyed by its OLD description, so the stale tools list was served
        // right back. The guarantee degraded from "a changed peer cannot be
        // served the old list" to "…for however long the peer said", which is a
        // TTL wearing a key's clothes — the substitution §D forbids in as many
        // words ("the TTL is a freshness hint about the server's data, not about
        // the caller's rights").
        //
        // Measured, not reasoned: `mcp-cache-confusion.test.ts` went red on
        // three legs with the cached version, returning the pre-change tool list
        // for a peer that had already changed.
        //
        // The cost is one `server/discover` per `listTools`. The `tools/list`
        // round trip is still saved, so a warm read is one request rather than
        // two, and the price of the fourth key component is paid in the one
        // place that cannot be avoided: you cannot key by a fact you refuse to
        // re-read.
        const discovered = await call(serverId, 'server/discover', {}, DEFAULT_TIMEOUT_MS, false).catch(() => undefined);
        const peerVersions = Array.isArray(discovered?.supportedVersions)
          ? discovered.supportedVersions.filter((v): v is string => typeof v === 'string')
          : [];
        // A peer that does not list the revision we are speaking has not agreed
        // to it, whatever it answered the last call under. That is the
        // difference between "the peer accepted our header" and "the peer says
        // it speaks this", and only the second is a self-description.
        //
        // WHAT HAPPENS NEXT DEPENDS ON THE PIN, and the first cut of this got it
        // wrong by refusing unconditionally. §B does say a current-profile
        // server MUST implement `server/discover`, but turning that into a hard
        // failure for EVERY connector would have broken `ctx.mcp.listTools`
        // against every real peer that has not yet shipped it — a live
        // regression on the Google/Slack manifests, justified by nothing the
        // operator asked for. (Measured: it reddened three pre-existing
        // `outbound-mcp` legs whose peers answer only `tools/list`.)
        //
        //   - PINNED: refuse. The operator declared this peer meets the profile
        //     in full, and a peer that will not say so is not that peer.
        //   - UNPINNED: do not refuse — but do NOT CACHE either. The §D
        //     guarantee this component exists for is "a stale entry cannot
        //     outlive a change in the peer's advertised surface", and without a
        //     self-description there is no way to notice such a change. Serving
        //     uncached is the honest answer; caching under a placeholder key
        //     would keep the guarantee's shape and lose its substance.
        if (!peerVersions.includes(revision)) {
          if (target.pinnedRevision !== undefined) {
            throw new McpError('interop_version_unsupported', `peer's self-description does not include the revision '${serverId}' is pinned to`, {
              protocol: 'mcp',
              requested: revision,
              supported: peerVersions,
            });
          }
          log.info('mcp_peer_self_description_absent', { serverId, revision, peerVersions });
          discoveryRevision = undefined;
        } else {
          discoveryRevision = discoveryRevisionOf(discovered);
        }
      }

      if (discoveryRevision === undefined) {
        const result = await call(serverId, 'tools/list', {}, DEFAULT_TIMEOUT_MS);
        return { tools: Array.isArray(result?.tools) ? result.tools : [] };
      }
      const key = await cacheKey(serverId, revision, discoveryRevision);
      const cached = readMcpCache(key, 'tools/list');
      if (cached !== undefined) return { tools: Array.isArray(cached) ? cached : [] };
      const result = await call(serverId, 'tools/list', {}, DEFAULT_TIMEOUT_MS);
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      writeMcpCache(key, 'tools/list', tools, { ttlMs: result?.ttlMs, cacheScope: result?.cacheScope });
      return { tools };
    },
    async serverStatus(serverId, opts) {
      // Health-check: `available:false` is the expected unhappy path, not a throw.
      const timeoutMs = opts?.timeoutMs ?? 5_000;
      try {
        // Under the current revision there is no handshake to probe with:
        // `server/discover` IS the probe, and a server MUST implement it.
        const discovered = await call(serverId, 'server/discover', {}, timeoutMs, false);
        const peerVersions = Array.isArray(discovered?.supportedVersions)
          ? discovered.supportedVersions.filter((v): v is string => typeof v === 'string')
          : [];
        // `supportedVersions[]` is REQUIRED of a conforming `server/discover`
        // (§B), so a result without one is not a discovery answer — it is a
        // legacy server that returns an empty success for a method it does not
        // know, instead of method-not-found. Treating that as a successful
        // probe silently LOSES the peer's `serverInfo`, which is what a health
        // check is for. Fall through to the legacy handshake.
        if (peerVersions.length === 0) throw new McpError('mcp_bad_response', 'server/discover carried no supportedVersions');
        const shared = peerVersions.find((v) => servesMcpVersion(v));
        if (!shared && peerVersions.length > 0) {
          log.info('mcp_peer_version_unserved', { serverId, peer: peerVersions.join(',') });
        }
        const info = discovered?._meta?.[MCP_META_SERVER_INFO] as { name?: string; version?: string } | undefined;
        return {
          available: true,
          ...(info?.name ? { name: info.name } : {}),
          ...(info?.version ? { version: info.version } : {}),
          ...(shared ? { protocolVersion: shared } : {}),
        };
      } catch (discoverErr) {
        // A legacy peer answers `server/discover` with method-not-found. Fall
        // back to the LEGACY handshake — explicitly, under the legacy revision,
        // which is a downgrade the peer's own answer justified rather than a
        // silent one.
        try {
          const result = await callAtRevision(serverId, MCP_LEGACY_VERSION, 'initialize', { protocolVersion: MCP_LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'openwop-host', version: '1' } }, timeoutMs);
          // The peer's version was previously read and discarded — only
          // `serverInfo` was kept, so a peer speaking something we cannot parse
          // still reported `available: true` with nothing recorded. Surfaced now
          // (reported, not enforced: `serverStatus` is a health check, not a gate).
          const peerVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : undefined;
          if (peerVersion && !servesMcpVersion(peerVersion)) {
            log.info('mcp_peer_version_unserved', { serverId, peer: peerVersion });
          }
          return { available: true, ...(result?.serverInfo?.name ? { name: result.serverInfo.name } : {}), ...(result?.serverInfo?.version ? { version: result.serverInfo.version } : {}), ...(peerVersion ? { protocolVersion: peerVersion } : {}) };
        } catch (err) {
          log.info('mcp serverStatus unavailable', { serverId, discover: discoverErr instanceof Error ? discoverErr.message : String(discoverErr), error: err instanceof Error ? err.message : String(err) });
          return { available: false };
        }
      }
    },
    async subscribeResource(spec, onEvent, opts) {
      // ADR 0030 Phase 2b — bounded in-band change detection. Poll `resources/read`
      // every interval for the window; the first SUCCESSFUL read sets the baseline
      // (no event), each subsequent differing read fires `onEvent` (external
      // content ⇒ untrusted, ADR 0027). No persistent connection / daemon. A GATE
      // error (misconfig) on the first poll fails fast; a transient error — on the
      // first poll or mid-window — is logged and retried until the window closes.
      // Every knob is clamped to a host ceiling (egress-amplification guard).
      const durationMs = Math.min(opts?.durationMs ?? DEFAULT_SUBSCRIBE_DURATION_MS, MAX_SUBSCRIBE_DURATION_MS);
      const pollIntervalMs = Math.max(opts?.pollIntervalMs ?? DEFAULT_SUBSCRIBE_POLL_MS, MIN_SUBSCRIBE_POLL_MS);
      const maxEvents = Math.min(opts?.maxEvents ?? DEFAULT_SUBSCRIBE_MAX_EVENTS, MAX_SUBSCRIBE_MAX_EVENTS);
      // Per-read budget is DECOUPLED from cadence: never below a sane floor, never
      // above the default request timeout, regardless of how fast we poll.
      const readTimeoutMs = Math.min(Math.max(pollIntervalMs, MIN_SUBSCRIBE_READ_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
      const deadline = Date.now() + durationMs;
      let lastHash: string | undefined;
      let emitted = 0;
      let haveBaseline = false;
      while (!deps.signal?.aborted && Date.now() < deadline && emitted < maxEvents) {
        try {
          const result = await call(spec.serverId, 'resources/read', { uri: spec.uri }, readTimeoutMs, !haveBaseline);
          const first = result?.contents?.[0];
          const content = first?.text ?? first?.blob ?? null;
          const hash = sha256(content);
          // Advance the baseline BEFORE delivery so a change is consumed exactly
          // once — a throwing consumer must not cause the same change to re-fire
          // every interval for the rest of the window.
          const changed = haveBaseline && hash !== lastHash;
          lastHash = hash;
          haveBaseline = true;
          if (changed) {
            try {
              await onEvent({ uri: spec.uri, content, mimeType: first?.mimeType ?? '', untrustedContent: true });
              emitted++;
            } catch (cbErr) {
              // A consumer-callback failure is NOT a transport failure — log it as
              // its own thing and move on (the change is already consumed).
              log.warn('mcp subscribe onEvent handler threw; dropping event', { serverId: spec.serverId, error: cbErr instanceof Error ? cbErr.message : String(cbErr) });
            }
          }
        } catch (err) {
          // Gate error on the first poll = misconfig the subscription can never
          // recover from → fail fast. Anything else (incl. a transient first-poll
          // blip) is logged and retried within the window.
          if (!haveBaseline && err instanceof McpError && GATE_ERROR_CODES.has(err.code)) throw err;
          log.warn('mcp subscribe poll failed; retrying', { serverId: spec.serverId, error: err instanceof Error ? err.message : String(err) });
        }
        if (deadline - Date.now() <= pollIntervalMs) break;
        await sleep(pollIntervalMs, deps.signal);
      }
    },
  };
}
