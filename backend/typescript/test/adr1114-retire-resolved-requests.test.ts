/**
 * ADR 1114 (#5868) — a request is over when its step is.
 *
 * Before: only the inbox card's own resolve archived a request. Decided in chat,
 * timed out, or the run ended, the row stayed "Approval needed / Unread".
 * Sabotage witness: make `retireRequestsFor` return 0 without calling storage
 * (or drop the `installRequestRetirement` line in bootstrap/notifications.ts)
 * and the storage and boot cases fail.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { EventRecord, NotificationRecord, RunRecord } from '../src/types.js';
import { resolutionStateOf, retireRequestsFor } from '../src/notifications/retireRequests.js';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';

const TENANT = 'org:adr1114';

function row(id: string, over: Partial<NotificationRecord>): NotificationRecord {
  return {
    notificationId: id, tenantId: TENANT, type: 'openwop-app.workflow.approval-needed', priority: 'high',
    status: 'unread', title: 'Approval needed', message: 'm', createdAt: new Date().toISOString(), ...over,
  };
}

function event(runId: string, type: string, payload: unknown): EventRecord {
  return { eventId: `e-${type}-${runId}`, runId, type, payload, sequence: 1, timestamp: '2026-11-13T01:00:00.000Z' } as EventRecord;
}

/** The real sqlite adapter, with `getRun` answered for the runs under test. */
function withRuns(storage: Storage, runIds: string[]): Storage {
  const runs = new Map(runIds.map((runId) => [runId, { runId, tenantId: TENANT } as RunRecord]));
  return Object.assign(Object.create(storage) as Storage, { getRun: async (id: string) => runs.get(id) ?? null });
}

describe('ADR 1114 — how a step ended', () => {
  it('reads the resolved action', () => {
    expect(resolutionStateOf({ action: 'accept' })).toBe('approved');
    expect(resolutionStateOf({ action: 'edit-accept' })).toBe('approved');
    expect(resolutionStateOf({ action: 'reject' })).toBe('rejected');
    expect(resolutionStateOf({ action: 'refine' })).toBe('changes-requested');
    expect(resolutionStateOf({ action: 'timeout', reason: 'timeout' })).toBe('timed-out');
    expect(resolutionStateOf({ reason: 'timeout' })).toBe('timed-out');
    expect(resolutionStateOf({ kind: 'clarification' })).toBe('answered');
    expect(resolutionStateOf(null)).toBe('answered');
  });
});

describe('ADR 1114 — retire on the server (sqlite)', () => {
  let storage: Storage;
  beforeAll(async () => { storage = await openStorage('memory://'); });

  it('a decision anywhere retires that request only, read and stamped', async () => {
    const s = withRuns(storage, ['r1']);
    await storage.insertNotification(row('a', { runId: 'r1', interruptId: 'i1' }));
    await storage.insertNotification(row('b', { runId: 'r1', interruptId: 'i2' }));
    await storage.insertNotification(row('c', { runId: 'r1', type: 'workflow.failed' })); // not a request

    expect(await retireRequestsFor(s, event('r1', 'interrupt.resolved', { interruptId: 'i1', kind: 'approval', action: 'reject' }))).toBe(1);
    const a = await storage.getNotification('a');
    expect(a?.status).toBe('read');
    expect(a?.readAt).toBe('2026-11-13T01:00:00.000Z');
    expect(a?.metadata?.resolution).toEqual({ state: 'rejected', at: '2026-11-13T01:00:00.000Z' });
    expect((await storage.getNotification('b'))?.status).toBe('unread');
    expect((await storage.getNotification('c'))?.metadata?.resolution).toBeUndefined();

    // Idempotent: a replayed event finds nothing left to stamp.
    expect(await retireRequestsFor(s, event('r1', 'interrupt.resolved', { interruptId: 'i1', action: 'accept' }))).toBe(0);
    expect((await storage.getNotification('a'))?.metadata?.resolution).toMatchObject({ state: 'rejected' });
  });

  it('the run ending retires what it still had, without overwriting a decision or touching archived rows', async () => {
    const s = withRuns(storage, ['r2']);
    await storage.insertNotification(row('d', { runId: 'r2', interruptId: 'i3', metadata: { kind: 'approval' } }));
    await storage.insertNotification(row('e', { runId: 'r2', interruptId: 'i4', status: 'archived' }));
    await storage.insertNotification(row('f', { runId: 'r2', interruptId: 'i5', status: 'read', metadata: { resolution: { state: 'approved', at: 'x' } } }));

    expect(await retireRequestsFor(s, event('r2', 'run.failed', {}))).toBe(1);
    const d = await storage.getNotification('d');
    expect(d?.metadata).toEqual({ kind: 'approval', resolution: { state: 'run-ended', at: '2026-11-13T01:00:00.000Z' } });
    expect((await storage.getNotification('e'))?.metadata?.resolution).toBeUndefined();
    expect((await storage.getNotification('f'))?.metadata?.resolution).toEqual({ state: 'approved', at: 'x' });
  });

  it('replaying a resolved run, or forking it, changes nothing it already settled', async () => {
    const s = withRuns(storage, ['src', 'fork']);
    await storage.insertNotification(row('h', { runId: 'src', interruptId: 'i7' }));
    const decided = event('src', 'interrupt.resolved', { interruptId: 'i7', kind: 'approval', action: 'accept' });
    const ended = event('src', 'run.completed', {});
    expect(await retireRequestsFor(s, decided)).toBe(1);
    expect(await retireRequestsFor(s, ended)).toBe(0);
    const settled = await storage.getNotification('h');

    // Replay: the same events again, in either order, are no-ops.
    for (const e of [ended, decided, decided, ended]) expect(await retireRequestsFor(s, e)).toBe(0);
    expect(await storage.getNotification('h')).toEqual(settled);

    // Fork: the copied prefix is appended under the FORK's run id, so the source's
    // interrupt id there matches no fork row and the source row is untouched.
    expect(await retireRequestsFor(s, { ...decided, runId: 'fork', payload: { interruptId: 'i7', action: 'reject' } } as EventRecord)).toBe(0);
    expect(await retireRequestsFor(s, { ...ended, runId: 'fork' } as EventRecord)).toBe(0);
    expect(await storage.getNotification('h')).toEqual(settled);
    expect(settled?.metadata?.resolution).toMatchObject({ state: 'approved' });

    // The fork's own request is retired by the fork's own events, keyed by its interrupt id.
    await storage.insertNotification(row('k', { runId: 'fork', interruptId: 'i8' }));
    expect(await retireRequestsFor(s, event('fork', 'interrupt.resolved', { interruptId: 'i7', action: 'reject' }))).toBe(0);
    expect(await retireRequestsFor(s, event('fork', 'interrupt.resolved', { interruptId: 'i8', action: 'reject' }))).toBe(1);
  });

  it('stays inside the tenant and ignores other events', async () => {
    const s = withRuns(storage, ['r3']);
    await storage.insertNotification(row('g', { runId: 'r3', interruptId: 'i6', tenantId: 'org:other' }));
    expect(await retireRequestsFor(s, event('r3', 'run.cancelled', {}))).toBe(0);
    expect(await retireRequestsFor(s, event('r3', 'node.completed', {}))).toBe(0);
    expect(await retireRequestsFor(s, event('missing-run', 'run.failed', {}))).toBe(0);
    expect((await storage.getNotification('g'))?.status).toBe('unread');
  });
});

describe('ADR 1114 — :archive-resolved', () => {
  let BASE: string;
  let server: http.Server;
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  }, 120_000);
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('archives requests that are over, including ones from before the retire step, and nothing else', async () => {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    const tenantId = `org:ar-${Date.now()}`;
    const login = await call('POST', '/host/openwop-app/test/login', { email: `ar-${Date.now()}@acme.test`, tenantId });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const me = (login.body.user as { userId: string }).userId;

    const { getNotificationEmitter } = await import('../src/notifications/emitter.js');
    const emit = (title: string, extra: Partial<NotificationRecord>) => getNotificationEmitter().emit({
      tenantId, recipientUserId: me, type: 'openwop-app.workflow.approval-needed', priority: 'high', title, message: title, ...extra,
    });
    const stamped = await emit('stamped', { runId: 'run-x', interruptId: 'int-x', metadata: { resolution: { state: 'approved', at: 'x' } } });
    const backlog = await emit('backlog', { runId: 'run-y', interruptId: 'int-gone' }); // interrupt row no longer exists
    const notice = await emit('notice', { runId: 'run-z', type: 'workflow.failed' }); // no interrupt: not a request

    const BASE_PATH = '/host/openwop-app/notifications';
    const r = await call('POST', `${BASE_PATH}:archive-resolved`);
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(2);
    const list = await call('GET', `${BASE_PATH}?includeArchived=true`);
    const byId = new Map((list.body.notifications as Array<{ notificationId: string; status: string }>).map((n) => [n.notificationId, n.status]));
    expect(byId.get(stamped.notificationId)).toBe('archived');
    expect(byId.get(backlog.notificationId)).toBe('archived');
    expect(byId.get(notice.notificationId)).toBe('unread');
  });
});
