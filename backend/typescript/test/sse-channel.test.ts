/**
 * host/sseChannel — the per-tenant concurrent-stream cap + lifecycle teardown
 * (architecture review #2). After the per-IP burst limiter was made to exempt
 * long-lived SSE (#537), this cap is the only server-side bound on how many
 * streams a tenant can hold; these tests pin the cap, the release-on-close, and
 * per-tenant isolation. Uses synthetic req/res so the cap is exercised against
 * a STABLE key (each real anon HTTP request gets a distinct tenant, which would
 * never trip the cap).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { openSseChannel, _resetSseStreamCounts } from '../src/host/sseChannel.js';

function mockReq(opts: string | { tenantId?: string; tenants?: string[] } = {}): Request & { _close: () => void } {
  const o = typeof opts === 'string' ? { tenantId: opts } : opts;
  const closeCbs: Array<() => void> = [];
  return {
    tenantId: o.tenantId,
    principal: o.tenants ? { principalId: 'p', tenants: o.tenants } : undefined,
    header: () => undefined,
    socket: { remoteAddress: '127.0.0.1' },
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
});
