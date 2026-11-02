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
 *
 * What is unique here (vs the pure `slo-projection.test.ts`, which already
 * asserts `unknown` for a null snapshot): the WIRING — with the profile off the
 * route hands the projection `snapshot: null`, never an empty one. Sabotage,
 * each red (w74 round 1): the route passing `[]` instead of `null` ("still
 * serves", "answers unknown"); answering the no-reader rows `healthy`; reading
 * the dispatch rows only when a snapshot exists; raising an alert for
 * `unknown`; dropping `requireSuperadmin`; filling `window.startedAt`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { _resetMetricsProviderForTest, localScrapeEnabled } from '../src/observability/metrics.js';
import { recordEffectBlocked } from '../src/observability/metricSeams.js';
import type { SloProjection, SloRow } from '../src/observability/sloProjection.js';

const SUPER_TENANT = 'org:test-slo-off-super';
const OPS = '/host/openwop-app/operations';

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
}, 120_000);

afterAll(async () => {
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  _resetMetricsProviderForTest();
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T> { status: number; body: T }
/** The flat S22 refusal envelope (`middleware/errorEnvelope.ts`). */
interface Refusal { error: string; message: string; rows?: unknown }

/** The catalog has 32 rows (`slo-projection.test.ts` "covers all 32 published
 *  objectives"): 2 not projectable (C2, Q1) and 2 read from the queue table
 *  (Q2, Q4 — `outbox_max`; Q3 is a `zero` objective over a metric), so exactly
 *  28 rows depend on telemetry. Counted from `sloProjection.ts`, and measured. */
const METRIC_DERIVED_ROWS = 28;

function row(rows: readonly SloRow[], id: string): SloRow {
  const found = rows.find((r) => r.id === id);
  expect(found, `row ${id}`).toBeDefined();
  return found!;
}
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

let n = 0;
async function login(tenantId: string) {
  const c = client();
  const r = await c.post<unknown>('/host/openwop-app/test/login', { email: `slooff-${Date.now()}-${n++}@acme.test`, tenantId });
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
    const r = await c.get<SloProjection>(`${OPS}/slo/summary`);
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
    const { rows } = (await c.get<SloProjection>(`${OPS}/slo/summary`)).body;
    const metricDerived = rows.filter((r) => r.state !== 'not_projectable' && r.source !== 'dispatch-outbox-stats');
    expect(metricDerived.length).toBe(METRIC_DERIVED_ROWS);
    expect(metricDerived.every((r) => r.state === 'unknown')).toBe(true);
    expect(metricDerived.every((r) => r.observed === null)).toBe(true);
    expect(metricDerived.some((r) => r.state === 'healthy')).toBe(false);
    // R1 specifically: an effect WAS blocked, and the panel must not imply none was.
    expect(row(rows, 'R1').state).toBe('unknown');
  });

  it('still answers the dispatch rows — they read the queue table, not telemetry', async () => {
    const c = await login(SUPER_TENANT);
    const { rows } = (await c.get<SloProjection>(`${OPS}/slo/summary`)).body;
    const q2 = row(rows, 'Q2');
    expect(q2.source).toBe('dispatch-outbox-stats');
    expect(q2.state).toBe('healthy');
  });

  it('raises no alerts — `unknown` is not a breach', async () => {
    const c = await login(SUPER_TENANT);
    expect((await c.get<SloProjection>(`${OPS}/slo/summary`)).body.alerts).toEqual([]);
  });

  it('keeps the gate exactly as it is with the profile on', async () => {
    // The profile is a telemetry setting, never an authorization one.
    expect((await client().get<Refusal>(`${OPS}/slo/summary`)).status).toBe(403);
    const member = await login('org:not-an-operator');
    const r = await member.get<Refusal>(`${OPS}/slo/summary`);
    expect(r.status).toBe(403);
    expect(r.body.rows).toBeUndefined();
    expect(r.body.error).toBe('forbidden');
  });
});
