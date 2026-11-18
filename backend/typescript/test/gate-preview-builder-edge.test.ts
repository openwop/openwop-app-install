/**
 * Issue 5910 — an approval gate's "Under review" box shows the step it gates.
 *
 * Reported downstream (source 24183cc77): a run of trigger → drafting step → approval
 * gate showed an empty "Under review" box. On current main this is pinned end to end
 * for a builder-drawn edge, which carries no ports (`sourceOutput`/`targetInput`), so
 * the upstream output lands on the gate's default `input` port:
 *  - the STORED interrupt (what both the inbox card and the chat card read, through
 *    `GET /host/openwop-app/runs/:runId/interrupts`) names the gate preview by
 *    `artifactId` AND `revisionId`. `GateEvidence` fetches only when it has both;
 *  - that revision holds the drafted content.
 * The wire `interrupt.requested` event carries `artifactId` only (ApprovalData's
 * shape), and no SPA card reads the preview from it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';

let server: http.Server;
let BASE = '';
let cookie = '';
let storage: import('../src/storage/storage.js').Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const login = await api('/host/openwop-app/test/login', { method: 'POST', body: JSON.stringify({ email: `r5910-${Date.now()}@acme.test`, tenantId: `org:r5910-${Date.now()}` }) });
  expect(login.status).toBe(201);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

type Json = Record<string, unknown>;
async function api<T = Json>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } });
  for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

describe('issue 5910 — the gate preview behind a builder edge', () => {
  it('the stored interrupt names a preview revision that holds the drafted step', async () => {
    const workflowId = `wf.r5910.${Date.now()}`;
    const saved = await api('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId, name: 'Draft then approve',
      nodes: [
        { nodeId: 'draft', typeId: 'core.identity', config: {} },
        { nodeId: 'review', typeId: 'core.approvalGate', config: { prompt: 'Approve the email draft' } },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 'draft', targetNodeId: 'review' }],
    }) });
    expect([200, 201], JSON.stringify(saved.body)).toContain(saved.status);
    const run = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: { subject: 'Hello', body: 'Dear client, here is the draft.' } }) });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    let status = '';
    for (let i = 0; i < 200 && !status.startsWith('waiting'); i++) { status = (await api<{ status: string }>(`/runs/${run.body.runId}`)).body.status; await new Promise((r) => setTimeout(r, 20)); }
    // The run id on the wire is `<tenant>/<id>`; storage keys the bare id.
    const raw = run.body.runId.includes('/') ? run.body.runId.slice(run.body.runId.indexOf('/') + 1) : run.body.runId;
    const open = await storage.listOpenInterrupts(raw);
    const stored = (open.find((x) => x.kind === 'approval')?.data ?? {}) as Json;
    const rev = await api<{ content?: string }>(`/host/openwop-app/artifacts/${encodeURIComponent(String(stored['artifactId']))}/revisions/${encodeURIComponent(String(stored['revisionId']))}`);
    expect(status).toBe('waiting-approval');
    expect(open.length, 'one open approval').toBe(1);
    expect(typeof stored['artifactId'] === 'string' && typeof stored['revisionId'] === 'string', 'both ids are stored').toBe(true);
    expect(rev.status).toBe(200);
    expect(rev.body.content).toContain('Dear client, here is the draft.');
  });
});
