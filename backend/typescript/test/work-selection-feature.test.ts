/**
 * ADR 0534 P3 — the feature end-to-end: the toggle gate and the replay stamp.
 *
 * P1 tested the policy in isolation and P2 tested the seam's fail-open. What is
 * new here is the wiring that only exists once the feature is real: does the
 * per-tenant toggle actually gate ranking (failing CLOSED when unregistered), and
 * is the winning card's decision available as the plain-JSON stamp that
 * `run.metadata` reads (ADR 0534 D3), so a `:fork` cannot re-rank? (The
 * `run.metadata` seat itself is wired in `heartbeatService.ts` and is not
 * exercised here.)
 * Sabotages witnessed (/grade-tests 8f W5, 8fw5g6-ws-*): the toggle check, the
 * unregistered fail-closed default, the stamp's rank / candidates / JSON copy, and
 * a toggle-off pass returning no decision to stamp. (CORRECTED on the ADR 0963
 * rebase: this used to say "the per-pass reset of the last picks". D6 removed that
 * module state; `rankWorkCandidates` now RETURNS the pass's decisions and
 * `workSelectionStamp(decisions, id)` reads them, `heartbeatService.ts:457,498`.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerToggleDefault, __resetToggleDefaults } from '../src/host/featureToggles/registry.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import {
  registerWorkSelectionCompiler,
  setWorkSelectionPolicyId,
  rankWorkCandidates,
  workSelectionStamp,
} from '../src/host/heartbeatService.js';
import { workSelectionCompiler, WORK_SELECTION_POLICY } from '../src/features/work-selection/service.js';
import { workSelectionFeature } from '../src/features/work-selection/feature.js';
import type { KanbanCard } from '../src/host/kanbanService.js';
import { WS_CRITERION } from '../src/features/work-selection/compiler.js';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const T = 'ws-feature-t1';
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function card(id: string, patch: Partial<KanbanCard> = {}): KanbanCard {
  const c: KanbanCard = {
    id, boardId: 'b1', columnId: 'todo', title: id, order: 0,
    createdAt: daysAgo(0), updatedAt: daysAgo(0), ...patch,
  };
  return c;
}

const ids = (cards: KanbanCard[]) => cards.map((c) => c.id);

/** Register the toggle default with the given status, as boot would. */
function seedToggle(status: 'on' | 'off'): void {
  registerToggleDefault({ ...workSelectionFeature.toggleDefault!, status });
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __clearToggleStore();
  __resetToggleDefaults();
  registerWorkSelectionCompiler(workSelectionCompiler);
  setWorkSelectionPolicyId(WORK_SELECTION_POLICY);
});

afterEach(async () => {
  registerWorkSelectionCompiler(null);
  setWorkSelectionPolicyId(null);
  __resetToggleDefaults();
  await __clearToggleStore();
  __resetHostExtPersistence();
});

describe('ADR 0534 P3 — the toggle gates ranking', () => {
  it('OFF ⇒ insertion order (the pre-0534 behaviour, unchanged)', async () => {
    seedToggle('off');
    const input = [card('old-low', { priority: 'low', createdAt: daysAgo(30) }), card('new-high', { priority: 'high' })];

    expect(
      ids((await rankWorkCandidates(input, NOW, T)).cards),
      'a tenant that never opted in must see exactly the old order',
    ).toEqual(['old-low', 'new-high']);
  });

  it('ON ⇒ the high card wins', async () => {
    seedToggle('on');
    const input = [card('old-low', { priority: 'low', createdAt: daysAgo(30) }), card('new-high', { priority: 'high' })];

    expect(ids((await rankWorkCandidates(input, NOW, T)).cards)[0]).toBe('new-high');
  });

  it('an unregistered toggle fails CLOSED to insertion order', async () => {
    // No default registered at all — an unresolvable toggle must not silently
    // enable a behaviour change for a tenant that never opted in.
    const input = [card('a'), card('b', { priority: 'high' })];
    expect(ids((await rankWorkCandidates(input, NOW, T)).cards)).toEqual(['a', 'b']);
  });
});

describe('ADR 0534 D3 — the replay stamp', () => {
  it('freezes the winning decision as plain JSON', async () => {
    seedToggle('on');
    const { decisions } = await rankWorkCandidates([card('a', { priority: 'high' }), card('b', { priority: 'low' })], NOW, T);

    const stamp = workSelectionStamp(decisions, 'a');
    expect(stamp).toMatchObject({ policy: WORK_SELECTION_POLICY, rank: 1, candidates: 2 });
    expect(typeof stamp?.score).toBe('number');
    // The per-criterion scores, keyed by the criterion ids the compiler owns (SSoT).
    const scores = stamp?.scores;
    if (typeof scores !== 'object' || scores === null) throw new Error('stamp.scores is not an object');
    expect(Object.keys(scores).sort()).toEqual(Object.values(WS_CRITERION).sort());
    // Must survive a JSON round-trip — `run.metadata` is persisted and replayed
    // verbatim, so a live reference here would not survive a fork.
    expect(JSON.parse(JSON.stringify(stamp))).toEqual(stamp);
  });

  it('records how many candidates the rank was against', async () => {
    // Rank 1 of 1 says much less than rank 1 of 40, and the difference is
    // invisible without this.
    seedToggle('on');
    // Three candidates (an asymmetric count: a constant `candidates: 1` or `2` is red).
    const { decisions } = await rankWorkCandidates([card('only', { priority: 'high' }), card('x'), card('y')], NOW, T);
    expect(workSelectionStamp(decisions, 'only')).toMatchObject({ rank: 1, candidates: 3 });
  });

  it('is absent when the toggle is off, so the stamp never claims a decision that did not happen', async () => {
    // Positive control first: the same input ON does stamp `a`, so the null below
    // is the toggle's doing, not an input the ranker never stamps.
    seedToggle('on');
    expect(workSelectionStamp((await rankWorkCandidates([card('a')], NOW, T)).decisions, 'a')).not.toBeNull();
    __resetToggleDefaults();
    seedToggle('off');
    const { decisions } = await rankWorkCandidates([card('a')], NOW, T);
    expect(workSelectionStamp(decisions, 'a')).toBeNull();
  });
});
