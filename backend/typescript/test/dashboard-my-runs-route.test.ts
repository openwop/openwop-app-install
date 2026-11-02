/**
 * Issue #4511 — `GET /host/openwop-app/dashboard/my-runs`, the read the
 * member-tier home tiles (Needs you, Get started) use instead of the
 * workspace-wide `GET /runs`.
 *
 * In a SHARED workspace a member sees only the runs THEY started, each as a
 * five-field row — never another member's run, and never a run's inputs,
 * variables or configurable. In the caller's own personal workspace every run
 * is theirs. Driven over HTTP: the ownership rule is only meaningful against
 * the owner stamp the real run-create path writes.
 *
 * TST-CUB-3. DOUBLE GUARD (recorded): another member's run is dropped twice — by
 * the store's owner predicate (`listRunSummaries({ owner })`) and by the
 * `isRunOwnedBy` re-check in `listOwnRuns`. The HTTP case is red when the route
 * scans the whole tenant (both guards off); the unit re-check case is red when the
 * re-check alone is skipped. Also red when a row carries more than the five fields,
 * when `truncated` ignores an exhausted scan, when `limit=0` is accepted, or when
 * the scan budget is not `limit` (personal) / 1000 (shared).
 *
 * CEILING: the route's `Math.min(limit, 100)` clamp is not witnessed (it needs >100
 * runs); only the malformed-limit refusals are.
 * CEILING: over HTTP every run is owner-stamped at creation, so the personal-
 * workspace case cannot tell "whole tenant" from "owner-filtered"; the unstamped
 * host-fired row that separates them is the unit case `keeps only the subject's…`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { listOwnRuns } from '../src/features/dashboard/ownRuns.js';
import { openStorage } from '../src/storage/index.js';
import { opaquePrincipal } from '../src/host/runOwner.js';
import type { RunRecord } from '../src/types.js';
import type { OwnRunRow } from '../src/features/dashboard/ownRuns.js';

let server: http.Server;
let BASE = '';
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface MyRunsBody { runs: OwnRunRow[]; truncated: boolean }
interface ErrorBody { error: string; message: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}
type Client = ReturnType<typeof client>;
async function signup(c: Client): Promise<{ userId: string }> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `myruns-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
async function startRun(c: Client, marker: string): Promise<string> {
  const r = await c.post<{ runId: string }>('/runs', { workflowId: 'conformance-noop', inputs: { marker } });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return raw(r.body.runId);
}
const FIVE = ['completedAt', 'runId', 'startedAt', 'status', 'workflowId'];
/** The create response carries the tenant-bound wire id (`<binding>/<runId>`);
 *  host-extension rows carry the raw id, as the SPA's `unbindRunIds` does. */
const raw = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
const MY_RUNS = '/host/openwop-app/dashboard/my-runs';

describe('#4511 — dashboard my-runs (HTTP)', () => {
  it('in a shared workspace, each member sees only their own runs, slim', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: 'MyRunsWS' })).body.workspaceId;
    expect((await owner.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    const member = client();
    const m = await signup(member);
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'M', subject: m.userId, roles: ['editor'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await member.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);

    const ownerRun = await startRun(owner, 'owner-secret-input');
    const memberRun = await startRun(member, 'member-input');

    // The workspace list (what the tiles used to read) holds both.
    const all = await member.get<{ runs: Array<{ runId: string }> }>('/runs?limit=100');
    expect(all.status).toBe(200);
    const allIds = all.body.runs.map((r) => raw(r.runId));
    expect(allIds).toEqual(expect.arrayContaining([ownerRun, memberRun]));

    const mine = await member.get<MyRunsBody>(MY_RUNS);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.runs.map((r) => r.runId)).toEqual([memberRun]);
    expect(mine.body.truncated).toBe(false);
    // Five fields, nothing else — the full snapshot never rides this read
    // (`completedAt` only once the run has finished).
    for (const row of mine.body.runs) {
      expect(Object.keys(row).sort(), JSON.stringify(row)).toEqual(FIVE.filter((k) => k !== 'completedAt' || 'completedAt' in row));
      expect(row.workflowId).toBe('conformance-noop');
    }
    expect(JSON.stringify(mine.body)).not.toContain('owner-secret-input');

    const ownerMine = await owner.get<MyRunsBody>(MY_RUNS);
    expect(ownerMine.body.runs.map((r) => r.runId)).toEqual([ownerRun]);
  });

  it('in the personal workspace every run is the caller\'s', async () => {
    const c = client();
    await signup(c);
    const a = await startRun(c, 'a');
    const b = await startRun(c, 'b');
    const mine = await c.get<MyRunsBody>(MY_RUNS);
    expect(mine.status).toBe(200);
    expect(new Set(mine.body.runs.map((r) => r.runId))).toEqual(new Set([a, b]));
  });

  it('an anonymous caller gets an empty list, not a throw (ADR 0839)', async () => {
    const anon = client();
    const r = await anon.get<MyRunsBody>(MY_RUNS);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ runs: [], truncated: false });
  });

  it('rejects a malformed limit and accepts a large one', async () => {
    // CEILING: the clamp to OWN_RUNS_MAX (100) is not observable here — it only
    // shows with more than 100 runs, and the route's store is not reachable to spy on.
    const c = client();
    await signup(c);
    for (const bad of ['0', 'abc', '-3', '1.5']) {
      const r = await c.get<ErrorBody>(`${MY_RUNS}?limit=${bad}`);
      expect(r.status, bad).toBe(400);
      expect(r.body.error).toBe('validation_error');
      expect(r.body.message).toMatch(/limit/);
    }
    const one = await c.get<MyRunsBody>(`${MY_RUNS}?limit=1`);
    expect(one.status).toBe(200);
    expect((await c.get<MyRunsBody>(`${MY_RUNS}?limit=5000`)).status).toBe(200);
  });
});

describe('#4511 — listOwnRuns (bounded scan)', () => {
  const T = 'ws:own-runs-unit';
  const stamp = (subject: string) => ({ owner: { principal: opaquePrincipal(subject), principalKind: 'user', subject: { issuer: 'urn:openwop-app:session', subjectId: opaquePrincipal(subject), lane: 'api-key', kind: 'user' } } });
  const run = (i: number, md: Record<string, unknown>): RunRecord => {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    return { runId: `r-${String(i).padStart(5, '0')}`, workflowId: 'wf', tenantId: T, status: 'completed', inputs: { secret: i }, metadata: md, configurable: {}, createdAt: at, updatedAt: at };
  };
  afterEach(() => { vi.restoreAllMocks(); });

  it('keeps only the subject\'s stamped (and legacy actingUserId) runs, newest first', async () => {
    const storage = await openStorage('memory://');
    await storage.insertRun(run(1, stamp('user:alice')));
    await storage.insertRun(run(2, stamp('user:bob')));
    await storage.insertRun(run(3, { actingUserId: 'user:alice' })); // pre-stamp legacy run
    await storage.insertRun(run(4, {})); // host-fired, no owner
    const out = await listOwnRuns(storage, { tenantId: T, subject: 'user:alice', wholeTenant: false, limit: 100 });
    expect(out.runs.map((r) => r.runId)).toEqual(['r-00003', 'r-00001']);
    expect(out.truncated).toBe(false);
    const whole = await listOwnRuns(storage, { tenantId: T, subject: 'user:alice', wholeTenant: true, limit: 100 });
    expect(whole.runs).toHaveLength(4);
  });

  it('#4531 — one bounded store read: `limit` rows in the personal workspace, 1000 in a shared one, never listRuns', async () => {
    const storage = await openStorage('memory://');
    for (let i = 1; i <= 1100; i += 1) await storage.insertRun(run(i, stamp('user:bob')));
    const fullRows = vi.spyOn(storage, 'listRuns').mockRejectedValue(new Error('my-runs must not read full rows'));
    const summaries = vi.spyOn(storage, 'listRunSummaries');
    await listOwnRuns(storage, { tenantId: T, subject: 'user:alice', wholeTenant: true, limit: 100 });
    expect(summaries.mock.calls.map((c) => c[0])).toEqual([{ tenantId: T, scanCap: 100, limit: 101 }]);
    summaries.mockClear();
    await listOwnRuns(storage, { tenantId: T, subject: 'user:alice', wholeTenant: false, limit: 100 });
    expect(summaries.mock.calls.map((c) => c[0])).toEqual([{ tenantId: T, owner: { principal: opaquePrincipal('user:alice'), subject: 'user:alice' }, scanCap: 1000, limit: 101 }]);
    expect(fullRows).not.toHaveBeenCalled();
  });

  it('#4531 — the store predicate is re-checked: a superset match that runOwner rejects is dropped', async () => {
    const storage = await openStorage('memory://');
    // A stamp naming bob, but an actingUserId of alice: the SQL superset matches it,
    // runOwner (stamp first) says bob.
    await storage.insertRun(run(1, { ...stamp('user:bob'), actingUserId: 'user:alice' }));
    const out = await listOwnRuns(storage, { tenantId: T, subject: 'user:alice', wholeTenant: false, limit: 100 });
    expect(out.runs).toEqual([]);
  });

  it('says truncated when the window fills or the scan budget runs out', async () => {
    const storage = await openStorage('memory://');
    // 1100 runs by someone else, then (older) one of alice's: past the 1000-row budget.
    await storage.insertRun(run(0, stamp('user:alice')));
    for (let i = 1; i <= 1100; i += 1) await storage.insertRun(run(i, stamp('user:bob')));
    const capped = await listOwnRuns(storage, { tenantId: T, subject: 'user:alice', wholeTenant: false, limit: 100 });
    expect(capped.runs).toEqual([]);
    expect(capped.truncated).toBe(true);
    const full = await listOwnRuns(storage, { tenantId: T, subject: 'user:bob', wholeTenant: false, limit: 3 });
    expect(full.runs).toHaveLength(3);
    expect(full.truncated).toBe(true);
  });
});
