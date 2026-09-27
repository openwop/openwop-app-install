/**
 * CDP-G Phase 1 — event schema registry (ADR 0269). Register versioned per-tenant
 * event schemas; validate payloads at the ingest contract; an unregistered event
 * type passes (no contract ⇒ no rejection); versions increment.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registerEventSchema, listEventSchemas, getEventSchema } from '../src/features/cdp/eventSchemaService.js';

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
async function owner() { const c = client(); const r = await c.post('/v1/host/openwop-app/test/login', { email: `g-${Date.now()}-${n++}@a.test`, tenantId: `org:g-${Date.now()}-${n++}` }); expect(r.status).toBe(201); return c; }
const setToggle = async (id: string, s: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: s }, 'test'); };

const ORDER_SCHEMA = { type: 'object', required: ['orderId', 'amount'], properties: { orderId: { type: 'string' }, amount: { type: 'number' } } };

describe('CDP-G event schema registry', () => {
  it('registers, validates conforming/non-conforming payloads, and versions', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const reg = await c.post('/v1/host/openwop-app/cdp/event-schemas', { eventType: 'order.created', schema: ORDER_SCHEMA });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    expect(reg.body.version).toBe(1);

    const good = await c.post('/v1/host/openwop-app/cdp/event-schemas/order.created/validate', { payload: { orderId: 'o1', amount: 5 } });
    expect(good.status).toBe(200);
    expect(good.body.valid).toBe(true);
    expect(good.body.hasSchema).toBe(true);

    const bad = await c.post('/v1/host/openwop-app/cdp/event-schemas/order.created/validate', { payload: { orderId: 'o1' } });
    expect(bad.status).toBe(422);
    expect(bad.body.valid).toBe(false);
    expect(bad.body.errors.length).toBeGreaterThan(0);

    // re-register → version 2; list surfaces the latest
    const reg2 = await c.post('/v1/host/openwop-app/cdp/event-schemas', { eventType: 'order.created', schema: ORDER_SCHEMA });
    expect(reg2.body.version).toBe(2);
    const list = await c.get('/v1/host/openwop-app/cdp/event-schemas');
    expect(list.body.schemas.find((s: any) => s.eventType === 'order.created').version).toBe(2);
  });

  it('an unregistered event type passes (no contract ⇒ no rejection)', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const r = await c.post('/v1/host/openwop-app/cdp/event-schemas/never.registered/validate', { payload: { anything: true } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ valid: true, hasSchema: false });
  });

  it('rejects a non-object schema at registration', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const r = await c.post('/v1/host/openwop-app/cdp/event-schemas', { eventType: 'bad', schema: 'not-a-schema' });
    expect(r.status).toBe(400);
  });

  it('is toggle-gated (cdp OFF ⇒ 404)', async () => {
    await setToggle('cdp', 'off');
    const c = await owner();
    expect((await c.get('/v1/host/openwop-app/cdp/event-schemas')).status).toBe(404);
    await setToggle('cdp', 'on');
  });

  // Concurrency: N simultaneous registrations of the SAME eventType must mint N
  // DISTINCT versions — the pre-fix read→put clobbered the loser on the shared key.
  it('concurrent registrations of one event type mint distinct contiguous versions (no clobber)', async () => {
    const tenantId = `org:concurrency-${Date.now()}`;
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () => registerEventSchema(tenantId, 'race.type', { type: 'object' })),
    );
    const versions = results.map((r) => r.version).sort((a, b) => a - b);
    // every version 1..N present exactly once — none lost to a clobber
    expect(versions).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    // and the store agrees: the latest is N, and every version is independently readable
    expect((await getEventSchema(tenantId, 'race.type'))?.version).toBe(N);
    for (let v = 1; v <= N; v++) expect((await getEventSchema(tenantId, 'race.type', v))?.version).toBe(v);
    expect((await listEventSchemas(tenantId)).find((s) => s.eventType === 'race.type')?.version).toBe(N);
  });
});
