/**
 * ADR 0133 Phase 3 — task-deck route (route + RBAC harness). Boots the real app and
 * drives: toggle-off 404, the ownership filter (a caller sees their own runs + the
 * direct children of those), and IDOR isolation (another user's runs are not shown).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let BASE: string;
let server: http.Server;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  storage = __hostExtStorage()!; // the app's run + host-ext storage instance
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
}
async function enable(id: string): Promise<void> { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }

const TENANT = 'td-tenant';
function seedRun(r: Partial<RunRecord> & { runId: string; status: RunRecord['status']; metadata: Record<string, unknown> }): Promise<void> {
  return storage.insertRun({
    workflowId: 'wf', tenantId: TENANT, inputs: {}, configurable: {},
    createdAt: '2026-06-24T00:00:00.000Z', updatedAt: '2026-06-24T00:00:00.000Z', ...r,
  } as RunRecord);
}

describe('task-deck route (ADR 0133 P3)', () => {
  it('serves without a toggle (always-on) — empty deck for a fresh user', async () => {
    const c = client();
    await c('POST', '/v1/host/openwop-app/test/login', { email: 'td-off@test.dev' });
    const r = await c('GET', '/v1/host/openwop-app/tasks');
    expect(r.status).toBe(200);
    expect(r.body.deck.buckets.running).toEqual([]);
  });

  it('shows the caller’s own runs + direct children; hides another user’s runs', async () => {
    await enable('users'); await enable('task-deck');
    const c = client();
    const login = await c('POST', '/v1/host/openwop-app/test/login', { email: 'td-owner@test.dev', tenantId: TENANT });
    const me = login.body.user?.userId;
    expect(me).toBeTruthy();

    await seedRun({ runId: 'mine-1', status: 'running', metadata: { actingUserId: me } });
    await seedRun({ runId: 'child-1', status: 'running', parentRunId: 'mine-1', metadata: { actingUserId: 'service', parentRunId: 'mine-1', delegatedBy: 'agent:a1' } });
    await seedRun({ runId: 'theirs-1', status: 'running', metadata: { actingUserId: 'someone-else' } });

    const r = await c('GET', '/v1/host/openwop-app/tasks');
    expect(r.status).toBe(200);
    const running = r.body.deck.buckets.running.map((x: any) => x.runId);
    expect(running).toContain('mine-1');     // owned
    expect(running).not.toContain('theirs-1'); // IDOR: another user's run hidden
    const mineCard = r.body.deck.buckets.running.find((x: any) => x.runId === 'mine-1');
    expect(mineCard.children.map((x: any) => x.runId)).toEqual(['child-1']); // child nested
  });

  it('anon (no session) ⇒ empty deck, not a tenant dump', async () => {
    await enable('users'); await enable('task-deck');
    const c = client(); // no login
    const r = await c('GET', '/v1/host/openwop-app/tasks');
    // unauthenticated may 401 at the auth layer OR return an empty deck; never another user's data
    if (r.status === 200) {
      const b = r.body.deck.buckets;
      expect([...b.running, ...b.pending, ...b.completed]).toEqual([]);
    } else {
      expect([401, 403, 404]).toContain(r.status);
    }
  });
});
