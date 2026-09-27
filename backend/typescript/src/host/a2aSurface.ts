/**
 * `ctx.a2a` host surface — the A2A (Agent-to-Agent) client the
 * `core.openwop.a2a` pack delegates to (`spec/v1/a2a-integration.md`).
 *
 * The pack speaks no JSON-RPC directly; this surface owns transport. The
 * CLIENT methods (discoverAgent / sendMessage / sendAndStream / getTask /
 * listTasks / cancelTask / resubscribe / pushConfig.*) are a genuine A2A 0.3
 * JSON-RPC-over-HTTP client — point a node at any real A2A agent and it works.
 *
 * Wire-form note (`a2a-integration.md` §"Wire-shape spelling drift"): A2A 0.3
 * JSON-RPC uses lowercase-hyphen `TaskState` (`input-required`); the openwop
 * pack reasons over the UPPERCASE_UNDERSCORE form (`INPUT_REQUIRED`). This
 * surface normalizes inbound `status.state` to the UPPERCASE form so the pack's
 * multi-turn coordinator and reporters see the documented vocabulary.
 *
 * The SERVER-side methods (publishAgentCard / emitStatus / emitArtifact /
 * pushSend) are for a workflow exposed AS an A2A agent. The sample host is not
 * a live A2A server, so they are honest stub — they accept the call so
 * the node runs, but a production A2A host would push to the connected client's
 * stream instead. The notes on `host.a2a` advertise this.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../observability/logger.js';
import { guardedEgressFetch } from './webhookEgressGuard.js';
import type { BundleScope } from './inMemorySurfaces.js';
import { recordAuthorityAction } from './authorityContext.js';
import {
  A2A_SUPPORTED_VERSIONS,
  advertisedA2AProtocolVersion,
  servesA2AVersion,
  type A2AProtocolVersion,
} from './a2aProfile.js';
import { projectPeerError10, textPart10 } from './a2aCodec10.js';
import { childOf, traceFields, traceHeaders, type TraceContext } from './traceContext.js';

const log = createLogger('host.a2a');

const AGENT_CARD_PATHS = ['/.well-known/agent-card.json', '/.well-known/agent.json'];
/** Per-RPC timeout for outbound A2A calls. Configurable (INT-3) — a peer agent
 *  with a slower SLA can raise it via OPENWOP_A2A_RPC_TIMEOUT_MS. */
const RPC_TIMEOUT_MS = Number(process.env.OPENWOP_A2A_RPC_TIMEOUT_MS) || 20_000;
const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'REJECTED']);

type Json = Record<string, unknown>;

/** The wire spelling of the version header (`a2aProfile.ts` holds the lowercase
 *  form Node hands inbound requests; outbound we write it as upstream does). */
const A2A_VERSION_HEADER_WIRE = 'A2A-Version';

// ── ADR 0552 P2 — outbound version negotiation (a2a-integration.md §B) ────────

/**
 * What this host settled on with one peer: the version it will actually put on
 * the wire, and where.
 *
 * `version` is the load-bearing field. §B: "a host that proceeds after a
 * downgrade MUST report the version it actually negotiated. Reporting the
 * preferred version while having used a lower one is the silent downgrade §B
 * forbids — and it is worse than a failure because it succeeds."
 */
export interface A2aPeerBinding {
  version: A2AProtocolVersion;
  endpoint: string;
  /** Every version the peer's card offered, for the refusal's `supported[]`. */
  peerVersions: readonly string[];
}

/**
 * A negotiation that could not complete honestly — no shared version, or a
 * downgrade this host's policy refuses. Carries the closed facts §B's canonical
 * projection needs (`interop_version_unsupported`) and nothing from the peer's
 * body.
 */
export class A2aVersionRefusedError extends Error {
  readonly code = 'interop_version_unsupported';
  constructor(
    readonly requested: string,
    readonly supported: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = 'A2aVersionRefusedError';
  }
}

/** An observer for every outbound A2A HTTP call — the §22 `invoke` seam reads
 *  it to report what the host ACTUALLY did, rather than what it meant to. */
export interface A2aCallRecord {
  method: 'GET' | 'POST';
  url: string;
  version: string;
  rpcMethod?: string;
  params?: unknown;
}
export type A2aCallRecorder = (call: A2aCallRecord) => void;

/** Options that only the §22 negotiation seam sets; production callers pass none. */
export interface A2aNegotiationOptions {
  /** §B's fail-closed default applies to an authenticated request. */
  authenticated?: boolean;
  /** Ask the peer for this version instead of `preferredVersion`. */
  requestVersion?: string;
  /** Treat the peer as offering only this version (the suite's `peerOffersOnly`). */
  peerOffersOnly?: string;
  onCall?: A2aCallRecorder;
}

/** `0.3.0` / `1.0.0` → `0.3` / `1.0`. Cards in the wild carry either form. */
function majorMinor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d+)\.(\d+)/.exec(value.trim());
  return m ? `${m[1]}.${m[2]}` : null;
}

/**
 * Read the versions and JSON-RPC endpoint out of either card shape.
 *
 * 1.0 (`supportedInterfaces[]`) is checked first because a 1.0 card has no
 * top-level `url`/`protocolVersion` to fall back to, and a host that checked
 * 0.3 first would read a 1.0 card as "no version stated". The endpoint falls
 * back to `baseUrl` when the card names none — the 0.3 shape makes `url`
 * optional in practice and this client has always POSTed to the base.
 */
function readPeerCard(card: unknown, baseUrl: string): { versions: string[]; endpointFor: (v: string) => string } {
  const c = (card ?? {}) as {
    supportedInterfaces?: Array<{ url?: unknown; protocolBinding?: unknown; protocolVersion?: unknown }>;
    url?: unknown;
    protocolVersion?: unknown;
  };
  if (Array.isArray(c.supportedInterfaces) && c.supportedInterfaces.length > 0) {
    const jsonrpc = c.supportedInterfaces.filter((i) => i.protocolBinding === 'JSONRPC' || i.protocolBinding === undefined);
    const byVersion = new Map<string, string>();
    for (const i of jsonrpc) {
      const v = majorMinor(i.protocolVersion);
      if (v && typeof i.url === 'string' && !byVersion.has(v)) byVersion.set(v, i.url);
    }
    return { versions: [...byVersion.keys()], endpointFor: (v) => byVersion.get(v) ?? baseUrl };
  }
  const legacy = majorMinor(c.protocolVersion) ?? '0.3';
  const url = typeof c.url === 'string' ? c.url : baseUrl;
  return { versions: [legacy], endpointFor: () => url };
}

/** Fetch a peer's Agent Card, asking for the era this host prefers (§B sender
 *  rule applies to the card GET too — a dual-era peer shapes the card by it). */
async function fetchPeerCard(baseUrl: string, askVersion: string, onCall?: A2aCallRecorder): Promise<unknown> {
  let lastErr: unknown = null;
  for (const path of AGENT_CARD_PATHS) {
    const url = new URL(path, baseUrl).toString();
    try {
      onCall?.({ method: 'GET', url, version: askVersion });
      const res = await guardedEgressFetch(url, {
        headers: { accept: 'application/json', [A2A_VERSION_HEADER_WIRE]: askVersion },
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw Object.assign(
    new Error(`A2A agent-card discovery failed for ${baseUrl}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`),
    { code: 'a2a_transport_error' },
  );
}

/**
 * §B — pick the version this host will speak to `baseUrl`, or refuse.
 *
 * The rules, in the order they bite:
 *   1. A `requestVersion` this host does not serve is refused before any egress
 *      — asking a peer for a version we could not decode is not a negotiation.
 *   2. The requested version, when the peer offers it. No downgrade, nothing
 *      to report.
 *   3. Otherwise the highest version BOTH sides speak. This is an EXPLICIT
 *      downgrade: the binding's `version` is what every subsequent header
 *      carries and what the seam reports, so caller and wire cannot disagree.
 *   4. …except for an authenticated request, where §B's default is fail-closed.
 *      A downgrade the caller did not ask for is a security-relevant change to
 *      a credentialed exchange, so it refuses rather than proceeds quietly.
 *   5. No shared version at all ⇒ refuse.
 */
export async function negotiateA2aPeer(baseUrl: string, opts: A2aNegotiationOptions = {}): Promise<A2aPeerBinding> {
  const requested = opts.requestVersion ?? advertisedA2AProtocolVersion();
  if (!servesA2AVersion(requested)) {
    throw new A2aVersionRefusedError(
      requested,
      [...A2A_SUPPORTED_VERSIONS],
      `this host does not speak A2A ${requested}`,
    );
  }
  const card = await fetchPeerCard(baseUrl, requested, opts.onCall);
  const read = readPeerCard(card, baseUrl);
  const offered = opts.peerOffersOnly ? read.versions.filter((v) => v === opts.peerOffersOnly) : read.versions;
  if (offered.includes(requested)) {
    return { version: requested, endpoint: read.endpointFor(requested), peerVersions: offered };
  }
  // Highest mutually-spoken version, in this host's own preference order.
  const shared = A2A_SUPPORTED_VERSIONS.find((v) => offered.includes(v));
  if (!shared) {
    throw new A2aVersionRefusedError(requested, offered, `peer offers no A2A version this host speaks`);
  }
  if (opts.authenticated === true) {
    // §B: "For an authenticated request the default is fail-closed … a
    // policy-forbidden downgrade MUST fail closed and MUST be audited
    // content-free." RFC 0049's authorization decision is the carrier the spec
    // recommends; this host has no A2A negotiation event, so the audit is the
    // content-free log line below (§B G7 remains an open spec gap).
    log.warn('a2a_version_downgrade_refused', { requested, negotiated: shared, authenticated: true });
    throw new A2aVersionRefusedError(
      requested,
      offered,
      `refusing to downgrade an authenticated A2A exchange from ${requested} to ${shared}`,
    );
  }
  log.info('a2a_version_downgraded', { requested, negotiated: shared });
  return { version: shared, endpoint: read.endpointFor(shared), peerVersions: offered };
}

/** §D.1 — the operation names, per version. One table, both directions. */
const OPERATION_NAMES = {
  sendMessage: { '1.0': 'SendMessage', '0.3': 'message/send' },
  sendStreamingMessage: { '1.0': 'SendStreamingMessage', '0.3': 'message/stream' },
  getTask: { '1.0': 'GetTask', '0.3': 'tasks/get' },
  listTasks: { '1.0': 'ListTasks', '0.3': 'tasks/list' },
  cancelTask: { '1.0': 'CancelTask', '0.3': 'tasks/cancel' },
  subscribeToTask: { '1.0': 'SubscribeToTask', '0.3': 'tasks/resubscribe' },
  createPushConfig: { '1.0': 'CreateTaskPushNotificationConfig', '0.3': 'tasks/pushNotificationConfig/set' },
  getPushConfig: { '1.0': 'GetTaskPushNotificationConfig', '0.3': 'tasks/pushNotificationConfig/get' },
  listPushConfig: { '1.0': 'ListTaskPushNotificationConfig', '0.3': 'tasks/pushNotificationConfig/list' },
  deletePushConfig: { '1.0': 'DeleteTaskPushNotificationConfig', '0.3': 'tasks/pushNotificationConfig/delete' },
  extendedCard: { '1.0': 'GetExtendedAgentCard', '0.3': 'agent/getAuthenticatedExtendedCard' },
} as const;

type A2aOperation = keyof typeof OPERATION_NAMES;

function methodName(op: A2aOperation, version: A2AProtocolVersion): string {
  return OPERATION_NAMES[op][version];
}

/**
 * Compose an outbound `Message` in the negotiated version's shape.
 *
 * 1.0 moved `taskId` / `contextId` ONTO the message and made `messageId` +
 * `role` required, so a 0.3-shaped params object sent under a 1.0 header is
 * accepted by nothing. The caller passes the same three facts either way.
 */
function messageParams(
  version: A2AProtocolVersion,
  message: unknown,
  taskId?: string | null,
  contextId?: string | null,
  trace?: TraceContext | null,
): Json {
  const src = (message ?? {}) as Json;
  const metadata = withTraceMetadata(src.metadata, trace);
  if (version === '0.3') {
    return {
      message: metadata === undefined ? message : { ...src, metadata },
      ...(taskId ? { taskId } : {}),
      ...(contextId ? { contextId } : {}),
    };
  }
  const parts = Array.isArray(src.parts) ? src.parts : [textPart10(typeof src.text === 'string' ? src.text : '')];
  return {
    message: {
      messageId: typeof src.messageId === 'string' ? src.messageId : randomUUID(),
      role: src.role === 'ROLE_AGENT' || src.role === 'agent' ? 'ROLE_AGENT' : 'ROLE_USER',
      parts,
      ...(taskId ? { taskId } : {}),
      ...(contextId ? { contextId } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    },
  };
}

/**
 * RFC 0207 §B / `a2a-integration.md` §"Declared mappings" — merge the trace
 * carrier into `Message.metadata.openwop`. `metadata.openwop.traceparent` and
 * `.tracestate` are the two normatively-shaped keys in that host-extension
 * namespace; everything else the caller put there is preserved untouched.
 *
 * Returns `undefined` when there is nothing to carry AND the caller supplied no
 * metadata, so a message that had no `metadata` key does not grow an empty one.
 */
function withTraceMetadata(existing: unknown, trace?: TraceContext | null): Json | undefined {
  const fields = traceFields(trace);
  if (Object.keys(fields).length === 0) return existing as Json | undefined;
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as Json) } : {};
  const openwop = base.openwop && typeof base.openwop === 'object' && !Array.isArray(base.openwop) ? { ...(base.openwop as Json) } : {};
  // The caller's own value wins — a node that set the carrier explicitly is
  // continuing a trace it knows about, and the run-level stamp must not
  // silently re-parent it.
  return { ...base, openwop: { ...fields, ...openwop } };
}

/** Normalize a wire `status.state` (`input-required`) to the pack's documented
 *  UPPERCASE_UNDERSCORE form (`INPUT_REQUIRED`). Handles a bare Task, a
 *  `tasks/list` envelope (`{ tasks: Task[] }`), and leaves non-Task results
 *  (e.g. a Message) untouched. */
function normalizeResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const r = result as Json;
  // A2A 1.0 `SendMessageResponse` is a `oneof { task | message }` — unwrap the
  // task so the pack sees the same envelope it saw at 0.3. ADR 0552 P2: the
  // pack's vocabulary is a HOST-side contract, and a version change on the wire
  // must not become a breaking change for every node that reads `status.state`.
  if (r.task && typeof r.task === 'object' && !Array.isArray(r.task)) {
    return normalizeResult(r.task);
  }
  // `tasks/list` / `ListTasks` envelope — normalize each task in the array.
  if (Array.isArray(r.tasks)) {
    return { ...r, tasks: r.tasks.map(normalizeResult) };
  }
  const status = r.status;
  if (status && typeof status === 'object' && typeof (status as Json).state === 'string') {
    // 0.3 `input-required` → INPUT_REQUIRED; 1.0 `TASK_STATE_INPUT_REQUIRED` →
    // the same, by stripping the enum prefix 1.0 added.
    const raw = (status as Json).state as string;
    const state = raw.toUpperCase().replace(/-/g, '_').replace(/^TASK_STATE_/, '');
    return { ...r, status: { ...(status as Json), state } };
  }
  return result;
}

function isTerminal(task: unknown): boolean {
  const s = (task as Json | null)?.status as Json | undefined;
  return typeof s?.state === 'string' && TERMINAL_STATES.has(s.state as string);
}

/**
 * Single A2A JSON-RPC call against a negotiated binding.
 *
 * Every non-GET call carries `A2A-Version: <negotiated>` — §B's sender rule,
 * and the exact fact `a2a-version-negotiation.test.ts` reads off the peer.
 *
 * A remote error is re-thrown with the §D.7 PROJECTION attached, not the peer's
 * body: `details` carries the closed `reason` (+ `supportedVersions[]` for a
 * version failure) and nothing else. §D.7 / RFC 0152 UQ4 — upstream details are
 * dropped, not redacted in place, so there is no filter to keep in sync with a
 * peer's error format.
 */
async function rpc(binding: A2aPeerBinding, method: string, params: Json, onCall?: A2aCallRecorder, trace?: TraceContext | null): Promise<unknown> {
  // ADR 0556 P3 / RFC 0154 §D — record WHO this host is calling out as, before
  // the call leaves. Outbound A2A carries no credential at all today (it is
  // SSRF-guarded and anonymous), so this is the only place the pair of
  // identities behind a cross-host call is written down. ADR 0552 P2 moved it
  // inside the negotiated-binding signature; it still fires before egress, and
  // it stays on the RPC path rather than the card GET so one logical call
  // records one action.
  recordAuthorityAction('a2a', 'attempt');
  let res: Awaited<ReturnType<typeof guardedEgressFetch>>;
  onCall?.({ method: 'POST', url: binding.endpoint, version: binding.version, rpcMethod: method, params });
  try {
    // (2026-07 vuln-scan M1) caller-supplied baseUrl → SSRF-guarded egress.
    res = await guardedEgressFetch(binding.endpoint, {
      method: 'POST',
      headers: {
        // RFC 0207 §B — the HTTP carrier, beside the `Message.metadata.openwop`
        // one. Either alone conforms; this host sends both.
        ...traceHeaders(trace),
        'content-type': 'application/json',
        accept: 'application/json',
        [A2A_VERSION_HEADER_WIRE]: binding.version,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (err) {
    throw Object.assign(new Error(`A2A ${method} transport error: ${err instanceof Error ? err.message : String(err)}`), { code: 'a2a_transport_error' });
  }
  const body = (await res.json().catch(() => ({}))) as {
    result?: unknown;
    error?: { code?: number; message?: string; data?: unknown };
  };
  if (body.error) {
    const projected = projectPeerError10(body.error);
    if (projected.code === 'interop_version_unsupported') {
      throw new A2aVersionRefusedError(
        binding.version,
        projected.supportedVersions ?? binding.peerVersions,
        `peer refused A2A version ${binding.version}`,
      );
    }
    throw Object.assign(new Error(`A2A ${method} failed (${projected.reason ?? 'upstream_error'})`), {
      code: 'a2a_remote_error',
      details: projected,
    });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`A2A ${method} returned HTTP ${res.status}`), { code: 'a2a_transport_error' });
  }
  return normalizeResult(body.result);
}

/** A2A streaming call (`message/stream` / `tasks/resubscribe`): POST JSON-RPC,
 *  read the SSE response, normalize + forward each event, return the terminal
 *  task (or the last event seen). */
async function rpcStream(
  binding: A2aPeerBinding,
  method: string,
  params: Json,
  onEvent: (event: unknown) => Promise<void> | void,
  trace?: TraceContext | null,
): Promise<unknown> {
  const res = await guardedEgressFetch(binding.endpoint, {
    method: 'POST',
    headers: {
      // RFC 0207 §B — same carrier as the blocking path; a streaming send is
      // still an outbound A2A message.
      ...traceHeaders(trace),
      'content-type': 'application/json',
      accept: 'text/event-stream',
      [A2A_VERSION_HEADER_WIRE]: binding.version,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    throw Object.assign(new Error(`A2A ${method} stream returned HTTP ${res.status}`), { code: 'a2a_transport_error' });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let terminal: unknown = null;
  let last: unknown = null;

  const handleData = async (data: string): Promise<void> => {
    let parsed: { result?: unknown; error?: { message?: string } };
    try {
      parsed = JSON.parse(data) as typeof parsed;
    } catch {
      return; // ignore non-JSON keepalive frames
    }
    if (parsed.error) throw Object.assign(new Error(`A2A ${method} stream error: ${parsed.error.message ?? 'unknown'}`), { code: 'a2a_remote_error' });
    const event = normalizeResult(parsed.result);
    last = event;
    await onEvent(event);
    if (isTerminal(event)) terminal = event;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    // SSE frames are separated by a blank line; each frame's `data:` lines join.
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (data) await handleData(data);
    }
  }
  return terminal ?? last;
}


/**
 * Every client method accepts the SAME optional `negotiation` block.
 *
 * The node pack never sets it — production negotiates on the defaults. The
 * §22 `invoke` seam does, which is what makes it a witness rather than a mock:
 * `host-sample-test-seams.md` §22 requires the seam to "drive the same A2A
 * client the production `a2a.invoke` path uses (same negotiation code, same
 * header construction); a seam that hand-writes `A2A-Version` proves nothing
 * about production." Passing options into the one client is how that stays
 * true; a parallel client for the seam would not.
 */
interface Negotiated {
  negotiation?: A2aNegotiationOptions;
}

export interface A2aSurface {
  discoverAgent(baseUrl: string, opts?: { extended?: boolean } & Negotiated): Promise<unknown>;
  sendMessage(args: { baseUrl: string; message: unknown; taskId?: string | null; contextId?: string | null } & Negotiated): Promise<unknown>;
  sendAndStream(
    args: { baseUrl: string; message: unknown; taskId?: string | null; contextId?: string | null } & Negotiated,
    onEvent: (event: unknown) => Promise<void> | void,
  ): Promise<unknown>;
  getTask(args: { baseUrl: string; taskId: string } & Negotiated): Promise<unknown>;
  listTasks(args: { baseUrl: string; filter?: unknown; cursor?: string | null; limit?: number | null } & Negotiated): Promise<unknown>;
  cancelTask(args: { baseUrl: string; taskId: string } & Negotiated): Promise<unknown>;
  resubscribe(args: { baseUrl: string; taskId: string } & Negotiated, onEvent: (event: unknown) => Promise<void> | void): Promise<unknown>;
  pushConfig: {
    create(args: PushConfigArgs): Promise<unknown>;
    get(args: PushConfigArgs): Promise<unknown>;
    list(args: PushConfigArgs): Promise<unknown>;
    delete(args: PushConfigArgs): Promise<unknown>;
  };
  // Server-side (workflow IS an A2A agent) — honest stub on the reference app.
  publishAgentCard(args: { card: unknown; signed?: boolean }): Promise<void>;
  emitStatus(event: unknown): Promise<void>;
  emitArtifact(event: unknown): Promise<void>;
  pushSend(args: { configId: string; event: unknown }): Promise<unknown>;
}

interface PushConfigArgs extends Negotiated {
  baseUrl: string;
  taskId: string;
  configId?: string | null;
  pushNotificationConfig?: unknown;
}

// Per-tenant store for the server-side stubs (published agent card). Keyed by
// tenant so a multi-tenant demo doesn't cross streams.
const _publishedCards = new Map<string, unknown>();

/** A7 — read a tenant's published agent card (set via `publishAgentCard`). The
 *  live A2A server route (`POST /v1/host/openwop-app/a2a`, RFC 0076) serves it on
 *  `agent/getCard`, falling back to a registry-synthesized card when a tenant
 *  hasn't published one. Returns undefined when none is published for the scope. */
export function getPublishedAgentCard(tenantId: string, scopeId = ''): unknown | undefined {
  return _publishedCards.get(`${tenantId}::${scopeId}`);
}

export function createA2aSurface(scope: BundleScope): A2aSurface {
  const tenantKey = `${scope.tenantId}::${scope.scopeId ?? ''}`;
  /** RFC 0207 §B — a fresh child of the run's trace context for ONE outbound
   *  message, so the metadata carrier and the HTTP header name the same span
   *  and two concurrent sends stay distinguishable. */
  const traceForCall = (): TraceContext | null => (scope.traceContext ? childOf(scope.traceContext) : null);

  return {
    async discoverAgent(baseUrl, opts) {
      // ADR 0552 P2 — the card GET carries `A2A-Version` too. A dual-era peer
      // shapes its card by that header (the suite's `A2AFakePeer` does exactly
      // this), so a header-less GET against a 1.0 peer returns the 0.3 card and
      // the negotiation that follows reads the wrong document.
      const binding = await negotiateA2aPeer(baseUrl, opts?.negotiation ?? {});
      let card = await fetchPeerCard(baseUrl, binding.version, opts?.negotiation?.onCall);
      // The authenticated extended card is an optional JSON-RPC follow-up.
      if (opts?.extended === true) {
        try {
          const extended = await rpc(binding, methodName('extendedCard', binding.version), {}, opts?.negotiation?.onCall);
          if (extended && typeof extended === 'object') card = extended;
        } catch (err) {
          log.warn('extended agent card fetch failed; returning base card', { baseUrl, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return card;
    },

    async sendMessage({ baseUrl, message, taskId, contextId, negotiation }) {
      const b = await negotiateA2aPeer(baseUrl, negotiation ?? {});
      const trace = traceForCall();
      return rpc(b, methodName('sendMessage', b.version), messageParams(b.version, message, taskId, contextId, trace), negotiation?.onCall, trace);
    },

    async sendAndStream({ baseUrl, message, taskId, contextId, negotiation }, onEvent) {
      const b = await negotiateA2aPeer(baseUrl, negotiation ?? {});
      const trace = traceForCall();
      return rpcStream(b, methodName('sendStreamingMessage', b.version), messageParams(b.version, message, taskId, contextId, trace), onEvent, trace);
    },

    async getTask({ baseUrl, taskId, negotiation }) {
      const b = await negotiateA2aPeer(baseUrl, negotiation ?? {});
      return rpc(b, methodName('getTask', b.version), { id: taskId }, negotiation?.onCall);
    },

    async listTasks({ baseUrl, filter, cursor, limit, negotiation }) {
      const b = await negotiateA2aPeer(baseUrl, negotiation ?? {});
      return rpc(b, methodName('listTasks', b.version), {
        ...(filter ? { filter } : {}),
        // 1.0 renamed the pagination pair; a `cursor`/`limit` sent to a 1.0 peer
        // is silently ignored, which reads as "the peer has no more pages".
        ...(cursor ? (b.version === '1.0' ? { pageToken: cursor } : { cursor }) : {}),
        ...(limit ? (b.version === '1.0' ? { pageSize: limit } : { limit }) : {}),
      }, negotiation?.onCall);
    },

    async cancelTask({ baseUrl, taskId, negotiation }) {
      const b = await negotiateA2aPeer(baseUrl, negotiation ?? {});
      return rpc(b, methodName('cancelTask', b.version), { id: taskId }, negotiation?.onCall);
    },

    async resubscribe({ baseUrl, taskId, negotiation }, onEvent) {
      const b = await negotiateA2aPeer(baseUrl, negotiation ?? {});
      return rpcStream(b, methodName('subscribeToTask', b.version), { id: taskId }, onEvent);
    },

    pushConfig: {
      async create({ baseUrl, taskId, pushNotificationConfig, negotiation }) {
        const b = await negotiateA2aPeer(baseUrl, negotiation ?? {});
        return rpc(b, methodName('createPushConfig', b.version), { taskId, pushNotificationConfig }, negotiation?.onCall);
      },
      async get({ baseUrl, taskId, configId, negotiation }) {
        const b = await negotiateA2aPeer(baseUrl, negotiation ?? {});
        return rpc(b, methodName('getPushConfig', b.version), { taskId, ...(configId ? { pushNotificationConfigId: configId } : {}) }, negotiation?.onCall);
      },
      async list({ baseUrl, taskId, negotiation }) {
        const b = await negotiateA2aPeer(baseUrl, negotiation ?? {});
        return rpc(b, methodName('listPushConfig', b.version), { taskId }, negotiation?.onCall);
      },
      async delete({ baseUrl, taskId, configId, negotiation }) {
        const b = await negotiateA2aPeer(baseUrl, negotiation ?? {});
        return rpc(b, methodName('deletePushConfig', b.version), { taskId, ...(configId ? { pushNotificationConfigId: configId } : {}) }, negotiation?.onCall);
      },
    },

    // ── Server-side demo stubs ───────────────────────────────────────
    async publishAgentCard({ card }) {
      _publishedCards.set(tenantKey, card);
      log.info('agent card published (demo: stored in-process, not served at a live A2A endpoint)', { tenant: scope.tenantId });
    },
    async emitStatus() {
      // A production A2A server pushes this onto the connected client's stream;
      // the reference app has no inbound A2A connection, so this is a no-op.
    },
    async emitArtifact() {
      // See emitStatus — no live A2A client stream on the reference app.
    },
    async pushSend({ configId }) {
      return { ok: true, configId, delivered: false, note: 'demo: sample host has no live push-notification channel' };
    },
  };
}
