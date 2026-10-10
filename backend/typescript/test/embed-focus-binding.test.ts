/**
 * ADR 0777 — embed focus: bind an embedded chat to the entity beside it.
 *
 * The binding is a tool DEFAULT, never a grant:
 *  - the server stores it only after verifying the caller may READ the entity
 *    (a refusal stores nothing — a forged request binds nothing);
 *  - an ephemeral embed session (no meta yet) gets a meta OWNED BY THE CALLER;
 *  - `cad.get-design` without `canvasId` reads the bound canvas, still through
 *    THE canvas predicate (a focus the caller can no longer read → not_found);
 *  - CANVAS only: a builder workflow's binding is ADR 0773's pairing context.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';
import { createMember } from '../src/host/accessControlService.js';
import { getConversationMeta } from '../src/host/conversationStore.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { CAD_GET_DESIGN_TOOL_ID } from '../src/features/cad/agentTools.js';

let server: http.Server;
let BASE = '';
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['projects', 'cad', 'workflow-author']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
}, 60_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Client { userId: string; put: (p: string, b?: unknown) => Promise<any>; post: (p: string, b?: unknown) => Promise<any>; patch: (p: string, b?: unknown) => Promise<any> }
async function loginTo(tenantId: string, who: string): Promise<Client> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  const r = await call('POST', '/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { userId: r.body.user.userId, put: (p, b) => call('PUT', p, b), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

/** A private project with a CAD canvas; A is the owner, B an org viewer outside it. */
async function fixture() {
  const tenantId = `org:efb-${Date.now()}-${n++}`;
  const a = await loginTo(tenantId, 'owner');
  const orgId = (await a.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId as string;
  const projectId = (await a.post('/host/openwop-app/projects', { orgId, name: 'Secret' })).body.id as string;
  await a.patch(`/host/openwop-app/projects/${projectId}/visibility`, { visibility: 'private' });
  const b = await loginTo(tenantId, 'viewer');
  await createMember({ tenantId, orgId, subject: b.userId, displayName: 'B', roles: ['viewer'] });
  const canvasId = (await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.cad', name: 'Bracket', ownerSubject: { kind: 'project', id: projectId }, initialState: { name: 'Bracket', solids: [] } })).canvasId;
  return { tenantId, orgId, a, b, canvasId };
}

const FOCUS = (sid: string) => `/host/openwop-app/chat/sessions/${sid}/focus`;

describe('focus route', () => {
  it('binds for a caller who may read the canvas, creating a caller-owned meta for an ephemeral session', async () => {
    const f = await fixture();
    const r = await f.a.put(FOCUS('embed-a-1'), { kind: 'canvas', id: f.canvasId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const meta = await getConversationMeta(f.tenantId, 'embed-a-1');
    expect(meta).toMatchObject({ focus: { kind: 'canvas', id: f.canvasId }, ownerUserId: f.a.userId });
  });

  it('refuses a caller who may NOT read the canvas — uniform 404, and NOTHING is stored', async () => {
    const f = await fixture();
    const r = await f.b.put(FOCUS('embed-b-1'), { kind: 'canvas', id: f.canvasId });
    expect(r.status).toBe(404);
    expect(await getConversationMeta(f.tenantId, 'embed-b-1')).toBeNull();
  });

  it('refuses to re-focus another user\'s conversation', async () => {
    const f = await fixture();
    await f.a.put(FOCUS('embed-a-2'), { kind: 'canvas', id: f.canvasId });
    const open = (await createCanvasForTenant(f.tenantId, { canvasTypeId: 'canvas.cad', name: 'Open', initialState: { solids: [] } })).canvasId;
    expect((await f.b.put(FOCUS('embed-a-2'), { kind: 'canvas', id: open })).status).toBe(404);
    expect((await getConversationMeta(f.tenantId, 'embed-a-2'))?.focus?.id).toBe(f.canvasId);
  });

  it('rejects any kind but canvas (a workflow binding is ADR 0773 pairing, not this)', async () => {
    const f = await fixture();
    expect((await f.a.put(FOCUS('embed-a-3'), { kind: 'workflow', id: 'x' })).status).toBe(400);
  });
});

describe('tools default to the focus, never widen with it', () => {
  it('cad.get-design with no canvasId reads the bound canvas', async () => {
    const f = await fixture();
    await f.a.put(FOCUS('embed-a-4'), { kind: 'canvas', id: f.canvasId });
    const out = await createAgentToolProvider({ tenantId: f.tenantId, actingUserId: f.a.userId, conversationId: 'embed-a-4' })
      .executeTool({ name: CAD_GET_DESIGN_TOOL_ID, input: { orgId: f.orgId } });
    expect(out.isError, out.content).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ canvasId: f.canvasId });
  });

  it('a focus the caller cannot read resolves to not_found (the predicate still applies)', async () => {
    const f = await fixture();
    await f.a.put(FOCUS('embed-a-5'), { kind: 'canvas', id: f.canvasId });
    // B acting on A's conversation id (a stale/forged scope): the id resolves, the read is refused.
    const out = await createAgentToolProvider({ tenantId: f.tenantId, actingUserId: f.b.userId, conversationId: 'embed-a-5' })
      .executeTool({ name: CAD_GET_DESIGN_TOOL_ID, input: { orgId: f.orgId } });
    expect(JSON.parse(out.content)).toMatchObject({ error: 'not_found' });
  });
});

