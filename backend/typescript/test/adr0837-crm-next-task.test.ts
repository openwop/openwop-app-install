/**
 * ADR 0837 D8 (implements ADR 0567 D1) — every deal carries its next open task,
 * and `null` says "no next activity". The rollup is one org task read, ordered
 * dated-first by the calendar date a `dueDate` STARTS with (A10: the field is a
 * free string up to 40 chars), and done tasks never count.
 *
 * Sabotage-witnessed (w4 grade-tests): letting undated beat dated, sorting the
 * date descending, or counting `done` tasks reds the ordering case; dropping
 * `nextTask` from the deal detail / list response reds the route case.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { dueDay, nextTaskByDeal } from '../src/features/crm/nextTask.js';
import type { Task } from '../src/features/crm/entities/tasks.js';

let BASE: string;
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}

const task = (over: Partial<Task>): Task => ({ taskId: 't', tenantId: 'x', orgId: 'o', title: 'T', status: 'open', createdBy: 'u', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', dealId: 'd1', ...over });

describe('ADR 0837 D8 — next-task ordering', () => {
  it('dated before undated, earliest date first, done tasks ignored, junk dates undated', () => {
    const m = nextTaskByDeal([
      task({ taskId: 'undated', createdAt: '2025-01-01T00:00:00Z' }),
      task({ taskId: 'late', dueDate: '2026-05-02' }),
      task({ taskId: 'early-with-time', dueDate: '2026-05-01T17:00' }),
      task({ taskId: 'done', dueDate: '2020-01-01', status: 'done' }),
      task({ taskId: 'junk', dueDate: 'next week' }),
      task({ taskId: 'other-deal', dealId: 'd2', status: 'doing' }),
    ]);
    expect(m.get('d1')).toEqual({ taskId: 'early-with-time', title: 'T', dueDate: '2026-05-01' });
    expect(m.get('d2')?.taskId).toBe('other-deal');
    expect(dueDay('next week')).toBeNull();
  });
});

describe('ADR 0837 D8 — the deals list and detail carry nextTask', () => {
  it('a deal with an open task names it; a deal without one says null; completing it moves the answer', async () => {
    const c = client();
    const tenantId = `org:a0837nt-${Date.now()}`;
    expect((await c.post('/host/openwop-app/test/login', { email: `nt-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    /** POST that must create (201) — a failed write fails HERE, not as a confusing mismatch below. */
    const created = async <K extends string>(path: string, body: unknown, idKey: K): Promise<string> => {
      const r = await c.post(path, body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return (r.body as Record<K, string>)[idKey];
    };
    const orgId = await created('/host/openwop-app/orgs', { name: 'Acme' }, 'orgId');
    const base = `/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}`;
    const busy = await created(`${base}/deals`, { title: 'Busy' }, 'dealId');
    const idle = await created(`${base}/deals`, { title: 'Idle' }, 'dealId');
    const first = await created(`${base}/tasks`, { title: 'Call back', dealId: busy, dueDate: '2026-11-02' }, 'taskId');
    await created(`${base}/tasks`, { title: 'Send proposal', dealId: busy, dueDate: '2026-11-09' }, 'taskId');

    const list = ((await c.get(`${base}/deals`)).body as { deals: Array<{ dealId: string; nextTask: unknown }> }).deals;
    expect(list.find((d) => d.dealId === busy)!.nextTask).toEqual({ taskId: first, title: 'Call back', dueDate: '2026-11-02' });
    expect(list.find((d) => d.dealId === idle)!.nextTask).toBeNull();

    expect((await c.patch(`${base}/tasks/${first}`, { status: 'done' })).status).toBe(200);
    const detail = (await c.get(`${base}/deals/${busy}`)).body as { nextTask: { title: string } | null };
    expect(detail.nextTask?.title).toBe('Send proposal');
    expect(((await c.get(`${base}/deals/${idle}`)).body as { nextTask: unknown }).nextTask).toBeNull();
  });
});
