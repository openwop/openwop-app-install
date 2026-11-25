/**
 * ADR 1099 (decided 2026-11-23) — an explicit `audience` on a grant.
 *
 * A builder and a client can hold the same `view`/`comment` grant on one project
 * and still must not see the same rows. A grant may carry one label from those
 * features register for its kind. The host stores it at mint, passes it to the
 * projection with the viewer, and lists the labels for the firm's picker. Upstream
 * gives labels no meaning.
 *
 *  - a registered label is stored on the grant and reaches the projection's viewer;
 *  - an unregistered label is a 400 naming the field; a kind with none refuses any;
 *  - no label: the viewer has no `audience` (the kind shows its least-privileged view);
 *  - the grantable list offers the kind's labels;
 *  - a label is lower-case and short, and two features cannot claim the same one.
 *
 * Sabotage notes (each reds a case below):
 *  - dropping `audience` from `viewerOf` reds "reaches the projection";
 *  - skipping `parseAudience` reds "an unregistered label is a 400";
 *  - omitting `audiences` from `listGrantableResources` reds "the grantable list".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getUser } from '../src/features/users/usersService.js';
import {
  registerGrantAudience, registerGrantResourceKind, grantAudiencesFor, __resetGrantAudiencesForTests,
  type CollaboratorGrant, type GrantViewer,
} from '../src/host/externalCollaborators.js';
import { getOrg } from '../src/host/accessControlService.js';
import { PROJECTS_CLIENT_PORTAL_TOGGLE } from '../src/features/projects/clientPortal.js';

let BASE: string;
let server: http.Server;
/** The viewer the probe kind's projection was last called with. */
let lastViewer: GrantViewer | undefined;
/** The audience `mayGrantTo` was last asked about. */
let lastRecipientAudience: string | undefined | null = null;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const portal = getToggleDefault(PROJECTS_CLIENT_PORTAL_TOGGLE);
  if (portal) await saveConfig({ ...portal, status: 'on' }, 'test');
  __resetGrantAudiencesForTests();
  // A kind whose projection records who asked, so the test can see the viewer.
  registerGrantResourceKind('aud-probe', {
    featureId: null,
    actions: ['view'],
    surface: { enabledFor: async () => true, async orgOpen(tenantId, orgId) { return (await getOrg(orgId))?.tenantId === tenantId; } },
    exists: async () => true,
    async project(_t, _o, id, viewer) { lastViewer = viewer; return { title: id, body: { kind: 'aud-probe' } }; },
    list: async () => [{ id: 'thing-1', title: 'Thing one' }],
    // A vendor (a builder firm) may never be minted the client's view.
    async mayGrantTo(_t, _o, _id, recipient) {
      lastRecipientAudience = recipient.audience;
      return !(recipient.kind === 'vendor' && recipient.audience === 'client');
    },
  });
  registerGrantAudience('aud-probe', 'builder', 'test-adopter');
  registerGrantAudience('aud-probe', 'client', 'test-adopter');
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

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
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}
type Client = ReturnType<typeof client>;
const C = (orgId: string): string => `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/collaborators`;
const G = (grantId: string): string => `/host/openwop-app/collab/grants/${grantId}`;

let n = 0;
async function firm() {
  const tenantId = `ws:t-1099aud-${n++}`;
  const admin = client();
  const a = await admin.post('/host/openwop-app/test/login', { email: `owner-aud-${n}@studio.test`, tenantId });
  expect(a.status, a.raw).toBe(201);
  const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Riverside renovation' });
  expect(org.status, org.raw).toBe(201);
  const p = await admin.post<{ id: string }>('/host/openwop-app/projects', { orgId: org.body.orgId, name: 'Kitchen and bath' });
  expect(p.status, p.raw).toBe(201);
  return { orgId: org.body.orgId, projectId: p.body.id, admin };
}
async function invited(f: { orgId: string; admin: Client }) {
  const person = client();
  const v = await person.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `builder-aud-${n++}@outside.test` });
  const email = (await getUser(v.body.user.userId))?.email ?? '';
  const inv = await f.admin.post<{ collaborator: { collaboratorId: string }; invite: { token: string } }>(C(f.orgId), { kind: 'vendor', email, displayName: 'Oak Builders' });
  expect(inv.status, inv.raw).toBe(201);
  expect((await person.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token })).status).toBe(200);
  return { person, collaboratorId: inv.body.collaborator.collaboratorId };
}
const mint = (f: { orgId: string; admin: Client }, collaboratorId: string, resource: { kind: string; id: string }, extra: Record<string, unknown> = {}) =>
  f.admin.post<{ grant: CollaboratorGrant; message?: string; details?: { field?: string } }>(`${C(f.orgId)}/${collaboratorId}/grants`, { resource, actions: ['view'], expiresInDays: 30, ...extra });

describe('ADR 1099 — an explicit audience on a grant', () => {
  it('a registered label is stored on the grant and reaches the projection with the viewer', async () => {
    const f = await firm();
    const c = await invited(f);
    const g = await mint(f, c.collaboratorId, { kind: 'aud-probe', id: 'thing-1' }, { audience: 'builder' });
    expect(g.status, g.raw).toBe(201);
    expect(g.body.grant.audience).toBe('builder');
    lastViewer = undefined;
    expect((await c.person.get(G(g.body.grant.grantId))).status).toBe(200);
    expect(lastViewer).toEqual({ collaboratorId: c.collaboratorId, grantId: g.body.grant.grantId, audience: 'builder' });
  });

  it('no label: the viewer carries no audience', async () => {
    const f = await firm();
    const c = await invited(f);
    const g = await mint(f, c.collaboratorId, { kind: 'aud-probe', id: 'thing-1' });
    expect(g.status, g.raw).toBe(201);
    expect(g.body.grant.audience).toBeUndefined();
    lastViewer = undefined;
    expect((await c.person.get(G(g.body.grant.grantId))).status).toBe(200);
    expect(lastViewer).toEqual({ collaboratorId: c.collaboratorId, grantId: g.body.grant.grantId });
  });

  it('an unregistered label is a 400 naming the field; a kind with no labels refuses any', async () => {
    const f = await firm();
    const c = await invited(f);
    const bad = await mint(f, c.collaboratorId, { kind: 'aud-probe', id: 'thing-1' }, { audience: 'architect' });
    expect(bad.status, bad.raw).toBe(400);
    expect(bad.raw).toContain('audience');
    const none = await mint(f, c.collaboratorId, { kind: 'project', id: f.projectId }, { audience: 'builder' });
    expect(none.status, none.raw).toBe(400);
    expect(none.raw).toContain('takes no');
  });

  it('mayGrantTo sees the audience at mint and at renew, so a kind can refuse a label for a recipient', async () => {
    const f = await firm();
    const c = await invited(f); // a vendor
    const refused = await mint(f, c.collaboratorId, { kind: 'aud-probe', id: 'thing-1' }, { audience: 'client' });
    expect(refused.status, refused.raw).toBe(400);
    expect(refused.body.details).toMatchObject({ reason: 'grant_recipient_refused' });
    expect(lastRecipientAudience).toBe('client');
    const ok = await mint(f, c.collaboratorId, { kind: 'aud-probe', id: 'thing-1' }, { audience: 'builder' });
    expect(ok.status, ok.raw).toBe(201);
    lastRecipientAudience = null;
    const renew = await f.admin.post(`${C(f.orgId)}/${c.collaboratorId}/grants/${ok.body.grant.grantId}/extend`, { expiresInDays: 60 });
    expect(renew.status, renew.raw).toBe(200);
    expect(lastRecipientAudience).toBe('builder');
  });

  it('the grantable list offers each kind\'s labels', async () => {
    const f = await firm();
    const r = await f.admin.get<{ kinds: Array<{ kind: string; audiences?: string[] }> }>(`${C(f.orgId)}/grantable`);
    expect(r.status, r.raw).toBe(200);
    expect(r.body.kinds.find((k) => k.kind === 'aud-probe')?.audiences).toEqual(['builder', 'client']);
    // A kind with no labels keeps its pre-ADR-1099 shape: no `audiences` key at all.
    const project = r.body.kinds.find((k) => k.kind === 'project');
    expect(project).toBeDefined();
    expect(project && 'audiences' in project).toBe(false);
  });

  it('labels are lower-case and short, and a label belongs to one feature', () => {
    expect(() => registerGrantAudience('aud-probe', 'Builder', 'test-adopter')).toThrow(/lower-case/);
    expect(() => registerGrantAudience('aud-probe', 'builder', 'another-feature')).toThrow(/already registered/);
    registerGrantAudience('aud-probe', 'builder', 'test-adopter'); // the same feature again is fine
    expect(grantAudiencesFor('aud-probe')).toEqual(['builder', 'client']);
  });
});
