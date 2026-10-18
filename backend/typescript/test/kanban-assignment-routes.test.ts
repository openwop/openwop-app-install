/**
 * ADR 0049 — kanban assignment over HTTP (the REST surface + permission model).
 *
 * Drives the real app with authenticated users (the ADR 0026 test-auth seam) so
 * the gates the service-level test bypasses are actually exercised:
 *   - assign in a shared workspace → addressed notification reaches ONLY the
 *     assignee's inbox; the card appears on their /kanban/assigned mirror;
 *   - a non-member assignee is rejected (tenant isolation, fail-closed);
 *   - role-addressed → claim makes the claimer the accountable assignee;
 *   - completing the card (terminal lane, incl. the legacy name-match fallback)
 *     withdraws (archives) the assignee's inbox item.
 *
 * (Self-assignment on your OWN personal workspace without a member row — review
 * fix #1 — lives in kanban-stack-write-oidc-identity.test.ts: the test-auth seam
 * here seeds the owner row, so this harness could never reach that branch.)
 *
 * Red if the membership check, the addressed recipient, the terminal-lane
 * withdraw or its name/last-column fallback, the role mirror, the claim's
 * assignee write or the mirror's board name break (probes w37g1-as-*).
 *
 * @see docs/adr/0049-kanban-card-assignment-to-people.md
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

interface Res<T = unknown> { status: number; body: T }
interface ErrBody { error?: string; message?: string }
interface Mirror { cards: Array<{ id: string; boardName?: string }> }
interface Inbox { notifications: Array<{ type: string; status: string; metadata?: { cardId?: string } }> }
interface CardBody { id: string; assigneeId?: string; assigneeRole?: string; completedAt?: string }
type Call = <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
function client(): { get: Call; post: Call; patch: Call } {
  let cookie = '';
  const call = async <T = unknown>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]; }
    // JSON response bodies are typed by each call site's view (`T`).
    const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

let n = 0;
async function signup(c: ReturnType<typeof client>): Promise<{ userId: string }> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `kb-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

const K = '/host/openwop-app/kanban';

describe('ADR 0049 routes — shared workspace assignment', () => {
  it('assign → addressed inbox + mirror for the assignee only; non-member rejected', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: 'Acme' })).body.workspaceId;
    await owner.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);

    const bob = client();
    const b = await signup(bob);
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'Bob', subject: b.userId, roles: ['editor'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);

    const board = (await owner.post<{ id: string }>(`${K}/boards`, { name: 'Launch' })).body;
    const card = (await owner.post<CardBody>(`${K}/boards/${board.id}/cards`, { title: 'Ship it', columnId: 'todo' })).body;

    // Non-member assignee is rejected (fail-closed).
    const bad = await owner.post<ErrBody>(`${K}/cards/${card.id}/assign`, { assigneeId: 'user:nobody' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'validation_error', message: 'Assignee must be a member of this workspace.' });

    // Assign to Bob.
    const ok = await owner.post(`${K}/cards/${card.id}/assign`, { assigneeId: b.userId, comment: 'you own this' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    // Bob switches in and sees the card on his mirror + an addressed notification.
    await bob.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    const mine = await bob.get<Mirror>(`${K}/assigned`);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.cards.map((c) => c.id)).toContain(card.id);
    expect(mine.body.cards.find((c) => c.id === card.id)?.boardName).toBe('Launch');

    const bobInbox = await bob.get<Inbox>('/host/openwop-app/notifications');
    const assigned = bobInbox.body.notifications.filter((x) => x.type === 'task.assigned');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.metadata?.cardId).toBe(card.id);

    // The owner does NOT see Bob's addressed notification (per-recipient privacy).
    const ownerInbox = await owner.get<Inbox>('/host/openwop-app/notifications');
    expect(ownerInbox.status).toBe(200);
    expect(ownerInbox.body.notifications.filter((x) => x.type === 'task.assigned')).toHaveLength(0);
  });

  it('completing the card (incl. legacy name-match terminal lane) withdraws the inbox item', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: 'Acme2' })).body.workspaceId;
    await owner.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    const bob = client();
    const b = await signup(bob);
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'Bob', subject: b.userId, roles: ['editor'] });

    // Custom columns with NO `terminal` flag — the last/"shipped" lane is a
    // legacy fallback terminal (review fix #2).
    const board = (await owner.post<{ id: string }>(`${K}/boards`, { name: 'Custom', columns: [{ id: 'backlog', name: 'Backlog' }, { id: 'shipped', name: 'Shipped' }] })).body;
    const card = (await owner.post<CardBody>(`${K}/boards/${board.id}/cards`, { title: 'Task', columnId: 'backlog' })).body;
    await owner.post(`${K}/cards/${card.id}/assign`, { assigneeId: b.userId });

    await bob.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    expect((await bob.get<Inbox>('/host/openwop-app/notifications')).body.notifications.filter((x) => x.type === 'task.assigned' && x.status === 'unread')).toHaveLength(1);

    // Move to the fallback-terminal column → completion withdraws Bob's item.
    const moved = await owner.patch<{ card: CardBody }>(`${K}/cards/${card.id}`, { columnId: 'shipped' });
    expect(moved.status).toBe(200);
    expect(moved.body.card.completedAt).toBeTruthy();
    const after = await bob.get<Inbox>('/host/openwop-app/notifications');
    expect(after.body.notifications.filter((x) => x.type === 'task.assigned')).toHaveLength(0); // out of the default view…
    const archived = await bob.get<Inbox>('/host/openwop-app/notifications?includeArchived=true');
    expect(archived.body.notifications.filter((x) => x.type === 'task.assigned').map((x) => x.status)).toEqual(['archived']); // …because it was ARCHIVED (withdrawn), not lost
  });

  it('role-addressed card surfaces in a holder mirror and can be claimed', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: 'Acme3' })).body.workspaceId;
    await owner.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    const bob = client();
    const b = await signup(bob);
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'Bob', subject: b.userId, roles: ['editor'] });

    const board = (await owner.post<{ id: string }>(`${K}/boards`, { name: 'Roleboard' })).body;
    const card = (await owner.post<CardBody>(`${K}/boards/${board.id}/cards`, { title: 'Anyone editor', columnId: 'todo' })).body;
    expect((await owner.post(`${K}/cards/${card.id}/assign`, { assigneeRole: 'editor' })).status).toBe(200);

    await bob.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    const mine = await bob.get<Mirror>(`${K}/assigned`);
    expect(mine.body.cards.map((c) => c.id)).toContain(card.id); // surfaces via the 'editor' role

    const claim = await bob.post<{ card: CardBody }>(`${K}/cards/${card.id}/claim`);
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect(claim.body.card.assigneeId).toBe(b.userId);
    expect(claim.body.card.assigneeRole).toBeFalsy();
  });
});
