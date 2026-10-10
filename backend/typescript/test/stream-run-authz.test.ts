/**
 * Run-READ authorization — `host/runAccess.loadReadableRun` and the four read
 * paths that now route through it (architecture review #1).
 *
 * The headline gap this guards: `GET /v1/runs/{runId}/events` (the live SSE
 * stream) previously authorized only run *existence* — no tenant check and no
 * RFC 0049 scope seam — so any caller who knew a runId could stream another
 * tenant's full event log, and an enforcement-ON deploy that gated the JSON
 * poll still leaked the same data live. These tests pin both the gate's logic
 * (unit) and the wiring at the HTTP boundary (a cross-tenant caller gets 404
 * on ALL four read paths, including the SSE entrypoint).
 *
 * @see src/host/runAccess.ts
 */

import { mintAnonSession, signSession } from '../src/middleware/cookieSession.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { loadReadableRun } from '../src/host/runAccess.js';
import { toWireRunId } from '../src/host/v2Ids.js';
import { type RunRecord } from '../src/types.js';
import type { Storage } from '../src/storage/storage.js';

// ── Unit: the gate logic in isolation ─────────────────────────────────────

function fakeReq(opts: { tenantId?: string; tenants?: string[] }): Request {
  return {
    tenantId: opts.tenantId,
    principal: opts.tenants ? { principalId: 'p', tenants: opts.tenants } : undefined,
    query: {},
  } as unknown as Request;
}

function stubStorage(run: RunRecord | null): Storage {
  return { getRun: async (id: string) => (run && run.runId === id ? run : null) } as unknown as Storage;
}

// ADR 0812 P3c-0 — long enough for the v2 opaque-id grammar (16–128), so it can be tenant-bound on the wire.
const RUN_A_ID = 'run-A-0123456789abcdef';
const RUN_A: RunRecord = {
  runId: RUN_A_ID, workflowId: 'wf', tenantId: 'tenant-A', status: 'completed',
  inputs: {}, metadata: {}, configurable: {}, createdAt: 'now', updatedAt: 'now',
};

describe('loadReadableRun (unit)', () => {
  it('returns the run for the owning tenant', async () => {
    const run = await loadReadableRun(fakeReq({ tenantId: 'tenant-A' }), stubStorage(RUN_A), RUN_A_ID);
    expect(run.runId).toBe(RUN_A_ID);
  });

  it('404s a caller from a DIFFERENT tenant (no existence leak)', async () => {
    await expect(loadReadableRun(fakeReq({ tenantId: 'tenant-B' }), stubStorage(RUN_A), RUN_A_ID))
      .rejects.toMatchObject({ code: 'run_not_found', httpStatus: 404 });
  });

  it('allows a wildcard operator principal across tenants', async () => {
    const run = await loadReadableRun(fakeReq({ tenants: ['*'] }), stubStorage(RUN_A), RUN_A_ID);
    expect(run.runId).toBe(RUN_A_ID);
  });

  it('404s a missing run', async () => {
    await expect(loadReadableRun(fakeReq({ tenantId: 'tenant-A' }), stubStorage(RUN_A), 'nope'))
      .rejects.toMatchObject({ code: 'run_not_found', httpStatus: 404 });
  });

  it('falls back to "default" tenant when req carries none', async () => {
    // A run owned by a real tenant must NOT be readable by a tenant-less caller.
    await expect(loadReadableRun(fakeReq({}), stubStorage(RUN_A), RUN_A_ID))
      .rejects.toMatchObject({ httpStatus: 404 });
  });
});

// ── HTTP boundary: every read path is actually wired to the gate ───────────

let server: http.Server;
let BASE: string;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT; // default (off) posture
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await storage.insertRun({ ...RUN_A });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('run-read paths reject a cross-tenant caller (HTTP)', () => {
  // An anonymous SESSION is a principal in its own `anon:<sid>` tenant, never
  // `tenant-A`. Each path must 404 rather than serve tenant-A's run/events.
  // ADR 0750 major-1 extension: a request with NO credential is now refused 401
  // before any lookup, so the probe presents a real anon session cookie — the
  // tenant check, not the no-credential refusal, is what this file witnesses.
  //
  // ADR 0812 P3c-0 — major 2 addresses a run by a TENANT-BOUND id, and the
  // identity layer refuses a segment that is not the caller's own tenant
  // (`403 id_tenant_mismatch`) before any lookup. So each caller binds the id
  // to ITS OWN tenant: that passes the identity check and reaches
  // `loadReadableRun`, which is the read gate this file witnesses.
  const paths = [
    { label: 'GET /runs/:id', tail: '', accept: 'application/json' },
    { label: 'SSE  /runs/:id/events', tail: '/events', accept: 'text/event-stream' },
    { label: 'JSON /runs/:id/events', tail: '/events', accept: 'application/json' },
    { label: 'poll /runs/:id/events/poll', tail: '/events/poll', accept: 'application/json' },
    { label: 'bundle /runs/:id/debug-bundle', tail: '/debug-bundle', accept: 'application/json' },
  ];
  const runPath = (tenant: string, tail: string) => `/runs/${encodeURIComponent(toWireRunId(RUN_A_ID, tenant))}${tail}`;
  // ADR 0812 P2b — POSITIVE CONTROL. These paths moved off `/v1`, and a 404 is
  // also what an unrouted or refused path answers, so the negative below would
  // pass vacuously. The wildcard operator reads the SAME run on the SAME path.
  for (const { label, tail, accept } of paths) {
    it(`${label} → 200 for a principal that may read tenant-A`, async () => {
      const ac = new AbortController();
      // The wildcard dev-token's request tenant is `default`.
      const res = await fetch(`${BASE}${runPath('default', tail)}`, { headers: { accept, authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' }, signal: ac.signal });
      expect(res.status, `${label} must be routed and serve run-A`).toBe(200);
      ac.abort();
    });
  }
  for (const { label, tail, accept } of paths) {
    it(`${label} → 404 for a different tenant`, async () => {
      const session = mintAnonSession();
      const res = await fetch(`${BASE}${runPath(session.tenantId, tail)}`, { headers: { accept, cookie: `__session=${signSession(session)}`, 'OpenWOP-Version': '2' } });
      expect(res.status, `${label} should not leak tenant-A`).toBe(404);
    });
  }
});
