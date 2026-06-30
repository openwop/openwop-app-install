/**
 * RFC 0118 — the live parallel-fan-out witness over HTTP. Boots the real app with
 * OPENWOP_TEST_SEAM_ENABLED=true and proves the witness is non-vacuous against the fixed
 * conformance seam the pinned suite drives:
 *   - /.well-known/openwop advertises dispatch.fanOutSupported + "parallel" in fanOutPolicies
 *   - POST /v1/host/sample/dispatch/fanout (the canonical conformance path) joins a wait-all/
 *     collect fan-out with joinOutcome:'satisfied', children[] of the right length, mergeOrder[]
 *   - the product path /v1/host/openwop-app/dispatch/fanout serves the same handler
 *
 * Mirrors conformance/src/scenarios/dispatch-fanout-parallel.test.ts (capability-gated).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const SAMPLE = () => `${BASE}/v1/host/sample/dispatch/fanout`;
const PRODUCT = () => `${BASE}/v1/host/openwop-app/dispatch/fanout`;
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) });
const waitAll = { nextWorkerIds: ['conformance.child.a', 'conformance.child.b', 'conformance.child.c'], config: { fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' } } };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('RFC 0118 — live parallel-fan-out witness', () => {
  it('advertises dispatch.fanOutSupported + parallel at the discovery root', async () => {
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      dispatch?: { supported?: boolean; fanOutSupported?: boolean; fanOutPolicies?: string[]; joinModes?: string[]; onChildFailureModes?: string[]; maxFanOut?: number };
    };
    expect(doc.dispatch?.fanOutSupported).toBe(true);
    expect(doc.dispatch?.fanOutPolicies).toContain('parallel');
    // Honesty: only `wait-all` is honored end-to-end (no in-flight child cancellation yet).
    expect(doc.dispatch?.joinModes).toEqual(['wait-all']);
    // RFC 0118 §seam amendment (openwop#789): the second join axis is author-discoverable.
    expect(doc.dispatch?.onChildFailureModes).toEqual(['collect', 'absorb']);
    expect(typeof doc.dispatch?.maxFanOut).toBe('number');
  });

  it('joins a wait-all/collect fan-out over all children with joinOutcome satisfied', async () => {
    const res = await post(SAMPLE(), waitAll);
    expect(res.status).toBe(200);
    const body = await res.json() as { joinOutcome?: string; children?: unknown[]; mergeOrder?: string[] };
    expect(body.joinOutcome).toBe('satisfied');
    expect(body.children).toHaveLength(3);
    expect(Array.isArray(body.mergeOrder)).toBe(true);
    expect(body.mergeOrder).toHaveLength(3);
  });

  it('serves the same handler at the product path', async () => {
    const res = await post(PRODUCT(), waitAll);
    expect(res.status).toBe(200);
    expect((await res.json() as { joinOutcome?: string }).joinOutcome).toBe('satisfied');
  });

  it('rejects a non-parallel or under-2-children request with 400', async () => {
    expect((await post(SAMPLE(), { nextWorkerIds: ['only-one'], config: { fanOutPolicy: 'parallel' } })).status).toBe(400);
    expect((await post(SAMPLE(), { nextWorkerIds: ['a', 'b'], config: { fanOutPolicy: 'sequential' } })).status).toBe(400);
  });
});
