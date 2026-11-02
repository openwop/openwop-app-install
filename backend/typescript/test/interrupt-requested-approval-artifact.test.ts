/**
 * loop row 3, P2 — interrupt.md §Events — the artifact an approval's `interrupt.requested` names MUST
 * resolve. `ApprovalData.artifactId` is REQUIRED on the wire; an id a client
 * follows to a 404 is a false claim. Witnessed by FETCHING the emitted id
 * through the real artifacts route, in each of the three ways a gate gets one:
 *
 *  1. the gate's own preview (the executor persists its inputs, ADR 0083);
 *  2. a replay fork, which persists nothing, names the INHERITED source preview;
 *  3. the minimal preview `ensureApprovalPreview` persists when there is none.
 *
 * TST-DGD-1. Red when a replay fork stops inheriting the source preview (it
 * would name its own), and when the minimal preview stops being titled with the
 * gate's prompt (sabotage-witnessed, wave 71). Every case creates its OWN run,
 * so the file passes in any order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { ensureApprovalPreview } from '../src/executor/gatePreview.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let server: http.Server;
let BASE = '';
let storage: Storage;
let cookie = '';
let tenantId = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // A REAL member of the run's tenant: the artifacts route authorises per record
  // (`workspace:read` in the record's org), which is exactly what a client that
  // follows the emitted id will meet.
  tenantId = `org:test-p2-${Date.now()}`;
  const login = await api<{ user?: unknown }>('/host/openwop-app/test/login', { method: 'POST', body: JSON.stringify({ email: `p2-${Date.now()}@acme.test`, tenantId }) });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

type Json = Record<string, unknown>;
async function api<T = Json>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } });
  for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
async function waitStatus(runId: string, pred: (s: string) => boolean): Promise<string> {
  let status = '';
  for (let i = 0; i < 200; i++) {
    status = (await api<{ status: string }>(`/runs/${runId}`)).body.status;
    if (pred(status)) return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return status;
}
async function requested(runId: string): Promise<Json[]> {
  const evs = (await api<{ events: Array<{ type: string; payload?: Json }> }>(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`)).body.events ?? [];
  return evs.filter((e) => e.type === 'interrupt.requested').map((e) => e.payload ?? {});
}
const fetchArtifact = (id: string) => api<{ artifactId?: string; title?: string }>(`/host/openwop-app/artifacts/${encodeURIComponent(id)}`);

/** A fresh approval run suspended at its gate, with the artifact its request names. */
async function approvalSource(): Promise<{ runId: string; artifactId: string; artifactType?: string }> {
  const create = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'conformance-approval' }) });
  expect(create.status).toBe(201);
  const runId = create.body.runId;
  expect(await waitStatus(runId, (s) => s.startsWith('waiting'))).toBe('waiting-approval');
  const [req] = await requested(runId);
  expect(req?.['kind']).toBe('approval');
  const data = req?.['data'] as { artifactId?: string; artifactType?: string };
  return { runId, artifactId: String(data.artifactId), ...(data.artifactType ? { artifactType: data.artifactType } : {}) };
}

describe('loop row 3, P2 — interrupt.md §Events — an approval interrupt.requested names an artifact that resolves', () => {
  it('1. the gate\'s own preview', async () => {
    const src = await approvalSource();
    expect(src.artifactType).toBe('openwop-app.gate-preview');
    const got = await fetchArtifact(src.artifactId);
    expect(got.status, `GET ${src.artifactId}`).toBe(200);
    expect(got.body.artifactId).toBe(src.artifactId);
    await api(`/runs/${src.runId}/cancel`, { method: 'POST', body: '{}' });
  });

  it('2. a replay fork names the INHERITED source preview, and it resolves', async () => {
    const src = await approvalSource();
    // fromSeq 1: the fork re-executes the gate (it suspends again on the fork).
    const f = await api<{ runId: string }>(`/runs/${src.runId}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'replay', fromSeq: 1 }) });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    const forkId = f.body.runId;
    expect(await waitStatus(forkId, (s) => s.startsWith('waiting') || ['completed', 'failed'].includes(s))).toBe('waiting-approval');
    const reqs = await requested(forkId);
    const latest = reqs[reqs.length - 1]!;
    const id = String((latest['data'] as { artifactId?: string }).artifactId);
    expect(id, 'the replay fork persists nothing of its own: it names the source preview').toBe(src.artifactId);
    const got = await fetchArtifact(id);
    expect(got.status).toBe(200);
    expect(got.body.artifactId).toBe(src.artifactId);
    await api(`/runs/${forkId}/cancel`, { method: 'POST', body: '{}' });
    await api(`/runs/${src.runId}/cancel`, { method: 'POST', body: '{}' });
  });

  it('3. with no preview to name, a MINIMAL gate preview is persisted, and it resolves', async () => {
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `run-minimal-preview-${randomUUID()}`, workflowId: 'conformance-approval', tenantId,
      status: 'running', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run);
    const preview = await ensureApprovalPreview({ run, nodeId: 'gate', data: { prompt: 'Ship the Q3 report?' } });
    expect(preview?.artifactId).toBe(`run-event:${run.runId}:gate`);
    const got = await fetchArtifact(preview!.artifactId);
    expect(got.status).toBe(200);
    expect(got.body.artifactId).toBe(`run-event:${run.runId}:gate`);
    expect(got.body.title, 'the minimal preview is titled with what is being approved').toBe('Ship the Q3 report?');
  });
});
