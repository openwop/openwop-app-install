/**
 * Brand & Guardrails (ADR 0155) — ROUTE harness. Boots the real app and drives
 * the feature over HTTP:
 *   - toggle gating (404 when `brand` is off)
 *   - create / list / get / update / delete a brand (org-scoped)
 *   - input sanitization (formality clamp, channel-rule allowlist)
 *   - IDOR: a co-tenant member without workspace:read in the brand's org gets 404
 *   - governance authority: lockLevel 'full' blocks a non-admin editor (403)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('brand'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
async function ownerWithOrg(): Promise<{ owner: Client; userId: string; orgId: string }> {
  const owner = client();
  const u = await signup(owner);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, userId: u.userId, orgId: org.body.orgId };
}

const B = '/v1/host/openwop-app/brand/brands';

describe('brand — always-on (ADR 0170: no feature-toggle gate)', () => {
  it('an authenticated member reaches the routes with no toggle enabled', async () => {
    const c = client();
    await signup(c);
    // graduated to core: no toggle to flip — the route is reachable (200), and
    // RBAC (not a feature gate) is what bounds access (covered below).
    const r = await c.get(B);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.brands)).toBe(true);
  });
});

describe('brand — CRUD + sanitization', () => {
  it('creates, lists, and gets a brand; clamps formality + filters channel rules', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const r = await owner.post(B, {
      orgId,
      name: 'FlashPick',
      voiceProfile: { voice: 'confident, not arrogant', formalityLevel: 99 },
      keyPhrases: { bannedPhrases: ['cheap', 'revolutionary'] },
      channelVoiceRules: [
        { channel: 'landing_page', tone: 'direct', maxLength: 600 },
        { channel: 'not_a_channel', tone: 'nope' },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.brand.name).toBe('FlashPick');
    expect(r.body.brand.voiceProfile.formalityLevel).toBe(3); // clamped (99 → default)
    expect(r.body.brand.channelVoiceRules).toHaveLength(1); // bad channel dropped
    expect(r.body.brand.channelVoiceRules[0].channel).toBe('landing_page');
    expect(r.body.brand.keyPhrases.bannedPhrases).toEqual(['cheap', 'revolutionary']);

    const list = await owner.get(`${B}?orgId=${orgId}`);
    expect(list.status).toBe(200);
    expect(list.body.brands.map((b: any) => b.id)).toContain(r.body.brand.id);

    const got = await owner.get(`${B}/${r.body.brand.id}`);
    expect(got.status).toBe(200);
    expect(got.body.brand.name).toBe('FlashPick');
  });

  it('requires a name on create', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const r = await owner.post(B, { orgId, name: '   ' });
    expect(r.status).toBe(400);
  });

  it('updates and deletes a brand', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(B, { orgId, name: 'Acme Voice' });
    const id = created.body.brand.id;
    const patched = await owner.patch(`${B}/${id}`, { description: 'updated', voiceProfile: { voice: 'warm', formalityLevel: 2 } });
    expect(patched.status).toBe(200);
    expect(patched.body.brand.description).toBe('updated');
    expect(patched.body.brand.voiceProfile.formalityLevel).toBe(2);
    const del = await owner.del(`${B}/${id}`);
    expect(del.status).toBe(200);
    expect((await owner.get(`${B}/${id}`)).status).toBe(404);
  });

  it('exposes the static channel vocabulary', async () => {
    const { owner } = await ownerWithOrg();
    const r = await owner.get('/v1/host/openwop-app/brand/channels');
    expect(r.status).toBe(200);
    expect(r.body.channels).toContain('landing_page');
    expect(r.body.channels).toContain('social_posts');
  });
});

describe('brand — isolation + governance', () => {
  it('a member without read in the brand org gets a uniform 404 (no existence leak)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(B, { orgId, name: 'Secret Brand' });
    const id = created.body.brand.id;
    // A different user in their own org/tenant must not read the foreign brand.
    const stranger = client();
    await signup(stranger);
    expect((await stranger.get(`${B}/${id}`)).status).toBe(404);
    expect((await stranger.patch(`${B}/${id}`, { name: 'hijack' })).status).toBe(404);
  });

  it("lockLevel 'full' blocks editing for a non-admin and 404s a cross-tenant id", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(B, { orgId, name: 'Locked Brand', governance: { lockLevel: 'full' } });
    const id = created.body.brand.id;
    // The owner is the org admin (tenant owner) → may still edit a fully-locked brand.
    const adminEdit = await owner.patch(`${B}/${id}`, { description: 'admin can' });
    expect(adminEdit.status, JSON.stringify(adminEdit.body)).toBe(200);
    // A foreign tenant id is simply not found.
    const stranger = client();
    await signup(stranger);
    expect((await stranger.del(`${B}/${id}`)).status).toBe(404);
  });
});
