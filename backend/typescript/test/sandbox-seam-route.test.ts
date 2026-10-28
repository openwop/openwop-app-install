/**
 * A13(a) — the RFC 0035 sandbox-invoke seam, now routed through the shared
 * `execInSandboxVm` primitive (host/sandbox.ts). Proves the refactor preserved
 * the seam's richer program-intent taxonomy end-to-end over HTTP: success,
 * forbidden-syscall escape (+escapeKind), capability-gate denial
 * (+requestedCapability), timeout, and an allow-listed host call. Boots the real
 * app with OPENWOP_TEST_SANDBOX_MVP=true.
 *
 * Each refusal is asserted whole (a 200 carrying `error` and NO `result`), so a
 * dispatch that returns nothing cannot pass as either outcome. Round 1's
 * `8fw2g3-seam-fetchmock` was vacuous because the fetch case asserted only that
 * no error came back.
 *
 * Sabotage witnessed red (8f grade-tests wave 2): the allow-list check removed
 * (`8fw2g3-seam-allow`), escapeKind dropped (`-seam-escapekind`), the capability
 * name not split from its message (`-seam-reqcap`), the timeout pattern broken
 * (`-seam-timeout`), args not passed (`-seam-args`), and the fetch mock's value
 * dropped (`-seam-fetchmock-r2`).
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let INVOKE: string;

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // mounts the testSeam routes
  process.env.OPENWOP_TEST_SANDBOX_MVP = 'true';  // enables the sandbox-{load,invoke} seam
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; INVOKE = `${BASE}/host/openwop-app/test/sandbox-invoke`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_SANDBOX_MVP;
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
});

const invoke = (body: unknown) => fetch(INVOKE, { method: 'POST', headers: H, body: JSON.stringify(body) });

interface SeamResp {
  result?: unknown;
  error?: { code?: string; details?: { escapeKind?: string; requestedCapability?: string; message?: string } };
}

describe('A13(a) — sandbox-invoke via execInSandboxVm', () => {
  it('runs a well-behaved program and returns its value', async () => {
    const r = await invoke({ typeId: 'well-behaved.echo', args: { input: 'ping' } });
    expect(r.status).toBe(200);
    const body = await r.json() as SeamResp;
    expect(body.result).toEqual({ echoed: 'ping' });
  });

  it('classifies a forbidden-syscall escape with its escapeKind', async () => {
    const r = await invoke({ typeId: 'misbehave.fs-escape-read' });
    expect(r.status).toBe(200);
    const body = await r.json() as SeamResp;
    expect(body.result).toBeUndefined();
    expect(body.error).toEqual({ code: 'sandbox_escape_attempt', details: { escapeKind: 'host-fs-escape', message: expect.any(String) } });
  });

  it('classifies a capability-gate violation with requestedCapability', async () => {
    const r = await invoke({ typeId: 'misbehave.capability-gate-violation' });
    expect(r.status).toBe(200);
    const body = await r.json() as SeamResp;
    expect(body.result).toBeUndefined();
    expect(body.error).toEqual({
      code: 'sandbox_capability_denied',
      details: { requestedCapability: 'notInAllowedList', message: 'host.notInAllowedList is not in allowedHostCalls' },
    });
  });

  it('times out a runaway loop', async () => {
    const r = await invoke({ typeId: 'misbehave.timeout' });
    expect(r.status).toBe(200);
    const body = await r.json() as SeamResp;
    expect(body.result).toBeUndefined();
    expect(body.error).toEqual({ code: 'sandbox_timeout', details: { message: expect.stringMatching(/timed out/i) } });
  });

  it('permits an allow-listed host call (fetch)', async () => {
    const r = await invoke({ typeId: 'well-behaved.host-fetch', allowedHostCalls: ['fetch'] });
    expect(r.status).toBe(200);
    const body = await r.json() as SeamResp;
    // host.fetch is mocked in the seam context → the mock's VALUE, not a capability denial.
    expect(body).toEqual({ result: { status: 200, body: 'mocked' } });
  });

  it('404s an unknown program id with sandbox_pack_not_found', async () => {
    const r = await invoke({ typeId: 'nope.not.a.program' });
    expect(r.status).toBe(404);
    // Distinguish a real program-not-found from a route-not-mounted 404.
    expect((await r.json() as { error?: string }).error).toBe('sandbox_pack_not_found');
  });
});
