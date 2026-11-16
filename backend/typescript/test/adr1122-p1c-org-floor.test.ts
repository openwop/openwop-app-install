/**
 * ADR 1122 P1c — the D2.1 org floor at the asset serve route, under
 * `OPENWOP_ASSET_ACCESS=enforce`, in a shared workspace with client orgs A and B:
 *  - a member of A reads A's library asset, not B's (the same 404 as an unknown token);
 *  - a workspace admin reads both;
 *  - an asset owned by the workspace root, and a token that is not a library asset,
 *    stay at the tenant floor (any member reads them);
 *  - a public grant still admits B's asset to anyone;
 *  - the index backfill fills rows for assets that predate the index.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember, createOrg } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { assetOrgResolver, grantPublicAsset, registerAssetOrgResolver } from '../src/host/assetAccess.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { backfillServeTokenIndexStep, createAsset, orgOfServeTokenIndexed } from '../src/features/media/mediaService.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let BASE: string;
let server: http.Server;
let ws = '';
let orgA = '';
let orgB = '';
const cookies = { memberA: '', admin: '' };

const now = (): number => Math.floor(Date.now() / 1000);
const cookieFor = (userId: string, personal: string): string =>
  `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: ws, tier: 'user', userId, personalTenant: personal, iat: now(), exp: now() + COOKIE_TTL_SECONDS })}`;
const read = async (token: string, cookie?: string): Promise<number> =>
  (await fetch(`${BASE}/host/openwop-app/assets/${token}`, cookie ? { headers: { cookie } } : {})).status;
const libraryAsset = async (orgId: string): Promise<string> => {
  const stored = await storeMediaAsset(ws, { contentBase64: PNG, contentType: 'image/png' });
  await createAsset({ tenantId: ws, orgId, name: 'x.png', contentType: 'image/png', sizeBytes: stored.bytes, storageRef: stored.token, serveToken: stored.token, uploadedBy: 'u1' });
  return stored.token;
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const owner = await upsertFromPrincipal({ tenantId: 'seed', principalId: 'oidc:p1c-owner', source: 'oidc' });
  ws = (await createWorkspace({ name: 'Agency', ownerSubject: owner.userId })).tenantId;
  orgA = (await createOrg({ tenantId: ws, createdBy: owner.userId, name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: ws, createdBy: owner.userId, name: 'Client B' })).orgId;
  const member = await upsertFromPrincipal({ tenantId: ws, principalId: 'oidc:p1c-member', source: 'oidc' });
  await createMember({ tenantId: ws, orgId: ws, subject: member.userId, displayName: 'member', roles: ['viewer'] });
  await createMember({ tenantId: ws, orgId: orgA, subject: member.userId, displayName: 'member', roles: ['editor'] });
  cookies.memberA = cookieFor(member.userId, 'ws:home-p1c-member');
  const admin = await upsertFromPrincipal({ tenantId: ws, principalId: 'oidc:p1c-admin', source: 'oidc' });
  await createMember({ tenantId: ws, orgId: ws, subject: admin.userId, displayName: 'admin', roles: ['admin'] });
  cookies.admin = cookieFor(admin.userId, 'ws:home-p1c-admin');
});
afterEach(() => { delete process.env.OPENWOP_ASSET_ACCESS; });
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 1122 P1c — an org-owned library asset needs access in its org', () => {
  it('a member of A reads A’s asset but not B’s; an admin reads both', async () => {
    process.env.OPENWOP_ASSET_ACCESS = 'enforce';
    const a = await libraryAsset(orgA);
    const b = await libraryAsset(orgB);
    expect(await read(a, cookies.memberA)).toBe(200);
    expect(await read(b, cookies.memberA)).toBe(404);
    expect(await read(a, cookies.admin)).toBe(200);
    expect(await read(b, cookies.admin)).toBe(200);
  });

  it('a root-owned asset and a non-library token stay at the tenant floor', async () => {
    process.env.OPENWOP_ASSET_ACCESS = 'enforce';
    const root = await libraryAsset(ws);
    const loose = (await storeMediaAsset(ws, { contentBase64: PNG, contentType: 'image/png' })).token;
    expect(await read(root, cookies.memberA)).toBe(200);
    expect(await read(loose, cookies.memberA)).toBe(200);
  });

  it('a public grant still admits B’s asset to anyone', async () => {
    process.env.OPENWOP_ASSET_ACCESS = 'enforce';
    const b = await libraryAsset(orgB);
    await grantPublicAsset(ws, b, 'cms-page:pub');
    expect(await read(b, cookies.memberA)).toBe(200);
    expect(await read(b)).toBe(200);
  });

  it('a failing org lookup fails closed for a session read; a public grant still serves', async () => {
    process.env.OPENWOP_ASSET_ACCESS = 'enforce';
    const a = await libraryAsset(orgA);
    const pub = await libraryAsset(orgA);
    await grantPublicAsset(ws, pub, 'cms-page:pub-flaky');
    const real = assetOrgResolver();
    expect(real).not.toBeNull();
    registerAssetOrgResolver({ orgOf: async () => { throw new Error('store unavailable'); }, backfillStep: async () => ({}) });
    try {
      expect(await read(a, cookies.memberA)).toBe(404); // fails closed, even for a member of A
      expect(await read(pub)).toBe(200); // the public arm is unaffected
    } finally {
      if (real) registerAssetOrgResolver(real);
    }
    expect(await read(a, cookies.memberA)).toBe(200);
  });

  it('the backfill indexes a library row written before the token index', async () => {
    const b = await libraryAsset(orgB);
    const storage = hostExtStorage();
    const idxKeys = (await storage.kvList('hostext:media:token-idx:')).map((r) => r.key).filter((k) => k.includes(ws));
    for (const k of idxKeys) await storage.kvDelete(k); // as if the rows predate ADR 0945's index
    expect(await orgOfServeTokenIndexed(ws, b)).toBeUndefined();
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) { const step = await backfillServeTokenIndexStep(cursor, 50); cursor = step.next; if (!cursor) break; }
    expect(await orgOfServeTokenIndexed(ws, b)).toBe(orgB);
  });
});
