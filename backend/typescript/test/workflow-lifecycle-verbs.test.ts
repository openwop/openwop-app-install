/**
 * ADR 0369 Phase 2 — lifecycle verbs at the HTTP boundary (authz/IDOR is only
 * observable here): archive/unarchive/promote + the DELETE runs-reference
 * guard + the promote "run it once first" gate (OQ5 decision).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = Record<string, unknown>> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as Record<string, unknown> };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}
async function signup(c: Client): Promise<void> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `lc-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

const WF = '/v1/host/openwop-app/workflows';
const wfDef = (workflowId: string, transient = false) => ({
  workflowId,
  nodes: [{ nodeId: 'a', typeId: 'core.noop' }],
  ...(transient ? { metadata: { lifecycle: { transient: true, generatedBy: 'workflow-author' } } } : {}),
});

async function runToCompletion(c: Client, workflowId: string): Promise<void> {
  const create = await c.post('/v1/runs', { workflowId, inputs: {} });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const runId = create.body.runId as string;
  for (let i = 0; i < 60; i++) {
    const r = await c.get(`/v1/runs/${runId}`);
    const status = r.body.status as string;
    if (status === 'completed') return;
    if (status === 'failed' || status === 'cancelled') throw new Error(`run ${status}: ${JSON.stringify(r.body)}`);
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('run never completed');
}

describe('workflow lifecycle verbs (ADR 0369 P2)', () => {
  it('archive hides from the tenant list, ?includeArchived restores, unarchive returns it live; archived stays run-resolvable', async () => {
    const c = client();
    await signup(c);
    const id = `lc-arch-${Date.now()}`;
    expect((await c.post(WF, wfDef(id))).status).toBe(201);

    expect((await c.post(`${WF}/${id}/archive`)).status).toBe(200);
    const hidden = (await c.get(WF)).body.workflows as Array<{ workflowId: string }>;
    expect(hidden.some((w) => w.workflowId === id)).toBe(false);
    const shown = (await c.get(`${WF}?includeArchived=true`)).body.workflows as Array<{ workflowId: string; archivedAt?: string }>;
    expect(shown.find((w) => w.workflowId === id)?.archivedAt).toBeTruthy();

    // The replay contract survives archive: the definition still RESOLVES —
    // a NEW run can start against the archived definition.
    await runToCompletion(c, id);

    expect((await c.post(`${WF}/${id}/unarchive`)).status).toBe(200);
    const live = (await c.get(WF)).body.workflows as Array<{ workflowId: string }>;
    expect(live.some((w) => w.workflowId === id)).toBe(true);
  });

  it('DELETE refuses (409 workflow_referenced) while runs reference; succeeds for a never-run workflow', async () => {
    const c = client();
    await signup(c);
    const ran = `lc-del-ran-${Date.now()}`;
    expect((await c.post(WF, wfDef(ran))).status).toBe(201);
    await runToCompletion(c, ran);
    const refused = await c.del(`${WF}/${ran}`);
    expect(refused.status).toBe(409);
    expect((refused.body as { details?: { reason?: string } }).details?.reason).toBe('workflow_referenced');

    const fresh = `lc-del-fresh-${Date.now()}`;
    expect((await c.post(WF, wfDef(fresh))).status).toBe(201);
    expect((await c.del(`${WF}/${fresh}`)).status).toBe(200);
  });

  it('promote refuses an untested draft (409 workflow_untested), succeeds after ONE completed run, and RE-PUBLISHES a saved workflow', async () => {
    const c = client();
    await signup(c);
    const id = `lc-promote-${Date.now()}`;
    expect((await c.post(WF, wfDef(id, true))).status).toBe(201);

    // The OWNER's scoped list shows the draft (flagged) pre-promotion — the
    // catalog-hiding that matters is the global registry consumers (P1).
    const before = (await c.get(WF)).body.workflows as Array<{ workflowId: string; transient?: boolean }>;
    expect(before.find((w) => w.workflowId === id)?.transient).toBe(true);

    const untested = await c.post(`${WF}/${id}/promote`);
    expect(untested.status).toBe(409);
    expect((untested.body as { details?: { reason?: string } }).details?.reason).toBe('workflow_untested');

    await runToCompletion(c, id); // transient defs are runnable (review runs)
    const promoted = await c.post(`${WF}/${id}/promote`);
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    expect((promoted.body.lifecycle as { transient?: boolean }).transient).toBeUndefined();

    // Now a saved workflow: visible — and promote is the RE-PUBLISH verb
    // (ADR 0474 correction / grade-ux #1): same gates, re-stamps
    // publishedRevision to the head, lifecycle untouched. The old 400 left
    // publishedBehindHead with no in-app cure but rollback.
    const after = (await c.get(WF)).body.workflows as Array<{ workflowId: string }>;
    expect(after.some((w) => w.workflowId === id)).toBe(true);
    const republished = await c.post(`${WF}/${id}/promote`);
    expect(republished.status, JSON.stringify(republished.body)).toBe(200);
    expect(republished.body.publishedRevision).toBeTruthy();
    expect((republished.body.lifecycle as { transient?: boolean }).transient).toBeUndefined();
  });

  it('IDOR: a foreign tenant gets an indistinguishable 404 from every verb', async () => {
    const owner = client();
    await signup(owner);
    const id = `lc-idor-${Date.now()}`;
    expect((await owner.post(WF, wfDef(id))).status).toBe(201);

    const stranger = client();
    await signup(stranger);
    for (const verb of ['archive', 'unarchive', 'promote']) {
      expect((await stranger.post(`${WF}/${id}/${verb}`)).status).toBe(404);
    }
  });
});
