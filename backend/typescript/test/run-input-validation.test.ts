/**
 * ADR 0197 Phase 3 (always-on since ADR 0434) — the SERVER-side run-input gate at
 * `POST /v1/runs` (`routes/runs.ts` → `validateRunInputs`). The client's subset
 * validation (`lib/formEngine.ts`) is a courtesy; this 400 is the guard an agent or a
 * hand-written API call actually meets, so it must hold on its own.
 *
 * ROUTE-level harness (the canvas-invoke pattern): the 400 boundary and the
 * schema-less no-op are only observable over HTTP. Pins:
 *   1. violating inputs (missing required, wrong type) → 400 `validation_error` with
 *      `details.errors[{path,message}]` naming the failing field;
 *   2. valid inputs → 201, and the run stores exactly those inputs;
 *   3. schema-less workflows are untouched (fail-open). This leg sits behind a DOUBLE
 *      guard — the route's `if (wf?.definition.inputSchema)` AND the validator's
 *      null-for-no-schema — so only a sabotage that breaks both (applying a strict
 *      default schema) turns it red (probe w32g3-route-strict-default);
 *   4. the pure validator's fail-open contract (no/uncompilable schema).
 *
 * Each case registers its OWN workflow, so the file is order-independent under shuffle.
 * Red under: dropping the 400 (`if (inputErrors …)` → false), refusing valid inputs,
 * or validating schema-less workflows against a default.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { validateRunInputs } from '../src/host/runInputValidation.js';

const TOKEN = 'dev-token';
let BASE: string;
let server: http.Server;
const PRIOR_ENV = { dsn: process.env.OPENWOP_STORAGE_DSN, cookies: process.env.OPENWOP_AUTH_DISABLE_COOKIES };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of [['OPENWOP_STORAGE_DSN', PRIOR_ENV.dsn], ['OPENWOP_AUTH_DISABLE_COOKIES', PRIOR_ENV.cookies]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

/** The host's error envelope is `{ error: <code>, message, details }`. */
interface RunBody { runId?: string; inputs?: unknown; error?: string; message?: string; details?: { errors?: unknown[] } }

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as T };
}

const INPUT_SCHEMA = {
  type: 'object',
  required: ['count'],
  properties: { count: { type: 'integer' }, name: { type: 'string' } },
} as const;

async function register(workflowId: string, extra: Record<string, unknown> = {}): Promise<void> {
  const r = await jsonFetch<unknown>('/host/openwop-app/workflows', {
    method: 'POST',
    body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'hook', typeId: 'core.trigger.webhook' }], edges: [], ...extra }),
  });
  expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
}

async function createRun(workflowId: string, inputs: unknown): Promise<{ status: number; body: RunBody }> {
  return jsonFetch<RunBody>(`/runs`, { method: 'POST', body: JSON.stringify({ workflowId, inputs, tenantId: 'default' }) });
}

describe('run-input validation (ADR 0197 Phase 3, always-on per ADR 0434)', () => {
  it('violating inputs → 400 validation_error with field errors', async () => {
    await register('riv-schema-wf-missing', { inputSchema: INPUT_SCHEMA });
    const r = await createRun('riv-schema-wf-missing', { name: 'Ada' }); // missing required `count`
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: 'validation_error',
      message: "inputs do not satisfy the workflow's inputSchema: / must have required property 'count'",
      details: { errors: [{ path: '/', message: "must have required property 'count'" }] },
    });
  });

  it('a wrongly-TYPED input is rejected too (the former toggle-OFF back-compat case)', async () => {
    await register('riv-schema-wf-typed', { inputSchema: INPUT_SCHEMA });
    const r = await createRun('riv-schema-wf-typed', { count: 'not-a-number' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: 'validation_error',
      message: "inputs do not satisfy the workflow's inputSchema: /count must be integer",
      details: { errors: [{ path: '/count', message: 'must be integer' }] },
    });
  });

  it('valid inputs → 201', async () => {
    await register('riv-schema-wf-valid', { inputSchema: INPUT_SCHEMA });
    const r = await createRun('riv-schema-wf-valid', { count: 3, name: 'Ada' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(typeof r.body.runId).toBe('string');
    const read = await jsonFetch<RunBody>(`/runs/${r.body.runId}`);
    expect(read.status).toBe(200);
    expect(read.body.inputs).toEqual({ count: 3, name: 'Ada' });
  });

  it('schema-less workflows are untouched (fail-open)', async () => {
    await register('riv-plain-wf');
    const r = await createRun('riv-plain-wf', { anything: 'goes' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(typeof r.body.runId).toBe('string');
  });
});

describe('validateRunInputs (pure fail-open contract)', () => {
  it('returns null for absent or uncompilable schemas', () => {
    expect(validateRunInputs(undefined, { a: 1 })).toBeNull();
    expect(validateRunInputs(null, { a: 1 })).toBeNull();
    expect(validateRunInputs({ type: 'object', properties: { a: { type: 'no-such-type' } } }, { a: 1 })).toBeNull();
  });
  it('maps ajv errors to {path,message}', () => {
    expect(validateRunInputs(INPUT_SCHEMA, { count: 'x' })).toEqual([{ path: '/count', message: 'must be integer' }]);
  });
});
