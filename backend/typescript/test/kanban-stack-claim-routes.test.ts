/**
 * ADR 0774 D4/D5 — the kanban write gate and the role claim, over HTTP.
 *
 * Authorization is only observable at the route boundary, so these drive the
 * real app with real signed-in users (the ADR 0026 test-auth seam) in a SHARED
 * `ws:` workspace — the one tenant shape where "in the tenant" and "may write"
 * differ. Before ADR 0774 a `viewer` there could create and delete boards, and
 * bind a workflow and move a card into a trigger lane to start a run, because a
 * legacy (non-project) board authorized on tenant match alone (`KSTWF-5`).
 *
 * Both sides are pinned: the viewer is REFUSED (403, the board is visible so a
 * 404 would lie) and starts nothing; the editor and owner still write; the
 * personal-workspace owner is untouched; the ADR 0049 assignee carve-out still
 * lets a viewer who was assigned a card progress it.
 *
 * @see docs/adr/0774-kanban-stack-claim-integrity.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const def = getToggleDefault('users');
  if (def) await saveConfig({ ...def, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
function client() {
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
    for (const sc of setCookies) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;

let n = 0;
async function signup(c: Client): Promise<{ userId: string }> {
  const r = await c.post('/host/openwop-app/test/login', { email: `kbw-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

const K = '/host/openwop-app/kanban';
const WS = '/host/openwop-app/workspaces';

/** An owner's shared workspace with a member of `role` switched into it. */
async function sharedWorkspaceWith(role: 'viewer' | 'editor'): Promise<{ owner: Client; member: Client; memberId: string; ws: string }> {
  const owner = client();
  await signup(owner);
  const ws = (await owner.post(WS, { name: `Acme ${n}` })).body.workspaceId as string;
  expect((await owner.post(`${WS}/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
  const member = client();
  const m = await signup(member);
  const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: role, subject: m.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  expect((await member.post(`${WS}/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
  return { owner, member, memberId: m.userId, ws };
}

describe('ADR 0774 D5 — a viewer can read a legacy board but not write it', () => {
  it('refuses every write with 403 and starts no run; the board and card are unchanged', async () => {
    const { owner, member: viewer } = await sharedWorkspaceWith('viewer');
    const board = (await owner.post(`${K}/boards`, {
      name: 'Ops',
      columns: [{ id: 'todo', name: 'To Do' }, { id: 'go', name: 'Go', triggerWorkflowId: 'wf-anything' }, { id: 'done', name: 'Done', terminal: true }],
    })).body;
    expect(board.id).toBeTruthy();
    const card = (await owner.post(`${K}/boards/${board.id}/cards`, { title: 'Keep me', columnId: 'todo' })).body;

    // Visibility is unchanged.
    expect((await viewer.get(`${K}/boards/${board.id}`)).status).toBe(200);

    const refused = await Promise.all([
      viewer.post(`${K}/boards`, { name: 'Mine now' }),
      viewer.post(`${K}/boards/${board.id}/cards`, { title: 'Injected', columnId: 'todo' }),
      viewer.patch(`${K}/boards/${board.id}`, { name: 'Renamed' }),
      viewer.patch(`${K}/cards/${card.id}`, { title: 'Defaced' }),
      viewer.patch(`${K}/cards/${card.id}`, { workflowId: 'wf-anything', columnId: 'go' }),
      viewer.del(`${K}/cards/${card.id}`),
      viewer.del(`${K}/boards/${board.id}`),
    ]);
    for (const r of refused) {
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body?.error ?? r.body?.code).toBe('forbidden_scope');
    }

    const after = (await owner.get(`${K}/boards/${board.id}`)).body;
    expect(after.board.name).toBe('Ops');
    const kept = after.cards.find((c: { id: string }) => c.id === card.id);
    expect(kept).toMatchObject({ title: 'Keep me', columnId: 'todo' });
    expect(kept.lastRunId).toBeUndefined();
    expect(after.cards.map((c: { title: string }) => c.title)).not.toContain('Injected');
  });

  it('an editor still writes (the gate is authority, not a lockout)', async () => {
    const { owner, member: editor } = await sharedWorkspaceWith('editor');
    const board = (await owner.post(`${K}/boards`, { name: 'Shared' })).body;
    const made = await editor.post(`${K}/boards/${board.id}/cards`, { title: 'Editor card', columnId: 'todo' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await editor.patch(`${K}/cards/${made.body.id}`, { columnId: 'doing' })).status).toBe(200);
    expect((await editor.post(`${K}/boards`, { name: 'Editor board' })).status).toBe(201);
  });

  it('the personal-workspace owner is untouched', async () => {
    const solo = client();
    await signup(solo);
    const board = await solo.post(`${K}/boards`, { name: 'Solo' });
    expect(board.status, JSON.stringify(board.body)).toBe(201);
    expect((await solo.post(`${K}/boards/${board.body.id}/cards`, { title: 'Mine', columnId: 'todo' })).status).toBe(201);
  });

  it('a viewer ASSIGNED a card may still progress it (ADR 0049 carve-out), but not edit it', async () => {
    const { owner, member: viewer, memberId } = await sharedWorkspaceWith('viewer');
    const board = (await owner.post(`${K}/boards`, { name: 'Assigned' })).body;
    const card = (await owner.post(`${K}/boards/${board.id}/cards`, { title: 'Yours', columnId: 'todo' })).body;
    expect((await owner.post(`${K}/cards/${card.id}/assign`, { assigneeId: memberId })).status).toBe(200);

    const moved = await viewer.patch(`${K}/cards/${card.id}`, { columnId: 'done' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await viewer.patch(`${K}/cards/${card.id}`, { title: 'Nope' })).status).toBe(403);
  });
});

describe('ADR 0774 D4 — a role-addressed card is claimed exactly once', () => {
  it('two concurrent claimers: one 200, one 409, and the card names the winner', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post(WS, { name: 'Claims' })).body.workspaceId as string;
    await owner.post(`${WS}/${encodeURIComponent(ws)}/switch`);
    const a = client(); const ua = await signup(a);
    const b = client(); const ub = await signup(b);
    for (const [c, u] of [[a, ua], [b, ub]] as const) {
      expect((await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: u.userId, subject: u.userId, roles: ['editor'] })).status).toBe(201);
      await c.post(`${WS}/${encodeURIComponent(ws)}/switch`);
    }
    const board = (await owner.post(`${K}/boards`, { name: 'Queue' })).body;
    const card = (await owner.post(`${K}/boards/${board.id}/cards`, { title: 'First come', columnId: 'todo' })).body;
    expect((await owner.post(`${K}/cards/${card.id}/assign`, { assigneeRole: 'editor' })).status).toBe(200);

    const [ra, rb] = await Promise.all([a.post(`${K}/cards/${card.id}/claim`), b.post(`${K}/cards/${card.id}/claim`)]);
    const statuses = [ra.status, rb.status].sort();
    // Both may also resolve sequentially; then the loser sees the snapshot
    // check (400) instead of the CAS (409). Either way exactly one wins.
    expect(statuses[0]).toBe(200);
    expect([400, 409]).toContain(statuses[1]);
    const winner = ra.status === 200 ? ua.userId : ub.userId;
    const after = (await owner.get(`${K}/boards/${board.id}`)).body.cards.find((c: { id: string }) => c.id === card.id);
    expect(after.assigneeId).toBe(winner);
    expect(after.assigneeRole).toBeUndefined();
  });
});

describe('grade-code fixes inside the ADR 0774 cut (routes)', () => {
  it('KSCD-3 — a viewer invited into someone ELSE\'s personal workspace does not inherit its owner\'s write', async () => {
    const owner = client();
    await signup(owner);
    const personal = (await owner.get('/host/openwop-app/me/workspaces')).body.personal as string;
    expect(personal).toMatch(/^user:/);
    const board = await owner.post(`${K}/boards`, { name: 'My own' });
    expect(board.status, JSON.stringify(board.body)).toBe(201); // the owner's shortcut still holds

    const guest = client();
    const g = await signup(guest);
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(personal)}/members`, { displayName: 'guest', subject: g.userId, roles: ['viewer'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await guest.post(`${WS}/${encodeURIComponent(personal)}/switch`)).status).toBe(200);

    // The tenant has a personal SHAPE; the guest is not its owner.
    const refused = await guest.post(`${K}/boards/${board.body.id}/cards`, { title: 'Injected', columnId: 'todo' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect((await guest.post(`${K}/boards`, { name: 'Squat' })).status).toBe(403);
  });

  it('KSCD-4 — a viewer cannot claim a role card addressed to a role they do not hold (and so cannot then trigger it)', async () => {
    const { owner, member: viewer } = await sharedWorkspaceWith('viewer');
    const board = (await owner.post(`${K}/boards`, {
      name: 'Roles',
      columns: [{ id: 'todo', name: 'To Do' }, { id: 'go', name: 'Go', triggerWorkflowId: 'wf-anything' }, { id: 'done', name: 'Done', terminal: true }],
    })).body;
    const card = (await owner.post(`${K}/boards/${board.id}/cards`, { title: 'For editors', columnId: 'todo' })).body;
    expect((await owner.post(`${K}/cards/${card.id}/assign`, { assigneeRole: 'editor' })).status).toBe(200);

    const claim = await viewer.post(`${K}/cards/${card.id}/claim`);
    expect(claim.status, JSON.stringify(claim.body)).toBe(403);
    // Not the assignee, so the carve-out stays shut too.
    expect((await viewer.patch(`${K}/cards/${card.id}`, { columnId: 'go' })).status).toBe(403);
    const after = (await owner.get(`${K}/boards/${board.id}`)).body.cards.find((c: { id: string }) => c.id === card.id);
    expect(after).toMatchObject({ columnId: 'todo', assigneeRole: 'editor' });
    expect(after.lastRunId).toBeUndefined();
  });
});
