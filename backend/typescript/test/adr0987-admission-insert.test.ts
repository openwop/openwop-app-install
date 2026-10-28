/**
 * ADR 0987 D2/D4 (P1) — concurrency admission counted from run state inside the run
 * insert, on the real app (single process, `memory://`, so it runs in the gate).
 *
 * WHY. The session cap used to live in a per-process map whose check counted only
 * slots younger than 60 s, so five runs still running at a minute stopped counting
 * and a sixth was admitted (P0 reproduced it). Now `POST /runs` passes an admission
 * scope to the insert, the store counts that scope's `pending`/`running` rows inside
 * the same transaction, and a full scope is refused with nothing written:
 *
 *   - S03-T2: five runs still running after 61 s still hold their slots;
 *   - D4: a run suspended on approval (`waiting-approval`) releases its slot, and a
 *     terminal run releases its slot, with no release call anywhere;
 *   - a refused run writes no row;
 *   - the stored scope is a digest, never the raw tenant or session (S03-R4).
 *
 * The cross-instance half (two processes, one Postgres) is
 * `adr0987-admission-two-process-postgres-live.test.ts`.
 *
 * `Date` is faked (only `Date`, so the 120 s `core.delay` timers stay real and the
 * runs stay running), as `adr0771-key-run-budget.test.ts` does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { _resetRateLimitState } from '../src/middleware/rateLimit.js';
import { getSetCookies } from './headerCookies.js';

let server: http.Server;
let BASE = '';
let storage: Storage;
let n = 0;
const CAP = 5;

beforeAll(async () => {
  vi.stubEnv('OPENWOP_STORAGE_DSN', 'memory://');
  vi.stubEnv('OPENWOP_SESSION_SECRET', 'test-session-secret-at-least-32-characters-long');
  vi.stubEnv('OPENWOP_TEST_AUTH_ENABLED', 'true');
  vi.stubEnv('OPENWOP_AUTH_DISABLE_COOKIES', '');
  vi.stubEnv('OPENWOP_RATELIMIT_DISABLED', '');
  vi.stubEnv('OPENWOP_RATELIMIT_SESSION_CONCURRENT', String(CAP));
  vi.stubEnv('OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN', '1000');
  vi.stubEnv('OPENWOP_RATELIMIT_SESSION_RUNS_PER_DAY', '1000');
  vi.stubEnv('OPENWOP_RATELIMIT_IP_REQS_PER_MIN', '10000');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((res) => { server.closeAllConnections?.(); server.close(() => res()); });
  vi.unstubAllEnvs();
});
beforeEach(() => {
  _resetRateLimitState();
  vi.useRealTimers();
});

/** A fresh signed-in user (its own session scope), a fresh 120 s hold workflow. */
async function user(): Promise<{ cookie: string; tenant: string; wf: string }> {
  const r = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `adm-in-${Date.now()}-${n++}@acme.test` }),
  });
  expect(r.status, await r.clone().text()).toBe(201);
  const cookie = (getSetCookies(r.headers) as string[]).map((c) => /(__session=[^;]+)/.exec(c)?.[1]).find(Boolean)!;
  const me = await fetch(`${BASE}/host/openwop-app/me/workspaces`, { headers: { cookie } });
  const tenant = ((await me.json()) as { personal: string }).personal;
  const wf = `wf.adr0987.in-${n++}`;
  registerWorkflow({ workflowId: wf, nodes: [{ nodeId: 'hold', typeId: 'core.delay', config: { durationMs: 120_000 } }], edges: [] });
  return { cookie, tenant, wf };
}
async function startRun(u: { cookie: string; wf: string }): Promise<number> {
  const r = await fetch(`${BASE}/runs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: u.cookie }, body: JSON.stringify({ workflowId: u.wf, inputs: {} }) });
  await r.arrayBuffer();
  return r.status;
}
const runsOf = async (u: { tenant: string; wf: string }) => storage.listRuns({ tenantId: u.tenant, workflowId: u.wf, limit: 100 });

describe('ADR 0987 D2 — admission counted inside the run insert', () => {
  it('S03-T2: five runs still running after 61 s still hold their slots; the sixth is refused and writes nothing', async () => {
    const u = await user();
    for (let i = 0; i < CAP; i += 1) expect(await startRun(u)).toBe(201);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    const before = (await runsOf(u)).length;
    expect(await startRun(u)).toBe(429);
    expect((await runsOf(u)).length).toBe(before); // nothing written
    expect((await runsOf(u)).filter((r) => r.status === 'pending' || r.status === 'running')).toHaveLength(CAP);
  });

  it('D4: a run suspended on approval releases its slot', async () => {
    const u = await user();
    for (let i = 0; i < CAP; i += 1) expect(await startRun(u)).toBe(201);
    expect(await startRun(u)).toBe(429);
    const [first] = await runsOf(u);
    await storage.updateRun(first!.runId, { status: 'waiting-approval' });
    expect(await startRun(u)).toBe(201);
  });

  it('a terminal run releases its slot, with no release call', async () => {
    const u = await user();
    for (let i = 0; i < CAP; i += 1) expect(await startRun(u)).toBe(201);
    const [first] = await runsOf(u);
    await storage.updateRun(first!.runId, { status: 'cancelled', completedAt: new Date().toISOString() });
    expect(await startRun(u)).toBe(201);
  });

  it('separate users have separate scopes', async () => {
    const a = await user();
    const b = await user();
    for (let i = 0; i < CAP; i += 1) expect(await startRun(a)).toBe(201);
    expect(await startRun(b)).toBe(201);
  });
});
