/**
 * `identity.md` §5 — A MAJOR-2 CALLER CAN CANCEL ITS OWN RUNS BY THE ID IT WAS GIVEN.
 *
 * The path guard (`middleware/v2Identity.ts`) resolves tenant-bound ids in the
 * URL. `POST /runs:bulk-cancel` carries its ids in the BODY, so `default/<uuid>`
 * — the exact string a v2 client received from its own create — reached
 * `storage.getRun` raw and answered `not_found` for every run the caller owned.
 * The webhook defect inverted: projection on the way out, none on the way in.
 *
 * Both directions asserted. A resolver that rejects every slash-bearing id
 * passes "foreign tenant is refused" and breaks every v2 caller; a resolver
 * that strips the first segment blindly passes "own tenant works" and lets a
 * foreign segment through. The legs below are disjoint under those sabotages.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

const TOKEN = 'dev-token';
let server: http.Server;
let base = '';
let appStorage: import('../src/storage/storage.js').Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  appStorage = app.locals.storage as typeof appStorage;
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => undefined)) as any };
}

async function createRunV1(): Promise<string> {
  const r = await call('POST', '/v1/runs', { workflowId: 'conformance-noop', inputs: {} });
  expect(r.status, 'v1 create').toBe(201);
  return r.json.runId as string;
}

describe('POST /runs:bulk-cancel accepts the tenant-bound id under major 2', () => {
  it('ACCEPTS the projected id a v2 client was handed (the leg that was broken)', async () => {
    const bare = await createRunV1();
    // What GET /runs/{id} under major 2 returns — the id the client actually holds.
    const v2read = await call('GET', `/runs/${bare}`, undefined, { 'OpenWOP-Version': '2' });
    expect(v2read.json.runId, 'v2 read is tenant-bound').toBe(`default/${bare}`);

    const r = await call('POST', '/runs:bulk-cancel', { runIds: [v2read.json.runId] }, { 'OpenWOP-Version': '2' });
    expect(r.status).toBe(200);
    const row = r.json.results[0];
    // ADR 0632 / bus `cea0`: under major 2 an already-terminal run answers `ok: false` +
    // `run_terminal` — and THAT is the proof the id was accepted (a refused id is `not_found`).
    expect(row.ok, `bulk-cancel by the id the client holds: ${JSON.stringify(row)}`).toBe(false);
    expect(row.error?.error, JSON.stringify(row)).toBe('run_terminal');
  });

  it('still accepts a BARE id under major 1 (v1 callers untouched)', async () => {
    const bare = await createRunV1();
    const r = await call('POST', '/v1/runs:bulk-cancel', { runIds: [bare] });
    expect(r.json.results[0].ok).toBe(true);
  });

  it('REFUSES a foreign tenant segment as not_found (no existence oracle)', async () => {
    const bare = await createRunV1();
    const r = await call('POST', '/runs:bulk-cancel', { runIds: [`other-tenant/${bare}`] }, { 'OpenWOP-Version': '2' });
    expect(r.json.results[0].ok).toBe(false);
    expect(r.json.results[0].error.error, 'v2 entry error is the envelope, not the v1 {code} object').toBe('not_found');
  });
});

describe('POST /runs:bulk-cancel losing the race to a completion on ANOTHER instance', () => {
  // MEASURED in production (2026-09-22, rev 00734): the row still read
  // `running` when the loop checked it, another instance then wrote
  // `run.completed`, the store refused `run.cancelled` (RFC 0194), and the
  // entry answered `internal_error`. It must answer as an already-terminal run.
  it('answers run_terminal (major 2), never internal_error, and writes no second terminal', async () => {
    const now = new Date().toISOString();
    const runId = `bulk-race-${Date.now()}`;
    await appStorage.insertRun({ runId, tenantId: 'default', workflowId: 'conformance-noop', status: 'running', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now } as never);
    await appStorage.appendEvent({ eventId: `${runId}-done`, runId, type: 'run.completed', payload: null, timestamp: now });

    const r = await call('POST', '/runs:bulk-cancel', { runIds: [`default/${runId}`] }, { 'OpenWOP-Version': '2' });
    expect(r.status).toBe(200);
    const row = r.json.results[0];
    expect(row.ok, JSON.stringify(row)).toBe(false);
    expect(row.error?.error, JSON.stringify(row)).toBe('run_terminal');
    const types = (await appStorage.listEvents(runId)).map((e) => e.type);
    expect(types).toEqual(['run.completed']);
    expect((await appStorage.getRun(runId))?.status, 'the row follows the LOG, which closed with run.completed').toBe('completed');
  });
});
