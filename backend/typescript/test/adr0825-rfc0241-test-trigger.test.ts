/**
 * RFC 0241 (ADR 0825) — `POST /host/events/test`, the production-safe host-event
 * trigger. The installed contract decides whether it is bound (§B.1); this file
 * mocks that one predicate to drive both states, and pins the real predicate
 * against the vendored manifest so the mock cannot drift from it.
 *
 * Witnessed with the trigger bound: the reserved types are listed; a durable
 * test event reaches the caller's stream (with `id:`) and the caller's webhook,
 * an ephemeral one reaches the stream (no `id:`) and no webhook; payloads are
 * empty; nothing reaches another tenant; the closed body and §B.4 refusals hold.
 * Unbound (contract off, or hostEvents off): nothing is listed and the route is
 * `404`.
 *
 * Tracker TST-BHE-6. Sabotage-witnessed (w62): red when the real predicate stops
 * reading the manifest, the unbound route serves, a foreign workspaceId is
 * accepted, a test event carries a payload, an Idempotency-Key replay or mismatch
 * is not honoured, the key is not tenant-scoped, an ephemeral event is webhooked,
 * or both webhook tenant guards in `fanOutHostEvent` are removed.
 * The "400 is not cached" claim is STRUCTURAL: validation runs before the
 * idempotency claim, so no single edit can make a 400 cached (honest ceiling).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { getSetCookies } from './headerCookies.js';
import { advertisedHostEventTypes, HOST_TEST_EVENT_TYPES } from '../src/host/hostEventTypes.js';
import { toWireTenant } from '../src/host/v2Ids.js';

const contract = vi.hoisted(() => ({ on: true }));
vi.mock('../src/host/hostEventTestContract.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, hostEventTestTriggerDefined: () => contract.on };
});

const here = dirname(fileURLToPath(import.meta.url));
const savedFlag = process.env.OPENWOP_HOST_EVENTS_V2;
let app: Express;
let server: http.Server;
let BASE = '';
let storage: Storage;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_HOST_EVENTS_V2 = 'true';
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterEach(() => { contract.on = true; process.env.OPENWOP_HOST_EVENTS_V2 = 'true'; });
afterAll(async () => {
  if (savedFlag === undefined) delete process.env.OPENWOP_HOST_EVENTS_V2; else process.env.OPENWOP_HOST_EVENTS_V2 = savedFlag;
  await new Promise<void>((res) => { server.closeAllConnections?.(); server.close(() => res()); });
});

async function login(tenantId: string): Promise<string> {
  const r = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `rfc0241-${Date.now()}-${n++}@acme.test`, tenantId }),
  });
  expect(r.status, await r.clone().text()).toBe(201);
  for (const c of getSetCookies(r.headers) as string[]) {
    const m = /(__session=[^;]+)/.exec(c);
    if (m) return m[1]!;
  }
  throw new Error('no session cookie');
}
const trigger = (cookie: string | null, body: unknown) =>
  fetch(`${BASE}/host/events/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'openwop-version': '2', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

interface Stream { text: () => string; close: () => void }
function openStream(cookie: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const req = http.get(`${BASE}/host/events`, { headers: { cookie, accept: 'text/event-stream', 'openwop-version': '2' } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d: string) => { buf += d; });
      const wait = (): void => { if (buf.includes(': open')) resolve({ text: () => buf, close: () => req.destroy() }); else setTimeout(wait, 5); };
      wait();
    });
    req.on('error', (e) => { if (!/socket hang up|aborted/.test(String(e))) reject(e); });
  });
}
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}
const eventFrames = (text: string) =>
  text.split('\n\n').filter((b) => b.length > 0 && !b.startsWith(':')).map((b) => {
    const f: { event?: string; id?: string; data?: string } = {};
    for (const line of b.split('\n')) {
      if (line.startsWith('event: ')) f.event = line.slice(7);
      else if (line.startsWith('id: ')) f.id = line.slice(4);
      else if (line.startsWith('data: ')) f.data = line.slice(6);
    }
    return f;
  });
async function insertSub(id: string, tenantId: string, events: string[]): Promise<void> {
  await storage.insertWebhook({ subscriptionId: id, tenantId, url: `https://example.test/${id}`, events, secret: 's', createdAt: new Date().toISOString(), protocolMajor: 2 });
}
async function drain(): Promise<Map<string, string[]>> {
  const rows = await storage.claimDueWebhookDeliveries(`w-0241-${n++}`, Date.now() + 1, 60_000, 200);
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.subscriptionId, [...(out.get(r.subscriptionId) ?? []), r.payload]);
  return out;
}

describe('RFC 0241 — the contract predicate is the vendored manifest (no drift from the mock)', () => {
  it('the real predicate equals "the vendored v2 path manifest defines /host/events/test"', async () => {
    const real = await vi.importActual<typeof import('../src/host/hostEventTestContract.js')>('../src/host/hostEventTestContract.js');
    const manifest = readFileSync(join(here, '..', '..', '..', 'schemas', 'v2', 'path-manifest.json'), 'utf8');
    // Non-vacuity: this is the v2 manifest, which defines the host-event channel.
    expect(manifest).toContain('"/host/events"');
    expect(real.hostEventTestTriggerDefined()).toBe(manifest.includes('"/host/events/test"'));
  });
});

describe('RFC 0241 §A/§B — trigger bound (contract defines it, hostEvents on)', () => {
  it('lists both reserved types with their classes', () => {
    const listed = advertisedHostEventTypes();
    expect(listed).toEqual(expect.arrayContaining([
      { type: HOST_TEST_EVENT_TYPES.durable, delivery: 'durable' },
      { type: HOST_TEST_EVENT_TYPES.ephemeral, delivery: 'ephemeral' },
    ]));
  });

  it('a durable test event reaches the caller’s stream (with id:) and webhook, empty payload, and no other tenant', async () => {
    const A = `org:t0241-a-${n++}`;
    const B = `org:t0241-b-${n++}`;
    const ca = await login(A);
    const sa = await openStream(ca);
    const cb = await login(B);
    const sb = await openStream(cb);
    const subA = `sub-a-${n++}`;
    const subB = `sub-b-${n++}`;
    await insertSub(subA, A, [HOST_TEST_EVENT_TYPES.durable]);
    await insertSub(subB, B, [HOST_TEST_EVENT_TYPES.durable]);

    const r = await trigger(ca, { delivery: 'durable' });
    expect(r.status, await r.clone().text()).toBe(202);
    const { eventId, type } = (await r.json()) as { eventId: string; type: string };
    expect(type).toBe(HOST_TEST_EVENT_TYPES.durable);

    await until(() => sa.text().includes(eventId));
    const fa = eventFrames(sa.text()).filter((f) => f.id === eventId);
    expect(fa).toHaveLength(1);
    expect(fa[0]!.event).toBe(HOST_TEST_EVENT_TYPES.durable);
    expect((JSON.parse(fa[0]!.data!) as { payload: unknown }).payload).toEqual({});
    // Tenant isolation: B's stream and B's webhook got nothing. B's OWN event is
    // awaited first, so B's stream is proven live before A's absence is read.
    const rb = await trigger(cb, { delivery: 'durable' });
    expect(rb.status).toBe(202);
    const { eventId: bEventId } = (await rb.json()) as { eventId: string };
    await until(() => sb.text().includes(bEventId));
    expect(sb.text()).toContain(bEventId);
    expect(sb.text()).not.toContain(eventId);
    const d = await drain();
    expect(d.get(subA)?.length).toBe(1);
    expect(d.get(subA)![0]).toContain(eventId);
    // B's webhook got only B's own event, never A's.
    expect(d.get(subB)?.length).toBe(1);
    expect(d.get(subB)![0]).toContain(bEventId);
    expect(d.get(subB)![0]).not.toContain(eventId);
    sa.close(); sb.close();
  });

  it('an ephemeral test event reaches the stream without id:, and no webhook', async () => {
    const A = `org:t0241-eph-${n++}`;
    const ca = await login(A);
    const sa = await openStream(ca);
    // Registration refuses an ephemeral type; plant one directly to prove fan-out skips it.
    const subE = `sub-eph-${n++}`;
    await insertSub(subE, A, [HOST_TEST_EVENT_TYPES.ephemeral]);
    const r = await trigger(ca, { delivery: 'ephemeral' });
    expect(r.status).toBe(202);
    const { eventId } = (await r.json()) as { eventId: string };
    await until(() => sa.text().includes(eventId));
    const f = eventFrames(sa.text()).find((x) => x.data?.includes(eventId));
    expect(f?.event).toBe(HOST_TEST_EVENT_TYPES.ephemeral);
    expect(f?.id).toBeUndefined();
    expect((await drain()).get(subE)).toBeUndefined();
    sa.close();
  });

  it('registering a webhook for the ephemeral test type is refused (RFC 0236 §E applies)', async () => {
    const c = await login(`org:t0241-reg-${n++}`);
    const r = await fetch(`${BASE}/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'openwop-version': '2', cookie: c },
      body: JSON.stringify({ url: 'https://example.test/hook', events: [HOST_TEST_EVENT_TYPES.ephemeral] }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error?: string }).error).toBe('validation_error');
  });

  it('the closed body and the §B.4 refusals', async () => {
    const A = `org:t0241-ref-${n++}`;
    const c = await login(A);
    const code = async (body: unknown) => {
      const r = await trigger(c, body);
      return `${r.status} ${((await r.json()) as { error?: string }).error}`;
    };
    expect(await code({ delivery: 'loud' })).toBe('400 validation_error');
    expect(await code({})).toBe('400 validation_error');
    expect(await code({ delivery: 'durable', type: 'host.crm.contact.created' })).toBe('400 validation_error');
    expect(await code({ delivery: 'durable', workspaceId: 'someone-else/ws-0000000000000001' })).toBe('403 id_tenant_mismatch');
    expect(await code({ delivery: 'durable', workspaceId: `${toWireTenant(A)}/ws-0000000000000001` })).toBe('404 not_found');
    // Unauthenticated: no tenant to emit to.
    const anon = await trigger(null, { delivery: 'durable' });
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error?: string }).error).toBe('unauthenticated');
  });
});

describe('RFC 0241 §B.1 — trigger unbound', () => {
  it('contract off: the reserved types are not listed and the route is 404', async () => {
    contract.on = false;
    expect(advertisedHostEventTypes().some((t) => t.type.startsWith('host-test.'))).toBe(false);
    const r = await trigger(await login(`org:t0241-off-${n++}`), { delivery: 'durable' });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error?: string }).error).toBe('not_found');
  });

  it('hostEvents off: the route is 404 even when the contract defines it', async () => {
    delete process.env.OPENWOP_HOST_EVENTS_V2;
    const r = await trigger(await login(`org:t0241-flag-${n++}`), { delivery: 'durable' });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error?: string }).error).toBe('not_found');
  });
});

describe('RFC 0241 §B.5 — Idempotency-Key (idempotency.md Layer 1)', () => {
  const keyed = (cookie: string, key: string, body: unknown) =>
    fetch(`${BASE}/host/events/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'openwop-version': '2', 'idempotency-key': key, cookie },
      body: JSON.stringify(body),
    });
  const freshKey = () => `k0241-${Date.now()}-${n++}-${'x'.repeat(16)}`;

  it('a same-key retry replays the 202 with the marker and emits NO second event', async () => {
    const A = `org:t0241-idem-${n++}`;
    const ca = await login(A);
    const sub = `sub-idem-${n++}`;
    await insertSub(sub, A, [HOST_TEST_EVENT_TYPES.durable]);
    const key = freshKey();

    const first = await keyed(ca, key, { delivery: 'durable' });
    expect(first.status, await first.clone().text()).toBe(202);
    expect(first.headers.get('openwop-idempotent-replay')).toBeNull();
    const firstBody = await first.json() as { eventId: string };

    const again = await keyed(ca, key, { delivery: 'durable' });
    expect(again.status).toBe(202);
    expect(again.headers.get('openwop-idempotent-replay')).toBe('true');
    expect(await again.json()).toEqual(firstBody);

    const delivered = (await drain()).get(sub) ?? [];
    expect(delivered.filter((p) => p.includes(firstBody.eventId))).toHaveLength(1);
    expect(delivered, 'a replay emitted a second test event').toHaveLength(1);
  });

  it('the same key with a different body is 409 idempotency_key_mismatch, never the cached body', async () => {
    const ca = await login(`org:t0241-idem-${n++}`);
    const key = freshKey();
    expect((await keyed(ca, key, { delivery: 'durable' })).status).toBe(202);
    const r = await keyed(ca, key, { delivery: 'ephemeral' });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('idempotency_key_mismatch');
  });

  it('a 400 validation_error is NOT cached: the corrected retry under the same key succeeds', async () => {
    const ca = await login(`org:t0241-idem-${n++}`);
    const key = freshKey();
    expect((await keyed(ca, key, { delivery: 'sideways' })).status).toBe(400);
    const r = await keyed(ca, key, { delivery: 'durable' });
    expect(r.status, await r.clone().text()).toBe(202);
    expect(r.headers.get('openwop-idempotent-replay')).toBeNull();
  });

  it('the same key in ANOTHER tenant is its own record (no cross-tenant replay)', async () => {
    const key = freshKey();
    const a = await keyed(await login(`org:t0241-idem-${n++}`), key, { delivery: 'durable' });
    const b = await keyed(await login(`org:t0241-idem-${n++}`), key, { delivery: 'durable' });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.headers.get('openwop-idempotent-replay')).toBeNull();
    expect(((await b.json()) as { eventId: string }).eventId).not.toBe(((await a.json()) as { eventId: string }).eventId);
  });
});
