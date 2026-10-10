/**
 * ADR 0832 D3 — a kanban WorkItem run is bounded by a person: the one who pressed
 * Run, else the person whose run materialized the item (`requestedBy`). The
 * daemon has no request, so without `requestedBy` an auto-dispatched item would
 * be a system run that any member could arrange by filing work.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/runStarter.js', () => ({ startWorkflowRun: vi.fn(async () => 'run-1') }));
vi.mock('../src/host/kanbanService.js', () => ({
  failWorkItemExecutionReservation: vi.fn(async () => undefined),
  markWorkItemExecutionStarted: vi.fn(async () => true),
}));

import { startWorkflowRun, type StartRunDeps } from '../src/host/runStarter.js';
import { deliverReservedWorkItem } from '../src/host/kanbanWorkItemDelivery.js';

const mock = startWorkflowRun as unknown as ReturnType<typeof vi.fn>;
const reservation = (requestedBy?: string) => ({
  kind: 'started' as const,
  runId: 'r1',
  item: {
    workItemId: 'w1', tenantId: 't', boardId: 'b', cardId: 'c', workflowId: 'wf',
    scope: { kind: 'x' }, source: { kind: 'y', id: 'z' },
    ...(requestedBy ? { requestedBy } : {}),
  },
}) as never;

describe('deliverReservedWorkItem', () => {
  it('the daemon (no request) bounds the run by the item requester', async () => {
    mock.mockClear();
    await deliverReservedWorkItem({} as StartRunDeps, reservation('user:requester'));
    expect(mock.mock.calls[0]![1]).toMatchObject({ orgScopeSubject: 'user:requester' });
    expect('actingUserId' in (mock.mock.calls[0]![1] as object)).toBe(false);
  });

  it('a manual Run is bounded by the person who pressed it', async () => {
    mock.mockClear();
    await deliverReservedWorkItem({} as StartRunDeps, reservation('user:requester'), Date.now(), 'user:clicker');
    expect(mock.mock.calls[0]![1]).toMatchObject({ orgScopeSubject: 'user:clicker' });
  });

  it('an item filed by a system run stays a system run', async () => {
    mock.mockClear();
    await deliverReservedWorkItem({} as StartRunDeps, reservation());
    expect('orgScopeSubject' in (mock.mock.calls[0]![1] as object)).toBe(false);
  });
});
