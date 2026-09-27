/**
 * ADR 0412 P5 — principal ownership on goal mutations.
 *
 * A goal created with an `owner.principal` is mutable only by that acting
 * principal; every foreign-principal mutation returns null — indistinguishable
 * from absent (uniform 404, no existence oracle). Reads stay tenant-scoped.
 * Principal-less goals keep tenant-only semantics (the conformance bearer and
 * the demo row are unaffected).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier, __clearGoalVerifiers } from '../src/features/goals/goalVerifiers.js';
import {
  armContinuation,
  bindContributingRun,
  createGoal,
  evaluateGoal,
  getGoal,
  transitionGoal,
  updateGoal,
} from '../src/features/goals/goalsService.js';

const TENANT = 'tenant-own';
const OWNER = 'user:alice';
const STRANGER = 'user:mallory';
const BOUNDS = { maxLoopIterations: 5, runTimeoutMs: 600_000 };

let storage: Storage;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

afterEach(() => {
  __clearGoalVerifiers();
  __resetHostExtPersistence();
});

async function ownedGoal(): Promise<string> {
  const g = await createGoal({
    objective: 'Principal-owned goal',
    completion: { check: 'verifier', verifierRef: 'own:v' },
    continuation: { mode: 'schedule' },
    bounds: BOUNDS,
    owner: { tenant: TENANT, principal: OWNER },
  });
  return g.id;
}

describe('principal-owned goal mutations', () => {
  it('foreign principal: every mutation is null (uniform not-found); owner succeeds', async () => {
    registerGoalVerifier('own:v', async () => ({ satisfied: false, confidence: 0.5, runId: 'run-own' }));
    const id = await ownedGoal();

    // Foreign principal — all mutations indistinguishable from absent.
    expect(await updateGoal(TENANT, id, { objective: 'hijack' }, STRANGER)).toBeNull();
    expect(await transitionGoal(TENANT, id, 'abandon', STRANGER)).toBeNull();
    expect(await bindContributingRun(TENANT, id, 'run:evil', undefined, STRANGER)).toBeNull();
    expect(await evaluateGoal(TENANT, id, { snapshotRef: 'r', snapshotHash: 'h' }, STRANGER)).toBeNull();
    expect(
      await armContinuation(TENANT, id, { workflowId: 'wf:x', cronExpr: '0 * * * *' }, STRANGER),
    ).toBeNull();

    // An ABSENT principal (tenant-trusted run surface) and the OWNER both work.
    expect(await bindContributingRun(TENANT, id, 'run:surface')).not.toBeNull();
    const evaluated = await evaluateGoal(TENANT, id, { snapshotRef: 'r', snapshotHash: 'h' }, OWNER);
    expect(evaluated?.verdict.satisfied).toBe(false);

    // Nothing the stranger attempted took effect.
    const g = await getGoal(TENANT, id);
    expect(g?.objective).toBe('Principal-owned goal');
    expect(g?.state).toBe('active');
    expect(g?.progress?.contributingRunIds).toEqual(['run:surface']);
  });

  it('a denied evaluation does not leak the recorded verdict via replay', async () => {
    registerGoalVerifier('own:v', async () => ({ satisfied: true, confidence: 1, runId: 'run-own-2' }));
    const id = await ownedGoal();
    await evaluateGoal(TENANT, id, { snapshotRef: 'r2', snapshotHash: 'h2' }, OWNER);
    // Same evidence, foreign principal — no replayed verdict, just not-found.
    expect(await evaluateGoal(TENANT, id, { snapshotRef: 'r2', snapshotHash: 'h2' }, STRANGER)).toBeNull();
  });

  it('GOALS-4: an objective edit preserves the judge sidecar (evidence replay key survives)', async () => {
    registerGoalVerifier('own:v', async () => ({ satisfied: false, confidence: 0.4, runId: 'run-keep' }));
    const id = await ownedGoal();
    await evaluateGoal(TENANT, id, { snapshotRef: 'rk', snapshotHash: 'hk' }, OWNER);
    await updateGoal(TENANT, id, { objective: 'Edited objective' }, OWNER);
    // Same evidence after the edit → still replays the recorded verdict
    // (the host sidecar survived the client edit).
    const replayed = await evaluateGoal(TENANT, id, { snapshotRef: 'rk', snapshotHash: 'hk' }, OWNER);
    expect(replayed?.replayed).toBe(true);
    expect(replayed?.verdict.runId).toBe('run-keep');
    expect((await getGoal(TENANT, id))?.objective).toBe('Edited objective');
  });

  it('principal-less goals keep tenant-only semantics', async () => {
    registerGoalVerifier('own:v', async () => ({ satisfied: true, confidence: 1, runId: 'run-own-3' }));
    const g = await createGoal({
      objective: 'Tenant-only goal',
      completion: { check: 'verifier', verifierRef: 'own:v' },
      continuation: { mode: 'manual' },
      bounds: BOUNDS,
      owner: { tenant: TENANT },
    });
    // Any principal within the tenant may mutate (prior behavior preserved).
    const done = await evaluateGoal(TENANT, g.id, { snapshotRef: 'r3', snapshotHash: 'h3' }, STRANGER);
    expect(done?.goal.state).toBe('satisfied');
  });
});
