/**
 * `run-event-payloads.schema.json` $defs/nodeCompleted — `required: ['nodeId']`,
 * `additionalProperties: false`, consistent with nodeStarted/nodeFailed.
 *
 * This host put `nodeId` on the event ENVELOPE and emitted payload `{ outputs }`,
 * so `v2-payload-registry-closed` failed on the payload's own schema. A v2
 * client validating a poll page rejected every node.completed this host has
 * ever emitted. Asserted here by running a real workflow through the app and
 * reading the event back — the emitter's output, not its source.
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

describe('node.completed payload carries nodeId (nodeCompleted.required)', () => {
  it('a real run emits node.completed whose PAYLOAD has nodeId equal to the envelope nodeId', async () => {
    const c = await call('POST', '/v1/runs', { workflowId: 'conformance-noop', inputs: {} });
    expect(c.status).toBe(201);
    const runId = c.json.runId as string;
    let events: any[] = [];
    for (let i = 0; i < 40; i++) {
      const p = await call('GET', `/v1/runs/${runId}/events/poll`);
      events = p.json?.events ?? [];
      if (events.some((e) => e.type === 'run.completed' || e.type === 'run.failed')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const done = events.filter((e) => e.type === 'node.completed');
    expect(done.length, 'the noop fixture must complete at least one node').toBeGreaterThan(0);
    for (const e of done) {
      expect(typeof e.payload?.nodeId, `payload.nodeId on ${JSON.stringify(e.payload)}`).toBe('string');
      expect(e.payload.nodeId).toBe(e.nodeId);
    }
  });
});
