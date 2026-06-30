/**
 * ADR 0080 follow-on (perf): `resolveStrategyContext` memoizes the priority-list
 * reads PER RESOLVE, so a portfolio with multiple priority-idea links into the
 * same list ranks it ONCE — not once per link. Proven by counting the calls into
 * the (mocked) priority-matrix service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';

const counters = vi.hoisted(() => ({ getList: 0, rank: 0, getProject: 0 }));

vi.mock('../src/features/priority-matrix/priorityMatrixService.js', () => ({
  getList: async (_tenantId: string, id: string) => { counters.getList++; return { id, tenantId: 't', orgId: 'org-1', name: 'Bets' }; },
  listRankedIdeas: async (_tenantId: string, _listId: string) => {
    counters.rank++;
    return [
      { card: { id: 'card-1', title: 'Idea one' }, computedPriority: 5, rank: 1 },
      { card: { id: 'card-2', title: 'Idea two' }, computedPriority: 4, rank: 2 },
    ];
  },
}));

vi.mock('../src/features/projects/projectsService.js', () => ({
  resolveProjectAccess: async () => 'workspace', // readable (anything but 'none')
  getProject: async (_tenantId: string, id: string) => {
    counters.getProject++;
    if (id === 'proj-boom') throw new Error('projects store transient error'); // STRAT-4 fixture
    return { id, tenantId: 't', name: `Project ${id}`, charter: { status: 'active', health: 'green', milestones: [] } };
  },
}));

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
    expect(entries[0].health).toBeDefined();                         // health rollup still computed
  });
});
