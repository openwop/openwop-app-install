/**
 * ADR 0852 D3 — a feature IS a project; `facet:'feature'` is a label only.
 *   - a writer sets it and clears it (null); the project reads it back;
 *   - only `'feature'` (or null) is accepted (400);
 *   - a notebook or a campaign's project keeps its facet (409);
 *   - a reader cannot set it (403).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { createProject } from '../src/features/projects/projectsService.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) as any };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
}
const P = '/host/openwop-app/projects';

async function setup() {
  const tenantId = `org:fl-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: `fl-${n++}@acme.test`, tenantId })).body.user.userId as string;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'FeatCo' })).body.orgId as string;
  const proj = (await owner.post(P, { orgId, name: 'Checkout v2' })).body as { id: string };
  return { tenantId, orgId, owner, ownerId, projectId: proj.id };
}

describe('ADR 0852 D3 — the feature label', () => {
  it('a writer sets and clears it; only "feature" or null is accepted', async () => {
    const s = await setup();
    const set = await s.owner.put(`${P}/${s.projectId}/facet`, { facet: 'feature' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((await s.owner.get(`${P}/${s.projectId}`)).body.facet).toBe('feature');
    expect((await s.owner.put(`${P}/${s.projectId}/facet`, { facet: null })).status).toBe(200);
    expect((await s.owner.get(`${P}/${s.projectId}`)).body.facet).toBeUndefined();
    for (const facet of ['campaign', 'notebook', 'epic', undefined]) {
      expect((await s.owner.put(`${P}/${s.projectId}/facet`, { facet })).status, String(facet)).toBe(400);
    }
  });

  it('a notebook or a campaign project keeps its facet (409)', async () => {
    const s = await setup();
    for (const facet of ['notebook', 'campaign'] as const) {
      const p = await createProject(s.tenantId, s.orgId, { name: `${facet} one`, facet }, s.ownerId);
      expect((await s.owner.put(`${P}/${p.id}/facet`, { facet: 'feature' })).status, facet).toBe(409);
    }
  });

  it('a reader cannot set it', async () => {
    const s = await setup();
    const viewer = client();
    const viewerId = (await viewer.post('/host/openwop-app/test/login', { email: `flv-${n++}@acme.test`, tenantId: s.tenantId })).body.user.userId as string;
    await createMember({ tenantId: s.tenantId, orgId: s.orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
    expect((await viewer.put(`${P}/${s.projectId}/facet`, { facet: 'feature' })).status).toBe(403);
  });
});
