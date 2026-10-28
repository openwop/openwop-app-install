/**
 * ADR 0973 — RFC 0250 opt-in host-event replay on this host (P1, dormant).
 *
 * Since the 2.46.23 pin the vendored schemas define `hostEvents.replay`, so the
 * wire is ON (first case; ADR 0973 P2). The wire-off case forces it off to keep
 * the dormant path witnessed:
 *
 *   - resume-backlog: D1, D2, an ephemeral E, D3; reconnect after D1; D4 live →
 *     exactly D2, D3, D4, in order, the cursor never re-emitted;
 *   - the source is the durable log, not the process ring (events appended
 *     without ever being published still replay: process replacement);
 *   - one byte-identical 409 before any SSE byte for an unknown cursor, another
 *     tenant's real id, an ephemeral id, and an unauthenticated caller naming a
 *     real id; an expired cursor resolves to the same null;
 *   - legacy: without `replay=required` an unknown cursor still opens the stream;
 *     with it and no cursor, the stream opens live;
 *   - the hand-off dedupes by id: a lower sequence committed after the backlog
 *     read arrives live exactly once, and a backlog event's late live frame is
 *     not written twice;
 *   - an oversized event reaches subscribers through the log;
 *   - tenant teardown removes the log, and the cursor is then refused;
 *   - discovery advertises `hostEvents.replay` only with the wire on.
 *
 * Sabotage-witnessed: see the ADR 0973 P1 record.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp, type AppConfig } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { getSetCookies } from './headerCookies.js';
import type { HostEventEnvelope } from '../src/host/hostEventTypes.js';
import { fanOutHostEvent } from '../src/routes/webhooks.js';
import { publishHostEventToStream } from '../src/host/hostEventStream.js';
import {
  appendHostEvent,
  HOST_EVENT_REPLAY_MIN_RETENTION_SECONDS,
  resetRfc0250WireCache,
  resolveHostEventCursor,
  rfc0250WireAvailable,
} from '../src/host/hostEventLog.js';
import { purgeTenantHostExt } from '../src/host/hostExtPersistence.js';
import { buildV2Advertisement } from '../src/routes/discovery.js';

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
afterAll(async () => {
  resetRfc0250WireCache();
  if (savedFlag === undefined) delete process.env.OPENWOP_HOST_EVENTS_V2; else process.env.OPENWOP_HOST_EVENTS_V2 = savedFlag;
  await new Promise<void>((res) => { server.closeAllConnections?.(); server.close(() => res()); });
});

const id = (k: string): string => `hev-00000000-0000-4000-8000-${k.padStart(12, '0')}`;
function ev(eventId: string, delivery: 'durable' | 'ephemeral' = 'durable', payload: Record<string, unknown> = {}): HostEventEnvelope {
  return { eventId, type: delivery === 'durable' ? 'example.thing-happened' : 'example.thing-noticed', timestamp: new Date().toISOString(), delivery, payload };
}

async function login(tenantId: string): Promise<string> {
  const r = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `rpl-${Date.now()}-${n++}@acme.test`, tenantId }),
  });
  expect(r.status, await r.clone().text()).toBe(201);
  for (const c of getSetCookies(r.headers) as string[]) {
    const m = /(__session=[^;]+)/.exec(c);
    if (m) return m[1]!;
  }
  throw new Error('no session cookie');
}

interface Stream { text: () => string; status: number; contentType: string; close: () => void }
function openStream(opts: { cookie?: string; lastEventId?: string; replay?: boolean }): Promise<Stream> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const req = http.get(`${BASE}/host/events${opts.replay ? '?replay=required' : ''}`, {
      headers: {
        accept: 'text/event-stream', 'openwop-version': '2',
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.lastEventId !== undefined ? { 'last-event-id': opts.lastEventId } : {}),
      },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d: string) => { buf += d; });
      const s: Stream = { text: () => buf, status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), close: () => req.destroy() };
      if (!s.contentType.includes('text/event-stream')) { res.on('end', () => resolve(s)); return; }
      const wait = (): void => { if (buf.includes(': open')) resolve(s); else setTimeout(wait, 5); };
      wait();
    });
    req.on('error', (e) => { if (!/socket hang up|aborted/.test(String(e))) reject(e); });
  });
}
async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}
const eventIds = (text: string): string[] =>
  text.split('\n\n').filter((b) => b.length > 0 && !b.startsWith(':'))
    .map((b) => /^id: (.+)$/m.exec(b)?.[1] ?? '(no id)');

describe('the switch (ADR 0973 D8)', () => {
  it('the vendored schemas define hostEvents.replay, so the wire is on', () => {
    // ADR 0973 P2: the 2.46.23 pin is the switch. P1 asserted false here.
    resetRfc0250WireCache();
    try {
      expect(rfc0250WireAvailable()).toBe(true);
    } finally {
      resetRfc0250WireCache(true);
    }
  });

  it('with the wire off, replay=required is ignored and nothing is logged', async () => {
    resetRfc0250WireCache(false);
    try {
      const T = `org:rpl-off-${n++}`;
      const cookie = await login(T);
      const s = await openStream({ cookie, replay: true, lastEventId: id('0ff1') });
      expect(s.status).toBe(200); // the legacy path: an unknown id resumes from live
      expect(s.contentType).toContain('text/event-stream');
      await fanOutHostEvent(storage, T, ev(id('0ff2')));
      await until(() => s.text().includes(id('0ff2')));
      s.close();
      expect(await resolveHostEventCursor(T, id('0ff2'))).toBeNull();
      expect('replay' in ((buildV2Advertisement(CONFIG).hostEvents ?? {}) as Record<string, unknown>)).toBe(false);
    } finally {
      resetRfc0250WireCache(true);
    }
  });
});

const CONFIG = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false } as AppConfig;

describe('resume (RFC 0250 RESUME, ADR 0973 D4)', () => {
  it('resume-backlog: after D1 → exactly D2, D3, then D4 live; no ephemeral, cursor never re-emitted', async () => {
    resetRfc0250WireCache(true);
    const T = `org:rpl-a-${n++}`;
    const cookie = await login(T);
    await fanOutHostEvent(storage, T, ev(id('a1')));
    await fanOutHostEvent(storage, T, ev(id('a2')));
    await fanOutHostEvent(storage, T, ev(id('ae'), 'ephemeral'));
    await fanOutHostEvent(storage, T, ev(id('a3')));
    const s = await openStream({ cookie, replay: true, lastEventId: id('a1') });
    expect(s.status).toBe(200);
    await fanOutHostEvent(storage, T, ev(id('a4')));
    await until(() => s.text().includes(id('a4')));
    expect(eventIds(s.text())).toEqual([id('a2'), id('a3'), id('a4')]);
    s.close();
  });

  it('replays from the durable log, not the process ring (process replacement)', async () => {
    const T = `org:rpl-log-${n++}`;
    const cookie = await login(T);
    // Appended but never published: no process ring anywhere ever held them.
    for (const k of ['b1', 'b2', 'b3']) expect(await appendHostEvent(T, ev(id(k)))).not.toBeNull();
    const s = await openStream({ cookie, replay: true, lastEventId: id('b1') });
    await until(() => s.text().includes(id('b3')));
    expect(eventIds(s.text())).toEqual([id('b2'), id('b3')]);
    s.close();
  });

  // ADR 0988 D1 — the legacy request (no `replay=required`) resumes from the durable
  // log when its cursor is not in this process's ring: the restart / other-instance case.
  it('ADR 0988 D1: without replay=required, a cursor only the log holds resumes from the log', async () => {
    const T = `org:rpl-d1-${n++}`;
    const cookie = await login(T);
    for (const k of ['f1', 'f2', 'f3']) expect(await appendHostEvent(T, ev(id(k)))).not.toBeNull();
    const s = await openStream({ cookie, lastEventId: id('f1') });
    expect(s.status).toBe(200);
    await until(() => s.text().includes(id('f3')));
    expect(eventIds(s.text())).toEqual([id('f2'), id('f3')]);
    s.close();
  });

  it('ADR 0988 D1: without replay=required, another tenant\'s real id still opens live and replays nothing', async () => {
    const A = `org:rpl-d1a-${n++}`;
    const B = `org:rpl-d1b-${n++}`;
    const ca = await login(A);
    expect(await appendHostEvent(B, ev(id('f7')))).not.toBeNull();
    expect(await appendHostEvent(B, ev(id('f8')))).not.toBeNull();
    const s = await openStream({ cookie: ca, lastEventId: id('f7') });
    expect(s.status).toBe(200);
    await fanOutHostEvent(storage, A, ev(id('f9')));
    await until(() => s.text().includes(id('f9')));
    expect(eventIds(s.text())).toEqual([id('f9')]);
    s.close();
  });

  it('with replay=required and no Last-Event-ID, opens live and replays nothing', async () => {
    const T = `org:rpl-nocur-${n++}`;
    const cookie = await login(T);
    await fanOutHostEvent(storage, T, ev(id('c1')));
    const s = await openStream({ cookie, replay: true });
    expect(s.contentType).toContain('text/event-stream');
    await fanOutHostEvent(storage, T, ev(id('c2')));
    await until(() => s.text().includes(id('c2')));
    expect(eventIds(s.text())).toEqual([id('c2')]);
    s.close();
  });
});

describe('the uniform refusal (RFC 0250 REFUSAL, ADR 0973 D5)', () => {
  it('unknown, foreign, ephemeral and out-of-grammar cursors get one byte-identical 409 before any SSE byte', async () => {
    const A = `org:rpl-ra-${n++}`;
    const B = `org:rpl-rb-${n++}`;
    const ca = await login(A);
    await fanOutHostEvent(storage, A, ev(id('d1')));
    await fanOutHostEvent(storage, A, ev(id('de'), 'ephemeral'));
    await fanOutHostEvent(storage, B, ev(id('db')));
    // Positive control: A's own durable id resumes.
    const ok = await openStream({ cookie: ca, replay: true, lastEventId: id('d1') });
    expect(ok.status).toBe(200);
    ok.close();

    const refusals = await Promise.all([
      openStream({ cookie: ca, replay: true, lastEventId: id('dead') }), // unknown
      openStream({ cookie: ca, replay: true, lastEventId: id('db') }), // B's real durable id
      openStream({ cookie: ca, replay: true, lastEventId: id('de') }), // an ephemeral id
      openStream({ cookie: ca, replay: true, lastEventId: 'not an event id' }), // outside the grammar
    ]);
    for (const r of refusals) {
      expect(r.status).toBe(409);
      expect(r.contentType).not.toContain('text/event-stream');
    }
    const bodies = new Set(refusals.map((r) => r.text()));
    expect(bodies.size, [...bodies].join('\n')).toBe(1);
    const body = JSON.parse(refusals[0]!.text()) as Record<string, unknown>;
    // Registered in the v2 error registry since 2.46.23, so it is not vendor-prefixed.
    expect(body.error).toBe('host_event_resync_required');
    expect(body.details).toBeUndefined();
    expect(refusals[0]!.text()).not.toContain('dead');

    // Unauthenticated, naming A's REAL id: the scope check's own 401 (RFC 0250
    // §C: auth failures keep their answer), or the uniform 409. Never a stream.
    const anon = await openStream({ replay: true, lastEventId: id('d1') });
    expect([401, 409]).toContain(anon.status);
    expect(anon.contentType).not.toContain('text/event-stream');
    if (anon.status === 409) expect(anon.text()).toBe(refusals[0]!.text());
  });

  it('the log refuses an ephemeral event itself, not only through fanOutHostEvent (MUST 2)', async () => {
    const T = `org:rpl-eph-${n++}`;
    expect(await appendHostEvent(T, ev(id('e9'), 'ephemeral'))).toBeNull();
    expect(await resolveHostEventCursor(T, id('e9'))).toBeNull();
    expect(await appendHostEvent(T, ev(id('e8')))).not.toBeNull(); // control
  });

  it('an expired cursor resolves to the same null; inside the floor it resumes', async () => {
    const T = `org:rpl-exp-${n++}`;
    await fanOutHostEvent(storage, T, ev(id('e1')));
    expect(await resolveHostEventCursor(T, id('e1'))).not.toBeNull();
    const later = Date.now() + HOST_EVENT_REPLAY_MIN_RETENTION_SECONDS * 1000;
    expect(await resolveHostEventCursor(T, id('e1'), later)).toBeNull();
  });

  it('legacy-unchanged: without replay=required an unknown cursor still opens the stream', async () => {
    const s = await openStream({ cookie: await login(`org:rpl-leg-${n++}`), lastEventId: id('dead') });
    expect(s.status).toBe(200);
    expect(s.contentType).toContain('text/event-stream');
    s.close();
  });
});

describe('the hand-off dedupes by id (ADR 0973 D4, architect finding 2)', () => {
  it('a lower sequence committed after the backlog read arrives live exactly once; a late duplicate is dropped', async () => {
    const T = `org:rpl-hole-${n++}`;
    const cookie = await login(T);
    const cursorSeq = await appendHostEvent(T, ev(id('f0')));
    const lowSeq = await appendHostEvent(T, ev(id('f1')));
    const highSeq = await appendHostEvent(T, ev(id('f2')));
    expect(cursorSeq !== null && lowSeq !== null && highSeq !== null && lowSeq < highSeq).toBe(true);
    // Make f1 a hole at backlog time: its row is committed only after the read.
    const key = `hostext:host-event-log:${T}::s::${String(lowSeq).padStart(16, '0')}`;
    const saved = await storage.kvGet(key);
    expect(saved).not.toBeNull();
    await storage.kvDelete(key);
    const s = await openStream({ cookie, replay: true, lastEventId: id('f0') });
    await until(() => s.text().includes(id('f2')));
    await storage.kvSet(key, saved!);
    await publishHostEventToStream(storage, T, ev(id('f1')), lowSeq); // the late commit, live
    await publishHostEventToStream(storage, T, ev(id('f2')), highSeq); // a backlog event's late live frame
    await fanOutHostEvent(storage, T, ev(id('f3'))); // a fence: everything before it has been delivered
    await until(() => s.text().includes(id('f3')));
    expect(eventIds(s.text())).toEqual([id('f2'), id('f1'), id('f3')]);
    s.close();
  });
});

describe('oversized events and teardown (ADR 0973 D3, D6)', () => {
  it('an event too large for NOTIFY reaches a live subscriber and replays', async () => {
    const T = `org:rpl-big-${n++}`;
    const cookie = await login(T);
    await fanOutHostEvent(storage, T, ev(id('g0')));
    const live = await openStream({ cookie });
    const blob = 'x'.repeat(9000); // over the 7,900-byte NOTIFY limit
    await fanOutHostEvent(storage, T, ev(id('g1'), 'durable', { blob }));
    await until(() => live.text().includes(id('g1')));
    expect(live.text()).toContain(blob);
    live.close();
    const replayed = await openStream({ cookie, replay: true, lastEventId: id('g0') });
    await until(() => replayed.text().includes(id('g1')));
    expect(eventIds(replayed.text())).toEqual([id('g1')]);
    expect(replayed.text()).toContain(blob);
    replayed.close();
  });

  it('tenant teardown removes the log, and the cursor is then refused', async () => {
    const T = `org:rpl-gone-${n++}`;
    await fanOutHostEvent(storage, T, ev(id('h1')));
    expect(await resolveHostEventCursor(T, id('h1'))).not.toBeNull();
    await purgeTenantHostExt(T);
    expect(await resolveHostEventCursor(T, id('h1'))).toBeNull();
  });
});

describe('the advertisement (ADR 0973 D8)', () => {
  it('hostEvents.replay = {minRetentionSeconds: 86400}, valid against the vendored capabilities schema', () => {
    resetRfc0250WireCache(true);
    const he = buildV2Advertisement(CONFIG).hostEvents as Record<string, unknown> | undefined;
    expect(he?.replay).toEqual({ minRetentionSeconds: 86_400 });
    const caps = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas', 'v2', 'capabilities.schema.json'), 'utf8')) as {
      properties: { hostEvents: { properties: { replay: Record<string, unknown> } } };
    };
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(caps.properties.hostEvents.properties.replay);
    expect(validate(he?.replay), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ minRetentionSeconds: 0 })).toBe(false); // control: the schema bites
  });
});
