/**
 * host/sseChannel — the per-tenant concurrent-stream cap + lifecycle teardown
 * (architecture review #2). After the per-IP burst limiter was made to exempt
 * long-lived SSE (#537), this cap is the only server-side bound on how many
 * streams a tenant can hold; these tests pin the cap, the release-on-close, and
 * per-tenant isolation. Uses synthetic req/res so the cap is exercised against
 * a STABLE key (each real anon HTTP request gets a distinct tenant, which would
 * never trip the cap).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { openSseChannel, boundedLifetimeMs, _resetSseStreamCounts } from '../src/host/sseChannel.js';
import { resetRfc0247WireCache, maxStreamAgeSec, rfc0247WireAvailable } from '../src/host/streamAgeCapability.js';

function mockReq(opts: string | { tenantId?: string; tenants?: string[]; destroyed?: boolean; query?: Record<string, string> } = {}): Request & { _close: () => void } {
  const o = typeof opts === 'string' ? { tenantId: opts } : opts;
  const closeCbs: Array<() => void> = [];
  return {
    tenantId: o.tenantId,
    principal: o.tenants ? { principalId: 'p', tenants: o.tenants } : undefined,
    destroyed: o.destroyed ?? false,
    query: o.query ?? {},
    path: '/test/events',
    header: () => undefined,
    socket: { remoteAddress: '127.0.0.1', destroyed: o.destroyed ?? false },
    on: (event: string, cb: () => void) => { if (event === 'close') closeCbs.push(cb); },
    _close: () => closeCbs.forEach((c) => c()),
  } as unknown as Request & { _close: () => void };
}

function mockRes(): Response {
  const res = {
    writeHead: () => res,
    write: () => true,
    end: () => res,
    set: () => res,
  };
  return res as unknown as Response;
}

function open(tenantId: string): ReturnType<typeof openSseChannel> {
  return openSseChannel(mockReq(tenantId), mockRes());
}

describe('sseChannel concurrent-stream cap', () => {
  beforeEach(() => { _resetSseStreamCounts(); process.env.OPENWOP_SSE_MAX_STREAMS_PER_TENANT = '2'; });
  afterEach(() => { delete process.env.OPENWOP_SSE_MAX_STREAMS_PER_TENANT; _resetSseStreamCounts(); });

  it('allows streams up to the cap, then 429s', () => {
    open('tenant-A');
    open('tenant-A');
    expect(() => open('tenant-A')).toThrowError(
      expect.objectContaining({ code: 'rate_limited', httpStatus: 429 }),
    );
  });

  it('releases a slot on close — a freed slot lets a new stream in', () => {
    const req1 = mockReq('tenant-A');
    openSseChannel(req1, mockRes());
    open('tenant-A'); // now at cap (2)
    expect(() => open('tenant-A')).toThrow();
    req1._close(); // client disconnects → slot released
    expect(() => open('tenant-A')).not.toThrow();
  });

  it('explicit channel.close() also releases the slot', () => {
    const ch = open('tenant-A');
    open('tenant-A');
    expect(() => open('tenant-A')).toThrow();
    ch.close();
    expect(() => open('tenant-A')).not.toThrow();
  });

  it('is isolated per tenant — one tenant at cap does not block another', () => {
    open('tenant-A');
    open('tenant-A');
    expect(() => open('tenant-A')).toThrow();
    expect(() => open('tenant-B')).not.toThrow();
    expect(() => open('tenant-B')).not.toThrow();
  });

  it('exempts wildcard operator principals from the cap entirely', () => {
    // tenants: ['*'] (API key / conformance / admin) — open well past the cap;
    // never throws, and consumes no per-key slot.
    for (let i = 0; i < 50; i++) {
      openSseChannel(mockReq({ tenants: ['*'] }), mockRes());
    }
    expect(() => openSseChannel(mockReq({ tenants: ['*'] }), mockRes())).not.toThrow();
    // …and the exempt streams didn't poison a real tenant's bucket: a tenant
    // keyed by its own id still gets its full cap.
    open('tenant-A');
    open('tenant-A');
    expect(() => open('tenant-A')).toThrow();
  });

  it('runs the onClose teardown hook exactly once', () => {
    const req = mockReq('tenant-A');
    const ch = openSseChannel(req, mockRes());
    let n = 0;
    ch.onClose(() => { n += 1; });
    req._close();
    req._close(); // idempotent
    ch.close();   // idempotent
    expect(n).toBe(1);
  });

  it('cap of 0 disables the limit', () => {
    process.env.OPENWOP_SSE_MAX_STREAMS_PER_TENANT = '0';
    for (let i = 0; i < 50; i++) open('tenant-A');
    expect(() => open('tenant-A')).not.toThrow();
  });

  it('refuses a request whose client already disconnected (pre-open abort)', () => {
    // The client aborted during the route's pre-open auth awaits: 'close' has
    // already been emitted, so the teardown listener would never fire. Opening
    // anyway would consume a slot FOREVER (the 2026-07-14 leak window).
    expect(() => openSseChannel(mockReq({ tenantId: 'tenant-A', destroyed: true }), mockRes())).toThrowError(
      expect.objectContaining({ code: 'invalid_request', httpStatus: 408 }),
    );
  });

  it('a pre-destroyed request consumes NO slot — the cap stays free for live streams', () => {
    // Hammer with aborted-before-open requests well past the cap…
    for (let i = 0; i < 10; i++) {
      expect(() => openSseChannel(mockReq({ tenantId: 'tenant-A', destroyed: true }), mockRes())).toThrow();
    }
    // …then a healthy client still gets its full cap (2): no slots leaked.
    expect(() => open('tenant-A')).not.toThrow();
    expect(() => open('tenant-A')).not.toThrow();
    expect(() => open('tenant-A')).toThrow();
  });
});

// A client disconnect that never reaches the container (MEASURED 2026-10-10:
// in-page fetch aborts of kanban streams ran the full 3600 s) holds a cap slot
// until the request times out. `maxAgeMs` bounds that from the server side.
describe('sseChannel maxAgeMs', () => {
  // Jitter pinned to 0 (the full lifetime); its own case is below.
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0); _resetSseStreamCounts(); process.env.OPENWOP_SSE_MAX_STREAMS_PER_TENANT = '1'; });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete process.env.OPENWOP_SSE_MAX_STREAMS_PER_TENANT; delete process.env.OPENWOP_SSE_MAX_AGE_MS; _resetSseStreamCounts(); });

  it('ends the stream at max age: releases the slot, runs onClose once, ends the response', () => {
    const res = mockRes();
    const end = vi.spyOn(res, 'end');
    const ch = openSseChannel(mockReq('tenant-A'), res, { maxAgeMs: 120_000 });
    const hook = vi.fn();
    ch.onClose(hook);
    expect(() => open('tenant-A')).toThrow(); // at cap (1)
    vi.advanceTimersByTime(119_999);
    expect(ch.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(ch.closed).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(() => open('tenant-A')).not.toThrow(); // slot released
  });

  it('a client disconnect before max age clears the timer (no second teardown)', () => {
    const req = mockReq('tenant-A');
    const ch = openSseChannel(req, mockRes(), { maxAgeMs: 120_000 });
    const hook = vi.fn();
    ch.onClose(hook);
    req._close();
    expect(vi.getTimerCount()).toBe(0); // heartbeat and max-age both cleared
    vi.advanceTimersByTime(200_000);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  // ADR 0897 — every stream is bounded by default, so an abandoned one frees
  // its slot within five minutes whatever the network in between does.
  it('without maxAgeMs a stream ends at the 5-minute default, after a retry: hint', () => {
    const res = mockRes();
    const write = vi.spyOn(res, 'write');
    const ch = openSseChannel(mockReq('tenant-A'), res);
    vi.advanceTimersByTime(299_999);
    expect(ch.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(ch.closed).toBe(true);
    expect(write).toHaveBeenLastCalledWith('retry: 1000\n\n');
  });

  it('OPENWOP_SSE_MAX_AGE_MS=0 turns the default off', () => {
    process.env.OPENWOP_SSE_MAX_AGE_MS = '0';
    const ch = open('tenant-A');
    vi.advanceTimersByTime(3_600_000);
    expect(ch.closed).toBe(false);
    ch.close();
  });

  // RFC 0247 — `events.md` holds a live run's stream open, so a wire channel
  // is bounded only for a consumer that opted in with `resumable=true`.
  it("boundWhen 'resumable' never ends a stream that did not opt in", () => {
    const ch = openSseChannel(mockReq('tenant-A'), mockRes(), { boundWhen: 'resumable' });
    vi.advanceTimersByTime(3_600_000);
    expect(ch.closed).toBe(false);
    ch.close();
  });

  it("boundWhen 'resumable' ends an opted-in stream at the default while limits.maxStreamAgeSec is advertised", () => {
    resetRfc0247WireCache(true);
    try {
      const ch = openSseChannel(mockReq({ tenantId: 'tenant-A', query: { resumable: 'true' } }), mockRes(), { boundWhen: 'resumable' });
      vi.advanceTimersByTime(300_000);
      expect(ch.closed).toBe(true);
      expect(maxStreamAgeSec(300_000)).toBe(300);
    } finally { resetRfc0247WireCache(); }
  });

  // RFC 0247: a host MUST NOT end an opted-in stream early unless it advertises
  // the facet — and it can only advertise once the vendored schema defines it.
  it('an opted-in stream is NOT bounded while the schema lacks limits.maxStreamAgeSec (nothing advertised)', () => {
    resetRfc0247WireCache(false);
    try {
      const ch = openSseChannel(mockReq({ tenantId: 'tenant-A', query: { resumable: 'true' } }), mockRes(), { boundWhen: 'resumable' });
      vi.advanceTimersByTime(3_600_000);
      expect(ch.closed).toBe(false);
      expect(maxStreamAgeSec(300_000)).toBeUndefined();
      ch.close();
    } finally { resetRfc0247WireCache(); }
  });

  it('the opted-in bound never goes under the RFC 0247 15 s floor', () => {
    resetRfc0247WireCache(true);
    try {
      process.env.OPENWOP_SSE_MAX_AGE_MS = '1000';
      expect(boundedLifetimeMs(mockReq({ query: { resumable: 'true' } }), { boundWhen: 'resumable' }, () => 0.999999)).toBe(15_000);
      expect(maxStreamAgeSec(1000)).toBe(15);
    } finally { resetRfc0247WireCache(); }
  });

  // Pinned to the corpus: since the v2.46.12 re-pin the vendored schema defines
  // the member, so the unforced gate is ON. A re-sync that loses it reds here
  // instead of silently turning the advert and the bound off.
  it('the vendored v2 schema (v2.46.12+) defines limits.maxStreamAgeSec, so the unforced gate is on', () => {
    resetRfc0247WireCache();
    expect(rfc0247WireAvailable()).toBe(true);
    expect(maxStreamAgeSec(300_000)).toBe(300);
  });

  it('jitter shortens a lifetime by at most 10%', () => {
    const req = mockReq('tenant-A');
    expect(boundedLifetimeMs(req, { maxAgeMs: 100_000 }, () => 0)).toBe(100_000);
    expect(boundedLifetimeMs(req, { maxAgeMs: 100_000 }, () => 0.999999)).toBe(90_000);
    expect(boundedLifetimeMs(req, { maxAgeMs: 0 }, () => 0)).toBe(0);
  });
});

// ADR 0897 — onClose used to keep only the LAST hook. The channel presence
// route registers `leave` and then its access watch, so `leave` never ran and a
// disconnected viewer stayed present until the instance recycled.
describe('sseChannel onClose', () => {
  beforeEach(() => { _resetSseStreamCounts(); });
  it('runs EVERY registered hook once, in order', () => {
    const req = mockReq('tenant-A');
    const ch = openSseChannel(req, mockRes());
    const order: string[] = [];
    ch.onClose(() => order.push('leave'));
    ch.onClose(() => order.push('clearWatch'));
    req._close();
    ch.close();
    expect(order).toEqual(['leave', 'clearWatch']);
  });
});

describe('ADR 0876 — streams that arrive through the front door', () => {
  const STREAM_BASE = 'https://backend-123.us-central1.run.app';
  function viaReq(headers: Record<string, string>): Request & { _close: () => void } {
    const req = mockReq('tenant-F') as unknown as Record<string, unknown>;
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    req.header = (name: string) => lower[name.toLowerCase()];
    req.path = '/host/openwop-app/kanban/boards/b/events';
    return req as unknown as Request & { _close: () => void };
  }
  // The Firebase Hosting hop as MEASURED: Host is the run.app service, the
  // forwarded host is the public domain.
  const FIREBASE_HOP = { host: 'backend-xyz-uc.a.run.app', 'x-forwarded-host': 'app.example.dev' };

  beforeEach(() => {
    _resetSseStreamCounts();
    process.env.OPENWOP_SSE_MAX_STREAMS_PER_TENANT = '1';
    process.env.OPENWOP_STREAM_BASE_URL = STREAM_BASE;
  });
  afterEach(() => {
    delete process.env.OPENWOP_SSE_MAX_STREAMS_PER_TENANT;
    delete process.env.OPENWOP_STREAM_BASE_URL;
    _resetSseStreamCounts();
  });

  it('refuses with 421 naming the stream origin, before headers or a cap slot', () => {
    const res = mockRes();
    const writeHead = vi.spyOn(res, 'writeHead');
    expect(() => openSseChannel(viaReq(FIREBASE_HOP), res)).toThrowError(
      expect.objectContaining({
        code: 'invalid_request',
        httpStatus: 421,
        details: { reason: 'stream_via_front_door', streamBase: STREAM_BASE },
      }),
    );
    expect(writeHead).not.toHaveBeenCalled();
    // The cap is 1: had the refusal consumed a slot, this direct open would 429.
    expect(() => openSseChannel(viaReq({ host: 'backend-123.us-central1.run.app' }), mockRes())).not.toThrow();
  });

  it('serves a direct request (no forwarded host)', () => {
    expect(() => openSseChannel(viaReq({ host: 'backend-123.us-central1.run.app' }), mockRes())).not.toThrow();
  });

  it('serves a pass-through proxy that forwards its own Host (nginx $host)', () => {
    expect(() => openSseChannel(viaReq({ host: 'app.example.dev', 'x-forwarded-host': 'app.example.dev' }), mockRes())).not.toThrow();
  });

  it('serves a forwarded host that IS the stream origin', () => {
    expect(() => openSseChannel(viaReq({ host: 'internal', 'x-forwarded-host': 'backend-123.us-central1.run.app' }), mockRes())).not.toThrow();
  });

  it('changes nothing when no stream origin is configured', () => {
    delete process.env.OPENWOP_STREAM_BASE_URL;
    expect(() => openSseChannel(viaReq(FIREBASE_HOP), mockRes())).not.toThrow();
  });

  it("a wire channel passes frontDoor: 'allow' and is served through the front door", () => {
    expect(() => openSseChannel(viaReq(FIREBASE_HOP), mockRes(), { frontDoor: 'allow' })).not.toThrow();
  });

  // ADR 0897 — Firebase Hosting retries an upstream that has not completed in
  // 60 s; an opted-in stream on that hop completes under it (a long poll).
  it('an opted-in wire stream on the hop is bounded under 60 s; without opt-in it is not', () => {
    resetRfc0247WireCache(true);
    const optedIn = viaReq(FIREBASE_HOP) as unknown as Record<string, unknown>;
    optedIn.query = { resumable: 'true' };
    expect(boundedLifetimeMs(optedIn as unknown as Request, { boundWhen: 'resumable' }, () => 0)).toBe(50_000);
    expect(boundedLifetimeMs(optedIn as unknown as Request, { boundWhen: 'resumable' }, () => 0.999999)).toBe(45_000);
    expect(boundedLifetimeMs(viaReq(FIREBASE_HOP), { boundWhen: 'resumable' }, () => 0)).toBe(0);
    // With the default off the host advertises nothing, so it bounds nothing.
    process.env.OPENWOP_SSE_MAX_AGE_MS = '0';
    expect(boundedLifetimeMs(optedIn as unknown as Request, { boundWhen: 'resumable' }, () => 0)).toBe(0);
    delete process.env.OPENWOP_SSE_MAX_AGE_MS;
    resetRfc0247WireCache();
  });
});
