/**
 * ADR 1124 (#5933 part 2) — a request whose run is deleted is retired, and the
 * rows ADR 1114 never stamped can be reconciled once.
 *
 * Before: `deleteRun` and `pruneTerminalRuns` removed a run's events and
 * interrupts but not its notifications, and appended no event, so ADR 1114's
 * retire subscriber never fired. The row stayed "Approval needed / Unread"
 * and its card read "This approval couldn't be loaded".
 *
 * Sabotage witnesses: drop the `stampDeletedRunRequests` call from sqlite
 * `deleteRun` (or `pruneTerminalRuns`) and the D1 cases fail; make
 * `reconcileStaleRequests` stamp in `report` mode and the report case fails.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { InterruptRecord, NotificationRecord, RunRecord } from '../src/types.js';
import { reconcileStaleRequests } from '../src/notifications/retireRequests.js';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';

let n = 0;
const uid = (p: string): string => `${p}-${Date.now().toString(36)}-${n++}`;

function row(tenantId: string, over: Partial<NotificationRecord>): NotificationRecord {
  return {
    notificationId: uid('n'), tenantId, type: 'openwop-app.workflow.approval-needed', priority: 'high',
    status: 'unread', title: 'Approval needed', message: 'm', createdAt: new Date().toISOString(), ...over,
  };
}
async function run(storage: Storage, tenantId: string, status: RunRecord['status'] = 'running', updatedAt = new Date().toISOString()): Promise<string> {
  const runId = uid('run');
  await storage.insertRun({ runId, workflowId: 'w', tenantId, status, inputs: null, configurable: {}, createdAt: updatedAt, updatedAt } as RunRecord);
  return runId;
}
async function interrupt(storage: Storage, runId: string): Promise<string> {
  const interruptId = uid('i');
  await storage.insertInterrupt({ interruptId, runId, nodeId: 'gate', kind: 'approval', token: uid('t'), data: {}, createdAt: new Date().toISOString() } as InterruptRecord);
  return interruptId;
}

describe('ADR 1124 D1 — a deleted run retires its requests (sqlite)', () => {
  let storage: Storage;
  beforeAll(async () => { storage = await openStorage('memory://'); });

  it('deleteRun stamps that run\'s open requests run-deleted and read, and nothing else', async () => {
    const T = uid('org');
    const r1 = await run(storage, T);
    const r2 = await run(storage, T);
    const open = row(T, { runId: r1, interruptId: await interrupt(storage, r1) });
    const decided = row(T, { runId: r1, interruptId: 'i-old', status: 'read', metadata: { resolution: { state: 'approved', at: 'x' } } });
    const archived = row(T, { runId: r1, interruptId: 'i-arch', status: 'archived' });
    const notice = row(T, { runId: r1, type: 'workflow.failed' }); // not a request
    const other = row(T, { runId: r2, interruptId: await interrupt(storage, r2) });
    for (const x of [open, decided, archived, notice, other]) await storage.insertNotification(x);

    expect(await storage.deleteRun(r1)).toBe(true);
    const o = await storage.getNotification(open.notificationId);
    expect(o?.status).toBe('read');
    expect(o?.metadata?.resolution).toMatchObject({ state: 'run-deleted' });
    expect((await storage.getNotification(decided.notificationId))?.metadata?.resolution).toEqual({ state: 'approved', at: 'x' });
    expect((await storage.getNotification(archived.notificationId))?.metadata?.resolution).toBeUndefined();
    expect((await storage.getNotification(notice.notificationId))?.metadata?.resolution).toBeUndefined();
    expect((await storage.getNotification(other.notificationId))?.status, 'another run\'s request is untouched').toBe('unread');
  });

  it('pruneTerminalRuns stamps the pruned runs\' open requests the same way', async () => {
    const T = uid('org');
    const old = await run(storage, T, 'completed', '2020-01-01T00:00:00.000Z');
    const live = await run(storage, T, 'running', '2020-01-01T00:00:00.000Z');
    const a = row(T, { runId: old, interruptId: 'i-a' });
    const b = row(T, { runId: live, interruptId: await interrupt(storage, live) });
    await storage.insertNotification(a);
    await storage.insertNotification(b);
    const r = await storage.pruneTerminalRuns('2021-01-01T00:00:00.000Z', 1000);
    expect(r.runs).toBeGreaterThanOrEqual(1);
    expect((await storage.getNotification(a.notificationId))?.metadata?.resolution).toMatchObject({ state: 'run-deleted' });
    expect((await storage.getNotification(b.notificationId))?.metadata?.resolution, 'a running run is not pruned').toBeUndefined();
  });
});

describe('ADR 1124 D2 — reconcile the unstamped backlog (sqlite)', () => {
  let storage: Storage;
  beforeAll(async () => { storage = await openStorage('memory://'); });

  /** Every branch at once: resolved, run gone, run ended, still open, unexplained. */
  async function backlog() {
    const T = uid('org');
    const rResolved = await run(storage, T, 'completed');
    const iResolved = await interrupt(storage, rResolved);
    await storage.resolveInterrupt(iResolved, { action: 'reject' }, '2026-11-01T00:00:00.000Z');
    const rEnded = await run(storage, T, 'failed', '2026-11-02T00:00:00.000Z');
    const rOpen = await run(storage, T, 'running');
    const iOpen = await interrupt(storage, rOpen);
    const rOdd = await run(storage, T, 'running');
    const rows = {
      resolved: row(T, { runId: rResolved, interruptId: iResolved }),
      deleted: row(T, { runId: 'run-that-is-gone', interruptId: 'i-gone' }),
      ended: row(T, { runId: rEnded, interruptId: 'i-ended-gone' }),
      open: row(T, { runId: rOpen, interruptId: iOpen }),
      odd: row(T, { runId: rOdd, interruptId: 'i-odd-gone' }),
    };
    for (const x of Object.values(rows)) await storage.insertNotification(x);
    return { T, rows };
  }
  const stateOf = async (id: string) => (await storage.getNotification(id))?.metadata?.resolution;

  it('report counts each branch per tenant and writes nothing', async () => {
    const { T, rows } = await backlog();
    const r = await reconcileStaleRequests(storage, 'report', 2); // a small page exercises the cursor
    expect(r?.stamped).toBe(0);
    expect(r?.byTenant[T]).toEqual({ resolved: 1, runEnded: 1, runDeleted: 1, stillOpen: 1, unexplained: 1 });
    for (const x of Object.values(rows)) {
      expect(await stateOf(x.notificationId), 'report mode writes nothing').toBeUndefined();
      expect((await storage.getNotification(x.notificationId))?.status).toBe('unread');
    }
  });

  it('apply stamps the three decidable branches, leaves the open and unexplained rows, and is idempotent', async () => {
    const { T, rows } = await backlog();
    const r = await reconcileStaleRequests(storage, 'apply', 2);
    expect(r?.byTenant[T]).toEqual({ resolved: 1, runEnded: 1, runDeleted: 1, stillOpen: 1, unexplained: 1 });
    expect(await stateOf(rows.resolved.notificationId)).toEqual({ state: 'rejected', at: '2026-11-01T00:00:00.000Z' });
    expect(await stateOf(rows.deleted.notificationId)).toMatchObject({ state: 'run-deleted' });
    expect(await stateOf(rows.ended.notificationId)).toEqual({ state: 'run-ended', at: '2026-11-02T00:00:00.000Z' });
    expect(await stateOf(rows.open.notificationId), 'still waiting').toBeUndefined();
    expect(await stateOf(rows.odd.notificationId), 'nothing says how it ended').toBeUndefined();
    const again = await reconcileStaleRequests(storage, 'apply', 2);
    expect(again?.byTenant[T]).toEqual({ resolved: 0, runEnded: 0, runDeleted: 0, stillOpen: 1, unexplained: 1 });
    expect(again?.stamped).toBe(0);
  });
});

describe('ADR 1124 — over HTTP: DELETE /runs retires the request', () => {
  let server: http.Server;
  let BASE = '';
  let storage: Storage;
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('the deleted run\'s request is stamped and no longer action-needed', async () => {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      const text = res.status === 204 ? '' : await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : undefined) as Record<string, unknown> };
    };
    const login = await call('POST', '/host/openwop-app/test/login', { email: `adr1124-${uid('u')}@acme.test` });
    expect(login.status).toBe(201);
    const user = login.body.user as { userId: string; tenantId: string };
    const started = await call('POST', '/runs', { workflowId: 'conformance-noop', inputs: {} });
    expect(started.status, JSON.stringify(started.body)).toBeLessThan(300);
    const wire = String(started.body.runId);
    const runId = wire.slice(wire.lastIndexOf('/') + 1);
    const req = row(user.tenantId, { runId, interruptId: 'i-http', recipientUserId: user.userId });
    await storage.insertNotification(req);

    const del = await call('DELETE', `/runs/${encodeURIComponent(wire)}`);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    const after = await storage.getNotification(req.notificationId);
    expect(after?.status).toBe('read');
    expect(after?.metadata?.resolution).toMatchObject({ state: 'run-deleted' });
  });
});
