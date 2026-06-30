import { describe, it, expect } from 'vitest';
import { planBoardroomTurns, orderConveneCohort, type BoardroomTurnPolicy } from '../boardroomCadence.js';

const policy = (over: Partial<BoardroomTurnPolicy> = {}): BoardroomTurnPolicy => ({
  rounds: 1, order: 'declared', synthesize: false, ...over,
});

describe('planBoardroomTurns', () => {
  it('plans one declared round of advisors, excluding the chair', () => {
    const turns = planBoardroomTurns(
      { chairAgentId: 'chair', advisorAgentIds: ['a', 'b', 'c'] },
      policy(),
    );
    expect(turns).toEqual([
      { agentId: 'a', kind: 'advisor', round: 0 },
      { agentId: 'b', kind: 'advisor', round: 0 },
      { agentId: 'c', kind: 'advisor', round: 0 },
    ]);
  });

  it('drops the chair from the advisor rotation even if listed among advisors', () => {
    const turns = planBoardroomTurns(
      { chairAgentId: 'a', advisorAgentIds: ['a', 'b', 'c'] },
      policy(),
    );
    expect(turns.map((t) => t.agentId)).toEqual(['b', 'c']);
  });

  it('appends a chair synthesis turn when synthesize is set', () => {
    const turns = planBoardroomTurns(
      { chairAgentId: 'chair', advisorAgentIds: ['a', 'b'] },
      policy({ synthesize: true }),
    );
    expect(turns).toEqual([
      { agentId: 'a', kind: 'advisor', round: 0 },
      { agentId: 'b', kind: 'advisor', round: 0 },
      { agentId: 'chair', kind: 'synthesis', round: 1 },
    ]);
  });

  it('omits synthesis when there is no chair', () => {
    const turns = planBoardroomTurns(
      { chairAgentId: null, advisorAgentIds: ['a', 'b'] },
      policy({ synthesize: true }),
    );
    expect(turns.every((t) => t.kind === 'advisor')).toBe(true);
  });

  it('rotates the starting advisor each round under round-robin', () => {
    const turns = planBoardroomTurns(
      { chairAgentId: 'chair', advisorAgentIds: ['a', 'b', 'c'] },
      policy({ rounds: 3, order: 'round-robin' }),
    );
    expect(turns.filter((t) => t.round === 0).map((t) => t.agentId)).toEqual(['a', 'b', 'c']);
    expect(turns.filter((t) => t.round === 1).map((t) => t.agentId)).toEqual(['b', 'c', 'a']);
    expect(turns.filter((t) => t.round === 2).map((t) => t.agentId)).toEqual(['c', 'a', 'b']);
  });

  it('repeats the declared order each round under declared ordering', () => {
    const turns = planBoardroomTurns(
      { chairAgentId: 'chair', advisorAgentIds: ['a', 'b'] },
      policy({ rounds: 2, order: 'declared' }),
    );
    expect(turns.map((t) => t.agentId)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('returns just the synthesis turn when there are no advisors', () => {
    const turns = planBoardroomTurns(
      { chairAgentId: 'chair', advisorAgentIds: [] },
      policy({ synthesize: true }),
    );
    expect(turns).toEqual([{ agentId: 'chair', kind: 'synthesis', round: 1 }]);
  });

  it('returns an empty plan when there is nothing to run', () => {
    expect(planBoardroomTurns({ chairAgentId: null, advisorAgentIds: [] }, policy())).toEqual([]);
  });

  it('coerces a zero/negative round count to a single round', () => {
    const turns = planBoardroomTurns(
      { chairAgentId: 'chair', advisorAgentIds: ['a'] },
      policy({ rounds: 0 }),
    );
    expect(turns).toEqual([{ agentId: 'a', kind: 'advisor', round: 0 }]);
  });
});

describe('orderConveneCohort (ADR 0054 D6)', () => {
  it('puts the moderator first, then the rest in declared order', () => {
    expect(orderConveneCohort('b', ['a', 'b', 'c'], 8)).toEqual(['b', 'a', 'c']);
  });

  it('ignores a moderator that is not a member (chair must be in the room)', () => {
    expect(orderConveneCohort('zzz', ['a', 'b'], 8)).toEqual(['a', 'b']);
  });

  it('keeps declared order when there is no moderator', () => {
    expect(orderConveneCohort(undefined, ['a', 'b', 'c'], 8)).toEqual(['a', 'b', 'c']);
  });

  it('caps the cohort for cost — moderator included in the cap', () => {
    expect(orderConveneCohort('e', ['a', 'b', 'c', 'd', 'e'], 3)).toEqual(['e', 'a', 'b']);
  });

  it('never duplicates the moderator when it is also listed as a member', () => {
    expect(orderConveneCohort('a', ['a', 'b', 'c'], 8)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty cohort when there are no members', () => {
    expect(orderConveneCohort('a', [], 8)).toEqual([]);
  });
});
