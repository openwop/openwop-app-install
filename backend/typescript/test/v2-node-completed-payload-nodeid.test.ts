/**
 * `run-event-payloads.schema.json` $defs/nodeCompleted — `required: ['nodeId']`,
 * `additionalProperties: false`, consistent with nodeStarted/nodeFailed.
 *
 * This host put `nodeId` on the event ENVELOPE and emitted payload `{ outputs }`,
 * so `v2-payload-registry-closed` failed on the payload's own schema. A v2
 * client validating a poll page rejected every node.completed this host has
 * ever emitted. Asserted by running a real workflow through the app.
 *
 * DOUBLE GUARD (named, grade-tests wave 63): the major-2 READ also supplies the
 * envelope's `nodeId` into a payload whose def requires it
 * (`storage/envelopeIdProjection.ts`), and boxes undeclared keys under
 * `vendor.openwop-app` (`storage/vendorKeyCarry.ts`). So a poll page alone cannot
 * see the EMITTER: removing `nodeId` from the emitted payload stayed green when
 * this file read only the poll (probe 8fw4g4-ncp-nodeid, vacuous). The emitter is
 * now asserted on the STORED event, and the wire on the poll page against the
 * closed def itself (Ajv over the vendored corpus).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';

const TOKEN = 'dev-token';
const V2_SCHEMAS = join(process.cwd(), '..', '..', 'schemas', 'v2');
let server: http.Server; let base = ''; let storage: Storage;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

interface WireEvent { type: string; nodeId?: string; payload?: Record<string, unknown> }
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: { runId?: string; events?: WireEvent[] } | undefined }> {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => undefined)) as { runId?: string; events?: WireEvent[] } | undefined };
}

/** The closed `$defs/<name>` validator, every sibling v2 schema registered so `$ref`s resolve. */
function payloadDef(name: string): (d: unknown) => boolean {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  for (const f of readdirSync(V2_SCHEMAS).filter((x) => x.endsWith('.schema.json'))) {
    try { ajv.addSchema(JSON.parse(readFileSync(join(V2_SCHEMAS, f), 'utf8')) as object); } catch { /* duplicate $id */ }
  }
  const v = ajv.getSchema(`https://openwop.dev/spec/v2/run-event-payloads.schema.json#/$defs/${name}`);
  if (!v) throw new Error(`$defs/${name} did not compile`);
  return v;
}

describe('node.completed payload carries nodeId (nodeCompleted.required)', () => {
  it('a real run emits node.completed whose PAYLOAD has nodeId equal to the envelope nodeId', async () => {
    const c = await call('POST', '/runs', { workflowId: 'conformance-noop', inputs: {} });
    expect(c.status).toBe(201);
    const runId = String(c.json?.runId);
    let events: WireEvent[] = [];
    for (let i = 0; i < 40; i++) {
      const p = await call('GET', `/runs/${encodeURIComponent(runId)}/events/poll`);
      events = p.json?.events ?? [];
      if (events.some((e) => e.type === 'run.completed' || e.type === 'run.failed')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const done = events.filter((e) => e.type === 'node.completed');
    expect(done.length, 'the noop fixture must complete at least one node').toBeGreaterThan(0);

    // The WIRE: every node.completed payload validates against the CLOSED def.
    const valid = payloadDef('nodeCompleted');
    for (const e of done) {
      expect(e.payload?.nodeId).toBe(e.nodeId);
      expect(valid(e.payload), `wire payload ${JSON.stringify(e.payload)} violates $defs/nodeCompleted`).toBe(true);
    }

    // The EMITTER: the stored payload carries nodeId itself, and nothing outside the def.
    const stored = (await storage.listEvents(runId.slice(runId.indexOf('/') + 1), { contract: 1 })).filter((e) => e.type === 'node.completed');
    expect(stored.length).toBe(done.length);
    for (const e of stored) {
      const payload = e.payload as Record<string, unknown>;
      expect(payload.nodeId, 'the emitter writes nodeId INTO the payload').toBe(e.nodeId);
      expect(Object.keys(payload).filter((k) => !['nodeId', 'outputs', 'durationMs'].includes(k)), 'no key outside the closed def').toEqual([]);
    }
  });
});
