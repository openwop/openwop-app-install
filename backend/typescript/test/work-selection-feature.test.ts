/**
 * ADR 0534 P3 — the feature end-to-end: toggle gate, replay stamp, reason vocabulary.
 *
 * P1 tested the policy in isolation and P2 tested the seam's fail-open. What is
 * new here is the wiring that only exists once the feature is real: does the
 * per-tenant toggle actually gate ranking, and does the winning card's decision
 * get frozen into `run.metadata` so a `:fork` cannot re-rank?
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerToggleDefault, __resetToggleDefaults } from '../src/host/featureToggles/registry.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import {
  registerWorkSelectionCompiler,
  setWorkSelectionPolicyId,
  orderWorkCandidates,
  workSelectionStamp,
} from '../src/host/heartbeatService.js';
import { workSelectionCompiler, WORK_SELECTION_POLICY } from '../src/features/work-selection/service.js';
import { workSelectionFeature } from '../src/features/work-selection/feature.js';
import type { KanbanCard } from '../src/host/kanbanService.js';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const T = 'ws-feature-t1';
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function card(id: string, patch: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id, boardId: 'b1', columnId: 'todo', title: id, order: 0,
    createdAt: daysAgo(0), updatedAt: daysAgo(0), ...patch,
  } as KanbanCard;
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
      ids(await orderWorkCandidates(input, NOW, T)),
      'a tenant that never opted in must see exactly the old order',
    ).toEqual(['old-low', 'new-high']);
  });

  it('ON ⇒ the high card wins', async () => {
    seedToggle('on');
    const input = [card('old-low', { priority: 'low', createdAt: daysAgo(30) }), card('new-high', { priority: 'high' })];

    expect(ids(await orderWorkCandidates(input, NOW, T))[0]).toBe('new-high');
  });

  it('an unregistered toggle fails CLOSED to insertion order', async () => {
    // No default registered at all — an unresolvable toggle must not silently
    // enable a behaviour change for a tenant that never opted in.
    const input = [card('a'), card('b', { priority: 'high' })];
    expect(ids(await orderWorkCandidates(input, NOW, T))).toEqual(['a', 'b']);
  });
});

describe('ADR 0534 D3 — the replay stamp', () => {
  it('freezes the winning decision as plain JSON', async () => {
    seedToggle('on');
    await orderWorkCandidates([card('a', { priority: 'high' }), card('b', { priority: 'low' })], NOW, T);

    const stamp = workSelectionStamp('a');
    expect(stamp).toMatchObject({ policy: WORK_SELECTION_POLICY, rank: 1, candidates: 2 });
    expect(typeof stamp?.score).toBe('number');
    // Must survive a JSON round-trip — `run.metadata` is persisted and replayed
    // verbatim, so a live reference here would not survive a fork.
    expect(JSON.parse(JSON.stringify(stamp))).toEqual(stamp);
  });

  it('records how many candidates the rank was against', async () => {
    // Rank 1 of 1 says much less than rank 1 of 40, and the difference is
    // invisible without this.
    seedToggle('on');
    await orderWorkCandidates([card('only')], NOW, T);
    expect(workSelectionStamp('only')).toMatchObject({ rank: 1, candidates: 1 });
  });

  it('is absent when the toggle is off, so the stamp never claims a decision that did not happen', async () => {
    seedToggle('off');
    await orderWorkCandidates([card('a')], NOW, T);
    expect(workSelectionStamp('a')).toBeNull();
  });
});
