/**
 * CDP-G — event collection (ADR 0269). The generic ingest enforces the schema
 * registry at the door (422 on mismatch; unregistered passes) and PII-tags the
 * payload at ingest.
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
async function owner() { const c = client(); const r = await c.post('/v1/host/openwop-app/test/login', { email: `col-${Date.now()}-${n++}@a.test`, tenantId: `org:col-${Date.now()}-${n++}` }); expect(r.status).toBe(201); return c; }
const setToggle = async (id: string, s: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: s }, 'test'); };

const SCHEMA = { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string' } } };

describe('CDP-G collect', () => {
  it('accepts a schema-valid event and PII-tags the payload', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    await c.post('/v1/host/openwop-app/cdp/event-schemas', { eventType: 'signup', schema: SCHEMA });
    const r = await c.post('/v1/host/openwop-app/cdp/collect', { eventType: 'signup', payload: { orderId: 'o1', email: 'a@x.test' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.hasSchema).toBe(true);
    expect(r.body.piiFields).toContain('email'); // ingest PII tagging

    const events = await c.get('/v1/host/openwop-app/cdp/collected-events');
    expect(events.body.events.length).toBe(1);
  });

  it('rejects a schema-invalid event (422)', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    await c.post('/v1/host/openwop-app/cdp/event-schemas', { eventType: 'signup', schema: SCHEMA });
    const r = await c.post('/v1/host/openwop-app/cdp/collect', { eventType: 'signup', payload: { notOrderId: true } });
    expect(r.status).toBe(422);
  });

  it('accepts an unregistered event type (no contract ⇒ no rejection)', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const r = await c.post('/v1/host/openwop-app/cdp/collect', { eventType: 'freeform', payload: { anything: 1 } });
    expect(r.status).toBe(201);
    expect(r.body.hasSchema).toBe(false);
  });

  it('batch: best-effort per row — one schema failure does not sink the rest', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    await c.post('/v1/host/openwop-app/cdp/event-schemas', { eventType: 'signup', schema: SCHEMA });
    const r = await c.post('/v1/host/openwop-app/cdp/collect/batch', { events: [
      { eventType: 'signup', payload: { orderId: 'o1' } },   // valid
      { eventType: 'signup', payload: { notOrderId: true } }, // schema-invalid → rejected
      { eventType: 'freeform', payload: { x: 1 } },           // unregistered → accepted
    ] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.accepted).toBe(2);
    expect(r.body.rejected).toBe(1);
    expect(r.body.results[0]).toMatchObject({ index: 0, ok: true });
    expect(r.body.results[1]).toMatchObject({ index: 1, ok: false });
    expect(r.body.results[1].error.code).toBe('validation_error');
    expect(r.body.results[2]).toMatchObject({ index: 2, ok: true, hasSchema: false });
    // only the two accepted rows landed
    expect((await c.get('/v1/host/openwop-app/cdp/collected-events')).body.events.length).toBe(2);
  });

  it('batch: rejects an oversize batch outright (no silent truncation)', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const events = Array.from({ length: 101 }, (_, i) => ({ eventType: 'freeform', payload: { i } }));
    const r = await c.post('/v1/host/openwop-app/cdp/collect/batch', { events });
    expect(r.status).toBe(400);
    // nothing landed — rejected before any write
    expect((await c.get('/v1/host/openwop-app/cdp/collected-events')).body.events.length).toBe(0);
  });

  it('batch: a non-array / empty events body is a 400', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    expect((await c.post('/v1/host/openwop-app/cdp/collect/batch', { events: 'nope' })).status).toBe(400);
    expect((await c.post('/v1/host/openwop-app/cdp/collect/batch', { events: [] })).status).toBe(400);
  });
});
