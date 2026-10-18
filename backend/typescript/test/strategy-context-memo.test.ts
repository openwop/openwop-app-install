/**
 * ADR 0080 follow-on (perf): `resolveStrategyContext` memoizes the priority-list
 * reads PER RESOLVE, so a portfolio with multiple priority-idea links into the
 * same list ranks it ONCE — not once per link. Proven by counting the calls into
 * the (mocked) priority-matrix service. The call COUNT is the claim (an N+1 perf
 * guarantee), so counting is behavior here, not shape.
 *
 * The mocks are typed against the REAL service signatures (`satisfies typeof
 * real.fn`) with full fixtures of the real return types, so a renamed field the
 * resolver reads breaks `tsc` instead of being served stale by the mock.
 *
 * Sabotage witnesses (grade-tests w19, `w19g2-cm-*`): drop the list memo, the
 * ranking memo or the project-data memo, or rethrow a per-link fetch error —
 * each turns a case red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';

import type * as PmService from '../src/features/priority-matrix/priorityMatrixService.js';
import type * as ProjectsService from '../src/features/projects/projectsService.js';
import type { AccessLevel } from '../src/host/subjectAccess.js';

const counters = vi.hoisted(() => ({ getList: 0, rank: 0, getProject: 0 }));
// Hoisted with the mocks: the factories run while the static imports below load.
const { T } = vi.hoisted(() => ({ T: '2030-01-01T00:00:00.000Z' }));

vi.mock('../src/features/priority-matrix/priorityMatrixService.js', () => {
  const getList = (async (_tenantId: string, id: string) => {
    counters.getList++;
    return {
      id, tenantId: 't', orgId: 'org-1', name: 'Bets', boardId: 'board-1',
      criteriaSet: { aggregation: 'weighted-sum', criteria: [] },
      votingMode: 'single', voteAggregation: 'mean', createdBy: 'u', createdAt: T, updatedAt: T,
    };
  }) satisfies typeof PmService.getList;
  const idea = (id: string, title: string, rank: number, computedPriority: number): PmService.RankedIdea => ({
    card: { id, boardId: 'board-1', columnId: 'col-1', title, order: rank, createdAt: T, updatedAt: T },
    status: { columnId: 'col-1', columnName: 'Ideas', terminal: false },
    scores: {}, computedPriority, rank,
    completeness: { declared: 0, scored: 0, missing: [], complete: true },
  });
  const listRankedIdeas = (async (_tenantId: string, _listId: string) => {
    counters.rank++;
    return [idea('card-1', 'Idea one', 1, 5), idea('card-2', 'Idea two', 2, 4)];
  }) satisfies typeof PmService.listRankedIdeas;
  return { getList, listRankedIdeas };
});

vi.mock('../src/features/projects/projectsService.js', () => {
  const resolveProjectAccess = (async (): Promise<AccessLevel> => 'read') satisfies typeof ProjectsService.resolveProjectAccess; // readable (anything but 'none'; the old 'workspace' was not an AccessLevel)
  const getProject = (async (_tenantId: string, id: string) => {
    counters.getProject++;
    if (id === 'proj-boom') throw new Error('projects store transient error'); // STRAT-4 fixture
    return { id, tenantId: 't', orgId: 'org-1', name: `Project ${id}`, workflows: [], charter: { status: 'active', health: 'on-track', milestones: [] }, createdAt: T, updatedAt: T };
  }) satisfies typeof ProjectsService.getProject;
  return { resolveProjectAccess, getProject };
});

import { createStrategy, replaceLinks, resolveStrategyContext, __clearStrategies } from '../src/features/strategy/strategyService.js';

describe('resolveStrategyContext memo (ADR 0080 follow-on)', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearStrategies();
    counters.getList = 0; counters.rank = 0; counters.getProject = 0;
  });

  it('ranks each priority list once per resolve despite multiple idea links to it', async () => {
    const s = await createStrategy('t', 'org-1', 'u', { title: 'Growth', scope: 'org' });
    const withLinks = await replaceLinks('t', s.id, [
      { kind: 'priority-idea', listId: 'list-1', cardId: 'card-1' },
      { kind: 'priority-idea', listId: 'list-1', cardId: 'card-2' },
      { kind: 'priority-list', listId: 'list-1' },
    ]);

    const entries = await resolveStrategyContext('t', [withLinks], undefined, async () => true);

    // All three priority links resolved...
    expect(entries[0].linkedPriorities).toHaveLength(3);
    // ...but the list was read + ranked AT MOST ONCE (without the memo: getList=3, rank=2).
    expect(counters.getList).toBe(1);
    expect(counters.rank).toBe(1);
  });

  it('STRAT-1: fetches a project ONCE per resolve even when many strategies link it (portfolio N+1)', async () => {
    // Two strategies in the readable portfolio both link the SAME project — the shape
    // `/strategy/health` resolves in one call. Without the project-data memo this is
    // getProject=2 (an N+1 that scales with portfolio size); with it, exactly 1.
    const a = await replaceLinks('t', (await createStrategy('t', 'org-1', 'u', { title: 'A', scope: 'org' })).id,
      [{ kind: 'project', projectId: 'proj-shared' }]);
    const b = await replaceLinks('t', (await createStrategy('t', 'org-1', 'u', { title: 'B', scope: 'org' })).id,
      [{ kind: 'project', projectId: 'proj-shared' }]);

    const entries = await resolveStrategyContext('t', [a, b], undefined, async () => true);

    expect(entries[0].linkedProjects).toHaveLength(1);
    expect(entries[1].linkedProjects).toHaveLength(1); // both strategies got the project
    expect(counters.getProject).toBe(1);               // ...but it was fetched once
  });

  it('STRAT-4: a transient fetch error on ONE link is dropped, not fatal — the resolve still returns', async () => {
    // A strategy links a healthy project AND one whose getProject throws (transient store
    // error). Before the fix this 500'd the whole resolve (and `/strategy/health`); now the
    // bad link is dropped and the rest of the context survives.
    const s = await replaceLinks('t', (await createStrategy('t', 'org-1', 'u', { title: 'A', scope: 'org' })).id, [
      { kind: 'project', projectId: 'proj-ok' },
      { kind: 'project', projectId: 'proj-boom' }, // getProject throws for this id
    ]);

    const entries = await resolveStrategyContext('t', [s], undefined, async () => true);

    expect(entries).toHaveLength(1);                                  // did NOT throw
    expect(entries[0].linkedProjects.map((p) => p.id)).toEqual(['proj-ok']); // healthy link kept, boom dropped
    // The rollup ran over the SURVIVING link only (the boom link would make it 2).
    expect(entries[0].health?.signals.linkedProjectCount).toBe(1);
  });
});
