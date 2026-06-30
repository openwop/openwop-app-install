/**
 * ADR 0025 — personal "My Board" route + owner-based board access, over HTTP.
 *
 * Proves the human-as-orchestration-principal contract at the route boundary
 * (where authorization + session binding actually live — a service-only test
 * can't see it):
 *   - GET /v1/host/openwop-app/kanban/boards/personal ensures + returns the caller's
 *     OWN personal board, idempotently;
 *   - the owner reaches AND mutates that board from a DIFFERENT active workspace
 *     (owner-access, ADR 0025 §5 — the board is bound to the user, not the
 *     active tenant);
 *   - a different user cannot reach it by id (fail-closed, no existence leak);
 *   - an anon sandbox session is refused (durable-only provisioning).
 *
 * @see docs/adr/0025-user-agent-orchestration-symmetry.md
 * @see src/routes/kanban.ts (authorizeBoard + /boards/personal)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) {
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

let n = 0;
async function signup(c: ReturnType<typeof client>): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `pb-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

describe('ADR 0025 — personal board route', () => {
  it('GET /boards/personal ensures + returns the caller\'s own board, idempotently', async () => {
    const c = client();
    await signup(c);
    const r = await c.get('/v1/host/openwop-app/kanban/boards/personal');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(typeof r.body.board.id).toBe('string');
    expect(r.body.board.ownerUserId).toBeTruthy();
    expect(Array.isArray(r.body.cards)).toBe(true);
    // To Do / Doing / Done by default.
    expect(r.body.board.columns.map((col: any) => col.id)).toEqual(['todo', 'doing', 'done']);
    // Idempotent: same board id on a second call (deterministic id, no dup).
    const r2 = await c.get('/v1/host/openwop-app/kanban/boards/personal');
    expect(r2.body.board.id).toBe(r.body.board.id);
  });

  it('the owner reaches + mutates their personal board from a DIFFERENT active workspace', async () => {
    const c = client();
    await signup(c);
    const personal = (await c.get('/v1/host/openwop-app/kanban/boards/personal')).body.board;

    // Switch into a shared workspace → active tenant != the board's (personal) tenant.
    const ws = (await c.post('/v1/host/openwop-app/workspaces', { name: 'Acme Corp' })).body.workspaceId;
    expect(ws).toMatch(/^ws:/);
    const sw = await c.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    expect(sw.status).toBe(200);

    // /boards/personal still resolves to the SAME board (owner-access).
    const again = await c.get('/v1/host/openwop-app/kanban/boards/personal');
    expect(again.status).toBe(200);
    expect(again.body.board.id).toBe(personal.id);

    // A direct GET by id also resolves via owner-access despite the active-tenant mismatch.
    const byId = await c.get(`/v1/host/openwop-app/kanban/boards/${encodeURIComponent(personal.id)}`);
    expect(byId.status).toBe(200);

    // And the owner can WRITE to it from the shared workspace.
    const created = await c.post(`/v1/host/openwop-app/kanban/boards/${encodeURIComponent(personal.id)}/cards`, { title: 'Ship it', columnId: 'todo' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  });

  it('a different user cannot reach the owner\'s personal board by id (fail-closed)', async () => {
    const owner = client();
    await signup(owner);
    const board = (await owner.get('/v1/host/openwop-app/kanban/boards/personal')).body.board;

    const other = client();
    await signup(other);
    const r = await other.get(`/v1/host/openwop-app/kanban/boards/${encodeURIComponent(board.id)}`);
    expect(r.status).toBe(404); // uniform 404 — no existence leak to a non-owner
  });

  it('an anon sandbox session is refused a personal board (durable-only)', async () => {
    // A fresh client with no sign-in is an anon `anon:<sid>` session.
    const anon = client();
    const r = await anon.get('/v1/host/openwop-app/kanban/boards/personal');
    expect(r.status).toBe(401);
  });
});

describe('ADR 0025 — personal schedules (owner=me)', () => {
  it('creates a user-owned schedule, lists it via ?owner=me, and isolates it from other users', async () => {
    const c = client();
    await signup(c);

    // No schedules yet.
    const empty = await c.get('/v1/host/openwop-app/scheduler/jobs?owner=me');
    expect(empty.status).toBe(200);
    expect(empty.body.jobs).toEqual([]);

    // Create a personal schedule (server derives the owner from the session).
    const created = await c.post('/v1/host/openwop-app/scheduler/jobs', { owner: 'me', cronExpr: '0 9 * * *', workflowId: 'wf.brief' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.ownerUserId).toBeTruthy();
    expect(created.body.rosterId).toBeUndefined();

    // It lists under ?owner=me, regardless of active workspace.
    const ws = (await c.post('/v1/host/openwop-app/workspaces', { name: 'Acme' })).body.workspaceId;
    await c.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    const mine = await c.get('/v1/host/openwop-app/scheduler/jobs?owner=me');
    expect(mine.body.jobs.map((j: any) => j.jobId)).toContain(created.body.jobId);

    // The owner can mutate it from the shared workspace (owner-access).
    const paused = await c.patch(`/v1/host/openwop-app/scheduler/jobs/${encodeURIComponent(created.body.jobId)}`, { enabled: false });
    expect(paused.status).toBe(200);
    expect(paused.body.enabled).toBe(false);

    // A different user neither lists nor mutates it (fail-closed).
    const other = client();
    await signup(other);
    const otherList = await other.get('/v1/host/openwop-app/scheduler/jobs?owner=me');
    expect(otherList.body.jobs.map((j: any) => j.jobId)).not.toContain(created.body.jobId);
    const otherPatch = await other.patch(`/v1/host/openwop-app/scheduler/jobs/${encodeURIComponent(created.body.jobId)}`, { enabled: true });
    expect(otherPatch.status).toBe(404);
  });

  it('a re-submitted identical personal schedule is idempotent (deterministic id, no duplicate)', async () => {
    const c = client();
    await signup(c);
    const a = await c.post('/v1/host/openwop-app/scheduler/jobs', { owner: 'me', cronExpr: '0 9 * * *', workflowId: 'wf.brief' });
    expect(a.status).toBe(201);
    // Same content again → same job id, 200 (not a new row).
    const b = await c.post('/v1/host/openwop-app/scheduler/jobs', { owner: 'me', cronExpr: '0 9 * * *', workflowId: 'wf.brief' });
    expect(b.status).toBe(200);
    expect(b.body.jobId).toBe(a.body.jobId);
    const list = await c.get('/v1/host/openwop-app/scheduler/jobs?owner=me');
    expect(list.body.jobs.filter((j: any) => j.jobId === a.body.jobId)).toHaveLength(1);
    // A different cadence is a genuinely different schedule → new row.
    const d = await c.post('/v1/host/openwop-app/scheduler/jobs', { owner: 'me', cronExpr: '0 * * * *', workflowId: 'wf.brief' });
    expect(d.status).toBe(201);
    expect(d.body.jobId).not.toBe(a.body.jobId);
  });

  it('a personal schedule cannot also bind a rosterId; anon owner=me is refused', async () => {
    const c = client();
    await signup(c);
    const bad = await c.post('/v1/host/openwop-app/scheduler/jobs', { owner: 'me', cronExpr: '0 9 * * *', rosterId: 'host:sally-1' });
    expect(bad.status).toBe(400);

    const anon = client();
    const r = await anon.post('/v1/host/openwop-app/scheduler/jobs', { owner: 'me', cronExpr: '0 9 * * *' });
    expect(r.status).toBe(401);
  });
});
