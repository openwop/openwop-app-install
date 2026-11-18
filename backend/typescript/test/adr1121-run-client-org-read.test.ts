/**
 * ADR 1121 (#5929 item 1) — a run FOR a client is read only by people who may
 * read that client.
 *
 * `runs:read` is a union across a subject's org memberships, so a member of
 * client org A held it tenant-wide, and the run reads and `GET /runs` checked
 * only the scope and the tenant. A's members could list and open B's runs.
 *
 * Driven over HTTP in a shared workspace with two client orgs, on both
 * contracts. The client stamp is written straight to the run row, because
 * `CAMPAIGN_ATTRIBUTION_KEYS` strips it from caller metadata: only feature
 * services stamp it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { seedShowcaseWorkforces } from '../src/host/workforceService.js';

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
  for (const id of ['users', 'evals']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  await seedShowcaseWorkforces(storage, 1_750_000_000_000); // registers the workforce catalog the dashboards read
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = unknown> { status: number; body: T }
interface RunList { runs: { runId: string }[] }
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
    post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b),
    del: <T = unknown>(p: string) => call<T>('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;
async function signup(c: Client): Promise<{ userId: string }> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `client-run-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const raw = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
const V2 = { 'OpenWOP-Version': '2' };
const OPS = 'openwop-app.campaignOps';
const enc = encodeURIComponent;
/** Raw run id → the id `POST /runs` answered with, which the HTTP paths take. */
const wire = new Map<string, string>();
const at = (id: string): string => enc(wire.get(id) ?? id);

/** A shared workspace with two client orgs. `join` adds a person at the root
 *  with `rootRole`, and in each named client org as a viewer. */
async function agency() {
  const owner = client();
  await signup(owner);
  const ws = (await owner.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: `Agency-${n++}` })).body.workspaceId;
  expect((await owner.post(`/host/openwop-app/workspaces/${enc(ws)}/switch`)).status).toBe(200);
  const org = async (name: string): Promise<string> => {
    const r = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.orgId;
  };
  const orgA = await org('Client A');
  const orgB = await org('Client B');
  const join = async (rootRole: string, clients: string[], clientRole = 'viewer'): Promise<Client> => {
    const c = client();
    const u = await signup(c);
    for (const [orgId, roles] of [[ws, [rootRole]], ...clients.map((o) => [o, [clientRole]] as const)] as const) {
      const add = await owner.post(`/host/openwop-app/test/orgs/${enc(orgId)}/members`, { displayName: 'P', subject: u.userId, roles });
      expect(add.status, JSON.stringify(add.body)).toBe(201);
    }
    expect((await c.post(`/host/openwop-app/workspaces/${enc(ws)}/switch`)).status).toBe(200);
    return c;
  };
  /** Start a run as the owner and stamp it for `stamp` (a client org, or raw metadata). */
  const run = async (stamp?: string | Record<string, unknown>): Promise<string> => {
    const r = await owner.post<{ runId: string }>('/runs', { workflowId: 'conformance-noop', inputs: {} });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const id = raw(r.body.runId);
    wire.set(id, r.body.runId);
    if (stamp !== undefined) {
      const row = await storage.getRun(id);
      await storage.updateRun(id, { metadata: { ...(row?.metadata ?? {}), ...(typeof stamp === 'string' ? { [OPS]: { orgId: stamp } } : stamp) } });
    }
    return id;
  };
  return { owner, ws, orgA, orgB, join, run };
}

const listed = async (c: Client, h?: Record<string, string>): Promise<Set<string>> => {
  const r = await c.get<RunList>('/runs?limit=200', h);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return new Set(r.body.runs.map((x) => raw(x.runId)));
};

describe('ADR 1121 — a client\'s runs are read by that client\'s people', () => {
  it('a member of client A opens and lists A\'s run and the unstamped run, never B\'s, on both contracts', async () => {
    const a = await agency();
    const memberA = await a.join('viewer', [a.orgA]);
    const runA = await a.run(a.orgA);
    const runB = await a.run(a.orgB);
    const plain = await a.run();

    for (const h of [undefined, V2]) {
      expect((await memberA.get(`/runs/${at(runA)}`, h)).status, 'own client').toBe(200);
      expect((await memberA.get(`/runs/${at(plain)}`, h)).status, 'no client: unchanged').toBe(200);
      const other = await memberA.get<{ error?: string }>(`/runs/${at(runB)}`, h);
      expect(other.status, 'another client\'s run reads as absent').toBe(404);
      const ids = await listed(memberA, h);
      expect(ids.has(runA)).toBe(true);
      expect(ids.has(plain)).toBe(true);
      expect(ids.has(runB), 'another client\'s run is not listed').toBe(false);
    }
    // Same answer as a run that does not exist: no existence leak.
    const wB = wire.get(runB) ?? runB;
    const absent = `${wB.slice(0, wB.lastIndexOf('/') + 1)}00000000-0000-4000-8000-000000000000`;
    const missing = await memberA.get<{ error?: string }>(`/runs/${enc(absent)}`);
    const foreign = await memberA.get<{ error?: string }>(`/runs/${at(runB)}`);
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body.error).toBe(missing.body.error);
  });

  it('the event poll, :diff and DELETE refuse another client\'s run as absent', async () => {
    const a = await agency();
    const editorA = await a.join('editor', [a.orgA], 'editor');
    const runA = await a.run(a.orgA);
    const runB = await a.run(a.orgB);
    expect((await editorA.get(`/runs/${at(runA)}/events/poll`)).status).toBe(200);
    expect((await editorA.get(`/runs/${at(runB)}/events/poll`)).status).toBe(404);
    expect((await editorA.get(`/runs/${at(runA)}:diff?against=${at(runB)}`)).status).toBe(404);
    expect((await editorA.del(`/runs/${at(runB)}`)).status).toBe(404);
    expect(await storage.getRun(runB), 'the refused delete removed nothing').not.toBeNull();
  });

  it('a workspace admin who belongs to no client reads every client\'s runs', async () => {
    const a = await agency();
    const admin = await a.join('admin', []);
    const runA = await a.run(a.orgA);
    const runB = await a.run(a.orgB);
    for (const h of [undefined, V2]) {
      expect((await admin.get(`/runs/${at(runA)}`, h)).status).toBe(200);
      expect((await admin.get(`/runs/${at(runB)}`, h)).status).toBe(200);
      const ids = await listed(admin, h);
      expect(ids.has(runA) && ids.has(runB)).toBe(true);
    }
  });

  it('a root viewer who belongs to no client sees none of its runs', async () => {
    const a = await agency();
    const rootOnly = await a.join('viewer', []);
    const runA = await a.run(a.orgA);
    expect((await rootOnly.get(`/runs/${at(runA)}`)).status).toBe(404);
    expect((await listed(rootOnly)).has(runA)).toBe(false);
  });

  it('a stamp that disagrees with itself fails closed for members, and admins still read it', async () => {
    const a = await agency();
    const memberA = await a.join('viewer', [a.orgA]);
    const admin = await a.join('admin', []);
    const split = await a.run({ [OPS]: { orgId: a.orgA }, campaignOrchestration: { orgId: a.orgB } });
    expect((await memberA.get(`/runs/${at(split)}`)).status).toBe(404);
    expect((await listed(memberA)).has(split)).toBe(false);
    expect((await admin.get(`/runs/${at(split)}`)).status).toBe(200);
  });

  it('residue: the workforce trace search finds only runs whose client the caller may read', async () => {
    const HERO = 'workforce.finance.invoice-exception';
    const a = await agency();
    const memberA = await a.join('viewer', [a.orgA]);
    const admin = await a.join('admin', []);
    const runA = await a.run({ [OPS]: { orgId: a.orgA }, workforceId: HERO, correlationId: 'corr-1121-a' });
    const runB = await a.run({ [OPS]: { orgId: a.orgB }, workforceId: HERO, correlationId: 'corr-1121-b' });
    const trace = async (c: Client, q: string) => {
      const r = await c.get<{ matches: { runId: string }[]; scanned: number }>(`/host/openwop-app/workforces/${HERO}/trace?q=${q}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    };
    expect((await trace(memberA, 'corr-1121-a')).matches.map((m) => raw(m.runId))).toEqual([runA]);
    expect((await trace(memberA, 'corr-1121-b')).matches, 'another client\'s run is not searchable').toEqual([]);
    expect((await trace(memberA, 'corr-1121')).scanned, 'nor counted').toBe(1);
    expect((await trace(admin, 'corr-1121-b')).matches.map((m) => raw(m.runId))).toEqual([runB]);
  });

  it('residue: an eval run\'s progress is read only by its client\'s people', async () => {
    const a = await agency();
    const memberA = await a.join('viewer', [a.orgA]);
    const evalMeta = { kind: 'agent-suite', suiteRef: 'suite-1121', agentId: 'agent-1121' };
    const runA = await a.run({ [OPS]: { orgId: a.orgA }, eval: evalMeta });
    const runB = await a.run({ [OPS]: { orgId: a.orgB }, eval: evalMeta });
    const progress = (id: string) => memberA.get<{ runId?: string }>(`/host/openwop-app/agent-evals/runs/${at(id)}/progress`);
    const own = await progress(runA);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect((await progress(runB)).status, 'another client\'s eval run reads as absent').toBe(404);
  });
});
