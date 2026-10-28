/**
 * ADR 0825 / RFC 0236 §G — the host-event emit seam
 * (`POST /conformance/seams/sample/host-events/emit`) and the `example.*` pair.
 *
 *   - Gate: without `OPENWOP_TEST_SEAM_ENABLED` the seam is a route-miss (404
 *     not_found), with a positive control that the same request is served when
 *     the gate is on.
 *   - The `example.*` types are advertised only with the seams profile AND
 *     `OPENWOP_HOST_EVENTS_V2`.
 *   - `example.thing-happened` (durable) reaches a major-2 subscription naming it
 *     as a schema-valid `{ hostEvent }`, and the stream.
 *   - `example.thing-noticed` (ephemeral) reaches the stream with no `id:`, and
 *     never a webhook — with the durable twin as the positive control.
 *   - Registration refuses the ephemeral type and accepts the durable one.
 *   - Tenant isolation, with a positive control.
 *
 * Tenant isolation is a DOUBLE guard in `routes/webhooks.ts` `fanOutHostEvent`:
 * the tenant-scoped `listWebhooks({ tenantId })` AND the in-loop
 * `sub.tenantId !== tenantId` check. Only breaking both reds the webhook leg;
 * the stream leg rests on `hostEventStream.ts`'s subscriber tenant filter.
 *
 * Tracker TST-BHE-3. Sabotage-witnessed (w62): red when the seam gate is
 * removed, an ephemeral event is webhooked or framed with `id:`, the example
 * types are advertised without the seams profile or the flag, registration
 * admits an ephemeral type, or either tenant guard (both webhook guards, or the
 * stream filter) is removed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Express } from 'express';
import { createApp, type AppConfig } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { getSetCookies } from './headerCookies.js';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import type { HostEventEnvelope } from '../src/host/hostEventTypes.js';

const V2 = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas', 'v2');
const AJV = new Ajv2020({ strict: false, allErrors: true });
addFormats(AJV);
for (const f of readdirSync(V2)) {
  if (!f.endsWith('.json')) continue;
  try { AJV.addSchema(JSON.parse(readFileSync(join(V2, f), 'utf8')) as Record<string, unknown>, f); } catch { /* sibling's problem */ }
}
function schema(file: string) {
  const id = (JSON.parse(readFileSync(join(V2, file), 'utf8')) as { $id?: string }).$id;
  const fn = (id ? AJV.getSchema(id) : undefined) ?? AJV.getSchema(file);
  if (!fn) throw new Error(`${file} did not register`);
  return fn;
}
const validateDelivery = schema('webhook-delivery.schema.json');
const validateHostEvent = schema('host-event.schema.json');
const validateCaps = schema('capabilities.schema.json');

const SEAM = '/conformance/seams/sample/host-events/emit';
/** The suite's own reader (`lib/error-envelope.ts`): `error` as a string, or `error.code`. */
const codeOf = (body: unknown): string | undefined => {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === 'string' ? e : (e as { code?: unknown } | null | undefined)?.code as string | undefined;
};
const DURABLE = 'example.thing-happened';
const EPHEMERAL = 'example.thing-noticed';
const saved = { flag: process.env.OPENWOP_HOST_EVENTS_V2, seams: process.env.OPENWOP_TEST_SEAM_ENABLED };
const on = (): void => { process.env.OPENWOP_HOST_EVENTS_V2 = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; };

let app: Express;
let server: http.Server;
let BASE = '';
let storage: Storage;
let n = 0;

beforeAll(async () => {
  on();
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterEach(on);
afterAll(async () => {
  for (const [k, v] of [['OPENWOP_HOST_EVENTS_V2', saved.flag], ['OPENWOP_TEST_SEAM_ENABLED', saved.seams]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await new Promise<void>((res) => { server.closeAllConnections?.(); server.close(() => res()); });
});

async function login(tenantId: string): Promise<string> {
  const r = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `seam-${Date.now()}-${n++}@acme.test`, tenantId }),
  });
  expect(r.status, await r.clone().text()).toBe(201);
  for (const c of getSetCookies(r.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) return m[1]!; }
  throw new Error('no session cookie');
}
interface EmitJson { eventId: string; error?: unknown }
async function emit(cookie: string, body: unknown, path = SEAM): Promise<{ status: number; json: EmitJson }> {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(path.startsWith('/host/') ? {} : { 'openwop-version': '2' }), cookie }, body: JSON.stringify(body) });
  // A non-JSON body stays `null` (a later `.eventId` read then fails loudly).
  const json: unknown = await r.json().catch(() => null);
  return { status: r.status, json: json as EmitJson };
}
async function insertSub(id: string, tenantId: string, events: string[]): Promise<void> {
  await storage.insertWebhook({ subscriptionId: id, tenantId, url: `https://example.test/${id}`, events, secret: 's', createdAt: new Date().toISOString(), protocolMajor: 2 });
}
async function drain(): Promise<Map<string, Array<{ payload: string; eventType: string }>>> {
  const rows = await storage.claimDueWebhookDeliveries(`seam-w-${n++}`, Date.now() + 1, 60_000, 200);
  const out = new Map<string, Array<{ payload: string; eventType: string }>>();
  for (const r of rows) out.set(r.subscriptionId, [...(out.get(r.subscriptionId) ?? []), { payload: r.payload, eventType: r.eventType }]);
  return out;
}
interface Stream { text: () => string; close: () => void }
function openStream(cookie: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const req = http.get(`${BASE}/host/events`, { headers: { cookie, accept: 'text/event-stream', 'openwop-version': '2' } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d: string) => { buf += d; });
      const s: Stream = { text: () => buf, close: () => req.destroy() };
      const wait = (): void => { if (buf.includes(': open')) resolve(s); else setTimeout(wait, 5); };
      wait();
    });
    req.on('error', (e) => { if (!/socket hang up|aborted/.test(String(e))) reject(e); });
  });
}
const until = async (pred: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};
function frames(text: string): Array<{ event?: string; id?: string; data?: string }> {
  return text.split('\n\n').filter((b) => b.length > 0 && !b.startsWith(':')).map((b) => {
    const f: { event?: string; id?: string; data?: string } = {};
    for (const line of b.split('\n')) {
      if (line.startsWith('event: ')) f.event = line.slice(7);
      else if (line.startsWith('id: ')) f.id = line.slice(4);
      else if (line.startsWith('data: ')) f.data = line.slice(6);
    }
    return f;
  });
}

describe('RFC 0236 §G — the emit seam gate', () => {
  it('is a route-miss (404 not_found) without the seams gate, at both addresses; served with it', async () => {
    const cookie = await login(`org:seam-gate-${n++}`);
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    for (const path of [SEAM, '/host/sample/host-events/emit']) {
      const off = await emit(cookie, { type: DURABLE }, path);
      expect(off.status, `${path} with seams off`).toBe(404);
      expect(codeOf(off.json)).toBe('not_found');
    }
    on();
    for (const path of [SEAM, '/host/sample/host-events/emit']) {
      const served = await emit(cookie, { type: DURABLE }, path);
      expect(served.status, `${path}: ${JSON.stringify(served.json)}`).toBe(202);
      expect(typeof served.json.eventId).toBe('string');
    }
  });

  it('refuses an unadvertised type, and every type while hostEvents is not advertised', async () => {
    const cookie = await login(`org:seam-type-${n++}`);
    const unadvertised = await emit(cookie, { type: 'example.not-advertised' });
    expect(unadvertised.status).toBe(400);
    expect(codeOf(unadvertised.json)).toBe('validation_error');
    const extra = await emit(cookie, { type: DURABLE, extra: 1 });
    expect(extra.status).toBe(400);
    expect(codeOf(extra.json)).toBe('validation_error');
    delete process.env.OPENWOP_HOST_EVENTS_V2;
    const off = await emit(cookie, { type: DURABLE });
    expect(off.status).toBe(400);
    expect(codeOf(off.json)).toBe('validation_error');
  });
});

describe('RFC 0236 §G — the example.* types in the advertisement', () => {
  const CONFIG: AppConfig = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false };
  const examples = (): Array<{ type: string; delivery: string }> =>
    ((buildV2Advertisement(CONFIG).hostEvents as { types?: Array<{ type: string; delivery: string }> } | undefined)?.types ?? [])
      .filter((t) => t.type.startsWith('example.'));
  it('are advertised with the seams profile plus the flag, with their classes, and the document validates', () => {
    expect(examples()).toEqual([{ type: DURABLE, delivery: 'durable' }, { type: EPHEMERAL, delivery: 'ephemeral' }]);
    const doc = buildV2Advertisement(CONFIG);
    expect((doc.conformance as { seamsProfile?: string } | undefined)?.seamsProfile).toBe('openwop-conformance-seams-v2');
    expect(validateCaps(doc), JSON.stringify(validateCaps.errors?.slice(0, 5))).toBe(true);
  });
  it('are not advertised without the seams profile (the production types still are)', () => {
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    expect(examples()).toEqual([]);
    expect(buildV2Advertisement(CONFIG).hostEvents).toBeDefined();
  });
  it('are not advertised without the flag (hostEvents absent)', () => {
    delete process.env.OPENWOP_HOST_EVENTS_V2;
    expect('hostEvents' in buildV2Advertisement(CONFIG)).toBe(false);
  });
});

describe('RFC 0236 §C–§E — emitting the example types', () => {
  it('the durable type reaches a major-2 subscription naming it as { hostEvent }, and the stream with id:', async () => {
    const T = `org:seam-d-${n++}`;
    const cookie = await login(T);
    await insertSub('ex-durable', T, [DURABLE]);
    await drain();
    const s = await openStream(cookie);
    const r = await emit(cookie, { type: DURABLE });
    expect(r.status).toBe(202);
    const rows = (await drain()).get('ex-durable');
    expect(rows).toHaveLength(1);
    const body = JSON.parse(rows![0]!.payload) as { hostEvent: HostEventEnvelope };
    expect(validateDelivery(body), JSON.stringify(validateDelivery.errors)).toBe(true);
    expect(Object.keys(body)).toEqual(['hostEvent']);
    expect(body.hostEvent).toMatchObject({ eventId: r.json.eventId, type: DURABLE, delivery: 'durable' });
    expect(rows![0]!.eventType).toBe(DURABLE);
    await until(() => s.text().includes(r.json.eventId));
    const f = frames(s.text());
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ event: DURABLE, id: r.json.eventId });
    expect(validateHostEvent(JSON.parse(f[0]!.data!))).toBe(true);
    s.close();
  });

  it('the ephemeral type reaches the stream without id: and never a webhook; the durable twin is delivered', async () => {
    const T = `org:seam-e-${n++}`;
    const cookie = await login(T);
    await insertSub('ex-both', T, [DURABLE, EPHEMERAL]); // stored directly: registration would refuse EPHEMERAL
    await drain();
    const s = await openStream(cookie);
    const e = await emit(cookie, { type: EPHEMERAL });
    expect(e.status).toBe(202);
    await until(() => s.text().includes(e.json.eventId));
    const f = frames(s.text());
    expect(f).toHaveLength(1);
    expect(f[0]!.event).toBe(EPHEMERAL);
    expect(f[0]!.id, 'an ephemeral frame has no id:').toBeUndefined();
    const env = JSON.parse(f[0]!.data!) as Record<string, unknown>;
    expect(validateHostEvent(env)).toBe(true);
    expect(env.delivery).toBe('ephemeral');
    expect((await drain()).has('ex-both'), 'ephemeral is never webhooked').toBe(false);
    // Positive control: the same subscription DOES receive the durable twin.
    const d = await emit(cookie, { type: DURABLE });
    const rows = (await drain()).get('ex-both');
    expect(rows).toHaveLength(1);
    expect(rows![0]!.payload).toContain(d.json.eventId);
    expect(rows![0]!.payload).not.toContain(e.json.eventId);
    s.close();
  });

  it('registration refuses the ephemeral type 400 validation_error and accepts the durable one', async () => {
    const cookie = await login(`org:seam-reg-${n++}`);
    const reg = (events: string[]) => fetch(`${BASE}/webhooks`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'openwop-version': '2', cookie },
      body: JSON.stringify({ url: 'https://example.com/openwop-0236', events }),
    });
    const bad = await reg([EPHEMERAL]);
    expect(bad.status).toBe(400);
    expect(codeOf(await bad.json())).toBe('validation_error');
    const good = await reg([DURABLE]);
    expect(good.status, await good.clone().text()).toBe(201);
  });

  it('a second tenant receives nothing for the first tenant’s event, and does receive its own', async () => {
    const A = `org:seam-ta-${n++}`;
    const B = `org:seam-tb-${n++}`;
    const ca = await login(A);
    const cb = await login(B);
    await insertSub('ta', A, [DURABLE]);
    await insertSub('tb', B, [DURABLE]);
    await drain();
    const sb = await openStream(cb);
    const ea = await emit(ca, { type: DURABLE });
    const got = await drain();
    expect(got.get('ta')).toHaveLength(1);
    expect(got.has('tb')).toBe(false);
    const eb = await emit(cb, { type: DURABLE });
    expect((await drain()).get('tb')).toHaveLength(1);
    await until(() => sb.text().includes(eb.json.eventId));
    expect(sb.text()).not.toContain(ea.json.eventId);
    expect(frames(sb.text()).map((f) => f.id)).toEqual([eb.json.eventId]);
    sb.close();
  });
});
