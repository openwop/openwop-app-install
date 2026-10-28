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
 *
 * Every rejected result (throw, drop, duplicate, unknown) must also return NO
 * decisions for the run stamp. Since ADR 0963 D6 `rankWorkCandidates` RETURNS
 * `{ cards, decisions }` (no module state; `lastPicks` and
 * `workSelectionDecisionFor` are gone), and every rejection returns the shared
 * `none` value with an empty map (`src/host/heartbeatService.ts:462`).
 *
 * Double guard (honest, by design): `rankWorkCandidates` checks the pick COUNT
 * (`picks.length !== cards.length`, heartbeatService.ts:467) and then the pick
 * SET (`seen.size` + every input present, :474). The set check alone catches a
 * drop and a duplicate, so deleting only the count check stays green (wave 64
 * probe 8fw5g2-ws-length-check, vacuous); deleting both reds the drop case
 * (8fw5g2-ws-length-check-r4). Only the set check's `every` catches an UNKNOWN
 * card (8fw5g2-ws-unknown-only-r4).
 *
 * Sabotage that turns it red: the throw caught into `[]`; both permutation
 * checks removed; a rejection that returns the compiler's picks as decisions
 * (8fw5g2-ws-reject-decisions-r4); the empty-list short-circuit removed; picks
 * not mapped back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerWorkSelectionCompiler,
  rankWorkCandidates,
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
  };
}

const pick = (c: KanbanCard, rank: number): WorkSelectionPick => ({
  card: c,
  rank,
  score: 10 - rank,
  scores: { 'ws.priority': 5 },
});

const ids = (cards: KanbanCard[]) => cards.map((c) => c.id);
const T = 'ws-tenant-1';
const order = async (cards: KanbanCard[]) => (await rankWorkCandidates(cards, NOW, T)).cards;
/** A rejected ranking: insertion order AND no decisions at all. */
async function expectRejected(input: KanbanCard[]): Promise<void> {
  const ranked = await rankWorkCandidates(input, NOW, T);
  expect(ids(ranked.cards)).toEqual(ids(input));
  expect([...ranked.decisions.keys()], 'a rejected result returns no decision to stamp').toEqual([]);
}

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
    await expectRejected([card('a', 0), card('b', 1)]);
  });

  it('a compiler that returns a DUPLICATE ⇒ insertion order', async () => {
    registerWorkSelectionCompiler((cards) => [pick(cards[0]!, 1), pick(cards[0]!, 2)]);
    await expectRejected([card('a', 0), card('b', 1)]);
  });

  it('a compiler that invents an UNKNOWN card ⇒ insertion order', async () => {
    registerWorkSelectionCompiler((cards) => [pick(cards[0]!, 1), pick(card('ghost', 9), 2)]);
    await expectRejected([card('a', 0), card('b', 1)]);
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

  it('returns the decision for the run stamp, and a pass with no compiler returns none', async () => {
    registerWorkSelectionCompiler((cards) => cards.map((c, i) => pick(c, i + 1)));
    const ranked = await rankWorkCandidates([card('a', 0)], NOW, T);

    expect(ranked.decisions.get('a')?.rank).toBe(1);

    // ADR 0963 D6 — decisions are the pass's own, so a later pass cannot read an
    // earlier one's: a stale stamp would be attributed to the wrong run.
    registerWorkSelectionCompiler(null);
    expect((await rankWorkCandidates([card('a', 0)], NOW, T)).decisions.get('a')).toBeUndefined();
  });

  it('a rejected result leaves no decision behind', async () => {
    registerWorkSelectionCompiler(() => { throw new Error('bug'); });
    const ranked = await rankWorkCandidates([card('a', 0)], NOW, T);

    expect(
      ranked.decisions.get('a'),
      'stamping a decision that did not order anything would be a lie in run.metadata',
    ).toBeUndefined();
  });
});
