/**
 * ADR 1132 D5 (#5969 P2) — the model-facing lanes apply the client floor too.
 *
 * P1 floored the HTTP routes. An agent or an MCP client is the same leak through
 * a different door: it could list client B's definitions as tools, read them
 * through the workflow-author tools, or bind them to a trigger.
 *
 * Sabotage witnesses: drop `mayLaunchOwned` from `mcpCallerFor` and the MCP case
 * fails; drop the actorless branch in `workflowClientReaderForScope` (return true)
 * and the actorless case fails; drop the kanban card floor and the binding case
 * fails.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { workflowClientReaderForScope } from '../src/host/workflowClientAccess.js';
import { listAuthoredWorkflows, readAuthoredWorkflow } from '../src/features/workflow-author/workflowAuthorService.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let server: http.Server;
let BASE = '';
let n = 0;
let rpcId = 0;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'kanban']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => {
  delete process.env.OPENWOP_MCP_SERVER_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = unknown> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = res.status === 204 ? '' : await res.text();
    let out: unknown;
    try { out = text ? JSON.parse(text) : undefined; } catch { out = text; }
    return { status: res.status, body: out as T };
  };
  return {
    get: <T = unknown>(p: string) => call<T>('GET', p),
    post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b),
    rpc: async (method: string, params: Record<string, unknown> = {}) =>
      call<{ result?: Record<string, unknown>; error?: { code: number; message: string } }>('POST', '/host/openwop-app/mcp', { jsonrpc: '2.0', id: ++rpcId, method, params }),
  };
}
type Client = ReturnType<typeof client>;
interface Person { c: Client; userId: string }
async function person(): Promise<Person> {
  const c = client();
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `wf1132p2-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user.userId };
}
const enc = encodeURIComponent;
const H = '/host/openwop-app';

async function agency() {
  const owner = await person();
  const ws = (await owner.c.post<{ workspaceId: string }>(`${H}/workspaces`, { name: `Agency1132p2-${n++}` })).body.workspaceId;
  expect((await owner.c.post(`${H}/workspaces/${enc(ws)}/switch`)).status).toBe(200);
  const org = async (name: string) => (await owner.c.post<{ orgId: string }>(`${H}/orgs`, { name })).body.orgId;
  const orgA = await org('Client A');
  const orgB = await org('Client B');
  // `rootRole` 'editor' for the lanes that need workspace write first (MCP's
  // workspaceLaunch, kanban card create), so the client floor is what refuses.
  const member = async (clientOrg: string, role = 'editor', rootRole = 'viewer'): Promise<Person> => {
    const p = await person();
    for (const [o, roles] of [[ws, [rootRole]], [clientOrg, [role]]] as const) {
      const r = await owner.c.post(`${H}/test/orgs/${enc(o)}/members`, { displayName: 'P', subject: p.userId, roles });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    expect((await p.c.post(`${H}/workspaces/${enc(ws)}/switch`)).status).toBe(200);
    return p;
  };
  /** A definition owned by the workspace, then assigned to `clientOrgId` (D6). */
  const definitionFor = async (clientOrgId: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const workflowId = `wf.p2.${Date.now().toString(36)}.${n++}`;
    const saved = await owner.c.post(`${H}/workflows`, { workflowId, nodes: [{ nodeId: 'a', typeId: 'core.noop', config: {} }], ...extra });
    expect([200, 201], JSON.stringify(saved.body)).toContain(saved.status);
    const stamped = await owner.c.post(`${H}/workflows/${enc(workflowId)}/client`, { clientOrgId });
    expect(stamped.status, JSON.stringify(stamped.body)).toBe(200);
    return workflowId;
  };
  return { owner, ws, orgA, orgB, member, definitionFor };
}

describe('ADR 1132 D5 — model-facing lanes', () => {
  it('MCP: another client\'s workflow is neither listed as a tool nor callable', async () => {
    const a = await agency();
    const tool = `p2tool_${n++}`;
    await a.definitionFor(a.orgB, {
      nodes: [{ nodeId: 'expose', typeId: 'core.openwop.mcp.expose-tool', config: { name: tool, description: 'd', inputSchema: { type: 'object', properties: {} } } }],
    });
    const names = async (c: Client) => (((await c.rpc('tools/list')).body.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
    const inB = await a.member(a.orgB, 'editor', 'editor');
    const inA = await a.member(a.orgA, 'editor', 'editor');
    expect(await names(inB.c), 'client B\'s people get the tool').toContain(tool);
    expect(await names(inA.c), 'client A\'s do not').not.toContain(tool);
    const call = await inA.c.rpc('tools/call', { name: tool, arguments: {} });
    expect(call.body.result?.isError === true || call.body.error !== undefined, JSON.stringify(call.body)).toBe(true);
  });

  it('author lane: an actor reads only clients they may; an admin reads all; an actorless run reads unstamped and its own client only', async () => {
    const a = await agency();
    const wfA = await a.definitionFor(a.orgA);
    const wfB = await a.definitionFor(a.orgB);
    const inA = await a.member(a.orgA, 'viewer');
    const actorA = workflowClientReaderForScope({ tenantId: a.ws, actingUserId: inA.userId });
    expect((await readAuthoredWorkflow(wfA, { tenantId: a.ws, mayRead: actorA })).found).toBe(true);
    expect((await readAuthoredWorkflow(wfB, { tenantId: a.ws, mayRead: actorA })).found, 'another client\'s is a miss').toBe(false);
    const listedA = new Set((await listAuthoredWorkflows({ tenantId: a.ws, mayRead: actorA })).map((w) => w.workflowId));
    expect(listedA.has(wfA) && !listedA.has(wfB)).toBe(true);

    const admin = workflowClientReaderForScope({ tenantId: a.ws, actingUserId: a.owner.userId });
    expect((await readAuthoredWorkflow(wfB, { tenantId: a.ws, mayRead: admin })).found, 'the workspace owner reads every client').toBe(true);

    // Actorless: a schedule's run for client B.
    const runId = `run-p2-${n++}`;
    await storage.insertRun({ runId, workflowId: wfB, tenantId: a.ws, status: 'running', inputs: null, configurable: {}, createdAt: 'x', updatedAt: 'x', metadata: { 'openwop-app.campaignOps': { orgId: a.orgB } } } as RunRecord);
    const bRun = workflowClientReaderForScope({ tenantId: a.ws, runId });
    expect((await readAuthoredWorkflow(wfB, { tenantId: a.ws, mayRead: bRun })).found, 'its own client').toBe(true);
    expect((await readAuthoredWorkflow(wfA, { tenantId: a.ws, mayRead: bRun })).found, 'not another client').toBe(false);
    const noRun = workflowClientReaderForScope({ tenantId: a.ws });
    expect((await readAuthoredWorkflow(wfA, { tenantId: a.ws, mayRead: noRun })).found, 'no person, no client: nothing stamped').toBe(false);
  });

  it('bindings: a client A member cannot bind client B\'s workflow; the admin view lists existing bindings', async () => {
    const a = await agency();
    const wfB = await a.definitionFor(a.orgB);
    const board = await a.owner.c.post<{ id: string; columns: Array<{ id: string }> }>(`${H}/kanban/boards`, { name: `Board ${n++}` });
    expect(board.status, JSON.stringify(board.body)).toBeLessThan(300);
    const col = board.body.columns[0]!.id;
    const inA = await a.member(a.orgA, 'editor', 'editor');
    const control = await inA.c.post(`${H}/kanban/boards/${enc(board.body.id)}/cards`, { columnId: col, title: 'no workflow' });
    expect(control.status, 'the member may create cards: the refusal below is the client floor').toBeLessThan(300);
    const refused = await inA.c.post(`${H}/kanban/boards/${enc(board.body.id)}/cards`, { columnId: col, title: 'x', workflowId: wfB });
    expect(refused.status, 'binding another client\'s workflow reads as unknown').toBe(404);
    const ok = await a.owner.c.post<{ id: string }>(`${H}/kanban/boards/${enc(board.body.id)}/cards`, { columnId: col, title: 'owner card', workflowId: wfB });
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);

    const view = await a.owner.c.get<{ bindings: Array<{ kind: string; workflowId: string; clientOrgId: string }> }>(`${H}/workflows/client-bindings`);
    expect(view.status).toBe(200);
    expect(view.body.bindings.some((b) => b.kind === 'kanban-card' && b.workflowId === wfB && b.clientOrgId === a.orgB)).toBe(true);
    expect((await inA.c.get(`${H}/workflows/client-bindings`)).status, 'admins only').toBe(403);
  });
});
