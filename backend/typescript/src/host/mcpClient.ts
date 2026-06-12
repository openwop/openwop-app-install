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
 *   4. JSON-RPC POST with `Authorization: Bearer`, over the RFC 0093 dispatcher
 *      (SSRF + pinned resolution), no-redirect, bounded timeout.
 *   5. Stamp `run.metadata.connectionUse[]` (RFC 0079) on success.
 *   6. Mark the result `untrustedContent` (ADR 0027 — external tool output is the
 *      `prompt-injection-mcp-marker` boundary; the pack wraps it for the LLM).
 *
 * SECURITY: token host-side only (never node config / events / run doc / log);
 * endpoint manifest-curated; three fail-closed gates.
 */

import { createHash } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { createLogger } from '../observability/logger.js';
import type { Storage } from '../storage/storage.js';
import { getProvider } from '../features/connections/providerRegistry.js';
import { resolveConnectionCredential } from '../features/connections/connectionsService.js';
import { isProviderAllowed } from './governanceService.js';
import { webhookEgressDispatcher, webhookPrivateEgressAllowed } from './webhookEgressGuard.js';
import { stampConnectionUse } from './connectionInjection.js';

const log = createLogger('connections.mcp');
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

export interface McpClientDeps {
  storage: Storage;
  tenantId: string;
  runId: string;
  actingUserId?: string;
  orgId?: string;
  /** Optional run-cancellation signal. When supplied, an aborted run cancels an
   *  in-flight request AND exits the subscribe poll loop. The executor does not
   *  yet thread a run signal (no run-cancellation signal exists there today), so
   *  this is currently dormant — wiring it is the tracked remaining gap (ADR 0030
   *  Phase 2b "known gaps"). */
  signal?: AbortSignal;
}

/** Carries a stable `code` so a failed MCP call surfaces a typed node error. */
export class McpError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'McpError';
  }
}

interface JsonRpcResult {
  result?: { tools?: unknown[]; content?: unknown; contents?: Array<{ mimeType?: string; text?: string; blob?: string; uri?: string }>; isError?: boolean; serverInfo?: { name?: string; version?: string } };
  error?: { code?: number; message?: string };
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
 * connection releases. Phase 2a: request/response only; long-lived
 * `subscribe-resource` push is Phase 2b.
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

export function makeMcpClient(deps: McpClientDeps): {
  invokeTool(serverId: string, toolName: string, args: unknown, opts?: { timeoutMs?: number }): Promise<{ result: unknown; isError: boolean; untrustedContent: true }>;
  readResource(serverId: string, uri: string, opts?: { timeoutMs?: number }): Promise<{ content: unknown; mimeType: string; untrustedContent: true }>;
  listTools(serverId: string): Promise<{ tools: unknown[] }>;
  serverStatus(serverId: string, opts?: { timeoutMs?: number }): Promise<{ available: boolean; name?: string; version?: string }>;
  subscribeResource(
    spec: { serverId: string; uri: string },
    onEvent: (event: { uri: string; content: unknown; mimeType: string; untrustedContent: true }) => void | Promise<void>,
    opts?: { durationMs?: number; pollIntervalMs?: number; maxEvents?: number },
  ): Promise<void>;
} {
  /** The shared per-call pipeline. Throws McpError (typed) on any gate/RPC
   *  failure; stamps provenance on success unless `stamp` is false (a health
   *  probe authenticates but isn't a data "use"). */
  async function call(serverId: string, method: string, params: Record<string, unknown>, timeoutMs: number, stamp = true): Promise<JsonRpcResult['result']> {
    // 1. Resolve server from the host-curated manifest (no author URL).
    const manifest = getProvider(serverId);
    const url = manifest?.reach === 'mcp' ? manifest.mcpServer?.url : undefined;
    if (!url) throw new McpError('server_not_found', `no MCP server registered for '${serverId}'`);
    if (!url.startsWith('https://') && !webhookPrivateEgressAllowed()) {
      throw new McpError('insecure_mcp_endpoint', 'MCP endpoint must be https');
    }
    // 2. Governance (ADR 0028) — fail-closed.
    if (!(await isProviderAllowed(deps.tenantId, serverId))) {
      throw new McpError('connector_not_allowed', `connector '${serverId}' is not allow-listed`);
    }
    // 3. Per-user credential (ADR 0024).
    const cred = await resolveConnectionCredential({
      tenantId: deps.tenantId,
      provider: serverId,
      ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
      ...(deps.orgId ? { orgId: deps.orgId } : {}),
    });
    if (!cred) throw new McpError('mcp_not_connected', `no Connection for '${serverId}' (acting user)`);

    // 4. JSON-RPC over the audited egress path. Advertise both response formats
    //    (MCP Streamable HTTP): the server may answer with `application/json` OR
    //    an `text/event-stream` SSE stream — we parse whichever comes back.
    const id = ++rpcSeq;
    // A per-request timeout, combined with the optional run-cancellation signal so
    // an aborted run also cancels an in-flight request (not just the poll gap).
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = deps.signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([timeoutSignal, deps.signal]) : timeoutSignal;
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${cred.secret}` },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        dispatcher: webhookEgressDispatcher(),
        redirect: 'error',
        signal,
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      throw new McpError(timedOut ? 'mcp_timeout' : 'mcp_request_failed', err instanceof Error ? err.message : String(err));
    }
    const body = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? await readSseJsonRpc(res, id)
      : await readJsonJsonRpc(res);
    if (body.error) {
      log.warn('mcp jsonrpc error', { serverId, method, code: body.error.code });
      throw new McpError('mcp_error', body.error.message ?? `MCP error ${body.error.code}`);
    }
    // 5. Provenance on a real use (not a health probe).
    if (stamp) await stampConnectionUse(deps.storage, deps.runId, cred.provenance);
    return body.result;
  }

  return {
    async invokeTool(serverId, toolName, args, opts) {
      const result = await call(serverId, 'tools/call', { name: toolName, arguments: args ?? {} }, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      // 6. External tool output is untrusted (ADR 0027) — the pack wraps it.
      return { result: result?.content ?? result ?? null, isError: result?.isError === true, untrustedContent: true };
    },
    async readResource(serverId, uri, opts) {
      const result = await call(serverId, 'resources/read', { uri }, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const first = result?.contents?.[0];
      return { content: first?.text ?? first?.blob ?? null, mimeType: first?.mimeType ?? '', untrustedContent: true };
    },
    async listTools(serverId) {
      const result = await call(serverId, 'tools/list', {}, DEFAULT_TIMEOUT_MS);
      return { tools: Array.isArray(result?.tools) ? result.tools : [] };
    },
    async serverStatus(serverId, opts) {
      // Health-check: `available:false` is the expected unhappy path, not a throw.
      try {
        const result = await call(serverId, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'openwop-host', version: '1' } }, opts?.timeoutMs ?? 5_000, false);
        return { available: true, ...(result?.serverInfo?.name ? { name: result.serverInfo.name } : {}), ...(result?.serverInfo?.version ? { version: result.serverInfo.version } : {}) };
      } catch (err) {
        log.info('mcp serverStatus unavailable', { serverId, error: err instanceof Error ? err.message : String(err) });
        return { available: false };
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
