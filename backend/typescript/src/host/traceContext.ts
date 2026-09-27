/**
 * W3C Trace Context carried across the MCP and A2A boundaries (RFC 0207).
 *
 * `spec/v1/multi-agent-execution.md` §"W3C tracecontext across MCP + A2A
 * composition" — a host that dispatches MCP tool calls AND advertises
 * `multiAgent.executionModel.version >= 3` MUST inject the parent run's W3C
 * trace context into every outbound MCP request, in `params._meta`
 * (`traceparent`, and `tracestate` when present) or, on Streamable HTTP, in the
 * HTTP `traceparent` header, and SHOULD use `params._meta`. The same rule
 * applies symmetrically to A2A: `Message.metadata.openwop.traceparent` or the
 * HTTP header, SHOULD the metadata. This host sends BOTH carriers, which is the
 * SHOULD satisfied rather than merely the MUST.
 *
 * CORRELATION ONLY. Neither carrier is authority: nothing here is ever read as
 * tenant, principal or scope (RFC 0207 §A/§B; `observability.md` §"Trace
 * context across interop boundaries"). That is why the value is a reserved
 * run-metadata key rather than anything a caller can influence past the one
 * header the middleware reads.
 *
 * WHY THE RUN ROW AND NOT `context.active()`. The OTel active context the
 * `traceContextMiddleware` extracts lives for the duration of the HTTP handler.
 * A run is dispatched on `setImmediate` (`host/runDispatch.ts`) and, on the
 * durable path, redelivered from the `dispatch_outbox` by a timer daemon
 * (`host/runDispatchSweeper.ts`) with no request context at all — so an
 * outbound MCP call made mid-run cannot read the caller's trace off the ambient
 * context. The context the run was CREATED under is persisted on the run
 * (`metadata.traceContext`, a reserved key) and read back here, which is the
 * only carrier that survives both paths.
 *
 * A malformed value is ignored — a new trace starts — and never fails a
 * request (W3C Trace Context §3.2 "restart the trace").
 *
 * @see RFCS/0207-trace-context-across-mcp-and-a2a.md §A, §B
 * @see spec/v1/multi-agent-execution.md §"W3C tracecontext across MCP + A2A composition"
 * @see spec/v1/mcp-integration.md §D ("Extensions are opaque" — the named OTel mapping)
 * @see spec/v1/a2a-integration.md §"Declared mappings" (`Message.metadata.openwop.traceparent`)
 */

import { randomBytes } from 'node:crypto';

export interface TraceContext {
  readonly traceparent: string;
  readonly tracestate?: string;
}

/** version-format = 2HEXDIG "-" 32HEXDIG "-" 16HEXDIG "-" 2HEXDIG (W3C §3.2.2). */
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** The parsed parts of a well-formed `traceparent`, or null. */
export function parseTraceparent(value: unknown): { traceId: string; parentId: string; flags: string } | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  // A future version MAY append `-<field>`; version `ff` is forbidden, and a
  // version-00 value MUST be exactly 55 chars (W3C §3.2.2.3).
  const m = TRACEPARENT.exec(v.slice(0, 55));
  if (m === null) return null;
  const [, version, traceId, parentId, flags] = m as unknown as [string, string, string, string, string];
  if (version === 'ff') return null;
  if (v.length > 55 && (version === '00' || v[55] !== '-')) return null;
  // An all-zero trace id or parent id is invalid.
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return { traceId, parentId, flags };
}

/** A `TraceContext` from a candidate pair, or null when the `traceparent` is malformed. */
function ofValue(traceparent: unknown, tracestate: unknown): TraceContext | null {
  if (parseTraceparent(traceparent) === null) return null;
  const tp = (traceparent as string).trim();
  // `tracestate` is best-effort: carried when it is a plausible header value,
  // dropped otherwise. A bad `tracestate` never invalidates a good
  // `traceparent` (W3C §3.3.2 "restart the trace state").
  return typeof tracestate === 'string' && tracestate.length > 0 && tracestate.length <= 512
    ? { traceparent: tp, tracestate }
    : { traceparent: tp };
}

/**
 * The inbound context for a request: the in-message carrier when it is valid,
 * else the HTTP header, else none. RFC 0207 §A/§B — a receiver prefers the
 * in-message value, because it names the request rather than the transport hop.
 */
export function inboundTraceContext(
  inMessage: { traceparent?: unknown; tracestate?: unknown } | null | undefined,
  header: (name: string) => string | undefined,
): TraceContext | null {
  return ofValue(inMessage?.traceparent, inMessage?.tracestate) ?? ofValue(header('traceparent'), header('tracestate'));
}

/** The context an HTTP request carries in its headers, or null. */
export function traceContextFromHeaders(header: (name: string) => string | undefined): TraceContext | null {
  return inboundTraceContext(null, header);
}

function freshSpanId(): string {
  let span = randomBytes(8).toString('hex');
  while (/^0+$/.test(span)) span = randomBytes(8).toString('hex');
  return span;
}

/**
 * A child of `tc` for ONE outbound request: the same trace id and flags, a
 * fresh span id. Same trace id is what makes the peer's spans join the caller's
 * trace; a fresh span id per request is what keeps two concurrent outbound
 * calls distinguishable.
 */
export function childOf(tc: TraceContext): TraceContext {
  const p = parseTraceparent(tc.traceparent);
  if (p === null) return tc;
  const traceparent = `00-${p.traceId}-${freshSpanId()}-${p.flags}`;
  return tc.tracestate !== undefined ? { traceparent, tracestate: tc.tracestate } : { traceparent };
}

/** The HTTP header carrier (Streamable HTTP for MCP; JSON-RPC over HTTP for A2A). */
export function traceHeaders(tc: TraceContext | null | undefined): Record<string, string> {
  if (!tc) return {};
  return { traceparent: tc.traceparent, ...(tc.tracestate !== undefined ? { tracestate: tc.tracestate } : {}) };
}

/**
 * The in-message carrier: unprefixed `traceparent` / `tracestate` keys, for MCP
 * `params._meta` and for A2A `Message.metadata.openwop`. Unprefixed is
 * deliberate — `mcp-integration.md` §D names exactly these keys as the mapped
 * OpenTelemetry extension, and a prefixed key would not be the named mapping.
 */
export function traceFields(tc: TraceContext | null | undefined): Record<string, string> {
  return traceHeaders(tc);
}

/**
 * The context the run was created under, read back off the run row. `metadata`
 * is the host-side bag (`RunRecord.metadata`); `traceContext` is a RESERVED key
 * there, so a client-supplied value is stripped before this ever sees it.
 */
export function runTraceContext(metadata: Record<string, unknown> | null | undefined): TraceContext | null {
  const tc = metadata?.['traceContext'];
  if (!tc || typeof tc !== 'object') return null;
  const { traceparent, tracestate } = tc as { traceparent?: unknown; tracestate?: unknown };
  return ofValue(traceparent, tracestate);
}
