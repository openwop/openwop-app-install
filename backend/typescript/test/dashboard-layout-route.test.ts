/**
 * Dashboard layout routes (ADR 0375 Phase 1) — the authorization + validation
 * contract, observable only through the HTTP boundary:
 *  - always-on (§ Correction 2026-07-16: graduated off its toggle — the
 *    signed-in home can't be toggle-hidden; routes serve unconditionally);
 *  - a resolvable acting subject is required (fail-closed);
 *  - self-scoped: caller B never sees caller A's layout (the key is
 *    session-derived, never request input — IDOR-safe by construction);
 *  - GET-absent ⇒ { layout: null } (FE derives defaults, zero-write first paint);
 *  - PUT validates tile shape (bad size/order/enabled, dup ids, oversize) and
 *    round-trips through GET.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { putLayout, putNote, getLayout, getNote } from '../src/features/dashboard/dashboardService.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let server: http.Server;
let BASE = '';
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), put: (p: string, b?: unknown) => call('PUT', p, b), post: (p: string, b?: unknown) => call('POST', p, b) };
}
async function signup(c: ReturnType<typeof client>): Promise<void> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `dash-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
const LAYOUT = '/v1/host/openwop-app/dashboard/layout';

describe('ADR 0375 — dashboard layout routes', () => {
  it('an un-logged-in caller is self-scoped to its own anon session (not denied, not shared)', async () => {
    // The auth middleware always populates a principal (anon sessions get their
    // own subject), so `requireSubject` never 401s via HTTP — it is defensive
    // code for a genuinely principal-less internal call. The honest behavior:
    // an anon caller gets ITS OWN (empty) row, keyed by its anon subject.
    const anon = client();
    const r = await anon.get(LAYOUT);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.layout).toBeNull();
    // And its writes are its own, invisible to a fresh session.
    await anon.put(LAYOUT, { tiles: [{ id: 'active-runs', order: 0, size: 'full', enabled: true }] });
    const other = client();
    expect((await other.get(LAYOUT)).body.layout).toBeNull();
  });

  it('GET before any PUT ⇒ { layout: null } (FE derives defaults)', async () => {
    const c = client(); await signup(c);
    const r = await c.get(LAYOUT);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.layout).toBeNull();
  });

  it('PUT then GET round-trips the caller\'s own layout', async () => {
    const c = client(); await signup(c);
    const tiles = [{ id: 'active-runs', order: 0, size: 'full', enabled: true }, { id: 'my-todos', order: 10, size: 'half', enabled: false }];
    const put = await c.put(LAYOUT, { tiles });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.layout.tiles).toEqual(tiles);
    const got = await c.get(LAYOUT);
    expect(got.body.layout.tiles).toEqual(tiles);
    expect(got.body.layout.updatedAt).toBeTruthy();
  });

  it('is self-scoped: caller B never sees caller A\'s layout', async () => {
    const a = client(); await signup(a);
    await a.put(LAYOUT, { tiles: [{ id: 'crm-pipeline', order: 0, size: 'full', enabled: true }] });
    const b = client(); await signup(b);
    const bGet = await b.get(LAYOUT);
    expect(bGet.status).toBe(200);
    expect(bGet.body.layout).toBeNull(); // B has their own (empty) row, not A's
  });

  it('note: GET-absent ⇒ { note: null }; PUT round-trips; self-scoped; cap enforced', async () => {
    const a = client(); await signup(a);
    const NOTE = '/v1/host/openwop-app/dashboard/note';
    expect((await a.get(NOTE)).body.note).toBeNull();
    const put = await a.put(NOTE, { text: 'call the vendor tomorrow' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.note.text).toBe('call the vendor tomorrow');
    expect((await a.get(NOTE)).body.note.text).toBe('call the vendor tomorrow');
    // self-scoped — a different caller has their own (empty) note
    const b = client(); await signup(b);
    expect((await b.get(NOTE)).body.note).toBeNull();
    // validation: non-string + over-cap rejected
    expect((await a.put(NOTE, { text: 42 })).status).toBe(400);
    expect((await a.put(NOTE, { text: 'x'.repeat(4001) })).status).toBe(400);
    // empty string is a legitimate "clear"
    expect((await a.put(NOTE, { text: '' })).status).toBe(200);
    expect((await a.get(NOTE)).body.note.text).toBe('');
  });

  it('GDPR: eraseSubject reaches BOTH dashboard rows (layout + note) via the registered eraser', async () => {
    // The seam's DSAR subjectKey = the opaque userId (the comments-eraser
    // precedent) — the same subject the dashboard keys on.
    const tenant = 'erasure-tenant';
    const who = 'user-being-erased';
    await putLayout(tenant, who, [{ id: 'active-runs', order: 0, size: 'half', enabled: true }]);
    await putNote(tenant, who, 'my private note');
    const other = 'unrelated-user';
    await putNote(tenant, other, 'keep me');
    await eraseSubject(tenant, who);
    expect(await getLayout(tenant, who)).toBeNull();
    expect(await getNote(tenant, who)).toBeNull();
    expect((await getNote(tenant, other))?.text).toBe('keep me'); // scoped: others untouched
  });

  it('rejects malformed tiles', async () => {
    const c = client(); await signup(c);
    const bad: unknown[] = [
      { tiles: 'not-an-array' },
      { tiles: [{ id: '', order: 0, size: 'full', enabled: true }] },
      { tiles: [{ id: 'x', order: 'nope', size: 'full', enabled: true }] },
      { tiles: [{ id: 'x', order: 0, size: 'jumbo', enabled: true }] },
      { tiles: [{ id: 'x', order: 0, size: 'full', enabled: 'yes' }] },
      { tiles: [{ id: 'dup', order: 0, size: 'full', enabled: true }, { id: 'dup', order: 1, size: 'half', enabled: true }] },
      { tiles: Array.from({ length: 101 }, (_, i) => ({ id: `t${i}`, order: i, size: 'half', enabled: true })) },
    ];
    for (const body of bad) {
      const r = await c.put(LAYOUT, body);
      expect(r.status, `expected 400 for ${JSON.stringify(body).slice(0, 60)}`).toBe(400);
    }
  });
});
