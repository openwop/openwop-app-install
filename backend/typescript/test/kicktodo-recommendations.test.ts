/**
 * ADR 0692 — KickTodo-local recommendations are deterministic, explainable, and
 * self-data only:
 *  - a newcomer gets starters (beginner / unlabeled) first;
 *  - a completed beginner promotes next-depth (intermediate) over same-depth over
 *    the rest; anything in flight or completed is never recommended;
 *  - the pure ranker orders by reason then title, so two reads agree;
 *  - another participant's enrollments never move the caller's list.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards, __test as coreStore } from '../src/features/kicktodo-core/enrollmentService.js';
import { rankRecommendations, recommendedChallengesFor } from '../src/features/kicktodo-core/recommendationService.js';

const T = 'tenant-reco';
const ME = 'user:reco-me';
const OTHER = 'user:reco-other';
const ids: Record<string, string> = {};

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  const specs: Array<[string, 'beginner' | 'intermediate' | 'advanced' | undefined]> = [
    ['Sleep Reset', 'beginner'], ['Morning Movement', 'beginner'], ['Deep Work', 'intermediate'], ['Focus Sprint', 'intermediate'], ['Marathon Base', 'advanced'], ['Unlabeled Habit', undefined],
  ];
  for (const [title, depthLevel] of specs) {
    const draft = await createDraft({
      tenantId: T, title, summary: 's', outcome: 'o', durationDays: 3, ...(depthLevel ? { depthLevel } : {}),
      activities: [{ stableActivityId: 'a', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
    });
    await publishChallenge(T, draft.id, 1);
    ids[title] = draft.id;
  }
});

describe('rankRecommendations (pure)', () => {
  const catalog = [
    { id: 'c3', version: 1, title: 'Cee', depthLevel: 'advanced' as const },
    { id: 'c1', version: 1, title: 'Aye', depthLevel: 'beginner' as const },
    { id: 'c2', version: 1, title: 'Bee', depthLevel: 'intermediate' as const },
    { id: 'c4', version: 1, title: 'Dee' },
  ];
  it('newcomer: starters first (beginner, unlabeled), the rest as more, titles alphabetical within a reason', () => {
    const out = rankRecommendations({ catalog, excludeIds: new Set(), deepestCompleted: null, deepestInFlight: null, hasAnyEnrollment: false, limit: 10 });
    expect(out.map((r) => [r.id, r.reason])).toEqual([['c1', 'starter'], ['c4', 'starter'], ['c2', 'more'], ['c3', 'more']]);
  });
  it('completed beginner: next-depth before same-depth before more; excluded ids never appear; limit applies', () => {
    const out = rankRecommendations({ catalog, excludeIds: new Set(['c1']), deepestCompleted: 'beginner', deepestInFlight: null, hasAnyEnrollment: true, limit: 2 });
    expect(out.map((r) => [r.id, r.reason])).toEqual([['c2', 'next-depth'], ['c3', 'more']]);
    expect(out.some((r) => r.id === 'c1')).toBe(false);
  });
  it('in flight only (nothing completed): same-depth is the anchor, no next-depth', () => {
    const out = rankRecommendations({ catalog, excludeIds: new Set(['c2']), deepestCompleted: null, deepestInFlight: 'intermediate', hasAnyEnrollment: true, limit: 10 });
    expect(out.map((r) => r.reason)).toEqual(['more', 'more', 'more']);
  });
});

describe('recommendedChallengesFor (store-backed, self-data only)', () => {
  it('a newcomer sees starters; another participant’s enrollments do not change it', async () => {
    await enroll({ tenantId: T, ownerSubject: OTHER, challengeId: ids['Marathon Base']!, challengeVersion: 1, timezone: 'UTC' });
    const out = await recommendedChallengesFor(T, ME);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.title)).toEqual(['Morning Movement', 'Sleep Reset', 'Unlabeled Habit']);
    expect(out.every((r) => r.reason === 'starter')).toBe(true);
  });

  it('after completing a beginner challenge, intermediate is next-depth and the finished one is excluded', async () => {
    const { enrollment } = await enroll({ tenantId: T, ownerSubject: ME, challengeId: ids['Sleep Reset']!, challengeVersion: 1, timezone: 'UTC' });
    // In flight: excluded, and with nothing completed the anchor is same-depth.
    const inFlight = await recommendedChallengesFor(T, ME, 10);
    expect(inFlight.some((r) => r.id === ids['Sleep Reset'])).toBe(false);
    expect(inFlight.find((r) => r.id === ids['Morning Movement'])?.reason).toBe('same-depth');
    // Complete it (store-level, the same seam the judge writes).
    await coreStore.enrollments.put({ ...enrollment, state: 'completed' });
    const done = await recommendedChallengesFor(T, ME, 10);
    expect(done.slice(0, 2).map((r) => [r.title, r.reason])).toEqual([['Deep Work', 'next-depth'], ['Focus Sprint', 'next-depth']]);
    expect(done.find((r) => r.title === 'Morning Movement')?.reason).toBe('same-depth');
    expect(done.some((r) => r.id === ids['Sleep Reset'])).toBe(false);
  });
});
