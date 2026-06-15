/**
 * Org invitations — ROUTE-level tests (review follow-up). This harness boots the
 * real app and drives the RECONCILED flow over HTTP: an org is created through
 * the `accessControl` surface (the single owner), an invite is issued through
 * the `orgs` feature, a second user accepts it and becomes an accessControl
 * member. It exercises the session binding (ADR 0003), the toggle gate, the
 * delegated `host:members:manage` authorization, and the email-ownership gate —
 * none of which a service-level test can reach.
 *
 * The harness is also what caught the original namespace collision (my orgs
 * routes were shadowed by accessControl) and a real `isAnonymous` bug.
 */

import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const PORT = 18647;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(PORT, res);
  });
  for (const id of ['users', 'orgs']) {
    const def = getToggleDefault(id);
    if (def) await saveConfig({ ...def, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> {
  status: number;
  body: T;
}
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookies = getSetCookies(res.headers);
    for (const sc of setCookies as string[]) {
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam (the email becomes the federated identity's email,
// which drives the invite email-ownership gate).
async function signup(c: ReturnType<typeof client>, email: string): Promise<{ userId: string; email: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

describe('org invitations over HTTP (reconciled with accessControl)', () => {
  it('owner creates an org (accessControl), invites a user, the user accepts and becomes a member', async () => {
    const ownerC = client();
    await signup(ownerC, uniqEmail('owner'));
    // org is created through the accessControl surface (the single owner)
    const org = (await ownerC.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body;
    expect(org.orgId).toBeTruthy();
    expect(org.createdBy).toBeTruthy(); // accessControl shape, not the old feature shape

    const bobEmail = uniqEmail('bob');
    const inv = await ownerC.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(org.orgId)}/invites`, { email: bobEmail, role: 'editor' });
    expect(inv.status).toBe(201);
    expect(inv.body.token).toBeTruthy();

    const bobC = client();
    const bob = await signup(bobC, bobEmail);
    const acc = await bobC.post('/v1/host/openwop-app/orgs/invitations/accept', { token: inv.body.token });
    expect(acc.status, JSON.stringify(acc.body)).toBe(201);
    expect(acc.body.subject).toBe(bob.userId);
    expect(acc.body.roles).toEqual(['editor']);

    // accessControl now lists bob as a member of the org
    const members = (await ownerC.get(`/v1/host/openwop-app/orgs/${encodeURIComponent(org.orgId)}/members`)).body.members;
    expect(members.some((m: any) => m.subject === bob.userId)).toBe(true);
  });

  it('ADR 0006: creating an org seeds an EXPLICIT owner member bound to the creator userId', async () => {
    const ownerC = client();
    const owner = await signup(ownerC, uniqEmail('founder'));
    const org = (await ownerC.post('/v1/host/openwop-app/orgs', { name: 'Founders' })).body;

    const members = (await ownerC.get(`/v1/host/openwop-app/orgs/${encodeURIComponent(org.orgId)}/members`)).body.members;
    const ownerMember = members.find((m: any) => m.subject === owner.userId);
    expect(ownerMember, 'creator should be an explicit member').toBeTruthy();
    expect(ownerMember.roles).toEqual(['owner']); // membership-derived ownership, bound to User.userId — not tenant==principal
  });

  it('email-ownership gate: a different user cannot accept someone else’s invite', async () => {
    const ownerC = client();
    await signup(ownerC, uniqEmail('owner'));
    const org = (await ownerC.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body;
    const inviteEmail = uniqEmail('invitee');
    const inv = await ownerC.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(org.orgId)}/invites`, { email: inviteEmail, role: 'viewer' });

    const strangerC = client();
    await signup(strangerC, uniqEmail('stranger'));
    const acc = await strangerC.post('/v1/host/openwop-app/orgs/invitations/accept', { token: inv.body.token });
    expect(acc.status).toBe(403); // not your email
  });

  it('IDOR: inviting into an org in another tenant is 404 (no existence leak)', async () => {
    const aC = client();
    await signup(aC, uniqEmail('a'));
    const org = (await aC.post('/v1/host/openwop-app/orgs', { name: 'Private' })).body;

    const bC = client();
    await signup(bC, uniqEmail('b')); // different tenant
    const r = await bC.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(org.orgId)}/invites`, { email: uniqEmail('x'), role: 'viewer' });
    expect(r.status).toBe(404);
  });

  it('the orgs invitation surface requires a signed-in session', async () => {
    const anonC = client(); // never signs up → anonymous session
    const r = await anonC.post('/v1/host/openwop-app/orgs/invitations/accept', { token: 'whatever' });
    expect(r.status).toBe(401);
  });
});
