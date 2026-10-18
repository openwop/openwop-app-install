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

interface Res<T = unknown> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return { get: <T,>(p: string) => call<T>('GET', p), post: <T,>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

let n = 0;
async function owner() {
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: `cdpc-${Date.now()}-${n++}@a.test`, tenantId: `org:cdpc-${Date.now()}-${n++}` });
  expect(r.status).toBe(201);
  return c;
}
const enable = async (id: string) => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); };
const members = async (c: ReturnType<typeof client>, id: string): Promise<string[]> =>
  (await c.get<{ members: { contactId: string }[] }>(`/host/openwop-app/crm/segments/${id}/members`)).body.members.map((m) => m.contactId);
async function contact(c: ReturnType<typeof client>, body: Record<string, string>): Promise<string> {
  const r = await c.post<{ contactId: string }>('/host/openwop-app/crm/contacts', body);
  expect(r.status).toBe(201);
  return r.body.contactId;
}
async function segment(c: ReturnType<typeof client>, name: string, field: string, op: string, value: string): Promise<string> {
  const r = await c.post<{ segmentId: string }>('/host/openwop-app/crm/segments', { name, filters: [{ field, op, value }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.segmentId;
}

describe('CDP-C behavioral/calculated segment traits', () => {
  it('numeric ops over identifierCount select the right members', async () => {
    await enable('crm');
    const c = await owner();
    const a = await contact(c, { name: 'A', email: 'a@x.test' }); // identifierCount = 1
    const two = await contact(c, { name: 'Two', email: 't@x.test' });
    await c.post(`/host/openwop-app/crm/contacts/${two}/identifiers`, { type: 'phone', value: '+15550002' }); // Two = 2 (the gte boundary)
    const b = await contact(c, { name: 'B', email: 'b@x.test' });
    await c.post(`/host/openwop-app/crm/contacts/${b}/identifiers`, { type: 'phone', value: '+15550001' });
    await c.post(`/host/openwop-app/crm/contacts/${b}/identifiers`, { type: 'loyalty', value: 'L1' }); // B = 3

    const gte2 = await members(c, await segment(c, 'multi-id', 'identifierCount', 'gte', '2'));
    expect([...gte2].sort()).toEqual([two, b].sort());
    const lte1 = await members(c, await segment(c, 'single-id', 'identifierCount', 'lte', '1'));
    expect(lte1).toEqual([a]);
  });

  it('daysSinceCreated recency: just-created contacts are < 1 day old, not > 0', async () => {
    await enable('crm');
    const c = await owner();
    const id = await contact(c, { name: 'New', email: 'new@x.test' });
    expect(await members(c, await segment(c, 'fresh', 'daysSinceCreated', 'lt', '1'))).toEqual([id]);
    expect(await members(c, await segment(c, 'old', 'daysSinceCreated', 'gt', '0'))).toEqual([]);
    // the lt/lte boundary at age 0: strictly-less excludes, less-or-equal includes
    expect(await members(c, await segment(c, 'neg', 'daysSinceCreated', 'lt', '0'))).toEqual([]);
    expect(await members(c, await segment(c, 'zero', 'daysSinceCreated', 'lte', '0'))).toEqual([id]);
  });

  it('rejects a non-numeric value for a numeric op at the write boundary', async () => {
    await enable('crm');
    const c = await owner();
    const bad = await c.post<{ message?: string }>('/host/openwop-app/crm/segments', { name: 'bad', filters: [{ field: 'identifierCount', op: 'gt', value: 'lots' }] });
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    expect(bad.body.message).toBe('filter.value must be numeric for op `gt`.');
  });
});
