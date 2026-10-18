/**
 * ADR 0768 Phase 0 — ONE canvas read predicate on EVERY lane.
 *
 * The canvas editor HTTP route has enforced project/user membership on a
 * member-owned canvas since ADR 0610 D3′ (`canvasEditorRoutes.ts` loadCanvas).
 * Every OTHER lane loaded canvases by tenant alone:
 *
 *  - the chat agent tools of cad / drawings / slides / campaign-studio / app-builder,
 *  - the ui-plugin RPC (`artifact.read` / `artifact.write` — also with NO type pin),
 *  - the sharing mint (a non-member could publish a project canvas publicly),
 *  - documents: DELETE a canvas, materialize it into an org doc, list canvas sources,
 *  - the app-builder workflow surface and the MCP control nodes.
 *
 * EXPLOITABILITY, stated precisely (it is narrower than "every lane"): project
 * policy (`levelFor`, ADR 0054 D5) gives `workspace:write` WRITE on every project,
 * private ones included — membership only widens READ. So the lanes that already
 * required workspace:write (sharing mint, documents delete / materialize) were NOT
 * exploitable; they now use the shared predicate for consistency. The REAL leaks
 * were the lanes a VIEWER (or no scope at all) reaches: the five agent
 * `get-design` tools (a viewer read private project canvases), the ui-plugin RPC
 * (NO scope and NO type pin — any authenticated caller could read AND write any
 * canvas), the canvas-sources picker (names), the MCP nodes and the app-builder
 * run surface. Each lane now calls `canvasReadAllowed` / `getCanvasForCaller`
 * (host/canvasSurface.ts).
 *
 * The fixture is the DRC-1 shape: a PRIVATE project, owner A (member), and B, a
 * real org member with `workspace:read` who is not in the project — exactly the
 * caller org scope alone would wrongly admit. Every refusal must be the SAME
 * not-found the lane uses for an absent canvas (no existence leak), and every
 * lane must still serve the member (the fix must not over-refuse).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant, getCanvasForTenant, listCanvasesForCaller } from '../src/host/canvasSurface.js';
import { createMember } from '../src/host/accessControlService.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { CAD_GET_DESIGN_TOOL_ID } from '../src/features/cad/agentTools.js';
import { DRAWINGS_GET_DESIGN_TOOL_ID } from '../src/features/drawings/agentTools.js';
import { SLIDES_GET_DESIGN_TOOL_ID } from '../src/features/slides/agentTools.js';
import { CAMPAIGN_STUDIO_GET_DESIGN_TOOL_ID } from '../src/features/campaign-studio/agentTools.js';
import { APP_BUILDER_GET_DESIGN_TOOL_ID } from '../src/features/app-builder/agentTools.js';
import { dispatcherForTenant } from '../src/routes/uiPlugins.js';
import { UI_PLUGIN_PROTOCOL } from '../src/host/uiPluginRpc.js';
import { createLink, listLinks } from '../src/features/sharing/sharingService.js';
import { buildAppBuilderSurface } from '../src/features/app-builder/surface.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { MCP_NODE_PREFIX } from '../src/features/app-builder/mcpControlNodes.js';
import type { NodeContext } from '../src/executor/types.js';

let server: http.Server;
let BASE = '';
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['projects', 'cad', 'drawings', 'slides', 'campaign-studio', 'app-builder', 'documents', 'sharing']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
}, 60_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface ErrBody { error: string; message: string }
interface Client {
  userId: string;
  get: <T>(p: string) => Promise<Res<T>>;
  post: <T>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T>(p: string, b?: unknown) => Promise<Res<T>>;
  del: <T>(p: string) => Promise<Res<T>>;
}
async function loginTo(tenantId: string, who: string): Promise<Client> {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    const parsed: T = res.status === 204 ? JSON.parse('null') : await res.json().catch(() => undefined);
    return { status: res.status, body: parsed };
  };
  const r = await call<{ user: { userId: string } }>('POST', '/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { userId: r.body.user.userId, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

const P = '/host/openwop-app/projects';

/** A PRIVATE project in a one-org tenant; A owns it, B is an org VIEWER outside it. */
async function privateProject() {
  const tenantId = `org:cap-${Date.now()}-${n++}`;
  const a = await loginTo(tenantId, 'owner');
  const orgId = (await a.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  const projectId = (await a.post<{ id: string }>(P, { orgId, name: 'Secret' })).body.id;
  expect((await a.patch<{ visibility: string }>(`${P}/${projectId}/visibility`, { visibility: 'private' })).body.visibility).toBe('private');
  const b = await loginTo(tenantId, 'nonmember');
  await createMember({ tenantId, orgId, subject: b.userId, displayName: 'B', roles: ['viewer'] });
  const canvas = async (canvasTypeId: string, name = 'Secret'): Promise<string> =>
    (await createCanvasForTenant(tenantId, { canvasTypeId, name, ownerSubject: { kind: 'project', id: projectId }, initialState: { name, title: name } })).canvasId;
  return { tenantId, orgId, a, b, canvas };
}

describe('agent tools read through the shared predicate', () => {
  // Literal titles (one per tool) so a probe can name the ONE lane it breaks.
  async function toolLane(tool: string, type: string): Promise<void> {
    const f = await privateProject();
    const id = await f.canvas(type, 'Secret');
    const asB = await createAgentToolProvider({ tenantId: f.tenantId, actingUserId: f.b.userId }).executeTool({ name: tool, input: { canvasId: id, orgId: f.orgId } });
    expect(asB.isError, asB.content).toBe(true);
    expect(JSON.parse(asB.content)).toMatchObject({ error: 'not_found' });
    expect(asB.content).not.toContain('"Secret"');
    const asA = await createAgentToolProvider({ tenantId: f.tenantId, actingUserId: f.a.userId }).executeTool({ name: tool, input: { canvasId: id, orgId: f.orgId } });
    expect(asA.isError, asA.content).toBeFalsy();
    expect(asA.content).toContain('"Secret"'); // the member really read the design
  }
  it('cad get-design: the non-member gets not_found; the member reads it', () => toolLane(CAD_GET_DESIGN_TOOL_ID, 'canvas.cad'));
  it('drawings get-design: the non-member gets not_found; the member reads it', () => toolLane(DRAWINGS_GET_DESIGN_TOOL_ID, 'canvas.drawing'));
  it('slides get-design: the non-member gets not_found; the member reads it', () => toolLane(SLIDES_GET_DESIGN_TOOL_ID, 'canvas.slides'));
  it('campaign-studio get-design: the non-member gets not_found; the member reads it', () => toolLane(CAMPAIGN_STUDIO_GET_DESIGN_TOOL_ID, 'canvas.campaign'));
  it('app-builder get-design: the non-member gets not_found; the member reads it', () => toolLane(APP_BUILDER_GET_DESIGN_TOOL_ID, 'canvas.app-builder'));
});

describe('ui-plugin RPC', () => {
  const rpc = (id: number, method: string, params: unknown) => ({ openwop: UI_PLUGIN_PROTOCOL, id, type: 'request', method, params });

  it('refuses a non-member (read AND write), serves the member', async () => {
    const f = await privateProject();
    const id = await f.canvas('canvas.app-builder');
    expect(await dispatcherForTenant(f.tenantId, { subject: f.b.userId })(rpc(1, 'artifact.read', { artifactId: id })))
      .toMatchObject({ ok: false, error: { code: 'artifact_not_found' } });
    expect(await dispatcherForTenant(f.tenantId, { subject: f.b.userId })(rpc(2, 'artifact.write', { artifactId: id, version: '1', payload: { name: 'pwned' } })))
      .toMatchObject({ ok: false, error: { code: 'artifact_not_found' } });
    expect((await getCanvasForTenant(f.tenantId, id))?.version).toBe(1); // no write happened
    expect(await dispatcherForTenant(f.tenantId, { subject: f.a.userId })(rpc(3, 'artifact.read', { artifactId: id })))
      .toMatchObject({ ok: true });
  });

  it('is type-pinned: a non-app-builder canvas is not_found even for its owner', async () => {
    const f = await privateProject();
    const drawing = await f.canvas('canvas.drawing');
    expect(await dispatcherForTenant(f.tenantId, { subject: f.a.userId })(rpc(4, 'artifact.read', { artifactId: drawing })))
      .toMatchObject({ ok: false, error: { code: 'artifact_not_found' } });
  });

  it('with no caller at all, a member-owned canvas is refused (fail-closed)', async () => {
    const f = await privateProject();
    const id = await f.canvas('canvas.app-builder');
    expect(await dispatcherForTenant(f.tenantId)(rpc(5, 'artifact.read', { artifactId: id })))
      .toMatchObject({ ok: false, error: { code: 'artifact_not_found' } });
  });
});

describe('sharing mint', () => {
  it('a non-member cannot mint a public link to a project canvas; the member can', async () => {
    const f = await privateProject();
    const id = await f.canvas('canvas.app-builder');
    await expect(createLink(f.tenantId, f.orgId, f.b.userId, { resourceType: 'app_builder_canvas', resourceId: id }))
      .rejects.toMatchObject({ httpStatus: 404 });
    await expect(createLink(f.tenantId, f.orgId, f.a.userId, { resourceType: 'app_builder_canvas', resourceId: id }))
      .resolves.toMatchObject({ token: expect.any(String) });
  });
});

describe('sharing owner list — ADR 0887 D2 reads at READ level, not publish level', () => {
  it('a Viewer who can read an open project canvas sees its title; a private project canvas is withheld from a non-member', async () => {
    const f = await privateProject();
    const hiddenId = await f.canvas('canvas.app-builder', 'Hidden plan');
    const openProject = (await f.a.post<{ id: string }>(P, { orgId: f.orgId, name: 'Open' })).body.id;
    const openId = (await createCanvasForTenant(f.tenantId, { canvasTypeId: 'canvas.app-builder', name: 'Open plan', ownerSubject: { kind: 'project', id: openProject }, initialState: { name: 'Open plan' } })).canvasId;
    await createLink(f.tenantId, f.orgId, f.a.userId, { resourceType: 'app_builder_canvas', resourceId: hiddenId });
    await createLink(f.tenantId, f.orgId, f.a.userId, { resourceType: 'app_builder_canvas', resourceId: openId });
    const asB = await listLinks(f.tenantId, f.orgId, f.b.userId);
    const open = asB.find((l) => l.resourceId === openId)!;
    const hidden = asB.find((l) => l.resourceId === hiddenId)!;
    // B (an org Viewer) can READ the open project's canvas but could not PUBLISH it:
    // read mode names it. Publish-level redaction would have withheld it (architect M3).
    expect(open.cardRedacted).toBeUndefined();
    expect(open.cardTitle).toBe('Open plan');
    expect(hidden.cardRedacted).toBe(true);
    expect(JSON.stringify(hidden)).not.toContain('Hidden plan');
  });
});

describe('documents lanes', () => {
  const D = (orgId: string) => `/host/openwop-app/documents/orgs/${encodeURIComponent(orgId)}`;

  it('canvas-sources hides a private project canvas from a non-member, shows it to the member', async () => {
    const f = await privateProject();
    const id = await f.canvas('canvas.drawing', 'Hidden sketch');
    const asB = await f.b.get<{ canvases: { canvasId: string }[] }>(`${D(f.orgId)}/canvas-sources`);
    expect(asB.status).toBe(200);
    expect(asB.body.canvases.map((c) => c.canvasId)).not.toContain(id);
    const asA = await f.a.get<{ canvases: { canvasId: string }[] }>(`${D(f.orgId)}/canvas-sources`);
    expect(asA.status).toBe(200);
    expect(asA.body.canvases.map((c) => c.canvasId)).toContain(id);
  });

  it('DELETE follows the ONE project policy: a viewer is refused, and workspace:write reaches every project (ADR 0054 D5)', async () => {
    const f = await privateProject();
    const id = await f.canvas('canvas.drawing');
    // A viewer outside the project: refused (scope first — never a delete).
    // DOUBLE GATE (recorded): the lane's shared predicate (`getCanvasForCaller`) never
    // decides this case — B stops at the workspace:write floor, and C below is
    // admitted by ADR 0054 D5 policy, so probe w47g1-cap-del-pred is vacuous BY
    // DESIGN; the predicate itself is witnessed by the canvas-sources and
    // listCanvasesForCaller cases (probe w47g1-cap-list-filter).
    const refused = await f.b.del<ErrBody>(`${D(f.orgId)}/canvases/${encodeURIComponent(id)}`);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('forbidden_scope');
    expect(refused.body.message).toMatch(/workspace:write/);
    expect(await getCanvasForTenant(f.tenantId, id)).not.toBeNull();
    // An org EDITOR outside the private project: allowed BY POLICY — `levelFor`
    // grants write on every project to workspace:write (membership only widens
    // READ). The shared predicate must not invent a stricter rule than the
    // editor route; pinned so a future change to that policy is a decision.
    const c = await loginTo(f.tenantId, 'editor');
    await createMember({ tenantId: f.tenantId, orgId: f.orgId, subject: c.userId, displayName: 'C', roles: ['editor'] });
    expect((await c.del(`${D(f.orgId)}/canvases/${encodeURIComponent(id)}`)).status).toBe(204);
    expect(await getCanvasForTenant(f.tenantId, id)).toBeNull();
  });
});

describe('app-builder workflow surface + MCP node', () => {
  it('surface.getDesign refuses a run acting for a non-member, and a run with NO acting user', async () => {
    const f = await privateProject();
    const id = await f.canvas('canvas.app-builder');
    await expect(buildAppBuilderSurface({ tenantId: f.tenantId, actingUserId: f.b.userId }).getDesign!({ canvasId: id })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(buildAppBuilderSurface({ tenantId: f.tenantId }).getDesign!({ canvasId: id })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(buildAppBuilderSurface({ tenantId: f.tenantId, actingUserId: f.a.userId }).getDesign!({ canvasId: id })).resolves.toMatchObject({ version: 1 });
  });

  it('the MCP get-design node refuses a non-member principal', async () => {
    const f = await privateProject();
    const id = await f.canvas('canvas.app-builder');
    const node = await getNodeRegistry().resolve(`${MCP_NODE_PREFIX}get-design`);
    expect(node).toBeTruthy();
    const ctx = (actingUserId: string): NodeContext => ({
      runId: 'mcp-run', nodeId: 'n', tenantId: f.tenantId, actingUserId, inputs: { canvasId: id },
      config: {}, configurable: {}, attempt: 1, secrets: {}, emit: async () => ({ eventId: '', sequence: 0 }),
    });
    const asB = await node!.execute(ctx(f.b.userId));
    expect(asB).toMatchObject({ status: 'failure', error: { code: 'not_found' } });
    const asA = await node!.execute(ctx(f.a.userId));
    expect(asA).toMatchObject({ status: 'success', outputs: { canvasId: id, version: 1 } });
  });
});

describe('listCanvasesForCaller', () => {
  it('omits member-owned canvases for a non-member and keeps org-owned ones', async () => {
    const f = await privateProject();
    const secret = await f.canvas('canvas.drawing');
    const open = (await createCanvasForTenant(f.tenantId, { canvasTypeId: 'canvas.drawing', name: 'Open', initialState: {} })).canvasId;
    const ids = (await listCanvasesForCaller(f.tenantId, { subject: f.b.userId })).map((c) => c.canvasId);
    expect(ids).toContain(open);
    expect(ids).not.toContain(secret);
  });
});
