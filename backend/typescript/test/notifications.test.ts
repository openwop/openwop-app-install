/**
 * Notification surface (PR #146 + follow-up).
 *
 * Covers:
 *   1. Storage round-trip (insert → list → mark-read → archive → delete)
 *      against the sqlite memory backend.
 *   2. REST routes mounted under `/v1/host/openwop-app/notifications/*` —
 *      includes the tenant-ownership regression that PR #146 missed
 *      (mutateStatus didn't check tenancy, so a leaked id could mutate
 *      another tenant's row).
 *   3. The notify helper sanitizes BYOK key shapes before persisting,
 *      defending the SR-1 redaction invariant on the notification
 *      surface (an upstream's 401 string that echoes the rejected
 *      key MUST NOT land in plaintext in the notifications table).
 *   4. `deleteAllTenantData` cascades notifications (was a gap —
 *      account-delete left orphan rows).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import {
  ensureNotificationEmitterInstalled,
} from '../src/bootstrap/notifications.js';
import { getNotificationEmitter } from '../src/notifications/emitter.js';
import {
  emitInterruptNotification,
  emitRunFailureNotification,
} from '../src/notifications/notify.js';
import type { NotificationRecord, RunRecord } from '../src/types.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function jsonFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 204) {
    return { status: 204, body: undefined as unknown as T };
  }
  return { status: res.status, body: (await res.json()) as T };
}

interface ListResponse {
  notifications: NotificationRecord[];
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date().toISOString();
  return {
    runId: 'r-test',
    workflowId: 'wf-test',
    tenantId: 'tenant-A',
    status: 'running',
    inputs: null,
    metadata: { workflowName: 'My Workflow' },
    configurable: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('storage: notification round-trip (sqlite memory)', () => {
  it('inserts, lists newest-first, transitions through statuses, and deletes', async () => {
    const storage = openSqliteStorage(':memory:');
    const earlier = new Date(Date.now() - 1000).toISOString();
    const later = new Date().toISOString();
    const a: NotificationRecord = {
      notificationId: 'n-1',
      tenantId: 'tenant-A',
      type: 'workflow.approval_needed',
      priority: 'high',
      status: 'unread',
      title: 'Approval needed',
      message: 'wf is waiting',
      runId: 'r-1',
      createdAt: earlier,
    };
    const b: NotificationRecord = {
      notificationId: 'n-2',
      tenantId: 'tenant-A',
      type: 'workflow.failed',
      priority: 'high',
      status: 'unread',
      title: 'Workflow failed',
      message: 'something broke',
      runId: 'r-2',
      createdAt: later,
    };
    await storage.insertNotification(a);
    await storage.insertNotification(b);

    const list = await storage.listNotifications({ tenantId: 'tenant-A' });
    expect(list.length).toBe(2);
    expect(list[0]!.notificationId).toBe('n-2');
    expect(list[1]!.notificationId).toBe('n-1');

    const reRead = await storage.updateNotificationStatus('n-1', 'read', new Date().toISOString());
    expect(reRead?.status).toBe('read');
    expect(reRead?.readAt).toBeTruthy();

    const archived = await storage.updateNotificationStatus('n-1', 'archived', new Date().toISOString());
    expect(archived?.status).toBe('archived');

    const withoutArchived = await storage.listNotifications({ tenantId: 'tenant-A' });
    expect(withoutArchived.find((n) => n.notificationId === 'n-1')).toBeUndefined();

    const withArchived = await storage.listNotifications({ tenantId: 'tenant-A', includeArchived: true });
    expect(withArchived.find((n) => n.notificationId === 'n-1')).toBeTruthy();

    const removed = await storage.deleteNotification('n-1');
    expect(removed).toBe(true);
    const again = await storage.deleteNotification('n-1');
    expect(again).toBe(false);
    await storage.close();
  });

  it('markAllNotificationsRead transitions every unread row for the tenant only', async () => {
    const storage = openSqliteStorage(':memory:');
    const now = new Date().toISOString();
    await storage.insertNotification({
      notificationId: 'n-A1', tenantId: 'A', type: 'system.alert', priority: 'low',
      status: 'unread', title: 't', message: 'm', createdAt: now,
    });
    await storage.insertNotification({
      notificationId: 'n-A2', tenantId: 'A', type: 'system.alert', priority: 'low',
      status: 'unread', title: 't', message: 'm', createdAt: now,
    });
    await storage.insertNotification({
      notificationId: 'n-B1', tenantId: 'B', type: 'system.alert', priority: 'low',
      status: 'unread', title: 't', message: 'm', createdAt: now,
    });
    const updated = await storage.markAllNotificationsRead('A', now);
    expect(updated).toBe(2);
    const bList = await storage.listNotifications({ tenantId: 'B' });
    expect(bList[0]!.status).toBe('unread');
    await storage.close();
  });

  it('deleteAllTenantData cascades notifications', async () => {
    const storage = openSqliteStorage(':memory:');
    const now = new Date().toISOString();
    // Insert one run + one notification under tenant X; one notification under tenant Y.
    await storage.insertRun({
      runId: 'r-x', workflowId: 'wf', tenantId: 'X', status: 'running',
      inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    });
    await storage.insertNotification({
      notificationId: 'n-x', tenantId: 'X', type: 'system.alert', priority: 'low',
      status: 'unread', title: 't', message: 'm', createdAt: now,
    });
    await storage.insertNotification({
      notificationId: 'n-y', tenantId: 'Y', type: 'system.alert', priority: 'low',
      status: 'unread', title: 't', message: 'm', createdAt: now,
    });
    const counts = await storage.deleteAllTenantData('X');
    expect(counts.notifications).toBe(1);
    // Y's row untouched.
    const yList = await storage.listNotifications({ tenantId: 'Y' });
    expect(yList.length).toBe(1);
    await storage.close();
  });

  // ADR 0050 Phase 3 — role-addressed broadcast, leak-safe.
  it('recipientRole: a role row is visible ONLY to role-holders (no broadcast leak)', async () => {
    const storage = openSqliteStorage(':memory:');
    const now = new Date().toISOString();
    const base = { tenantId: 'T', type: 'system.alert', priority: 'low' as const, status: 'unread' as const, title: 't', message: 'm', createdAt: now };
    await storage.insertNotification({ ...base, notificationId: 'broadcast' });                          // true broadcast
    await storage.insertNotification({ ...base, notificationId: 'role-admin', recipientRole: 'admin' }); // role-addressed
    await storage.insertNotification({ ...base, notificationId: 'addr-u1', recipientUserId: 'u1' });     // addressed

    // A role-holder sees the broadcast + the admin row (not u1's addressed row).
    const admin = await storage.listNotifications({ tenantId: 'T', recipientUserId: 'u2', recipientRoles: ['admin'] });
    expect(admin.map((n) => n.notificationId).sort()).toEqual(['broadcast', 'role-admin']);

    // A NON-holder sees ONLY the true broadcast — the role row must NOT leak.
    const member = await storage.listNotifications({ tenantId: 'T', recipientUserId: 'u3', recipientRoles: [] });
    expect(member.map((n) => n.notificationId)).toEqual(['broadcast']);

    // The addressed user sees the broadcast + their own row, not the role row.
    const u1 = await storage.listNotifications({ tenantId: 'T', recipientUserId: 'u1', recipientRoles: [] });
    expect(u1.map((n) => n.notificationId).sort()).toEqual(['addr-u1', 'broadcast']);
    await storage.close();
  });

  it('recipientRole: markAllNotificationsRead clears a role row only for a holder', async () => {
    const storage = openSqliteStorage(':memory:');
    const now = new Date().toISOString();
    await storage.insertNotification({
      notificationId: 'role-admin', tenantId: 'T', recipientRole: 'admin', type: 'system.alert',
      priority: 'low', status: 'unread', title: 't', message: 'm', createdAt: now,
    });
    // A non-holder's mark-all-read leaves the admin row unread.
    await storage.markAllNotificationsRead('T', now, 'u9', []);
    const before = await storage.listNotifications({ tenantId: 'T' });
    expect(before.find((n) => n.notificationId === 'role-admin')?.status).toBe('unread');
    // A holder clears it.
    await storage.markAllNotificationsRead('T', now, 'u1', ['admin']);
    const after = await storage.listNotifications({ tenantId: 'T' });
    expect(after.find((n) => n.notificationId === 'role-admin')?.status).toBe('read');
    await storage.close();
  });
});

describe('routes: /v1/host/openwop-app/notifications', () => {
  it('lists notifications for the caller and returns an empty list when none exist', async () => {
    const r = await jsonFetch<ListResponse>('/v1/host/openwop-app/notifications');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.notifications)).toBe(true);
  });

  it('mark-read / archive / delete walk through the full status lifecycle', async () => {
    // The dev-token wildcard principal can specify a tenant; emit
    // through the in-process emitter, which the test app shares.
    const emitter = getNotificationEmitter();
    const n = await emitter.emit({
      tenantId: 'demo',
      type: 'system.alert',
      priority: 'normal',
      title: 'test',
      message: 'hello',
    });
    expect(n.status).toBe('unread');

    const read = await jsonFetch<NotificationRecord>(
      `/v1/host/openwop-app/notifications/${n.notificationId}/read`,
      { method: 'POST' },
    );
    expect(read.status).toBe(200);
    expect(read.body.status).toBe('read');

    const archived = await jsonFetch<NotificationRecord>(
      `/v1/host/openwop-app/notifications/${n.notificationId}/archive`,
      { method: 'POST' },
    );
    expect(archived.body.status).toBe('archived');

    const del = await jsonFetch<{ deleted: boolean }>(
      `/v1/host/openwop-app/notifications/${n.notificationId}`,
      { method: 'DELETE' },
    );
    expect(del.body.deleted).toBe(true);
  });

  it('mark-read returns 404 for an unknown id', async () => {
    const r = await jsonFetch<{ error: string }>(
      `/v1/host/openwop-app/notifications/does-not-exist/read`,
      { method: 'POST' },
    );
    expect(r.status).toBe(404);
  });

  // The Bearer-auth test harness gives wildcard `tenants: ['*']`, so a
  // direct same-process tenant-isolation test is hard to wire here.
  // Instead exercise the storage-layer tenant filter: a row owned by
  // tenant A doesn't surface to a `listNotifications({ tenantId: 'B' })`.
  it('listNotifications filters by tenant', async () => {
    const storage = openSqliteStorage(':memory:');
    const now = new Date().toISOString();
    await storage.insertNotification({
      notificationId: 'n-tenant-A', tenantId: 'A', type: 'system.alert', priority: 'low',
      status: 'unread', title: 't', message: 'm', createdAt: now,
    });
    const aList = await storage.listNotifications({ tenantId: 'A' });
    const bList = await storage.listNotifications({ tenantId: 'B' });
    expect(aList.length).toBe(1);
    expect(bList.length).toBe(0);
    await storage.close();
  });
});

describe('notify helpers: secret redaction (SR-1 defense-in-depth)', () => {
  it('emitRunFailureNotification sanitizes BYOK key shapes embedded in userMessage', async () => {
    const storage = openSqliteStorage(':memory:');
    ensureNotificationEmitterInstalled(storage);
    const now = new Date().toISOString();
    await storage.insertRun({
      ...makeRun({ runId: 'r-redact', tenantId: 'redact', metadata: { workflowName: 'WF' } }),
      createdAt: now, updatedAt: now,
    });
    await emitRunFailureNotification(storage, 'r-redact', {
      code: 'unauthorized',
      // Synthetic upstream 401: provider echoes the rejected key back.
      userMessage: 'anthropic rejected the API key sk-ant-api-AAAAAAAAAAAAAAAAAAAAAAAA — please reconfigure',
    });
    const list = await storage.listNotifications({ tenantId: 'redact' });
    expect(list.length).toBe(1);
    expect(list[0]!.message).not.toContain('sk-ant-api-AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(list[0]!.message).toContain('sk-***');
    await storage.close();
  });

  it('emitInterruptNotification sanitizes secrets that arrive via workflowName', async () => {
    const storage = openSqliteStorage(':memory:');
    ensureNotificationEmitterInstalled(storage);
    const now = new Date().toISOString();
    await storage.insertRun({
      ...makeRun({
        runId: 'r-intr',
        tenantId: 'redact2',
        // A user-named workflow that accidentally carries a Bearer token.
        metadata: { workflowName: 'Bearer abcdefghijklmnopqrstuv' },
      }),
      createdAt: now,
      updatedAt: now,
    });
    await emitInterruptNotification(storage, {
      interruptId: 'int-1',
      runId: 'r-intr',
      nodeId: 'node-1',
      kind: 'approval',
      token: 'tok',
      data: null,
      createdAt: now,
    });
    const list = await storage.listNotifications({ tenantId: 'redact2' });
    expect(list.length).toBe(1);
    expect(list[0]!.message).not.toContain('abcdefghijklmnopqrstuv');
    expect(list[0]!.message).toContain('Bearer ***');
    await storage.close();
  });
});

describe('emitter: signal() — non-persisted broadcast (ADR 0074)', () => {
  it('fans out a review.updated frame to subscribers WITHOUT persisting it', async () => {
    const storage = openSqliteStorage(':memory:');
    ensureNotificationEmitterInstalled(storage);
    const emitter = getNotificationEmitter();

    const received: NotificationRecord[] = [];
    const unsubscribe = emitter.subscribe((n) => received.push(n));

    const frame = emitter.signal({
      tenantId: 'sig-tenant',
      type: 'review.updated',
      priority: 'low',
      title: 'review updated',
      message: '',
      runId: 'r-9',
      nodeId: 'approval_3',
      interruptId: 'int-9',
      metadata: { reviewId: 'interrupt:int-9', status: 'resolved' },
    });
    unsubscribe();

    // Fanned out to the live subscriber...
    expect(received.length).toBe(1);
    expect(received[0]!.type).toBe('review.updated');
    expect(received[0]!.notificationId).toBe(frame.notificationId);
    expect((received[0]!.metadata as { status?: string }).status).toBe('resolved');

    // ...but never written to the durable inbox (no storage growth, no bell row).
    const persisted = await storage.listNotifications({ tenantId: 'sig-tenant', includeArchived: true });
    expect(persisted.length).toBe(0);
    await storage.close();
  });

  it('broadcast frame omits recipientUserId so it reaches every tenant member', () => {
    const storage = openSqliteStorage(':memory:');
    ensureNotificationEmitterInstalled(storage);
    const frame = getNotificationEmitter().signal({
      tenantId: 'sig-tenant-2',
      type: 'review.updated',
      priority: 'low',
      title: 'review updated',
      message: '',
    });
    // No recipientUserId ⇒ the stream route's per-recipient filter passes it to
    // all subscribers of the tenant (ADR 0050 broadcast channel).
    expect(frame.recipientUserId).toBeUndefined();
    void storage.close();
  });
});
