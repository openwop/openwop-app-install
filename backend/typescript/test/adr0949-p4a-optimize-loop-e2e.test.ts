/**
 * ADR 0949 P4a — WF-EXP-1: the optimize-loop chain end to end through the REAL
 * executor, then a real `:fork` that allocates nothing.
 *
 * The replay-safety claim of the Optimize loop rests on one property: the epoch
 * number comes from the run's frozen start instant (`run.metadata
 * ['openwop-app.experiments'].asOf`), and a `:fork` copies that stamp verbatim,
 * so the forked node finds its epoch already appended. The unit tests prove the
 * service half; this witnesses the whole path: `from-chain` instantiation, the
 * run-start contributor's stamp, the node pack calling the surface, the
 * executor, and the fork route.
 *
 * The fork runs three hours after its source (the wall clock is moved; only
 * `Date` is faked), so by the clock the next epoch is due: only the frozen
 * instant keeps the fork from allocating.
 *
 * Sabotage (run 2026-10-20): the run-start contributor stamping a fresh instant
 * on a derived run (ignoring `derivedFromRun`) makes the fork append a second
 * epoch and reds the fork assertions. Without the clock move it did not: a fork
 * inside the same epoch window is `too_soon` either way, which is why the clock
 * moves.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registerExperimentSurface } from '../src/host/experiments/adapters.js';
import { getExperimentRow, mutateExperimentRow, putExperimentRow } from '../src/host/experiments/store.js';
import { createDraft, launch } from '../src/features/experiments/experimentsService.js';
import { EXPERIMENTS_RUN_KEY } from '../src/host/experiments/runFreeze.js';
import type { Storage } from '../src/storage/storage.js';
import { bareRunId } from './support/bareRunId.js';

let BASE = '';
let server: http.Server;
let storage: Storage;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // Users is permanent infrastructure; only Experiments declares a toggle.
  for (const id of ['experiments']) {
    const d = getToggleDefault(id);
    if (!d) throw new Error(`Missing test prerequisite toggle: ${id}`);
    await saveConfig({ ...d, status: 'on' }, 'test');
  }
  // A surface whose observations are fixed, so the epoch's weights are known to move.
  const units: Array<{ arm: string; firstExposureAt: string; converted: boolean }> = [];
  for (let i = 0; i < 300; i++) for (const [arm, rate] of [['a', 0.05], ['b', 0.2]] as const) units.push({ arm, firstExposureAt: '2026-10-01T01:00:00.000Z', converted: i < 300 * rate });
  registerExperimentSurface({
    kind: 'test.optimize-e2e',
    validateTarget: async () => undefined,
    launch: async (e) => (await mutateExperimentRow(e.tenantId, e.orgId, e.experimentId, (c) => ({ ...c, status: 'running', startedAt: '2026-10-01T00:00:00.000Z' })))!,
    stop: async (e) => e,
    observe: async () => ({ units, coverage: 'complete', sourceRetainedSince: null }),
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface JsonResponse<T> { status: number; body: T }
interface TestClient { call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<JsonResponse<T>> }
function client(): TestClient {
  let cookie = '';
  return {
    call: async <T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<JsonResponse<T>> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
      const decoded: unknown = await res.json().catch(() => undefined);
      return { status: res.status, body: decoded as T };
    },
  };
}

/** Honest ceiling: a bounded poll on the real condition, not a fixed sleep. */
async function waitTerminal(runId: string): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const run = await storage.getRun(bareRunId(runId));
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) return run.status;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('ADR 0949 P4a — WF-EXP-1: optimize-loop through the real executor, then a real :fork', () => {
  it('the run appends exactly one epoch; its fork finds it existing and allocates nothing', async () => {
    const tenantId = `org:p4e2e-${Date.now()}-${n++}`;
    const c = client();
    expect((await c.call('POST', '/host/openwop-app/test/login', { email: `p4e2e-${n++}@acme.test`, tenantId })).status).toBe(201);
    const createdOrg = await c.call<{ orgId: string }>('POST', '/host/openwop-app/orgs', { name: 'Client' });
    expect(createdOrg.status, JSON.stringify(createdOrg.body)).toBe(201);
    const orgId = createdOrg.body.orgId;
    expect(orgId).toEqual(expect.any(String));
    const d = await createDraft(tenantId, orgId, 'u', {
      name: 'Hero', surface: { kind: 'test.optimize-e2e', ref: 'r' }, mode: 'optimize',
      arms: [{ key: 'a', ref: null, weight: 50 }, { key: 'b', ref: 'v2', weight: 50 }],
      optimize: { rewardMetric: { kind: 'conversion', name: 'signup' }, floorPct: 10, epochMinutes: 60 },
    });
    await launch(tenantId, orgId, d.experimentId, 'u');
    const row = (await getExperimentRow(tenantId, orgId, d.experimentId))!;
    // Launched weeks ago, so the next epoch is due for a run starting now.
    await putExperimentRow({ ...row, epochs: [{ ...row.epochs[0]!, at: '2026-10-01T00:00:00.000Z' }] });

    const wf = await c.call<{ workflowId: string }>('POST', '/host/openwop-app/workflows/from-chain', { chainId: 'experiments.optimize-loop', params: { orgId, experimentId: d.experimentId } });
    expect(wf.status, JSON.stringify(wf.body)).toBe(201);
    const workflowId: string = wf.body.workflowId;

    const started = await c.call<{ runId: string }>('POST', '/runs', { workflowId });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const runId: string = started.body.runId;
    expect(await waitTerminal(runId)).toBe('completed');
    const source = (await storage.getRun(bareRunId(runId)))!;
    const asOf = (source.metadata as Record<string, { asOf?: string }>)[EXPERIMENTS_RUN_KEY]?.asOf;
    expect(asOf).toMatch(/^\d{4}-/);
    const afterRun = (await getExperimentRow(tenantId, orgId, d.experimentId))!;
    expect(afterRun.epochs).toHaveLength(2);
    expect(afterRun.epochs[1]).toMatchObject({ reason: 'optimize' });
    expect(bareRunId(afterRun.epochs[1]!.decidedByRunId ?? '')).toBe(bareRunId(runId));
    expect(afterRun.epochs[1]!.weights.b).toBeGreaterThan(afterRun.epochs[1]!.weights.a!);

    // The fork happens three hours later: the next epoch would be due by the
    // wall clock, so only the frozen instant keeps the fork from allocating.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(asOf!) + 3 * 3_600_000);
    let forkId: string;
    try {
      const forked = await c.call<{ runId: string }>('POST', `/runs/${encodeURIComponent(runId)}:fork`, { mode: 'branch', fromSeq: 0 });
      expect(forked.status, JSON.stringify(forked.body)).toBe(201);
      forkId = forked.body.runId;
      expect(forkId).toEqual(expect.any(String));
      expect(forkId).not.toBe(runId);
      expect(await waitTerminal(forkId)).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
    const fork = (await storage.getRun(bareRunId(forkId)!))!;
    // The fork RE-EXECUTED the node (branch mode, from the start): its output is
    // the surface's `existing` at the source's frozen instant, not a copy of the
    // source's `appended`.
    const forkEvents = JSON.stringify(await storage.listEvents(bareRunId(forkId!), { fromSeq: -1, limit: 10_000 }));
    expect(forkEvents).toContain('"outcome":"existing"');
    expect(forkEvents).not.toContain('"outcome":"appended"');
    // The fork carries the source's frozen instant verbatim…
    expect((fork.metadata as Record<string, { asOf?: string }>)[EXPERIMENTS_RUN_KEY]?.asOf).toBe(asOf);
    // …so it finds the epoch already appended: zero new allocations.
    const afterFork = (await getExperimentRow(tenantId, orgId, d.experimentId))!;
    expect(afterFork.epochs).toEqual(afterRun.epochs);
    expect(afterFork.updatedAt).toBe(afterRun.updatedAt);
  });
});
