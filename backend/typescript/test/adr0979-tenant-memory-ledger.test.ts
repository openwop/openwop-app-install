/**
 * ADR 0979 (feature loop round 2, row 56) — the tenant memory ledger.
 *
 * D1: each row holds a slice of one run's OUTPUT, so it follows the run-payload
 * rule (#4543): a member sees the summaries of runs they started, an admin sees
 * all, a Viewer deletes nothing, an Editor deletes only their own, and a row the
 * caller may not see is a 404 (no existence oracle). The stored `owner` stamp is
 * host-internal and never served.
 * D2: a run whose output was fabricated (the mock-AI node, a `stub:true`
 * placeholder) writes no summary and no `memory.written`; a real run still does.
 *
 * P1–P3 were RED on `dfafc439b` (the round-2 baseline probes).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { writeMemoryEntry, MEMORY_DEMO_REF } from '../src/host/inMemorySurfaces.js';

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
  for (const id of ['users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
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
    del: <T = unknown>(p: string) => call<T>('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;
async function signup(c: Client): Promise<{ userId: string }> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `row56-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
async function sharedWorkspace(): Promise<{ owner: Client; join: (role: string) => Promise<Client>; ws: string }> {
  const owner = client();
  await signup(owner);
  const ws = (await owner.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: `Row56WS-${n++}` })).body.workspaceId;
  expect((await owner.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
  const join = async (role: string): Promise<Client> => {
    const c = client();
    const u = await signup(c);
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: role, subject: u.userId, roles: [role] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await c.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    return c;
  };
  return { owner, join, ws };
}
async function runAndSettle(c: Client, text: string, workflowId = 'openwop-app.uppercase'): Promise<string> {
  const r = await c.post<{ runId: string }>('/runs', { workflowId, inputs: { text, query: text } });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  for (let i = 0; i < 100; i++) {
    const s = await c.get<{ status?: string }>(`/runs/${encodeURIComponent(r.body.runId)}`);
    if (['completed', 'failed', 'cancelled'].includes(s.body?.status ?? '')) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const raw = r.body.runId.slice(r.body.runId.lastIndexOf('/') + 1);
  wireOf.set(raw, r.body.runId);
  return raw;
}
/** raw run id → the id the run routes take. */
const wireOf = new Map<string, string>();
interface MemEntry { id: string; content: string; tags: string[]; [k: string]: unknown }
interface MemList { entries: MemEntry[]; visibility?: string; canDelete?: boolean }
const summaryId = (runId: string): string => `runsummary:${runId}`;
const ids = (l: MemList): string[] => l.entries.map((e) => e.id);

describe('ADR 0979 D1 — the ledger follows the run-payload rule', () => {
  it('a Viewer does not read another member\'s run output (was RED: P1)', async () => {
    const { owner, join } = await sharedWorkspace();
    const viewer = await join('viewer');
    const runId = await runAndSettle(owner, 'owner private output row56');
    const ownList = await owner.get<MemList>('/host/openwop-app/memory');
    expect(ids(ownList.body), 'precondition: the run summary exists').toContain(summaryId(runId));
    const list = await viewer.get<MemList>('/host/openwop-app/memory');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('OWNER PRIVATE OUTPUT ROW56');
    expect(list.body.visibility).toBe('own-runs');
    expect(list.body.canDelete).toBe(false);
    const one = await viewer.get(`/host/openwop-app/memory/${encodeURIComponent(summaryId(runId))}`);
    expect(one.status, 'an invisible row is the same 404 as an absent one').toBe(404);
  });

  it('a Viewer cannot delete a ledger entry (was RED: P2)', async () => {
    const { owner, join } = await sharedWorkspace();
    const viewer = await join('viewer');
    const runId = await runAndSettle(owner, 'row56 delete target');
    const del = await viewer.del(`/host/openwop-app/memory/${encodeURIComponent(summaryId(runId))}`);
    expect(del.status).toBe(403);
    const missing = await viewer.del('/host/openwop-app/memory/runsummary:no-such-run');
    expect(missing.status, 'the scope refusal does not depend on the id').toBe(403);
    expect(ids((await owner.get<MemList>('/host/openwop-app/memory')).body)).toContain(summaryId(runId));
  });

  it('an Editor reads and deletes only their own runs\' summaries (was RED: P3)', async () => {
    const { owner, join } = await sharedWorkspace();
    const editor = await join('editor');
    const ownerRun = await runAndSettle(owner, 'row56 owner run');
    const editorRun = await runAndSettle(editor, 'row56 editor run');
    const list = await editor.get<MemList>('/host/openwop-app/memory');
    expect(list.body.visibility).toBe('own-runs');
    expect(list.body.canDelete).toBe(true);
    expect(ids(list.body)).toContain(summaryId(editorRun));
    expect(ids(list.body)).not.toContain(summaryId(ownerRun));
    const tagged = await editor.get<MemList>(`/host/openwop-app/memory?tag=${encodeURIComponent(`run-id:${editorRun}`)}`);
    expect(ids(tagged.body), 'the run panel\'s per-run query').toEqual([summaryId(editorRun)]);
    // The filter runs BEFORE the limit: a newer run the editor may not see must
    // not push their own row off a one-row page.
    await runAndSettle(owner, 'row56 owner newer run');
    const page = await editor.get<MemList>('/host/openwop-app/memory?limit=1');
    expect(ids(page.body)).toEqual([summaryId(editorRun)]);
    const other = await editor.del(`/host/openwop-app/memory/${encodeURIComponent(summaryId(ownerRun))}`);
    expect(other.status).toBe(404);
    expect(ids((await owner.get<MemList>('/host/openwop-app/memory')).body)).toContain(summaryId(ownerRun));
    const mine = await editor.del(`/host/openwop-app/memory/${encodeURIComponent(summaryId(editorRun))}`);
    expect(mine.status).toBe(200);
  });

  it('an Admin reads every member\'s summaries, and an UNSTAMPED (legacy) row is admins only in a shared workspace', async () => {
    const { owner, join, ws } = await sharedWorkspace();
    const admin = await join('admin');
    const editor = await join('editor');
    const editorRun = await runAndSettle(editor, 'row56 editor run for admin');
    await writeMemoryEntry(ws, MEMORY_DEMO_REF, { id: 'legacy-row56', content: 'legacy row with no owner', tags: ['run-summary'] });
    const adminList = await admin.get<MemList>('/host/openwop-app/memory');
    expect(adminList.body.visibility).toBe('all');
    expect(ids(adminList.body)).toEqual(expect.arrayContaining([summaryId(editorRun), 'legacy-row56']));
    expect(ids((await editor.get<MemList>('/host/openwop-app/memory')).body)).not.toContain('legacy-row56');
    expect(ids((await owner.get<MemList>('/host/openwop-app/memory')).body), 'the workspace owner is its admin').toContain('legacy-row56');
  });

  it('a workflow step\'s memory-write row is its run owner\'s, like a summary', async () => {
    registerWorkflow({ workflowId: 'adr0979.memory-write', metadata: { name: 'mw' }, nodes: [{ nodeId: 'w', typeId: 'local.openwop-app.memory-write', config: {} }], edges: [] });
    const { join } = await sharedWorkspace();
    const writer = await join('editor');
    const other = await join('editor');
    const runId = await runAndSettle(writer, 'row56 node note', 'adr0979.memory-write');
    const mine = (await writer.get<MemList>(`/host/openwop-app/memory?tag=${encodeURIComponent(`run-id:${runId}`)}`)).body;
    expect(mine.entries.some((e) => e.tags.includes('demo-write')), JSON.stringify(mine)).toBe(true);
    const theirs = (await other.get<MemList>(`/host/openwop-app/memory?tag=${encodeURIComponent(`run-id:${runId}`)}`)).body;
    expect(theirs.entries).toEqual([]);
  });

  it('the stored owner stamp is never served', async () => {
    const { owner } = await sharedWorkspace();
    const runId = await runAndSettle(owner, 'row56 projection');
    const list = await owner.get<MemList>('/host/openwop-app/memory');
    const row = list.body.entries.find((e) => e.id === summaryId(runId));
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('owner');
    const one = await owner.get<{ entry: MemEntry }>(`/host/openwop-app/memory/${encodeURIComponent(summaryId(runId))}`);
    expect(one.body.entry).not.toHaveProperty('owner');
  });

  it('in the caller\'s own personal workspace every row is theirs, unstamped legacy rows included', async () => {
    const c = client();
    await signup(c);
    const runId = await runAndSettle(c, 'row56 personal');
    // Every prod row predates the owner stamp (5,782 on 2026-10-25). In a personal
    // tenant its one owner must keep their history.
    const tenant = (await storage.getRun(runId))?.tenantId;
    expect(tenant, 'precondition: the run names its tenant').toBeTruthy();
    await writeMemoryEntry(tenant!, MEMORY_DEMO_REF, { id: 'legacy-personal-row56', content: 'pre-stamp history', tags: ['run-summary'] });
    const list = await c.get<MemList>('/host/openwop-app/memory');
    expect(list.body.visibility).toBe('all');
    expect(list.body.canDelete).toBe(true);
    expect(ids(list.body)).toEqual(expect.arrayContaining([summaryId(runId), 'legacy-personal-row56']));
  });
});

describe('ADR 0979 D2 — fabricated output writes no summary', () => {
  registerWorkflow({ workflowId: 'adr0979.mock', metadata: { name: 'mock' }, nodes: [{ nodeId: 'm', typeId: 'local.sample.demo.mock-ai' }], edges: [] });
  registerWorkflow({ workflowId: 'adr0979.stub-search', metadata: { name: 'stub' }, nodes: [{ nodeId: 's', typeId: 'core.web.search' }], edges: [] });

  for (const wf of ['adr0979.mock', 'adr0979.stub-search']) {
    it(`${wf}: no row and no memory.written; a real run still writes both`, async () => {
      const c = client();
      await signup(c);
      const fake = await runAndSettle(c, 'row56 fabricated', wf);
      const real = await runAndSettle(c, 'row56 real');
      const fakeRun = await c.get<{ status?: string }>(`/runs/${encodeURIComponent(wireOf.get(fake)!)}`);
      expect(fakeRun.body.status, `precondition: the fabricated run COMPLETED: ${JSON.stringify(fakeRun.body).slice(0, 600)}`).toBe('completed');
      const body = (await c.get<MemList>('/host/openwop-app/memory')).body;
      const list = ids(body);
      expect(list).toContain(summaryId(real));
      expect(list, JSON.stringify(body.entries.find((e) => e.id === summaryId(fake)))).not.toContain(summaryId(fake));
      const ev = await c.get<{ events: Array<{ type: string }> }>(`/runs/${encodeURIComponent(wireOf.get(fake)!)}/events/poll?limit=1000`);
      expect(ev.status).toBe(200);
      expect(ev.body.events.map((e) => e.type)).toContain('run.completed');
      expect(ev.body.events.map((e) => e.type)).not.toContain('memory.written');
      const realEv = await c.get<{ events: Array<{ type: string }> }>(`/runs/${encodeURIComponent(wireOf.get(real)!)}/events/poll?limit=1000`);
      expect(realEv.body.events.map((e) => e.type)).toContain('memory.written');
    });
  }
});
