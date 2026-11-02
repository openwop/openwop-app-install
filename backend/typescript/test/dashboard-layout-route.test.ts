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
 *
 * TST-CUB-2. The caller-B legs sign A and B into the SAME tenant: with a tenant
 * per user the `${tenantId}:${subject}` key would hide a broken SUBJECT half (the
 * round-1 probe that fixed the subject stayed green on exactly that). Red when the
 * route keys on a fixed subject, when the tile/note caps or the duplicate-id check
 * move, when `enabled` stops round-tripping, or when the eraser skips a row.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { putLayout, putNote, getLayout, getNote, type DashboardLayout, type DashboardNote } from '../src/features/dashboard/dashboardService.js';
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

interface Res<T> { status: number; body: T }
interface LayoutBody { layout: DashboardLayout | null }
interface NoteBody { note: DashboardNote | null }
interface ErrorBody { error: string; message: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), put: <T>(p: string, b?: unknown) => call<T>('PUT', p, b), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}
/** Sign in; with `tenantId`, join that (shared) tenant as a distinct subject. */
async function signup(c: ReturnType<typeof client>, tenantId?: string): Promise<void> {
  const r = await c.post('/host/openwop-app/test/login', { email: `dash-${Date.now()}-${n++}@acme.test`, ...(tenantId ? { tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
const LAYOUT = '/host/openwop-app/dashboard/layout';

describe('ADR 0375 — dashboard layout routes', () => {
  it('an un-logged-in caller is self-scoped to its own anon session (not denied, not shared)', async () => {
    // The auth middleware always populates a principal (anon sessions get their
    // own subject), so `requireSubject` never 401s via HTTP — it is defensive
    // code for a genuinely principal-less internal call. The honest behavior:
    // an anon caller is SERVED (200, not 401) with ITS OWN row. Two anon sessions
    // are also two tenants, so this case shows "not denied, not shared between
    // sessions"; the subject half of the key is the same-tenant case below.
    const anon = client();
    const r = await anon.get<LayoutBody>(LAYOUT);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.layout).toBeNull();
    // And its writes are its own, invisible to a fresh session.
    const put = await anon.put<LayoutBody>(LAYOUT, { tiles: [{ id: 'active-runs', order: 0, size: 'full', enabled: true }] });
    expect(put.status).toBe(200);
    expect((await anon.get<LayoutBody>(LAYOUT)).body.layout?.tiles.map((t) => t.id)).toEqual(['active-runs']);
    const other = client();
    expect((await other.get<LayoutBody>(LAYOUT)).body.layout).toBeNull();
  });

  it('GET before any PUT ⇒ { layout: null } (FE derives defaults)', async () => {
    const c = client(); await signup(c);
    const r = await c.get<LayoutBody>(LAYOUT);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.layout).toBeNull();
  });

  it('PUT then GET round-trips the caller\'s own layout', async () => {
    const c = client(); await signup(c);
    const tiles = [{ id: 'active-runs', order: 0, size: 'full', enabled: true }, { id: 'my-todos', order: 10, size: 'half', enabled: false }];
    const put = await c.put<LayoutBody>(LAYOUT, { tiles });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.layout?.tiles).toEqual(tiles);
    const got = await c.get<LayoutBody>(LAYOUT);
    expect(got.body.layout?.tiles).toEqual(tiles);
    expect(got.body.layout?.updatedAt).toBeTruthy();
  });

  it('is self-scoped: caller B never sees caller A\'s layout', async () => {
    // A and B share ONE tenant, so only the subject half of the key separates them.
    const shared = `tnt-dash-${Date.now()}-${n++}`;
    const a = client(); await signup(a, shared);
    const b = client(); await signup(b, shared);
    expect((await a.put<LayoutBody>(LAYOUT, { tiles: [{ id: 'crm-pipeline', order: 0, size: 'full', enabled: true }] })).status).toBe(200);
    const bGet = await b.get<LayoutBody>(LAYOUT);
    expect(bGet.status).toBe(200);
    expect(bGet.body.layout).toBeNull(); // B has their own (empty) row, not A's
    // B's write is B's; A's row is untouched (owner control)
    await b.put(LAYOUT, { tiles: [{ id: 'my-todos', order: 0, size: 'half', enabled: true }] });
    expect((await a.get<LayoutBody>(LAYOUT)).body.layout?.tiles.map((t) => t.id)).toEqual(['crm-pipeline']);
    expect((await b.get<LayoutBody>(LAYOUT)).body.layout?.tiles.map((t) => t.id)).toEqual(['my-todos']);
  });

  it('note: GET-absent ⇒ { note: null }; PUT round-trips; self-scoped; cap enforced', async () => {
    const shared = `tnt-note-${Date.now()}-${n++}`;
    const a = client(); await signup(a, shared);
    const NOTE = '/host/openwop-app/dashboard/note';
    expect((await a.get<NoteBody>(NOTE)).body.note).toBeNull();
    const put = await a.put<NoteBody>(NOTE, { text: 'call the vendor tomorrow' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.note?.text).toBe('call the vendor tomorrow');
    expect((await a.get<NoteBody>(NOTE)).body.note?.text).toBe('call the vendor tomorrow');
    // self-scoped — a different caller in the SAME tenant has their own (empty) note
    const b = client(); await signup(b, shared);
    expect((await b.get<NoteBody>(NOTE)).body.note).toBeNull();
    // validation: non-string + over-cap rejected; exactly the cap is accepted
    const nonString = await a.put<ErrorBody>(NOTE, { text: 42 });
    expect(nonString.status).toBe(400);
    expect(nonString.body.message).toMatch(/`text` is required/);
    const over = await a.put<ErrorBody>(NOTE, { text: 'x'.repeat(4001) });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/Note too long/);
    expect((await a.put(NOTE, { text: 'x'.repeat(4000) })).status).toBe(200);
    // empty string is a legitimate "clear"
    expect((await a.put(NOTE, { text: '' })).status).toBe(200);
    expect((await a.get<NoteBody>(NOTE)).body.note?.text).toBe('');
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
    // Each body is valid except the one property under test; the message pins WHICH check refused it.
    const bad: Array<[unknown, RegExp]> = [
      [{ tiles: 'not-an-array' }, /MUST be an array/],
      [{ tiles: [{ id: '', order: 0, size: 'full', enabled: true }] }, /id must be a non-empty string/],
      [{ tiles: [{ id: 'x', order: 'nope', size: 'full', enabled: true }] }, /order must be a finite number/],
      [{ tiles: [{ id: 'x', order: 0, size: 'jumbo', enabled: true }] }, /size must be/],
      [{ tiles: [{ id: 'x', order: 0, size: 'full', enabled: 'yes' }] }, /enabled must be a boolean/],
      [{ tiles: [{ id: 'dup', order: 0, size: 'full', enabled: true }, { id: 'dup', order: 1, size: 'half', enabled: true }] }, /Duplicate tile id/],
      [{ tiles: Array.from({ length: 101 }, (_, i) => ({ id: `t${i}`, order: i, size: 'half', enabled: true })) }, /Too many tiles/],
    ];
    for (const [body, message] of bad) {
      const r = await c.put<ErrorBody>(LAYOUT, body);
      expect(r.status, `expected 400 for ${JSON.stringify(body).slice(0, 60)}`).toBe(400);
      expect(r.body.error).toBe('validation_error');
      expect(r.body.message).toMatch(message);
    }
    // boundary control: exactly MAX_TILES (100) is accepted
    const full = await c.put(LAYOUT, { tiles: Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, order: i, size: 'half', enabled: true })) });
    expect(full.status).toBe(200);
  });
});
