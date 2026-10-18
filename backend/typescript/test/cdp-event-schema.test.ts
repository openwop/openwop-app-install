/**
 * CDP-G Phase 1 — event schema registry (ADR 0269). Register versioned per-tenant
 * event schemas; validate payloads at the ingest contract; an unregistered event
 * type passes (no contract ⇒ no rejection); versions increment.
 *
 * Sabotage that reds it (w38 probes): version mint `+ 1` → `+ 2`; the insert-if-absent
 * CAS → a blind `put` (the concurrency case — the pre-fix read→put clobber); validate
 * ignoring the payload; the route answering 200 for an invalid payload; an
 * unregistered type claiming `hasSchema`; the object-shape guard in `assertCompiles`
 * (asserted by its own message — `ajv.compile` ALSO rejects a string with a 400, so a
 * status-only check could not tell the two guards apart); dropping the toggle gate;
 * the list picking the oldest version.
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

interface Res { status: number; body: unknown }
interface ValidateBody { valid: boolean; hasSchema: boolean; version?: number; errors?: { path: string; message: string }[] }
interface ErrBody { error: string; message: string }
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
async function owner() { const c = client(); const r = await c.post('/host/openwop-app/test/login', { email: `g-${Date.now()}-${n++}@a.test`, tenantId: `org:g-${Date.now()}-${n++}` }); expect(r.status).toBe(201); return c; }
const setToggle = async (id: string, s: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: s }, 'test'); };

const ORDER_SCHEMA = { type: 'object', required: ['orderId', 'amount'], properties: { orderId: { type: 'string' }, amount: { type: 'number' } } };

describe('CDP-G event schema registry', () => {
  it('registers, validates conforming/non-conforming payloads, and versions', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const reg = await c.post('/host/openwop-app/cdp/event-schemas', { eventType: 'order.created', schema: ORDER_SCHEMA });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    expect((reg.body as { version: number }).version).toBe(1);

    const good = await c.post('/host/openwop-app/cdp/event-schemas/order.created/validate', { payload: { orderId: 'o1', amount: 5 } });
    expect(good.status).toBe(200);
    expect(good.body).toEqual({ valid: true, hasSchema: true, version: 1 });

    const bad = await c.post('/host/openwop-app/cdp/event-schemas/order.created/validate', { payload: { orderId: 'o1' } });
    expect(bad.status).toBe(422);
    const badBody = bad.body as ValidateBody;
    expect(badBody.valid).toBe(false);
    expect(badBody.hasSchema).toBe(true);
    expect(badBody.errors).toContainEqual({ path: '(root)', message: "must have required property 'amount'" });

    // re-register → version 2; list surfaces the latest
    const reg2 = await c.post('/host/openwop-app/cdp/event-schemas', { eventType: 'order.created', schema: ORDER_SCHEMA });
    expect((reg2.body as { version: number }).version).toBe(2);
    const list = await c.get('/host/openwop-app/cdp/event-schemas');
    const schemas = (list.body as { schemas: { eventType: string; version: number }[] }).schemas;
    expect(schemas.find((s) => s.eventType === 'order.created')?.version).toBe(2);
  });

  it('an unregistered event type passes (no contract ⇒ no rejection)', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const r = await c.post('/host/openwop-app/cdp/event-schemas/never.registered/validate', { payload: { anything: true } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ valid: true, hasSchema: false });
  });

  it('rejects a non-object schema at registration', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const r = await c.post('/host/openwop-app/cdp/event-schemas', { eventType: 'bad', schema: 'not-a-schema' });
    expect(r.status).toBe(400);
    // The object-shape guard's OWN message — the ajv-compile catch answers 400 too,
    // with 'schema does not compile: …', so the status alone cannot witness this guard.
    expect(r.body).toMatchObject({ error: 'validation_error', message: 'schema must be a JSON Schema object.' } satisfies ErrBody);
  });

  it('is toggle-gated (cdp OFF ⇒ 404)', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    // positive control: the same caller reads the registry while the toggle is on
    expect((await c.get('/host/openwop-app/cdp/event-schemas')).status).toBe(200);
    await setToggle('cdp', 'off');
    try {
      const off = await c.get('/host/openwop-app/cdp/event-schemas');
      expect(off.status).toBe(404);
      expect(off.body).toEqual({ error: 'not_found', message: 'CDP is not enabled for this tenant.', details: { feature: 'cdp' } });
    } finally {
      await setToggle('cdp', 'on');
    }
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
