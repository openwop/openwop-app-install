/**
 * ADR 0865 P2 — `ctx.dataIntegration.fetchA2A`: send one task to an A2A peer that
 * is a CONNECTION with a data-source base URL (B1), and wait for its result.
 *
 * Nothing here is a second A2A client. Negotiation, the operation names, the
 * message shape and the state normalization are `host/a2aSurface.ts`'s; this
 * module hands it a transport (B2) that goes through the Connections broker
 * (`connectors.invoke`: the credential, the provider's `apiHosts` pin, the SSRF
 * guard, the tenant firewall) and refuses any URL outside the source base before
 * it is sent (B3), so the agent card, the endpoint the card names and every poll
 * are confined to the peer the tenant registered.
 *
 * Sending is reserved before dispatch (B4): the `egress:sent` ledger (channel `a2a`) is reserved
 * before the send and records the peer's TASK ID, an opaque reference, never a
 * payload. A retried node with a recorded task re-reads that task instead of
 * sending another (B5). A peer's reply is data: only artifact/message part
 * CONTENT is returned, and nothing reads its metadata (B7, ADR 0552 P2).
 */
import { createHash } from 'node:crypto';
import { getProvider } from '../features/connections/providerRegistry.js';
import { a2aGetTaskOn, a2aSendMessageOn, negotiateA2aPeer, type A2aPeerBinding, type A2aTransport } from './a2aSurface.js';
import { dataPart10, decodePart10 } from './a2aCodec10.js';
import { isWithinBase, sourceError } from './dataSourceUrl.js';
import { egressLedgerKey, priorSend, recordSend, releaseSend, reserveSend, type EgressSentRecord } from './egressSentLedger.js';
import type { NegotiationRecorder } from './negotiationDecided.js';

/** The pack's `timeoutMs` bounds (`source.a2a.config.json`). */
export const A2A_TIMEOUT = { min: 1_000, max: 600_000, default: 30_000 } as const;
/** B6 — polling backs off 1 s, 2 s, 4 s… capped here. */
const MAX_POLL_INTERVAL_MS = 10_000;
/** B7 — the same byte cap as the REST/GraphQL methods (ADR 0783 D6). */
const MAX_RESULT_BYTES = 5_000_000;
/** A message-only accept has no task to re-read; its ledger row says so. */
const MESSAGE_ONLY = 'message:';

export type A2aTaskState = 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface FetchA2AResult {
  taskState: A2aTaskState;
  result?: unknown;
  error?: { code: string; message: string };
  peerId: string;
  taskId?: string;
}

export interface A2aSource { connectionId: string; provider: string; base: string }

export interface A2aInvoke {
  invoke(connectorId: string, request: {
    url: string; method?: string; body?: string; contentType?: string; connectionId?: string;
    extraHeaders?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }>;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** B4 — the A2A `messageId`, derived from the ledger key so a peer that de-dupes
 *  by message id sees the same id on a retry. UUID-shaped, not a random UUID. */
export function a2aMessageIdFor(ledgerKey: string): string {
  const h = createHash('sha256').update(ledgerKey).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** B2/B3 — the brokered, base-confined transport. */
function brokeredTransport(connectors: A2aInvoke, src: A2aSource, deadline: AbortSignal): A2aTransport {
  return async (url, init) => {
    if (!isWithinBase(new URL(url), src.base)) {
      throw sourceError('validation_error', 'the A2A peer pointed a request outside its data source');
    }
    const signal = init.signal ? AbortSignal.any([deadline, init.signal]) : deadline;
    signal.throwIfAborted();
    const r = await untilAborted(signal, () => connectors.invoke(src.provider, {
      url, method: init.method, connectionId: src.connectionId,
      signal,
      ...(init.body !== undefined ? { body: init.body, contentType: 'application/json' } : {}),
      extraHeaders: Object.fromEntries(Object.entries(init.headers).filter(([k]) => k.toLowerCase() !== 'content-type')),
    }));
    if (r.error && !r.status) {
      // The broker's own refusal (no credential, host not allowed, timeout): the
      // A2A client sees a transport failure, and the caller maps it below.
      throw Object.assign(new Error(`the broker refused the A2A request (${r.error})`), { code: 'a2a_transport_error', brokerError: r.error });
    }
    return { ok: r.ok, status: r.status ?? 0, json: async () => r.data };
  };
}

/** Credential lookup and response parsing also count toward the caller's
 * deadline. Keep a rejection handler attached to the underlying broker call;
 * cancelling a wait is never evidence that the peer did not accept a send. */
async function untilAborted<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([run(), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** B6 — a normalized A2A state → the pack's four. */
function mapState(state: string): { taskState: A2aTaskState; error?: { code: string; message: string } } | null {
  switch (state) {
    case 'COMPLETED': return { taskState: 'completed' };
    case 'CANCELED': return { taskState: 'cancelled' };
    case 'FAILED': return { taskState: 'failed', error: { code: 'peer_failed', message: 'the peer reported the task failed' } };
    case 'REJECTED': return { taskState: 'failed', error: { code: 'peer_rejected', message: 'the peer rejected the task' } };
    // A data-source node cannot answer a peer's question; multi-turn exchanges
    // belong to the core.openwop.a2a pack.
    case 'INPUT_REQUIRED': return { taskState: 'failed', error: { code: 'peer_input_required', message: 'the peer asked for more input, which a data-source node cannot give' } };
    case 'AUTH_REQUIRED': return { taskState: 'failed', error: { code: 'peer_auth_required', message: 'the peer asked for authorization this node cannot give' } };
    default: return null; // SUBMITTED, WORKING, UNKNOWN: not terminal
  }
}

/** B7 — the CONTENT of the parts: `data` and `text` members only. A `url` part is
 *  a reference this host never fetches; a `raw` part is bytes. Metadata is never read. */
function contentOf(parts: unknown): unknown[] {
  if (!Array.isArray(parts)) return [];
  const out: unknown[] = [];
  for (const p of parts) {
    const d = decodePart10(p);
    if (d.member === 'data') out.push(d.data);
    else if (d.member === 'text') out.push(d.text);
  }
  return out;
}

/** The peer's result: the last artifact's content, else the status message's. */
function resultOf(task: Json): unknown {
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  const last = artifacts[artifacts.length - 1];
  let content = isObject(last) ? contentOf(last.parts) : [];
  if (content.length === 0) {
    const msg = isObject(task.status) ? (task.status as Json).message : undefined;
    content = isObject(msg) ? contentOf(msg.parts) : [];
  }
  if (content.length === 0) return undefined;
  return content.length === 1 ? content[0] : content;
}

const byteSize = (v: unknown): number => {
  try { return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8'); } catch { return Number.POSITIVE_INFINITY; }
};

/** Map an A2A client failure to this method's codes (B8). */
function peerFailure(err: unknown): never {
  const e = err as { code?: string; message?: string; details?: { reason?: string } };
  if (e.code === 'validation_error' || e.code === 'interop_version_unsupported') throw err;
  if (e.code === 'a2a_remote_error') {
    throw sourceError('a2a_peer_error', `the A2A peer refused the request (${e.details?.reason ?? 'upstream_error'})`);
  }
  throw sourceError('a2a_peer_unavailable', `the A2A peer could not be reached: ${e.message ?? String(err)}`);
}

export interface FetchA2ADeps {
  tenantId: string;
  connectors: A2aInvoke;
  recordNegotiation?: NegotiationRecorder;
}

export interface FetchA2AArgs { peerId?: unknown; taskType?: unknown; payload?: unknown; timeoutMs?: unknown; idempotencyKey?: unknown }

/** Argument checks that need no source (run BEFORE the peer is resolved). */
export function checkFetchA2AArgs(args: FetchA2AArgs): { taskType: string; timeoutMs: number; idempotencyKey: string } {
  if (typeof args.taskType !== 'string' || args.taskType === '') throw sourceError('validation_error', 'taskType must be a non-empty string');
  const timeoutMs = args.timeoutMs ?? A2A_TIMEOUT.default;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < A2A_TIMEOUT.min || timeoutMs > A2A_TIMEOUT.max) {
    throw sourceError('validation_error', `timeoutMs must be an integer from ${A2A_TIMEOUT.min} to ${A2A_TIMEOUT.max}`);
  }
  const k = args.idempotencyKey;
  if (typeof k !== 'string' || k === '' || k.length > 200) {
    throw sourceError('validation_error', 'sending an A2A task needs an idempotencyKey (a non-empty string of at most 200 characters)');
  }
  return { taskType: args.taskType, timeoutMs, idempotencyKey: k };
}

export async function fetchA2A(deps: FetchA2ADeps, src: A2aSource, peerId: string, args: FetchA2AArgs): Promise<FetchA2AResult> {
  const { taskType, timeoutMs, idempotencyKey } = checkFetchA2AArgs(args);
  // B8 — sending a task is a write; a read-only provider refuses it.
  if (getProvider(src.provider)?.readOnly) throw sourceError('connector_read_only', 'This data source is read-only; it does not accept A2A tasks.');
  // B3 — the agent card lives at the origin root, so a peer's base must BE an
  // origin; any other base could never reach its own card without leaving it.
  if (new URL(src.base).pathname.replace(/\/+$/, '') !== '') {
    throw sourceError('validation_error', "an A2A peer's data-source base URL must be an origin (scheme and host only), because its agent card lives at the origin root");
  }
  const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
  const started = Date.now();
  const remaining = (): number => timeoutMs - (Date.now() - started);
  const deadline = AbortSignal.timeout(timeoutMs);

  let binding: A2aPeerBinding;
  try {
    binding = await negotiateA2aPeer(src.base, { transport: brokeredTransport(deps.connectors, src, deadline), ...(deps.recordNegotiation ? { onDecided: deps.recordNegotiation } : {}) });
  } catch (err) {
    if (deadline.aborted || remaining() <= 0) return timedOut(peerId);
    peerFailure(err);
  }
  if (remaining() <= 0) return timedOut(peerId);
  // A card is untrusted. Refuse its endpoint before reserving a send, so a
  // purely local validation failure stays distinct from uncertain delivery.
  let endpoint: URL;
  try { endpoint = new URL(binding.endpoint); }
  catch { throw sourceError('validation_error', 'the A2A peer named an invalid endpoint'); }
  if (!isWithinBase(endpoint, src.base)) {
    throw sourceError('validation_error', 'the A2A peer pointed a request outside its data source');
  }

  const key = egressLedgerKey(deps.tenantId, 'a2a', idempotencyKey);
  const row: EgressSentRecord = { key, tenantId: deps.tenantId, channel: 'a2a', provider: src.provider, providerRef: '', createdAt: new Date().toISOString() };
  let taskId: string;
  if ((await reserveSend(row)) === 'duplicate') {
    // B5 — the task was sent before. Re-read it; never send a second one.
    const prior = await priorSend(key);
    if (!prior?.providerRef) {
      throw sourceError('a2a_delivery_uncertain', 'the prior A2A send has no confirmed task id; it is not sent again');
    }
    if (prior.providerRef.startsWith(MESSAGE_ONLY)) {
      throw sourceError('duplicate_result_unavailable', 'this A2A task was already sent; it is not sent again, and the peer gave no task to re-read');
    }
    taskId = prior.providerRef;
  } else {
    if (remaining() <= 0) {
      await releaseSend(key); // No send was attempted.
      return timedOut(peerId);
    }
    let reply: unknown;
    try {
      reply = await a2aSendMessageOn(binding, {
        messageId: a2aMessageIdFor(key),
        role: 'ROLE_USER',
        parts: [dataPart10({ taskType, ...(args.payload !== undefined ? { payload: args.payload } : {}) })],
      });
    } catch {
      // A lost response, deadline or peer error can follow acceptance. A stable
      // messageId is not a peer-side deduplication guarantee. Preserve the
      // reservation and refuse automatic re-send even when no task id arrived.
      throw sourceError('a2a_delivery_uncertain', 'the A2A send has no confirmed reply; it is not sent again');
    }
    if (!isObject(reply) || typeof reply.id !== 'string' || reply.id === '' || !isObject(reply.status)) {
      // A message-only reply (1.0 `SendMessageResponse.message`, or a bare 0.3
      // Message) is the whole answer: there is no task to wait for or re-read.
      const msg = isObject(reply) && isObject(reply.message) ? reply.message : reply;
      if (!isObject(msg) || typeof msg.messageId !== 'string' || msg.messageId === '' || !Array.isArray(msg.parts)) {
        throw sourceError('a2a_delivery_uncertain', 'the A2A send returned no valid task or message; it is not sent again');
      }
      await recordSend({ ...row, providerRef: `${MESSAGE_ONLY}${a2aMessageIdFor(key)}` });
      if (remaining() <= 0) return timedOut(peerId);
      const content = contentOf(msg.parts);
      return finish({ taskState: 'completed', ...(content.length ? { result: content.length === 1 ? content[0] : content } : {}), peerId });
    }
    taskId = reply.id;
    await recordSend({ ...row, providerRef: taskId });
    if (remaining() <= 0) return timedOut(peerId, taskId);
    const mapped = mapState(String((reply.status as Json).state));
    if (mapped) return finish({ ...mapped, ...(mapped.taskState === 'completed' ? withResult(reply) : {}), peerId, taskId });
  }

  // B6 — poll GetTask until a terminal state or the deadline. The deadline is
  // checked before and after every awaited call.
  for (let interval = 1_000; ; interval = Math.min(interval * 2, MAX_POLL_INTERVAL_MS)) {
    if (remaining() <= 0) return timedOut(peerId, taskId);
    await sleep(Math.min(interval, remaining()));
    if (remaining() <= 0) return timedOut(peerId, taskId);
    let task: unknown;
    try { task = await a2aGetTaskOn(binding, taskId); } catch (err) {
      if (deadline.aborted || remaining() <= 0) return timedOut(peerId, taskId);
      peerFailure(err);
    }
    if (remaining() < 0) return timedOut(peerId, taskId);
    const state = isObject(task) && isObject(task.status) ? String((task.status as Json).state) : 'UNKNOWN';
    const mapped = mapState(state);
    if (mapped) return finish({ ...mapped, ...(mapped.taskState === 'completed' && isObject(task) ? withResult(task) : {}), peerId, taskId });
  }
}

function withResult(task: Json): { result?: unknown } {
  const result = resultOf(task);
  return result === undefined ? {} : { result };
}

function finish(out: FetchA2AResult): FetchA2AResult {
  if (out.result !== undefined && byteSize(out.result) > MAX_RESULT_BYTES) {
    throw sourceError('payload_too_large', `the peer's result exceeds ${MAX_RESULT_BYTES} bytes`);
  }
  return out;
}

/** B6 — the deadline passed. The peer task is NOT cancelled; its id is returned
 *  so a later step can read it. */
function timedOut(peerId: string, taskId?: string): FetchA2AResult {
  return { taskState: 'timeout', error: { code: 'peer_timeout', message: 'the peer did not finish before timeoutMs' }, peerId, ...(taskId ? { taskId } : {}) };
}
