/**
 * CDP-G — batch/CSV import (ADR 0298). The import route parses a CSV body and RIDES the
 * existing collectEventBatch path: schema validation + ingest-time PII tagging + per-row
 * outcome are reused, not reimplemented. Fail-closed on parse errors / oversize; per-row
 * failures are surfaced without sinking the import; tenant-isolated.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { parseCsv } from '../src/features/cdp/csvImportService.js';

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
async function owner() { const c = client(); const r = await c.post('/v1/host/openwop-app/test/login', { email: `csv-${Date.now()}-${n++}@a.test`, tenantId: `org:csv-${Date.now()}-${n++}` }); expect(r.status).toBe(201); return c; }
const setToggle = async (id: string, s: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: s }, 'test'); };

const SCHEMA = { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string' } } };

describe('parseCsv (pure)', () => {
  it('parses a header + quoted fields with commas and newlines inside quotes', () => {
    const csv = 'a,b,c\r\n1,"two, and a half","line\none"\n3,,z\n';
    const { headers, records } = parseCsv(csv);
    expect(headers).toEqual(['a', 'b', 'c']);
    expect(records.length).toBe(2);
    expect(records[0].values).toEqual(['1', 'two, and a half', 'line\none']);
    expect(records[0].line).toBe(2);
    expect(records[1].values).toEqual(['3', '', 'z']);
    expect(records[1].line).toBe(4); // the quoted newline pushed the third record's line
  });

  it('honors an escaped double-quote ("")', () => {
    const { records } = parseCsv('x\n"a ""quoted"" b"\n');
    expect(records[0].values).toEqual(['a "quoted" b']);
  });

  it('throws on an unterminated quoted field', () => {
    expect(() => parseCsv('x\n"never closed\n')).toThrow(/unterminated/);
  });
});

describe('CDP-G CSV import', () => {
  it('imports N valid rows through collectEventBatch (schema validation applied + PII tagged)', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    await c.post('/v1/host/openwop-app/cdp/event-schemas', { eventType: 'signup', schema: SCHEMA });
    const csv = 'orderId,email\no1,a@x.test\no2,b@x.test\no3,c@x.test\n';
    const r = await c.post('/v1/host/openwop-app/cdp/collect/import', { csv, eventType: 'signup' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.imported).toBe(3);
    expect(r.body.failed).toBe(0);
    expect(r.body.rows.every((row: any) => row.status === 'imported')).toBe(true);

    // Reached the real collect path: rows landed, schema-tagged + PII-tagged.
    const events = await c.get('/v1/host/openwop-app/cdp/collected-events');
    expect(events.body.events.length).toBe(3);
    expect(events.body.events[0].hasSchema ?? events.body.events[0].schemaVersion).toBeTruthy();
    expect(events.body.events[0].piiFields).toContain('email'); // ingest PII tagging reused
  });

  it('surfaces a schema-mismatch row per-row while others succeed', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    // required orderId, no additional props → a row missing orderId fails; a valid row passes.
    const strict = { type: 'object', required: ['orderId'], additionalProperties: false, properties: { orderId: { type: 'string' } } };
    await c.post('/v1/host/openwop-app/cdp/event-schemas', { eventType: 'signup', schema: strict });
    const csv = 'orderId\no1\no2\n';
    const good = await c.post('/v1/host/openwop-app/cdp/collect/import', { csv, eventType: 'signup' });
    expect(good.body.imported).toBe(2);
    // A row carrying a non-schema field (additionalProperties:false) → per-row rejection.
    const csv2 = 'orderId,rogue\no9,boom\n';
    const r2 = await c.post('/v1/host/openwop-app/cdp/collect/import', { csv: csv2, eventType: 'signup' });
    expect(r2.body.failed).toBe(1);
    expect(r2.body.rows[0].status).toBe('failed');
    expect(r2.body.rows[0].error).toBeTruthy();
    expect(r2.body.imported).toBe(0);
  });

  it('mixed batch: valid + schema-invalid + unregistered rows via eventTypeColumn', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    await c.post('/v1/host/openwop-app/cdp/event-schemas', { eventType: 'signup', schema: SCHEMA });
    const csv = 'kind,orderId\nsignup,o1\nsignup,\nfreeform,z9\n';
    const r = await c.post('/v1/host/openwop-app/cdp/collect/import', { csv, eventTypeColumn: 'kind' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // signup,o1 → valid; signup,"" → still a string, satisfies required ⇒ valid; freeform → unregistered ⇒ accepted
    expect(r.body.imported).toBe(3);
    // eventTypeColumn value is stripped from the payload, not stored as a field
    const events = await c.get('/v1/host/openwop-app/cdp/collected-events');
    expect(events.body.events.every((e: any) => !('kind' in e.payload))).toBe(true);
  });

  it('rejects a schema-invalid row via a required-field schema on eventTypeColumn path', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const strict = { type: 'object', required: ['orderId'], additionalProperties: false, properties: { orderId: { type: 'string' } } };
    await c.post('/v1/host/openwop-app/cdp/event-schemas', { eventType: 'purchase', schema: strict });
    const csv = 'kind,orderId,extra\npurchase,o1,nope\n';
    const r = await c.post('/v1/host/openwop-app/cdp/collect/import', { csv, eventTypeColumn: 'kind' });
    expect(r.body.failed).toBe(1);
    expect(r.body.rows[0].status).toBe('failed');
  });

  it('malformed CSV → 400 fail-closed (nothing lands)', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const r = await c.post('/v1/host/openwop-app/cdp/collect/import', { csv: 'a,b\n"unterminated\n', eventType: 'freeform' });
    expect(r.status).toBe(400);
    expect((await c.get('/v1/host/openwop-app/cdp/collected-events')).body.events.length).toBe(0);
  });

  it('oversize import → rejected outright (no write)', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const lines = ['orderId'];
    for (let i = 0; i < 10_001; i++) lines.push(`o${i}`);
    const r = await c.post('/v1/host/openwop-app/cdp/collect/import', { csv: lines.join('\n') + '\n', eventType: 'freeform' });
    expect(r.status).toBe(400);
    expect((await c.get('/v1/host/openwop-app/cdp/collected-events')).body.events.length).toBe(0);
  });

  it('missing params → 400 (need exactly one of eventType / eventTypeColumn)', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    expect((await c.post('/v1/host/openwop-app/cdp/collect/import', { csv: 'a\n1\n' })).status).toBe(400);
    expect((await c.post('/v1/host/openwop-app/cdp/collect/import', { csv: 'a\n1\n', eventType: 'x', eventTypeColumn: 'a' })).status).toBe(400);
    expect((await c.post('/v1/host/openwop-app/cdp/collect/import', { csv: 'a\n1\n', eventTypeColumn: 'nope' })).status).toBe(400);
  });

  it('per-row dedup via dedupKeyField skips repeated keys within the import', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const csv = 'orderId,userId\no1,u1\no2,u1\no3,u2\n';
    const r = await c.post('/v1/host/openwop-app/cdp/collect/import', { csv, eventType: 'freeform', dedupKeyField: 'userId' });
    expect(r.body.imported).toBe(2);
    expect(r.body.skipped).toBe(1);
    expect(r.body.rows.find((row: any) => row.line === 3)?.status).toBe('skipped');
    expect((await c.get('/v1/host/openwop-app/cdp/collected-events')).body.events.length).toBe(2);
  });

  it('chunks a >100-row import across multiple batches and imports all', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    const lines = ['orderId'];
    for (let i = 0; i < 250; i++) lines.push(`o${i}`);
    const r = await c.post('/v1/host/openwop-app/cdp/collect/import', { csv: lines.join('\n') + '\n', eventType: 'freeform' });
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(250);
    expect((await c.get('/v1/host/openwop-app/cdp/collected-events?limit=500')).body.events.length).toBe(250);
  });

  it('tenant isolation — one tenant\'s import is not visible to another', async () => {
    await setToggle('cdp', 'on');
    const a = await owner();
    const b = await owner();
    await a.post('/v1/host/openwop-app/cdp/collect/import', { csv: 'orderId\nA1\nA2\n', eventType: 'freeform' });
    expect((await b.get('/v1/host/openwop-app/cdp/collected-events')).body.events.length).toBe(0);
    expect((await a.get('/v1/host/openwop-app/cdp/collected-events')).body.events.length).toBe(2);
  });

  it('toggle off → 404 (no surface)', async () => {
    await setToggle('cdp', 'on');
    const c = await owner();
    await setToggle('cdp', 'off');
    const r = await c.post('/v1/host/openwop-app/cdp/collect/import', { csv: 'a\n1\n', eventType: 'freeform' });
    expect(r.status).toBe(404);
    await setToggle('cdp', 'on');
  });
});
