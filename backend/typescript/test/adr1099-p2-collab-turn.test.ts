/**
 * ADR 1099 D5 (P2) — the collaborator turn, through the real route.
 *
 * A firm grants an outside person ONE project; that person (signed in to their own
 * account, never a member of the firm) talks to the project's agent. Witnesses:
 *
 *  - the model is offered EXACTLY the client tools registered for the kind whose
 *    action the grant holds: no ADR 0315 baseline, no member tool, no `comment` tool
 *    on a `view`-only grant;
 *  - a scope key the model writes (`projectId`) never reaches the tool; the tool runs
 *    on the grant's project;
 *  - a revoke between two tool calls refuses the second;
 *  - the run is the firm's and owned by `collab:<collaboratorId>`, with no
 *    `principalKind` anywhere (never the anonymous actor);
 *  - the day cap answers 429;
 *  - a kind with no turn agent, another person, and an empty message are refused.
 *
 * Sabotage notes (each reds a case below):
 *  - compiling the agent pack's allowlist instead of `clientToolsFor` reds "exactly";
 *  - passing `call.input` to `run` without `withoutScopeKeys` reds "scope key";
 *  - dropping the per-call `checkGrantUse` reds "revoke";
 *  - stamping `anonOwnerStamp` reds "owned by collab".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getUser } from '../src/features/users/usersService.js';
import { getOrg } from '../src/host/accessControlService.js';
import { registerGrantResourceKind, type CollaboratorGrant } from '../src/host/externalCollaborators.js';
import { registerClientProjectTool, type ClientToolScope } from '../src/host/clientProjectTools.js';
import { COLLAB_TURN_WORKFLOW_ID, __resetCollabTurnCapsForTests, __setCollabTurnModelForTests } from '../src/host/collaboratorTurn.js';
import { PROJECTS_CLIENT_PORTAL_TOGGLE, PROJECT_OVERVIEW_TOOL } from '../src/features/projects/clientPortal.js';

const PROBE = 'openwop:client.project.probe';
const COMMENT_PROBE = 'openwop:client.project.comment-probe';

let BASE: string;
let server: http.Server;
let storage: Storage;
/** What the probe tool was called with, in order. */
const probeCalls: Array<{ scope: ClientToolScope; input: Record<string, unknown> }> = [];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const portal = getToggleDefault(PROJECTS_CLIENT_PORTAL_TOGGLE);
  if (portal) await saveConfig({ ...portal, status: 'on' }, 'test');
  registerClientProjectTool({
    id: PROBE, kind: 'project', featureId: 'test-adopter', effect: 'read', action: 'view',
    description: 'Probe.', inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
    async run(scope, input) { probeCalls.push({ scope, input }); return { ok: true }; },
  });
  registerClientProjectTool({
    id: COMMENT_PROBE, kind: 'project', featureId: 'test-adopter', effect: 'read', action: 'comment',
    description: 'Needs comment.', inputSchema: { type: 'object', properties: {} },
    async run() { return { ok: true }; },
  });
  // A kind with no turn agent: no collaborator chat.
  registerGrantResourceKind('turnless-probe', {
    featureId: null, actions: ['view'],
    surface: { enabledFor: async () => true, async orgOpen(tenantId, orgId) { return (await getOrg(orgId))?.tenantId === tenantId; } },
    exists: async () => true,
    project: async (_t, _o, id) => ({ title: id, body: {} }),
    list: async () => [{ id: 'thing-1', title: 'Thing one' }],
  });
}, 120_000);
afterEach(async () => {
  __setCollabTurnModelForTests(undefined);
  await __resetCollabTurnCapsForTests();
  delete process.env.OPENWOP_COLLAB_TURNS_PER_GRANT_DAY;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T; raw: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1] ?? cookie; }
    const raw = res.status === 204 ? '' : await res.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed as T, raw };
  };
  const v2 = async <T>(path: string, body: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'OpenWOP-Version': '2', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const raw = await res.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed as T, raw };
  };
  return { post: <T>(p: string, b?: unknown) => call<T>('POST', p, b), del: <T>(p: string) => call<T>('DELETE', p), postV2: v2 };
}
const C = (orgId: string): string => `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/collaborators`;
const TURN = (grantId: string): string => `/host/openwop-app/collab/grants/${grantId}/turn`;

let n = 0;
async function setup(resource?: { kind: string; id: string }) {
  const tenantId = `ws:t-1099turn-${n++}`;
  const admin = client();
  expect((await admin.post('/host/openwop-app/test/login', { email: `owner-turn-${n}@studio.test`, tenantId })).status).toBe(201);
  const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Riverside renovation' });
  const p = await admin.post<{ id: string }>('/host/openwop-app/projects', { orgId: org.body.orgId, name: 'Kitchen and bath' });
  expect(p.status, p.raw).toBe(201);
  const person = client();
  const v = await person.post<{ user: { userId: string; tenantId?: string } }>('/host/openwop-app/test/login', { email: `client-turn-${n++}@outside.test` });
  const email = (await getUser(v.body.user.userId))?.email ?? '';
  const inv = await admin.post<{ collaborator: { collaboratorId: string }; invite: { token: string } }>(C(org.body.orgId), { kind: 'client-stakeholder', email, displayName: 'The Garcias' });
  expect(inv.status, inv.raw).toBe(201);
  expect((await person.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token })).status).toBe(200);
  const collaboratorId = inv.body.collaborator.collaboratorId;
  const g = await admin.post<{ grant: CollaboratorGrant }>(`${C(org.body.orgId)}/${collaboratorId}/grants`, { resource: resource ?? { kind: 'project', id: p.body.id }, actions: ['view'], expiresInDays: 30 });
  expect(g.status, g.raw).toBe(201);
  return { tenantId, orgId: org.body.orgId, projectId: p.body.id, admin, person, collaboratorId, grantId: g.body.grant.grantId };
}

/** A scripted model: each round returns the next step's tool calls, then text. */
function scripted(steps: Array<(r: AiToolCallRequest) => Promise<AiToolCallResult['toolCalls']> | AiToolCallResult['toolCalls']>, seen: AiToolCallRequest[] = []) {
  let round = 0;
  return async (r: AiToolCallRequest): Promise<AiToolCallResult> => {
    seen.push(r);
    const step = steps[round++];
    if (!step) return { content: 'All done.', toolCalls: [] };
    return { content: '', toolCalls: await step(r) };
  };
}

describe('ADR 1099 P2 — the collaborator turn', () => {
  it('offers exactly the client tools for the kind whose action the grant holds', async () => {
    const s = await setup();
    const seen: AiToolCallRequest[] = [];
    __setCollabTurnModelForTests(scripted([() => [{ id: 'c1', name: PROJECT_OVERVIEW_TOOL, input: {} }]], seen));
    const r = await s.person.post<{ reply: string; runId?: string }>(TURN(s.grantId), { message: 'How is the project going?' });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.reply).toBe('All done.');
    // The run is the firm's: its id never reaches the outsider.
    expect(r.body.runId).toBeUndefined();
    expect(seen[0]?.tools.map((t) => t.name).sort()).toEqual([PROBE, PROJECT_OVERVIEW_TOOL].sort());
    // The overview tool returned the grant's project.
    expect(JSON.stringify(seen[1]?.messages)).toContain('Kitchen and bath');
  });

  it('a scope key the model writes never reaches the tool', async () => {
    const s = await setup();
    probeCalls.length = 0;
    __setCollabTurnModelForTests(scripted([() => [{ id: 'c1', name: PROBE, input: {
      projectId: 'someone-elses', tenantId: 'ws:other', note: 'hi',
      // Nested, snake-case and other spellings are dropped too.
      filter: { project_id: 'someone-elses', ProjectID: 'x', rows: [{ 'grant-id': 'cgr_x', keep: 1 }] },
    } }]]));
    expect((await s.person.post(TURN(s.grantId), { message: 'Show me the other project.' })).status).toBe(200);
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]?.input).toEqual({ note: 'hi', filter: { rows: [{ keep: 1 }] } });
    expect(probeCalls[0]?.scope).toMatchObject({ tenantId: s.tenantId, orgId: s.orgId, resourceKind: 'project', resourceId: s.projectId, grantId: s.grantId, collaboratorId: s.collaboratorId });
  });

  it('a revoke between two tool calls refuses the second', async () => {
    const s = await setup();
    probeCalls.length = 0;
    const seen: AiToolCallRequest[] = [];
    __setCollabTurnModelForTests(scripted([
      () => [{ id: 'c1', name: PROBE, input: {} }],
      async () => {
        const del = await s.admin.del(`${C(s.orgId)}/${s.collaboratorId}/grants/${s.grantId}`);
        expect(del.status, del.raw).toBe(200);
        // Different input: the loop refuses an exact repeat by itself.
        return [{ id: 'c2', name: PROBE, input: { note: 'again' } }];
      },
    ], seen));
    expect((await s.person.post(TURN(s.grantId), { message: 'Twice, please.' })).status).toBe(200);
    expect(probeCalls).toHaveLength(1);
    expect(JSON.stringify(seen[2]?.messages)).toContain('access_ended');
    // And the next turn is the uniform 404.
    expect((await s.person.post(TURN(s.grantId), { message: 'Again?' })).status).toBe(404);
  });

  it('the run is the firm\'s, owned by collab:<id>, and never carries principalKind', async () => {
    const s = await setup();
    __setCollabTurnModelForTests(scripted([]));
    const r = await s.person.post(TURN(s.grantId), { message: 'Hello.' });
    expect(r.status, r.raw).toBe(200);
    const runs = await storage.listRuns({ tenantId: s.tenantId, workflowId: COLLAB_TURN_WORKFLOW_ID });
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run?.tenantId).toBe(s.tenantId);
    const md = (run?.metadata ?? {}) as Record<string, unknown>;
    expect(md.collabPrincipal).toBe(`collab:${s.collaboratorId}`);
    expect(md.grantId).toBe(s.grantId);
    const owner = md.owner as { principal: string; principalKind?: string; subject: { issuer: string; kind: string } };
    expect(owner.principal).toBe(`collab:${s.collaboratorId}`);
    expect(owner.subject).toMatchObject({ issuer: 'urn:openwop-app:collaborator', kind: 'user' });
    expect(JSON.stringify(md)).not.toContain('principalKind');
  });

  it('a member cannot fork or replay a collaborator\'s run', async () => {
    const s = await setup();
    __setCollabTurnModelForTests(scripted([]));
    expect((await s.person.post(TURN(s.grantId), { message: 'Hello.' })).status).toBe(200);
    const [run] = await storage.listRuns({ tenantId: s.tenantId, workflowId: COLLAB_TURN_WORKFLOW_ID });
    for (const mode of ['replay', 'branch']) {
      const f = await s.admin.postV2<{ details?: { reason?: string } }>(`/runs/${encodeURIComponent(`${s.tenantId}/${run!.runId}`)}:fork`, { mode, fromSeq: 0 });
      expect(f.status, f.raw).toBe(409);
      expect(f.body.details?.reason).toBe('collab_run_not_forkable');
    }
  });

  it('a schema naming a scope key at any depth, in any spelling, is refused', () => {
    const base = { kind: 'project', featureId: 'test-adopter', effect: 'read' as const, action: 'view' as const, description: 'x', run: async () => null };
    expect(() => registerClientProjectTool({ ...base, id: 'openwop:client.project.nested', inputSchema: { type: 'object', properties: { filter: { type: 'object', properties: { projectId: { type: 'string' } } } } } })).toThrow(/scope keys/);
    expect(() => registerClientProjectTool({ ...base, id: 'openwop:client.project.snake', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } } } })).toThrow(/scope keys/);
    expect(() => registerClientProjectTool({ ...base, id: 'openwop:client.project.items', inputSchema: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { TenantID: {} } } } } } })).toThrow(/scope keys/);
    expect(() => registerClientProjectTool({ ...base, id: 'openwop:other.thing', inputSchema: { type: 'object', properties: {} } })).toThrow(/openwop:client\.project\./);
  });

  it('the day cap answers 429', async () => {
    const s = await setup();
    process.env.OPENWOP_COLLAB_TURNS_PER_GRANT_DAY = '2';
    __setCollabTurnModelForTests(scripted([]));
    expect((await s.person.post(TURN(s.grantId), { message: 'One.' })).status).toBe(200);
    expect((await s.person.post(TURN(s.grantId), { message: 'Two.' })).status).toBe(200);
    const third = await s.person.post(TURN(s.grantId), { message: 'Three.' });
    expect(third.status, third.raw).toBe(429);
  });

  it('refuses a kind with no turn agent, another person, and an empty message', async () => {
    const turnless = await setup({ kind: 'turnless-probe', id: 'thing-1' });
    __setCollabTurnModelForTests(scripted([]));
    expect((await turnless.person.post(TURN(turnless.grantId), { message: 'Hi.' })).status).toBe(404);
    const s = await setup();
    const stranger = client();
    await stranger.post('/host/openwop-app/test/login', { email: `stranger-${n++}@outside.test` });
    expect((await stranger.post(TURN(s.grantId), { message: 'Hi.' })).status).toBe(404);
    // The firm's own member is not the collaborator either.
    expect((await s.admin.post(TURN(s.grantId), { message: 'Hi.' })).status).toBe(404);
    const empty = await s.person.post(TURN(s.grantId), { message: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.raw).toContain('message');
  });
});
