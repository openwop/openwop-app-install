import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoSchemasDir } from '../src/host/_repoPath.js';

const here = dirname(fileURLToPath(import.meta.url));
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';

import { createApp } from '../src/index.js';
import { getEventLog } from '../src/executor/eventLog.js';
import type { Storage } from '../src/storage/storage.js';

/**
 * ADR 0722 A.6 — a major-2 WEBHOOK subscriber receives the same projected
 * payload the poll/SSE reader does. Before this the fan-out projected only the
 * event TYPE and forwarded the raw in-process payload: the v1 owner block
 * (`principal`, `principalKind`) went out on the v2 wire, and seven webhook
 * scenarios — none validating payload shape — never noticed. This is the host
 * witness the suite does not have.
 *
 * Tracker TST-BGF-25. Red when the major-2 fan-out forwards the raw payload
 * (`projectV2Payload` skipped) or drops the envelope's `schemaVersion` stamp.
 */
let app: Express; let server: Server; let base = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };

async function subscribe(): Promise<string> {
  // ADR 0812 P3c-0 — major 2 only: the `OpenWOP-Version: 1.1` subscriber leg
  // went with major 1 (the header is 406 on a host that retired it).
  const res = await fetch(`${base}/webhooks`, {
    method: 'POST',
    headers: { ...AUTH, 'OpenWOP-Version': '2.0' },
    body: JSON.stringify({ url: 'https://receiver.example.test/hook', events: ['run.started'] }),
  });
  const body = await res.json() as { subscriptionId?: string; subscription?: { subscriptionId?: string } };
  const id = body.subscriptionId ?? body.subscription?.subscriptionId;
  if (res.status !== 201 || !id) throw new Error(`subscribe answered ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return id;
}

/** Append a run.started carrying the PERSISTED v1 owner block, as executor.ts does. */
async function startRunWithV1Owner(storage: Storage, runId: string): Promise<void> {
  const now = new Date().toISOString();
  await storage.insertRun({ runId, workflowId: 'conformance-noop', tenantId: 'default', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now });
  await getEventLog().append({
    runId, type: 'run.started',
    payload: { workflowId: 'conformance-noop', owner: { tenant: 'default', principal: 'user:abc', principalKind: 'user', subject: { issuer: 'urn:openwop:legacy', subjectId: 'user:abc', tenant: 'default', lane: 'api-key', kind: 'user' } } },
  });
}

async function deliveredPayload(storage: Storage, subscriptionId: string): Promise<Record<string, unknown>> {
  // The subscription id came off the WIRE: under major 2 it is tenant-bound
  // (`default/<opaque>`, ADR 0723) while storage keys rows by the bare opaque —
  // the same seam `middleware/v2Identity.ts` crosses on the accept path.
  const storageId = subscriptionId.includes('/') ? subscriptionId.slice(subscriptionId.indexOf('/') + 1) : subscriptionId;
  // The fan-out is fire-and-forget off the append: wait for the enqueued row itself.
  const payload = await vi.waitFor(async () => {
    const rows = await storage.listWebhookDeliveries({ subscriptionIds: [storageId], limit: 5 });
    expect(rows.length, 'no delivery was enqueued for the subscription').toBeGreaterThan(0);
    return rows[0]!.payload;
  }, { timeout: 2_000, interval: 10 });
  return JSON.parse(payload) as Record<string, unknown>;
}

describe('ADR 0722 — the webhook fan-out is a projected major-2 egress channel', () => {
  it('a MAJOR-2 subscriber gets the closed v2 owner block, not the persisted v1 one', async () => {
    const storage = app.locals['storage'] as Storage;
    const subId = await subscribe();
    await startRunWithV1Owner(storage, 'run-adr0722-major2-000001');
    const body = await deliveredPayload(storage, subId);
    // The major-2 delivery is the `{ runId, event }` envelope; no fallback to a bare event.
    expect(body).toHaveProperty('event');
    const event = body['event'] as { type?: string; payload?: { owner?: Record<string, unknown> } };
    expect(event.type, 'v2 spelling of the type').toBe('run.started');
    const owner = event.payload?.owner ?? {};
    expect(Object.keys(owner).sort(), 'ONLY the keys the v2 def declares').toEqual(['subject', 'tenant']);
    expect('principal' in owner, 'the v1 principal must not reach a v2 subscriber').toBe(false);
  });

  // ADR 0812 P3c-0: the "MAJOR-1 subscriber still gets the v1 dialect" control
  // leg was deleted with major 1 — there is no major-1 subscriber to keep apart.

  it('the major-2 delivery ENVELOPE validates against webhook-delivery.schema.json — the reader the body never had (Phase E)', async () => {
    // The corrected `v2-webhook-delivery-shape` scenario (corpus 2.3.2) is the
    // first reader of this body in the suite's history, and it found that the
    // fan-out shipped an event with no `schemaVersion` — REQUIRED on a major-2
    // RunEventDoc, supplied at the read seat only. Phase A projected the
    // payload here and left the envelope alone. This is the host's own copy of
    // that assertion, so the next drift does not wait for a corpus release.
    const require_ = createRequire(join(here, '..', 'package.json'));
    const Ajv = (require_('ajv/dist/2020.js').default ?? require_('ajv/dist/2020.js')) as new (o: object) => {
      addSchema: (s: unknown) => void; compile: (s: unknown) => ((d: unknown) => boolean) & { errors?: unknown }; errorsText: (e: unknown) => string;
    };
    const ajv = new Ajv({ strict: false, allErrors: true });
    (require_('ajv-formats').default ?? require_('ajv-formats'))(ajv);
    const dir = join(locateRepoSchemasDir(here, 'run-event.schema.json'), 'v2');
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.schema.json')) continue;
      try { ajv.addSchema(JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown); } catch { /* duplicate $id */ }
    }
    const validate = ajv.compile({ $ref: 'https://openwop.dev/spec/v2/webhook-delivery.schema.json' });

    const storage = app.locals['storage'] as Storage;
    const subId = await subscribe();
    await startRunWithV1Owner(storage, 'run-adr0722-envelope-0000001');
    const body = await deliveredPayload(storage, subId);
    expect(validate(body), `delivery envelope: ${ajv.errorsText(validate.errors)}`).toBe(true);
    const ev = body['event'] as Record<string, unknown>;
    expect(typeof ev['schemaVersion'], 'schemaVersion is REQUIRED on a major-2 RunEventDoc').toBe('number');
  });
});
