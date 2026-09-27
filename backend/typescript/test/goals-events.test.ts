/**
 * ADR 0412 P3 — content-free `host.goals.evaluated` / `host.goals.closed`
 * lifecycle events + the replay invariant.
 *
 * Unit-style (the host-event-pii-strip pattern): a capturing dispatcher fake
 * observes every emitted envelope. Covers: exact schema-shaped payloads (the
 * run-event-payloads §goalEvaluated/§goalClosed mirror, content-free — no
 * objective text, no evidence refs), closed-on-terminal for all four finals,
 * NO emission on a replayed evaluation, no re-emit on repeated abandon, and
 * the capability gate (flag off → zero events).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  initHostEventDispatcher,
  __clearHostEventBindings,
  __resetHostEventDispatcher,
  type HostEventEnvelope,
} from '../src/host/hostEventDispatcher.js';
import { registerGoalVerifier, __clearGoalVerifiers } from '../src/features/goals/goalVerifiers.js';
import {
  bindContributingRun,
  createGoal,
  evaluateGoal,
  transitionGoal,
} from '../src/features/goals/goalsService.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

let storage: Storage;
let delivered: HostEventEnvelope[];
const TENANT = 'tenant-goal-events';
const priorFlag = process.env.OPENWOP_GOALS_ENABLED;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __clearHostEventBindings();
  delivered = [];
  initHostEventDispatcher({
    storage,
    hostSuite,
    deliverWebhooks: async (event) => {
      delivered.push(event);
    },
    startRun: async () => 'run:fake-1',
  });
  process.env.OPENWOP_GOALS_ENABLED = 'true'; // capability gate: events may emit
});

afterEach(() => {
  if (priorFlag === undefined) delete process.env.OPENWOP_GOALS_ENABLED;
  else process.env.OPENWOP_GOALS_ENABLED = priorFlag;
  __clearGoalVerifiers();
  __resetHostEventDispatcher();
  __resetHostExtPersistence();
});

const BOUNDS = { maxLoopIterations: 5, runTimeoutMs: 600_000 };

async function makeGoal(verifierRef: string, bounds: Record<string, number> = BOUNDS): Promise<string> {
  const g = await createGoal({
    objective: 'SECRET objective text that must never appear in an event',
    completion: { check: 'verifier', verifierRef },
    continuation: { mode: 'manual' },
    bounds,
    owner: { tenant: TENANT },
  });
  return g.id;
}

const ofType = (type: string) => delivered.filter((e) => e.type === type);

describe('host.goals.evaluated / host.goals.closed', () => {
  it('satisfied evaluation emits schema-shaped evaluated + closed(satisfied), content-free', async () => {
    registerGoalVerifier('ev:sat', async () => ({ satisfied: true, confidence: 0.85, runId: 'run-ev-1' }));
    const id = await makeGoal('ev:sat');
    await evaluateGoal(TENANT, id, { snapshotRef: 'ref:1', snapshotHash: 'h1' });

    const evaluated = ofType('host.goals.evaluated');
    expect(evaluated).toHaveLength(1);
    // EXACT §goalEvaluated payload — nothing more (content-free), nothing less.
    expect(evaluated[0].payload).toEqual({
      goalId: id,
      satisfied: true,
      confidence: 0.85,
      runId: 'run-ev-1',
      iterations: 1,
    });
    expect(evaluated[0].tenantId).toBe(TENANT);

    const closed = ofType('host.goals.closed');
    expect(closed).toHaveLength(1);
    expect(closed[0].payload).toEqual({ goalId: id, finalState: 'satisfied' });

    // Content-free: the objective text appears nowhere in any envelope.
    expect(JSON.stringify(delivered)).not.toContain('SECRET');
  });

  it('unsatisfied (goal stays active) emits evaluated only', async () => {
    registerGoalVerifier('ev:unsat', async () => ({ satisfied: false, confidence: 0.3, runId: 'run-ev-2' }));
    const id = await makeGoal('ev:unsat');
    await evaluateGoal(TENANT, id, { snapshotRef: 'ref:2', snapshotHash: 'h2' });
    expect(ofType('host.goals.evaluated')).toHaveLength(1);
    expect(ofType('host.goals.closed')).toHaveLength(0);
  });

  it('REPLAYED evaluation emits nothing (replay never re-emits)', async () => {
    registerGoalVerifier('ev:replay', async () => ({ satisfied: false, confidence: 0.5, runId: 'run-ev-3' }));
    const id = await makeGoal('ev:replay');
    await evaluateGoal(TENANT, id, { snapshotRef: 'ref:3', snapshotHash: 'same-hash' });
    const countAfterFirst = delivered.length;
    const replayed = await evaluateGoal(TENANT, id, { snapshotRef: 'ref:3', snapshotHash: 'same-hash' });
    expect(replayed?.replayed).toBe(true);
    expect(delivered.length).toBe(countAfterFirst);
  });

  it('bound-exceeded via exact iteration bound emits evaluated + closed(bound-exceeded)', async () => {
    registerGoalVerifier('ev:cap', async () => ({ satisfied: false, confidence: 0.1, runId: 'run-ev-4' }));
    const id = await makeGoal('ev:cap', { maxLoopIterations: 1 });
    await evaluateGoal(TENANT, id, { snapshotRef: 'ref:4', snapshotHash: 'h4' });
    const closed = ofType('host.goals.closed');
    expect(closed).toHaveLength(1);
    expect(closed[0].payload).toEqual({ goalId: id, finalState: 'bound-exceeded' });
  });

  it('cost bound crossed at bindContributingRun emits closed(bound-exceeded)', async () => {
    registerGoalVerifier('ev:cost', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
    const id = await makeGoal('ev:cost', { maxCostUsd: 1 });
    await bindContributingRun(TENANT, id, 'run:cheap', 0.4);
    expect(ofType('host.goals.closed')).toHaveLength(0);
    await bindContributingRun(TENANT, id, 'run:pricey', 0.8);
    // The bind-time flip is a real closure — it must be announced.
    expect(ofType('host.goals.closed').map((e) => e.payload)).toEqual([{ goalId: id, finalState: 'bound-exceeded' }]);
  });

  it('abandon emits closed(abandoned) once; repeated abandon does not re-emit', async () => {
    registerGoalVerifier('ev:ab', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
    const id = await makeGoal('ev:ab');
    await transitionGoal(TENANT, id, 'abandon');
    await transitionGoal(TENANT, id, 'abandon');
    const closed = ofType('host.goals.closed');
    expect(closed).toHaveLength(1);
    expect(closed[0].payload).toEqual({ goalId: id, finalState: 'abandoned' });
  });

  it('capability gate: with OPENWOP_GOALS_ENABLED off, NO goal event emits', async () => {
    delete process.env.OPENWOP_GOALS_ENABLED;
    registerGoalVerifier('ev:gate', async () => ({ satisfied: true, confidence: 1, runId: 'run-ev-5' }));
    const id = await makeGoal('ev:gate');
    await evaluateGoal(TENANT, id, { snapshotRef: 'ref:5', snapshotHash: 'h5' });
    await transitionGoal(TENANT, id, 'abandon');
    expect(delivered).toHaveLength(0);
  });
});
