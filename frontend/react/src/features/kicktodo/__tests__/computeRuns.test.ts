/**
 * ADR 0436 §5.4 commitment ledger — the rhythm-runs collapse invariants
 * (grade-pass F5-nit: the one non-trivial pure function in the ledger diff
 * had no unit test). Pins: identical consecutive days collapse; a day-number
 * gap NEVER collapses; a content change NEVER collapses; minutes and
 * evidencePolicy are part of the signature; empty input → empty output.
 */
import { describe, it, expect } from 'vitest';
import { computeRuns } from '../ChallengeDetailPage.js';
import type { ChallengeActivity } from '../../../client/kicktodoClient.js';

const act = (day: number, title: string, minutes = 20, evidence = 'note'): ChallengeActivity => ({
  stableActivityId: `a-${day}-${title}`,
  day,
  title,
  instructions: 'x',
  evidencePolicy: evidence,
  estimatedMinutes: minutes,
});

const byDay = (acts: ChallengeActivity[]): Array<[number, ChallengeActivity[]]> => {
  const map = new Map<number, ChallengeActivity[]>();
  for (const a of acts) { const g = map.get(a.day) ?? []; g.push(a); map.set(a.day, g); }
  return [...map.entries()].sort(([x], [y]) => x - y);
};

describe('computeRuns', () => {
  it('collapses consecutive identical days and breaks on the synthesis day', () => {
    const acts = [
      ...[1, 2, 3, 4, 5, 6].map((d) => act(d, 'Read 20 minutes')),
      act(7, 'Mid-book synthesis', 25),
      ...[8, 9, 10].map((d) => act(d, 'Read 20 minutes')),
    ];
    const runs = computeRuns(byDay(acts));
    expect(runs.map((r) => [r.from, r.to])).toEqual([[1, 6], [7, 7], [8, 10]]);
  });

  it('never collapses across a day-number gap, even with identical content', () => {
    const runs = computeRuns(byDay([act(1, 'Walk'), act(3, 'Walk')]));
    expect(runs.map((r) => [r.from, r.to])).toEqual([[1, 1], [3, 3]]);
  });

  it('breaks a run when minutes or evidence policy change (signature fields)', () => {
    const runs = computeRuns(byDay([
      act(1, 'Walk', 10), act(2, 'Walk', 15), // minutes differ
      act(3, 'Walk', 15, 'photo'),            // evidence differs
    ]));
    expect(runs.map((r) => [r.from, r.to])).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it('keeps multi-activity days intact and collapses only exact matches', () => {
    const runs = computeRuns(byDay([
      act(1, 'Walk'), act(1, 'Stretch', 5),
      act(2, 'Walk'), act(2, 'Stretch', 5),
      act(3, 'Walk'), // second activity missing → breaks
    ]));
    expect(runs.map((r) => [r.from, r.to])).toEqual([[1, 2], [3, 3]]);
    expect(runs[0]!.acts).toHaveLength(2);
  });

  it('handles empty input and all-distinct days', () => {
    expect(computeRuns([])).toEqual([]);
    const runs = computeRuns(byDay([act(1, 'A'), act(2, 'B'), act(3, 'C')]));
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.from === r.to)).toBe(true);
  });
});
