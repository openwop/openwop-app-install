/**
 * ADR 0172 P4 fold-in — team profiles auto-index into the tenant-level
 * `Team Portfolio KB` collection (gated on `production`), + the ctx.features.profiles
 * read surface. §Correction: profiles are tenant-scoped, so the collection is
 * `mgd-team-<tenant>` under the reserved sentinel org `_team`, NOT the per-org
 * vendor collection.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getDocument } from '../src/features/kb/kbService.js';

let BASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'production']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}

const teamCol = (tenantId: string): [string, string, string] => [tenantId, '_team', `mgd-team-${tenantId}`];

describe('Team Portfolio KB indexing (ADR 0172 P4 fold-in)', () => {
  it('indexes a member on profile edit; empties → removes; excludes PII', async () => {
    const tenantId = `org:tpk-${Date.now()}`;
    const c = client();
    const login = await c.post('/v1/host/openwop-app/test/login', { email: `tpk-${Date.now()}@t.test`, tenantId });
    expect(login.status).toBe(201);
    const me = await c.get('/v1/host/openwop-app/profiles/me');
    const userId = (me.body as { userId: string }).userId as string;

    // Edit descriptive capability fields (+ a contact location = declared PII) → indexed.
    const patched = await c.patch('/v1/host/openwop-app/profiles/me', { jobTitle: 'Video Editor', interests: ['motion graphics'], equipment: ['DaVinci Resolve'], contact: { location: 'SECRET-CITY-42', links: [] } });
    expect(patched.status).toBe(200);
    const doc = await getDocument(...teamCol(tenantId), `profile:${userId}`);
    expect(doc, 'profile should be indexed after edit').not.toBeNull();
    expect(doc!.text).toContain('Video Editor');
    expect(doc!.text).toContain('motion graphics');
    expect(doc!.text).not.toContain('SECRET-CITY-42'); // contact/location PII is NOT indexed

    // Empty the capability signal → the doc is removed (no noise).
    await c.patch('/v1/host/openwop-app/profiles/me', { jobTitle: '', bio: '', interests: [], equipment: [] });
    expect(await getDocument(...teamCol(tenantId), `profile:${userId}`), 'empty profile should be unindexed').toBeNull();
  });

  it('is gated on the production toggle (off ⇒ no indexing)', async () => {
    const prod = getToggleDefault('production');
    if (prod) await saveConfig({ ...prod, status: 'off' }, 'test');
    try {
      const tenantId = `org:tpk-off-${Date.now()}`;
      const c = client();
      await c.post('/v1/host/openwop-app/test/login', { email: `tpkoff-${Date.now()}@t.test`, tenantId });
      const me = await c.get('/v1/host/openwop-app/profiles/me');
      await c.patch('/v1/host/openwop-app/profiles/me', { jobTitle: 'Designer' });
      expect(await getDocument(...teamCol(tenantId), `profile:${(me.body as { userId: string }).userId}`)).toBeNull();
    } finally {
      if (prod) await saveConfig({ ...prod, status: 'on' }, 'test');
    }
  });
});

describe('Team Portfolio KB is retrievable (GRADE DATA-4 / TPK-1)', () => {
  it('the shareableKb provider ensures+backfills the collection and resolves it', async () => {
    const { teamPortfolioShareableKbProvider, backfillTeamPortfolioKb } = await import('../src/features/profiles/profilesKnowledgeService.js');
    const tenantId = `org:tpk-share-${Date.now()}`;
    const c = client();
    await c.post('/v1/host/openwop-app/test/login', { email: `tpkshare-${Date.now()}@t.test`, tenantId });
    const me = await c.get('/v1/host/openwop-app/profiles/me');
    // A profile that pre-dates any binding (would be missed without a backfill).
    await c.patch('/v1/host/openwop-app/profiles/me', { jobTitle: 'Gaffer' });

    // Before ensure, a fresh tenant may or may not have the collection; ensure creates
    // + backfills, then resolve returns it.
    const ensured = await teamPortfolioShareableKbProvider.ensureCollectionIds!(tenantId, 'someOrg', (me.body as { userId: string }).userId);
    expect(ensured).toEqual([`mgd-team-${tenantId}`]);
    const resolved = await teamPortfolioShareableKbProvider.resolveCollectionIds(tenantId, 'someOrg');
    expect(resolved).toEqual([`mgd-team-${tenantId}`]);
    // Backfill is idempotent + best-effort.
    await expect(backfillTeamPortfolioKb(tenantId)).resolves.toBeUndefined();
  });
});

describe('ctx.features.profiles surface (ADR 0005 addendum)', () => {
  it('lists + gets tenant profiles, stripping internal columns', async () => {
    const { buildProfilesSurface } = await import('../src/features/profiles/surface.js');
    const tenantId = `org:tpk-surf-${Date.now()}`;
    const c = client();
    await c.post('/v1/host/openwop-app/test/login', { email: `tpksurf-${Date.now()}@t.test`, tenantId });
    const me = await c.get('/v1/host/openwop-app/profiles/me');
    await c.patch('/v1/host/openwop-app/profiles/me', { jobTitle: 'Producer' });

    const surface = buildProfilesSurface({ tenantId });
    const list = await surface.listProfiles!({}) as { profiles: Record<string, unknown>[] };
    expect(list.profiles.some((p) => p.userId === (me.body as { userId: string }).userId && p.jobTitle === 'Producer')).toBe(true);
    expect(list.profiles.every((p) => !('tenantId' in p))).toBe(true); // internal column stripped

    const one = await surface.getProfile!({ userId: (me.body as { userId: string }).userId }) as { profile: Record<string, unknown> | null };
    expect(one.profile?.jobTitle).toBe('Producer');
    const missing = await surface.getProfile!({ userId: 'nobody' }) as { profile: null };
    expect(missing.profile).toBeNull();
  });
});
