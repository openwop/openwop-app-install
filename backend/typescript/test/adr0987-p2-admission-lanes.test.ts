/**
 * ADR 0987 D3 (P2) — every run-creating lane passes one admission, at the one insert
 * seam (`host/runInsert.ts` `insertRunWithStartContext`), and an exemption is
 * written in the code rather than left as an omission. S03-T4, the lane matrix.
 *
 * WHY. Before P2 the three run limits had three different owners. The monthly plan
 * was charged by `startWorkflowRun` directly and by a `withRunLimit` wrapper at ten
 * other sites, the concurrency cap lived in a per-process map that only the six
 * middleware routes reserved into, and creative-briefs reserved a slot it never
 * had. A new lane could skip all of it by calling the insert seam plainly.
 *
 * Pins:
 *   1. THE RATCHET: every `insertRunWithStartContext(` call in `src/**` passes
 *      `admission:`, and the table below says what each lane passes. A new caller,
 *      a dropped scope or a changed exemption reason fails here until classified.
 *   2. The seam charges the plan: a charged insert takes one unit, an exempt one
 *      takes none even at the limit, and an insert that throws (a duplicate id, a
 *      full concurrency scope) gives its unit back. A refusal writes no row.
 *   3. An HTTP lane other than `POST /runs` (`:fork`) is refused at the session's
 *      concurrency cap by the store, and admitted once a held run finishes.
 *
 * Out of reach here, held elsewhere: a lane that bypasses the seam with a bare
 * `storage.insertRun(` is invisible to this ratchet (it scans `insertRunWithStartContext(`
 * only). `test/run-metadata-copy-sites.test.ts` classifies every file that calls `.insertRun(`,
 * so a new FILE with a bare insert is refused there (a second bare call inside an already
 * classified file is not, by either test).
 *
 * Sabotage-witnessed: red when a lane drops `admission:`, a lane's scope is dropped
 * (`chargedAdmission()` in place of `chargedAdmission(runAdmissionFor(req))`), the
 * seam stops charging, an exempt policy is charged, the release on a throw is
 * removed, or the fork lane stops passing its scope.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openStorage } from '../src/storage/index.js';
import { AdmissionRefusedError, type Storage } from '../src/storage/storage.js';
import { chargedAdmission, insertRunWithStartContext } from '../src/host/runInsert.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerPlanLimitsResolver } from '../src/host/planLimitsSeam.js';
import { planRunsThisMonth } from '../src/host/planRunLimit.js';
import { billingPlanLimitsResolver } from '../src/features/billing/feature.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import type { RunRecord } from '../src/types.js';
import { createApp } from '../src/index.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { _resetRateLimitState } from '../src/middleware/rateLimit.js';
import { getSetCookies } from './headerCookies.js';
import { stripComments } from './helpers/stripComments.js';

const SRC = join(import.meta.dirname, '..', 'src');

/**
 * What each lane passes. `scope` = the plan unit plus the HTTP caller's
 * concurrency scope (`chargedAdmission(runAdmissionFor(req))`, or a route-computed
 * scope handed down); `charge` = the plan unit with no caller scope; `exempt:<r>` =
 * no plan unit, for the reason named in the code.
 */
const LANES: Record<string, string[]> = {
  'executor/subWorkflowDispatcher.ts': ['charge'], // Q1: a child counts, inside its parent's slot
  'features/channel-ingress/ingress.ts': ['charge'], // ADR 1042 D7: a channel message opens the owner's conversation run, charged like chat
  'features/creative-briefs/routes.ts': ['scope'],
  'features/workflow-author/routes.ts': ['scope'],
  'host/canvasSurface.ts': ['charge'], // Q1: a cross-canvas child
  'host/evals/createEvalRun.ts': ['scope'], // POST /runs {mode:"eval"}, scope from the route
  'host/kanbanTriggerDelivery.ts': ['charge'],
  'host/mcpSemantics.ts': ['charge'],
  'host/runStarter.ts': ['charge'], // schedules, heartbeats, chat, agent tools, approvals, webhooks
  'host/triggerIngestionService.ts': ['charge'],
  'host/workflowEvalRunner.ts': ['exempt:eval-case'],
  'host/workforceService.ts': ['exempt:historical-record'],
  'routes/artifactTypeSeam.ts': ['exempt:conformance-seam'],
  'routes/compensationSeam.ts': ['exempt:conformance-seam', 'exempt:conformance-seam'],
  'routes/durabilitySeam.ts': ['exempt:conformance-seam'],
  'routes/effectSeamFireSeam.ts': ['exempt:conformance-seam'],
  'routes/runs.ts': ['scope', 'scope'], // POST /runs and :fork
  'routes/triggerBridge.ts': ['exempt:conformance-seam'],
  'routes/workflowDebug.ts': ['scope', 'scope'], // debug run and redrive
};

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p);
  }
  return out;
}


/** The argument text of each `insertRunWithStartContext(` call (balanced parens). */
function callArgs(src: string): string[] {
  const out: string[] = [];
  const re = /\binsertRunWithStartContext\s*\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (/export async function\s*$/.test(src.slice(Math.max(0, m.index - 30), m.index))) continue;
    let depth = 1; let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i += 1) {
      if ('([{'.includes(src[i]!)) depth += 1;
      else if (')]}'.includes(src[i]!)) depth -= 1;
    }
    out.push(src.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

function classify(args: string): string {
  if (/admission:\s*chargedAdmission\(\s*(runAdmissionFor\(req\)|input\.admission)\s*\)/.test(args)) return 'scope';
  if (/admission:\s*chargedAdmission\(\s*\)/.test(args)) return 'charge';
  const ex = /admission:\s*\{\s*plan:\s*'(exempt:[a-z0-9-]+)'\s*\}/.exec(args);
  if (ex) return ex[1]!;
  return /admission:/.test(args) ? 'unclassified' : 'MISSING';
}

describe('ADR 0987 D3 — the lane ratchet (S03-T4)', () => {
  const found: Record<string, string[]> = {};
  for (const file of tsFiles(SRC)) {
    const calls = callArgs(stripComments(readFileSync(file, 'utf8')));
    if (calls.length > 0) found[relative(SRC, file)] = calls.map(classify);
  }
  delete found['host/runInsert.ts'];

  it('every insertRunWithStartContext call passes an admission, and each lane passes what the table says', () => {
    expect(found).toEqual(LANES);
  });

  it('a lane that does not charge names a reason', () => {
    for (const policies of Object.values(found)) {
      for (const p of policies) expect(p === 'scope' || p === 'charge' || /^exempt:[a-z0-9-]+$/.test(p), p).toBe(true);
    }
  });
});

describe('ADR 0987 D3 — the seam charges the monthly plan', () => {
  let storage: Storage;
  const run = (runId: string, tenantId: string): RunRecord => {
    const now = new Date().toISOString();
    return { runId, workflowId: 'wf', tenantId, status: 'running', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
  };

  beforeEach(async () => {
    storage = await openStorage('memory://');
    initHostExtPersistence(storage);
    registerToggleDefault({ id: 'billing', label: 'Billing', description: 'b', status: 'on', bucketUnit: 'tenant', salt: 'billing' });
    registerPlanLimitsResolver(billingPlanLimitsResolver);
    process.env.OPENWOP_BILLING_PLAN_LIMITS = JSON.stringify({ free: { workflowRuns: 2 } });
  });
  afterEach(() => {
    registerPlanLimitsResolver(null);
    delete process.env.OPENWOP_BILLING_PLAN_LIMITS;
    __resetHostExtPersistence();
  });

  it('a charged insert takes one unit; at the limit it is a typed 429 and writes no row', async () => {
    await insertRunWithStartContext(storage, run('c1', 't-c'), { admission: chargedAdmission() });
    await insertRunWithStartContext(storage, run('c2', 't-c'), { admission: chargedAdmission() });
    expect(await planRunsThisMonth('t-c')).toBe(2);
    await expect(insertRunWithStartContext(storage, run('c3', 't-c'), { admission: chargedAdmission() }))
      .rejects.toMatchObject({ httpStatus: 429, details: { reason: 'plan_run_limit_reached' } });
    expect(await storage.getRun('c3')).toBeNull();
    expect(await planRunsThisMonth('t-c')).toBe(2);
  });

  it('an exempt insert takes no unit, even at the limit', async () => {
    for (const id of ['e1', 'e2', 'e3']) await insertRunWithStartContext(storage, run(id, 't-e'), { admission: { plan: 'exempt:eval-case' } });
    expect(await planRunsThisMonth('t-e')).toBe(0);
    expect(await storage.getRun('e3')).not.toBeNull();
  });

  it('an insert that throws gives its unit back: a duplicate id, and a full concurrency scope', async () => {
    await insertRunWithStartContext(storage, run('d1', 't-d'), { admission: chargedAdmission() });
    // The duplicate-row refusal itself (sqlite's primary key), not any error: a plan 429
    // or a TypeError would also throw, and the release would then be untested.
    await expect(insertRunWithStartContext(storage, run('d1', 't-d'), { admission: chargedAdmission() }))
      .rejects.toThrow(/UNIQUE constraint failed: runs\.run_id/);
    expect(await planRunsThisMonth('t-d')).toBe(1);

    const scope = { key: 'scope-digest-d', cap: 1 };
    process.env.OPENWOP_BILLING_PLAN_LIMITS = JSON.stringify({ free: { workflowRuns: 10 } });
    await insertRunWithStartContext(storage, run('s1', 't-s'), { admission: chargedAdmission(scope) });
    await expect(insertRunWithStartContext(storage, run('s2', 't-s'), { admission: chargedAdmission(scope) }))
      .rejects.toBeInstanceOf(AdmissionRefusedError);
    expect(await storage.getRun('s2')).toBeNull();
    expect(await planRunsThisMonth('t-s')).toBe(1);
  });
});

describe('ADR 0987 D3 — an HTTP lane besides POST /runs hits the store-counted cap', () => {
  const CAP = 2;
  let server: http.Server;
  let BASE = '';
  let storage: Storage;

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
    await new Promise<void>((res) => { server.closeAllConnections?.(); server.close(() => res()); });
    vi.unstubAllEnvs();
  });
  beforeEach(() => _resetRateLimitState());

  it(':fork is refused session_concurrent at the cap, writes nothing, and is admitted once a held run finishes', async () => {
    const login = await fetch(`${BASE}/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `adm-lanes-${Date.now()}@acme.test` }),
    });
    expect(login.status, await login.clone().text()).toBe(201);
    const cookie = (getSetCookies(login.headers) as string[]).map((c) => /(__session=[^;]+)/.exec(c)?.[1]).find(Boolean)!;
    const wf = `wf.adr0987.lanes-${Date.now()}`;
    registerWorkflow({ workflowId: wf, nodes: [{ nodeId: 'hold', typeId: 'core.delay', config: { durationMs: 120_000 } }], edges: [] });
    const H = { 'content-type': 'application/json', cookie };

    const ids: string[] = [];
    for (let i = 0; i < CAP; i += 1) {
      const r = await fetch(`${BASE}/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId: wf, inputs: {} }) });
      expect(r.status).toBe(201);
      ids.push(((await r.json()) as { runId: string }).runId);
    }
    const fork = () => fetch(`${BASE}/runs/${encodeURIComponent(ids[0]!)}:fork`, { method: 'POST', headers: H, body: JSON.stringify({ mode: 'branch', fromSeq: 0 }) });
    const tenant = (await storage.getRun(ids[0]!.includes('/') ? ids[0]!.slice(ids[0]!.indexOf('/') + 1) : ids[0]!))!.tenantId;
    const before = (await storage.listRuns({ tenantId: tenant, limit: 100 })).length;

    const refused = await fork();
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { details?: { reason?: string } }).details?.reason).toBe('session_concurrent');
    expect((await storage.listRuns({ tenantId: tenant, limit: 100 })).length).toBe(before);

    const bare = ids[1]!.includes('/') ? ids[1]!.slice(ids[1]!.indexOf('/') + 1) : ids[1]!;
    await storage.updateRun(bare, { status: 'cancelled', completedAt: new Date().toISOString() });
    const admitted = await fork();
    expect(admitted.status, await admitted.clone().text()).toBe(201);
  });
});
