/**
 * `version-negotiation.md` §Stamping — BOTH version axes on the v1 snapshot.
 *
 *   "Every persisted run document MUST carry an eventLogSchemaVersion"  (current v1 value 2)
 *   "Every persisted run document MUST carry an engineVersion: number set to the
 *    writer engine's CURRENT_ENGINE_VERSION at write time"
 *
 * §Legacy detection reads an ABSENT eventLogSchemaVersion as "legacy run" and
 * tells a conforming reader to ignore the event log — so withholding it on the
 * v1 read (which this host did, by design, until 2026-09-04) told every correct
 * v1 client to ignore what we serve. The suite's v1 scenario
 * `era-key-stamped-v1` (rc.26+) reads GET /v1/runs/{id} and asserts a number
 * >= 2 and a numeric engineVersion; both were red on this host.
 *
 * Asserted the way the scenario does: a real run, the v1 read, the two fields.
 * Each leg has its own sabotage (re-gate the era key to major 2; skip the
 * write-time stamp).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { CURRENT_ENGINE_VERSION } from '../src/storage/eventEra.js';

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

describe('v1 snapshot carries both version axes (version-negotiation.md §Stamping)', () => {
  it('a freshly created run reads back on /v1 with eventLogSchemaVersion >= 2 and a numeric engineVersion', async () => {
    const c = await call('POST', '/v1/runs', { workflowId: 'conformance-noop', input: {} });
    expect(c.status).toBe(201);
    const snap = await call('GET', `/v1/runs/${c.json.runId}`);
    expect(snap.status).toBe(200);
    expect(typeof snap.json.eventLogSchemaVersion, 'era key present on the v1 read').toBe('number');
    expect(snap.json.eventLogSchemaVersion, 'a run minted now is not legacy').toBeGreaterThanOrEqual(2);
    expect(typeof snap.json.engineVersion, 'engineVersion stamped at write time').toBe('number');
    expect(snap.json.engineVersion).toBe(CURRENT_ENGINE_VERSION);
  });
});
