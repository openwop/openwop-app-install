/**
 * Phase 11 `demo-kicktodo` (app-seeding-strategy.md §4, §7.1).
 *
 * The gap this closes is a chain, not one blank page: with no published
 * challenges Discover is empty, so Today is empty, so Plan / Progress / Journal
 * are empty — five surfaces that demo as blank and are indistinguishable from a
 * broken install. These tests pin the three properties that make the seeder
 * safe to run against a real tenant: it is idempotent, it is toggle-gated, and
 * `clear()` is surgical.
 *
 * Sabotages that turn these red (w41 probes): dropping the published-row
 * `continue` (idempotence), the toggle check, the `isDemo` filter or the
 * demo-ACTOR filter in clear() (surgical), versioning a retired lineage with
 * createDraft instead of createDraftVersion (round trip), the live-state filter
 * on the re-seed enrollment check, and swallowing an untyped enroll error.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { countDemoKicktodo, seedDemoKicktodo, clearDemoKicktodo } from '../src/host/demoKicktodoSeed.js';
import {
  createDraft, createDraftVersion, publishChallenge, listPublished, getLatest, ChallengeValidationError, listChallengeVersions,
} from '../src/features/kicktodo-core/challengeService.js';
import {
  enroll, listEnrollmentsFor, registerEnrollGuard, __clearEnrollGuards,
} from '../src/features/kicktodo-core/enrollmentService.js';
import { KICKTODO_DEMO_CHALLENGES, KICKTODO_DEMO_PREFIX, KICKTODO_DEMO_ACTOR } from '../src/host/seed-data/kicktodoDemo.js';

vi.mock('../src/host/featureToggles/service.js', async (orig) => {
  const actual = await orig<typeof import('../src/host/featureToggles/service.js')>();
  return { ...actual, resolveOne: vi.fn(async () => ({ enabled: toggleOn })) };
});
let toggleOn = true;

let storage: Awaited<ReturnType<typeof openStorage>>;
beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-kicktodo-seed-')) });
});
// Every case owns its toggle + guard state (shuffle-safe).
beforeEach(() => {
  toggleOn = true;
  __clearEnrollGuards();
});

describe('demo-kicktodo', () => {
  it('publishes the catalog and is idempotent — a second run creates nothing', async () => {
    toggleOn = true;
    const t = 'kt-seed-idem';
    const first = await seedDemoKicktodo(t);
    expect(first.created).toBeGreaterThanOrEqual(KICKTODO_DEMO_CHALLENGES.length);
    expect(await countDemoKicktodo(t)).toBe(KICKTODO_DEMO_CHALLENGES.length);

    const second = await seedDemoKicktodo(t);
    expect(second.created, 're-seed must create nothing').toBe(0);
    expect(await countDemoKicktodo(t)).toBe(KICKTODO_DEMO_CHALLENGES.length);
  });

  it('every seeded challenge is PUBLISHED — a draft would leave Discover empty', async () => {
    toggleOn = true;
    const t = 'kt-seed-published';
    await seedDemoKicktodo(t);
    const published = (await listPublished(t)).filter((c) => c.id.startsWith(KICKTODO_DEMO_PREFIX));
    expect(published).toHaveLength(KICKTODO_DEMO_CHALLENGES.length);
    for (const c of published) {
      expect(c.status).toBe('published');
      expect(c.activities.length, `${c.id} must carry a full curriculum`).toBe(c.durationDays);
    }
  });

  it('is toggle-gated: reports skipped rather than seeding when kicktodo-core is off', async () => {
    toggleOn = false;
    try {
      const t = 'kt-seed-off';
      const r = await seedDemoKicktodo(t);
      expect(r.created).toBe(0);
      expect(r.details?.skipped).toBe('kicktodo-core toggle off');
      toggleOn = true; // read back with the toggle ON: nothing was written while it was off
      expect(await countDemoKicktodo(t)).toBe(0);
    } finally {
      toggleOn = true;
    }
  });

  it('clear() is SURGICAL — an operator-authored challenge survives', async () => {
    toggleOn = true;
    const t = 'kt-seed-surgical';
    await seedDemoKicktodo(t);

    const mine = await createDraft({
      tenantId: t, title: 'My own challenge', summary: 's', outcome: 'o', durationDays: 1,
      activities: [{ stableActivityId: 'a1', day: 1, title: 'x', instructions: 'y', evidencePolicy: 'attestation' }],
    });
    await publishChallenge(t, mine.id, mine.version);
    // A REAL participant enrolled in a demo challenge keeps their pinned version
    // (PRD §13) — clear() abandons only the demo ACTOR's enrollments.
    // DOUBLE GUARD (w41 r2): this is held by TWO checks — clear()'s actor filter
    // (`e.ownerSubject !== KICKTODO_DEMO_ACTOR`, demoKicktodoSeed.ts) AND
    // abandonEnrollment's owner check (`e.ownerSubject !== actingSubject`,
    // enrollmentService.ts), since clear() always acts AS the demo actor. Removing
    // either alone stays green here (w41g4-seed-actor-only-r2 was vacuous); the
    // owner check is witnessed by kicktodo-core.test.ts "uniform 404: a foreign
    // participant cannot see or mutate my enrollment" (w41g4-abandon-owner-r3).
    const demoId = `${KICKTODO_DEMO_PREFIX}${KICKTODO_DEMO_CHALLENGES[0]!.slug}`;
    const { enrollment: real } = await enroll({ tenantId: t, ownerSubject: 'user:real-participant', challengeId: demoId, challengeVersion: 1, timezone: 'UTC' });

    const cleared = await clearDemoKicktodo(t);
    // `cleared` counts every demo entity removed: N retired challenges + the
    // demo actor's one abandoned enrollment. Neither touches the operator's rows.
    expect(cleared.details?.retired).toBe(KICKTODO_DEMO_CHALLENGES.length);
    expect(cleared.details?.abandoned).toBe(1);
    expect(cleared.cleared).toBe(KICKTODO_DEMO_CHALLENGES.length + 1);
    expect(await countDemoKicktodo(t)).toBe(0);
    const realAfter = (await listEnrollmentsFor(t, 'user:real-participant')).find((e) => e.id === real.id);
    expect(realAfter?.state, 'a real participant on a demo challenge is never abandoned').toBe('active');
    expect(realAfter?.challengeVersion).toBe(1);

    const left = await listPublished(t);
    expect(left.map((c) => c.id), 'the operator-authored challenge must survive').toContain(mine.id);
    expect(left.some((c) => c.id.startsWith(KICKTODO_DEMO_PREFIX))).toBe(false);
  });

  // §2 "clear is symmetric": the first cut retired v1 and then, on the next
  // seed, handed the RETIRED row to publishChallenge — ChallengeImmutableError on
  // every seed after the first clear. A lineage is immutable; the way back is a
  // new version at the same deterministic id.
  it('clear() → seed() ROUND-TRIPS: the retired lineage gets a NEW VERSION, not a thrown ChallengeImmutableError', async () => {
    toggleOn = true;
    const t = 'kt-seed-roundtrip';
    await seedDemoKicktodo(t);
    await clearDemoKicktodo(t);
    expect(await countDemoKicktodo(t)).toBe(0);

    const again = await seedDemoKicktodo(t); // used to throw here
    expect(again.created).toBeGreaterThanOrEqual(KICKTODO_DEMO_CHALLENGES.length);
    expect(await countDemoKicktodo(t)).toBe(KICKTODO_DEMO_CHALLENGES.length);
    for (const c of KICKTODO_DEMO_CHALLENGES) {
      const latest = await getLatest(t, `${KICKTODO_DEMO_PREFIX}${c.slug}`);
      expect(latest?.status, c.slug).toBe('published');
      expect(latest?.version, `${c.slug} must be a new version, the retired v1 is immutable`).toBe(2);
    }
    // And once more: the third seed is a no-op again (idempotence survives the round trip).
    expect((await seedDemoKicktodo(t)).created).toBe(0);
  });

  it('clear() ABANDONS the demo actor\'s enrollment (symmetric), and a re-seed enrolls again', async () => {
    toggleOn = true;
    const t = 'kt-seed-enroll-sym';
    const first = await seedDemoKicktodo(t);
    expect(first.details?.enrolled, 'the participant surfaces need one enrollment').toBe(1);
    const live = (await listEnrollmentsFor(t, KICKTODO_DEMO_ACTOR)).filter((e) => e.state === 'active');
    expect(live).toHaveLength(1);

    const cleared = await clearDemoKicktodo(t);
    expect(cleared.details?.abandoned).toBe(1);
    expect((await listEnrollmentsFor(t, KICKTODO_DEMO_ACTOR)).every((e) => e.state === 'abandoned')).toBe(true);

    const again = await seedDemoKicktodo(t);
    expect(again.details?.enrolled, 'a re-seed must enroll again or Today is blank').toBe(1);
    const liveAgain = (await listEnrollmentsFor(t, KICKTODO_DEMO_ACTOR)).filter((e) => e.state === 'active');
    expect(liveAgain).toHaveLength(1);
    expect(liveAgain[0]!.challengeVersion, 'pinned to the NEW version').toBe(2);
  });

  it('enroll(): a TYPED refusal is reported as enrolled:0; anything else is RETHROWN, never swallowed', async () => {
    try {
      registerEnrollGuard(async () => ({ ok: false, reason: 'capacity' }));
      const refused = await seedDemoKicktodo('kt-seed-refused');
      expect(refused.details?.enrolled).toBe(0);
      expect(refused.details?.challenges).toBe(KICKTODO_DEMO_CHALLENGES.length);
      __clearEnrollGuards();

      registerEnrollGuard(async () => { throw new Error('storage exploded'); });
      await expect(seedDemoKicktodo('kt-seed-exploded')).rejects.toThrow('storage exploded');
    } finally {
      __clearEnrollGuards();
    }
  });

  it('createDraftVersion(): refuses while the latest is a draft, then increments after publish', async () => {
    const t = 'kt-cdv';
    const base = {
      tenantId: t, id: 'chal:cdv', title: 'v', summary: 's', outcome: 'o', durationDays: 1,
      activities: [{ stableActivityId: 'a1', day: 1, title: 'x', instructions: 'y', evidencePolicy: 'attestation' as const }],
    };
    expect(await createDraftVersion(base), 'no lineage yet').toBeNull();
    const v1 = await createDraft(base);
    await expect(createDraftVersion(base)).rejects.toBeInstanceOf(ChallengeValidationError);
    await publishChallenge(t, v1.id, v1.version);
    const v2 = await createDraftVersion({ ...base, title: 'v2' });
    expect(v2?.version).toBe(2);
    expect(v2?.status).toBe('draft');
    expect((await getLatest(t, 'chal:cdv'))?.version).toBe(2);
  });

  /**
   * KTSEED-3 (KickTodo wave 4C) — each clear/seed cycle used to leave the retired
   * version AND the demo actor's abandoned enrollment behind forever (two cycles ⇒
   * three versions and two abandoned rows per tenant). The re-seed now prunes its
   * own residue, and only its own: a version a REAL participant still pins is kept.
   * Breaks if `pruneDemoResidue` is not called, or prunes a pinned version
   * (sabotage-witnessed: drop the `pinned.has(...)` guard → the real participant's
   * v1 disappears).
   */
  it('KTSEED-3 — repeated clear/seed cycles do not accumulate retired versions or abandoned enrollments', async () => {
    toggleOn = true;
    const t = 'kt-seed-residue';
    await seedDemoKicktodo(t);
    const pinnedId = `${KICKTODO_DEMO_PREFIX}${KICKTODO_DEMO_CHALLENGES[0]!.slug}`;
    // A real participant pins v1 of the first demo challenge.
    await enroll({ tenantId: t, ownerSubject: 'user:real-pinned', challengeId: pinnedId, challengeVersion: 1, timezone: 'UTC' });
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await clearDemoKicktodo(t);
      await seedDemoKicktodo(t);
    }
    const actorRows = await listEnrollmentsFor(t, KICKTODO_DEMO_ACTOR);
    expect(actorRows.map((e) => e.state), 'only the live demo enrollment is left').toEqual(['active']);
    for (const c of KICKTODO_DEMO_CHALLENGES) {
      const id = `${KICKTODO_DEMO_PREFIX}${c.slug}`;
      const versions = (await listChallengeVersions(t, id)).map((v) => `${v.version}:${v.status}`);
      expect(versions, c.slug).toEqual(id === pinnedId ? ['1:retired', '3:published'] : ['3:published']);
    }
    // Idempotent: one more seed changes nothing.
    await seedDemoKicktodo(t);
    expect((await listChallengeVersions(t, pinnedId)).map((v) => v.version)).toEqual([1, 3]);
  });
});
