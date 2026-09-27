/**
 * CDP-B — merge-event audit (ADR 0264). Every contact merge records what it did:
 * the survivor fields it filled and the identifiers it absorbed (the substrate a
 * future unmerge replays).
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
async function owner() { const c = client(); const r = await c.post('/v1/host/openwop-app/test/login', { email: `me-${Date.now()}-${n++}@a.test`, tenantId: `org:me-${Date.now()}-${n++}` }); expect(r.status).toBe(201); return c; }
const enable = async (id: string) => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); };

describe('CDP-B merge-event audit', () => {
  it('records the filled fields and absorbed identifiers of a merge', async () => {
    await enable('crm');
    const c = await owner();
    const survivor = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'S' })).body; // no email/company
    const source = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'D', email: 'd@x.test', company: 'Acme' })).body;
    await c.post(`/v1/host/openwop-app/crm/contacts/${source.contactId}/identifiers`, { type: 'loyalty', value: 'L9' });

    const merged = await c.post(`/v1/host/openwop-app/crm/contacts/${survivor.contactId}/merge`, { sourceContactId: source.contactId });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);

    const events = (await c.get('/v1/host/openwop-app/crm/merge-events')).body.events;
    expect(events.length).toBe(1);
    const ev = events[0];
    expect(ev.survivorId).toBe(survivor.contactId);
    expect(ev.sourceId).toBe(source.contactId);
    // survivor was blank → filled email + company from source
    expect(ev.filledFields.email).toBe('d@x.test');
    expect(ev.filledFields.company).toBe('Acme');
    // the source's loyalty id was absorbed
    expect(ev.absorbedIdentifiers.some((i: any) => i.type === 'loyalty' && i.value === 'L9')).toBe(true);
  });
});
