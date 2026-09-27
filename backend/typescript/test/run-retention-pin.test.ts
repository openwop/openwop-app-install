/**
 * ADR 0371 Phase 5 — the retention pin at the run surface: POST pin toggles
 * run.metadata.pinned, the snapshot projects `pinned` + `removalAt`, and the
 * P2 sweeper honors the pin (a pinned run survives a past-deadline sweep).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_RUN_RETENTION_DAYS = '30'; // retention is OFF by default now — enable it for this suite
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { delete process.env.OPENWOP_RUN_RETENTION_DAYS; await new Promise<void>((res) => server.close(() => res())); });

async function j<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function makeTerminalRun(): Promise<string> {
  const wfId = `pin-wf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await j('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId: wfId, nodes: [{ nodeId: 'a', typeId: 'core.noop' }] }) });
  const create = await j<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId: wfId, inputs: {} }) });
  const runId = create.body.runId;
  for (let i = 0; i < 60; i++) {
    const snap = await j<{ status: string }>(`/v1/runs/${runId}`);
    if (snap.body.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return runId;
}

describe('run retention pin (ADR 0371 P5)', () => {
  it('the snapshot projects removalAt after a terminal transition', async () => {
    const runId = await makeTerminalRun();
    const snap = await j<{ removalAt?: string; pinned?: boolean }>(`/v1/runs/${runId}`);
    expect(snap.body.removalAt).toBeTruthy(); // default 30d stamp
    expect(snap.body.pinned).toBeUndefined();
  });

  it('POST pin sets run.metadata.pinned; the snapshot reflects it; unpin clears it (the sweep-honors-pin path is P2-covered)', async () => {
    const runId = await makeTerminalRun();
    expect((await j(`/v1/host/openwop-app/runs/${runId}/pin`, { method: 'POST' })).status).toBe(200);
    expect((await j<{ pinned?: boolean; removalAt?: string }>(`/v1/runs/${runId}`)).body.pinned).toBe(true);

    expect((await j(`/v1/host/openwop-app/runs/${runId}/pin`, { method: 'POST', body: JSON.stringify({ pinned: false }) })).status).toBe(200);
    expect((await j<{ pinned?: boolean }>(`/v1/runs/${runId}`)).body.pinned).toBeUndefined();
  });
});
