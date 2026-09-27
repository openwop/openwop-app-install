/**
 * RFC 0207 — the outbound W3C Trace Context carrier (`host/traceContext.ts`).
 *
 * What is actually load-bearing here, and therefore what these assert:
 *
 *  - the W3C §3.2.2 grammar, because a malformed value MUST restart the trace
 *    rather than be forwarded (a forwarded garbage value fails the suite's
 *    `classifyCarriers` outright, which is worse than sending nothing);
 *  - `childOf` keeps the TRACE id and mints a FRESH span id — the trace id is
 *    what makes the peer's spans join the caller's trace, and the suite fails a
 *    row whose carrier trace id is not the one it sent;
 *  - `runTraceContext` reads the reserved `run.metadata.traceContext` key and
 *    refuses a forged/garbage one, so an outbound call carries only a context
 *    this host actually stamped from a request header;
 *  - `traceContext` is in `RESERVED_RUN_METADATA_KEYS`, so a caller's value is
 *    stripped before the host's own stamp lands.
 *
 * @see RFCS/0207-trace-context-across-mcp-and-a2a.md §A, §B
 */
import { describe, it, expect } from 'vitest';
import {
  parseTraceparent,
  inboundTraceContext,
  traceContextFromHeaders,
  childOf,
  traceHeaders,
  traceFields,
  runTraceContext,
} from '../traceContext.js';
import { stripReservedRunMetadata } from '../runDispatch.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';
const TP = `00-${TRACE}-${SPAN}-01`;

const headers = (h: Record<string, string>) => (n: string): string | undefined => h[n.toLowerCase()];

describe('parseTraceparent (W3C §3.2.2)', () => {
  it('accepts a well-formed version-00 value', () => {
    expect(parseTraceparent(TP)).toEqual({ traceId: TRACE, parentId: SPAN, flags: '01' });
  });
  it('rejects the forbidden version ff, an all-zero trace id and an all-zero span id', () => {
    expect(parseTraceparent(`ff-${TRACE}-${SPAN}-01`)).toBeNull();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE}-${'0'.repeat(16)}-01`)).toBeNull();
  });
  it('rejects uppercase hex, a short trace id, a non-string and a version-00 value with a trailing field', () => {
    expect(parseTraceparent(TP.toUpperCase())).toBeNull();
    expect(parseTraceparent(`00-${TRACE.slice(0, 30)}-${SPAN}-01`)).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent({ traceparent: TP })).toBeNull();
    expect(parseTraceparent(`${TP}-extra`)).toBeNull();
  });
  it('accepts a FUTURE version that appends a field (forward compatibility)', () => {
    expect(parseTraceparent(`01-${TRACE}-${SPAN}-01-future`)).not.toBeNull();
  });
});

describe('inboundTraceContext', () => {
  it('prefers the in-message carrier over the HTTP header', () => {
    const other = '1'.repeat(32);
    const tc = inboundTraceContext({ traceparent: `00-${other}-${SPAN}-01` }, headers({ traceparent: TP }));
    expect(parseTraceparent(tc?.traceparent)?.traceId).toBe(other);
  });
  it('falls back to the header when the in-message carrier is malformed — never fails the request', () => {
    const tc = inboundTraceContext({ traceparent: 'garbage' }, headers({ traceparent: TP }));
    expect(parseTraceparent(tc?.traceparent)?.traceId).toBe(TRACE);
  });
  it('is null when neither carrier is present or both are malformed', () => {
    expect(inboundTraceContext(null, headers({}))).toBeNull();
    expect(inboundTraceContext({ traceparent: 'garbage' }, headers({ traceparent: 'also-garbage' }))).toBeNull();
  });
  it('carries a plausible tracestate but drops a bad one without invalidating the traceparent', () => {
    expect(traceContextFromHeaders(headers({ traceparent: TP, tracestate: 'vendor=x' }))?.tracestate).toBe('vendor=x');
    expect(traceContextFromHeaders(headers({ traceparent: TP, tracestate: 'x'.repeat(600) }))?.tracestate).toBeUndefined();
  });
});

describe('childOf', () => {
  it('keeps the trace id and the flags but mints a fresh span id', () => {
    const child = childOf({ traceparent: TP });
    const p = parseTraceparent(child.traceparent);
    expect(p?.traceId).toBe(TRACE);
    expect(p?.flags).toBe('01');
    expect(p?.parentId).not.toBe(SPAN);
  });
  it('gives two concurrent outbound calls distinguishable span ids', () => {
    const a = childOf({ traceparent: TP });
    const b = childOf({ traceparent: TP });
    expect(a.traceparent).not.toBe(b.traceparent);
  });
  it('preserves tracestate', () => {
    expect(childOf({ traceparent: TP, tracestate: 'vendor=x' }).tracestate).toBe('vendor=x');
  });
});

describe('the two carriers', () => {
  it('names the HTTP header and the in-message keys UNPREFIXED (the mapping mcp-integration.md §D names)', () => {
    const tc = { traceparent: TP, tracestate: 'vendor=x' };
    expect(traceHeaders(tc)).toEqual({ traceparent: TP, tracestate: 'vendor=x' });
    expect(traceFields(tc)).toEqual({ traceparent: TP, tracestate: 'vendor=x' });
  });
  it('emits NOTHING when there is no context — a host must not invent a trace', () => {
    expect(traceHeaders(null)).toEqual({});
    expect(traceFields(undefined)).toEqual({});
  });
  it('omits tracestate when the run carried none', () => {
    expect(traceHeaders({ traceparent: TP })).toEqual({ traceparent: TP });
  });
});

describe('runTraceContext (the reserved run-metadata key)', () => {
  it('reads back a stamped context', () => {
    expect(runTraceContext({ traceContext: { traceparent: TP } })?.traceparent).toBe(TP);
  });
  it('is null for an absent, non-object or malformed value', () => {
    expect(runTraceContext(undefined)).toBeNull();
    expect(runTraceContext({})).toBeNull();
    expect(runTraceContext({ traceContext: TP })).toBeNull();
    expect(runTraceContext({ traceContext: { traceparent: 'garbage' } })).toBeNull();
  });
});

describe('the caller cannot supply the carrier', () => {
  it('strips a client-supplied traceContext from run metadata', () => {
    const out = stripReservedRunMetadata({ traceContext: { traceparent: TP }, mine: 'kept' });
    expect(out).toEqual({ mine: 'kept' });
  });
});
