/**
 * ADR 0534 P1 — the work-selection projector and criteria set.
 *
 * The ranking ENGINE is already covered by `priority-matrix-scoring.test.ts`
 * (hoisted to `host/weightedScoring.ts` in P0). What is new here is POLICY: which
 * factors matter, and how a card's fields land on the engine's 1..10 band. So
 * these test the projection and the resulting ORDER, not the arithmetic.
 *
 * The bug this whole feature exists to fix — a `high` card filed today waiting
 * behind every `low` card ever filed — is the first ordering test below.
 */
import { describe, expect, it } from 'vitest';
import type { KanbanCard } from '../src/host/kanbanService.js';
import { rankByPriority, computePriority } from '../src/host/weightedScoring.js';
import {
  WORK_SELECTION_CRITERIA,
  WS_CRITERION,
  projectCardScores,
  urgencyScore,
  priorityScore,
  ageScore,
  blockedScore,
} from '../src/features/work-selection/compiler.js';
import { WORK_SELECTION_POLICY } from '../src/features/work-selection/service.js';

const NOW = Date.parse('2026-08-08T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

function card(patch: Partial<KanbanCard> & { id: string }): KanbanCard {
  return {
    boardId: 'b1',
    columnId: 'todo',
    title: patch.id,
    order: 0,
    createdAt: daysAgo(0),
    updatedAt: daysAgo(0),
    ...patch,
  } as KanbanCard;
}

const rank = (cards: KanbanCard[]) =>
  rankByPriority(WORK_SELECTION_CRITERIA, cards, (c) => projectCardScores(c, NOW)).map(
    (r) => r.item.id,
  );

describe('ADR 0534 P1 — the ordering bug this feature fixes', () => {
  it('a high card filed today beats a low card filed a month ago', () => {
    // Under FIFO (`order` = append position) the old low card wins forever.
    const oldLow = card({ id: 'old-low', priority: 'low', createdAt: daysAgo(30) });
    const newHigh = card({ id: 'new-high', priority: 'high', createdAt: daysAgo(0) });

    expect(rank([oldLow, newHigh])[0]).toBe('new-high');
  });

  it('an overdue card outranks a not-yet-due one of the same priority', () => {
    const overdue = card({ id: 'overdue', dueAt: daysAhead(-2) });
    const later = card({ id: 'later', dueAt: daysAhead(10) });

    expect(rank([later, overdue])[0]).toBe('overdue');
  });
});

describe('ADR 0534 P1 — the 0-means-unscored trap', () => {
  it('every projected score is >= 1, so "no data" never reads as "worthless"', () => {
    // `computePriority` treats 0 as UNSCORED and sinks the item. A bare card has
    // no dueAt, no priority and no blocker note — if any of those projected to 0
    // it would rank below everything permanently.
    const bare = card({ id: 'bare' });
    const scores = projectCardScores(bare, NOW);

    for (const [criterion, value] of Object.entries(scores)) {
      expect(value, `${criterion} projected 0 — that reads as unscored, not as low`).toBeGreaterThanOrEqual(1);
    }
    expect(computePriority(WORK_SELECTION_CRITERIA, scores)).toBeGreaterThan(0);
  });

  it('an undated card still beats a dated one once it is old enough', () => {
    // The anti-starvation guarantee (OQ-2): age is a real term, so the permanent
    // tail cannot be starved by a stream of dated work.
    const ancientUndated = card({ id: 'ancient', createdAt: daysAgo(60) });
    const freshDistant = card({ id: 'fresh', createdAt: daysAgo(0), dueAt: daysAhead(14) });

    expect(rank([freshDistant, ancientUndated])[0]).toBe('ancient');
  });
});

describe('ADR 0534 P1 — blocked is a COST (and damps crash loops)', () => {
  it('a blocked card sinks below an identical unblocked one', () => {
    const blocked = card({ id: 'blocked', blockerNote: 'waiting on legal' });
    const clear = card({ id: 'clear' });

    expect(rank([blocked, clear])[0]).toBe('clear');
  });

  it('a card ADR 0535 restored after a failed run is damped automatically', () => {
    // ADR 0534 OQ-4 / ADR 0535 OQ-3: crash-loop damping falls out of the cost
    // criterion rather than needing a bespoke retry damper. A card whose run
    // just failed carries a restore note, so it yields to healthy work.
    const restored = card({
      id: 'restored',
      priority: 'high',
      blockerNote: 'Returned to To Do — its run failed (run-123).',
    });
    const healthy = card({ id: 'healthy', priority: 'high' });

    expect(rank([restored, healthy])[0]).toBe('healthy');
  });

  it('clearing the note restores the card to its natural rank', () => {
    const cleared = card({ id: 'cleared', priority: 'high', blockerNote: '   ' });
    const normal = card({ id: 'normal', priority: 'normal' });

    expect(blockedScore(cleared), 'whitespace is not a blocker').toBe(1);
    expect(rank([normal, cleared])[0]).toBe('cleared');
  });
});

describe('ADR 0534 P1 — projections are pure and bounded', () => {
  it('urgency saturates at both ends and tolerates a bad date', () => {
    expect(urgencyScore(card({ id: 'a', dueAt: daysAhead(-100) }), NOW)).toBe(10);
    expect(urgencyScore(card({ id: 'b', dueAt: daysAhead(365) }), NOW)).toBe(3);
    expect(urgencyScore(card({ id: 'c' }), NOW)).toBe(2);
    expect(urgencyScore(card({ id: 'd', dueAt: 'not-a-date' }), NOW), 'garbage is absence, not urgency').toBe(2);
  });

  it('priority maps the three flags, with unset reading as normal', () => {
    expect(priorityScore(card({ id: 'h', priority: 'high' }))).toBe(10);
    expect(priorityScore(card({ id: 'n', priority: 'normal' }))).toBe(5);
    expect(priorityScore(card({ id: 'l', priority: 'low' }))).toBe(2);
    expect(priorityScore(card({ id: 'u' })), 'an unset flag is normal, not missing').toBe(5);
  });

  it('age saturates at 30 days and never dips below 1', () => {
    expect(ageScore(card({ id: 'new', createdAt: daysAgo(0) }), NOW)).toBe(1);
    expect(ageScore(card({ id: 'old', createdAt: daysAgo(30) }), NOW)).toBe(10);
    expect(ageScore(card({ id: 'ancient', createdAt: daysAgo(400) }), NOW)).toBe(10);
    expect(ageScore(card({ id: 'future', createdAt: daysAhead(5) }), NOW), 'a clock skew must not go negative').toBe(1);
  });

  it('is deterministic — the same card at the same instant always projects the same', () => {
    // The ADR 0534 D3 replay stamp is meaningless if the projection can drift.
    const c = card({ id: 'x', priority: 'high', dueAt: daysAhead(3), createdAt: daysAgo(9) });
    expect(projectCardScores(c, NOW)).toEqual(projectCardScores(c, NOW));
  });

  it('exposes exactly the four criteria the set declares', () => {
    // A projector that returns a key the set does not declare is silently
    // ignored by the engine; one that omits a declared key scores it 0 (=
    // unscored) and sinks every card. Both are silent, so pin the pairing.
    const projected = Object.keys(projectCardScores(card({ id: 'y' }), NOW)).sort();
    const declared = WORK_SELECTION_CRITERIA.criteria.map((c) => c.id).sort();

    expect(projected).toEqual(declared);
    expect(declared).toEqual([WS_CRITERION.age, WS_CRITERION.blocked, WS_CRITERION.priority, WS_CRITERION.urgency].sort());
  });
});

describe('ADR 0534 — the policy version is pinned to the criteria', () => {
  it('a criteria change must bump WORK_SELECTION_POLICY', () => {
    // The stamp in run.metadata records WHICH policy ranked a run. If the
    // criteria set changes without the version bumping, historical stamps
    // silently start describing a policy that no longer exists — and nothing
    // else in the system would notice. This fingerprint makes that a red test
    // instead: change the criteria, and you must change the version.
    const fingerprint = WORK_SELECTION_CRITERIA.criteria
      .map((c) => `${c.id}:${c.weight}:${c.direction}`)
      .sort()
      .join('|');

    expect(fingerprint).toBe(
      'ws.age:2:benefit|ws.blocked:7:cost|ws.priority:5:benefit|ws.urgency:10:benefit',
    );
    expect(WORK_SELECTION_POLICY, 'bump the version when the fingerprint above changes').toBe('work-selection@1');
  });
});
