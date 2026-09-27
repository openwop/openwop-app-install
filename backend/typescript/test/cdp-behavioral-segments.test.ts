/**
 * CDP-C Phase 0 — behavioral/calculated segment traits (ADR 0265). ROUTE-level:
 * numeric comparison ops (gt/lt/gte/lte) over calculated traits (identifierCount,
 * daysSinceCreated) resolve the right live membership; numeric ops reject a
 * non-numeric value at the write boundary.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

let n = 0;
async function owner() {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `cdpc-${Date.now()}-${n++}@a.test`, tenantId: `org:cdpc-${Date.now()}-${n++}` });
  expect(r.status).toBe(201);
  return c;
}
const enable = async (id: string) => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); };
const members = async (c: ReturnType<typeof client>, id: string) => (await c.get(`/v1/host/openwop-app/crm/segments/${id}/members`)).body.members as { contactId: string }[];

describe('CDP-C behavioral/calculated segment traits', () => {
  it('numeric ops over identifierCount select the right members', async () => {
    await enable('crm');
    const c = await owner();
    const a = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'A', email: 'a@x.test' })).body; // identifierCount = 1
    const b = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'B', email: 'b@x.test' })).body;
    await c.post(`/v1/host/openwop-app/crm/contacts/${b.contactId}/identifiers`, { type: 'phone', value: '+15550001' });
    await c.post(`/v1/host/openwop-app/crm/contacts/${b.contactId}/identifiers`, { type: 'loyalty', value: 'L1' }); // B = 3

    const seg = (await c.post('/v1/host/openwop-app/crm/segments', { name: 'multi-id', filters: [{ field: 'identifierCount', op: 'gte', value: '2' }] })).body;
    const ids = (await members(c, seg.segmentId)).map((m) => m.contactId);
    expect(ids).toContain(b.contactId);
    expect(ids).not.toContain(a.contactId);
  });

  it('daysSinceCreated recency: just-created contacts are < 1 day old, not > 0', async () => {
    await enable('crm');
    const c = await owner();
    await c.post('/v1/host/openwop-app/crm/contacts', { name: 'New', email: 'new@x.test' });
    const fresh = (await c.post('/v1/host/openwop-app/crm/segments', { name: 'fresh', filters: [{ field: 'daysSinceCreated', op: 'lt', value: '1' }] })).body;
    const old = (await c.post('/v1/host/openwop-app/crm/segments', { name: 'old', filters: [{ field: 'daysSinceCreated', op: 'gt', value: '0' }] })).body;
    expect((await members(c, fresh.segmentId)).length).toBeGreaterThanOrEqual(1);
    expect((await members(c, old.segmentId)).length).toBe(0);
  });

  it('rejects a non-numeric value for a numeric op at the write boundary', async () => {
    await enable('crm');
    const c = await owner();
    const bad = await c.post('/v1/host/openwop-app/crm/segments', { name: 'bad', filters: [{ field: 'identifierCount', op: 'gt', value: 'lots' }] });
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
  });
});
