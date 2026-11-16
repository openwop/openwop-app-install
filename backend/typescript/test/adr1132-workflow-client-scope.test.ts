/**
 * ADR 1132 (#5969) — a workflow definition FOR a client is read and used only by
 * people who may act in that client.
 *
 * `market-intel.digest` freezes its `topic` param into the stored definition, so
 * a secret topic stands in for a client's own content: it must never reach a
 * member of another client, by the list, the by-id read, or a launched run.
 *
 * Sabotage witnesses: make `workflowClientReader` always allow and the read and
 * list cases fail; drop the D4 stamp in `runInsert.ts` and the run case fails.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getOwned } from '../src/host/workflowOwnership.js';
import { inheritedRunMetadata } from '../src/host/inheritedRunMetadata.js';
import { listChain } from '../src/host/auditChainService.js';
import type { Storage } from '../src/storage/storage.js';

let server: http.Server;
let BASE = '';
let n = 0;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'funnels']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = unknown> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...headers, ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = res.status === 204 ? '' : await res.text();
    let out: unknown;
    try { out = text ? JSON.parse(text) : undefined; } catch { out = text; }
    return { status: res.status, body: out as T };
  };
  return {
    get: <T = unknown>(p: string, h?: Record<string, string>) => call<T>('GET', p, undefined, h),
    post: <T = unknown>(p: string, b?: unknown, h?: Record<string, string>) => call<T>('POST', p, b, h),
  };
}
type Client = ReturnType<typeof client>;
interface Person { c: Client; userId: string; tenantId: string }
async function person(): Promise<Person> {
  const c = client();
  const r = await c.post<{ user: { userId: string; tenantId: string } }>('/host/openwop-app/test/login', { email: `wf1132-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user.userId, tenantId: r.body.user.tenantId };
}
const enc = encodeURIComponent;
const H = '/host/openwop-app';

async function agency() {
  const owner = await person();
  const ws = (await owner.c.post<{ workspaceId: string }>(`${H}/workspaces`, { name: `Agency1132-${n++}` })).body.workspaceId;
  expect((await owner.c.post(`${H}/workspaces/${enc(ws)}/switch`)).status).toBe(200);
  const org = async (name: string) => (await owner.c.post<{ orgId: string }>(`${H}/orgs`, { name })).body.orgId;
  const orgA = await org('Client A');
  const orgB = await org('Client B');
  const place = async (p: Person, orgId: string, roles: string[]): Promise<string> => {
    const r = await owner.c.post<{ memberId: string }>(`${H}/orgs/${enc(orgId)}/members`, { displayName: 'P', subject: p.userId, roles });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.memberId;
  };
  const enter = async (p: Person) => { expect((await p.c.post(`${H}/workspaces/${enc(ws)}/switch`)).status).toBe(200); };
  /** Instantiate the digest chain with a secret topic, as `who`. */
  const instantiate = async (who: Client, topic: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
    who.post<{ workflowId: string; error?: string; details?: { reason?: string } }>(`${H}/workflows/from-chain`, { chainId: 'market-intel.digest', params: { topic }, ...extra }, headers);
  return { owner, ws, orgA, orgB, place, enter, instantiate };
}

describe('ADR 1132 — a client\'s workflow definitions', () => {
  it('D1/D2: a definition for client B is invisible to a member of client A (list and by-id) and readable by an admin', async () => {
    const a = await agency();
    const secret = `B-SECRET-${n++}`;
    const made = await a.instantiate(a.owner.c, secret, { clientOrgId: a.orgB });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    const id = made.body.workflowId;
    expect((await getOwned(a.ws, id))?.clientOrgId).toBe(a.orgB);

    const memberA = await person();
    await a.place(memberA, a.ws, ['viewer']);
    await a.place(memberA, a.orgA, ['viewer']);
    await a.enter(memberA);
    const list = await memberA.c.get<{ workflows?: Array<{ workflowId: string }> } | Array<{ workflowId: string }>>(`${H}/workflows`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(id);
    const byId = await memberA.c.get(`/workflows/${enc(id)}`);
    expect(byId.status, 'another client\'s definition reads as unknown').toBe(404);
    expect(JSON.stringify(byId.body)).not.toContain(secret);
    for (const path of [`${H}/workflows/${enc(id)}/head`, `${H}/workflows/${enc(id)}/revisions`]) {
      const r = await memberA.c.get(path);
      expect(r.status, path).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain(secret);
    }

    const memberB = await person();
    await a.place(memberB, a.ws, ['viewer']);
    await a.place(memberB, a.orgB, ['viewer']);
    await a.enter(memberB);
    expect((await memberB.c.get(`/workflows/${enc(id)}`)).status, 'client B\'s own people read it').toBe(200);
    expect(JSON.stringify((await a.owner.c.get(`/workflows/${enc(id)}`)).body), 'the admin reads it').toContain(secret);
  });

  it('D1: act-as a client member stamps that client; a mismatching clientOrgId is refused', async () => {
    const a = await agency();
    const editorA = await person();
    await a.place(editorA, a.ws, ['viewer']);
    const memberIdA = await a.place(editorA, a.orgA, ['editor']);
    const asA = { 'x-openwop-act-as': memberIdA };
    const made = await a.instantiate(a.owner.c, `A-${n++}`, {}, asA);
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    expect((await getOwned(a.ws, made.body.workflowId))?.clientOrgId, 'derived from act-as').toBe(a.orgA);
    const clash = await a.instantiate(a.owner.c, 'x', { clientOrgId: a.orgB }, asA);
    expect(clash.status, 'an explicit client that disagrees with the context').toBe(404);
    const root = await a.instantiate(a.owner.c, `root-${n++}`);
    expect((await getOwned(a.ws, root.body.workflowId))?.clientOrgId, 'a root admin with no context makes an unstamped one').toBeUndefined();
  });

  it('D4 and the launch floor: a run of client B\'s definition is B\'s run; client A cannot launch it', async () => {
    const a = await agency();
    const made = await a.instantiate(a.owner.c, `B-RUN-${n++}`, { clientOrgId: a.orgB });
    const id = made.body.workflowId;
    const run = await a.owner.c.post<{ runId: string }>('/runs', { workflowId: id, inputs: {} });
    expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);
    const raw = run.body.runId.slice(run.body.runId.lastIndexOf('/') + 1);
    const stored = await storage.getRun(raw);
    expect((stored?.metadata as Record<string, { orgId?: string }>)['openwop-app.campaignOps']?.orgId, 'stamped for the definition\'s client').toBe(a.orgB);

    const memberA = await person();
    await a.place(memberA, a.ws, ['editor']);
    await a.place(memberA, a.orgA, ['editor']);
    await a.enter(memberA);
    expect((await memberA.c.get(`/runs/${enc(run.body.runId)}`)).status, 'ADR 1121 now sees the client').toBe(404);
    expect((await memberA.c.post('/runs', { workflowId: id, inputs: {} })).status, 'nor may they launch it').toBe(404);
  });

  it('D6: a root admin lists the unstamped definitions and stamps one, once, audited', async () => {
    const a = await agency();
    const made = await a.instantiate(a.owner.c, `legacy-${n++}`);
    const id = made.body.workflowId;
    const unstamped = await a.owner.c.get<{ workflows: Array<{ workflowId: string; name?: string }> }>(`${H}/workflows/unstamped`);
    expect(unstamped.status).toBe(200);
    expect(unstamped.body.workflows.some((w) => w.workflowId === id)).toBe(true);
    for (const w of unstamped.body.workflows) expect(Object.keys(w).every((k) => k === 'workflowId' || k === 'name'), 'ids and names only').toBe(true);

    const viewer = await person();
    await a.place(viewer, a.ws, ['viewer']);
    await a.enter(viewer);
    expect((await viewer.c.get(`${H}/workflows/unstamped`)).status).toBe(403);
    expect((await viewer.c.post(`${H}/workflows/${enc(id)}/client`, { clientOrgId: a.orgA })).status).toBe(403);

    expect((await a.owner.c.post(`${H}/workflows/${enc(id)}/client`, { clientOrgId: a.ws })).status, 'the workspace root is not a client').toBe(404);
    const ok = await a.owner.c.post(`${H}/workflows/${enc(id)}/client`, { clientOrgId: a.orgA });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await getOwned(a.ws, id))?.clientOrgId).toBe(a.orgA);
    const again = await a.owner.c.post<{ details?: { reason?: string } }>(`${H}/workflows/${enc(id)}/client`, { clientOrgId: a.orgB });
    expect(again.status, 'set once').toBe(409);
    expect(again.body.details?.reason).toBe('client_already_set');
    expect((await getOwned(a.ws, id))?.clientOrgId).toBe(a.orgA);
    const entry = (await listChain(a.ws)).find((e) => e.kind === 'security.workflow.client-stamped');
    expect(entry?.payload).toMatchObject({ workflowId: id, clientOrgId: a.orgA, actor: a.owner.userId });

    // A later save never clears the stamp.
    const def = (await a.owner.c.get<Record<string, unknown>>(`/workflows/${enc(id)}`)).body;
    expect((await a.owner.c.post(`${H}/workflows`, def)).status).toBeLessThan(300);
    expect((await getOwned(a.ws, id))?.clientOrgId, 'sticky across a save').toBe(a.orgA);
  });

  it('a sub-chain child holds no client content, and a child RUN inherits the parent run\'s client', async () => {
    const a = await agency();
    const secret = `B-CHILD-${n++}`;
    const made = await a.owner.c.post<{ workflowId: string; subChainWorkflowIds?: string[] }>(`${H}/workflows/from-chain`, {
      chainId: 'funnels.blueprint.lead-magnet', clientOrgId: a.orgB,
      params: { orgId: a.orgB, briefId: secret, campaignId: secret, formId: secret, name: secret },
    });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    const children = made.body.subChainWorkflowIds ?? [];
    expect(children.length, 'the chain co-registers its children').toBeGreaterThan(0);
    expect(JSON.stringify((await a.owner.c.get(`/workflows/${enc(made.body.workflowId)}`)).body), 'control: the PARENT froze the secret').toContain(secret);

    const memberA = await person();
    await a.place(memberA, a.ws, ['viewer']);
    await a.place(memberA, a.orgA, ['viewer']);
    await a.enter(memberA);
    expect((await memberA.c.get(`/workflows/${enc(made.body.workflowId)}`)).status).toBe(404);
    for (const child of children) {
      // Children are shared and unstamped, so they stay readable; what matters is
      // that they carry none of B's values (they expand with params: {}).
      const r = await memberA.c.get(`/workflows/${enc(child)}`);
      expect(JSON.stringify(r.body), `child ${child} carries none of B's values`).not.toContain(secret);
      expect((await getOwned(a.ws, child))?.clientOrgId).toBeUndefined();
    }
    // The values reach a child through its RUN, which inherits the client.
    const inherited = inheritedRunMetadata({ 'openwop-app.campaignOps': { orgId: a.orgB, approval: 'x' } });
    expect(inherited['openwop-app.campaignOps'], 'the org only, never execution authority').toEqual({ orgId: a.orgB });
  });
});
