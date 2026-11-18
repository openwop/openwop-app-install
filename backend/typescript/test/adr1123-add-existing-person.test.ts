/**
 * ADR 1123 (#5942) — add a person who already has an account to an org, and
 * link an unbound roster row, with no email round trip.
 *
 * Driven over HTTP in a shared workspace with two client orgs. Pinned:
 *  - D1: the picker lists people from orgs the caller can act in (#5930's
 *    `listCallerOrgs`), never a client-B-only member for a client-A admin, and
 *    never a raw subject. A forged candidate id is refused like an unknown one.
 *  - D2: only a superadmin may look an account up by email. The token it gets
 *    is bound to that caller and that org, and works once.
 *  - D3/D4: the add binds the subject the server resolved; link binds a
 *    sub-org placeholder in place, re-keys a root placeholder, and never
 *    duplicates a person who is already there.
 *  - D5: each add and link is on the security chain, and only the added
 *    person is notified.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { listChain } from '../src/host/auditChainService.js';

let server: http.Server;
let BASE = '';
let n = 0;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { delete process.env.OPENWOP_SUPERADMIN_TENANTS; });

interface Res<T = unknown> { status: number; body: T }
interface Member { memberId: string; subject?: string; roles: string[]; displayName: string }
interface Cand { candidateId: string; displayName: string; email?: string; subject?: unknown }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = res.status === 204 ? '' : await res.text();
    let out: unknown;
    try { out = text ? JSON.parse(text) : undefined; } catch { out = text; }
    return { status: res.status, body: out as T };
  };
  return {
    get: <T = unknown>(p: string) => call<T>('GET', p),
    post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T = unknown>(p: string, b?: unknown) => call<T>('PATCH', p, b),
  };
}
type Client = ReturnType<typeof client>;
interface Person { c: Client; userId: string; tenantId: string; email: string }
async function person(): Promise<Person> {
  const c = client();
  const email = `p1123-${Date.now()}-${n++}@acme.test`;
  const r = await c.post<{ user: { userId: string; tenantId: string } }>('/host/openwop-app/test/login', { email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user.userId, tenantId: r.body.user.tenantId, email };
}
const enc = encodeURIComponent;
const M = (orgId: string) => `/host/openwop-app/orgs/${enc(orgId)}`;

async function agency() {
  const owner = await person();
  const ws = (await owner.c.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: `Agency1123-${n++}` })).body.workspaceId;
  expect((await owner.c.post(`/host/openwop-app/workspaces/${enc(ws)}/switch`)).status).toBe(200);
  const org = async (name: string) => (await owner.c.post<{ orgId: string }>('/host/openwop-app/orgs', { name })).body.orgId;
  const orgA = await org('Client A');
  const orgB = await org('Client B');
  /** Put a person in `orgId` directly (the owner's existing POST lane), and into the workspace if asked. */
  const place = async (p: Person, orgId: string, roles: string[]): Promise<void> => {
    // #5945 — the old lane now refuses a `user:` subject, so seeding uses the auth test seam (same handler).
    const r = await owner.c.post(`/host/openwop-app/test/orgs/${enc(orgId)}/members`, { displayName: p.email, subject: p.userId, email: p.email, roles });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  const enter = async (p: Person) => { expect((await p.c.post(`/host/openwop-app/workspaces/${enc(ws)}/switch`)).status).toBe(200); };
  const members = async (orgId: string) => (await owner.c.get<{ members: Member[] }>(`${M(orgId)}/members`)).body.members;
  return { owner, ws, orgA, orgB, place, enter, members };
}
const candidates = async (c: Client, orgId: string) => {
  const r = await c.get<{ candidates: Cand[] }>(`${M(orgId)}/member-candidates`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.candidates;
};

describe('ADR 1123 — add an existing person to an org', () => {
  it('D1/D3/D5: the owner adds a workspace member to a client org, bound at once, audited, and only they are notified', async () => {
    const a = await agency();
    const p = await person();
    await a.place(p, a.ws, ['viewer']);
    const pool = await candidates(a.owner.c, a.orgA);
    const cand = pool.find((x) => x.email === p.email);
    expect(cand, 'a workspace member is offered').toBeDefined();
    for (const x of pool) expect(x, 'no raw subject on the wire').not.toHaveProperty('subject');

    const add = await a.owner.c.post<Member>(`${M(a.orgA)}/members/add-existing`, { candidateId: cand!.candidateId, roles: ['editor'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.subject).toBe(p.userId);
    expect(add.body.roles).toEqual(['editor']);
    expect((await candidates(a.owner.c, a.orgA)).some((x) => x.email === p.email), 'once added, no longer offered').toBe(false);
    const again = await a.owner.c.post(`${M(a.orgA)}/members/add-existing`, { candidateId: cand!.candidateId, roles: ['viewer'] });
    expect(again.status, 'a second add of the same person').toBe(404);

    const entry = (await listChain(a.ws)).find((e) => e.kind === 'security.org.member-added-direct' && e.payload.lane === 'workspace');
    expect(entry?.payload).toMatchObject({ orgId: a.orgA, memberId: add.body.memberId, subject: p.userId, roles: ['editor'], lane: 'workspace', actor: a.owner.userId });
    expect(JSON.stringify(entry?.payload)).not.toContain(p.email);

    const mine = await storage.listNotifications({ tenantId: a.ws, recipientUserId: p.userId, includeArchived: true, limit: 50 });
    const forA = mine.filter((x) => x.type === 'org.member.added' && (x.metadata as { orgId?: string } | undefined)?.orgId === a.orgA);
    expect(forA).toHaveLength(1);
    expect(forA[0]?.title).toBe('You were added to Client A');
    const owners = await storage.listNotifications({ tenantId: a.ws, recipientUserId: a.owner.userId, includeArchived: true, limit: 50 });
    expect(owners.some((x) => x.type === 'org.member.added'), 'nobody else is told').toBe(false);
  });

  it('D1: a client-A admin is never offered a client-B-only member, and a forged candidate id is refused', async () => {
    const a = await agency();
    const adminA = await person();
    await a.place(adminA, a.ws, ['viewer']);
    await a.place(adminA, a.orgA, ['admin']);
    await a.enter(adminA);
    const bOnly = await person();
    await a.place(bOnly, a.orgB, ['viewer']);
    const pool = await candidates(adminA.c, a.orgA);
    expect(pool.some((x) => x.email === bOnly.email), 'client B\'s people stay out of client A\'s picker').toBe(false);
    const bRow = (await a.members(a.orgB)).find((m) => m.subject === bOnly.userId)!;
    const forged = await adminA.c.post(`${M(a.orgA)}/members/add-existing`, { candidateId: `m:${bRow.memberId}`, roles: ['viewer'] });
    expect(forged.status).toBe(404);
    expect((await a.members(a.orgA)).some((m) => m.subject === bOnly.userId)).toBe(false);
    // The owner, a workspace admin, may add them: the same person is in the owner's pool.
    expect((await candidates(a.owner.c, a.orgA)).some((x) => x.email === bOnly.email)).toBe(true);
  });

  it('D2: only a superadmin may look up by email; the token is single-use and bound to that caller and that org', async () => {
    const a = await agency();
    const target = await person();
    expect((await a.owner.c.post(`${M(a.orgA)}/member-lookup`, { email: target.email })).status, 'an ordinary admin').toBe(403);

    process.env.OPENWOP_SUPERADMIN_TENANTS = a.owner.tenantId;
    const miss = await a.owner.c.post<{ candidate: unknown }>(`${M(a.orgA)}/member-lookup`, { email: `nobody-${n++}@acme.test` });
    expect(miss.status).toBe(200);
    expect(miss.body.candidate).toBeNull();
    const prefix = await a.owner.c.post<{ candidate: unknown }>(`${M(a.orgA)}/member-lookup`, { email: target.email.slice(0, 8) });
    expect(prefix.body.candidate, 'no prefix match').toBeNull();
    const hit = await a.owner.c.post<{ candidate: { lookupToken: string; email?: string } }>(`${M(a.orgA)}/member-lookup`, { email: target.email.toUpperCase() });
    expect(hit.body.candidate?.email).toBe(target.email);
    const token = hit.body.candidate.lookupToken;

    expect((await a.owner.c.post(`${M(a.orgB)}/members/add-existing`, { lookupToken: token, roles: ['viewer'] })).status, 'another org').toBe(404);
    const add = await a.owner.c.post<Member>(`${M(a.orgA)}/members/add-existing`, { lookupToken: token, roles: ['viewer'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.subject).toBe(target.userId);
    expect((await listChain(a.ws)).find((e) => e.kind === 'security.org.member-added-direct' && e.payload.lane === 'host-lookup')?.payload).toMatchObject({ subject: target.userId });
    // Burned: a reuse reads like an unknown token, even into an org it was never used in.
    const hit2 = await a.owner.c.post<{ candidate: { lookupToken: string } }>(`${M(a.orgB)}/member-lookup`, { email: target.email });
    expect((await a.owner.c.post(`${M(a.orgA)}/members/add-existing`, { lookupToken: token, roles: ['viewer'] })).status, 'a second use').toBe(404);

    // Another caller cannot spend a token they did not get, even another superadmin.
    const other = await person();
    await a.place(other, a.ws, ['owner']);
    await a.place(other, a.orgB, ['admin']); // org authority is per org: they may manage B's members
    await a.enter(other);
    process.env.OPENWOP_SUPERADMIN_TENANTS = `${a.owner.tenantId},${other.tenantId}`;
    expect((await other.c.post(`${M(a.orgB)}/members/add-existing`, { lookupToken: hit2.body.candidate.lookupToken, roles: ['viewer'] })).status, 'another caller').toBe(404);
    // Control: the same token still works for the superadmin it was issued to.
    expect((await a.owner.c.post(`${M(a.orgB)}/members/add-existing`, { lookupToken: hit2.body.candidate.lookupToken, roles: ['viewer'] })).status, 'its own issuer').toBe(201);
  });

  it('D4: link binds a sub-org placeholder in place, re-keys a root one, and never duplicates', async () => {
    const a = await agency();
    const p = await person();
    await a.place(p, a.ws, ['viewer']);
    const cand = async (orgId: string) => (await candidates(a.owner.c, orgId)).find((x) => x.email === p.email)!;

    // Sub-org placeholder → bound in place, same row.
    const ph = (await a.owner.c.post<Member>(`${M(a.orgA)}/members`, { displayName: 'Pat (placeholder)', roles: ['editor'] })).body;
    const linked = await a.owner.c.post<Member>(`${M(a.orgA)}/members/${enc(ph.memberId)}/link`, { candidateId: (await cand(a.orgA)).candidateId });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body).toMatchObject({ memberId: ph.memberId, subject: p.userId, roles: ['editor'] });
    expect((await listChain(a.ws)).find((e) => e.kind === 'security.org.member-linked')?.payload).toMatchObject({ orgId: a.orgA, placeholderMemberId: ph.memberId, subject: p.userId });

    // Already a member there → the placeholder goes, the bound row stays as it was.
    const ph2 = (await a.owner.c.post<Member>(`${M(a.orgA)}/members`, { displayName: 'Pat again', roles: ['admin'] })).body;
    const forLink = (await a.owner.c.get<{ candidates: Cand[] }>(`${M(a.orgA)}/member-candidates?for=link`)).body.candidates.find((x) => x.email === p.email);
    expect(forLink, 'a link may name someone already in the org').toBeDefined();
    const merged = await a.owner.c.post<Member>(`${M(a.orgA)}/members/${enc(ph2.memberId)}/link`, { candidateId: forLink!.candidateId });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(merged.body).toMatchObject({ memberId: ph.memberId, roles: ['editor'] });
    const after = await a.members(a.orgA);
    expect(after.filter((m) => m.subject === p.userId), 'still exactly one row for the person').toHaveLength(1);
    expect(after.some((m) => m.memberId === ph2.memberId), 'the placeholder is gone').toBe(false);

    // Root placeholder → a bound row with its roles, and the placeholder is gone.
    const q = await person();
    await a.place(q, a.orgB, ['viewer']);
    const rootPh = (await a.owner.c.post<Member>(`${M(a.ws)}/members`, { displayName: 'Quinn (placeholder)', roles: ['viewer'] })).body;
    const qc = (await candidates(a.owner.c, a.ws)).find((x) => x.email === q.email)!;
    const rootLinked = await a.owner.c.post<Member>(`${M(a.ws)}/members/${enc(rootPh.memberId)}/link`, { candidateId: qc.candidateId });
    expect(rootLinked.status, JSON.stringify(rootLinked.body)).toBe(200);
    expect(rootLinked.body.subject).toBe(q.userId);
    const root = await a.members(a.ws);
    expect(root.some((m) => m.memberId === rootPh.memberId), 'the root placeholder is gone').toBe(false);
    expect(root.filter((m) => m.subject === q.userId)).toHaveLength(1);
  });

  it('interim (#5945): a person bound through the old free-text lane is audited and told, a service subject is not', async () => {
    const a = await agency();
    const p = await person();
    await a.place(p, a.orgA, ['viewer']); // POST …/members {subject: userId}
    const chain = async () => (await listChain(a.ws)).filter((e) => e.payload.lane === 'legacy-subject');
    const added = (await chain()).find((e) => e.kind === 'security.org.member-added-direct');
    expect(added?.payload).toMatchObject({ orgId: a.orgA, subject: p.userId, roles: ['viewer'], actor: a.owner.userId });
    const told = await storage.listNotifications({ tenantId: a.ws, recipientUserId: p.userId, includeArchived: true, limit: 50 });
    expect(told.filter((x) => x.type === 'org.member.added')).toHaveLength(1);

    const svc = await a.owner.c.post<Member>(`${M(a.orgA)}/members`, { displayName: 'CI bot', subject: 'oidc:svc-1123', roles: ['viewer'] });
    expect(svc.status).toBe(201);
    expect((await chain()).some((e) => e.payload.subject === 'oidc:svc-1123'), 'a service subject is no person to notify').toBe(false);

    // PATCH binding a sub-org placeholder to a person: recorded as a link. Since #5945 only an exempt
    // caller reaches this lane (a superadmin, the wildcard, or the auth test seam used here); the
    // refusal itself is pinned in adr1123-legacy-subject-refusal.
    const q = await person();
    const ph = (await a.owner.c.post<Member>(`${M(a.orgB)}/members`, { displayName: 'Quinn', roles: ['viewer'] })).body;
    const res = await a.owner.c.patch(`/host/openwop-app/test/orgs/${enc(a.orgB)}/members/${enc(ph.memberId)}`, { subject: q.userId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await chain()).find((e) => e.kind === 'security.org.member-linked')?.payload).toMatchObject({ orgId: a.orgB, memberId: ph.memberId, placeholderMemberId: ph.memberId, subject: q.userId });
  });
});
