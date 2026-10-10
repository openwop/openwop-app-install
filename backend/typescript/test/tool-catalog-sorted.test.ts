/**
 * #4339 — `GET /v1/tools` returned host projections in registration order and
 * then whichever workspace workflows exposed a tool at read time, so the order
 * moved with workspace state and the suite's advisory leg ("an unchanged catalog
 * reads identically, sorted by toolId", RFC 0204 §D.13) flipped between runs.
 * The route now sorts by toolId. These tools are registered in REVERSE name
 * order, so without the sort they come back out of order.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';

let BASE: string;
let server: http.Server;
const stamp = Date.now();
let cookie = '';

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  for (const ck of getSetCookies(res.headers)) {
    const m = /(__session=[^;]+)/.exec(ck);
    if (m?.[1]) return m[1];
  }
  throw new Error('no session cookie');
}

async function registerExposeTool(workflowId: string, toolName: string): Promise<void> {
  const res = await fetch(`${BASE}/host/openwop-app/workflows`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      workflowId,
      nodes: [{ nodeId: 'expose', typeId: 'core.openwop.mcp.expose-tool', config: { name: toolName, description: 'sort witness', inputSchema: { type: 'object', properties: {} } } }],
    }),
  });
  expect([200, 201], await res.clone().text()).toContain(res.status);
}

async function listToolIds(query = ''): Promise<string[]> {
  // The unversioned key + major 2 (ADR 0642), not a new v1 call site.
  const res = await fetch(`${BASE}/tools${query}`, { headers: { cookie, 'OpenWOP-Version': '2' } });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as Array<{ toolId: string }> | { tools: Array<{ toolId: string }> };
  return (Array.isArray(body) ? body : body.tools).map((t) => t.toolId);
}

const codeUnitSorted = (ids: string[]): string[] => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  cookie = await login(`sort-${stamp}@acme.test`);
  // Reverse order on purpose: registration order would put zz before aa.
  await registerExposeTool(`sort.zz.${stamp}`, `zz_sort_${stamp}`);
  await registerExposeTool(`sort.aa.${stamp}`, `aa_sort_${stamp}`);
});

afterAll(async () => {
  delete process.env.OPENWOP_MCP_SERVER_ENABLED;
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('#4339 — the tool catalog list is sorted by toolId, and stable', () => {
  it('the standard view is in toolId order, including workspace tools registered out of order', async () => {
    const ids = await listToolIds();
    expect(ids).toContain(`mcp:aa_sort_${stamp}`);
    expect(ids).toContain(`mcp:zz_sort_${stamp}`);
    expect(ids).toEqual(codeUnitSorted(ids));
  });

  it('the compact view has the same order', async () => {
    expect(await listToolIds('?view=compact')).toEqual(await listToolIds());
  });

  it('an unchanged catalog reads identically', async () => {
    expect(await listToolIds()).toEqual(await listToolIds());
  });
});
