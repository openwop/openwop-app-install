/**
 * Campaign ops — the house client: "Set up your own business" (the house-client
 * ADR, amending ADR 0921 D1). A firm registers its own business as a client
 * without the workspace root ever becoming one.
 *
 * Each case builds its OWN agency workspace, because the invariant under test is
 * one house client per workspace; a shared workspace would make the cases depend
 * on order. Real HTTP, real access control, memory storage.
 *
 * What turns each case red:
 *  - the house client is the root, or is not flagged `house` (creation case);
 *  - a repeat creates a second org instead of returning the first (idempotent);
 *  - the pointer claim is dropped, so two parallel first clicks make two orgs
 *    (concurrency case: org count and house count both pinned to one);
 *  - `requireAgencyAdmin` is skipped on POST /house (operator case);
 *  - the root guard in `createClient` is dropped, or its message reverts;
 *  - a personal-workspace owner is refused (solo-firm case);
 *  - the brand kit is copied without being asked for, copied twice, linked
 *    instead of copied, or the root's editor list rides along (brand cases).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createWorkspace, listOrgs } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createBrand, listBrands } from '../src/features/brand/brandService.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import type { ClientAccount } from '../src/features/campaign-ops/types.js';

let BASE: string;
let server: http.Server;
let seq = 0;

interface ErrorBody { error?: string; message?: string; details?: { reason?: string } }
interface HouseBody { client: ClientAccount; created: boolean; brandKit?: { copied: boolean; brandId?: string; reason?: string } }
interface Res<T> { status: number; body: T; raw: string }

async function call<T = ErrorBody>(cookie: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}/host/openwop-app/campaign-ops${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  // The JSON wire boundary: each call site names the body shape it expects.
  return { status: res.status, body: parsed as T, raw };
}

function cookie(tenantId: string, userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}

/** A fresh shared agency workspace: an admin on the root, and an operator with
 *  a root `viewer` row (enough to enter, not to add clients — ADR 0921 D2). */
async function agency(name: string): Promise<{ tenantId: string; admin: string; operator: string }> {
  const n = ++seq;
  const ws = await createWorkspace({ name, ownerSubject: `oidc:house-owner-${n}` });
  const admin = await upsertFromPrincipal({ tenantId: ws.tenantId, principalId: `oidc:house-admin-${n}`, source: 'oidc' });
  const operator = await upsertFromPrincipal({ tenantId: ws.tenantId, principalId: `oidc:house-operator-${n}`, source: 'oidc' });
  await createMember({ tenantId: ws.tenantId, orgId: ws.tenantId, subject: admin.userId, displayName: 'Admin', roles: ['admin'] });
  await createMember({ tenantId: ws.tenantId, orgId: ws.tenantId, subject: operator.userId, displayName: 'Operator', roles: ['viewer'] });
  return {
    tenantId: ws.tenantId,
    admin: cookie(ws.tenantId, admin.userId, `ws:home-house-admin-${n}`),
    operator: cookie(ws.tenantId, operator.userId, `ws:home-house-operator-${n}`),
  };
}

const houses = (cs: ClientAccount[]): ClientAccount[] => cs.filter((c) => c.house === true);

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('campaign-ops');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('the house client — "Set up your own business"', () => {
  it('creates a non-root org named after the workspace, flagged house, and lists it first', async () => {
    const a = await agency('Harbor & Pine Studio');
    // An earlier client whose name sorts before the house client's.
    const aardvark = await call<{ client: ClientAccount }>(a.admin, 'POST', '/clients', { name: 'Aardvark Bakery' });
    expect(aardvark.status, aardvark.raw).toBe(201);

    const r = await call<HouseBody>(a.admin, 'POST', '/house', {});
    expect(r.status, r.raw).toBe(201);
    expect(r.body.created).toBe(true);
    expect(r.body.client).toMatchObject({ tenantId: a.tenantId, displayName: 'Harbor & Pine Studio', house: true, mode: 'preview', approvalPolicy: 'agency', status: 'active' });
    expect(r.body.client.orgId, 'the house client is a real sub-org, never the root').not.toBe(a.tenantId);
    expect((await listOrgs(a.tenantId)).some((o) => o.orgId === r.body.client.orgId)).toBe(true);
    expect(r.body.brandKit, 'no brand copy unless asked').toBeUndefined();

    const list = await call<{ clients: ClientAccount[] }>(a.admin, 'GET', '/clients');
    expect(list.body.clients.map((c) => c.orgId)).toEqual([r.body.client.orgId, aardvark.body.client.orgId]);
    // An ordinary client is never flagged house.
    expect(list.body.clients[1]?.house).toBeUndefined();
  });

  it('a caller-supplied name wins over the workspace name', async () => {
    const a = await agency('Northwind Agency');
    const r = await call<HouseBody>(a.admin, 'POST', '/house', { name: 'Northwind Coffee' });
    expect(r.status, r.raw).toBe(201);
    expect(r.body.client.displayName).toBe('Northwind Coffee');
  });

  it('a repeat returns the existing house client instead of creating another', async () => {
    const a = await agency('Repeat Studio');
    const first = await call<HouseBody>(a.admin, 'POST', '/house', {});
    expect(first.status, first.raw).toBe(201);
    const orgsAfterFirst = (await listOrgs(a.tenantId)).length;
    const again = await call<HouseBody>(a.admin, 'POST', '/house', { name: 'A different name' });
    expect(again.status, again.raw).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.client.orgId).toBe(first.body.client.orgId);
    expect(again.body.client.displayName, 'a repeat does not rename').toBe('Repeat Studio');
    expect((await listOrgs(a.tenantId)).length).toBe(orgsAfterFirst);
  });

  it('two parallel first clicks converge on ONE house org', async () => {
    const a = await agency('Parallel Clicks Co');
    const orgsBefore = (await listOrgs(a.tenantId)).length;
    const [x, y] = await Promise.all([
      call<HouseBody>(a.admin, 'POST', '/house', {}),
      call<HouseBody>(a.admin, 'POST', '/house', {}),
    ]);
    expect([x.status, y.status].sort(), `${x.raw} ${y.raw}`).toEqual([200, 201]);
    expect(x.body.client.orgId).toBe(y.body.client.orgId);
    expect([x.body.created, y.body.created].filter(Boolean)).toHaveLength(1);
    expect((await listOrgs(a.tenantId)).length, 'exactly one new org').toBe(orgsBefore + 1);
    const list = await call<{ clients: ClientAccount[] }>(a.admin, 'GET', '/clients');
    expect(houses(list.body.clients).map((c) => c.orgId)).toEqual([x.body.client.orgId]);
  });

  it('only an agency admin can set it up', async () => {
    const a = await agency('Gatekept Agency');
    const orgsBefore = (await listOrgs(a.tenantId)).length;
    const op = await call(a.operator, 'POST', '/house', {});
    expect(op.status, op.raw).toBe(403);
    expect(op.body.error).toBe('forbidden_scope');
    expect((await listOrgs(a.tenantId)).length, 'a refused call creates no org').toBe(orgsBefore);
    // The refusal claimed nothing: the admin still gets a fresh house client.
    const ad = await call<HouseBody>(a.admin, 'POST', '/house', {});
    expect(ad.status, ad.raw).toBe(201);
    expect(ad.body.created).toBe(true);
  });

  it('the workspace root is still refused as a client, with the new copy', async () => {
    const a = await agency('Root Guard Agency');
    const r = await call(a.admin, 'POST', '/clients', { name: 'Ourselves', orgId: a.tenantId });
    expect(r.status, r.raw).toBe(400);
    expect(r.body.details?.reason).toBe('root_org_not_client');
    expect(r.body.message).toBe("Your workspace can't be a client itself. Set up your own business as a client instead.");
    // The service refuses it too, whatever the route does.
    await expect(createClient({ tenantId: a.tenantId, orgId: a.tenantId, name: 'Ourselves', createdBy: 'seed' }))
      .rejects.toMatchObject({ httpStatus: 400, details: { reason: 'root_org_not_client' } });
  });

  it('the owner of a personal workspace (a one-person firm) can set it up and add clients', async () => {
    const personal = `user:house-solo-${randomBytes(4).toString('hex')}`;
    const solo = await upsertFromPrincipal({ tenantId: personal, principalId: `oidc:house-solo-${seq}`, source: 'oidc' });
    const c = cookie(personal, solo.userId, personal);
    const r = await call<HouseBody>(c, 'POST', '/house', { name: 'Solo Founder Studio' });
    expect(r.status, r.raw).toBe(201);
    expect(r.body.client).toMatchObject({ tenantId: personal, displayName: 'Solo Founder Studio', house: true });
    expect(r.body.client.orgId).not.toBe(personal);
    // The no-orgId client path works in a personal workspace too.
    const client = await call<{ client: ClientAccount }>(c, 'POST', '/clients', { name: 'First Customer' });
    expect(client.status, client.raw).toBe(201);
    expect(client.body.client.orgId).not.toBe(personal);
    const list = await call<{ clients: ClientAccount[]; agencyAdmin: boolean }>(c, 'GET', '/clients');
    expect(list.body.agencyAdmin).toBe(true);
    expect(list.body.clients.map((x) => x.displayName)).toEqual(['Solo Founder Studio', 'First Customer']);
  });
});

describe('the house client — optional brand-kit copy', () => {
  it('copies the root brand once, on request, as a separate record with no editor list', async () => {
    const a = await agency('Brand Kit Agency');
    const root = await createBrand(a.tenantId, a.tenantId, 'seed', {
      name: 'Brand Kit Agency',
      voiceProfile: { voice: 'warm, plain, direct', samplePhrases: ['Built for small teams'] },
      governance: { lockLevel: 'partial', allowedEditors: ['user:root-editor'], requireApproval: true },
    });

    const created = await call<HouseBody>(a.admin, 'POST', '/house', {});
    expect(created.status, created.raw).toBe(201);
    const houseOrg = created.body.client.orgId;
    expect(await listBrands(a.tenantId, houseOrg), 'setup alone copies nothing').toEqual([]);

    const copied = await call<HouseBody>(a.admin, 'POST', '/house', { copyBrandKit: true });
    expect(copied.status, copied.raw).toBe(200);
    expect(copied.body.brandKit?.copied).toBe(true);
    const houseBrands = await listBrands(a.tenantId, houseOrg);
    expect(houseBrands).toHaveLength(1);
    const kit = houseBrands[0]!;
    expect(kit.id).toBe(copied.body.brandKit?.brandId);
    expect(kit.id, 'a copy, not the root record').not.toBe(root.id);
    expect(kit).toMatchObject({ orgId: houseOrg, name: 'Brand Kit Agency' });
    expect(kit.voiceProfile.voice).toBe('warm, plain, direct');
    expect(kit.voiceProfile.samplePhrases).toEqual(['Built for small teams']);
    expect(kit.governance).toMatchObject({ lockLevel: 'partial', requireApproval: true, allowedEditors: [] });

    const again = await call<HouseBody>(a.admin, 'POST', '/house', { copyBrandKit: true });
    expect(again.body.brandKit).toMatchObject({ copied: false, reason: 'already_copied', brandId: kit.id });
    expect(await listBrands(a.tenantId, houseOrg)).toHaveLength(1);
    // The root brand is untouched and still the root's only one.
    expect((await listBrands(a.tenantId, a.tenantId)).map((b) => b.id)).toEqual([root.id]);
  });

  it('says so when the workspace has no brand kit to copy', async () => {
    const a = await agency('No Brand Agency');
    const r = await call<HouseBody>(a.admin, 'POST', '/house', { copyBrandKit: true });
    expect(r.status, r.raw).toBe(201);
    expect(r.body.brandKit).toEqual({ copied: false, reason: 'no_workspace_brand' });
  });

  it('refuses a non-boolean copyBrandKit before creating anything', async () => {
    const a = await agency('Strict Body Agency');
    const orgsBefore = (await listOrgs(a.tenantId)).length;
    const r = await call(a.admin, 'POST', '/house', { copyBrandKit: 'yes' });
    expect(r.status, r.raw).toBe(400);
    expect((await listOrgs(a.tenantId)).length).toBe(orgsBefore);
  });
});
