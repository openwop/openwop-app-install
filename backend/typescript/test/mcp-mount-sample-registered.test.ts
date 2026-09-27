/**
 * ADR 0553 P2 — the MCP mount exposes a SAMPLE-REGISTERED suspending workflow,
 * end to end, over the exact path the conformance suite drives.
 *
 * WHY THIS FILE EXISTS. The spec worker's run of the sibling suite against this
 * branch reported `mcp-mrtr-roundtrip`'s server half failing with
 * `-32602 "tool 'mrtr_…' not exposed"`, read as a host gap: "the mount does not
 * expose sample-registered suspending workflows as tools when the seam is on."
 *
 * MEASURED, and that is not what is happening. Driven over the SAME path the
 * suite uses — register at `/v1/host/sample/workflows`, call at
 * `/v1/host/sample/mcp`, authenticated — the tool appears in `tools/list` and
 * `tools/call` answers `input_required`. The suite's registration `400`s for an
 * unrelated reason (its fixture posts `edges: [{ from, to }]`, the RFC 0013
 * workflow-CHAIN vocabulary, to the workflow-DEFINITION endpoint), so the
 * workflow never registers and `-32602` is the CORRECT answer to a call for a
 * tool that does not exist. The reported symptom is downstream of the fixture
 * bug, not a second defect behind it.
 *
 * So this file is the standing evidence for that claim, and the regression
 * guard the reviewer asked for: if the mount ever DOES stop exposing
 * sample-registered workflows, this goes red here rather than being rediscovered
 * as a mystery `-32602` in someone else's suite run.
 *
 * Note the auth: `/v1/host/sample/*` is guarded by
 * `requireNonAnonymousPrincipal`, so an unauthenticated probe of this path 401s
 * — which is its own trap, and the reason the first attempt at this measurement
 * was meaningless.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { MCP_CURRENT_VERSION, MCP_META_CLIENT_CAPABILITIES, MCP_META_PROTOCOL_VERSION } from '../src/host/mcpProfile.js';

let BASE: string;
let server: http.Server;
let cookie = '';
const TOOL = `mrtr_sample_${Date.now()}`;
let rpcId = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `mcp-mount-${Date.now()}@acme.test` }),
  });
  expect(login.status, await login.clone().text()).toBe(201);
  for (const ck of getSetCookies(login.headers)) {
    const m = /(__session=[^;]+)/.exec(ck);
    if (m?.[1]) cookie = m[1];
  }
  expect(cookie, 'no session cookie — every leg would 401 on the guarded sample prefix').toBeTruthy();
});

afterAll(async () => {
  delete process.env.OPENWOP_MCP_SERVER_ENABLED;
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

async function mcp(method: string, params: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${BASE}/v1/host/sample/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', cookie,
      'MCP-Protocol-Version': MCP_CURRENT_VERSION, 'Mcp-Method': method, ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: ++rpcId, method,
      params: { ...params, _meta: { [MCP_META_PROTOCOL_VERSION]: MCP_CURRENT_VERSION, [MCP_META_CLIENT_CAPABILITIES]: { elicitation: {} } } },
    }),
  });
  const body = (await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
  return { status: res.status, ...body };
}

describe('the MCP mount exposes a sample-registered suspending workflow (the suite path)', () => {
  it('registers via /v1/host/sample/workflows, appears in tools/list, and completes an MRTR round trip', async () => {
    const reg = await fetch(`${BASE}/v1/host/sample/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        workflowId: `mcp.sample.${TOOL}`,
        nodes: [
          { nodeId: 'expose', typeId: 'core.openwop.mcp.expose-tool', config: { name: TOOL, description: 'MRTR conformance tool', inputSchema: { type: 'object', properties: {} } } },
          { nodeId: 'ask', typeId: 'core.openwop.mcp.handle-elicitation', config: { message: 'What is your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
        ],
        // The DEFINITION endpoint's edge shape. The suite's fixture sends
        // `{ from, to }` here and is 400'd — that, not the mount, is why its
        // server half reported "tool not exposed".
        edges: [{ edgeId: 'expose-to-ask', sourceNodeId: 'expose', targetNodeId: 'ask' }],
      }),
    });
    expect([200, 201], `registration failed: ${await reg.clone().text()}`).toContain(reg.status);

    const listed = await mcp('tools/list', {});
    expect(listed.status).toBe(200);
    const names = (listed.result?.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names, 'a sample-registered workflow MUST be exposed on the mount').toContain(TOOL);

    const first = await mcp('tools/call', { name: TOOL, arguments: {} }, { 'Mcp-Name': TOOL });
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    expect(first.result?.resultType).toBe('input_required');
    const key = Object.keys(first.result?.inputRequests as Record<string, unknown>)[0]!;
    const state = first.result?.requestState;
    expect(typeof state).toBe('string');

    const retry = await mcp('tools/call', {
      name: TOOL, arguments: {}, requestState: state,
      inputResponses: { [key]: { action: 'accept', content: { name: 'Ada' } } },
    }, { 'Mcp-Name': TOOL });
    expect(retry.error).toBeUndefined();
    expect(retry.result?.resultType).toBe('complete');
  });

  it('a tool that was never registered is -32602 — the answer the suite actually received', async () => {
    // Pins the OTHER half of the diagnosis: `-32602 not exposed` is the correct
    // response to a call for a tool that does not exist, so seeing it does not
    // imply the mount refuses to expose sample-registered workflows.
    const r = await mcp('tools/call', { name: 'mrtr_never_registered', arguments: {} }, { 'Mcp-Name': 'mrtr_never_registered' });
    expect(r.error?.code).toBe(-32602);
    expect(r.error?.message).toContain('not exposed');
  });
});
