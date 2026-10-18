/**
 * Notebooks as MCP tools (ADR 0087) — ROUTE + gating harness. Proves the feature:
 *   - the `notebooks.mcp.*` expose-tool workflows register on the RFC 0020 inbound
 *     MCP server (`tools/list`) and execute via `tools/call` (the 2-node
 *     expose→backing wiring + variable seeding actually produce a CallToolResult);
 *   - tenant isolation (a tool call runs in the caller's tenant — cross-tenant
 *     notebooks are invisible);
 *   - the gate (anonymous principal denied; `notebooks` toggle off ⇒ hidden);
 *   - the `/tools` RFC 0078 projection (descriptors valid + by-id + 404).
 *
 * Requires OPENWOP_MCP_SERVER_ENABLED=true at createApp time (set in beforeAll).
 *
 * What reds it (sabotage-witnessed, /grade-tests wave 20): the backing node's output
 * (`listNotebooks`); the project store's tenant check; `isAnonymousPrincipal`; the
 * toggle leg of `isToolAllowedWith`; the FIRST-tenant authority read; a catalog
 * route that re-derives `auth.scopes`; the write tools' `mcpSafetyTier`; the
 * create-note chain's `core.hitl.approval-request` node (it lives in
 * `examples/workflow-chain-packs/mcp-tool-projections`, NOT `mcpToolsWorkflows.ts`,
 * which only contributes the metadata gates).
 *
 * @see docs/adr/0087-notebooks-as-mcp-tools.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { isToolAllowed, listTools, requiredScopeForTool } from '../src/host/mcpServerRegistry.js';
import { createMember } from '../src/host/accessControlService.js';
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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['notebooks', 'kb', 'users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The JSON shapes this file reads. Every field is optional because a failed call
 *  must surface as a failing assertion, not a TypeError in the helper. */
interface Body {
  user?: { tenantId?: string };
  orgId?: string;
  notebook?: { id: string };
  notes?: unknown[];
  toolId?: string;
  result?: { isError?: boolean; tools?: Array<{ name: string }>; content?: Array<{ text?: string }> };
  error?: { code?: number; message?: string };
}
interface Res<T = Body> { status: number; body: T }
interface Client { get: <T = Body>(p: string) => Promise<Res<T>>; post: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res<unknown>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: async <T = Body>(p: string) => (await call('GET', p)) as Res<T>,
    post: async (p: string, b?: unknown) => (await call('POST', p, b)) as Res,
  };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(who: string): Promise<{ c: Client; orgId: string; tenantId: string }> {
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail(who) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const tenantId = r.body.user?.tenantId;
  expect(typeof tenantId, JSON.stringify(r.body)).toBe('string');
  const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(typeof org.body.orgId, JSON.stringify(org.body)).toBe('string');
  return { c, orgId: org.body.orgId!, tenantId: tenantId! };
}

const textOf = (r: Res): string => r.body.result?.content?.[0]?.text ?? '';

const MCP = '/host/openwop-app/mcp';
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
    const created = await c.post('/host/openwop-app/notebooks', { orgId, name: 'MCP cats' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const notebookId = created.body.notebook!.id;

    const r = await rpc(c, 'tools/call', { name: 'notebook-list', arguments: {} });
    expect(r.status).toBe(200);
    expect(r.body.result?.isError, JSON.stringify(r.body)).toBe(false);
    expect(textOf(r)).toContain(notebookId); // the backing node's output is the result

    // notebook-get for that id round-trips.
    const g = await rpc(c, 'tools/call', { name: 'notebook-get', arguments: { notebookId } });
    expect(g.body.result?.isError).toBe(false);
    expect(textOf(g)).toContain(notebookId);
  });

  it('tools/call notebook-search runs (grounded over the notebook KB)', async () => {
    const { c, orgId } = await ownerWithOrg('mcp-search');
    const created = await c.post('/host/openwop-app/notebooks', { orgId, name: 'Felines' });
    const notebookId = created.body.notebook!.id;
    const src = await c.post(`/host/openwop-app/notebooks/${notebookId}/sources`, { title: 'Cats', text: 'Cats purr when content and groom with their tongue.' });
    expect(src.status, JSON.stringify(src.body)).toBe(201);
    const r = await rpc(c, 'tools/call', { name: 'notebook-search', arguments: { notebookId, query: 'why do cats purr' } });
    expect(r.status).toBe(200);
    expect(r.body.result?.isError, JSON.stringify(r.body)).toBe(false);
    // Grounded: the hit IS the notebook's source, not merely a successful empty run.
    expect(textOf(r)).toMatch(/Cats purr/);
  });

  it('rejects an unknown tool', async () => {
    const { c } = await ownerWithOrg('mcp-unknown');
    const r = await rpc(c, 'tools/call', { name: 'notebook-nonexistent', arguments: {} });
    // A JSON-RPC protocol error, not a tool-level `isError` result.
    expect(typeof r.body.error?.code, JSON.stringify(r.body)).toBe('number');
    expect(r.body.result).toBeUndefined();
  });

  it('a tool call runs in the CALLER’s tenant — a cross-tenant notebook is invisible', async () => {
    const a = await ownerWithOrg('mcp-tenantA');
    const b = await ownerWithOrg('mcp-tenantB');
    // The claim's precondition: two DIFFERENT tenants (not two orgs in one tenant).
    expect(a.tenantId).not.toBe(b.tenantId);
    const created = await a.c.post('/host/openwop-app/notebooks', { orgId: a.orgId, name: 'A secret' });
    const aNotebookId = created.body.notebook!.id;
    // Control: the owner's own call DOES see it, so the negative below is not a
    // tool that returns nothing for everyone.
    const own = await rpc(a.c, 'tools/call', { name: 'notebook-get', arguments: { notebookId: aNotebookId } });
    expect(textOf(own)).toContain(aNotebookId);
    // b calls notebook-get for a's notebook → null (different tenant), not a leak.
    const g = await rpc(b.c, 'tools/call', { name: 'notebook-get', arguments: { notebookId: aNotebookId } });
    expect(g.body.result?.isError).toBe(false);
    expect(textOf(g)).not.toContain(aNotebookId);
  });
});

describe('notebooks MCP tools — gating (ADR 0087)', () => {
  // ADR 0601 — `isToolAllowed` now also enforces the RBAC scope the tool's own
  // RFC 0078 descriptor advertises, so a principal must be a MEMBER holding that
  // scope. These two cases pin the ANONYMITY gate and the TOGGLE gate, so their
  // principals are given member rows that satisfy the scope leg; otherwise a
  // toggle-off assertion would pass for the wrong reason (denied on scope, not on
  // the toggle). `editor` carries both workspace:read and workspace:write.
  beforeAll(async () => {
    await createMember({ tenantId: 'some-tenant', orgId: 'org-mcp-gate', subject: 'u1', displayName: 'u1', roles: ['editor'] });
    await createMember({ tenantId: 't-first', orgId: 'org-mcp-first', subject: 'u1', displayName: 'u1', roles: ['editor'] });
    // The anonymous id ALSO holds a member row, so the scope leg would admit it:
    // the anonymity check is then the ONLY thing that can refuse it (a principal
    // with no rows is refused by the scope leg first — wave-20 probe found the anon
    // assertion double-guarded exactly that way).
    await createMember({ tenantId: 'some-tenant', orgId: 'org-mcp-gate', subject: 'mcp-anonymous', displayName: 'anon', roles: ['editor'] });
  });

  it('denies the anonymous principal; requires the notebooks toggle', async () => {
    const tool = listTools().find((t) => t.name === 'notebook-search')!;
    expect(tool.mcpRequiresAuth).toBe(true);
    expect(tool.mcpFeatureToggle).toBe('notebooks');
    // mcp-anonymous → denied, even in a real tenant where it holds editor.
    expect(await isToolAllowed(tool, { principalId: 'mcp-anonymous', tenants: ['some-tenant'], token: '' })).toBe(false);
    // A wildcard ANYWHERE in the tenant list is anonymous (u1 holds editor in t-first).
    expect(await isToolAllowed(tool, { principalId: 'u1', tenants: ['t-first', '*'], token: '' })).toBe(false);
    // a real tenant with notebooks ON (enabled globally in beforeAll) → allowed.
    expect(await isToolAllowed(tool, { principalId: 'u1', tenants: ['some-tenant'], token: '' })).toBe(true);
    // ...and the SAME principal is refused once the toggle is OFF — u1 still holds
    // editor, so this false can only be the toggle leg.
    const d = getToggleDefault('notebooks')!;
    await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      expect(await isToolAllowed(tool, { principalId: 'u1', tenants: ['some-tenant'], token: '' })).toBe(false);
    } finally {
      await saveConfig({ ...d, status: 'on' }, 'test');
    }
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
    const list = await c.get<Array<{ toolId: string; source: string; safetyTier: string; inputSchema?: unknown }>>('/tools');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body), 'GET /v1/tools MUST be a bare ToolDescriptor[]').toBe(true);
    const search = list.body.find((d) => d.toolId === 'mcp:notebook-search');
    expect(search, 'mcp:notebook-search descriptor present').toBeTruthy();
    expect(search!.source).toBe('mcp');
    expect(search!.safetyTier).toBe('read');
    expect(search!.inputSchema).toBeTruthy();

    const byId = await c.get('/tools/mcp:notebook-search');
    expect(byId.status).toBe(200);
    expect(byId.body.toolId).toBe('mcp:notebook-search');

    const unknown = await c.get('/tools/mcp:does-not-exist');
    expect(unknown.status).toBe(404);
  });

  it('projects the WRITE tools with safetyTier:write + approval:always (ADR 0087 OQ-1)', async () => {
    const { c } = await ownerWithOrg('mcp-write-desc');
    const list = (await c.get<Array<{ toolId: string; safetyTier: string; approval: string; auth?: { scopes?: string[] } }>>('/tools')).body;
    const addSource = list.find((d) => d.toolId === 'mcp:notebook-add-source');
    expect(addSource, 'mcp:notebook-add-source present').toBeTruthy();
    expect(addSource!.safetyTier).toBe('write');
    expect(addSource!.approval).toBe('always');
    expect(addSource!.auth?.scopes).toContain('workspace:write');
  });

  it('ADR 0601 — the SERVED descriptor\'s advertised scope IS the one the gate enforces', async () => {
    // CORRECTED (/grade-tests wave 20). This case used to `registerWorkflow` an
    // UNGATED expose-tool first, claiming it was "the only input that separates"
    // the shared rule from a hand-rolled `safetyTier` derivation. It was dead: the
    // MCP host enumeration reads `listChainBackedWorkflows()` only, so a
    // `registerWorkflow` definition is never served, and that exact sabotage stayed
    // green. The ungated branch of the ADVERT is carried by
    // `mcp-tool-scope-enforcement.test.ts` (over `toDescriptor` + an ungated host
    // manifest). What this case uniquely carries is the WIRE: the bytes GET /tools
    // serves (not the helper) equal the rule the gate enforces, for the GATED tools
    // the catalog actually serves — so a route that re-derives the scope reds here.
    const { c } = await ownerWithOrg('mcp-scope-parity');
    const list = (await c.get<Array<{ toolId: string; auth?: { scopes?: string[] } }>>('/tools')).body;
    expect(list.length, 'an empty catalog would make this loop vacuous').toBeGreaterThan(0);
    let checked = 0;
    for (const d of list) {
      const manifest = listTools().find((m) => `mcp:${m.name}` === d.toolId);
      if (!manifest) continue;
      const required = requiredScopeForTool(manifest);
      expect(d.auth?.scopes ?? [], d.toolId).toEqual(required ? [required] : []);
      checked += 1;
    }
    // ≥ the six read + two write notebook tools (all gated, both scope values walked).
    expect(checked, 'no served descriptor resolved back to a manifest').toBeGreaterThanOrEqual(8);
  });
});

describe('notebooks MCP WRITE tools — HITL gate (ADR 0087 OQ-1)', () => {
  it('a write tools/call SUSPENDS for approval and does NOT mutate until approved', async () => {
    const { c, orgId } = await ownerWithOrg('mcp-write');
    const created = await c.post('/host/openwop-app/notebooks', { orgId, name: 'Write target' });
    const notebookId = created.body.notebook!.id;

    const r = await rpc(c, 'tools/call', { name: 'notebook-create-note', arguments: { notebookId, content: 'untrusted note' } });
    expect(r.status).toBe(200);
    // The approval node suspended the run → the client is told it's pending, NOT done.
    expect(r.body.result?.isError, JSON.stringify(r.body)).toBe(true);
    expect(textOf(r)).toContain('awaiting');

    // The note was NOT created — approval is load-bearing (no silent mutation).
    // DOUBLE GUARD (recorded): even with the approval node gone, the write node's own
    // `decision !== 'accept'` check refuses (witnessed in notebooks-nodes.test.ts), so
    // this read alone cannot tell the two apart; the 'awaiting' assertion carries the node.
    const notes = await c.get(`/host/openwop-app/notebooks/${notebookId}/notes`);
    expect(notes.status).toBe(200);
    expect(notes.body.notes).toEqual([]);
  });
  // `the write node is a no-op unless the decision is accept` moved to
  // notebooks-nodes.test.ts (a pure node-fn claim; no app boot needed).
});
