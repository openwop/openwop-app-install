/**
 * ADR 1099 D10 (P4) — sections a feature adds to a collaborator's view of a
 * granted project (the portal page), read through the one per-use check.
 *
 *  - the list and every read pass the grant check and the kind's switch; anything
 *    else is the uniform 404, so section ids never reach someone without a grant;
 *  - the reader's scope comes from the grant only: query fields are ignored;
 *  - another kind's section is never served on a project grant;
 *  - a least view is closed to `{ available, message, code? }`;
 *  - the output is capped at 64 KB (502 `section_too_large`);
 *  - a reader's typed 4xx passes its sentence; a raw fault is a generic 502;
 *  - reads are bounded per grant (429);
 *  - `enabledFor` off (or faulting) hides a section from the list and 404s a read;
 *  - the grant view says whether the portal chat is available.
 *
 * Sabotage-witnessed (2026-11-26, one combined run, each sabotage aimed at a
 * different test; exactly these seven went red and the other four stayed green):
 * the list route without the grant check ("a stranger and a revoked grant", "the
 * switch off"); the scope spread with `req.query` ("scope from the grant only");
 * the section looked up across kinds ("another kind's section"); the least view
 * returned unclosed ("closed"); the byte cap removed ("over 64 KB"); the read
 * route without `sectionBudget` ("bounded per grant").
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getUser } from '../src/features/users/usersService.js';
import type { CollaboratorGrant } from '../src/host/externalCollaborators.js';
import { PROJECTS_CLIENT_PORTAL_TOGGLE } from '../src/features/projects/clientPortal.js';
import type { ClientToolScope } from '../src/host/clientProjectTools.js';
import { registerGrantViewSection, SECTION_MAX_BYTES } from '../src/host/grantViewSections.js';
import { OpenwopError } from '../src/types.js';

let BASE: string;
let server: http.Server;
const seen: ClientToolScope[] = [];
let mode: 'ok' | 'least' | 'big' | 'refuse' | 'fault' = 'ok';
let extraOn: boolean | 'throw' = true;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  await portalSwitch('on');
  registerGrantViewSection({
    kind: 'project', id: 'test-adopter.due', featureId: 'test-adopter', order: 20,
    async read(scope) {
      seen.push(scope);
      if (mode === 'least') return { available: false, message: 'Nothing is due from you.', code: 'test.least_view', rows: ['a builder row'] };
      if (mode === 'big') return { available: true, rows: 'x'.repeat(SECTION_MAX_BYTES) };
      if (mode === 'refuse') throw new OpenwopError('conflict', 'This project is archived.', 409, { code: 'test.archived', secret: 'internal' });
      if (mode === 'fault') throw new Error('ECONNREFUSED 10.0.0.7:5432');
      return { available: true, due: [{ decision: 'Tile' }] };
    },
  });
  registerGrantViewSection({ kind: 'project', id: 'test-adopter.dates', featureId: 'test-adopter', order: 10, async read() { return { available: true, milestones: [] }; } });
  registerGrantViewSection({
    kind: 'project', id: 'test-adopter.extra', featureId: 'test-adopter', order: 30,
    enabledFor: () => { if (extraOn === 'throw') throw new Error('toggle store down'); return extraOn; },
    async read() { return { available: true, extra: true }; },
  });
  registerGrantViewSection({ kind: 'campaign', id: 'test-adopter.campaign-only', featureId: 'test-adopter', order: 1, async read() { return { available: true, leaked: true }; } });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function portalSwitch(status: 'on' | 'off'): Promise<void> {
  const portal = getToggleDefault(PROJECTS_CLIENT_PORTAL_TOGGLE);
  if (portal) await saveConfig({ ...portal, status }, 'test');
}

interface Res<T> { status: number; body: T; raw: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1] ?? cookie; }
    const raw = res.status === 204 ? '' : await res.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed as T, raw };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b), del: <T>(p: string) => call<T>('DELETE', p) };
}
type Client = ReturnType<typeof client>;
const C = (orgId: string): string => `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/collaborators`;
const G = (g: string): string => `/host/openwop-app/collab/grants/${g}`;
const LIST = (g: string): string => `${G(g)}/sections`;
const READ = (g: string, id: string): string => `${G(g)}/sections/${encodeURIComponent(id)}`;

let n = 0;
async function firm() {
  const tenantId = `ws:t-1099p4-${n++}`;
  const admin = client();
  expect((await admin.post('/host/openwop-app/test/login', { email: `owner-p4-${n}@studio.test`, tenantId })).status).toBe(201);
  const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Riverside renovation' });
  const p = await admin.post<{ id: string }>('/host/openwop-app/projects', { orgId: org.body.orgId, name: 'Kitchen and bath' });
  return { tenantId, orgId: org.body.orgId, projectId: p.body.id, admin };
}
async function collaborator(f: { orgId: string; projectId: string; admin: Client }) {
  const person = client();
  const v = await person.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `p4-${n++}@outside.test` });
  const email = (await getUser(v.body.user.userId))?.email ?? '';
  const inv = await f.admin.post<{ collaborator: { collaboratorId: string }; invite: { token: string } }>(C(f.orgId), { kind: 'client-stakeholder', email, displayName: 'The Garcias' });
  expect((await person.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token })).status).toBe(200);
  const collaboratorId = inv.body.collaborator.collaboratorId;
  const g = await f.admin.post<{ grant: CollaboratorGrant }>(`${C(f.orgId)}/${collaboratorId}/grants`, { resource: { kind: 'project', id: f.projectId }, actions: ['view'], expiresInDays: 30 });
  expect(g.status, g.raw).toBe(201);
  return { person, collaboratorId, grantId: g.body.grant.grantId };
}

describe('ADR 1099 D10 — portal sections', () => {
  it('lists the project sections in order, ids only, and never another kind\'s', async () => {
    const f = await firm();
    const c = await collaborator(f);
    const r = await c.person.get<{ sections: Array<{ id: string; order: number }> }>(LIST(c.grantId));
    expect(r.status, r.raw).toBe(200);
    expect(r.body.sections).toEqual([{ id: 'test-adopter.dates', order: 10 }, { id: 'test-adopter.due', order: 20 }, { id: 'test-adopter.extra', order: 30 }]);
  });

  it('a section switched off for the tenant (or whose check faults) is absent from the list and 404 on a read', async () => {
    const f = await firm();
    const c = await collaborator(f);
    try {
      for (const off of [false, 'throw'] as const) {
        extraOn = off;
        const r = await c.person.get<{ sections: Array<{ id: string }> }>(LIST(c.grantId));
        expect(r.body.sections.map((x) => x.id)).toEqual(['test-adopter.dates', 'test-adopter.due']);
        expect((await c.person.get(READ(c.grantId, 'test-adopter.extra'))).status).toBe(404);
      }
    } finally { extraOn = true; }
    expect((await c.person.get(READ(c.grantId, 'test-adopter.extra'))).status).toBe(200);
  });

  it('reads a section on the scope from the grant only; query fields are ignored', async () => {
    mode = 'ok';
    const f = await firm();
    const c = await collaborator(f);
    seen.length = 0;
    const r = await c.person.get<{ data: unknown }>(`${READ(c.grantId, 'test-adopter.due')}?tenantId=ws:other&resourceId=p-other&orgId=o-other&audience=client&grantId=g-other`);
    expect(r.status, r.raw).toBe(200);
    expect(r.body.data).toEqual({ available: true, due: [{ decision: 'Tile' }] });
    expect(seen).toEqual([{ tenantId: f.tenantId, orgId: f.orgId, resourceKind: 'project', resourceId: f.projectId, grantId: c.grantId, collaboratorId: c.collaboratorId }]);
  });

  it('a stranger and a revoked grant get the uniform 404 on the list and on a read', async () => {
    mode = 'ok';
    const f = await firm();
    const c = await collaborator(f);
    const stranger = client();
    await stranger.post('/host/openwop-app/test/login', { email: `stranger-${n++}@outside.test` });
    for (const p of [LIST(c.grantId), READ(c.grantId, 'test-adopter.due')]) expect((await stranger.get(p)).status).toBe(404);
    expect((await f.admin.del(`${C(f.orgId)}/${c.collaboratorId}/grants/${c.grantId}`)).status).toBeLessThan(300);
    seen.length = 0;
    for (const p of [LIST(c.grantId), READ(c.grantId, 'test-adopter.due')]) expect((await c.person.get(p)).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('the switch off refuses the list and every read', async () => {
    const f = await firm();
    const c = await collaborator(f);
    await portalSwitch('off');
    try {
      expect((await c.person.get(LIST(c.grantId))).status).toBe(404);
      expect((await c.person.get(READ(c.grantId, 'test-adopter.due'))).status).toBe(404);
    } finally { await portalSwitch('on'); }
  });

  it('another kind\'s section, or an unknown id, is 404 on a project grant', async () => {
    const f = await firm();
    const c = await collaborator(f);
    expect((await c.person.get(READ(c.grantId, 'test-adopter.campaign-only'))).status).toBe(404);
    expect((await c.person.get(READ(c.grantId, 'test-adopter.nope'))).status).toBe(404);
  });

  it('a least view is closed: nothing the reader put beside it is sent', async () => {
    mode = 'least';
    const f = await firm();
    const c = await collaborator(f);
    const r = await c.person.get<{ data: unknown }>(READ(c.grantId, 'test-adopter.due'));
    expect(r.body.data).toEqual({ available: false, message: 'Nothing is due from you.', code: 'test.least_view' });
    expect(r.raw).not.toContain('a builder row');
  });

  it('over 64 KB is 502 section_too_large', async () => {
    mode = 'big';
    const f = await firm();
    const c = await collaborator(f);
    const r = await c.person.get<{ error: { details?: { reason?: string } } }>(READ(c.grantId, 'test-adopter.due'));
    expect(r.status).toBe(502);
    expect(r.raw).toContain('section_too_large');
    expect(r.raw.length).toBeLessThan(2000);
  });

  it('a reader\'s typed 4xx passes its sentence only; a raw fault is a generic 502', async () => {
    const f = await firm();
    const c = await collaborator(f);
    mode = 'refuse';
    const refused = await c.person.get(READ(c.grantId, 'test-adopter.due'));
    expect(refused.status).toBe(409);
    expect(refused.raw).toContain('This project is archived.');
    expect(refused.raw).toContain('test.archived');
    expect(refused.raw).not.toContain('internal');
    mode = 'fault';
    const fault = await c.person.get(READ(c.grantId, 'test-adopter.due'));
    expect(fault.status).toBe(502);
    expect(fault.raw).toContain('section_unavailable');
    expect(fault.raw).not.toContain('ECONNREFUSED');
  });

  it('reads are bounded per grant: the 121st in a minute is 429, another grant is unaffected', async () => {
    mode = 'ok';
    const f = await firm();
    const c = await collaborator(f);
    const other = await collaborator(f);
    for (let i = 0; i < 120; i += 1) expect((await c.person.get(READ(c.grantId, 'test-adopter.dates'))).status).toBe(200);
    expect((await c.person.get(READ(c.grantId, 'test-adopter.dates'))).status).toBe(429);
    expect((await c.person.get(LIST(c.grantId))).status).toBe(429);
    expect((await other.person.get(READ(other.grantId, 'test-adopter.dates'))).status).toBe(200);
  }, 60_000);

  it('the grant view says the portal chat is available', async () => {
    const f = await firm();
    const c = await collaborator(f);
    const on = await c.person.get<{ chat: boolean }>(G(c.grantId));
    expect(on.body.chat).toBe(true);
  });
});

describe('ADR 1099 D10 — registration', () => {
  const read = async (): Promise<unknown> => ({});
  it('refuses an id without the feature prefix, a duplicate, and a bad order', () => {
    expect(() => registerGrantViewSection({ kind: 'project', id: 'due', featureId: 'acme', order: 1, read })).toThrow(/acme\.<name>/);
    expect(() => registerGrantViewSection({ kind: 'project', id: 'other.due', featureId: 'acme', order: 1, read })).toThrow(/acme\.<name>/);
    expect(() => registerGrantViewSection({ kind: 'project', id: 'test-adopter.due', featureId: 'test-adopter', order: 1, read })).toThrow(/already registered/);
    expect(() => registerGrantViewSection({ kind: 'project', id: 'acme.x', featureId: 'acme', order: Number.NaN, read })).toThrow(/finite order/);
  });
});
