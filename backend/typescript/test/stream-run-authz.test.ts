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

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { loadReadableRun } from '../src/host/runAccess.js';
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

const RUN_A: RunRecord = {
  runId: 'run-A', workflowId: 'wf', tenantId: 'tenant-A', status: 'completed',
  inputs: {}, metadata: {}, configurable: {}, createdAt: 'now', updatedAt: 'now',
};

describe('loadReadableRun (unit)', () => {
  it('returns the run for the owning tenant', async () => {
    const run = await loadReadableRun(fakeReq({ tenantId: 'tenant-A' }), stubStorage(RUN_A), 'run-A');
    expect(run.runId).toBe('run-A');
  });

  it('404s a caller from a DIFFERENT tenant (no existence leak)', async () => {
    await expect(loadReadableRun(fakeReq({ tenantId: 'tenant-B' }), stubStorage(RUN_A), 'run-A'))
      .rejects.toMatchObject({ code: 'run_not_found', httpStatus: 404 });
  });

  it('allows a wildcard operator principal across tenants', async () => {
    const run = await loadReadableRun(fakeReq({ tenants: ['*'] }), stubStorage(RUN_A), 'run-A');
    expect(run.runId).toBe('run-A');
  });

  it('404s a missing run', async () => {
    await expect(loadReadableRun(fakeReq({ tenantId: 'tenant-A' }), stubStorage(RUN_A), 'nope'))
      .rejects.toMatchObject({ code: 'run_not_found', httpStatus: 404 });
  });

  it('falls back to "default" tenant when req carries none', async () => {
    // A run owned by a real tenant must NOT be readable by a tenant-less caller.
    await expect(loadReadableRun(fakeReq({}), stubStorage(RUN_A), 'run-A'))
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
    server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('run-read paths reject a cross-tenant caller (HTTP)', () => {
  // A fetch with no cookie is an anon principal — tenant `anon:<sid>`, never
  // `tenant-A`. Each path must 404 rather than serve tenant-A's run/events.
  const paths = [
    { label: 'GET /v1/runs/:id', path: '/v1/runs/run-A', accept: 'application/json' },
    { label: 'SSE  /v1/runs/:id/events', path: '/v1/runs/run-A/events', accept: 'text/event-stream' },
    { label: 'JSON /v1/runs/:id/events', path: '/v1/runs/run-A/events', accept: 'application/json' },
    { label: 'poll /v1/runs/:id/events/poll', path: '/v1/runs/run-A/events/poll', accept: 'application/json' },
    { label: 'bundle /v1/runs/:id/debug-bundle', path: '/v1/runs/run-A/debug-bundle', accept: 'application/json' },
  ];
  for (const { label, path, accept } of paths) {
    it(`${label} → 404 for a different tenant`, async () => {
      const res = await fetch(`${BASE}${path}`, { headers: { accept } });
      expect(res.status, `${label} should not leak tenant-A`).toBe(404);
    });
  }
});
