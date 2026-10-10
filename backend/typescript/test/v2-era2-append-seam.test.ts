import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from '../src/index.js';

/**
 * seams-v2 `appendEra2Event` (suite 2.42.6) — the RFC 0176 §A writer-rule
 * witness. `persistence.md` §"The writer rule": an append to an era-2 run is
 * STORED in v1 vocabulary, so every reader's translation still works. The seam
 * is only the trigger; the production writer (`eventEraAdapter`) makes the
 * choice, and the production READ is what these tests assert on.
 *
 * `agent.reasoning-delta` is the suite's witness type because the codemap
 * RENAMES it (v1 `agent.reasoning.delta`) — an identity row would pass whether
 * or not the writer rule held.
 */
let server: Server;
let base: string;
let savedKeys: string | undefined;
let storage: import('../src/storage/storage.js').Storage;
const V2_NAME = 'agent.reasoning-delta';
const V1_NAME = 'agent.reasoning.delta';
const as = (key: string, major: 2) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'OpenWOP-Version': String(major) });
const TENANT_KEY = 'k-append-tenant';
const OTHER_KEY = 'k-append-other';

beforeAll(async () => {
  savedKeys = process.env.OPENWOP_API_KEYS;
  process.env.OPENWOP_API_KEYS = `dev-token:*,${TENANT_KEY}:append-tenant,${OTHER_KEY}:append-other`;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as typeof storage;
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (savedKeys === undefined) delete process.env.OPENWOP_API_KEYS; else process.env.OPENWOP_API_KEYS = savedKeys;
});

async function seed(status = 'running', key = TENANT_KEY): Promise<string> {
  const res = await fetch(`${base}/conformance/seams/sample/event-log/seed`, {
    method: 'POST', headers: as(key, 2),
    body: JSON.stringify({ eventLogSchemaVersion: 2, status, events: [
      { sequence: 0, type: 'run.started', payload: { workflowId: 'conformance-noop' } },
      { sequence: 1, type: 'node.started', payload: { nodeId: 'n1' } },
    ] }),
  });
  const body = await res.json() as { runId?: string };
  if (res.status !== 201 || !body.runId) throw new Error(`seed answered ${res.status}: ${JSON.stringify(body)}`);
  return body.runId;
}

async function append(body: unknown, key = TENANT_KEY) {
  const res = await fetch(`${base}/conformance/seams/sample/event-log/append`, { method: 'POST', headers: as(key, 2), body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as Record<string, unknown> | null };
}

async function types(runId: string): Promise<string[]> {
  const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}/events/poll?timeout=1`, { headers: as(TENANT_KEY, 2) });
  expect(res.status, 'the major-2 read of the era-2 log must succeed after the append').toBe(200);
  const b = await res.json() as { events?: Array<{ type: string; sequence: number }> };
  return (b.events ?? []).map((e) => e.type);
}

describe('appendEra2Event — the writer rule, witnessed through the production writer', () => {
  it('a codemap-RENAMED v2 type is stored in v1 vocabulary: v2 reads it as v2, v1 reads it as v1', async () => {
    const runId = await seed();
    const { status, json } = await append({ runId, type: V2_NAME, payload: { agentId: 'conformance', delta: 'witness', sequence: 0 } });
    expect(status, JSON.stringify(json)).toBe(202);
    expect(json?.sequence, 'the append continues the seeded sequence space (0, 1 seeded)').toBe(2);
    expect(json?.runId).toBe(runId);

    const v2 = await types(runId);
    expect(v2[2], 'the translated major-2 read returns the v2 name').toBe(V2_NAME);
    // ADR 0812 P3c-0 — the untranslated major-1 READ leg was deleted with major 1;
    // the stored spelling it witnessed is now read from storage directly.
    const stored = (await storage.listEvents(runId.slice(runId.indexOf('/') + 1))).map((e) => e.type);
    expect(stored[2], 'the append is STORED in v1 vocabulary').toBe(V1_NAME);
  });

  it('a run the seed seam did NOT create is 404, exactly like an unknown run', async () => {
    const created = await fetch(`${base}/runs`, { method: 'POST', headers: as(TENANT_KEY, 2), body: JSON.stringify({ workflowId: 'conformance-noop' }) });
    const real = (await created.json() as { runId?: string }).runId;
    expect(real, 'a real run to aim at').toBeTruthy();
    const r = await append({ runId: real, type: V2_NAME, payload: {} });
    expect(r.status, 'the seam must not be able to inject into a real run').toBe(404);
    const unknown = await append({ runId: 'append-tenant/00000000-0000-4000-8000-000000000000', type: V2_NAME, payload: {} });
    expect(unknown.status).toBe(404);
    expect(unknown.json?.error ?? (unknown.json as { code?: string } | null)?.code).toBe(r.json?.error ?? (r.json as { code?: string } | null)?.code);
  });

  it("another tenant's seeded run is 404", async () => {
    const theirs = await seed('running', OTHER_KEY);
    expect((await append({ runId: theirs, type: V2_NAME, payload: {} })).status).toBe(404);
  });

  it('a terminal run is 409 run_terminal', async () => {
    const runId = await seed('completed');
    const r = await append({ runId, type: V2_NAME, payload: {} });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.json)).toContain('run_terminal');
  });

  it('a type outside the v2 registry is 400 — including a v1-only spelling and a host vendor name', async () => {
    const runId = await seed();
    for (const type of ['not.a.type', V1_NAME, 'openwop-app.a2ui-surface']) {
      const r = await append({ runId, type, payload: {} });
      expect(r.status, `${type} must be refused`).toBe(400);
    }
    expect((await append({ runId, type: V2_NAME, payload: {}, extra: 1 })).status, 'closed-world body').toBe(400);
  });
});
