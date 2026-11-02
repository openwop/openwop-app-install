/**
 * Coverage for the P0.2 cookie-mode auth path:
 *   - First request without a cookie mints an anonymous session.
 *   - Subsequent requests carrying the cookie hit the same tenant.
 *   - A tampered signature is not a session: the request is answered 200 as
 *     a fresh anonymous visitor, with a NEW cookie whose tenant is not the
 *     forged one.
 *   - Tenant id derives from the cookie, not from request body, so
 *     body.tenantId = "someone-elses-tenant" can't impersonate.
 *
 * Tracker TST-BEC-1 (w66). Red when: the anon mint stops setting the cookie;
 * `verifySession` ignores a valid cookie (the session is not preserved); the
 * HMAC length/compare checks are removed (the forged tenant is accepted); the
 * principal authorizer allows any tenant (impersonation case).
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';

let server: http.Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = ''; // cookie mode ON
  process.env.OPENWOP_SESSION_SECRET = ''; // dev fallback kicks in
  delete process.env.OPENWOP_SESSION_SECRET;
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test-cookie',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

function extractCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  // "__session=value; Path=/; Max-Age=..." — extract just `key=value`.
  const head = setCookieHeader.split(';')[0]!;
  return head.trim();
}

describe('cookie-mode auth (P0.2)', () => {
  it('mints a session cookie on first request', async () => {
    // Hit a route that requires auth. /host/openwop-app/workflows is a
    // GET that 200s with an empty list once authed.
    const res = await fetch(`${BASE}/host/openwop-app/workflows`);
    expect(res.status).toBe(200);
    const cookie = extractCookie(res.headers.get('set-cookie'));
    expect(cookie).toMatch(/^__session=/);
  });

  it('preserves the session across requests + derives tenantId from cookie', async () => {
    const first = await fetch(`${BASE}/host/openwop-app/workflows`);
    const cookie = extractCookie(first.headers.get('set-cookie'))!;
    // Register a workflow (POST) carrying the cookie; the run should
    // inherit the cookie-derived tenant.
    const reg = await fetch(`${BASE}/host/openwop-app/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        workflowId: 'cookie-test',
        nodes: [{ nodeId: 'shout', typeId: 'local.openwop-app.uppercase' }],
      }),
    });
    expect(reg.status).toBe(201);

    // Create a run WITHOUT passing tenantId in the body. The cookie's
    // tenant should be used.
    const runRes = await fetch(`${BASE}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ workflowId: 'cookie-test', inputs: { text: 'hello' } }),
    });
    expect(runRes.status).toBe(201);
    const run = (await runRes.json()) as { runId: string };

    // Fetch run snapshot to confirm the run was authed to the cookie's
    // tenant. (The snapshot projection doesn't echo tenantId; the
    // success of the create + fetch is the assertion.)
    const snap = await fetch(`${BASE}/runs/${projectBoundId(run.runId)}`, {
      headers: { cookie },
    });
    expect(snap.status).toBe(200);
    const snapBody = (await snap.json()) as { runId: string; workflowId: string };
    expect(snapBody.runId).toBe(run.runId);
    expect(snapBody.workflowId).toBe('cookie-test');
  });

  it('rejects a body.tenantId that doesn\'t match the cookie\'s tenant', async () => {
    const first = await fetch(`${BASE}/host/openwop-app/workflows`);
    const cookie = extractCookie(first.headers.get('set-cookie'))!;
    await fetch(`${BASE}/host/openwop-app/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        workflowId: 'cookie-impersonation-test',
        nodes: [{ nodeId: 'shout', typeId: 'local.openwop-app.uppercase' }],
      }),
    });
    const runRes = await fetch(`${BASE}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        workflowId: 'cookie-impersonation-test',
        tenantId: 'someone-elses-tenant',
        inputs: {},
      }),
    });
    // Principal's tenants is [cookie.tenantId]; authorizer rejects.
    expect(runRes.status).toBe(403);
    const body = (await runRes.json()) as { error: string };
    expect(body.error).toBe('openwop-app.forbidden_tenant');
  });

  it('rejects a tampered signature → new cookie minted', async () => {
    // Forge a payload + bad sig
    const forged = '__session=eyJzaWQiOiJYIiwidGVuYW50SWQiOiJhbm9uOlgiLCJ0aWVyIjoiYW5vbiIsImlhdCI6MSwiZXhwIjoyMDAwMDAwMDAwfQ.BADSIG';
    const res = await fetch(`${BASE}/host/openwop-app/workflows`, {
      headers: { cookie: forged },
    });
    expect(res.status).toBe(200); // a fresh cookie is minted
    const reissued = extractCookie(res.headers.get('set-cookie'));
    expect(reissued).toBeTruthy();
    expect(reissued).not.toBe(forged);
    // The new session is a fresh one, never the forged payload's tenant/sid.
    const value = reissued!.slice('__session='.length);
    const payload = JSON.parse(Buffer.from(value.slice(0, value.indexOf('.')), 'base64url').toString('utf8')) as { tenantId: string; sid: string };
    expect(payload.tenantId).not.toBe('anon:X');
    expect(payload.sid).not.toBe('X');
  });
});
