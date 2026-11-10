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
 *   - a refused run writes no row (held by the insert transaction: the count and the
 *     insert are one SQLite write transaction, so a refusal rolls the row back).
 *
 * CORRECTED 2026-11-03 (grade-tests wave 78, TST-EPA-1): this header also listed "the
 * stored scope is a digest, never the raw tenant or session (S03-R4)". No case here
 * asserts it, and no gate-lane test does: `Storage` exposes no reader for
 * `admission_key`. The digest is computed in `middleware/rateLimit.ts`
 * `setRunAdmission`; the gap is a grade-code row, not a claim of this file.
 *
 * Every refusal is asserted as the concurrency 429 (`details.reason:
 * 'session_concurrent'`), not as any 429.
 *
 * The cross-instance half (two processes, one Postgres) is
 * `adr0987-admission-two-process-postgres-live.test.ts`.
 *
 * `Date` is faked (only `Date`, so the 120 s `core.delay` timers stay real and the
 * runs stay running), as `adr0771-key-run-budget.test.ts` does.
 *
 * Sabotage-witnessed (wave 78): the count check `>=` turned `>` reds S03-T2 and D4;
 * `waiting-approval` added to the holding states reds D4; `cancelled` added reds the
 * terminal case; one constant scope key for every session reds "separate users".
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
/** A run start the store refuses for concurrency: the rate-limit 429 naming the
 *  session-concurrency limiter (not the per-minute or per-day window). */
async function expectConcurrencyRefusal(u: { cookie: string; wf: string }): Promise<void> {
  const r = await fetch(`${BASE}/runs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: u.cookie }, body: JSON.stringify({ workflowId: u.wf, inputs: {} }) });
  const body = (await r.json()) as { error?: string; details?: { reason?: string } };
  expect(r.status).toBe(429);
  expect(body).toMatchObject({ error: 'rate_limited', details: { reason: 'session_concurrent' } });
}
const runsOf = async (u: { tenant: string; wf: string }) => storage.listRuns({ tenantId: u.tenant, workflowId: u.wf, limit: 100 });

describe('ADR 0987 D2 — admission counted inside the run insert', () => {
  it('S03-T2: five runs still running after 61 s still hold their slots; the sixth is refused and writes nothing', async () => {
    const u = await user();
    for (let i = 0; i < CAP; i += 1) expect(await startRun(u)).toBe(201);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    const before = (await runsOf(u)).length;
    await expectConcurrencyRefusal(u);
    expect((await runsOf(u)).length).toBe(before); // nothing written
    expect((await runsOf(u)).filter((r) => r.status === 'pending' || r.status === 'running')).toHaveLength(CAP);
  });

  it('D4: a run suspended on approval releases its slot', async () => {
    const u = await user();
    for (let i = 0; i < CAP; i += 1) expect(await startRun(u)).toBe(201);
    await expectConcurrencyRefusal(u);
    const [first] = await runsOf(u);
    await storage.updateRun(first!.runId, { status: 'waiting-approval' });
    expect(await startRun(u)).toBe(201);
  });

  it('a terminal run releases its slot, with no release call', async () => {
    const u = await user();
    for (let i = 0; i < CAP; i += 1) expect(await startRun(u)).toBe(201);
    await expectConcurrencyRefusal(u); // the scope is full before the release
    const [first] = await runsOf(u);
    await storage.updateRun(first!.runId, { status: 'cancelled', completedAt: new Date().toISOString() });
    expect(await startRun(u)).toBe(201);
  });

  it('separate users have separate scopes', async () => {
    const a = await user();
    const b = await user();
    for (let i = 0; i < CAP; i += 1) expect(await startRun(a)).toBe(201);
    await expectConcurrencyRefusal(a); // A is at its cap...
    expect(await startRun(b)).toBe(201); // ...and B's scope is its own
  });
});
