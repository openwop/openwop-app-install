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
 * Clients A and B are seeded in `beforeAll`; every case that registers an asset
 * registers its OWN page, so cases pass alone and in any order.
 *
 * Tracker: TST-CBA-3 (/grade-tests wave 67). Red when (probe-witnessed,
 * 2026-10-29):
 *  - the per-client filter in GET /clients is dropped (the operator sees B);
 *  - every caller takes the agency-admin branch of `authorizeClient` (the
 *    operator reaches client B and switches A to live);
 *  - `requireAgencyAdmin` on POST /clients is skipped, or the workspace-root
 *    refusal in `createClient` is dropped (create case);
 *  - the claim CAS in `addAsset` is dropped (the same page registers twice);
 *  - an anon personal tenant counts as its own agency admin (GET /clients
 *    answers agencyAdmin:true to an anon session);
 *  - `bindRunToClient` drops its actorless refusal, its run-stamp compare, or its
 *    `assertRunOrgScope` membership check (the three surface refusals).
 * Recorded double guard: the adapter's own `expectedVersion` compare and the pin
 * passed to `updatePage` each refuse a stale write; dropping one stays green.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createPage, getPage, updatePage } from '../src/features/cms/cmsService.js';
import { cmsPageAdapter } from '../src/features/campaign-ops/adapters/cmsPage.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { addAsset } from '../src/features/campaign-ops/assetService.js';
import { canonicalJSON } from '../src/host/jcs.js';
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
let orgC: string;
let n = 0;

function cookieFor(userId: string, personalTenant: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
}

interface ErrorBody { error?: string; message?: string }
interface Res<T> { status: number; body: T; raw: string }
async function call<T = ErrorBody>(cookie: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}/host/openwop-app/campaign-ops${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  // The JSON wire boundary: each call site names the body shape it expects.
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

/** A page of client A registered by the operator, with its heading editable. */
async function registeredPage(): Promise<{ asset: CampaignAsset; pageId: string; heading: string }> {
  const { pageId, heroId } = await landingPage(orgA, `Webinar A ${++n}`);
  const heading = `sections[${heroId}].data.heading`;
  const r = await call<{ asset: CampaignAsset }>(operatorCookie, 'POST', `/clients/${orgA}/assets`, {
    destination: 'openwop.cms.page', locator: { pageId }, label: 'Webinar landing page', editableFields: [heading, 'title'],
  });
  expect(r.status, r.raw).toBe(201);
  return { asset: r.body.asset, pageId, heading };
}

function isAssetList(v: unknown): v is { assets: CampaignAsset[] } {
  return typeof v === 'object' && v !== null && Array.isArray((v as { assets?: unknown }).assets);
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
  orgC = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client C' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: operatorUserId, displayName: 'Operator', roles: ['editor'] });
  await createClient({ tenantId: TENANT, orgId: orgA, name: 'Client A', createdBy: 'seed' });
  await createClient({ tenantId: TENANT, orgId: orgB, name: 'Client B', createdBy: 'seed' });
  adminCookie = cookieFor(adminUserId, 'ws:home-admin');
  operatorCookie = cookieFor(operatorUserId, 'ws:home-operator');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0921 — client accounts', () => {
  it('only an agency admin creates clients; the workspace root cannot be one', async () => {
    const op = await call(operatorCookie, 'POST', '/clients', { name: 'X', orgId: orgC });
    expect(op.status, op.raw).toBe(403);
    expect(op.body).toMatchObject({ error: 'forbidden_scope', message: 'Only an agency admin can do this.' });
    const c = await call<{ client: ClientAccount }>(adminCookie, 'POST', '/clients', { name: 'Client C', orgId: orgC });
    expect(c.status, c.raw).toBe(201);
    expect(c.body.client).toMatchObject({ orgId: orgC, status: 'active', mode: 'preview' });
    expect((await call(adminCookie, 'POST', '/clients', { name: 'Again', orgId: orgC })).status).toBe(409);
    const root = await call(adminCookie, 'POST', '/clients', { name: 'Root', orgId: TENANT });
    expect(root.status).toBe(400);
    expect(root.raw).toContain('root_org_not_client');
  });

  it('the switcher lists only the clients the caller can read; the admin sees all', async () => {
    const op = await call<{ clients: ClientAccount[]; agencyAdmin: boolean }>(operatorCookie, 'GET', '/clients');
    expect(op.status, op.raw).toBe(200);
    expect(op.body.agencyAdmin).toBe(false);
    // Client A is the operator's; B and C are not (other cases may add clients
    // the operator does belong to, so this is membership, not the whole list).
    const visible = op.body.clients.map((c) => c.orgId);
    expect(visible).toContain(orgA);
    expect(visible).not.toContain(orgB);
    expect(visible).not.toContain(orgC);
    const ad = await call<{ clients: ClientAccount[]; agencyAdmin: boolean }>(adminCookie, 'GET', '/clients');
    expect(ad.body.agencyAdmin).toBe(true);
    expect(ad.body.clients.map((c) => c.orgId)).toEqual(expect.arrayContaining([orgA, orgB]));
  });

  it('an anon sandbox session is not an agency admin of its own tenant', async () => {
    const sid = randomBytes(12).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    const anon = `__session=${signSession({ sid, tenantId: `anon:${sid}`, tier: 'anon', personalTenant: `anon:${sid}`, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
    const r = await call(anon, 'GET', '/clients');
    // Not the agency-admin branch: the anon caller falls to the member lane, which
    // needs a signed-in user (an agency-admin answer would be 200 agencyAdmin:true).
    expect(r.status, r.raw).toBe(401);
    expect(r.body).toMatchObject({ error: 'sign_in_required' });
    expect(r.raw).not.toContain('agencyAdmin');
  });

  it('another client is a uniform 404 to the operator, on reads and writes', async () => {
    const pageB = (await landingPage(orgB, 'Webinar B')).pageId;
    const missing = await call(operatorCookie, 'GET', '/clients/org-does-not-exist');
    expect(missing.status).toBe(404);
    for (const r of [
      await call(operatorCookie, 'GET', `/clients/${orgB}`),
      await call(operatorCookie, 'GET', `/clients/${orgB}/assets`),
      await call(operatorCookie, 'POST', `/clients/${orgB}/assets`, { destination: 'openwop.cms.page', locator: { pageId: pageB }, label: 'B', editableFields: ['title'] }),
    ]) {
      expect(r.status, r.raw).toBe(404);
      expect({ error: r.body.error, message: r.body.message }).toEqual({ error: missing.body.error, message: missing.body.message });
    }
  });

  it('switching a client to live needs admin on that client, not editor', async () => {
    const op = await call(operatorCookie, 'PATCH', `/clients/${orgA}`, { mode: 'live' });
    expect(op.status, op.raw).toBe(403);
    expect(op.body.error).toBe('forbidden_scope');
    const r = await call<{ client: ClientAccount }>(adminCookie, 'PATCH', `/clients/${orgA}`, { mode: 'live' });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.client.mode).toBe('live');
  });
});

describe('ADR 0922 — asset registry', () => {
  it('adds a page of the same client with its current version and hash', async () => {
    const { asset, pageId } = await registeredPage();
    const page = await getPage(TENANT, orgA, pageId);
    if (!page) throw new Error('page missing');
    // ADR 0922 D3 source identity, derived here: sha256 over RFC 8785 JSON of title, slug, sections.
    const expected = `sha256:${createHash('sha256').update(canonicalJSON({ title: page.title, slug: page.slug, sections: page.sections })).digest('hex')}`;
    expect(asset.lastKnown).toMatchObject({ version: page.version, contentHash: expected });
  });

  it('refuses another client’s page, a page registered twice, and unknown fields', async () => {
    const pageB = (await landingPage(orgB, 'Webinar B (not A)')).pageId;
    const wrong = await call(operatorCookie, 'POST', `/clients/${orgA}/assets`, { destination: 'openwop.cms.page', locator: { pageId: pageB }, label: 'B', editableFields: ['title'] });
    expect(wrong.status).toBe(404);
    expect(wrong.raw).toContain('wrong_client_or_missing');
    const { pageId } = await registeredPage();
    const twice = await call(operatorCookie, 'POST', `/clients/${orgA}/assets`, { destination: 'openwop.cms.page', locator: { pageId }, label: 'Again', editableFields: ['title'] });
    expect(twice.status).toBe(409);
    expect(twice.raw).toContain('asset_already_registered');
    const fresh = (await landingPage(orgA, 'Webinar A fresh')).pageId;
    const bad = await call(operatorCookie, 'POST', `/clients/${orgA}/assets`, { destination: 'openwop.cms.page', locator: { pageId: fresh }, label: 'A2', editableFields: ['sections[sec:nope].data.heading'] });
    expect(bad.status).toBe(400);
    expect(bad.raw).toContain('sections[sec:nope].data.heading');
  });

  it('refresh picks up a human edit made after registration', async () => {
    const { asset, pageId } = await registeredPage();
    const page = await getPage(TENANT, orgA, pageId);
    if (!page) throw new Error('page missing');
    await updatePage(TENANT, orgA, pageId, { title: 'Webinar A (edited)' }, 'someone');
    const r = await call<{ asset: CampaignAsset }>(operatorCookie, 'POST', `/clients/${orgA}/assets/${asset.assetId}/refresh`);
    expect(r.status, r.raw).toBe(200);
    expect(r.body.asset.lastKnown?.version).toBe(page.version + 1);
  });

  it('the adapter writes only with the expected version, only editable fields, only exact matches', async () => {
    const { asset, pageId, heading } = await registeredPage();
    const page = await getPage(TENANT, orgA, pageId);
    if (!page) throw new Error('page missing');
    const ctx = { tenantId: TENANT, actingUserId: operatorUserId };
    const v = page.version;
    const subheading = heading.replace('.data.heading', '.data.subheading');
    const edit = { field: heading, find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5' };
    expect(await cmsPageAdapter.write(asset, [edit], { expectedVersion: v - 1 }, ctx)).toMatchObject({ kind: 'version_conflict', currentVersion: v });
    expect(await cmsPageAdapter.write(asset, [{ field: subheading, find: 'old', replace: 'new' }], { expectedVersion: v }, ctx))
      .toMatchObject({ kind: 'refused', reason: 'not_editable' });
    expect(await cmsPageAdapter.write(asset, [{ field: heading, find: 'Friday', replace: 'x' }], { expectedVersion: v }, ctx))
      .toMatchObject({ kind: 'refused', reason: 'edit_mismatch' });
    const ok = await cmsPageAdapter.write(asset, [edit], { expectedVersion: v }, ctx);
    expect(ok).toEqual({ kind: 'written', version: v + 1 });
    const after = await cmsPageAdapter.read(asset, { tenantId: TENANT });
    expect(after?.fields[heading]).toBe('Q4 pipeline review — Thursday, Nov 5');
    expect(after?.fields['title']).toBe(page.title); // untouched
  });
});

describe('ADR 0921 D3 — the workflow surface is client-bound', () => {
  const scopeFor = (actingUserId: string | undefined, runId?: string) =>
    ({ tenantId: TENANT, ...(actingUserId ? { actingUserId } : {}), ...(runId ? { runId } : {}) });

  it('refuses an actorless run', async () => {
    await expect(buildCampaignOpsSurface(scopeFor(undefined)).listAssets({ orgId: orgA })).rejects.toMatchObject({ details: { reason: 'no_acting_user' } });
  });

  it('refuses an actor with no row on the client', async () => {
    await expect(buildCampaignOpsSurface(scopeFor(operatorUserId)).listAssets({ orgId: orgB }))
      .rejects.toMatchObject({ code: 'forbidden_scope', message: 'Missing required scope: workspace:read' });
  });

  it('refuses a run stamped for another client', async () => {
    const runId = `run-cops-${randomBytes(4).toString('hex')}`;
    const at = new Date().toISOString();
    await hostExtStorage().insertRun({
      runId, workflowId: 'w', tenantId: TENANT, status: 'pending', inputs: null,
      metadata: { [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgB } }, configurable: {}, createdAt: at, updatedAt: at,
    });
    await expect(buildCampaignOpsSurface(scopeFor(operatorUserId, runId)).listAssets({ orgId: orgA })).rejects.toMatchObject({ details: { reason: 'wrong_client' } });
  });

  it('serves the client’s own assets to a member of that client', async () => {
    const orgD = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client D' })).orgId;
    await createMember({ tenantId: TENANT, orgId: orgD, subject: operatorUserId, displayName: 'Operator', roles: ['editor'] });
    await createClient({ tenantId: TENANT, orgId: orgD, name: 'Client D', createdBy: 'seed' });
    const { pageId } = await landingPage(orgD, 'Webinar D');
    await addAsset({ tenantId: TENANT, orgId: orgD, destination: 'openwop.cms.page', locator: { pageId }, label: 'D', editableFields: ['title'], createdBy: 'seed' });
    const out: unknown = await buildCampaignOpsSurface(scopeFor(operatorUserId)).listAssets({ orgId: orgD });
    if (!isAssetList(out)) throw new Error(`not an asset list: ${JSON.stringify(out)}`);
    expect(out.assets.map((a) => ('pageId' in a.locator ? a.locator.pageId : null))).toEqual([pageId]);
  });
});
