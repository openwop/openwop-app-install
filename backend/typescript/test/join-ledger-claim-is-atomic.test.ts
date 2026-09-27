/**
 * `claimJoin` is an insert-once lock, and must behave like one under concurrency.
 *
 * WHY THIS TEST LOOKS THE WAY IT DOES. The bug it pins was invisible to the
 * obvious assertion. `claimJoin` was `get()`-then-`put()`: two concurrent binds
 * both read null, both wrote, and both were told they won. But both writes
 * target the SAME key, so afterwards there is exactly one join record and
 * `hasJoined` is true — a test that checks the stored state passes against the
 * broken implementation. What doubles is only the set of callers that got
 * `true` back, and therefore the `createMember` / `setActiveWorkspace` side
 * effects downstream of it.
 *
 * So every assertion here counts WINNERS, not rows. That is the transferable
 * rule from this repo's double-refund incident: a check that only inspects the
 * end state cannot see two writers who both believed they were first.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { claimJoin, hasJoined, autoJoinDefaultWorkspaces } from '../src/host/workspaceJoinLedger.js';
import { createOrg, listMembers } from '../src/host/accessControlService.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('claimJoin — exactly one winner per (subject, workspace)', () => {
  it('N concurrent claims for ONE subject produce exactly ONE true', async () => {
    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, () => claimJoin({ subject: 'user:race', workspaceId: 'host-race', orgId: 'host-race' })),
    );
    const winners = results.filter(Boolean).length;
    // THE assertion. Under get-then-put this was 12, and every other
    // observable below was still correct.
    expect(winners, `${winners} callers were told they won a lock only one may hold`).toBe(1);

    // The state assertions that CANNOT distinguish the two implementations,
    // kept deliberately so the contrast is on the record rather than in a
    // commit message: both of these passed while the lock was broken.
    expect(await hasJoined('user:race', 'host-race')).toBe(true);
  });

  it('a later claim after the race still loses — the record is durable, not a latch', async () => {
    await claimJoin({ subject: 'user:race2', workspaceId: 'host-race2', orgId: 'host-race2' });
    expect(await claimJoin({ subject: 'user:race2', workspaceId: 'host-race2', orgId: 'host-race2' })).toBe(false);
  });

  it('DIFFERENT subjects each win their own claim — the lock is per identity, not global', async () => {
    const [a, b] = await Promise.all([
      claimJoin({ subject: 'user:ra', workspaceId: 'host-race3', orgId: 'host-race3' }),
      claimJoin({ subject: 'user:rb', workspaceId: 'host-race3', orgId: 'host-race3' }),
    ]);
    // Non-vacuity: a lock that always returns false would pass the first test.
    expect([a, b]).toEqual([true, true]);
  });
});

describe('the side effect the lock protects — no duplicate membership', () => {
  it('concurrent first sign-ins create ONE member row, not N', async () => {
    const t = { featureId: 'f-race', orgId: 'host-racej', tenantId: 'host-racej', name: 'Race' };
    registerToggleDefault({ id: t.featureId, label: t.name, status: 'on', bucketUnit: 'user', salt: t.featureId } as never);
    await createOrg({ tenantId: t.tenantId, orgId: t.orgId, createdBy: 'system', name: t.name });

    // Six binds landing together — the real shape of the hazard, since
    // auto-join runs on EVERY bind.
    const joined = await Promise.all(
      Array.from({ length: 6 }, () => autoJoinDefaultWorkspaces('user:racej', 'Racer', 'user:racej', [t])),
    );
    expect(joined.filter((n) => n > 0).length, 'only one bind may perform the join').toBe(1);

    const mine = (await listMembers(t.tenantId, t.orgId)).filter((m) => m.subject === 'user:racej');
    expect(mine, 'a doubled claim doubles the member row').toHaveLength(1);
  });
});
