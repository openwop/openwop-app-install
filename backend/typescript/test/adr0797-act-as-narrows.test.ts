/**
 * ADR 0797 (CE-8) — `x-openwop-act-as` may only NARROW, and only an owner
 * grants, changes or removes ownership.
 *
 * Before: every reader of the header resolved authority for the NAMED member
 * alone, so a Viewer naming the Owner's member id held the Owner's scopes
 * (reproduced over HTTP: a Viewer PATCHed itself to owner and DELETEd the
 * owner). And `host:members:manage` — an admin's scope too — was all it took to
 * add an owner, so the top role was reachable from the rung below.
 *
 * Route-level, real sessions, a SHARED `ws:` workspace (membership-derived,
 * fail-closed), demo mode off.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { createMember, createOrg, getMember, listMembers, type EffectiveAccess } from '../src/host/accessControlService.js';
import { narrowToCaller } from '../src/host/actingAccess.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const H = '/host/openwop-app';
let BASE = ''; let server: http.Server;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_DEMO_MODE']) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0797', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'orgs', 'cdp']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
}, 120_000);
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', connection: 'close', ...(cookie ? { cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { call };
}

interface World { ws: string; owner: Who; admin: Who; viewer: Who }
interface Who { call: ReturnType<typeof client>['call']; memberId: string; subject: string }

/** A shared workspace with one owner, one admin and one viewer, each a real session. */
async function world(tag: string): Promise<World> {
  const ws = `ws:adr0797-${tag}-${Date.now()}`;
  const org = await createOrg({ tenantId: ws, createdBy: 'seed', name: tag, orgId: ws });
  const who = async (role: string): Promise<Who> => {
    const c = client();
    const login = await c.call('POST', `${H}/test/login`, { subject: `oidc:${tag}-${role}-${Date.now()}`, tenantId: ws, email: `${tag}-${role}@a.test` });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const subject = login.body.user.userId as string;
    const m = await createMember({ orgId: org.orgId, tenantId: ws, displayName: role, subject, roles: [role] });
    return { call: c.call, memberId: m.memberId, subject };
  };
  return { ws, owner: await who('owner'), admin: await who('admin'), viewer: await who('viewer') };
}
const members = (ws: string): string => `${H}/orgs/${encodeURIComponent(ws)}/members`;
const actAs = (memberId: string): Record<string, string> => ({ 'x-openwop-act-as': memberId });

describe('ADR 0797 — act-as narrows', () => {
  it('a Viewer naming the Owner gains nothing: it cannot add a member, change itself, or remove the owner', async () => {
    const w = await world('escalate');
    const asOwner = actAs(w.owner.memberId);
    expect((await w.viewer.call('POST', members(w.ws), { displayName: 'Planted', roles: ['admin'] }, asOwner)).status).toBe(403);
    expect((await w.viewer.call('PATCH', `${members(w.ws)}/${w.viewer.memberId}`, { roles: ['owner'] }, asOwner)).status).toBe(403);
    expect((await w.viewer.call('DELETE', `${members(w.ws)}/${w.owner.memberId}`, undefined, asOwner)).status).toBe(403);
    // And nothing changed.
    expect((await getMember(w.viewer.memberId))!.roles).toEqual(['viewer']);
    expect(await getMember(w.owner.memberId)).not.toBeNull();
    expect((await listMembers(w.ws, w.ws)).some((m) => m.displayName === 'Planted')).toBe(false);
  });

  it('CONTROL: without the header the Viewer was already refused, and the Owner is allowed', async () => {
    const w = await world('control');
    expect((await w.viewer.call('POST', members(w.ws), { displayName: 'X', roles: ['viewer'] })).status).toBe(403);
    expect((await w.owner.call('POST', members(w.ws), { displayName: 'Hired', roles: ['viewer'] })).status).toBe(201);
  });

  it('the lens still works: an Owner viewing AS a Viewer is denied what a Viewer is denied', async () => {
    const w = await world('lens');
    const r = await w.owner.call('POST', members(w.ws), { displayName: 'X', roles: ['viewer'] }, actAs(w.viewer.memberId));
    expect(r.status).toBe(403);
    expect(r.body.details?.actingAs).toBe(w.viewer.memberId);
  });

  it('an Admin naming the Owner keeps an Admin’s authority and no more', async () => {
    const w = await world('admin-as-owner');
    const asOwner = actAs(w.owner.memberId);
    // Still an admin: may add an ordinary member…
    expect((await w.admin.call('POST', members(w.ws), { displayName: 'Ok', roles: ['viewer'] }, asOwner)).status).toBe(201);
    // …and still not an owner: the role did not come with the header.
    const grant = await w.admin.call('POST', members(w.ws), { displayName: 'Boss', roles: ['owner'] }, asOwner);
    expect(grant.status).toBe(403);
    expect(grant.body.details?.code).toBe('owner_required');
  });
});

describe('ADR 0797 — only an owner grants, changes or removes ownership', () => {
  it.each([
    ['add an owner', (w: World) => w.admin.call('POST', members(w.ws), { displayName: 'Boss', roles: ['owner'] })],
    ['make itself an owner', (w: World) => w.admin.call('PATCH', `${members(w.ws)}/${w.admin.memberId}`, { roles: ['admin', 'owner'] })],
    ['demote the owner', (w: World) => w.admin.call('PATCH', `${members(w.ws)}/${w.owner.memberId}`, { roles: ['viewer'] })],
    ['re-point the owner row at another subject', (w: World) => w.admin.call('PATCH', `${members(w.ws)}/${w.owner.memberId}`, { subject: w.admin.subject })],
    ['remove the owner', (w: World) => w.admin.call('DELETE', `${members(w.ws)}/${w.owner.memberId}`)],

    ['create an owner group containing itself', (w: World) => w.admin.call('POST', `${H}/orgs/${encodeURIComponent(w.ws)}/groups`, { name: 'g', roles: ['owner'], memberIds: [w.admin.memberId] })],
    ['invite an owner', (w: World) => w.admin.call('POST', `${H}/orgs/${encodeURIComponent(w.ws)}/invites`, { email: 'new-owner@a.test', role: 'owner' })],
  ])('an Admin cannot %s', async (_label, attempt) => {
    const w = await world('grant');
    const r = await attempt(w);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.details?.code).toBe('owner_required');
    expect((await getMember(w.admin.memberId))!.roles).toEqual(['admin']);
    const owner = await getMember(w.owner.memberId);
    expect(owner!.roles).toEqual(['owner']);
    expect(owner!.subject).toBe(w.owner.subject);
  });

  it('an Admin cannot transfer ownership to itself (refused on scope before the owner rule is reached)', async () => {
    const w = await world('transfer');
    const r = await w.admin.call('POST', `${members(w.ws)}/${w.admin.memberId}/transfer-ownership`, {});
    expect(r.status).toBe(403);
    expect((await getMember(w.admin.memberId))!.roles).toEqual(['admin']);
  });

  it('CONTROL: an Admin still manages ordinary members, and an Owner can do all of the above', async () => {
    const w = await world('owner-can');
    const hired = await w.admin.call('POST', members(w.ws), { displayName: 'Hired', roles: ['editor'] });
    expect(hired.status).toBe(201);
    expect((await w.admin.call('PATCH', `${members(w.ws)}/${hired.body.memberId}`, { roles: ['viewer'] })).status).toBe(200);
    expect((await w.owner.call('POST', members(w.ws), { displayName: 'Co-owner', roles: ['owner'] })).status).toBe(201);
    expect((await w.owner.call('POST', `${members(w.ws)}/${w.admin.memberId}/transfer-ownership`, {})).status).toBe(200);
    expect((await getMember(w.admin.memberId))!.roles).toContain('owner');
  });
});

describe('ADR 0797 / KEY-19 — the CDP audit-chain check resolves the CALLER', () => {
  const VERIFY = `${H}/cdp/audit-chain/verify`;

  it('a Viewer is refused (it passed: no act-as header meant `{}`, and `{}` resolves to owner)', async () => {
    const w = await world('cdp');
    expect((await w.viewer.call('GET', VERIFY)).status).toBe(403);
    expect((await w.viewer.call('GET', VERIFY, undefined, actAs(w.owner.memberId))).status).toBe(403);
  });

  it('CONTROL: an Owner and an Admin pass the role check', async () => {
    const w = await world('cdp-ok');
    expect((await w.owner.call('GET', VERIFY)).status).toBe(200);
    expect((await w.admin.call('GET', VERIFY)).status).toBe(200);
  });
});

describe('narrowToCaller', () => {
  const acc = (roles: string[], scopes: string[]): EffectiveAccess => ({ roles, scopes: scopes as EffectiveAccess['scopes'], basis: 'member' });

  it('is an intersection of scopes: more than the caller holds is dropped, less is kept', () => {
    const viewer = acc(['viewer'], ['workspace:read']);
    const owner = acc(['owner'], ['workspace:read', 'workspace:write', 'host:members:manage']);
    expect(narrowToCaller(viewer, owner).scopes).toEqual(['workspace:read']);
    expect(narrowToCaller(owner, viewer).scopes).toEqual(['workspace:read']);
  });

  it('roles: an owner may wear any member’s roles; anyone else only the ones they hold', () => {
    const admin = acc(['admin'], []);
    expect(narrowToCaller(admin, acc(['owner', 'admin'], [])).roles).toEqual(['admin']);
    expect(narrowToCaller(acc(['owner'], []), acc(['viewer'], [])).roles).toEqual(['viewer']);
    expect(narrowToCaller(acc([], []), acc(['owner'], [])).roles).toEqual([]);
  });
});
