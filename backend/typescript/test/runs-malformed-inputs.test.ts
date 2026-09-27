/**
 * Regression: POST /v1/runs with a malformed `inputs` (an ARRAY of variable
 * descriptors instead of a {name:value} map) must be rejected cleanly, NOT 500.
 * Repro of the prod report: inputs=[{name,type,description,required}] → internal_error.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as T };
}

describe('POST /v1/runs — malformed inputs shape', () => {
  beforeAll(async () => {
    // Register a workflow that declares a `transcript` variable (like the prod chain).
    const reg = await jsonFetch('/v1/host/openwop-app/workflows', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: 'app.malformed-inputs-test',
        nodes: [{ nodeId: 'n', typeId: 'core.flow.noop' }],
        edges: [],
        variables: [{ name: 'transcript', type: 'string', description: 'The transcript.', required: true }],
      }),
    });
    expect([200, 201]).toContain(reg.status);
  });

  it('rejects an ARRAY inputs with a clean 4xx (not 500)', async () => {
    const res = await jsonFetch<{ error?: string }>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: 'app.malformed-inputs-test',
        inputs: [{ name: 'transcript', type: 'string', description: 'The transcript.', required: true }],
      }),
    });
    expect(res.status).not.toBe(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.error).not.toBe('internal_error');
  });

  it('still accepts a well-formed object inputs', async () => {
    const res = await jsonFetch<{ runId?: string }>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'app.malformed-inputs-test', inputs: { transcript: 'hello' } }),
    });
    expect(res.status).toBe(201);
    expect(res.body.runId).toBeTruthy();
  });

  it('still accepts null / omitted inputs', async () => {
    const res = await jsonFetch('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'app.malformed-inputs-test' }) });
    expect(res.status).toBe(201);
  });
});
