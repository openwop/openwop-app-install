/**
 * ADR 1155 D6 — `dueAt: null` clears a card's due date, and clearing or moving
 * the date withdraws the assignee's open due notices (ADR 1138).
 *
 * Service half: bare persistence + the notification backend + the real sweep.
 * Route half: `createApp` + cookie sessions, because the `null` must survive
 * the PATCH body parsing and the assignment-scope carve-out (ADR 0049 D4).
 *
 * Red if: `null` is ignored or stored; a stale "Overdue" stays unread after the
 * date is cleared or moved; a cleared card is swept again; a moved date gets no
 * fresh notice; or an assignment-only caller can clear the date.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureNotificationEmitterInstalled } from '../src/bootstrap/notifications.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { enableTenantOverride, saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, createWorkspace } from '../src/host/accessControlService.js';
import { createBoard, createCard, getCard, updateCardFields } from '../src/host/kanbanService.js';
import { kanbanDueRemindersFeature } from '../src/features/kanban-due-reminders/feature.js';
import { __resetDueSweepCursor, sweepTenantDue } from '../src/features/kanban-due-reminders/dueSweep.js';
import { createApp } from '../src/index.js';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

describe('ADR 1155 D6 — clearing dueAt (service)', () => {
  let store: Storage;
  let tenantId: string;

  beforeAll(async () => {
    store = await openStorage('memory://');
    initHostExtPersistence(store);
    ensureNotificationEmitterInstalled(store);
    registerToggleDefault(kanbanDueRemindersFeature.toggleDefault!);
    tenantId = (await createWorkspace({ name: 'Due', ownerSubject: 'user:owner' })).tenantId;
    await createMember({ tenantId, orgId: tenantId, subject: 'user:alice', displayName: 'Alice', roles: ['editor'] });
    expect(await enableTenantOverride('kanban-due-reminders', tenantId, 'test')).toBe('enabled');
  });
  afterAll(async () => {
    __resetHostExtPersistence();
    await store.close();
  });

  const dueNotices = async (cardId: string) =>
    (await store.listNotifications({ tenantId, recipientUserId: 'user:alice', includeArchived: true }))
      .filter((n) => n.type === 'task.due' && n.metadata?.cardId === cardId);

  it('null clears the date, archives the open notice, and the sweep stops', async () => {
    __resetDueSweepCursor();
    const board = await createBoard({ tenantId, name: 'Build' });
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Pick tile', assigneeId: 'user:alice', dueAt: iso(NOW - HOUR) });
    await sweepTenantDue(tenantId, NOW);
    expect((await dueNotices(card.id)).map((n) => [n.metadata?.state, n.status])).toEqual([['overdue', 'unread']]);

    const cleared = await updateCardFields(card.id, { dueAt: null });
    expect(cleared?.dueAt).toBeUndefined();
    expect('dueAt' in (await getCard(card.id))!).toBe(false);
    expect((await dueNotices(card.id)).map((n) => n.status)).toEqual(['archived']);

    __resetDueSweepCursor();
    await sweepTenantDue(tenantId, NOW + HOUR);
    expect(await dueNotices(card.id)).toHaveLength(1);
  });

  it('a moved date archives the old notice and the sweep sends a fresh one', async () => {
    __resetDueSweepCursor();
    const board = await createBoard({ tenantId, name: 'Finish' });
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Order lights', assigneeId: 'user:alice', dueAt: iso(NOW - HOUR) });
    await sweepTenantDue(tenantId, NOW);

    await updateCardFields(card.id, { dueAt: iso(NOW + 30 * HOUR) });
    __resetDueSweepCursor();
    await sweepTenantDue(tenantId, NOW + HOUR);
    const notices = await dueNotices(card.id);
    expect(notices.map((n) => [n.metadata?.state, n.status]).sort()).toEqual([['overdue', 'archived'], ['soon', 'unread']]);
  });

  it('an edit that keeps the date leaves its notice alone; an unassigned card clears quietly', async () => {
    __resetDueSweepCursor();
    const board = await createBoard({ tenantId, name: 'Keep' });
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Confirm grout', assigneeId: 'user:alice', dueAt: iso(NOW - HOUR) });
    await sweepTenantDue(tenantId, NOW);
    await updateCardFields(card.id, { title: 'Confirm grout colour' });
    expect((await dueNotices(card.id)).map((n) => n.status)).toEqual(['unread']);

    const loose = await createCard({ boardId: board.id, columnId: 'todo', title: 'Nobody yet', dueAt: iso(NOW + HOUR) });
    expect((await updateCardFields(loose.id, { dueAt: null }))?.dueAt).toBeUndefined();
  });
});

describe('ADR 1155 D6 — clearing dueAt (route)', () => {
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
  type Call = <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
  function client(): { post: Call; patch: Call } {
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
    return { post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
  }
  let n = 0;
  async function signup(c: ReturnType<typeof client>): Promise<{ userId: string }> {
    const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `due-${Date.now()}-${n++}@acme.test` });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.user;
  }
  const K = '/host/openwop-app/kanban';
  interface CardBody { id: string; dueAt?: string }

  it('a board member clears the date with null; the assignee alone cannot', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: 'Reno' })).body.workspaceId;
    await owner.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    const bob = client();
    const b = await signup(bob);
    expect((await owner.post(`/host/openwop-app/test/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'Bob', subject: b.userId, roles: ['viewer'] })).status).toBe(201);

    const board = (await owner.post<{ id: string }>(`${K}/boards`, { name: 'Kitchen' })).body;
    const card = (await owner.post<CardBody>(`${K}/boards/${board.id}/cards`, { title: 'Pick hood', columnId: 'todo', dueAt: '2026-12-01T00:00:00.000Z' })).body;
    expect(card.dueAt).toBe('2026-12-01T00:00:00.000Z');
    expect((await owner.post(`${K}/cards/${card.id}/assign`, { assigneeId: b.userId })).status).toBe(200);

    await bob.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    const refused = await bob.patch(`${K}/cards/${card.id}`, { dueAt: null });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);

    const ok = await owner.patch<{ card: CardBody }>(`${K}/cards/${card.id}`, { dueAt: null });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.card.dueAt).toBeUndefined();
  });
});
