/**
 * ADR 0556 P2 — the SLO route with the local-scrape profile OFF.
 *
 * A separate file because `createMetrics` installs a process-wide meter
 * provider, so "profile on" and "profile off" cannot both be true in one vitest
 * worker file without the second boot inheriting the first's decision.
 *
 * The property under test is the one most likely to be got wrong in the
 * flattering direction: an operator who has NOT enabled the profile must see
 * `unknown`, and must never see a panel that reads as healthy. A host with no
 * reader records every blocked effect it suffers and can report none of them —
 * so silence here is the absence of evidence, not evidence of absence, and the
 * route has to say which.
 *
 * The gate is unchanged by the profile: it is an authorization boundary, not a
 * telemetry one.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { _resetMetricsProviderForTest, localScrapeEnabled } from '../src/observability/metrics.js';
import { recordEffectBlocked } from '../src/observability/metricSeams.js';

const SUPER_TENANT = 'org:test-slo-off-super';
const OPS = '/v1/host/openwop-app/operations';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SUPERADMIN_TENANTS = SUPER_TENANT;
  delete process.env.OPENWOP_METRICS_LOCAL_SCRAPE;
  _resetMetricsProviderForTest();
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 60_000);

afterAll(async () => {
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  _resetMetricsProviderForTest();
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

let n = 0;
async function login(tenantId: string) {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `slooff-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return c;
}

describe('ADR 0556 P2 — profile off', () => {
  it('confirms the profile really is off (the precondition)', () => {
    // Without this the whole file could pass against a host that HAS a reader,
    // asserting nothing about the state it claims to cover.
    expect(localScrapeEnabled()).toBe(false);
  });

  it('still serves an operator — the panel works, it just cannot see', async () => {
    const c = await login(SUPER_TENANT);
    const r = await c.get(`${OPS}/slo/summary`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.source).toBe('unavailable');
    expect(r.body.window.startedAt).toBeNull();
  });

  it('answers `unknown` for every metric-derived row, and NEVER healthy', async () => {
    // Recorded first, so the host genuinely has something to hide: this is the
    // exact scenario where a naive projection would report "0 blocked effects,
    // all good" while the process has in fact blocked one.
    recordEffectBlocked('network-egress');
    const c = await login(SUPER_TENANT);
    const rows = (await c.get(`${OPS}/slo/summary`)).body.rows as any[];
    const metricDerived = rows.filter((row) => row.state !== 'not_projectable' && row.source !== 'dispatch-outbox-stats');
    expect(metricDerived.length).toBeGreaterThan(20);
    expect(metricDerived.every((row) => row.state === 'unknown')).toBe(true);
    expect(metricDerived.every((row) => row.observed === null)).toBe(true);
    expect(metricDerived.some((row) => row.state === 'healthy')).toBe(false);
    // R1 specifically: an effect WAS blocked, and the panel must not imply none was.
    expect(rows.find((row) => row.id === 'R1').state).toBe('unknown');
  });

  it('still answers the dispatch rows — they read the queue table, not telemetry', async () => {
    const c = await login(SUPER_TENANT);
    const rows = (await c.get(`${OPS}/slo/summary`)).body.rows as any[];
    const q2 = rows.find((row) => row.id === 'Q2');
    expect(q2.source).toBe('dispatch-outbox-stats');
    expect(q2.state).toBe('healthy');
  });

  it('raises no alerts — `unknown` is not a breach', async () => {
    const c = await login(SUPER_TENANT);
    expect((await c.get(`${OPS}/slo/summary`)).body.alerts).toEqual([]);
  });

  it('keeps the gate exactly as it is with the profile on', async () => {
    // The profile is a telemetry setting, never an authorization one.
    expect((await client().get(`${OPS}/slo/summary`)).status).toBe(403);
    const member = await login('org:not-an-operator');
    const r = await member.get(`${OPS}/slo/summary`);
    expect(r.status).toBe(403);
    expect(r.body?.rows).toBeUndefined();
    expect(r.body.error).toBe('forbidden');
  });
});
