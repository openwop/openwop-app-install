/**
 * RFC 0219 — `OpenWOP-Client-Version` is `<major>.<minor>[.<patch>]` (non-negative
 * integers, no leading zeros), compared on major.minor only, and a MALFORMED value
 * is treated as if the header were ABSENT: never 426, never 400. A missing header
 * is never refused. A well-formed value below `minClientVersion` still gets
 * `426 client_version_unsupported` with `details.minClientVersion` (§1.5), major 2
 * only.
 *
 * Before this fix the grammar was unanchored (`1.0abc` parsed as 1.0) and a
 * non-matching value fell back to '0.0' — so "abc" was REFUSED with 426, the
 * exact inversion of the rule.
 *
 * Every served case asserts it got the DISCOVERY document (a `protocolVersions`
 * array, no `error`), not just a 200, and the values and floor are literals
 * (`2.0`), never `minClientVersion()`, so a sabotaged floor cannot move the
 * expectation with it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { minClientVersion } from '../src/middleware/protocolVersion.js';

let server: Server;
let base = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function discovery(clientVersion: string | undefined): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'OpenWOP-Version': '2' };
  if (clientVersion !== undefined) headers['OpenWOP-Client-Version'] = clientVersion;
  const res = await fetch(`${base}/.well-known/openwop`, { headers });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Served = 200 AND the body is the v2 discovery document, not an error or a fallthrough. */
function expectServed(r: { status: number; body: Record<string, unknown> }): void {
  expect(r.status).toBe(200);
  expect(Array.isArray(r.body['protocolVersions'])).toBe(true);
  expect(r.body['error']).toBeUndefined();
}

describe('RFC 0219 — OpenWOP-Client-Version grammar', () => {
  // ADR 0812 P3c-0 — the floor follows retirement (`1.0` through the overlap, `2.0` after
  // the cut), so the cases below are stated relative to it rather than to a pinned `1.0`.
  it('the floor is 2.0 (v1 retired, ADR 0812)', () => {
    expect(minClientVersion()).toBe('2.0');
  });

  it.each([
    ['abc', 'no grammar at all'],
    ['1.0abc', 'trailing garbage (the old unanchored parse read this as 1.0)'],
    ['01.0', 'a leading zero'],
    ['1', 'major only'],
    ['1.0.0.0', 'too many parts'],
    ['0.0abc', 'a below-floor PREFIX is still malformed, so it is still absent'],
  ])('a MALFORMED value is treated as absent and served: %s (%s)', async (v) => {
    expectServed(await discovery(v));
  });

  it('a missing header is never refused', async () => {
    expectServed(await discovery(undefined));
  });

  it.each([['2.0.7'], ['2.0'], ['2.3']])('a well-formed value at/above the floor is served: %s', async (v) => {
    expectServed(await discovery(v));
  });

  it('a well-formed value BELOW the floor is refused 426 with minClientVersion', async () => {
    const r = await discovery('0.0.1');
    expect(r.status).toBe(426);
    expect(r.body).toMatchObject({ error: 'client_version_unsupported', details: { minClientVersion: '2.0' } });
  });

  // ADR 0812 P3c-0 — the "floor is enforced on major 2 only" leg (a major-1 request) is
  // deleted with v1: a major-1 request is now a 406, so major 2 is the only major there is.
});
