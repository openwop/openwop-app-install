/**
 * Notebooks as MCP tools (ADR 0087) — ROUTE + gating harness. Proves the feature:
 *   - the `notebooks.mcp.*` expose-tool workflows register on the RFC 0020 inbound
 *     MCP server (`tools/list`) and execute via `tools/call` (the 2-node
 *     expose→backing wiring + variable seeding actually produce a CallToolResult);
 *   - tenant isolation (a tool call runs in the caller's tenant — cross-tenant
 *     notebooks are invisible);
 *   - the gate (anonymous principal denied; `notebooks` toggle off ⇒ hidden);
 *   - the `/v1/tools` RFC 0078 projection (descriptors valid + by-id + 404).
 *
 * Requires OPENWOP_MCP_SERVER_ENABLED=true at createApp time (set in beforeAll).
 *
 * @see docs/adr/0087-notebooks-as-mcp-tools.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { isToolAllowed, listTools } from '../src/host/mcpServerRegistry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true'; // mount the MCP server + /v1/tools
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['notebooks', 'kb', 'users']) {
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

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(who: string): Promise<{ c: Client; orgId: string }> {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail(who) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: org.body.orgId };
}

const MCP = '/v1/host/openwop-app/mcp';
let rpcId = 0;
const rpc = (c: Client, method: string, params?: unknown) =>
  c.post(MCP, { jsonrpc: '2.0', id: ++rpcId, method, ...(params !== undefined ? { params } : {}) });

describe('notebooks MCP tools — registration + roundtrip', () => {
  it('registers the notebook expose-tool workflows in the registry', () => {
    const names = listTools().map((t) => t.name);
    for (const expected of ['notebook-list', 'notebook-get', 'notebook-list-sources', 'notebook-list-notes', 'notebook-search', 'notebook-ask']) {
      expect(names, `missing ${expected}`).toContain(expected);
    }
  });

  it('tools/list advertises the notebook tools to an authenticated caller', async () => {
    const { c } = await ownerWithOrg('mcp-list');
    const r = await rpc(c, 'tools/list');
    expect(r.status).toBe(200);
    const tools = (r.body.result?.tools ?? []) as Array<{ name: string }>;
    expect(tools.some((t) => t.name === 'notebook-search')).toBe(true);
  });

  it('tools/call notebook-list returns a CallToolResult with the caller’s notebook', async () => {
    const { c, orgId } = await ownerWithOrg('mcp-call');
    const created = await c.post('/v1/host/openwop-app/notebooks', { orgId, name: 'MCP cats' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const notebookId = created.body.notebook.id as string;

    const r = await rpc(c, 'tools/call', { name: 'notebook-list', arguments: {} });
    expect(r.status).toBe(200);
    expect(r.body.result?.isError, JSON.stringify(r.body)).toBe(false);
    const text = (r.body.result?.content?.[0]?.text ?? '') as string;
    expect(text).toContain(notebookId); // the backing node's output is the result

    // notebook-get for that id round-trips.
    const g = await rpc(c, 'tools/call', { name: 'notebook-get', arguments: { notebookId } });
    expect(g.body.result?.isError).toBe(false);
    expect((g.body.result?.content?.[0]?.text ?? '') as string).toContain(notebookId);
  });

  it('tools/call notebook-search runs (grounded over the notebook KB)', async () => {
    const { c, orgId } = await ownerWithOrg('mcp-search');
    const created = await c.post('/v1/host/openwop-app/notebooks', { orgId, name: 'Felines' });
    const notebookId = created.body.notebook.id as string;
    await c.post(`/v1/host/openwop-app/notebooks/${notebookId}/sources`, { title: 'Cats', text: 'Cats purr when content and groom with their tongue.' });
    const r = await rpc(c, 'tools/call', { name: 'notebook-search', arguments: { notebookId, query: 'why do cats purr' } });
    expect(r.status).toBe(200);
    expect(r.body.result?.isError, JSON.stringify(r.body)).toBe(false);
  });

  it('rejects an unknown tool', async () => {
    const { c } = await ownerWithOrg('mcp-unknown');
    const r = await rpc(c, 'tools/call', { name: 'notebook-nonexistent', arguments: {} });
    expect(r.body.error, JSON.stringify(r.body)).toBeTruthy();
  });

  it('a tool call runs in the CALLER’s tenant — a cross-tenant notebook is invisible', async () => {
    const a = await ownerWithOrg('mcp-tenantA');
    const b = await ownerWithOrg('mcp-tenantB');
    const created = await a.c.post('/v1/host/openwop-app/notebooks', { orgId: a.orgId, name: 'A secret' });
    const aNotebookId = created.body.notebook.id as string;
    // b calls notebook-get for a's notebook → null (different tenant), not a leak.
    const g = await rpc(b.c, 'tools/call', { name: 'notebook-get', arguments: { notebookId: aNotebookId } });
    expect(g.body.result?.isError).toBe(false);
    expect((g.body.result?.content?.[0]?.text ?? '') as string).not.toContain(aNotebookId);
  });
});

describe('notebooks MCP tools — gating (ADR 0087)', () => {
  it('denies the anonymous principal; requires the notebooks toggle', async () => {
    const tool = listTools().find((t) => t.name === 'notebook-search')!;
    expect(tool.mcpRequiresAuth).toBe(true);
    expect(tool.mcpFeatureToggle).toBe('notebooks');
    // mcp-anonymous → denied.
    expect(await isToolAllowed(tool, { principalId: 'mcp-anonymous', tenants: ['*'], token: '' })).toBe(false);
    // a real tenant with notebooks ON (enabled globally in beforeAll) → allowed.
    expect(await isToolAllowed(tool, { principalId: 'u1', tenants: ['some-tenant'], token: '' })).toBe(true);
  });

  it('MCP-5: a multi-tenant principal is gated by its FIRST tenant (pinned, fail-closed)', async () => {
    const tool = listTools().find((t) => t.name === 'notebook-search')!;
    // notebooks is enabled globally in beforeAll, so any real tenant in slot 0
    // passes; the documented residual is that ONLY tenants[0] is consulted. This
    // pins the contract so a future multi-tenant change can't silently widen it.
    expect(await isToolAllowed(tool, { principalId: 'u1', tenants: ['t-first', 't-second'], token: '' })).toBe(true);
    // A wildcard-led tenant list is anonymous → denied regardless of any later
    // real tenant, confirming the gate never scans past slot 0 to ALLOW.
    expect(await isToolAllowed(tool, { principalId: 'u1', tenants: ['*', 't-real'], token: '' })).toBe(false);
  });
});

describe('notebooks MCP tools — /v1/tools projection (RFC 0078)', () => {
  it('lists valid ToolDescriptors + serves by-id + 404s unknown', async () => {
    const { c } = await ownerWithOrg('mcp-catalog');
    const list = await c.get('/v1/tools');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body), 'GET /v1/tools MUST be a bare ToolDescriptor[]').toBe(true);
    const search = (list.body as Array<{ toolId: string; source: string; safetyTier: string; inputSchema?: unknown }>)
      .find((d) => d.toolId === 'mcp:notebook-search');
    expect(search, 'mcp:notebook-search descriptor present').toBeTruthy();
    expect(search!.source).toBe('mcp');
    expect(search!.safetyTier).toBe('read');
    expect(search!.inputSchema).toBeTruthy();

    const byId = await c.get('/v1/tools/mcp:notebook-search');
    expect(byId.status).toBe(200);
    expect(byId.body.toolId).toBe('mcp:notebook-search');

    const unknown = await c.get('/v1/tools/mcp:does-not-exist');
    expect(unknown.status).toBe(404);
  });

  it('projects the WRITE tools with safetyTier:write + approval:always (ADR 0087 OQ-1)', async () => {
    const { c } = await ownerWithOrg('mcp-write-desc');
    const list = (await c.get('/v1/tools')).body as Array<{ toolId: string; safetyTier: string; approval: string; auth?: { scopes?: string[] } }>;
    const addSource = list.find((d) => d.toolId === 'mcp:notebook-add-source');
    expect(addSource, 'mcp:notebook-add-source present').toBeTruthy();
    expect(addSource!.safetyTier).toBe('write');
    expect(addSource!.approval).toBe('always');
    expect(addSource!.auth?.scopes).toContain('workspace:write');
  });
});

describe('notebooks MCP WRITE tools — HITL gate (ADR 0087 OQ-1)', () => {
  it('a write tools/call SUSPENDS for approval and does NOT mutate until approved', async () => {
    const { c, orgId } = await ownerWithOrg('mcp-write');
    const created = await c.post('/v1/host/openwop-app/notebooks', { orgId, name: 'Write target' });
    const notebookId = created.body.notebook.id as string;

    const r = await rpc(c, 'tools/call', { name: 'notebook-create-note', arguments: { notebookId, content: 'untrusted note' } });
    expect(r.status).toBe(200);
    // The approval node suspended the run → the client is told it's pending, NOT done.
    expect(r.body.result?.isError, JSON.stringify(r.body)).toBe(true);
    expect((r.body.result?.content?.[0]?.text ?? '') as string).toContain('awaiting');

    // The note was NOT created — approval is load-bearing (no silent mutation).
    const notes = await c.get(`/v1/host/openwop-app/notebooks/${notebookId}/notes`);
    expect((notes.body.notes ?? []).length).toBe(0);
  });

  it('the write node is a no-op unless the decision is accept', async () => {
    // @ts-expect-error — untyped .mjs pack module
    const pack = await import('../../../packs/feature.notebooks.nodes/index.mjs');
    let called = false;
    const ctxBase = { features: { notebooks: { addNote: async () => { called = true; return { created: true }; } } } };
    const declined = await pack.mcpCreateNote({ ...ctxBase, inputs: { notebookId: 'n', content: 'x', decision: 'reject' } });
    expect(declined.outputs.created).toBe(false);
    expect(declined.outputs.declined).toBe(true);
    expect(called).toBe(false);
    const accepted = await pack.mcpCreateNote({ ...ctxBase, inputs: { notebookId: 'n', content: 'x', decision: 'accept' } });
    expect(accepted.outputs.created).toBe(true);
    expect(called).toBe(true);
  });
});
