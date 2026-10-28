/**
 * ADR 0950 P2 — the `experiments.promote` chain end to end, through the REAL
 * loader, starter, executor, node pack and surface.
 *
 *   1. THE P2 EXIT (happy path): a fixture winner passes all eight gates, the
 *      policy gate asks for one approval (an unbound run is `legacy`), and the
 *      winner ramps 50 → 90 → 98 with a 2% holdout, each stage rechecked on its
 *      own units, monitored, then finalized; the decision log reads
 *      ramp, ramp, ramp, finalize. A replay fork of the finished run applies
 *      nothing new.
 *   2. THE P2 EXIT (breach): a guardrail breach at stage 2 rolls back: every
 *      unit back on control and status `rolled_back`; stage 3 never applies.
 *   3. The chokepoint: only the claimed promotion run may ramp, finalize or roll
 *      back; a second start is `promotion_in_progress`; failing gates refuse to
 *      start (`gate_failed`).
 *   4. The route: the sub-toggle gates it (parent ON, sub OFF → refused), a viewer
 *      is refused, another org is the same 404.
 *
 * Sabotage (run 2026-10-20): dropping `assertPromotionRun` reds 3; recheck
 * against the LAUNCH weights (not the stage's) reds 1 with a spurious SRM
 * breach; ignoring the breach edge (always ramp) reds 2.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registerExperimentSurface } from '../src/host/experiments/adapters.js';
import { getExperimentRow, putExperimentRow } from '../src/host/experiments/store.js';
import type { UnitObservation } from '../src/host/experiments/rollup.js';
import type { Experiment } from '../src/host/experiments/types.js';
import { listChain } from '../src/host/auditChainService.js';
import { resolveAndResume, timerResumeContinuation, __awaitRunResumeChainForTests } from '../src/routes/interrupts.js';
import { sweepDueTimers, timerDeadlineMs } from '../src/executor/timerResume.js';
import { PROMOTE_CHAIN_ID, startPromotion } from '../src/features/experiments/promotionService.js';
import { getChainBackedWorkflow } from '../src/host/chainBackedWorkflows.js';
import { recordRevision } from '../src/host/workflowRevisions.js';
import { recordOwnership, removeOwnership } from '../src/host/workflowOwnership.js';
import { buildExperimentsSurface } from '../src/features/experiments/surface.js';
import { startWorkflowRun } from '../src/host/runStarter.js';
import { bareRunId } from './support/bareRunId.js';
import { toWireRunId } from '../src/host/v2Ids.js';
import { observeExperiment } from '../src/host/experiments/observe.js';
import { readExperimentRollup, totalsByArm } from '../src/host/experiments/rollup.js';
import { evaluateStageCheck } from '../src/host/experiments/stageCheck.js';
import { checkPromotionAdmission, checkPromotionGates } from '../src/host/experiments/promotion.js';
import { applyRamp as applyPromotionRamp, claimPromotionRun, finalize as finalizePromotion, PROMOTION_START_GRACE_MS, releasePromotionRun, rollback as rollbackPromotion } from '../src/host/experiments/promote.js';

let BASE = '';
let server: http.Server;
let storage: Storage;
let hostSuite: HostAdapterSuite;
let n = 0;

const DAY = 86_400_000;
/** What the fixture surface reports, per experiment. */
const scenario = new Map<string, { breachAtStage?: number; underpoweredAtStage?: number }>();
const shipped: Array<{ experimentId: string; winner: string }> = [];
const restored: string[] = [];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_EXPERIMENTS_MIN_STAGE_MS = '0';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'experiments', 'experiments.auto-promote']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  registerExperimentSurface({
    kind: 'test.promote',
    supportedMetrics: ['unsubscribe'],
    validateTarget: async () => undefined,
    launch: async (e) => e,
    stop: async (e) => e,
    checkPromotable: async () => ({ ok: true }),
    finalize: async (e, winner) => { shipped.push({ experimentId: e.experimentId, winner }); return { baselineRef: 'baseline-v1' }; },
    restoreBaseline: async (e) => { restored.push(e.experimentId); },
    observe: async (e) => ({ units: unitsFor(e), coverage: 'complete', sourceRetainedSince: null }),
  });
});
afterAll(async () => { delete process.env.OPENWOP_EXPERIMENTS_MIN_STAGE_MS; await new Promise<void>((res) => server.close(() => res())); });

/** 28 days of history (control 10%, b 14%), plus today's cohort split by the
 *  latest ramp stage's weights. A breach scenario gives b unsubscribes at its stage. */
function unitsFor(e: Experiment): UnitObservation[] {
  const out: UnitObservation[] = [];
  const start = Date.parse(e.startedAt!);
  for (let d = 0; d < 28; d++) {
    const at = new Date(start + d * DAY + 3_600_000).toISOString();
    for (const [arm, rate] of [['control', 0.1], ['b', 0.14]] as const) {
      for (let i = 0; i < 150; i++) out.push({ arm, firstExposureAt: at, converted: i < 150 * rate, metrics: { unsubscribe: 0 } });
    }
  }
  const stage = [...e.epochs].reverse().find((x) => x.reason === 'ramp');
  if (stage) {
    const today = stage.at; // Frozen fixture exposures are within the observation as-of bound.
    const breach = scenario.get(e.experimentId)?.breachAtStage === stage.stage;
    const stageUnits = scenario.get(e.experimentId)?.underpoweredAtStage === stage.stage ? 40 : 4000;
    for (const [arm, w] of Object.entries(stage.weights)) {
      const k = Math.round(stageUnits * (w / 100));
      for (let i = 0; i < k; i++) {
        out.push({ arm, firstExposureAt: today, converted: i < k * (arm === 'b' ? 0.14 : 0.1), metrics: { unsubscribe: breach && arm === 'b' && i < k * 0.3 ? 1 : 0 } });
      }
    }
  }
  return out;
}

const PLAN = {
  primaryMetric: { kind: 'conversion', name: 'signup' }, guardrails: [{ metric: { kind: 'conversion', name: 'unsubscribe' }, direction: 'up_is_bad' as const, niMargin: 0.02 }],
  baselineRate: 0.1, mde: 0.02, alpha: 0.05, power: 0.8, fdrQ: 0.05, minDays: 7, maxDays: 60, minSamplePerArm: 200, lockedAt: '2026-01-01T00:00:00.000Z', planHash: 'p'.repeat(64),
};

async function experiment(tenantId: string, orgId: string, over: Partial<Experiment> = {}): Promise<Experiment> {
  const started = new Date(Date.now() - 29 * DAY).toISOString();
  const e: Experiment = {
    experimentId: `exp:p2-${n++}-${Math.random().toString(36).slice(2, 8)}`, tenantId, orgId, name: 'Hero', hypothesis: '',
    surface: { kind: 'test.promote', ref: 'r' }, unit: 'visitor', design: { type: 'ab' },
    arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: 'v2', weight: 50 }], mode: 'decide', status: 'running', salt: 's',
    plan: PLAN as Experiment['plan'], epochs: [{ epoch: 0, weights: { control: 50, b: 50 }, at: started, reason: 'launch' }],
    createdBy: 'u', createdAt: started, updatedAt: started, startedAt: started, ...over,
  };
  await putExperimentRow(e);
  return e;
}

// `any`: the JSON wire boundary of a test-only HTTP helper (the adr0832 probe precedent).
function client(): { call: (method: string, p: string, b?: unknown) => Promise<{ status: number; body: any }> } {
  let cookie = '';
  return {
    call: async (method, path, body) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
      return { status: res.status, body: await res.json().catch(() => undefined) };
    },
  };
}
async function workspace() {
  const tenantId = `org:p2-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId: string = (await owner.call('POST', '/host/openwop-app/test/login', { email: `p2-o-${n++}@acme.test`, tenantId })).body.user.userId;
  const orgId: string = (await owner.call('POST', '/host/openwop-app/orgs', { name: 'Client' })).body.orgId;
  return { tenantId, orgId, owner, ownerId };
}

/** Bounded poll on the real condition, not a fixed sleep. */
async function until<T>(read: () => Promise<T | null | undefined | false>, label: string): Promise<T> {
  for (let i = 0; i < 600; i++) {
    const v = await read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out: ${label}`);
}
const settled = (runId: string) => until(async () => {
  // The portable loader freezes non-prompt config at expansion, so these are
  // the real 24-hour waits, regardless of run inputs. Advance only the timer
  // sweep's explicit clock to this run's frozen deadline; production stage-age
  // checks use the existing NODE_ENV=test floor above. No wall-clock sleep or
  // alternate executor/continuation is needed.
  const open = await storage.listOpenInterrupts(bareRunId(runId));
  const deadline = Math.max(Date.now(), ...open.map(timerDeadlineMs).filter((value): value is number => value !== null));
  await sweepDueTimers(storage, timerResumeContinuation(storage, hostSuite), deadline);
  await __awaitRunResumeChainForTests(bareRunId(runId));
  const r = await storage.getRun(bareRunId(runId));
  return r && ['completed', 'failed', 'cancelled'].includes(r.status) ? r : null;
}, `run ${runId} settles`);
async function approveGate(runId: string): Promise<void> {
  const open = await until(async () => {
    const row = await storage.getRun(bareRunId(runId));
    if (row && ['completed', 'failed', 'cancelled'].includes(row.status)) {
      throw new Error(`promotion ended before its approval gate: ${JSON.stringify({ status: row.status, error: row.error, events: (await storage.listEvents(row.runId)).slice(-5) })}`);
    }
    return (await storage.listOpenInterrupts(bareRunId(runId)))[0];
  }, 'the promotion gate opens');
  await resolveAndResume(storage, hostSuite, open.interruptId, { action: 'approve' }, { subjectRef: 'u-approver' });
  await __awaitRunResumeChainForTests(bareRunId(runId));
}
const decisions = async (tenantId: string, experimentId: string) =>
  (await listChain(tenantId)).filter((x) => x.kind === 'experiment.decision' && x.payload.experimentId === experimentId).map((x) => x.payload);

describe('ADR 0950 P2 — 1. the promote chain end to end (the P2 exit)', () => {
  it('approval, then 50 → 90 → 98 with a 2% holdout, each stage rechecked, monitored, finalized; a fork applies nothing', async () => {
    const w = await workspace();
    const e = await experiment(w.tenantId, w.orgId);
    const { runId, winner } = await startPromotion({ storage, hostSuite }, w.tenantId, w.orgId, e.experimentId, w.ownerId);
    expect(winner).toBe('b');
    await approveGate(runId);
    const run = await settled(runId);
    expect(run.status, JSON.stringify(run.error ?? null)).toBe('completed');
    const row = (await getExperimentRow(w.tenantId, w.orgId, e.experimentId))!;
    const ramps = row.epochs.filter((x) => x.reason === 'ramp');
    expect(ramps.map((x) => [x.stage, x.weights.b])).toEqual([[1, 50], [2, 90], [3, 98]]);
    expect(ramps[2]!.weights.control).toBe(2);
    expect(row.promotion).toMatchObject({ winner: 'b', holdoutPct: 2, baselineRef: 'baseline-v1' });
    expect(row.promotion?.finalizedAt).toBeTruthy();
    expect(shipped).toContainEqual({ experimentId: e.experimentId, winner: 'b' });
    expect((await decisions(w.tenantId, e.experimentId)).map((d) => d.action)).toEqual(['ramp', 'ramp', 'ramp', 'finalize']);

    const fork = await w.owner.call('POST', `/runs/${encodeURIComponent(toWireRunId(runId, w.tenantId))}:fork`, { mode: 'replay', fromSeq: 0 });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    expect(fork.body.runId).toEqual(expect.any(String));
    // A gate-role node reopens its approval in a replay; this is deliberate
    // human control, while effect-role nodes serve their recorded outcomes.
    await approveGate(fork.body.runId as string);
    const replayed = await settled(fork.body.runId as string);
    expect(replayed.status, JSON.stringify(replayed.error ?? null)).toBe('completed');
    expect(replayed.parentRunId).toBe(runId);
    const after = (await getExperimentRow(w.tenantId, w.orgId, e.experimentId))!;
    expect(after.epochs).toEqual(row.epochs);
    expect(shipped.filter((entry) => entry.experimentId === e.experimentId)).toHaveLength(1);
    expect((await decisions(w.tenantId, e.experimentId)).length).toBe(4);
  });
});

describe('ADR 0950 P2 — 2. a guardrail breach at stage 2 rolls back (the P2 exit)', () => {
  it('every unit back on control, the baseline restored, stage 3 never applied', async () => {
    const w = await workspace();
    const e = await experiment(w.tenantId, w.orgId);
    scenario.set(e.experimentId, { breachAtStage: 2 });
    const { runId } = await startPromotion({ storage, hostSuite }, w.tenantId, w.orgId, e.experimentId, w.ownerId);
    await approveGate(runId);
    expect((await settled(runId)).status).toBe('completed');
    const row = (await getExperimentRow(w.tenantId, w.orgId, e.experimentId))!;
    expect(row.status).toBe('rolled_back');
    expect(row.epochs.filter((x) => x.reason === 'ramp').map((x) => x.stage)).toEqual([1, 2]);
    expect(row.epochs.at(-1)).toMatchObject({ reason: 'rollback', weights: { control: 100 } });
    expect(row.promotion?.finalizedAt).toBeUndefined();
    expect((await decisions(w.tenantId, e.experimentId)).map((d) => d.action)).toEqual(['ramp', 'ramp', 'rollback']);
  });
});

describe('ADR 0950 P2 recovery — a held stage resumes its elected winner', () => {
  it('a real underpowered stage-2 run resumes on stage weights, keeps its holdout and appends no duplicate epochs', async () => {
    const w = await workspace();
    const e = await experiment(w.tenantId, w.orgId);
    scenario.set(e.experimentId, { underpoweredAtStage: 2 });
    const first = await startPromotion({ storage, hostSuite }, w.tenantId, w.orgId, e.experimentId, w.ownerId,
      { holdoutPct: 3 });
    await approveGate(first.runId);
    expect((await settled(first.runId)).status).toBe('failed');
    const held = (await getExperimentRow(w.tenantId, w.orgId, e.experimentId))!;
    expect(held.epochs.filter((epoch) => epoch.reason === 'ramp').map((epoch) => epoch.stage)).toEqual([1, 2]);
    expect(held.promotion?.finalizedAt).toBeUndefined();
    expect(held.promotionGate).toMatchObject({ winner: 'b', planHash: PLAN.planHash });
    scenario.delete(e.experimentId);
    const launchChecks = await checkPromotionGates(held, new Date().toISOString());
    expect(launchChecks.gates.find((gate) => gate.id === 'G3')?.status, 'non-vacuity: launch-weight SRM rejects a legitimate 90% ramp').toBe('fail');
    const resumed = await startPromotion({ storage, hostSuite }, w.tenantId, w.orgId, e.experimentId, w.ownerId);
    expect(resumed.runId).not.toBe(first.runId);
    expect((await storage.getRun(resumed.runId))?.metadata?.experimentPromotion).toMatchObject({ winner: 'b', resumedFromStage: 2 });
    await approveGate(resumed.runId);
    expect((await settled(resumed.runId)).status).toBe('completed');
    const done = (await getExperimentRow(w.tenantId, w.orgId, e.experimentId))!;
    expect(done.epochs.filter((epoch) => epoch.reason === 'ramp').map((epoch) => [epoch.stage, epoch.weights.b])).toEqual([[1, 50], [2, 90], [3, 97]]);
    expect(done.promotion?.holdoutPct).toBe(3);
    expect(done.promotionGate).toEqual(held.promotionGate);
  });

  it('stopping the experiment after its gate read prevents the reservation CAS from granting authority', async () => {
    const e = await experiment(`org:admission-race-${n++}`, 'client');
    const now = new Date().toISOString();
    const admission = await checkPromotionAdmission(e, now);
    await putExperimentRow({ ...e, status: 'stopped' });
    await expect(claimPromotionRun(e.tenantId, e.orgId, e.experimentId, 'late-start', async () => 'missing', now, admission))
      .rejects.toMatchObject({ details: { reason: 'promotion_admission_changed' } });
    expect((await getExperimentRow(e.tenantId, e.orgId, e.experimentId))?.promotionRunId).toBeUndefined();
  });
});

describe('ADR 0950 P2 — 3. the chokepoint', () => {
  it('a param-less internal promotion refuses at its first node before any effect', async () => {
    const w = await workspace();
    const before = shipped.length;
    const runId = await startWorkflowRun({ storage, hostSuite }, { tenantId: w.tenantId,
      workflowId: PROMOTE_CHAIN_ID, inputs: {}, orgScopeSubject: w.ownerId });
    if (!runId) throw new Error('the internal promotion workflow did not resolve');
    const run = await settled(runId);
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'validation_error' });
    const failed = (await storage.listEvents(runId)).filter((event) => event.type === 'node.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.nodeId).toMatch(/_gates$/);
    expect(shipped).toHaveLength(before);
  });

  it('an ambiguous committed start retains its promotion claim instead of revoking the run it inserted', async () => {
    const w = await workspace();
    const e = await experiment(w.tenantId, w.orgId);
    const insert = storage.insertRun.bind(storage);
    const get = storage.getRun.bind(storage);
    let attempted: string | undefined;
    let uncertain = false;
    const readFault = vi.spyOn(storage, 'getRun').mockImplementation(async (runId) => {
      if (uncertain && runId === attempted) { uncertain = false; throw new Error('promotion acknowledgement unknown'); }
      return get(runId);
    });
    const insertFault = vi.spyOn(storage, 'insertRun').mockImplementation(async (run, options) => {
      if (!attempted && run.workflowId === PROMOTE_CHAIN_ID && run.tenantId === w.tenantId) {
        attempted = run.runId;
        await insert(run, options);
        uncertain = true;
        throw new Error('promotion insert committed before the process stopped');
      }
      return insert(run, options);
    });
    try {
      await expect(startPromotion({ storage, hostSuite }, w.tenantId, w.orgId, e.experimentId, w.ownerId))
        .rejects.toThrow('promotion acknowledgement unknown');
    } finally {
      insertFault.mockRestore();
      readFault.mockRestore();
    }
    if (!attempted) throw new Error('promotion never attempted its run insert');
    expect(await get(attempted)).toMatchObject({ tenantId: w.tenantId, workflowId: PROMOTE_CHAIN_ID });
    expect((await getExperimentRow(w.tenantId, w.orgId, e.experimentId))?.promotionRunId).toBe(attempted);
  });

  it('only the claimed run may ramp; a second start is promotion_in_progress; failing gates refuse to start', async () => {
    const w = await workspace();
    const e = await experiment(w.tenantId, w.orgId);
    const other = buildExperimentsSurface({ tenantId: w.tenantId, runId: 'run-not-the-promotion' });
    await expect(other.applyRamp!({ orgId: w.orgId, experimentId: e.experimentId, stage: 1, winner: 'b', holdoutPct: 2 })).rejects.toMatchObject({ details: { reason: 'not_the_promotion_run' } });
    await expect(other.rollback!({ orgId: w.orgId, experimentId: e.experimentId })).rejects.toMatchObject({ details: { reason: 'not_the_promotion_run' } });
    await expect(other.finalize!({ orgId: w.orgId, experimentId: e.experimentId })).rejects.toMatchObject({ details: { reason: 'not_the_promotion_run' } });
    const first = await startPromotion({ storage, hostSuite }, w.tenantId, w.orgId, e.experimentId, w.ownerId);
    await expect(startPromotion({ storage, hostSuite }, w.tenantId, w.orgId, e.experimentId, w.ownerId)).rejects.toMatchObject({ details: { reason: 'promotion_in_progress' } });
    expect((await getExperimentRow(w.tenantId, w.orgId, e.experimentId))?.promotionRunId).toBe(first.runId);
    const young = await experiment(w.tenantId, w.orgId, { startedAt: new Date(Date.now() - DAY).toISOString() });
    await expect(startPromotion({ storage, hostSuite }, w.tenantId, w.orgId, young.experimentId, w.ownerId)).rejects.toMatchObject({ details: { reason: 'gate_failed' } });
  });
});

describe('ADR 0950 P2 — 4. the route', () => {
  it('starts a promotion (202); the sub-toggle gates it; a viewer is refused; another org is a 404', async () => {
    const w = await workspace();
    const e = await experiment(w.tenantId, w.orgId);
    const path = (org: string, id: string) => `/host/openwop-app/experiments/orgs/${encodeURIComponent(org)}/experiments/${encodeURIComponent(id)}/promote`;
    const sub = getToggleDefault('experiments.auto-promote')!;
    await saveConfig({ ...sub, status: 'off' }, 'test');
    try {
      expect((await w.owner.call('POST', path(w.orgId, e.experimentId), {})).status).not.toBe(202);
    } finally {
      await saveConfig({ ...sub, status: 'on' }, 'test');
    }
    const otherOrg: string = (await w.owner.call('POST', '/host/openwop-app/orgs', { name: 'Other' })).body.orgId;
    expect((await w.owner.call('POST', path(otherOrg, e.experimentId), {})).status).toBe(404);
    const viewer = client();
    const viewerId: string = (await viewer.call('POST', '/host/openwop-app/test/login', { email: `p2-v-${n++}@acme.test`, tenantId: w.tenantId })).body.user.userId;
    expect((await w.owner.call('POST', `/host/openwop-app/orgs/${encodeURIComponent(w.orgId)}/members`, { displayName: 'V', subject: viewerId, roles: ['viewer'] })).status).toBe(201);
    expect((await viewer.call('POST', path(w.orgId, e.experimentId), {})).status).toBe(403);
    const ok = await w.owner.call('POST', path(w.orgId, e.experimentId), { holdoutPct: 3 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
    expect(ok.body).toMatchObject({ experimentId: e.experimentId, winner: 'b' });
    expect((await w.owner.call('POST', path(w.orgId, e.experimentId), {})).status).toBe(409);
  });
});

/** Recovery regression witnesses: a real reservation and real row CAS, with a
 * competing claimant inserted at the storage boundary before the stale write. */
describe('ADR 0950 P2 recovery — startup reservations', () => {
  it.each(['catalog', 'published'] as const)('refuses a changed %s definition and releases its reservation', async (source) => {
    const w = await workspace();
    const e = await experiment(w.tenantId, w.orgId);
    const trusted = getChainBackedWorkflow(PROMOTE_CHAIN_ID)!;
    expect(trusted).toBeDefined();
    const altered = { ...trusted, name: `Altered promotion ${e.experimentId}` };
    let suite = hostSuite;
    if (source === 'catalog') {
      suite = { ...hostSuite, workflowCatalog: { ...hostSuite.workflowCatalog, getWorkflow: async () => ({ workflowId: PROMOTE_CHAIN_ID, definition: altered }) } };
    } else {
      const hash = await recordRevision(w.tenantId, altered);
      expect(hash).toBeTruthy();
      await recordOwnership(w.tenantId, PROMOTE_CHAIN_ID, { nodeCount: altered.nodes.length, publishedRevision: hash! });
    }
    try {
      await expect(startPromotion({ storage, hostSuite: suite }, w.tenantId, w.orgId, e.experimentId, w.ownerId))
        .rejects.toMatchObject({ code: 'workflow_not_found' });
      expect((await getExperimentRow(w.tenantId, w.orgId, e.experimentId))?.promotionRunId).toBeUndefined();
    } finally {
      if (source === 'published') await removeOwnership(w.tenantId, PROMOTE_CHAIN_ID);
    }
  });

  it('a not-yet-inserted run keeps its claim; a terminal run releases immediately', async () => {
    const tenantId = `org:claim-${n++}`; const orgId = 'client';
    const e = await experiment(tenantId, orgId);
    const now = new Date().toISOString();
    await claimPromotionRun(tenantId, orgId, e.experimentId, 'first', async () => 'missing', now);
    await expect(claimPromotionRun(tenantId, orgId, e.experimentId, 'second', async () => 'missing', now))
      .rejects.toMatchObject({ details: { reason: 'promotion_in_progress' } });
    expect((await getExperimentRow(tenantId, orgId, e.experimentId))?.promotionRunId).toBe('first');
    await claimPromotionRun(tenantId, orgId, e.experimentId, 'second', async () => 'terminal', now);
    expect((await getExperimentRow(tenantId, orgId, e.experimentId))?.promotionRunId).toBe('second');
    await releasePromotionRun(tenantId, orgId, e.experimentId, 'second');
    const released = await getExperimentRow(tenantId, orgId, e.experimentId);
    expect(released?.promotionRunId).toBeUndefined();
    expect(released?.promotionRunClaimedAt).toBeUndefined();
  });

  it('a crashed pre-insert reservation expires, while an existing live run does not', async () => {
    const tenantId = `org:claim-${n++}`; const orgId = 'client';
    const e = await experiment(tenantId, orgId);
    const at = Date.now();
    await claimPromotionRun(tenantId, orgId, e.experimentId, 'first', async () => 'missing', new Date(at).toISOString());
    const later = new Date(at + PROMOTION_START_GRACE_MS + 1).toISOString();
    await expect(claimPromotionRun(tenantId, orgId, e.experimentId, 'second', async () => 'live', later))
      .rejects.toMatchObject({ details: { reason: 'promotion_in_progress' } });
    await claimPromotionRun(tenantId, orgId, e.experimentId, 'second', async () => 'missing', later);
    expect((await getExperimentRow(tenantId, orgId, e.experimentId))?.promotionRunId).toBe('second');
  });

  it('a legacy missing-run claim starts a grace period before it can be recovered', async () => {
    const tenantId = `org:claim-${n++}`; const orgId = 'client';
    const e = await experiment(tenantId, orgId, { promotionRunId: 'legacy' });
    const at = Date.now(); const now = new Date(at).toISOString();
    await expect(claimPromotionRun(tenantId, orgId, e.experimentId, 'second', async () => 'missing', now))
      .rejects.toMatchObject({ details: { reason: 'promotion_in_progress' } });
    expect(await getExperimentRow(tenantId, orgId, e.experimentId)).toMatchObject({ promotionRunId: 'legacy', promotionRunClaimedAt: now });
    await expect(claimPromotionRun(tenantId, orgId, e.experimentId, 'second', async () => 'missing', now))
      .rejects.toMatchObject({ details: { reason: 'promotion_in_progress' } });
    await claimPromotionRun(tenantId, orgId, e.experimentId, 'second', async () => 'missing', new Date(at + PROMOTION_START_GRACE_MS + 1).toISOString());
    expect((await getExperimentRow(tenantId, orgId, e.experimentId))?.promotionRunId).toBe('second');
  });

  it('an unreadable reservation timestamp fails closed', async () => {
    const tenantId = `org:claim-${n++}`; const orgId = 'client';
    const e = await experiment(tenantId, orgId, { promotionRunId: 'first', promotionRunClaimedAt: 'invalid' });
    await expect(claimPromotionRun(tenantId, orgId, e.experimentId, 'second', async () => 'missing'))
      .rejects.toMatchObject({ details: { reason: 'promotion_in_progress' } });
  });
});

describe('ADR 0950 P2 recovery — promotion ownership CAS', () => {
  it.each(['ramp', 'finalize', 'rollback'] as const)('%s refuses a claim transferred after its initial read', async (action) => {
    const tenantId = `org:claim-cas-${n++}`; const orgId = 'client';
    const e = await experiment(tenantId, orgId, { promotion: { winner: 'b', holdoutPct: 2 } });
    const now = new Date().toISOString();
    await claimPromotionRun(tenantId, orgId, e.experimentId, 'old-owner', async () => 'missing', now);
    const before = await getExperimentRow(tenantId, orgId, e.experimentId);
    const shippedBefore = shipped.length; const restoredBefore = restored.length;
    const cas = storage.kvCompareAndSwap.bind(storage);
    let transferred = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (!transferred && args[0].includes(e.experimentId)) {
        transferred = true;
        await claimPromotionRun(tenantId, orgId, e.experimentId, 'new-owner', async () => 'terminal', now);
      }
      return cas(...args);
    });
    const ctx = { actor: 'u', runId: 'old-owner', now };
    try {
      const result = action === 'ramp'
        ? applyPromotionRamp(tenantId, orgId, e.experimentId, { stage: 1, winner: 'b', winnerPct: 50, holdoutPct: 2 }, ctx)
        : action === 'finalize'
          ? finalizePromotion(tenantId, orgId, e.experimentId, ctx)
          : rollbackPromotion(tenantId, orgId, e.experimentId, { ...ctx, reason: 'breach' });
      await expect(result).rejects.toMatchObject({ details: { reason: 'not_the_promotion_run' } });
    } finally { spy.mockRestore(); }
    expect(transferred).toBe(true);
    const after = await getExperimentRow(tenantId, orgId, e.experimentId);
    expect(after?.promotionRunId).toBe('new-owner');
    expect(after?.epochs).toEqual(before?.epochs);
    expect(after?.promotion).toEqual(before?.promotion);
    expect(shipped.length).toBe(shippedBefore);
    expect(restored.length).toBe(restoredBefore);
  });
});

describe('ADR 0950 P2 recovery — exact stage cohort', () => {
  it('excludes pre-ramp units on the same day without replacing the full experiment cache', async () => {
    const tenantId = `org:stage-cohort-${n++}`; const orgId = 'client';
    const day = new Date().toISOString().slice(0, 10);
    const at = `${day}T12:00:00.000Z`; const now = `${day}T14:00:00.000Z`;
    const units: UnitObservation[] = [];
    const add = (arm: string, count: number, time: string, rate: number): void => {
      for (let i = 0; i < count; i++) units.push({ arm, firstExposureAt: time, converted: i < count * rate, metrics: { unsubscribe: 0 } });
    };
    add('control', 500, `${day}T11:00:00.000Z`, 0.1);
    add('b', 500, `${day}T11:00:00.000Z`, 0.14);
    add('control', 400, `${day}T13:00:00.000Z`, 0.1);
    add('b', 3600, `${day}T13:00:00.000Z`, 0.14);
    registerExperimentSurface({
      kind: 'test.stage-cohort', validateTarget: async () => undefined,
      launch: async (e) => e, stop: async (e) => e,
      observe: async () => ({ units, coverage: 'complete', sourceRetainedSince: null }),
    });
    const e = await experiment(tenantId, orgId, { surface: { kind: 'test.stage-cohort', ref: 'r' } });
    const epoch = { epoch: 1, weights: { control: 10, b: 90 }, at, reason: 'ramp' as const, stage: 2 };
    const obs = await observeExperiment(e, now, { firstExposedSince: at });
    expect(obs.totals.get('control')?.n).toBe(400);
    expect(obs.totals.get('b')?.n).toBe(3600);
    expect(evaluateStageCheck({ experiment: e, cells: obs.cells, coverage: obs.coverage, epoch, now, kind: 'recheck', minUnitsPerArm: 50 }).outcome).toBe('pass');
    const full = totalsByArm((await readExperimentRollup(tenantId, orgId, e.experimentId)).cells);
    expect(full.get('control')?.n).toBe(900);
    expect(full.get('b')?.n).toBe(4100);
  });

  it('partial source coverage can never pass a stage', async () => {
    const e = await experiment(`org:stage-partial-${n++}`, 'client');
    const at = new Date().toISOString();
    const epoch = { epoch: 1, weights: { control: 10, b: 90 }, at, reason: 'ramp' as const, stage: 2 };
    expect(evaluateStageCheck({ experiment: e, cells: [], coverage: 'partial', epoch, now: at, kind: 'recheck', minUnitsPerArm: 0 }))
      .toMatchObject({ outcome: 'underpowered', breach: false, reason: 'partial_coverage' });
  });
});
