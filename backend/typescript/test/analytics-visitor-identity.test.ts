/**
 * ADR 0569 — cookieless visitor identity (daily-rotating salted hash).
 *
 * Pins, both polarities:
 *  - same visitor (IP+UA) same day → ONE daily unique; different UA → two.
 *  - `analytics-visitor-identity` OFF → NO visitor dimension at all (counts
 *    only; no `visitorHash` on rows, no `uniqueVisitors` on the summary).
 *  - the raw IP/UA sentinels NEVER persist (absent from the stored rows and
 *    every reporting response).
 *  - the NEVER-LOGGED tripwire: the day's salt appears in no console output
 *    and no route response (the discipline gets a test, not a comment).
 *  - rotation: a new UTC day mints a NEW salt, DELETES the prior day's row,
 *    and the same visitor hashes differently (cross-day unlinkability).
 *  - `countDailyUniques` mechanism (pure, apart from wiring — ADR 0502):
 *    per-day distinct, summed across days; hashless rows contribute nothing.
 *  - ANL-1 — the TTL ADR 0569 decision 2 claimed and did not have, BOTH layers:
 *    the mint-time sweep across a TRAFFIC GAP (the case the consecutive-day
 *    rotation test above is structurally unable to see), and the
 *    `registerKvAgeOut` lane that reclaims with NO mint at all.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __resetAnalyticsStore, countDailyUniques, listEvents } from '../src/features/analytics/analyticsService.js';
import { ensureDailySalt, visitorHashFor, __peekSaltForTest, __resetVisitorSalts, __sweepExpiredSaltsForTest, SALT_TTL_DAYS } from '../src/features/analytics/visitorIdentity.js';
import { __listKvAgeOutForTest, __runKvAgeOutOnce } from '../src/host/kvAgeOut.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'analytics', 'analytics-visitor-identity']) {
    const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(async () => { await __resetAnalyticsStore(); });

interface Res<T = any> { status: number; body: T }
function client(initialCookie = '') {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(headers ?? {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    const sc = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [];
    for (const c of sc) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown, hd?: Record<string, string>) => call('POST', p, b, hd),
  };
}
const pub = client();
let n = 0;
async function ownerWithOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const su = await owner.post('/v1/host/openwop-app/test/login', { email: `vid-${Date.now()}-${n++}@acme.test` });
  expect(su.status, JSON.stringify(su.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const tenantId = String(org.body.tenantId ?? su.body.user?.tenantId ?? su.body.tenantId ?? '');
  expect(tenantId, 'the org row carries its tenant — needed to read the STORED row').toBeTruthy();
  return { owner, orgId: org.body.orgId, tenantId };
}
const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test');
};

const IP_SENTINEL = '203.0.113.77'; // TEST-NET-3 — never a real client
const UA_SENTINEL = 'ADR0569-UA-Sentinel/1.0';
const beacon = (orgId: string, body: Record<string, unknown>, ua = UA_SENTINEL, ip = IP_SENTINEL) =>
  pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, body, { 'x-forwarded-for': ip, 'user-agent': ua });

describe('ADR 0569 — visitor identity at ingest', () => {
  it('same IP+UA on one day = ONE daily unique; a different UA = a second', async () => {
    const { owner, orgId } = await ownerWithOrg();
    expect((await beacon(orgId, { type: 'pageview', path: '/a' })).status).toBe(201);
    expect((await beacon(orgId, { type: 'pageview', path: '/b' })).status).toBe(201);
    let sum = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/summary`);
    expect(sum.body.summary.uniqueVisitors).toBe(1);
    expect(typeof sum.body.summary.uniqueVisitorsSince).toBe('string');

    expect((await beacon(orgId, { type: 'pageview', path: '/c' }, 'Other-Agent/2.0')).status).toBe(201);
    sum = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/summary`);
    expect(sum.body.summary.uniqueVisitors).toBe(2);
  });

  it('a client-supplied visitorHash is IGNORED — the hash is server-computed only', async () => {
    const { owner, orgId } = await ownerWithOrg();
    // An attacker inflating uniques would send a fresh hash per hit.
    expect((await beacon(orgId, { type: 'pageview', path: '/x', visitorHash: 'attacker-hash-1' })).status).toBe(201);
    expect((await beacon(orgId, { type: 'pageview', path: '/y', visitorHash: 'attacker-hash-2' })).status).toBe(201);
    const sum = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/summary`);
    expect(sum.body.summary.uniqueVisitors).toBe(1); // same IP+UA ⇒ still ONE visitor
    const evs = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/events`);
    expect(JSON.stringify(evs.body)).not.toContain('attacker-hash');
  });

  it('the trend carries per-day uniques (today ≥ 1 after a hashed hit)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    expect((await beacon(orgId, { type: 'pageview', path: '/t' })).status).toBe(201);
    const trend = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/trend?days=7`);
    const today = new Date().toISOString().slice(0, 10);
    const point = (trend.body.trend as { day: string; uniques: number }[]).find((p) => p.day === today);
    expect(point?.uniques).toBe(1);
  });

  it('toggle OFF ⇒ counts only: no visitorHash on rows, no uniqueVisitors on the summary', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await setToggle('analytics-visitor-identity', 'off');
    try {
      // The client-supplied hash rides the OFF path too — the window where a
      // body-read regression would actually land (with the toggle ON the
      // server hash always wins, so only THIS polarity can catch it).
      expect((await beacon(orgId, { type: 'pageview', path: '/off', visitorHash: 'attacker-hash-3' })).status).toBe(201);
      const sum = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/summary`);
      expect(sum.body.summary.total).toBe(1); // the event IS recorded (counts only)
      expect(sum.body.summary.uniqueVisitors).toBeUndefined();
      const evs = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/events`);
      expect(JSON.stringify(evs.body)).not.toContain('visitorHash');
    } finally { await setToggle('analytics-visitor-identity', 'on'); }
  });

  it('the raw IP/UA sentinels are NEVER persisted or served', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    expect((await beacon(orgId, { type: 'pageview', path: '/pii' })).status).toBe(201);
    const evs = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/events`);
    const sum = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/summary`);
    for (const payload of [JSON.stringify(evs.body), JSON.stringify(sum.body)]) {
      expect(payload).not.toContain(IP_SENTINEL);
      expect(payload).not.toContain(UA_SENTINEL);
    }
    // The hash IS on the stored row (the dimension exists) — just not the raws.
    // ANL-15 (2026-09-10) — the hash is PERSISTED (the proof the raw IP/UA were
    // replaced) but no longer SERVED: the events response is projected to the
    // declared client shape, and a salted per-visitor hash is re-identifying to a
    // workspace member holding the day's salt. This line used to assert it was served.
    expect(JSON.stringify(await listEvents(tenantId, orgId, 10))).toContain('visitorHash');
    expect(JSON.stringify(evs.body)).not.toContain('visitorHash');
  });

  it('NEVER-LOGGED tripwire: the day salt reaches no console output and no response', async () => {
    const captured: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { captured.push(args.map(String).join(' ')); }));
    try {
      const { owner, orgId } = await ownerWithOrg();
      expect((await beacon(orgId, { type: 'pageview', path: '/salt' })).status).toBe(201);
      const salt = await __peekSaltForTest();
      expect(salt).toBeTruthy(); // the mint happened
      const evs = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/events`);
      const sum = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/summary`);
      for (const line of captured) expect(line).not.toContain(salt!);
      expect(JSON.stringify(evs.body)).not.toContain(salt!);
      expect(JSON.stringify(sum.body)).not.toContain(salt!);
    } finally { spies.forEach((s) => s.mockRestore()); }
  });

  it('rotation: a new UTC day mints a NEW salt, deletes the prior row, and the same visitor hashes differently', async () => {
    await __resetVisitorSalts();
    const day1 = Date.UTC(2026, 7, 20, 12);
    const day2 = day1 + 86_400_000;
    const fakeReq = {
      header: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? IP_SENTINEL : name.toLowerCase() === 'user-agent' ? UA_SENTINEL : undefined),
      socket: { remoteAddress: IP_SENTINEL },
    } as unknown as Request;
    const salt1 = await ensureDailySalt(day1);
    const h1 = await visitorHashFor('t1', 'org1', fakeReq, day1);
    const salt2 = await ensureDailySalt(day2);
    const h2 = await visitorHashFor('t1', 'org1', fakeReq, day2);
    expect(salt1).not.toBe(salt2);
    expect(h1).toBeTruthy();
    expect(h1).not.toBe(h2); // cross-day unlinkability
    expect(await __peekSaltForTest(day1)).toBeNull(); // prior salt DISCARDED
    expect(await __peekSaltForTest(day2)).toBe(salt2);
  });

  it('ANL-1 — a TRAFFIC GAP does not orphan a salt: the next mint reclaims EVERY past day', async () => {
    // THE CASE THE ROTATION TEST ABOVE CANNOT SEE. It steps day1 → day1+1d, so
    // `delete(utcDay(now − 1d))` happens to hit day1 and the test passes over a
    // reclaim that only ever covers ONE day. Step a GAP instead — an idle site,
    // a quiet weekend, a low-traffic org — and the old code left day1's salt in
    // the store forever, which makes sha256(salt|orgId|ip|ua) brute-forceable
    // over the IP×UA space and re-identifies every visitorHash from that day.
    await __resetVisitorSalts();
    const day1 = Date.UTC(2026, 7, 20, 12);
    const day4 = day1 + 3 * 86_400_000; // 3-day gap: NOTHING minted on day2/day3
    const salt1 = await ensureDailySalt(day1);
    expect(await __peekSaltForTest(day1)).toBe(salt1);
    const salt4 = await ensureDailySalt(day4);
    expect(salt4).not.toBe(salt1);
    // FAILS against the pre-ANL-1 code: it deleted only utcDay(day4 − 1d) = day3,
    // a day that was never minted, leaving day1's salt permanently live.
    expect(await __peekSaltForTest(day1), 'the gapped day\'s salt must be reclaimed').toBeNull();
    expect(await __peekSaltForTest(day4)).toBe(salt4);
  });

  it('ANL-1 — the sweep MECHANISM keeps today and takes past days (both polarities, apart from the mint)', async () => {
    // Mechanism tested apart from its wiring (the ADR 0502 lesson): a sweep that
    // took today's row would split the day's uniques, and one that took nothing
    // is the defect. Assert BOTH directions on the same seeded state.
    await __resetVisitorSalts();
    const d1 = Date.UTC(2026, 7, 10, 6);
    const d3 = d1 + 2 * 86_400_000;
    const salt1 = await ensureDailySalt(d1);
    expect(await __sweepExpiredSaltsForTest(d1), 'sweeping ON d1 must keep d1').toBe(0);
    expect(await __peekSaltForTest(d1)).toBe(salt1);
    expect(await __sweepExpiredSaltsForTest(d3), 'sweeping two days later takes it').toBe(1);
    expect(await __peekSaltForTest(d1)).toBeNull();
  });

  it('ANL-1 — the salt is registered on the kvAgeOut lane, so it expires with NO mint at all', async () => {
    // The layer that makes ADR 0569 decision 2's "(a) the TTL" a real bound
    // rather than a hope that the site gets another visitor. Layer 1 (the mint
    // sweep) cannot run on a site with no traffic — this one can.
    const reg = __listKvAgeOutForTest().find((r) => r.id === 'analytics:visitor-salt');
    expect(reg, 'analytics:visitor-salt must be registered for age-out').toBeTruthy();
    expect(reg!.prefix).toBe('hostext:analytics:visitor-salt:');
    expect(reg!.ttlDays).toBe(SALT_TTL_DAYS);
    expect(reg!.timestampField).toBe('mintedAt');

    await __resetVisitorSalts();
    const day1 = Date.UTC(2026, 7, 20, 12);
    await ensureDailySalt(day1);
    expect(await __peekSaltForTest(day1)).toBeTruthy();
    const storage = __hostExtStorage();
    expect(storage, 'hostext storage must be bound by createApp').toBeTruthy();
    // A tick one hour after the mint must NOT take a live salt…
    await __runKvAgeOutOnce(storage!, new Date(day1 + 3_600_000));
    expect(await __peekSaltForTest(day1), 'a LIVE salt survives the tick').toBeTruthy();
    // …and a tick past the TTL must take it, with no mint in between.
    await __runKvAgeOutOnce(storage!, new Date(day1 + SALT_TTL_DAYS * 86_400_000 + 3_600_000));
    expect(await __peekSaltForTest(day1), 'an EXPIRED salt is reclaimed without a mint').toBeNull();
  });

  it('ANL-1 R2 — a LEGACY row with no `mintedAt` is still reclaimed by layer 2 (the population the bound was for)', async () => {
    // `mintedAt` is stamped only by a NEW mint and no migration backfills it,
    // while the age-out lane SKIPS a row whose timestamp is not finite. So
    // without a derivation every pre-existing `{day, salt}` row — precisely the
    // orphaned-by-a-traffic-gap population ANL-1 was about — was invisible to
    // layer 2 forever, and layer 1 needs a mint it will never get. Seed the
    // legacy shape directly (a mint cannot produce it) and pin BOTH polarities.
    await __resetVisitorSalts();
    const storage = __hostExtStorage();
    expect(storage, 'hostext storage must be bound by createApp').toBeTruthy();
    const legacy = (day: string) =>
      storage!.kvSet(`hostext:analytics:visitor-salt:${day}`, JSON.stringify({ day, salt: 'f'.repeat(64) }));

    await legacy('2026-07-01'); // long orphaned
    await legacy('2026-08-20'); // "today" for the tick below
    const tick = new Date(Date.UTC(2026, 7, 20, 13));

    await __runKvAgeOutOnce(storage!, tick);

    expect(
      await storage!.kvGet('hostext:analytics:visitor-salt:2026-07-01'),
      'a legacy orphan must NOT survive the TTL just because it predates `mintedAt`',
    ).toBeNull();
    expect(
      await storage!.kvGet('hostext:analytics:visitor-salt:2026-08-20'),
      "TODAY's legacy row must survive — deriving midnight must not expire a live salt",
    ).toBeTruthy();
  });

  it('countDailyUniques mechanism: per-day distinct, summed across days; hashless rows contribute nothing', () => {
    expect(countDailyUniques([])).toEqual({ uniques: 0 });
    expect(countDailyUniques([
      { ts: '2026-08-10T01:00:00.000Z', visitorHash: 'aaa' },
      { ts: '2026-08-10T02:00:00.000Z', visitorHash: 'aaa' }, // same day dedup
      { ts: '2026-08-11T01:00:00.000Z', visitorHash: 'aaa' }, // next day RE-counts (by design)
      { ts: '2026-08-11T03:00:00.000Z', visitorHash: 'bbb' },
      { ts: '2026-08-11T04:00:00.000Z' },                     // hashless — nothing
    ])).toEqual({ uniques: 3, since: '2026-08-10T01:00:00.000Z' });
  });
});
