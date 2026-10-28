/**
 * Campaign ops P0 — client accounts (ADR 0921) and the asset registry + CMS page
 * adapter (ADR 0922), over HTTP and the workflow surface.
 *
 * Setup is a real shared `ws:` agency workspace with two client orgs. The
 * OPERATOR holds `viewer` on the workspace root (enough to enter it) and `editor`
 * on client A only, which is the ADR 0921 D2 posture. The AGENCY ADMIN holds
 * `admin` on the root and NO row on either client, which pins ADR 0921 Q1: the
 * admin path is an explicit root-row check, not a fallback.
 *
 * Sabotage notes (each run, 2026-10-18):
 *  - drop the per-client filter in GET /clients → red (the operator sees B);
 *  - let every caller take the agency-admin branch of `authorizeClient` → red
 *    (the operator reaches client B and switches A to live);
 *  - drop the claim CAS in `addAsset` → red (the same page registers twice);
 *  - let an anon personal tenant count as its own agency admin → red (GET
 *    /clients answers agencyAdmin:true to an anon session);
 *  - drop the adapter's own `expectedVersion` compare → STAYS GREEN, correctly:
 *    `updatePage` enforces the same pin. Dropping both the compare and the pin
 *    passed to `updatePage` → red (the stale write lands).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createPage, getPage, updatePage } from '../src/features/cms/cmsService.js';
import { cmsPageAdapter, pageContentHash } from '../src/features/campaign-ops/adapters/cmsPage.js';
import { buildCampaignOpsSurface, CAMPAIGN_OPS_RUN_STAMP } from '../src/features/campaign-ops/surface.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import type { CampaignAsset, ClientAccount } from '../src/features/campaign-ops/types.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let adminCookie: string;
let operatorCookie: string;
let adminUserId: string;
let operatorUserId: string;
let orgA: string;
let orgB: string;
let pageA: string;
let pageA2: string;
let pageB: string;
let heroA: string;

function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}

interface Res<T> { status: number; body: T; raw: string }
async function call<T = Record<string, unknown>>(cookie: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}/host/openwop-app/campaign-ops${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}

async function landingPage(orgId: string, title: string): Promise<{ pageId: string; heroId: string }> {
  const page = await createPage({
    tenantId: TENANT, orgId, title, createdBy: 'seed',
    sections: [
      { type: 'hero', data: { heading: 'Q4 pipeline review — Tuesday, Nov 3', subheading: 'Register at https://example.test/register-old' } },
      { type: 'richText', data: { body: 'Join our live session.' } },
    ],
  });
  return { pageId: page.pageId, heroId: page.sections[0].sectionId };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['cms', 'campaign-ops']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const ws = await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:cops-owner' });
  TENANT = ws.tenantId;
  const admin = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:cops-admin', source: 'oidc' });
  const operator = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:cops-operator', source: 'oidc' });
  adminUserId = admin.userId;
  operatorUserId = operator.userId;
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: adminUserId, displayName: 'Admin', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: operatorUserId, displayName: 'Operator', roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: operatorUserId, displayName: 'Operator', roles: ['editor'] });
  ({ pageId: pageA, heroId: heroA } = await landingPage(orgA, 'Webinar A'));
  ({ pageId: pageA2 } = await landingPage(orgA, 'Webinar A2'));
  ({ pageId: pageB } = await landingPage(orgB, 'Webinar B'));
  adminCookie = cookieFor(adminUserId, 'ws:home-admin');
  operatorCookie = cookieFor(operatorUserId, 'ws:home-operator');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0921 — client accounts', () => {
  it('only an agency admin creates clients; the workspace root cannot be one', async () => {
    expect((await call(operatorCookie, 'POST', '/clients', { name: 'X', orgId: orgA })).status).toBe(403);
    const a = await call<{ client: ClientAccount }>(adminCookie, 'POST', '/clients', { name: 'Client A', orgId: orgA });
    expect(a.status, a.raw).toBe(201);
    expect(a.body.client).toMatchObject({ orgId: orgA, status: 'active', mode: 'preview' });
    expect((await call(adminCookie, 'POST', '/clients', { name: 'Client B', orgId: orgB })).status).toBe(201);
    expect((await call(adminCookie, 'POST', '/clients', { name: 'Again', orgId: orgA })).status).toBe(409);
    const root = await call<{ error: string }>(adminCookie, 'POST', '/clients', { name: 'Root', orgId: TENANT });
    expect(root.status).toBe(400);
    expect(root.raw).toContain('root_org_not_client');
  });

  it('the switcher lists only the clients the caller can read; the admin sees all', async () => {
    const op = await call<{ clients: ClientAccount[] }>(operatorCookie, 'GET', '/clients');
    expect(op.status, op.raw).toBe(200);
    expect(op.body.clients.map((c) => c.orgId)).toEqual([orgA]);
    const ad = await call<{ clients: ClientAccount[]; agencyAdmin: boolean }>(adminCookie, 'GET', '/clients');
    expect(ad.body.agencyAdmin).toBe(true);
    expect(ad.body.clients.map((c) => c.orgId).sort()).toEqual([orgA, orgB].sort());
  });

  it('an anon sandbox session is not an agency admin of its own tenant', async () => {
    const sid = randomBytes(12).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    const anon = `__session=${signSession({ sid, tenantId: `anon:${sid}`, tier: 'anon', personalTenant: `anon:${sid}`, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
    const r = await call<{ clients: ClientAccount[]; agencyAdmin: boolean }>(anon, 'GET', '/clients');
    if (r.status === 200) expect(r.body.agencyAdmin, r.raw).toBe(false);
    else expect([401, 403, 404], r.raw).toContain(r.status);
  });

  it('another client is a uniform 404 to the operator, on reads and writes', async () => {
    expect((await call(operatorCookie, 'GET', `/clients/${orgB}`)).status).toBe(404);
    expect((await call(operatorCookie, 'GET', `/clients/${orgB}/assets`)).status).toBe(404);
    const w = await call(operatorCookie, 'POST', `/clients/${orgB}/assets`, { destination: 'openwop.cms.page', locator: { pageId: pageB }, label: 'B', editableFields: ['title'] });
    expect(w.status, w.raw).toBe(404);
  });

  it('switching a client to live needs admin on that client, not editor', async () => {
    expect((await call(operatorCookie, 'PATCH', `/clients/${orgA}`, { mode: 'live' })).status).toBe(403);
    const r = await call<{ client: ClientAccount }>(adminCookie, 'PATCH', `/clients/${orgA}`, { mode: 'live' });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.client.mode).toBe('live');
  });
});

describe('ADR 0922 — asset registry', () => {
  let asset: CampaignAsset;
  const heroHeading = (): string => `sections[${heroA}].data.heading`;

  it('adds a page of the same client with its current version and hash', async () => {
    const r = await call<{ asset: CampaignAsset }>(operatorCookie, 'POST', `/clients/${orgA}/assets`, {
      destination: 'openwop.cms.page', locator: { pageId: pageA }, label: 'Webinar landing page', editableFields: [heroHeading(), 'title'],
    });
    expect(r.status, r.raw).toBe(201);
    asset = r.body.asset;
    const page = await getPage(TENANT, orgA, pageA);
    expect(asset.lastKnown).toMatchObject({ version: page!.version, contentHash: pageContentHash(page!) });
  });

  it('refuses another client’s page, a page registered twice, and unknown fields', async () => {
    const wrong = await call(operatorCookie, 'POST', `/clients/${orgA}/assets`, { destination: 'openwop.cms.page', locator: { pageId: pageB }, label: 'B', editableFields: ['title'] });
    expect(wrong.status).toBe(404);
    expect(wrong.raw).toContain('wrong_client_or_missing');
    const twice = await call(operatorCookie, 'POST', `/clients/${orgA}/assets`, { destination: 'openwop.cms.page', locator: { pageId: pageA }, label: 'Again', editableFields: ['title'] });
    expect(twice.status).toBe(409);
    const bad = await call(operatorCookie, 'POST', `/clients/${orgA}/assets`, { destination: 'openwop.cms.page', locator: { pageId: pageA2 }, label: 'A2', editableFields: ['sections[sec:nope].data.heading'] });
    expect(bad.status).toBe(400);
  });

  it('refresh picks up a human edit made after registration', async () => {
    const page = await getPage(TENANT, orgA, pageA);
    await updatePage(TENANT, orgA, pageA, { title: 'Webinar A (edited)' }, 'someone');
    const r = await call<{ asset: CampaignAsset }>(operatorCookie, 'POST', `/clients/${orgA}/assets/${asset.assetId}/refresh`);
    expect(r.status, r.raw).toBe(200);
    expect(r.body.asset.lastKnown!.version).toBe(page!.version + 1);
    asset = r.body.asset;
  });

  it('the adapter writes only with the expected version, only editable fields, only exact matches', async () => {
    const ctx = { tenantId: TENANT, actingUserId: operatorUserId };
    const v = asset.lastKnown!.version;
    const edit = { field: heroHeading(), find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5' };
    expect(await cmsPageAdapter.write(asset, [edit], { expectedVersion: v - 1 }, ctx)).toMatchObject({ kind: 'version_conflict', currentVersion: v });
    expect(await cmsPageAdapter.write(asset, [{ field: `sections[${heroA}].data.subheading`, find: 'old', replace: 'new' }], { expectedVersion: v }, ctx))
      .toMatchObject({ kind: 'refused', reason: 'not_editable' });
    expect(await cmsPageAdapter.write(asset, [{ field: heroHeading(), find: 'Friday', replace: 'x' }], { expectedVersion: v }, ctx))
      .toMatchObject({ kind: 'refused', reason: 'edit_mismatch' });
    const ok = await cmsPageAdapter.write(asset, [edit], { expectedVersion: v }, ctx);
    expect(ok).toEqual({ kind: 'written', version: v + 1 });
    const after = await cmsPageAdapter.read(asset, { tenantId: TENANT });
    expect(after!.fields[heroHeading()]).toBe('Q4 pipeline review — Thursday, Nov 5');
    expect(after!.fields['title']).toBe('Webinar A (edited)'); // untouched
  });
});

describe('ADR 0921 D3 — the workflow surface is client-bound', () => {
  const scopeFor = (actingUserId: string | undefined, runId?: string) =>
    ({ tenantId: TENANT, ...(actingUserId ? { actingUserId } : {}), ...(runId ? { runId } : {}) });

  it('refuses an actorless run', async () => {
    await expect(buildCampaignOpsSurface(scopeFor(undefined)).listAssets({ orgId: orgA })).rejects.toMatchObject({ details: { reason: 'no_acting_user' } });
  });

  it('refuses an actor with no row on the client', async () => {
    await expect(buildCampaignOpsSurface(scopeFor(operatorUserId)).listAssets({ orgId: orgB })).rejects.toBeTruthy();
  });

  it('refuses a run stamped for another client', async () => {
    const runId = `run-cops-${randomBytes(4).toString('hex')}`;
    await hostExtStorage().insertRun({
      runId, workflowId: 'w', tenantId: TENANT, status: 'pending', inputs: null,
      metadata: { [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgB } }, configurable: {}, createdAt: 'x', updatedAt: 'x',
    });
    await expect(buildCampaignOpsSurface(scopeFor(operatorUserId, runId)).listAssets({ orgId: orgA })).rejects.toMatchObject({ details: { reason: 'wrong_client' } });
  });

  it('serves the client’s own assets to a member of that client', async () => {
    const out = await buildCampaignOpsSurface(scopeFor(operatorUserId)).listAssets({ orgId: orgA }) as { assets: CampaignAsset[] };
    expect(out.assets.map((a) => (a.locator as { pageId: string }).pageId)).toEqual([pageA]);
  });
});
