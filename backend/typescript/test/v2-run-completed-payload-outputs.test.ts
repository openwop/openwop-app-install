/**
 * `run-event-payloads.schema.json` $defs/runCompleted — `{ outputs, durationMs }`,
 * `additionalProperties: false` in v2 (and `outputs` in v1 too, where
 * `additionalProperties: true` merely tolerated the singular this host emitted).
 *
 * This host emitted `payload: { output }` for its whole life, so
 * `v2-payload-registry-closed` rejected every run.completed. Fixed at the
 * emitter; stored era-2 events keep `output` and readers accept both. Asserted
 * by driving a real run.
 *
 * Corrected in grade-tests wave 63: the "no key outside { outputs, durationMs }"
 * line compared a filtered copy of the payload's keys with the keys themselves,
 * so it could not fail (probe 8fw4g4-rcp-extra-key, vacuous). It now reads the
 * STORED event (the emitter's own output — the major-2 read boxes undeclared
 * keys under `vendor.openwop-app`, so the poll page cannot see an extra key) and
 * validates the poll page against the closed def.
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

interface WireEvent { type: string; payload?: Record<string, unknown> }
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

describe('run.completed payload uses the contract key `outputs` (runCompleted, closed)', () => {
  it('a real run emits run.completed with `outputs` and WITHOUT the legacy `output`', async () => {
    const c = await call('POST', '/runs', { workflowId: 'conformance-noop', inputs: {} });
    expect(c.status).toBe(201);
    const runId = String(c.json?.runId);
    let done: WireEvent | undefined;
    for (let i = 0; i < 40 && !done; i++) {
      const p = await call('GET', `/runs/${encodeURIComponent(runId)}/events/poll`);
      done = (p.json?.events ?? []).find((e) => e.type === 'run.completed');
      if (!done) await new Promise((r) => setTimeout(r, 50));
    }
    expect(done, 'the noop fixture must complete').toBeDefined();
    // The WIRE: validates against the closed def.
    expect(payloadDef('runCompleted')(done!.payload), `wire payload ${JSON.stringify(done!.payload)}`).toBe(true);

    // The EMITTER: the stored payload, before any read-side projection.
    const stored = (await storage.listEvents(runId.slice(runId.indexOf('/') + 1), { contract: 1 })).find((e) => e.type === 'run.completed');
    const payload = stored?.payload as Record<string, unknown> | undefined;
    expect(payload, 'the run.completed row is stored').toBeDefined();
    expect(Object.keys(payload!).filter((k) => k !== 'outputs' && k !== 'durationMs'), 'no key outside { outputs, durationMs }').toEqual([]);
    expect('output' in payload!, 'the singular key must be gone').toBe(false);
    // Both schemas type `outputs` as an object; a scalar terminal value is wrapped
    // as { output } exactly like node outputs. The noop fixture's value is an
    // object already, so this leg is the TYPE contract, not the wrap path -- the
    // wrap path is witnessed by run-event-payload-conformance's scalar fixture.
    const outputs = payload!.outputs;
    expect(typeof outputs === 'object' && outputs !== null && !Array.isArray(outputs), 'outputs MUST be an object').toBe(true);
  });
});
