/**
 * CDP-B — probabilistic match candidates (ADR 0264). ROUTE-level: the generator
 * PROPOSES scored likely-dupes (shared identifier; similar name+company) beyond
 * exact-email, excludes exact-email dupes, and never mutates. Deterministic.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users'); if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (m: string, p: string, b?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
let n = 0;
async function owner() { const c = client(); const r = await c.post('/v1/host/openwop-app/test/login', { email: `b-${Date.now()}-${n++}@a.test`, tenantId: `org:b-${Date.now()}-${n++}` }); expect(r.status).toBe(201); return c; }
const enable = async (id: string) => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); };

describe('CDP-B match candidates', () => {
  it('proposes shared-identifier and name+company dupes; excludes exact-email and dissimilar', async () => {
    await enable('crm');
    const c = await owner();
    const j1 = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'John Smith', email: 'j1@x.test', company: 'Acme' })).body;
    const j2 = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'Jon Smith', email: 'j2@x.test', company: 'Acme' })).body;
    await c.post(`/v1/host/openwop-app/crm/contacts/${j1.contactId}/identifiers`, { type: 'phone', value: '+1 (555) 111-0000' });
    await c.post(`/v1/host/openwop-app/crm/contacts/${j2.contactId}/identifiers`, { type: 'phone', value: '+15551110000' }); // normalizes to the same digits
    await c.post('/v1/host/openwop-app/crm/contacts', { name: 'Jane Doe', email: 'jane@x.test', company: 'Globex' });

    const r = await c.get('/v1/host/openwop-app/crm/match-candidates');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const cands = r.body.candidates as { a: { contactId: string; name: string }; b: { contactId: string; name: string }; reason: string; score: number }[];
    // the Smith pair is surfaced (shared phone → strong)
    const smith = cands.find((x) => [x.a.contactId, x.b.contactId].sort().join() === [j1.contactId, j2.contactId].sort().join());
    expect(smith).toBeTruthy();
    expect(smith!.reason).toBe('shared-identifier');
    expect(smith!.score).toBeGreaterThanOrEqual(0.9);
    // Jane Doe pairs with nobody
    const janeInvolved = cands.filter((x) => x.a.name === 'Jane Doe' || x.b.name === 'Jane Doe');
    expect(janeInvolved.length).toBe(0);
  });

  it('is deterministic and excludes exact-email dupes', async () => {
    await enable('crm');
    const c = await owner();
    const dup = 'dup@x.test';
    await c.post('/v1/host/openwop-app/crm/contacts', { name: 'A', email: dup });
    await c.post('/v1/host/openwop-app/crm/contacts', { name: 'B', email: dup }); // exact-email dupe — NOT a probabilistic candidate
    const r1 = (await c.get('/v1/host/openwop-app/crm/match-candidates')).body.candidates;
    const r2 = (await c.get('/v1/host/openwop-app/crm/match-candidates')).body.candidates;
    expect(r1).toEqual(r2); // deterministic
    expect(r1.length).toBe(0); // the only pair is exact-email → owned by findDuplicateContacts
  });
});
