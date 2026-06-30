/**
 * Standing-goals SERVICE-layer coverage (RFC 0097) — fills the grade-code FEAT-4
 * gap: the existing `goals.test.ts` boots the full HTTP app to assert the two
 * behavioral legs; the pure service CRUD, the tenant-prefixed `listByPrefix`
 * scan, and the cross-tenant read guard were never unit-tested directly. This
 * drives `goalsService` against an in-memory sqlite `DurableCollection`.
 *
 * `OPENWOP_GOALS_REQUIRE_BOUNDS` is pinned per-test so the bounds invariant is
 * exercised both ways without leaking env between tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createGoal,
  getGoal,
  listGoals,
  updateGoal,
  transitionGoal,
  BoundsRequiredError,
  JudgeOnlyStateError,
  __test,
  type CreateGoalInput,
} from '../src/features/goals/goalsService.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const baseInput = (tenant: string, objective = 'Keep the digest short'): CreateGoalInput => ({
  objective,
  completion: { check: 'verifier' },
  continuation: { mode: 'schedule' },
  bounds: { maxLoopIterations: 10 },
  owner: { tenant },
});

describe('goalsService (service layer, in-memory durable)', () => {
  const prevBounds = process.env.OPENWOP_GOALS_REQUIRE_BOUNDS;

  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __test.collection.__clear();
  });

  afterEach(() => {
    if (prevBounds === undefined) delete process.env.OPENWOP_GOALS_REQUIRE_BOUNDS;
    else process.env.OPENWOP_GOALS_REQUIRE_BOUNDS = prevBounds;
  });

  it('createGoal → getGoal round-trips a bounded active goal', async () => {
    const g = await createGoal(baseInput(TENANT_A));
    expect(g.id).toMatch(/^goal:/);
    expect(g.state).toBe('active');
    expect(g.owner.tenant).toBe(TENANT_A);
    expect(g.bounds.maxLoopIterations).toBe(10);

    const got = await getGoal(TENANT_A, g.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(g.id);
    expect(got!.objective).toBe('Keep the digest short');
  });

  it('createGoal without bounds throws BoundsRequiredError when require-bounds is on', async () => {
    process.env.OPENWOP_GOALS_REQUIRE_BOUNDS = 'true';
    const noBounds: CreateGoalInput = { ...baseInput(TENANT_A), bounds: undefined };
    await expect(createGoal(noBounds)).rejects.toBeInstanceOf(BoundsRequiredError);
  });

  it('createGoal without bounds is allowed when require-bounds is off', async () => {
    process.env.OPENWOP_GOALS_REQUIRE_BOUNDS = 'false';
    const noBounds: CreateGoalInput = { ...baseInput(TENANT_A), bounds: undefined };
    const g = await createGoal(noBounds);
    expect(g.bounds).toEqual({});
  });

  it('listGoals returns only the tenant slice, filters by state, sorts by createdAt', async () => {
    const g1 = await createGoal(baseInput(TENANT_A, 'first'));
    const g2 = await createGoal(baseInput(TENANT_A, 'second'));
    await createGoal(baseInput(TENANT_B, 'other tenant'));

    const all = await listGoals(TENANT_A);
    expect(all.map((g) => g.id).sort()).toEqual([g1.id, g2.id].sort());
    expect(all.every((g) => g.owner.tenant === TENANT_A)).toBe(true);

    // abandon one, then a state filter narrows to it
    await transitionGoal(TENANT_A, g1.id, 'abandon');
    expect((await listGoals(TENANT_A, 'abandoned')).map((g) => g.id)).toEqual([g1.id]);
    expect((await listGoals(TENANT_A, 'active')).map((g) => g.id)).toEqual([g2.id]);
  });

  it('tenant isolation: tenant B cannot read tenant A\'s goal', async () => {
    const a = await createGoal(baseInput(TENANT_A));
    expect(await getGoal(TENANT_B, a.id)).toBeNull();
    expect(await listGoals(TENANT_B)).toHaveLength(0);
  });

  it('updateGoal edits the objective but refuses a judge-owned verdict', async () => {
    const g = await createGoal(baseInput(TENANT_A));
    const updated = await updateGoal(TENANT_A, g.id, { objective: 'New objective' });
    expect(updated!.objective).toBe('New objective');
    expect(updated!.updatedAt).toBeTypeOf('string');

    // a client may never write a completion verdict
    await expect(updateGoal(TENANT_A, g.id, { state: 'satisfied' })).rejects.toBeInstanceOf(JudgeOnlyStateError);
    // and the foreign-tenant update is a null no-op
    expect(await updateGoal(TENANT_B, g.id, { objective: 'hijack' })).toBeNull();
  });

  it('transitionGoal handles pause/resume/abandon; missing id → null', async () => {
    const g = await createGoal(baseInput(TENANT_A));
    expect((await transitionGoal(TENANT_A, g.id, 'pause'))!.state).toBe('active');
    expect((await transitionGoal(TENANT_A, g.id, 'resume'))!.state).toBe('active');
    expect((await transitionGoal(TENANT_A, g.id, 'abandon'))!.state).toBe('abandoned');
    expect(await transitionGoal(TENANT_A, 'goal:does-not-exist', 'pause')).toBeNull();
  });
});
