/**
 * RFC 0064 §F — the tool-hooks invoke seam is served at the CANONICAL conformance
 * namespace `/host/sample/toolhooks/invoke`, so the published
 * `tool-hooks-failure-honesty` scenario (and the other `tool-hooks-*` scenarios)
 * WITNESS this host instead of 404 → soft-skip. Booted host, real HTTP — this is
 * the guard that WFAU-4's §F wire claim is not silently unwitnessed because the
 * seam sits at the vendor path the suite never hits. The `/host/openwop-app/*`
 * alias is asserted equivalent (same handler).
 *
 * Wave 61 (rounds 2–3) — HONEST DOUBLE GUARD on the canonical path. The
 * `/host/sample/toolhooks/invoke` spelling reaches the ONE handler by two
 * independent routes inside `registerTestSeamRoutes` (same seam gate):
 *   (a) the LEGACY rewrite (`testSeam.ts` ~:311, `/host/sample/*` →
 *       `/host/openwop-app/*`) onto the vendor registration, and
 *   (b) its own `app.post('/host/sample/toolhooks/invoke', …)` (~:1466), which
 *       is SHADOWED while (a) exists but serves the moment (a) stops rewriting.
 * So deleting either alone stays green (ts-sample-r2 and ts-rewrite-r2 were
 * both vacuous); deleting the vendor route reddens every sample case
 * (ts-vendor-r2), because (a) still rewrites onto it. The shared piece both
 * routes reach — the handler — is probed by ts-shared-r3.
 *
 * Every case uses its own principal: the rate-limit bucket (5 per
 * principal+tool per minute, module-level) is shared by every case in the file.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // The tool-hooks seam lives in the `registerTestSeamRoutes` module, which is OFF
  // by default and gated on this flag — the same flag the conformance harness sets
  // when it boots a host to run the `tool-hooks-*` scenarios.
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  await new Promise<void>((res) => server.close(() => res()));
});

const SAMPLE = '/host/sample/toolhooks/invoke';
const VENDOR = '/host/openwop-app/toolhooks/invoke';
const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

type SeamResponse = {
  toolCalled?: { principal?: string; toolName?: string };
  toolReturned: { status?: string; error?: { code?: string; message?: string }; durationMs?: number };
  error?: { code?: string };
};

describe('RFC 0064 §F — toolhooks seam is reachable at the canonical /sample/ path', () => {
  it('the CANONICAL /host/sample/toolhooks/invoke path exists (NOT a 404 soft-skip)', async () => {
    const r = await post(SAMPLE, { principal: 'user:canonical', toolName: 'search' });
    // The whole point: the conformance suite must reach the real handler here,
    // not a 404 soft-skip and not some other route.
    expect(r.status).toBe(200);
    const body = await r.json() as SeamResponse;
    expect(body.toolCalled?.principal).toBe('user:canonical');
    expect(body.toolCalled?.toolName).toBe('search');
    expect(body.toolReturned.status).toBe('ok');
  });

  it('§F failure-honesty: simulateToolError → status:error + populated error + non-negative durationMs', async () => {
    const r = await post(SAMPLE, { principal: 'user:fhonesty', toolName: 'search', simulateToolError: true });
    expect(r.status).toBe(200); // the seam call succeeds; the failure is in the tool event
    const body = await r.json() as SeamResponse;
    expect(body.toolReturned.status).toBe('error');
    expect(body.toolReturned.error?.code).toBe('tool_execution_failed');
    expect(typeof body.toolReturned.error?.message).toBe('string');
    expect(body.toolReturned.error?.message?.length).toBeGreaterThan(0);
    expect(body.toolReturned.durationMs).toBeGreaterThanOrEqual(0); // it ran
  });

  it('ok path: status:ok + durationMs, no error', async () => {
    const r = await post(SAMPLE, { principal: 'user:ok', toolName: 'search' });
    expect(r.status).toBe(200);
    const body = await r.json() as SeamResponse;
    expect(body.toolReturned.status).toBe('ok');
    expect(body.toolReturned.durationMs).toBeGreaterThanOrEqual(0);
    expect(body.toolReturned.error).toBeUndefined();
  });

  it('gate: a fail-closed authz refusal is 403 forbidden with NO error payload on the tool event', async () => {
    const r = await post(SAMPLE, { principal: 'user:b', toolName: 'delete', requiredScopes: ['tools.delete'], grantedScopes: ['tools.read'] });
    expect(r.status).toBe(403);
    const body = await r.json() as SeamResponse;
    expect(body.toolReturned.status).toBe('forbidden');
    expect(body.toolReturned.error).toBeUndefined(); // gate → no error payload, no durationMs
    expect(body.toolReturned.durationMs).toBeUndefined();
    expect(body.error?.code).toBe('forbidden'); // HTTP-level gate code
  });

  it('the vendor /host/openwop-app/ alias serves the SAME handler', async () => {
    const r = await post(VENDOR, { principal: 'user:alias', toolName: 'search', simulateToolError: true });
    expect(r.status).toBe(200);
    const body = await r.json() as SeamResponse;
    expect(body.toolReturned.status).toBe('error');
    expect(body.toolReturned.error?.code).toBe('tool_execution_failed');
  });
});
