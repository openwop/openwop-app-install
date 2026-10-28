/**
 * ADR 0825 P1 / RFC 0236 — host events on the major-2 wire, behind
 * `OPENWOP_HOST_EVENTS_V2`.
 *
 *   1. The SSOT (`host/hostEventTypes.ts`): two-segment names, injective, and
 *      complete against the emit sites it was derived from.
 *   2. Webhooks: a major-2 subscriber naming the type gets `{ hostEvent }`
 *      (validated against the VENDORED webhook-delivery.schema.json, host
 *      branch), never a runId; pre-flag spellings still match; `*` does not;
 *      another tenant gets nothing; an unadvertised type is not emitted; an
 *      ephemeral event is never enqueued; an ephemeral type is refused at
 *      registration.
 *   3. Discovery: `hostEvents` validates against capabilities.schema.json and
 *      is absent with the flag off.
 *   4. `/host/events` SSE: frame shape, `id:` only on durable frames and never
 *      on heartbeats, tenant scope, `Last-Event-ID` resume.
 *
 * Every negative has a positive control in the same test, so an empty result
 * cannot pass by the path simply being dead.
 *
 * Floors are the MEASURED values at w62 (catalog 179 entries; 31 emitter files,
 * 48 literal names, 12 computed families); shrinking any of them is deliberate.
 * Tenant isolation on the webhook lane is a DOUBLE guard in routes/webhooks.ts:
 * `deliverHostEventV2`'s `listWebhooks({ tenantId })` and `fanOutHostEvent`'s
 * in-loop `sub.tenantId !== tenantId`; only breaking both reds it.
 *
 * Tracker TST-BHE-5. Sabotage-witnessed (w62): red when `*` matches a host
 * type, a major-1 subscription gets the v2 body, both webhook tenant guards are
 * removed, an ephemeral event is enqueued, a pre-flag id is not projected, an
 * unadvertised type reaches the stream, the stream or resume tenant filter is
 * removed, an ephemeral frame carries `id:`, or either flag gate is removed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Express } from 'express';
import { createApp, type AppConfig } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { getSetCookies } from './headerCookies.js';
import {
  advertisedHostEventTypes,
  HOST_EVENT_TYPE_PATTERN,
  hostEventEntryForEmitted,
  hostEventEntryForSubscriptionName,
  hostEventsV2Enabled,
  hostEventTypeEntries,
  twoSegmentHostEventType,
  v2HostEventId,
  type HostEventEnvelope,
} from '../src/host/hostEventTypes.js';
import { hostEventFrame } from '../src/host/hostEventStream.js';
import { assertNoEphemeralHostEventTypes, deliverHostExtEvent, fanOutHostEvent } from '../src/routes/webhooks.js';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import { CRM_EVENT_TYPES } from '../src/features/crm/emit.js';
import { KB_EVENT_TYPES } from '../src/features/kb/emit.js';
import { OpenwopError } from '../src/types.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
const V2 = join(here, '..', '..', '..', 'schemas', 'v2');

function ajv(): Ajv2020 {
  const a = new Ajv2020({ strict: false, allErrors: true });
  addFormats(a);
  for (const f of readdirSync(V2)) {
    if (!f.endsWith('.json')) continue;
    try { a.addSchema(JSON.parse(readFileSync(join(V2, f), 'utf8')) as Record<string, unknown>, f); } catch { /* sibling's own problem */ }
  }
  return a;
}
const AJV = ajv();
function schema(file: string) {
  const id = (JSON.parse(readFileSync(join(V2, file), 'utf8')) as { $id?: string }).$id;
  const fn = (id ? AJV.getSchema(id) : undefined) ?? AJV.getSchema(file);
  if (!fn) throw new Error(`${file} did not register — validation would be vacuous`);
  return fn;
}
const validateDelivery = schema('webhook-delivery.schema.json');
const validateHostEvent = schema('host-event.schema.json');
const validateCaps = schema('capabilities.schema.json');

const savedFlag = process.env.OPENWOP_HOST_EVENTS_V2;
const flagOn = (): void => { process.env.OPENWOP_HOST_EVENTS_V2 = 'true'; };
const flagOff = (): void => { delete process.env.OPENWOP_HOST_EVENTS_V2; };

// ── 1. the SSOT ──────────────────────────────────────────────────────────────

describe('RFC 0236 host-event types — the SSOT', () => {
  it('derives two-segment names, the RFC example included, and they are unique', () => {
    expect(twoSegmentHostEventType('host.crm.contact.created')).toBe('openwop-app.crm-contact-created');
    expect(twoSegmentHostEventType('host.goals.evaluated')).toBe('openwop-app.goals-evaluated');
    expect(twoSegmentHostEventType('crm.segment.entered')).toBe('openwop-app.crm-segment-entered');
    expect(twoSegmentHostEventType('openwop-app.whatsapp.health-degraded')).toBe('openwop-app.whatsapp-health-degraded');
    expect(twoSegmentHostEventType('run.completed')).toBeNull();
    const entries = hostEventTypeEntries();
    expect(entries.length).toBeGreaterThanOrEqual(179);
    for (const e of entries) {
      expect(HOST_EVENT_TYPE_PATTERN.test(e.type), e.type).toBe(true);
      expect(e.type.split('.')).toHaveLength(2);
      expect(e.delivery).toBe('durable');
    }
    expect(new Set(entries.map((e) => e.type)).size, 'injective').toBe(entries.length);
    expect(new Set(entries.map((e) => e.emitted)).size).toBe(entries.length);
  });

  it('pins the closed-world CRM and KB verb tables both ways', () => {
    const crm = hostEventTypeEntries().map((e) => e.emitted).filter((n) => n.startsWith('host.crm.'));
    expect(crm.sort()).toEqual([...CRM_EVENT_TYPES].sort());
    const kb = hostEventTypeEntries().map((e) => e.emitted).filter((n) => n.startsWith('host.kb.'));
    expect(kb.sort()).toEqual([...KB_EVENT_TYPES].sort());
  });

  it('is complete against the emit sites: every literal emitted name is listed, every computed family is covered', () => {
    const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const walk = (d: string, out: string[] = []): string[] => {
      for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p); }
      return out;
    };
    const literals = new Set<string>();
    const computed = new Set<string>();
    let emitterFiles = 0;
    for (const f of walk(SRC)) {
      const raw = readFileSync(f, 'utf8');
      if (!/emitHostEvent\(/.test(raw) || f.endsWith('hostEventDispatcher.ts')) continue;
      emitterFiles++;
      const code = strip(raw);
      for (const m of code.matchAll(/'((?:host|openwop-app)\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+|crm\.segment\.entered)'/g)) literals.add(m[1]!);
      for (const m of code.matchAll(/`(host\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.)\$\{/g)) computed.add(m[1]!);
    }
    // Anti-vacuity: the scan found the emitter population.
    expect(emitterFiles).toBeGreaterThanOrEqual(31);
    expect(literals.size).toBeGreaterThanOrEqual(48);
    expect(computed.size).toBeGreaterThanOrEqual(12);
    // `openwop-app.<feature>.<x>` literals in an emitter file that are NOT host
    // events (workflow ids, run-event types) — recorded so the exclusion is visible.
    const NOT_HOST_EVENTS = /^openwop-app\.(agents|workflow|kicktodo|insights|authored|evals|conversation|ai|chat|channel|scheduled-chat|node|web|production|host|cdp|kanban)\./;
    const missing = [...literals].filter((n) => !NOT_HOST_EVENTS.test(n) && hostEventEntryForEmitted(n) === undefined);
    expect(missing, 'an emitted host-event name is missing from host/hostEventTypes.ts').toEqual([]);
    const emitted = hostEventTypeEntries().map((e) => e.emitted);
    const uncovered = [...computed].filter((p) => !emitted.some((n) => n.startsWith(p)));
    expect(uncovered, 'a template-built emitter family has no listed type').toEqual([]);
  });

  it('resolves pre-flag subscription spellings to the advertised type, and nothing else', () => {
    const t = 'openwop-app.crm-contact-created';
    expect(hostEventEntryForSubscriptionName(t)?.type).toBe(t);
    expect(hostEventEntryForSubscriptionName('host.crm.contact.created')?.type).toBe(t);
    expect(hostEventEntryForSubscriptionName('openwop-app.crm.contact-created')?.type).toBe(t);
    expect(hostEventEntryForSubscriptionName('crm.segment.entered')?.type).toBe('openwop-app.crm-segment-entered');
    expect(hostEventEntryForSubscriptionName('openwop-app.crm.segment-entered')?.type).toBe('openwop-app.crm-segment-entered');
    expect(hostEventEntryForSubscriptionName('*')).toBeUndefined();
    expect(hostEventEntryForSubscriptionName('run.completed')).toBeUndefined();
    // A three-segment name that flattens onto an entry but is NOT its ADR 0792 spelling.
    expect(hostEventEntryForSubscriptionName('openwop-app.crm-contact.created')).toBeUndefined();
  });

  it('reads the flag and projects pre-flag event ids into the v2 grammar', () => {
    expect(hostEventsV2Enabled({})).toBe(false);
    expect(hostEventsV2Enabled({ OPENWOP_HOST_EVENTS_V2: 'false' })).toBe(false);
    expect(hostEventsV2Enabled({ OPENWOP_HOST_EVENTS_V2: 'true' })).toBe(true);
    expect(hostEventsV2Enabled({ OPENWOP_HOST_EVENTS_V2: '1' })).toBe(true);
    const id = 'hev:12345678-1234-4123-8123-123456789abc';
    expect(v2HostEventId(id)).toBe('hev-12345678-1234-4123-8123-123456789abc');
    expect(v2HostEventId('hev-12345678-1234-4123-8123-123456789abc')).toBe('hev-12345678-1234-4123-8123-123456789abc');
    expect(/^[A-Za-z0-9._~-]{16,128}$/.test(v2HostEventId('x:y'))).toBe(true);
  });
});

// ── shared app for 2–4 ───────────────────────────────────────────────────────

let app: Express;
let server: http.Server;
let BASE = '';
let storage: Storage;

beforeAll(async () => {
  flagOn();
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterEach(() => { flagOn(); });
afterAll(async () => {
  if (savedFlag === undefined) delete process.env.OPENWOP_HOST_EVENTS_V2; else process.env.OPENWOP_HOST_EVENTS_V2 = savedFlag;
  await new Promise<void>((res) => { server.closeAllConnections?.(); server.close(() => res()); });
});

let n = 0;
async function insertSub(id: string, tenantId: string, events: string[], protocolMajor: 1 | 2 = 2): Promise<void> {
  await storage.insertWebhook({ subscriptionId: id, tenantId, url: `https://example.test/${id}`, events, secret: 's', createdAt: new Date().toISOString(), protocolMajor });
}
async function drain(): Promise<Map<string, { payload: string; eventType: string }[]>> {
  const rows = await storage.claimDueWebhookDeliveries(`w-${n++}`, Date.now() + 1, 60_000, 200);
  const out = new Map<string, { payload: string; eventType: string }[]>();
  for (const r of rows) out.set(r.subscriptionId, [...(out.get(r.subscriptionId) ?? []), { payload: r.payload, eventType: r.eventType }]);
  return out;
}

// ── 2. webhooks ──────────────────────────────────────────────────────────────

describe('RFC 0236 §E — durable host events on major-2 webhooks (flag ON)', () => {
  it('delivers { hostEvent } (schema-valid, no runId) to every pre-flag spelling, once per subscription, and to nobody else', async () => {
    const T = `org:hev-a-${n++}`;
    const OTHER = `org:hev-b-${n++}`;
    await insertSub('two-seg', T, ['openwop-app.crm-contact-created']);
    await insertSub('in-process', T, ['host.crm.contact.created']);
    await insertSub('adr0792', T, ['openwop-app.crm.contact-created']);
    await insertSub('both', T, ['host.crm.contact.created', 'openwop-app.crm-contact-created']);
    await insertSub('star', T, ['*']);
    await insertSub('other-type', T, ['openwop-app.crm-deal-won']);
    await insertSub('foreign', OTHER, ['openwop-app.crm-contact-created']);
    await drain();

    await deliverHostExtEvent({ type: 'host.crm.contact.created', tenantId: T, payload: { contactId: 'c-1' }, eventId: 'hev-00000000-0000-4000-8000-0000000000aa' });
    const got = await drain();

    for (const id of ['two-seg', 'in-process', 'adr0792', 'both']) {
      const rows = got.get(id);
      expect(rows, `${id} received the event`).toHaveLength(1); // `both` names it twice and still gets ONE row
      const body = JSON.parse(rows![0]!.payload) as { hostEvent: HostEventEnvelope } & Record<string, unknown>;
      expect(validateDelivery(body), JSON.stringify(validateDelivery.errors)).toBe(true);
      expect(Object.keys(body)).toEqual(['hostEvent']);
      expect('runId' in body).toBe(false);
      expect(validateHostEvent(body.hostEvent), JSON.stringify(validateHostEvent.errors)).toBe(true);
      expect(body.hostEvent).toMatchObject({ eventId: 'hev-00000000-0000-4000-8000-0000000000aa', type: 'openwop-app.crm-contact-created', delivery: 'durable', payload: { contactId: 'c-1' } });
      expect('runId' in body.hostEvent || 'sequence' in body.hostEvent || 'workspaceId' in body.hostEvent).toBe(false);
      expect(rows![0]!.eventType, 'OpenWOP-Event-Type is the two-segment type').toBe('openwop-app.crm-contact-created');
    }
    // §E: `*` names no type; another type; another tenant (CTI-1) — all receive nothing,
    // while the four positive controls above, from the same emit, did receive it.
    expect(got.has('star')).toBe(false);
    expect(got.has('other-type')).toBe(false);
    expect(got.has('foreign')).toBe(false);

    // Positive control for the foreign tenant: its OWN event reaches it.
    await deliverHostExtEvent({ type: 'host.crm.contact.created', tenantId: OTHER, payload: { contactId: 'c-2' } });
    const got2 = await drain();
    expect(got2.get('foreign')).toHaveLength(1);
    expect(got2.has('two-seg')).toBe(false);
  });

  it('end to end: a real CRM write reaches a major-2 subscriber as { hostEvent }, with ONE v2 id shared with the run it triggered', async () => {
    const crm = getToggleDefault('crm');
    if (crm) await saveConfig({ ...crm, status: 'on' }, 'test');
    const T = `org:hev-e2e-${n++}`;
    const cookie = await login(T);
    await insertSub('e2e', T, ['host.crm.contact.created']); // a pre-flag spelling, as a live subscription would carry
    await drain();
    const wk = (await (await fetch(`${BASE}/.well-known/openwop`)).json()) as { fixtures?: string[] };
    const binding = await fetch(`${BASE}/host/openwop-app/host-events/bindings`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ eventType: 'host.crm.contact.created', workflowId: wk.fixtures?.[0] ?? 'openwop-app.uppercase' }),
    });
    expect(binding.status, await binding.clone().text()).toBe(201);
    const bindingId = ((await binding.json()) as { bindingId: string }).bindingId;
    const r = await fetch(`${BASE}/host/openwop-app/crm/contacts`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Host Event Target' }) });
    expect(r.status, await r.clone().text()).toBe(201);
    let row: { payload: string; eventType: string } | undefined;
    for (let i = 0; i < 80 && !row; i++) {
      row = (await drain()).get('e2e')?.[0];
      if (!row) await new Promise((res) => setTimeout(res, 25));
    }
    expect(row, 'the emitter path enqueued a delivery').toBeDefined();
    const body = JSON.parse(row!.payload) as { hostEvent: HostEventEnvelope };
    expect(validateDelivery(body), JSON.stringify(validateDelivery.errors)).toBe(true);
    expect(body.hostEvent.type).toBe('openwop-app.crm-contact-created');
    expect(body.hostEvent.eventId.startsWith('hev-'), body.hostEvent.eventId).toBe(true);
    // ADR 0208 correlation: the run the binding started carries the SAME id, so the
    // dispatcher must mint it in the v2 grammar rather than have the envelope rewrite it.
    let runEventId: string | undefined;
    for (let i = 0; i < 80 && !runEventId; i++) {
      const runs = await storage.listRuns({ tenantId: T, limit: 50 });
      const run = runs.find((x) => (x.metadata as { hostEvent?: { bindingId?: string } } | undefined)?.hostEvent?.bindingId === bindingId);
      runEventId = (run?.metadata as { hostEvent?: { eventId?: string } } | undefined)?.hostEvent?.eventId;
      if (!runEventId) await new Promise((res) => setTimeout(res, 25));
    }
    expect(runEventId, 'the binding started a run').toBeDefined();
    expect(runEventId).toBe(body.hostEvent.eventId);
  });

  it('a pre-flag `hev:` id is projected into the eventId grammar', async () => {
    const T = `org:hev-c-${n++}`;
    await insertSub('legacy-id', T, ['openwop-app.cms-page-published']);
    await deliverHostExtEvent({ type: 'host.cms.page.published', tenantId: T, payload: { pageId: 'p' }, eventId: 'hev:00000000-0000-4000-8000-0000000000bb' });
    const body = JSON.parse((await drain()).get('legacy-id')![0]!.payload) as { hostEvent: HostEventEnvelope };
    expect(body.hostEvent.eventId).toBe('hev-00000000-0000-4000-8000-0000000000bb');
    expect(validateDelivery(body)).toBe(true);
  });

  it('a major-1 subscription gets nothing (ADR 0812 decision 2) while a major-2 one gets the host body', async () => {
    const T = `org:hev-d-${n++}`;
    await insertSub('m1', T, ['host.commerce.order.paid'], 1);
    await insertSub('m2', T, ['openwop-app.commerce-order-paid'], 2);
    await deliverHostExtEvent({ type: 'host.commerce.order.paid', tenantId: T, payload: { orderId: 'o' } });
    const got = await drain();
    expect(got.has('m1')).toBe(false);
    const v2 = JSON.parse(got.get('m2')![0]!.payload) as { hostEvent: HostEventEnvelope };
    expect(v2.hostEvent.type).toBe('openwop-app.commerce-order-paid');
  });

  it('an UNADVERTISED type is not emitted on the v2 lane (§B) — neither webhook nor stream — while an advertised one is', async () => {
    const T = `org:hev-e-${n++}`;
    await insertSub('unadv', T, ['openwop-app.crm-contact-frobbed', 'host.crm.contact.frobbed']);
    await insertSub('adv', T, ['openwop-app.crm-contact-updated']);
    const s = await openStream(await login(T));
    await deliverHostExtEvent({ type: 'host.crm.contact.frobbed', tenantId: T, payload: { marker: 'unadvertised' } });
    await deliverHostExtEvent({ type: 'host.crm.contact.updated', tenantId: T, payload: { marker: 'advertised' } });
    const got = await drain();
    expect(got.has('unadv')).toBe(false);
    expect(got.get('adv')).toHaveLength(1);
    await until(() => s.text().includes('"advertised"'));
    const events = frames(s.text()).filter((f) => !f.comment).map((f) => f.event);
    expect(events).toEqual(['openwop-app.crm-contact-updated']);
    s.close();
  });

  it('an EPHEMERAL event is never enqueued (§C); the same envelope as durable is', async () => {
    const T = `org:hev-f-${n++}`;
    await insertSub('eph', T, ['openwop-app.crm-contact-created']);
    const base = { eventId: 'hev-00000000-0000-4000-8000-0000000000cc', type: 'openwop-app.crm-contact-created', timestamp: new Date().toISOString(), payload: {} };
    await fanOutHostEvent(storage, T, { ...base, delivery: 'ephemeral' });
    expect((await drain()).has('eph')).toBe(false);
    await fanOutHostEvent(storage, T, { ...base, delivery: 'durable' });
    expect((await drain()).get('eph')).toHaveLength(1);
  });

  it('registration refuses an ephemeral host-event type and accepts a durable one (§E)', async () => {
    const lookup = (name: string) => (name === 'example.thing-noticed' ? { delivery: 'ephemeral' as const } : name === 'example.thing-happened' ? { delivery: 'durable' as const } : undefined);
    expect(() => assertNoEphemeralHostEventTypes(['example.thing-happened', 'run.completed'], lookup)).not.toThrow();
    let caught: unknown;
    try { assertNoEphemeralHostEventTypes(['run.completed', 'example.thing-noticed'], lookup); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(OpenwopError);
    expect((caught as OpenwopError).code).toBe('validation_error');
    expect((caught as OpenwopError).httpStatus).toBe(400);
    // Through the real route: a v2 registration naming the advertised durable type is accepted.
    const c = await login(`org:hev-reg-${n++}`);
    const r = await fetch(`${BASE}/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'openwop-version': '2', cookie: c },
      body: JSON.stringify({ url: 'https://example.com/hook', events: ['openwop-app.crm-contact-created'] }),
    });
    expect(r.status, await r.clone().text()).toBe(201);
  });
});

// ── 3. discovery ─────────────────────────────────────────────────────────────

describe('RFC 0236 §B — the hostEvents advertisement', () => {
  const CONFIG: AppConfig = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false };
  it('validates against the vendored capabilities schema and lists the SSOT', () => {
    const doc = buildV2Advertisement(CONFIG);
    const rec = doc.hostEvents as { status: string; witness: string; types: Array<{ type: string; delivery: string }> };
    expect(rec, 'advertised with the flag on').toBeDefined();
    expect(rec.types).toEqual(advertisedHostEventTypes());
    expect(rec.types.some((t) => t.type === 'openwop-app.crm-contact-created' && t.delivery === 'durable')).toBe(true);
    expect(rec.witness).toBe('witnessable-gated');
    expect(validateCaps(doc), JSON.stringify(validateCaps.errors?.slice(0, 5))).toBe(true);
  });
  it('is absent with the flag off', () => {
    flagOff();
    expect('hostEvents' in buildV2Advertisement(CONFIG)).toBe(false);
  });
});

// ── 4. /host/events ──────────────────────────────────────────────────────────

async function login(tenantId: string): Promise<string> {
  const r = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `hev-${Date.now()}-${n++}@acme.test`, tenantId }),
  });
  expect(r.status, await r.clone().text()).toBe(201);
  for (const c of getSetCookies(r.headers) as string[]) {
    const m = /(__session=[^;]+)/.exec(c);
    if (m) return m[1]!;
  }
  throw new Error('no session cookie');
}

interface Stream { text: () => string; status: number; contentType: string; close: () => void }
function openStream(cookie: string, lastEventId?: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const req = http.get(`${BASE}/host/events`, {
      headers: { cookie, accept: 'text/event-stream', 'openwop-version': '2', ...(lastEventId ? { 'last-event-id': lastEventId } : {}) },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d: string) => { buf += d; });
      const s: Stream = { text: () => buf, status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), close: () => req.destroy() };
      // Resolve once the stream is open (the `: open` comment) or the response is not a stream.
      if (!s.contentType.includes('text/event-stream')) { res.on('end', () => resolve(s)); return; }
      const wait = (): void => { if (buf.includes(': open')) resolve(s); else setTimeout(wait, 5); };
      wait();
    });
    req.on('error', (e) => { if (!/socket hang up|aborted/.test(String(e))) reject(e); });
  });
}
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}
/** Parse SSE frames: each block separated by a blank line. */
function frames(text: string): Array<{ event?: string; id?: string; data?: string; comment: boolean }> {
  return text.split('\n\n').filter((b) => b.length > 0).map((b) => {
    const f: { event?: string; id?: string; data?: string; comment: boolean } = { comment: b.startsWith(':') };
    for (const line of b.split('\n')) {
      if (line.startsWith('event: ')) f.event = line.slice(7);
      else if (line.startsWith('id: ')) f.id = line.slice(4);
      else if (line.startsWith('data: ')) f.data = line.slice(6);
    }
    return f;
  });
}

describe('RFC 0236 §B–§D — /host/events', () => {
  it('frames a durable event with event: = type, id: = eventId, data: = a valid envelope; tenant-scoped', async () => {
    const A = `org:hev-sse-a-${n++}`;
    const B = `org:hev-sse-b-${n++}`;
    const sa = await openStream(await login(A));
    const sb = await openStream(await login(B));
    expect(sa.status).toBe(200);
    expect(sa.contentType).toContain('text/event-stream');

    await deliverHostExtEvent({ type: 'host.crm.contact.created', tenantId: A, payload: { contactId: 'sse-1' }, eventId: 'hev-00000000-0000-4000-8000-0000000000d1' });
    await deliverHostExtEvent({ type: 'host.crm.deal.won', tenantId: B, payload: { dealId: 'sse-2' }, eventId: 'hev-00000000-0000-4000-8000-0000000000d2' });
    await until(() => sa.text().includes('d1') && sb.text().includes('d2'));

    const fa = frames(sa.text()).filter((f) => !f.comment);
    expect(fa).toHaveLength(1);
    expect(fa[0]!.event).toBe('openwop-app.crm-contact-created');
    expect(fa[0]!.id).toBe('hev-00000000-0000-4000-8000-0000000000d1');
    const env = JSON.parse(fa[0]!.data!) as Record<string, unknown>;
    expect(validateHostEvent(env), JSON.stringify(validateHostEvent.errors)).toBe(true);
    expect('runId' in env || 'sequence' in env).toBe(false);
    // Tenant scope (§D): B never saw A's event, and positively did see its own.
    const fb = frames(sb.text()).filter((f) => !f.comment);
    expect(fb.map((f) => f.id)).toEqual(['hev-00000000-0000-4000-8000-0000000000d2']);
    expect(sb.text()).not.toContain('sse-1');
    // Comment lines (open / heartbeat) carry no id:.
    for (const f of frames(sa.text()).filter((x) => x.comment)) expect(f.id).toBeUndefined();
    sa.close(); sb.close();
  });

  it('resumes durable events after Last-Event-ID, for the caller tenant only', async () => {
    const A = `org:hev-resume-a-${n++}`;
    const B = `org:hev-resume-b-${n++}`;
    const ca = await login(A);
    const id = (k: string): string => `hev-00000000-0000-4000-8000-0000000000${k}`;
    await deliverHostExtEvent({ type: 'host.cms.page.published', tenantId: A, payload: {}, eventId: id('e1') });
    await deliverHostExtEvent({ type: 'host.cms.page.archived', tenantId: B, payload: {}, eventId: id('e2') });
    await deliverHostExtEvent({ type: 'host.cms.page.restored', tenantId: A, payload: {}, eventId: id('e3') });
    await deliverHostExtEvent({ type: 'host.cms.page.rejected', tenantId: A, payload: {}, eventId: id('e4') });
    const s = await openStream(ca, id('e1'));
    await until(() => s.text().includes(id('e4')));
    const ids = frames(s.text()).filter((f) => !f.comment).map((f) => f.id);
    expect(ids).toEqual([id('e3'), id('e4')]); // after e1, A only (e2 is B's)
    s.close();
    // Control: an unknown id resumes from live — nothing replayed. A fresh live
    // event is awaited first, so "nothing else" is read after the stream is proven live.
    const s2 = await openStream(ca, 'hev-not-a-retained-id-000000');
    await deliverHostExtEvent({ type: 'host.cms.page.published', tenantId: A, payload: {}, eventId: id('f9') });
    await until(() => s2.text().includes(id('f9')));
    expect(frames(s2.text()).filter((f) => !f.comment).map((f) => f.id)).toEqual([id('f9')]);
    s2.close();
  });

  it('an ephemeral frame carries no id:; a durable one does', () => {
    const base = { eventId: 'hev-00000000-0000-4000-8000-0000000000f1', type: 'example.thing-noticed', timestamp: '2026-10-05T12:00:00Z', payload: {} };
    expect(hostEventFrame({ ...base, delivery: 'ephemeral' })).toBe(`event: example.thing-noticed\ndata: ${JSON.stringify({ ...base, delivery: 'ephemeral' })}\n\n`);
    expect(hostEventFrame({ ...base, delivery: 'durable' })).toContain('\nid: hev-00000000-0000-4000-8000-0000000000f1\n');
  });

  it('with the flag off /host/events is not served (falls through as before)', async () => {
    flagOff();
    const s = await openStream(await login(`org:hev-off-${n++}`));
    expect(s.contentType.includes('text/event-stream')).toBe(false);
    expect(s.status).toBe(404);
    s.close();
  });
});
