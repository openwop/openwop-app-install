/**
 * ADR 0831 P3 — the team-ledger agent tools, on a real app.
 *
 *   - both are registered builtins (and NOT on the default-on baseline: the
 *     chief-of-staff pack allowlists them);
 *   - no acting user ⇒ a typed failure, never an empty success;
 *   - the tool shares the route's predicate: a stranger and a toggle-OFF tenant
 *     get the same `not_found`; a viewer can read but `propose` is `forbidden`;
 *   - `propose` only proposes: the version does not move, the author is the
 *     agent, the source is the run; the owner then accepts it over HTTP;
 *   - invalid patches come back as typed tool errors.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { TEAM_LEDGER_GET_TOOL_ID, TEAM_LEDGER_PROPOSE_TOOL_ID } from '../src/features/team-intent-ledger/agentTools.js';
import { getDelta } from '../src/features/team-intent-ledger/ledgerStore.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}
const email = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

async function setup() {
  const tenantId = `org:tlt-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: email('tlt-owner'), tenantId })).body.user.userId as string;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'ToolCo' })).body.orgId as string;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string };
  await owner.patch(`/host/openwop-app/projects/${proj.id}`, { charter: { goal: 'Ship the launch', objectives: ['EU live'] } });
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  expect((await owner.post(L)).status).toBe(201);
  return { tenantId, orgId, owner, ownerId, projectId: proj.id, L };
}

const call = (tenantId: string, scope: { actingUserId?: string; agentProfileId?: string }, name: string, input: Record<string, unknown>) =>
  createAgentToolProvider({ tenantId, runId: 'run-tlt-1', ...scope }).executeTool({ name, input });
const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, any>;

describe('ADR 0831 P3 — team-ledger agent tools', () => {
  it('both are registered builtins', () => {
    const ids = builtinAgentToolIds();
    expect(ids).toContain(TEAM_LEDGER_GET_TOOL_ID);
    expect(ids).toContain(TEAM_LEDGER_PROPOSE_TOOL_ID);
  });

  it('no acting user ⇒ a typed failure on both', async () => {
    const s = await setup();
    for (const [name, input] of [[TEAM_LEDGER_GET_TOOL_ID, { projectId: s.projectId }], [TEAM_LEDGER_PROPOSE_TOOL_ID, { projectId: s.projectId, patch: { inScope: ['x'] }, why: 'w' }]] as const) {
      const r = await call(s.tenantId, {}, name, input);
      expect(r.isError).toBe(true);
      expect(parse(r).error).toBe('acting_user_required');
    }
  });

  it('get returns the current state; a stranger and a toggle-OFF tenant get the same not_found', async () => {
    const s = await setup();
    const ok = parse(await call(s.tenantId, { actingUserId: s.ownerId }, TEAM_LEDGER_GET_TOOL_ID, { projectId: s.projectId }));
    expect(ok).toMatchObject({ version: 1, canPropose: true, state: { goal: 'Ship the launch', objectives: ['EU live'] } });

    const stranger = client();
    const strangerId = (await stranger.post('/host/openwop-app/test/login', { email: email('tlt-stranger') })).body.user.userId as string;
    const st = await call(s.tenantId, { actingUserId: strangerId }, TEAM_LEDGER_GET_TOOL_ID, { projectId: s.projectId });
    expect(st.isError).toBe(true);
    expect(parse(st).error).toBe('not_found');
  });

  it('propose only proposes; the owner accepts it over HTTP', async () => {
    const s = await setup();
    const r = parse(await call(s.tenantId, { actingUserId: s.ownerId, agentProfileId: 'agent.cos' }, TEAM_LEDGER_PROPOSE_TOOL_ID, {
      projectId: s.projectId, patch: { openQuestions: ['Is the date fixed?'] }, why: 'Raised in standup', baseVersion: 1,
    }));
    expect(r).toMatchObject({ proposed: true, status: 'proposed', baseVersion: 1 });
    expect((await s.owner.get(s.L)).body.ledger.version).toBe(1); // nothing moved
    const delta = await getDelta(s.tenantId, r.deltaId);
    expect(delta).toMatchObject({ author: { kind: 'agent', id: 'agent.cos' }, source: { kind: 'run', ref: 'run-tlt-1' } });
    const acc = await s.owner.post(`${s.L}/deltas/${r.deltaId}/accept`);
    expect(acc.status).toBe(200);
    expect(acc.body.ledger.version).toBe(2);
  });

  it('a viewer can read but cannot propose; invalid patches are typed errors', async () => {
    const s = await setup();
    const viewer = client();
    const viewerId = (await viewer.post('/host/openwop-app/test/login', { email: email('tlt-viewer'), tenantId: s.tenantId })).body.user.userId as string;
    await createMember({ tenantId: s.tenantId, orgId: s.orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
    expect(parse(await call(s.tenantId, { actingUserId: viewerId }, TEAM_LEDGER_GET_TOOL_ID, { projectId: s.projectId })).canPropose).toBe(false);
    const denied = await call(s.tenantId, { actingUserId: viewerId }, TEAM_LEDGER_PROPOSE_TOOL_ID, { projectId: s.projectId, patch: { inScope: ['x'] }, why: 'w' });
    expect(parse(denied).error).toBe('forbidden');

    const bad = await call(s.tenantId, { actingUserId: s.ownerId }, TEAM_LEDGER_PROPOSE_TOOL_ID, { projectId: s.projectId, patch: { intent: 'x' }, why: 'w' });
    expect(bad.isError).toBe(true);
    expect(parse(bad).error).toBe('validation_error');
    const noWhy = await call(s.tenantId, { actingUserId: s.ownerId }, TEAM_LEDGER_PROPOSE_TOOL_ID, { projectId: s.projectId, patch: { inScope: ['x'] }, why: ' ' });
    expect(parse(noWhy).error).toBe('validation_error');
  });
});
