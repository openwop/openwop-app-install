/**
 * ADR 0393 Lane B — the App-Builder MCP control tools, ROUTE + gating harness
 * (the notebooks-mcp precedent):
 *   - the 7 `app-builder.mcp.*` expose-tool workflows register (`tools/list`)
 *     and execute via `tools/call` (create → open/list → get-design →
 *     render-design → get-preview-url roundtrip);
 *   - tenant isolation (a cross-tenant canvas is invisible);
 *   - the ADR 0087 gate (anonymous denied; `app-builder` toggle off ⇒ denied);
 *   - resolve-paused-task's narrow allowlist (unknown interrupt → typed error);
 *   - schema parity: the MCP get-design/render/catalog input schemas pin to the
 *     ADR 0358 agent-tool defs (one SSoT, minus the chat-only `orgId` — MCP
 *     tenant comes from the principal), the B4 obligation;
 *   - the verified market boundary: NO file tools (read-file/write-file/diff/
 *     merge) exposed over MCP.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { isToolAllowed, listTools } from '../src/host/mcpServerRegistry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { APP_BUILDER_MCP_TOOLS, APP_BUILDER_MCP_TOOL_NAMES } from '../src/features/app-builder/mcpControlWorkflows.js';
import { APP_BUILDER_GET_DESIGN_TOOL_ID, APP_BUILDER_RENDER_TOOL_ID } from '../src/features/app-builder/agentTools.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'app-builder']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

async function owner(who: string): Promise<Client> {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  return c;
}

const MCP = '/v1/host/openwop-app/mcp';
let rpcId = 0;
const rpc = (c: Client, method: string, params?: unknown) =>
  c.post(MCP, { jsonrpc: '2.0', id: ++rpcId, method, ...(params !== undefined ? { params } : {}) });
const resultText = (r: Res): string => (r.body.result?.content?.[0]?.text ?? '') as string;

describe('app-builder MCP control tools — registration + roundtrip', () => {
  it('registers all 7 control tools', () => {
    const names = listTools().map((t) => t.name);
    for (const expected of APP_BUILDER_MCP_TOOL_NAMES) expect(names, `missing ${expected}`).toContain(expected);
  });

  it('exposes NO file tools over MCP (the verified market boundary, B2)', () => {
    const names = listTools().map((t) => t.name).filter((x) => x.startsWith('app-builder-'));
    for (const forbidden of ['read-file', 'write-file', 'diff', 'merge']) {
      expect(names.some((x) => x.includes(forbidden)), `file tool '${forbidden}' must not exist`).toBe(false);
    }
  });

  it('create → open(list) → get-design → preview roundtrip in the caller tenant', async () => {
    const c = await owner('ctl');
    const created = await rpc(c, 'tools/call', { name: 'app-builder-create-project', arguments: { name: 'MCP App' } });
    expect(created.status).toBe(200);
    expect(created.body.result?.isError, JSON.stringify(created.body)).toBe(false);
    const { canvasId } = JSON.parse(resultText(created)) as { canvasId: string };
    expect(canvasId).toBeTruthy();

    const listed = await rpc(c, 'tools/call', { name: 'app-builder-open-project', arguments: {} });
    expect(resultText(listed)).toContain(canvasId);

    const design = await rpc(c, 'tools/call', { name: 'app-builder-get-design', arguments: { canvasId } });
    expect(design.body.result?.isError).toBe(false);
    const parsed = JSON.parse(resultText(design)) as { version: number; app: { screens: unknown[] } };
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.app.screens)).toBe(true);

    const preview = await rpc(c, 'tools/call', { name: 'app-builder-get-preview-url', arguments: { canvasId } });
    expect(preview.body.result?.isError).toBe(false);
    const pv = JSON.parse(resultText(preview)) as { url: string; previewUrl: string };
    expect(pv.url).toContain(canvasId);
    expect(pv.previewUrl).toContain('/preview');
  });

  it('catalog serves the live closed-catalog projection', async () => {
    const c = await owner('cat');
    const r = await rpc(c, 'tools/call', { name: 'app-builder-catalog', arguments: {} });
    expect(r.body.result?.isError).toBe(false);
    const parsed = JSON.parse(resultText(r)) as { components?: unknown[]; promptTypeList?: string };
    expect(Array.isArray(parsed.components)).toBe(true);
    expect((parsed.components ?? []).length).toBeGreaterThan(5);
  });

  it('a cross-tenant canvas is invisible (tenant comes from the principal)', async () => {
    const a = await owner('tenA');
    const b = await owner('tenB');
    const created = await rpc(a, 'tools/call', { name: 'app-builder-create-project', arguments: { name: 'A secret' } });
    const { canvasId } = JSON.parse(resultText(created)) as { canvasId: string };
    const stolen = await rpc(b, 'tools/call', { name: 'app-builder-get-design', arguments: { canvasId } });
    expect(stolen.body.result?.isError).toBe(true);
    expect(resultText(stolen)).not.toContain('"app"');
  });

  it('resolve-paused-task rejects an unknown interrupt with a typed error', async () => {
    const c = await owner('rpt');
    const r = await rpc(c, 'tools/call', { name: 'app-builder-resolve-paused-task', arguments: { interruptId: 'nope' } });
    expect(r.body.result?.isError).toBe(true);
    expect(resultText(r)).toContain('not found');
  });
});

describe('app-builder MCP control tools — ADR 0087 gating', () => {
  it('every control tool requires auth + the app-builder toggle; anonymous denied', async () => {
    for (const name of APP_BUILDER_MCP_TOOL_NAMES) {
      const tool = listTools().find((t) => t.name === name)!;
      expect(tool.mcpRequiresAuth, `${name} must require auth`).toBe(true);
      expect(tool.mcpFeatureToggle, `${name} must gate on app-builder`).toBe('app-builder');
      expect(await isToolAllowed(tool, { principalId: 'mcp-anonymous', tenants: ['*'], token: '' })).toBe(false);
    }
  });

  it('a tenant with app-builder OFF is denied', async () => {
    const tool = listTools().find((t) => t.name === 'app-builder-get-design')!;
    const d = getToggleDefault('app-builder');
    if (d) await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      expect(await isToolAllowed(tool, { principalId: 'p1', tenants: ['org:some-tenant'], token: 't' })).toBe(false);
    } finally {
      if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
});

describe('schema parity — MCP inputSchema ↔ ADR 0358 agent-tool SSoT (B4)', () => {
  const props = (schema: unknown): Record<string, unknown> =>
    ((schema as { properties?: Record<string, unknown> }).properties ?? {});
  const { resolveTool } = createAgentToolProvider({ tenantId: 't', runId: 'r' });

  it('get-design: identical properties minus the chat-only orgId', () => {
    const agent = resolveTool(APP_BUILDER_GET_DESIGN_TOOL_ID)!;
    const mcp = APP_BUILDER_MCP_TOOLS.find((t) => t.id === 'get-design')!;
    const agentProps = { ...props(agent.inputSchema) };
    delete agentProps.orgId; // chat-session concept; MCP tenant = principal
    expect(Object.keys(props(mcp.inputSchema)).sort()).toEqual(Object.keys(agentProps).sort());
  });

  it('render-design: identical properties minus the chat-only orgId', () => {
    const agent = resolveTool(APP_BUILDER_RENDER_TOOL_ID)!;
    const mcp = APP_BUILDER_MCP_TOOLS.find((t) => t.id === 'render-design')!;
    const agentProps = { ...props(agent.inputSchema) };
    delete agentProps.orgId;
    expect(Object.keys(props(mcp.inputSchema)).sort()).toEqual(Object.keys(agentProps).sort());
    expect((mcp.inputSchema as { required?: string[] }).required).toEqual(['app']);
  });
});
