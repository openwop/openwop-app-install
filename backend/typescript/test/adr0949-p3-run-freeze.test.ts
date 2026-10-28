/**
 * ADR 0949 P3 — run-based units are assigned at the run's frozen instant.
 *
 *   1. A run created with `experiments` ON carries
 *      `metadata['openwop-app.experiments'].asOf`; OFF, nothing. A caller cannot
 *      supply it (reserved key).
 *   2. THE P3 EXIT: a `:fork` after an epoch change reuses the source's weights.
 *      Over the real `/runs/:id:fork` route the fork carries the source's
 *      instant, and `ctx.features.experiments.assign` in the fork gives every
 *      contact the arm the source gave, while a fresh run uses the new epoch.
 *   3. Only an experiment that was assigning at the run's instant assigns: a
 *      fork taken after a stop still assigns as its source did (code-review).
 *
 * Sabotage (run 2026-10-20): stamping on a derived run reds the born-OFF fork
 * case (a stamped source is protected by the copy-wins merge on its own);
 * dropping the reserved key reds 1's caller case; ignoring the epoch's `at`
 * reds 2's fresh-run leg.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { putExperimentRow } from '../src/host/experiments/store.js';
import { assignAt, epochAt, readExperimentsRunStamp } from '../src/host/experiments/runFreeze.js';
import type { Experiment } from '../src/host/experiments/types.js';
import { buildExperimentsSurface } from '../src/features/experiments/surface.js';
import { bareRunId } from './support/bareRunId.js';

let server: http.Server;
let storage: Storage;
let BASE = '';
let workflowId = '';

const setToggle = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('experiments');
  if (d) await saveConfig({ ...d, status }, 'test');
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const disco = await api<{ fixtures?: string[] }>('/.well-known/openwop');
  workflowId = disco.body.fixtures?.[0] ?? 'openwop-app.uppercase';
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', ...((init.headers as Record<string, string>) ?? {}) } });
  return { status: res.status, body: (res.status === 204 ? undefined : await res.json()) as T };
}
async function createRun(metadata?: Record<string, unknown>): Promise<string> {
  const r = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: {}, ...(metadata ? { metadata } : {}) }) });
  expect(r.status).toBe(201);
  return r.body.runId;
}
async function forkRun(src: string): Promise<string> {
  const f = await api<{ runId: string }>(`/runs/${src}:fork`, { method: 'POST', body: JSON.stringify({ fromSeq: 0, mode: 'replay' }) });
  expect(f.status).toBe(201);
  return f.body.runId;
}
const runOf = async (runId: string) => (await storage.getRun(bareRunId(runId)))!;

function experiment(tenantId: string, epochs: Experiment['epochs'], status: Experiment['status'] = 'running'): Experiment {
  return {
    experimentId: `exp:p3-${Math.random().toString(36).slice(2)}`, tenantId, orgId: tenantId, name: 'Journey split', hypothesis: '',
    surface: { kind: 'journey.split', ref: 'j1' }, unit: 'contact', design: { type: 'ab' },
    arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: 'v2', weight: 50 }],
    mode: 'decide', status, salt: 'salt-p3', epochs, createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('ADR 0949 P3 — the run stamp', () => {
  it('is stamped when experiments is ON, absent when OFF, and a caller cannot supply it', async () => {
    await setToggle('off');
    expect(readExperimentsRunStamp((await runOf(await createRun())).metadata)).toBeNull();
    await setToggle('on');
    const stamped = readExperimentsRunStamp((await runOf(await createRun())).metadata);
    expect(stamped?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const forged = readExperimentsRunStamp((await runOf(await createRun({ 'openwop-app.experiments': { asOf: '2000-01-01T00:00:00.000Z' } }))).metadata);
    expect(forged?.asOf).not.toBe('2000-01-01T00:00:00.000Z');
  });
});

describe('ADR 0949 P3 — absence is inherited too (ADR 0604)', () => {
  it('a run born with experiments OFF is not stamped when forked after it turns ON', async () => {
    await setToggle('off');
    const src = await createRun();
    expect(readExperimentsRunStamp((await runOf(src)).metadata)).toBeNull();
    await setToggle('on');
    expect(readExperimentsRunStamp((await runOf(await createRun())).metadata)).not.toBeNull(); // the toggle really is on
    expect(readExperimentsRunStamp((await runOf(await forkRun(src))).metadata)).toBeNull();
  });
});

describe('ADR 0949 P3 — a fork after an epoch change reuses the source\'s weights (the P3 exit)', () => {
  it('over the real :fork route, every contact gets the source\'s arm; a fresh run uses the new epoch', async () => {
    await setToggle('on');
    const src = await createRun();
    const srcRun = await runOf(src);
    const asOf = readExperimentsRunStamp(srcRun.metadata)!.asOf;
    const tenantId = srcRun.tenantId;
    // Launched before the source run; an Optimize epoch moves the weights AFTER it started.
    const later = new Date(Date.parse(asOf) + 60_000).toISOString();
    const exp = experiment(tenantId, [
      { epoch: 0, weights: { control: 50, b: 50 }, at: '2026-01-01T00:00:00.000Z', reason: 'launch' },
      { epoch: 1, weights: { control: 5, b: 95 }, at: later, reason: 'optimize' },
    ]);
    await putExperimentRow(exp);

    const fork = await forkRun(src);
    expect(readExperimentsRunStamp((await runOf(fork)).metadata)?.asOf).toBe(asOf);

    const inSource = buildExperimentsSurface({ tenantId, runId: bareRunId(src) });
    const inFork = buildExperimentsSurface({ tenantId, runId: bareRunId(fork) });
    const contacts = Array.from({ length: 400 }, (_, i) => `contact-${i}`);
    const armsOf = async (s: ReturnType<typeof buildExperimentsSurface>) =>
      Promise.all(contacts.map(async (c) => (await s.assign({ orgId: tenantId, experimentId: exp.experimentId, unitKey: c }) as { arm: string; epoch: number })));
    const a = await armsOf(inSource);
    const b = await armsOf(inFork);
    expect(b.map((x) => x.arm)).toEqual(a.map((x) => x.arm));
    expect(new Set(b.map((x) => x.epoch))).toEqual(new Set([0]));

    // A fresh run after the epoch change is assigned at the NEW weights.
    const fresh = Array.from({ length: 400 }, (_, i) => assignAt(exp, `contact-${i}`, new Date(Date.parse(later) + 1).toISOString()));
    expect(new Set(fresh.map((x) => x?.epoch))).toEqual(new Set([1]));
    expect(fresh.filter((x) => x?.arm.key === 'b').length).toBeGreaterThan(340); // ≈95%
    expect(a.filter((x) => x.arm === 'b').length).toBeLessThan(260); // ≈50%
  });
});

describe('ADR 0949 P3 — assignment rules (pure)', () => {
  it('picks the latest epoch at or before the instant, falls back to launch, and only a running experiment assigns', () => {
    const exp = experiment('t', [
      { epoch: 0, weights: { control: 50, b: 50 }, at: '2026-02-01T00:00:00.000Z', reason: 'launch' },
      { epoch: 1, weights: { control: 20, b: 80 }, at: '2026-03-01T00:00:00.000Z', reason: 'ramp' },
    ]);
    expect(epochAt(exp, '2026-02-15T00:00:00.000Z')?.epoch).toBe(0);
    expect(epochAt(exp, '2026-03-02T00:00:00.000Z')?.epoch).toBe(1);
    expect(epochAt(exp, '2026-01-01T00:00:00.000Z')?.epoch).toBe(0);
    // Stopped BEFORE the run began: never assigns. Stopped AFTER it began (a fork
    // taken after the stop): assigns exactly as while running.
    const ran = { ...exp, startedAt: '2026-02-01T00:00:00.000Z' };
    expect(assignAt({ ...ran, status: 'stopped', stoppedAt: '2026-03-01T12:00:00.000Z' }, 'c1', '2026-03-02T00:00:00.000Z')).toBeNull();
    expect(assignAt({ ...ran, status: 'stopped', stoppedAt: '2026-03-05T00:00:00.000Z' }, 'c1', '2026-03-02T00:00:00.000Z')).toEqual(assignAt(ran, 'c1', '2026-03-02T00:00:00.000Z'));
    expect(assignAt({ ...exp, status: 'draft' }, 'c1', '2026-03-02T00:00:00.000Z')).toBeNull();
    expect(assignAt({ ...exp, epochs: [] }, 'c1', '2026-03-02T00:00:00.000Z')).toBeNull();
    expect(assignAt(exp, 'c1', '2026-03-02T00:00:00.000Z')).toEqual(assignAt(exp, 'c1', '2026-03-02T00:00:00.000Z'));
  });
});

describe('ADR 0949 P3 — guardrail metrics', () => {
  it('a guardrail is accepted only on a metric the surface counts, and a bad-direction effect halts with guardrail_breach', async () => {
    const { registerExperimentSurface } = await import('../src/host/experiments/adapters.js');
    const { createDraft, launch, lockPlan, results } = await import('../src/features/experiments/experimentsService.js');
    const { getExperimentRow, mutateExperimentRow } = await import('../src/host/experiments/store.js');
    const units: Array<{ arm: string; firstExposureAt: string; converted: boolean; metrics: Record<string, 0 | 1> }> = [];
    registerExperimentSurface({
      kind: 'test.contact', supportedMetrics: ['unsubscribe'],
      validateTarget: async () => undefined,
      launch: async (e) => (await mutateExperimentRow(e.tenantId, e.orgId, e.experimentId, (c) => ({ ...c, status: 'running', startedAt: '2026-10-01T00:00:00.000Z' })))!,
      stop: async (e) => e,
      observe: async () => ({ units, coverage: 'complete', sourceRetainedSince: null }),
    });
    const tenantId = `t-p3g-${Date.now()}`;
    const plan = { primaryMetric: { kind: 'conversion', name: 'click' }, baselineRate: 0.1, mde: 0.02, alpha: 0.05, power: 0.8, fdrQ: 0.05, minDays: 7, maxDays: 30 };
    const arms = [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: 'v2', weight: 50 }];
    const draft = await createDraft(tenantId, tenantId, 'u', { name: 'Subject line', surface: { kind: 'test.contact', ref: 'c1' }, arms });
    await expect(lockPlan(tenantId, tenantId, draft.experimentId, { ...plan, guardrails: [{ metric: { kind: 'rate', name: 'complaint' }, direction: 'up_is_bad', niMargin: 0.002 }] }))
      .rejects.toMatchObject({ details: { reason: 'unsupported_metric', metrics: ['complaint'] } });
    await lockPlan(tenantId, tenantId, draft.experimentId, { ...plan, guardrails: [{ metric: { kind: 'rate', name: 'unsubscribe' }, direction: 'up_is_bad', niMargin: 0.002 }] });
    await launch(tenantId, tenantId, draft.experimentId, 'u');
    expect((await getExperimentRow(tenantId, tenantId, draft.experimentId))?.status).toBe('running');
    for (let i = 0; i < 4000; i++) {
      units.push({ arm: 'control', firstExposureAt: '2026-10-02T00:00:00.000Z', converted: i < 400, metrics: { unsubscribe: i < 20 ? 1 : 0 } });
      units.push({ arm: 'b', firstExposureAt: '2026-10-02T00:00:00.000Z', converted: i < 420, metrics: { unsubscribe: i < 200 ? 1 : 0 } });
    }
    const r = await results(tenantId, tenantId, draft.experimentId, '2026-10-03T00:00:00.000Z') as { verdict: unknown };
    expect(r.verdict).toEqual({ kind: 'guardrail_breach', metric: 'unsubscribe', arm: 'b' });
    // A healthy guardrail does not halt: equal unsubscribe rates read as running (before the gates).
    for (const u of units) if (u.arm === 'b') u.metrics.unsubscribe = units.indexOf(u) < 40 ? 1 : 0;
    expect(((await results(tenantId, tenantId, draft.experimentId, '2026-10-03T00:00:00.000Z')) as { verdict: { kind: string } }).verdict.kind).toBe('running');
  });
});
