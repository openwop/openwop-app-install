/**
 * seams-v2 `armIdempotencyHold` (RFC 0213 §B): the next same-key create keeps its
 * Layer-1 claim in flight for holdMs, so a CONCURRENT same-key create meets the
 * production in-flight branch (409 + Retry-After). The seam itself answers only 201.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
const key = (): string => randomBytes(18).toString('base64url');

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

const create = (k: string): Promise<Response> =>
  fetch(`${BASE}/runs`, { method: 'POST', headers: { ...H, 'Idempotency-Key': k }, body: JSON.stringify({ workflowId: 'conformance-noop', inputs: {} }) });

describe('armIdempotencyHold', () => {
  it('a concurrent same-key create during the hold is refused in-flight (409 + Retry-After); the held one completes', async () => {
    const k = key();
    const arm = await fetch(`${BASE}/conformance/seams/sample/test/idempotency/hold`, { method: 'POST', headers: H, body: JSON.stringify({ key: k, holdMs: 800 }) });
    expect(arm.status, await arm.clone().text()).toBe(201);
    const first = create(k);
    await new Promise((r) => setTimeout(r, 150));
    const second = await create(k);
    expect(second.status).toBe(409);
    expect(second.headers.get('retry-after')).toBeTruthy();
    expect((await first).status).toBe(201);
  });

  it('an unarmed key is never delayed', async () => {
    const t0 = Date.now();
    expect((await create(key())).status).toBe(201);
    expect(Date.now() - t0).toBeLessThan(700);
  });

  it('a malformed body is a 400', async () => {
    const r = await fetch(`${BASE}/conformance/seams/sample/test/idempotency/hold`, { method: 'POST', headers: H, body: JSON.stringify({ key: 'short', holdMs: 5 }) });
    expect(r.status).toBe(400);
  });
});
