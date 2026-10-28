/**
 * ADR 0133 Phase 3 — task-deck route (route + RBAC harness). Boots the real app and
 * drives: toggle-off 404, the ownership filter (a caller sees their own runs + the
 * direct children of those), and IDOR isolation (another user's runs are not shown).
 *
 * TWINS (protected, kept): case 2's ownership filter and child nesting are also
 * covered by adr0902-task-deck-authority.test.ts ("CONTROL: in a shared workspace
 * another member's run is never mine", "CONTROL: a host-dispatched child … nests
 * under its parent"); the same sabotage reddened both files (probes 8fw3g3-tdr-owner
 * and -tdr-owner-cover). This file is the ADR 0133 P3 route harness that came first.
 *
 * CEILING (case 3): an anonymous caller is given its OWN fresh tenant and an
 * `anon:` principal, so it never reaches the route's `!viewer` branch, and its
 * tenant has no runs to leak. The case pins the exact answer (200, a fully empty
 * deck), so it catches a crash or a shape change, never a cross-tenant leak (that
 * is case 2's claim). Probe 8fw3g3-tdr-anon on the `!viewer` branch was vacuous
 * for exactly this reason.
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
import type { TaskDeck, TaskBucket } from '../src/features/task-deck/taskDeckProjection.js';

let BASE: string;
let server: http.Server;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  storage = __hostExtStorage()!; // the app's run + host-ext storage instance
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface DeckBody { deck: TaskDeck }
interface LoginBody { user?: { userId?: string } }
function client() {
  let cookie = '';
  return async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    // The one JSON boundary: each call site names the body's type (product types or a local interface).
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T };
  };
}
async function enable(id: string): Promise<void> { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }

const TENANT = 'td-tenant';
function seedRun(r: Partial<RunRecord> & { runId: string; status: RunRecord['status']; metadata: Record<string, unknown> }): Promise<void> {
  return storage.insertRun({
    workflowId: 'wf', tenantId: TENANT, inputs: {}, configurable: {},
    createdAt: '2026-06-24T00:00:00.000Z', updatedAt: '2026-06-24T00:00:00.000Z', ...r,
  });
}

describe('task-deck route (ADR 0133 P3)', () => {
  it('serves without a toggle (always-on) — empty deck for a fresh user', async () => {
    const c = client();
    await c<LoginBody>('POST', '/host/openwop-app/test/login', { email: 'td-off@test.dev' });
    const r = await c<DeckBody>('GET', '/host/openwop-app/tasks');
    expect(r.status).toBe(200);
    expect(r.body.deck.buckets.running).toEqual([]);
  });

  it('shows the caller’s own runs + direct children; hides another user’s runs', async () => {
    await enable('users'); await enable('task-deck');
    const c = client();
    const login = await c<LoginBody>('POST', '/host/openwop-app/test/login', { email: 'td-owner@test.dev', tenantId: TENANT });
    const me = login.body.user?.userId;
    expect(me).toBeTruthy();

    await seedRun({ runId: 'mine-1', status: 'running', metadata: { actingUserId: me } });
    await seedRun({ runId: 'child-1', status: 'running', parentRunId: 'mine-1', metadata: { actingUserId: 'service', parentRunId: 'mine-1', delegatedBy: 'agent:a1' } });
    await seedRun({ runId: 'theirs-1', status: 'running', metadata: { actingUserId: 'someone-else' } });

    const r = await c<DeckBody>('GET', '/host/openwop-app/tasks');
    expect(r.status).toBe(200);
    const running = r.body.deck.buckets.running.map((x) => x.runId);
    expect(running).toContain('mine-1');     // owned
    expect(running).not.toContain('theirs-1'); // IDOR: another user's run hidden
    const mineCard = r.body.deck.buckets.running.find((x) => x.runId === 'mine-1');
    expect(mineCard?.children.map((x) => x.runId)).toEqual(['child-1']); // child nested
  });

  it('anon (no session) ⇒ empty deck, not a tenant dump', async () => {
    await enable('users'); await enable('task-deck');
    const c = client(); // no login
    const r = await c<DeckBody>('GET', '/host/openwop-app/tasks');
    expect(r.status).toBe(200); // measured: the anon principal passes runs:read in its own tenant
    const buckets: TaskBucket[] = ['pending', 'running', 'blocked', 'delegated', 'completed', 'failed'];
    for (const b of buckets) expect(r.body.deck.buckets[b], b).toEqual([]);
    expect(r.body.deck.truncated).toBe(false);
  });
});
