/**
 * ADR 1133 (issue #5970) — a run a private project is working on is read only by
 * people who may read that project, at every door that serves it:
 *  - `GET /runs/:id`, its event poll, and `GET /runs` lists;
 *  - the artifact library's `run-event:*` lane: the GET, its revision, and the list.
 *
 * Driven over HTTP in a shared workspace. The run is bound to the project the way
 * a project-fired schedule binds it (`metadata.schedule.ownerScope`), or through a
 * card on the project's board (`metadata.kanban.boardId`). Both are written straight
 * to the run row, as the scheduler and the kanban dispatcher do.
 *
 * Sabotage witness: with `runProjectReader` answering `true`, every
 * "non-member" assertion below goes red (recorded in ADR 1133).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { persistRunArtifact } from '../src/host/runArtifactStore.js';
import { invalidatePrivateProjects, privateProjectProbe, registerPrivateProjectProbe, runProjectReader } from '../src/host/runProjectAccess.js';

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
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

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
    patch: <T = unknown>(p: string, b?: unknown) => call<T>('PATCH', p, b),
  };
}
type Client = ReturnType<typeof client>;
const enc = encodeURIComponent;
const raw = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
const P = '/host/openwop-app/projects';
const A = '/host/openwop-app/artifacts';

async function signup(c: Client): Promise<string> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `prj-run-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId;
}

/** A shared workspace with a PRIVATE project, a member viewer and a non-member viewer. */
async function workspace() {
  const owner = client();
  await signup(owner);
  const ws = (await owner.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: `Studio-${n++}` })).body.workspaceId;
  expect((await owner.post(`/host/openwop-app/workspaces/${enc(ws)}/switch`)).status).toBe(200);
  const viewer = async (): Promise<{ c: Client; userId: string }> => {
    const c = client();
    const userId = await signup(c);
    expect((await owner.post(`/host/openwop-app/test/orgs/${enc(ws)}/members`, { displayName: 'V', subject: userId, roles: ['viewer'] })).status).toBe(201);
    expect((await c.post(`/host/openwop-app/workspaces/${enc(ws)}/switch`)).status).toBe(200);
    return { c, userId };
  };
  const created = await owner.post<{ id: string; boardId: string }>(P, { orgId: ws, name: 'Launch film' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const project = created.body;
  const member = await viewer();
  const outsider = await viewer();
  expect((await owner.post(`${P}/${project.id}/members`, { ref: `user:${member.userId}`, role: 'observer' })).status).toBe(201);
  expect((await owner.patch<{ visibility: string }>(`${P}/${project.id}/visibility`, { visibility: 'private' })).body.visibility).toBe('private');

  const wire = new Map<string, string>();
  /** Start a run as the owner and bind it with `binding` (raw metadata). */
  const run = async (binding?: Record<string, unknown>): Promise<string> => {
    const r = await owner.post<{ runId: string }>('/runs', { workflowId: 'conformance-noop', inputs: {} });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const id = raw(r.body.runId);
    wire.set(id, r.body.runId);
    if (binding) {
      const row = await storage.getRun(id);
      await storage.updateRun(id, { metadata: { ...(row?.metadata ?? {}), ...binding } });
    }
    return id;
  };
  const at = (id: string): string => enc(wire.get(id) ?? id);
  /** A delivered file artifact on `runId`, the shape the Library lists. */
  const deliver = async (runId: string): Promise<{ artifactId: string; revisionId: string }> => {
    const out = await persistRunArtifact({ tenantId: ws, runId, nodeId: 'deliver', role: 'deliverable', output: { images: [{ url: 'https://cdn.example.test/scene.png' }] }, now: new Date().toISOString() });
    expect(out).not.toBeNull();
    return out!;
  };
  const scheduled = { schedule: { ownerScope: `project:${project.id}` } };
  return { owner, ws, project, member: member.c, outsider: outsider.c, run, at, wire, deliver, scheduled };
}

const listedRuns = async (c: Client): Promise<Set<string>> => {
  const r = await c.get<{ runs: { runId: string }[] }>('/runs?limit=200');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return new Set(r.body.runs.map((x) => raw(x.runId)));
};
const listedArtifacts = async (c: Client): Promise<Set<string>> => {
  const r = await c.get<{ artifacts: { artifactId: string }[] }>(A);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return new Set(r.body.artifacts.map((x) => x.artifactId));
};

describe('ADR 1133 — a private project\'s runs are read by its people', () => {
  it('the run doors: a member reads and lists it; a non-member gets the absent 404 and no list entry', async () => {
    const w = await workspace();
    const bound = await w.run(w.scheduled);
    const plain = await w.run();

    expect((await w.member.get(`/runs/${w.at(bound)}`)).status, 'member').toBe(200);
    expect((await w.member.get(`/runs/${w.at(bound)}/events/poll`)).status, 'member poll').toBe(200);
    expect((await listedRuns(w.member)).has(bound)).toBe(true);

    const refused = await w.outsider.get<{ error?: string }>(`/runs/${w.at(bound)}`);
    expect(refused.status, 'non-member').toBe(404);
    expect((await w.outsider.get(`/runs/${w.at(bound)}/events/poll`)).status, 'non-member poll').toBe(404);
    const ids = await listedRuns(w.outsider);
    expect(ids.has(bound), 'not listed to a non-member').toBe(false);
    expect(ids.has(plain), 'a run with no project is unchanged').toBe(true);
    expect((await w.outsider.get(`/runs/${w.at(plain)}`)).status).toBe(200);

    // The same answer as a run that does not exist: no existence leak.
    const wid = w.wire.get(bound) ?? bound;
    const missing = await w.outsider.get<{ error?: string }>(`/runs/${enc(`${wid.slice(0, wid.lastIndexOf('/') + 1)}00000000-0000-4000-8000-000000000000`)}`);
    expect(refused.status).toBe(missing.status);
    expect(refused.body.error).toBe(missing.body.error);
  });

  it('the artifact lane: the GET, its revision and the Library list refuse a non-member, serve a member', async () => {
    const w = await workspace();
    const bound = await w.run(w.scheduled);
    const { artifactId, revisionId } = await w.deliver(bound);
    expect(artifactId.startsWith('run-event:')).toBe(true);

    expect((await w.member.get(`${A}/${enc(artifactId)}`)).status, 'member GET').toBe(200);
    expect((await w.member.get(`${A}/${enc(artifactId)}/revisions/${enc(revisionId)}`)).status, 'member revision').toBe(200);
    expect((await listedArtifacts(w.member)).has(artifactId)).toBe(true);

    const refused = await w.outsider.get<{ error?: string }>(`${A}/${enc(artifactId)}`);
    expect(refused.status, 'non-member GET').toBe(404);
    expect((await w.outsider.get(`${A}/${enc(artifactId)}/revisions/${enc(revisionId)}`)).status, 'non-member revision').toBe(404);
    expect((await w.outsider.get(`${A}/${enc(artifactId)}/revisions`)).status, 'non-member revisions').toBe(404);
    expect((await listedArtifacts(w.outsider)).has(artifactId), 'not listed to a non-member').toBe(false);
    const unknown = await w.outsider.get<{ error?: string }>(`${A}/${enc('run-event:no-such-run:deliver')}`);
    expect(refused.status).toBe(unknown.status);
    expect(refused.body.error).toBe(unknown.body.error);
  });

  it('a card run on the project\'s board is bound the same way', async () => {
    const w = await workspace();
    const bound = await w.run({ kanban: { boardId: w.project.boardId } });
    expect((await w.member.get(`/runs/${w.at(bound)}`)).status).toBe(200);
    expect((await w.outsider.get(`/runs/${w.at(bound)}`)).status).toBe(404);
  });

  it('a fork of a private-project run is refused to a non-member: the binding is derived, never stamped', async () => {
    const w = await workspace();
    const bound = await w.run(w.scheduled);
    const forked = await w.owner.post<{ runId: string }>(`/runs/${w.at(bound)}:fork`, { mode: 'branch', fromSeq: 0 });
    expect(forked.status, JSON.stringify(forked.body)).toBeLessThan(300);
    const forkId = forked.body.runId;
    expect((await w.member.get(`/runs/${enc(forkId)}`)).status, 'member reads the fork').toBe(200);
    expect((await w.outsider.get(`/runs/${enc(forkId)}`)).status, 'non-member: fork').toBe(404);
    expect((await w.outsider.get(`/runs/${enc(forkId)}/events/poll`)).status, 'non-member: fork events').toBe(404);
  });

  it('cost: a tenant with no private project refuses nothing, so no run or board is read', async () => {
    const w = await workspace();
    expect(await runProjectReader(w.ws, undefined).mayRefuse(), 'a private project exists').toBe(true);
    const other = client();
    await signup(other);
    const ws2 = (await other.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: `Open-${n++}` })).body.workspaceId;
    expect((await other.post(`/host/openwop-app/workspaces/${enc(ws2)}/switch`)).status).toBe(200);
    expect((await other.post(P, { orgId: ws2, name: 'Org-visible' })).status).toBe(201);
    const reader = runProjectReader(ws2, undefined);
    expect(await reader.mayRefuse(), 'no private project: nothing to refuse').toBe(false);
    // Even an anonymous caller and a dangling board id pass without a read.
    expect(await reader({ kanban: { boardId: 'no-such-board' } })).toBe(true);
  });

  it('cost: consecutive run reads share one probe call until the TTL or a visibility change', async () => {
    const w = await workspace();
    const bound = await w.run(w.scheduled);
    const real = privateProjectProbe();
    expect(real).not.toBeNull();
    let calls = 0;
    registerPrivateProjectProbe(async (t) => { calls++; return real ? real(t) : new Set(); });
    try {
      expect((await w.outsider.get(`/runs/${w.at(bound)}`)).status).toBe(404);
      expect((await w.outsider.get(`/runs/${w.at(bound)}/events/poll`)).status).toBe(404);
      expect((await w.member.get(`/runs/${w.at(bound)}`)).status).toBe(200);
      expect(calls, 'three requests, one probe call').toBe(1);
      // Making the project org-visible clears the cache in-process: the next read re-probes
      // and the run reads as unbound again.
      expect((await w.owner.patch(`${P}/${w.project.id}/visibility`, { visibility: 'org' })).status).toBe(200);
      expect((await w.outsider.get(`/runs/${w.at(bound)}`)).status).toBe(200);
      expect(calls).toBe(2);
      invalidatePrivateProjects(w.ws);
    } finally {
      if (real) registerPrivateProjectProbe(real);
    }
  });

  it('a failing probe fails closed: the full per-run check still refuses a non-member', async () => {
    const w = await workspace();
    const bound = await w.run(w.scheduled);
    const { artifactId } = await w.deliver(bound);
    const real = privateProjectProbe();
    registerPrivateProjectProbe(async () => { throw new Error('store unavailable'); });
    try {
      expect(await runProjectReader(w.ws, undefined).mayRefuse(), 'unknown is not "none"').toBe(true);
      expect((await w.outsider.get(`/runs/${w.at(bound)}`)).status).toBe(404);
      expect((await w.outsider.get(`${A}/${enc(artifactId)}`)).status).toBe(404);
      expect((await listedArtifacts(w.outsider)).has(artifactId)).toBe(false);
      expect((await w.member.get(`/runs/${w.at(bound)}`)).status, 'a member still reads it').toBe(200);
    } finally {
      if (real) registerPrivateProjectProbe(real);
    }
  });

  it('an empty `project:` scope binds nothing, even with the probe unknown', async () => {
    const w = await workspace();
    const run = await w.run({ schedule: { ownerScope: 'project:' } });
    expect((await w.outsider.get(`/runs/${w.at(run)}`)).status).toBe(200);
    // With the probe failing, every bound run takes the full check, so a run bound
    // to the empty id would be refused here. It must read as unbound.
    const real = privateProjectProbe();
    registerPrivateProjectProbe(async () => { throw new Error('store unavailable'); });
    try {
      expect((await w.outsider.get(`/runs/${w.at(run)}`)).status).toBe(200);
    } finally {
      if (real) registerPrivateProjectProbe(real);
    }
  });
});
