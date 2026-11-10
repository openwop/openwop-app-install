/**
 * SEED-RS-2 — example-data route wiring (ADR 0292).
 *
 * Locks the streaming + gating wiring the unit tests can't reach:
 *   - `POST /example-data/run` with `Accept: application/x-ndjson` STREAMS one
 *     `{type:'step'}` line per seeder then a `{type:'summary'}` line;
 *   - the same route WITHOUT that Accept returns the aggregate JSON;
 *   - `POST /example-data/provision-demo` is superadmin-gated (403 `forbidden`
 *     with the requireSuperadmin message for an authenticated non-superadmin).
 *
 * Tracker: TST-DBA-1. Red when: the per-step `write({type:'step'})` is dropped,
 * the summary line reports `success:false`, `wantsStream` answers true without
 * the ndjson Accept, or `requireSuperadmin` is removed from provision-demo
 * (probes w70g2-edr-step / -summary / -json / -superadmin).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createApp } from '../src/index.js';
import type { RunResult, StepResult } from '../src/host/exampleDataSeeders.js';

type StreamLine = ({ type: 'step' } & StepResult) | { type: 'summary'; success: boolean; summary: RunResult['summary'] };

describe('example-data routes (streaming + provision gate)', () => {
  let server: http.Server;
  let BASE: string;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    // Cookie auth ON so a bearer-less request is an authenticated NON-superadmin
    // (exercises the provision-demo 403 gate), and no superadmin allowlist.
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  const runPath = '/host/openwop-app/example-data/run';
  const provisionPath = '/host/openwop-app/example-data/provision-demo';

  it('streams NDJSON (step lines + a summary) when Accept: application/x-ndjson', async () => {
    const res = await fetch(`${BASE}${runPath}`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify({ steps: ['demo-people'], expectedTenantId: 'default' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines: StreamLine[] = (await res.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as StreamLine);
    const step = lines.find((l): l is { type: 'step' } & StepResult => l.type === 'step' && l.step === 'demo-people');
    expect(step).toBeDefined();
    expect(['created', 'skipped']).toContain(step?.action);
    const summary = lines.find((l): l is Extract<StreamLine, { type: 'summary' }> => l.type === 'summary');
    expect(summary?.success).toBe(true);
    expect(summary?.summary.total).toBe(1); // one step selected → one step run
  });

  it('returns aggregate JSON (not a stream) without the ndjson Accept', async () => {
    const res = await fetch(`${BASE}${runPath}`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' },
      body: JSON.stringify({ steps: ['demo-people'], expectedTenantId: 'default' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as RunResult;
    expect(body.results.map((r) => r.step)).toEqual(['demo-people']);
    expect(body.summary.total).toBe(1);
  });

  it('provision-demo denies an authenticated non-superadmin (403)', async () => {
    const res = await fetch(`${BASE}${provisionPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' }, // no bearer ⇒ anon cookie session
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('forbidden');
    expect(body.message).toContain('Demo-tenant provisioning requires a superadmin principal');
  });
});
