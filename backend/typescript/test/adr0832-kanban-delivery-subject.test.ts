/**
 * ADR 0832 D3 — a kanban WorkItem run is bounded by a person: the one who pressed
 * Run, else the person whose run materialized the item (`requestedBy`). The
 * daemon has no request, so without `requestedBy` an auto-dispatched item would
 * be a system run that any member could arrange by filing work.
 *
 * Red if `deliverReservedWorkItem` (host/kanbanWorkItemDelivery.ts) flips the
 * `causedBy ?? requestedBy` precedence, drops the requester fallback, stamps an
 * `actingUserId` on a daemon run, or sends an `orgScopeSubject` key for a
 * system-filed item (probes w37g1-dlv-*).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/runStarter.js', () => ({ startWorkflowRun: vi.fn(async () => 'run-1') }));
vi.mock('../src/host/kanbanService.js', () => ({
  failWorkItemExecutionReservation: vi.fn(async () => undefined),
  markWorkItemExecutionStarted: vi.fn(async () => true),
}));

import { startWorkflowRun, type StartRunDeps } from '../src/host/runStarter.js';
import { deliverReservedWorkItem } from '../src/host/kanbanWorkItemDelivery.js';
import type { KanbanCard, KanbanWorkItem, WorkItemExecutionClaim } from '../src/host/kanbanService.js';
import type { Storage } from '../src/storage/storage.js';

const mock = vi.mocked(startWorkflowRun);
const AT = '2026-10-01T00:00:00.000Z';

function reservation(requestedBy?: string): Extract<WorkItemExecutionClaim, { kind: 'started' }> {
  const item: KanbanWorkItem = {
    workItemId: 'w1', tenantId: 't', boardId: 'b', cardId: 'c', workflowId: 'wf',
    scope: { kind: 'x' }, source: { kind: 'y', id: 'z' }, sourceKey: 'k', dependencyIds: [],
    execution: { mode: 'auto', maxAttempts: 3, attempts: 1, status: 'starting', runId: 'r1' },
    state: 'running', order: 0, version: 2, createdAt: AT, updatedAt: AT,
    ...(requestedBy ? { requestedBy } : {}),
  };
  const card: KanbanCard = { id: 'c', boardId: 'b', tenantId: 't', columnId: 'todo', title: 'T', workItemId: 'w1', order: 1, createdAt: AT, updatedAt: AT };
  return { kind: 'started', runId: 'r1', item, card };
}

// startWorkflowRun is mocked, so these deps are never read: an empty storage
// placeholder, not a laundered fixture.
const deps: StartRunDeps = {
  storage: {} as Storage,
  hostSuite: {
    workflowCatalog: { getWorkflow: async () => null },
    providerPolicyResolver: { resolveForRun: async () => [] },
  },
};

const sentArgs = (): object => mock.mock.calls[0]![1] as object;

describe('deliverReservedWorkItem', () => {
  beforeEach(() => { mock.mockClear(); });

  it('the daemon (no request) bounds the run by the item requester', async () => {
    await deliverReservedWorkItem(deps, reservation('user:requester'));
    expect(mock).toHaveBeenCalledTimes(1);
    expect(sentArgs()).toMatchObject({ orgScopeSubject: 'user:requester' });
    expect('actingUserId' in sentArgs()).toBe(false);
  });

  it('a manual Run is bounded by the person who pressed it', async () => {
    await deliverReservedWorkItem(deps, reservation('user:requester'), Date.now(), 'user:clicker');
    expect(mock).toHaveBeenCalledTimes(1);
    expect(sentArgs()).toMatchObject({ orgScopeSubject: 'user:clicker' });
  });

  it('an item filed by a system run stays a system run', async () => {
    await deliverReservedWorkItem(deps, reservation());
    expect(mock).toHaveBeenCalledTimes(1);
    expect('orgScopeSubject' in sentArgs()).toBe(false);
  });
});
