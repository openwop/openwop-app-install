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
import type { BatchItemResult, CollectedEvent } from '../src/features/cdp/collectService.js';

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

/** Every shape these cases read: collect result, batch summary, event list, error envelope. */
interface Body {
  hasSchema?: boolean; schemaVersion?: number; piiFields?: string[];
  accepted?: number; rejected?: number; results?: BatchItemResult[];
  events?: CollectedEvent[];
  error?: string; message?: string;
}
interface Res { status: number; body: Body }
function client() {
  let cookie = '';
  const call = async (m: string, p: string, b?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Body };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
let n = 0;
async function owner() { const c = client(); const r = await c.post('/host/openwop-app/test/login', { email: `col-${Date.now()}-${n++}@a.test`, tenantId: `org:col-${Date.now()}-${n++}` }); expect(r.status).toBe(201); return c; }
const setToggle = async (id: string, s: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: s }, 'test'); };

const SCHEMA = { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string' } } };
const listEvents = async (c: ReturnType<typeof client>): Promise<CollectedEvent[]> => (await c.get('/host/openwop-app/cdp/collected-events')).body.events ?? [];

describe('CDP-G collect', () => {
  it('accepts a schema-valid event and PII-tags the payload', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    await c.post('/host/openwop-app/cdp/event-schemas', { eventType: 'signup', schema: SCHEMA });
    const r = await c.post('/host/openwop-app/cdp/collect', { eventType: 'signup', payload: { orderId: 'o1', email: 'a@x.test' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.hasSchema).toBe(true);
    expect(r.body.piiFields).toContain('email'); // ingest PII tagging

    // read back what was STORED, not just the write's own response
    const stored = await listEvents(c);
    expect(stored.length).toBe(1);
    expect(stored[0]).toMatchObject({ eventType: 'signup', piiFields: ['email'], schemaVersion: 1, payload: { orderId: 'o1', email: 'a@x.test' } });
  });

  it('rejects a schema-invalid event (422)', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    await c.post('/host/openwop-app/cdp/event-schemas', { eventType: 'signup', schema: SCHEMA });
    const r = await c.post('/host/openwop-app/cdp/collect', { eventType: 'signup', payload: { notOrderId: true } });
    expect(r.status).toBe(422);
    expect(r.body.message).toBe('event failed its registered schema (v1).');
    expect(await listEvents(c)).toEqual([]); // nothing landed
  });

  it('accepts an unregistered event type (no contract ⇒ no rejection)', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const r = await c.post('/host/openwop-app/cdp/collect', { eventType: 'freeform', payload: { anything: 1 } });
    expect(r.status).toBe(201);
    expect(r.body.hasSchema).toBe(false);
  });

  it('batch: best-effort per row — one schema failure does not sink the rest', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    await c.post('/host/openwop-app/cdp/event-schemas', { eventType: 'signup', schema: SCHEMA });
    const r = await c.post('/host/openwop-app/cdp/collect/batch', { events: [
      { eventType: 'signup', payload: { orderId: 'o1' } },   // valid
      { eventType: 'signup', payload: { notOrderId: true } }, // schema-invalid → rejected
      { eventType: 'freeform', payload: { x: 1 } },           // unregistered → accepted
    ] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.accepted).toBe(2);
    expect(r.body.rejected).toBe(1);
    const results = r.body.results ?? [];
    expect(results[0]).toMatchObject({ index: 0, ok: true });
    expect(results[1]).toMatchObject({ index: 1, ok: false, error: { code: 'validation_error', message: 'event failed its registered schema (v1).' } });
    expect(results[2]).toMatchObject({ index: 2, ok: true, hasSchema: false });
    // only the two accepted rows landed
    expect((await listEvents(c)).length).toBe(2);
  });

  it('batch: rejects an oversize batch outright (no silent truncation)', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const events = Array.from({ length: 101 }, (_, i) => ({ eventType: 'freeform', payload: { i } }));
    const r = await c.post('/host/openwop-app/cdp/collect/batch', { events });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('at most 100 events per batch.');
    // nothing landed — rejected before any write
    expect(await listEvents(c)).toEqual([]);
  });

  it('batch: a non-array / empty events body is a 400', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const notArray = await c.post('/host/openwop-app/cdp/collect/batch', { events: 'nope' });
    expect(notArray.status).toBe(400);
    expect(notArray.body.message).toBe('events must be an array.');
    const empty = await c.post('/host/openwop-app/cdp/collect/batch', { events: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.message).toBe('events must be a non-empty array.');
  });
});
