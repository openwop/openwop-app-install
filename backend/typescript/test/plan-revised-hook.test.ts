import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerPlanRevisedListener,
  emitPlanRevised,
  __resetPlanRevisedListenersForTest,
} from '../src/host/planRevisedHook.js';

/**
 * ENG-15(b) — the plan-revised seam that replaced a direct cross-feature call.
 *
 * The first implementation had kicktodo-core import kicktodo-integrations
 * directly. It worked, but it took the ADR 0446 classifier's `[3] Hard-dep` count
 * from 0 to 1, and `feature-deps-classifier.test.ts` asserts that count is ZERO.
 * This seam is the fixed edge: neither feature imports the other.
 *
 * The contract worth pinning is that FAIL-SOFT lives HERE, not in each listener —
 * a plan revision is the participant's durable intent and is already committed
 * when this fires, so no projection may turn it into a failed revision.
 */
const EV = { tenantId: 't', ownerSubject: 'user:a', enrollmentId: 'e1', lanes: ['move'] };

beforeEach(() => __resetPlanRevisedListenersForTest());

describe('plan-revised hook (ENG-15(b))', () => {
  it('a THROWING listener does not propagate — the revision cannot fail on a projection', async () => {
    registerPlanRevisedListener(() => { throw new Error('calendar exploded'); });
    await expect(emitPlanRevised(EV)).resolves.toBeUndefined();
  });

  it('one listener failing does not stop the next', async () => {
    // Otherwise registration ORDER would silently decide which projections run —
    // a coupling nobody declared.
    const second = vi.fn();
    registerPlanRevisedListener(() => { throw new Error('first fails'); });
    registerPlanRevisedListener(second);
    await emitPlanRevised(EV);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('passes the lanes so a listener can ignore revisions it does not care about', async () => {
    const seen: string[][] = [];
    registerPlanRevisedListener((ev) => { seen.push([...ev.lanes]); });
    await emitPlanRevised({ ...EV, lanes: ['schedule'] });
    expect(seen).toEqual([['schedule']]);
  });

  it('awaits async listeners, so a caller can sequence on the projection', async () => {
    let done = false;
    registerPlanRevisedListener(async () => {
      await new Promise((r) => setTimeout(r, 5));
      done = true;
    });
    await emitPlanRevised(EV);
    expect(done).toBe(true);
  });
});
