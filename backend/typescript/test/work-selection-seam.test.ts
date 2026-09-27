/**
 * ADR 0534 P2 — the core seam and its fail-open contract.
 *
 * `heartbeatService` is core and must not import a feature, so the ranking
 * policy is registered into it at boot (the ADR 0318 precedent). The load-bearing
 * assertion here is the FALLBACK: 0318's provider returns config, so falling open
 * to null restores prior behaviour exactly; this one returns a DECISION, so "fail
 * open" has to mean the literal pre-0534 order — insertion order — and never a
 * degraded ranking. A broken compiler that quietly became "rank badly" would be
 * worse than no ranking and far harder to notice.
 *
 * The permutation checks are not paranoia: the contract is ORDER, not filter, so
 * a compiler that drops a card would make work silently unreachable — the same
 * class of bug as the strand ADR 0535 fixes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerWorkSelectionCompiler,
  orderWorkCandidates,
  workSelectionDecisionFor,
  type WorkSelectionPick,
} from '../src/host/heartbeatService.js';
import type { KanbanCard } from '../src/host/kanbanService.js';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');

function card(id: string, order: number): KanbanCard {
  return {
    id,
    boardId: 'b1',
    columnId: 'todo',
    title: id,
    order,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  } as KanbanCard;
}

const pick = (c: KanbanCard, rank: number): WorkSelectionPick => ({
  card: c,
  rank,
  score: 10 - rank,
  scores: { 'ws.priority': 5 },
});

const ids = (cards: KanbanCard[]) => cards.map((c) => c.id);
const T = 'ws-tenant-1';
const order = (cards: KanbanCard[]) => orderWorkCandidates(cards, NOW, T);

afterEach(() => registerWorkSelectionCompiler(null));

describe('ADR 0534 P2 — fail open to the literal pre-0534 order', () => {
  it('no compiler registered ⇒ insertion order, untouched', async () => {
    const input = [card('a', 0), card('b', 1), card('c', 2)];
    expect(ids(await order(input))).toEqual(['a', 'b', 'c']);
  });

  it('a throwing compiler ⇒ insertion order, not an empty pick list', async () => {
    registerWorkSelectionCompiler(() => { throw new Error('policy bug'); });
    const input = [card('a', 0), card('b', 1)];

    expect(
      ids(await order(input)),
      'a thrown error must not silently empty the queue — that would stall the loop',
    ).toEqual(['a', 'b']);
  });

  it('a compiler that DROPS a card ⇒ insertion order', async () => {
    // Dropping makes work unreachable with no error anywhere — the same silent
    // class as the ADR 0535 strand.
    registerWorkSelectionCompiler((cards) => [pick(cards[0]!, 1)]);
    const input = [card('a', 0), card('b', 1)];

    expect(ids(await order(input))).toEqual(['a', 'b']);
  });

  it('a compiler that returns a DUPLICATE ⇒ insertion order', async () => {
    registerWorkSelectionCompiler((cards) => [pick(cards[0]!, 1), pick(cards[0]!, 2)]);
    const input = [card('a', 0), card('b', 1)];

    expect(ids(await order(input))).toEqual(['a', 'b']);
  });

  it('a compiler that invents an UNKNOWN card ⇒ insertion order', async () => {
    registerWorkSelectionCompiler((cards) => [pick(cards[0]!, 1), pick(card('ghost', 9), 2)]);
    const input = [card('a', 0), card('b', 1)];

    expect(ids(await order(input))).toEqual(['a', 'b']);
  });

  it('an empty candidate list short-circuits without calling the compiler', async () => {
    let called = false;
    registerWorkSelectionCompiler((cards) => { called = true; return cards.map((c, i) => pick(c, i + 1)); });

    expect(await order([])).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('ADR 0534 P2 — a healthy compiler ranks', () => {
  it('reorders the candidates', async () => {
    registerWorkSelectionCompiler((cards) =>
      [...cards].reverse().map((c, i) => pick(c, i + 1)),
    );
    const input = [card('a', 0), card('b', 1), card('c', 2)];

    expect(ids(await order(input))).toEqual(['c', 'b', 'a']);
  });

  it('exposes the decision for the run stamp, and clears it between passes', async () => {
    registerWorkSelectionCompiler((cards) => cards.map((c, i) => pick(c, i + 1)));
    await order([card('a', 0)]);

    expect(workSelectionDecisionFor('a')?.rank).toBe(1);

    // A later pass with no compiler must not leave the previous pass's decision
    // readable — a stale stamp would be attributed to the wrong run.
    registerWorkSelectionCompiler(null);
    await order([card('a', 0)]);
    expect(workSelectionDecisionFor('a')).toBeUndefined();
  });

  it('a rejected result leaves no decision behind', async () => {
    registerWorkSelectionCompiler(() => { throw new Error('bug'); });
    await order([card('a', 0)]);

    expect(
      workSelectionDecisionFor('a'),
      'stamping a decision that did not order anything would be a lie in run.metadata',
    ).toBeUndefined();
  });
});
