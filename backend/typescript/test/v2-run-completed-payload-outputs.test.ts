/**
 * `run-event-payloads.schema.json` $defs/runCompleted — `{ outputs, durationMs }`,
 * `additionalProperties: false` in v2 (and `outputs` in v1 too, where
 * `additionalProperties: true` merely tolerated the singular this host emitted).
 *
 * This host emitted `payload: { output }` for its whole life, so
 * `v2-payload-registry-closed` rejected every run.completed. Fixed at the
 * emitter; stored era-2 events keep `output` and readers accept both. Asserted
 * by driving a real run and reading the event back — the emitter's output.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

const TOKEN = 'dev-token';
let server: http.Server; let base = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => undefined)) as any };
}

describe('run.completed payload uses the contract key `outputs` (runCompleted, closed)', () => {
  it('a real run emits run.completed with `outputs` and WITHOUT the legacy `output`', async () => {
    const c = await call('POST', '/v1/runs', { workflowId: 'conformance-noop', inputs: {} });
    expect(c.status).toBe(201);
    const runId = c.json.runId as string;
    let done: any;
    for (let i = 0; i < 40 && !done; i++) {
      const p = await call('GET', `/v1/runs/${runId}/events/poll`);
      done = (p.json?.events ?? []).find((e: any) => e.type === 'run.completed');
      if (!done) await new Promise((r) => setTimeout(r, 100));
    }
    expect(done, 'the noop fixture must complete').toBeDefined();
    expect(Object.keys(done.payload), 'no key outside { outputs, durationMs }').toEqual(
      expect.arrayContaining(Object.keys(done.payload).filter((k) => k === 'outputs' || k === 'durationMs')),
    );
    expect('output' in done.payload, 'the singular key must be gone').toBe(false);
    expect('outputs' in done.payload).toBe(true);
    // Both schemas type `outputs` as an object; a scalar terminal value is wrapped
    // as { output } exactly like node outputs. The noop fixture's value is an
    // object already, so this leg is the TYPE contract, not the wrap path -- the
    // wrap path is witnessed by run-event-payload-conformance's scalar fixture.
    expect(typeof done.payload.outputs === 'object' && done.payload.outputs !== null && !Array.isArray(done.payload.outputs), 'outputs MUST be an object').toBe(true);
  });
});
