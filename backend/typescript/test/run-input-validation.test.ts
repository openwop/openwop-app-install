/**
 * ADR 0197 Phase 3 — best-effort run-input validation at `POST /v1/runs`.
 *
 * ROUTE-level harness (the canvas-invoke pattern): the toggle gate, the 400
 * boundary, and the schema-less/toggle-off no-op paths are only observable
 * over HTTP. Pins:
 *   1. toggle OFF (default) → schema-violating inputs are ACCEPTED (back-compat);
 *   2. toggle ON  → violating inputs → 400 `validation_error` with
 *      `details.errors[{path,message}]`; valid inputs → 201;
 *   3. schema-less workflows are untouched either way;
 *   4. the pure validator's fail-open contract (no/uncompilable schema).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { validateRunInputs } from '../src/host/runInputValidation.js';

const TOKEN = 'dev-token';
let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as T };
}

const SCHEMA_WF = 'riv-schema-wf';
const PLAIN_WF = 'riv-plain-wf';
const INPUT_SCHEMA = {
  type: 'object',
  required: ['count'],
  properties: { count: { type: 'integer' }, name: { type: 'string' } },
} as const;

async function register(workflowId: string, extra: Record<string, unknown> = {}): Promise<void> {
  const r = await jsonFetch('/v1/host/openwop-app/workflows', {
    method: 'POST',
    body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'hook', typeId: 'core.trigger.webhook' }], edges: [], ...extra }),
  });
  expect([200, 201]).toContain(r.status);
}

async function createRun(workflowId: string, inputs: unknown): Promise<{ status: number; body: { runId?: string; error?: { code?: string; details?: { errors?: unknown[] } }; code?: string; details?: { errors?: unknown[] } } }> {
  return jsonFetch(`/v1/runs`, { method: 'POST', body: JSON.stringify({ workflowId, inputs, tenantId: 'default' }) });
}

// ADR 0434 — `run-input-forms` graduated to always-on (it shipped as an explicit
// pre-GA opt-in: "opt-in until the toggle GAs"). These cases previously asserted
// the toggle-OFF back-compat leg; they now pin the UNCONDITIONAL behavior, which
// is the real contract going forward. The fail-open half is what protects
// back-compat now, and it is pinned by the pure-contract describe block below
// plus the schema-less case here.
describe('run-input validation (ADR 0197 Phase 3, always-on per ADR 0434)', () => {
  it('violating inputs → 400 validation_error with field errors', async () => {
    await register(SCHEMA_WF, { inputSchema: INPUT_SCHEMA });
    const r = await createRun(SCHEMA_WF, { name: 'Ada' }); // missing required `count`
    expect(r.status).toBe(400);
    const errBody = JSON.stringify(r.body);
    expect(errBody).toContain('validation_error');
    expect(errBody).toContain('count');
  });

  it('a wrongly-TYPED input is rejected too (the former toggle-OFF back-compat case)', async () => {
    const r = await createRun(SCHEMA_WF, { count: 'not-a-number' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('validation_error');
  });

  it('valid inputs → 201', async () => {
    const r = await createRun(SCHEMA_WF, { count: 3, name: 'Ada' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('schema-less workflows are untouched (fail-open)', async () => {
    await register(PLAIN_WF);
    const r = await createRun(PLAIN_WF, { anything: 'goes' });
    expect(r.status).toBe(201);
  });
});

describe('validateRunInputs (pure fail-open contract)', () => {
  it('returns null for absent or uncompilable schemas', () => {
    expect(validateRunInputs(undefined, { a: 1 })).toBeNull();
    expect(validateRunInputs(null, { a: 1 })).toBeNull();
    expect(validateRunInputs({ type: 'object', properties: { a: { type: 'no-such-type' } } }, { a: 1 })).toBeNull();
  });
  it('maps ajv errors to {path,message}', () => {
    const errs = validateRunInputs(INPUT_SCHEMA, { count: 'x' });
    expect(errs).not.toBeNull();
    expect(errs![0]).toMatchObject({ path: '/count' });
  });
});
