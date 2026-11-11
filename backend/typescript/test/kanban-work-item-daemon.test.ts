/** ADR 0738 P4 — the reusable WorkItem executor owns eligibility and leases,
 * while every actual workflow launch still uses the shared run-starter/outbox.
 *
 * Red if delivery drops the item input or the card's lastRunId, the started
 * metric, or the terminal move to Done (probes w37g1-dmn-inputs, -dmn-card-lastrun,
 * -dmn-metric, -dmn-settle-move); if a manual claim can race an `auto` item
 * (-dmn-mode-policy); or if retries stop at maxAttempts / end `blocked`
 * (-dmn-max-attempts, -dmn-blocked). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  __resetKanbanStore,
  applyBoardCommand,
  buildKanbanWorkItemDeliverySummary,
  claimEligibleWorkItemExecution,
  createBoard,
  failWorkItemExecutionReservation,
  getCard,
  getWorkItem,
  listPendingWorkItemOutbox,
  settleWorkItemExecutionFromRun,
} from '../src/host/kanbanService.js';
import { sweepKanbanWorkItemOutbox } from '../src/host/kanbanWorkItemDaemon.js';
import { ensureSuspendManagerInstalled } from '../src/bootstrap/suspend.js';
import { ensureEventLogInstalled } from '../src/bootstrap/eventLog.js';
import { ensureInvocationLogInstalled } from '../src/bootstrap/invocationLog.js';
import { _resetMetricsForTest, emissionsOf } from '../src/observability/metrics.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: {
    getWorkflow: async (workflowId) => ({ workflowId, definition: { workflowId, nodes: [], edges: [] } }),
  },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

let storage: Storage;
let deps: StartRunDeps;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  ensureSuspendManagerInstalled(storage);
  ensureEventLogInstalled(storage);
  ensureInvocationLogInstalled(storage);
  _resetMetricsForTest();
  await __resetKanbanStore();
  deps = { storage, hostSuite };
});

afterEach(async () => {
  await storage.close();
  __resetHostExtPersistence();
});

describe('core Kanban WorkItem daemon', () => {
  it('records fleet-safe started, retried, and dead-lettered delivery outcomes from real worker paths', async () => {
    const base = Date.now() + 1_000;
    const board = await createBoard({ tenantId: 'tenant-a', name: 'Delivery telemetry' });
    const startedPlan = await applyBoardCommand({
      type: 'work-items.materialize', tenantId: 'tenant-a', boardId: board.id,
      scope: { kind: 'canvas.generic' }, source: { kind: 'feature.generic.plan', id: 'started-plan', revision: '1' },
      idempotencyKey: 'started-plan-1',
      items: [{
        key: 'starts', title: 'Starts through the normal worker', columnId: 'todo', workflowId: 'tenant-owned-workflow',
        execution: { mode: 'auto', maxAttempts: 2 },
      }],
    });
    await expect(sweepKanbanWorkItemOutbox(deps, 'healthy-worker', base)).resolves.toBe(1);

    const failingPlan = await applyBoardCommand({
      type: 'work-items.materialize', tenantId: 'tenant-a', boardId: board.id,
      scope: { kind: 'canvas.generic' }, source: { kind: 'feature.generic.plan', id: 'failing-plan', revision: '1' },
      idempotencyKey: 'failing-plan-1',
      items: [{
        key: 'fails', title: 'Retries through the normal worker', columnId: 'todo', workflowId: 'tenant-owned-workflow',
        // The worker retry budget, rather than this WorkItem's execution budget,
        // is what this fixture verifies. Keep the reservation retryable while the
        // outbox spends its eight durable delivery attempts. Ten is the maximum
        // valid WorkItem policy budget.
        execution: { mode: 'auto', maxAttempts: 10 },
      }],
    });
    const failingDeps: StartRunDeps = {
      storage,
      hostSuite: {
        workflowCatalog: { getWorkflow: async () => { throw new Error('simulated catalog outage'); } },
        providerPolicyResolver: { resolveForRun: async () => [] },
      },
    };
    // A real worker sweep claims, reserves, fails to start, and reschedules the
    // same durable row. Advancing beyond its reservation lease forces the exact
    // crash-recovery path; no test writes an outbox status by hand.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(sweepKanbanWorkItemOutbox(failingDeps, 'failing-worker', base + 60_000 * (attempt + 1))).resolves.toBe(0);
    }

    const summary = await buildKanbanWorkItemDeliverySummary(base + 9 * 60_000);
    expect(summary.outcomes).toMatchObject({ started: 1, retried: 7, 'dead-lettered': 1 });
    expect(summary.queue.deadLettered).toBeGreaterThanOrEqual(1);
    expect(summary.queue.pending).toBeGreaterThanOrEqual(0);
    // The aggregate projection deliberately has no identities or error text.
    expect(Object.keys(summary)).toEqual(['queue', 'outcomes', 'window']);
    expect(Object.keys(summary.queue).sort()).toEqual([
      'claimed', 'deadLettered', 'delivered', 'oldestPendingAgeS', 'oldestPendingCreatedAt', 'pending',
    ]);
    expect(startedPlan.workItems).toHaveLength(1);
    expect(failingPlan.workItems).toHaveLength(1);
    // Let the normal run-starter's in-process wakeup observe the open test
    // storage before teardown; durable dispatch remains the recovery path.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('leases an auto policy once, starts a normal idempotent run, and reconciles its terminal state to the shared card', async () => {
    const board = await createBoard({
      tenantId: 'tenant-a',
      name: 'Reusable delivery',
      columns: [
        { id: 'todo', name: 'To Do' },
        { id: 'done', name: 'Done', terminal: true },
      ],
    });
    const plan = await applyBoardCommand({
      type: 'work-items.materialize',
      tenantId: 'tenant-a',
      boardId: board.id,
      scope: { kind: 'canvas.generic', externalRef: 'any-canvas-7' },
      source: { kind: 'feature.generic.plan', id: 'plan-7', revision: '1' },
      idempotencyKey: 'generic-plan-7',
      items: [{
        key: 'deliver', title: 'Deliver the reusable outcome', columnId: 'todo',
        workflowId: 'tenant-owned-workflow', input: { source: 'test' },
        execution: { mode: 'auto', maxAttempts: 2 },
      }],
    });
    const work = plan.workItems[0]!;
    const now = Date.now();

    // Fleet racing is safe: one persisted outbox lease wins and produces one
    // normal RunRecord; the loser observes no due entry.
    // Honest double guard: removing only the outbox CAS stays green — the
    // execution CAS + live lease (→ defer) in claimEligibleWorkItemExecution is the outer guard.
    const [first, second] = await Promise.all([
      sweepKanbanWorkItemOutbox(deps, 'worker-a', now),
      sweepKanbanWorkItemOutbox(deps, 'worker-b', now),
    ]);
    expect(first + second).toBe(1);
    expect(emissionsOf('openwop.kanban.work_item.delivery')).toContainEqual({
      name: 'openwop.kanban.work_item.delivery',
      value: 1,
      attributes: { mode: 'auto', outcome: 'started' },
    });

    const running = (await getWorkItem(work.workItemId))!;
    expect(running.state).toBe('running');
    expect(running.execution).toMatchObject({ mode: 'auto', status: 'running', attempts: 1 });
    expect(running.execution.runId).toMatch(/^kanban-work-run-/);
    const run = await storage.getRun(running.execution.runId!);
    expect(run).toMatchObject({ tenantId: 'tenant-a', workflowId: 'tenant-owned-workflow', inputs: { source: 'test' } });
    expect((run?.metadata as Record<string, unknown>).kanbanWorkItem).toMatchObject({ workItemId: work.workItemId, boardId: board.id });
    expect((await getCard(work.cardId))?.lastRunId).toBe(running.execution.runId);

    expect(await settleWorkItemExecutionFromRun('tenant-a', running.execution.runId!, 'completed', now + 1)).toBe(true);
    const completed = (await getWorkItem(work.workItemId))!;
    expect(completed.state).toBe('completed');
    expect(completed.execution.status).toBe('succeeded');
    expect((await getCard(work.cardId))?.columnId).toBe('done');
    // Lifecycle audit events are consumed as non-eligible after completion;
    // no pending delivery can start a completed item again.
    expect(await sweepKanbanWorkItemOutbox(deps, 'worker-c', Date.now() + 10_000)).toBe(0);
    expect((await listPendingWorkItemOutbox('tenant-a')).every((entry) => entry.workItemId !== work.workItemId)).toBe(true);
    // Let the normal run-starter's in-process wakeup observe the open test
    // storage before teardown; durable dispatch remains the recovery path.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('keeps automatic retries bounded and never creates a feature-specific retry runner', async () => {
    const board = await createBoard({ tenantId: 'tenant-a', name: 'Bounded retry' });
    const plan = await applyBoardCommand({
      type: 'work-items.materialize', tenantId: 'tenant-a', boardId: board.id,
      scope: { kind: 'canvas.any' }, source: { kind: 'feature.any.plan', id: 'retry-plan', revision: '1' },
      idempotencyKey: 'retry-plan-1',
      items: [{
        key: 'one', title: 'Generic retryable work', columnId: 'todo', workflowId: 'tenant-owned-workflow',
        execution: { mode: 'auto', maxAttempts: 2 },
      }],
    });
    const workId = plan.workItems[0]!.workItemId;
    // The API's explicit human affordance is for a reviewed manual policy; it
    // must not become an escape hatch that races an automatic WorkItem's
    // durable worker lease.
    await expect(claimEligibleWorkItemExecution('tenant-a', workId, 'human-a', 'manual', Date.now()))
      .resolves.toEqual({ kind: 'skip' });
    const first = await claimEligibleWorkItemExecution('tenant-a', workId, 'worker-a', 'auto', Date.now());
    expect(first.kind).toBe('started');
    if (first.kind !== 'started') throw new Error('expected first execution reservation');
    await failWorkItemExecutionReservation('tenant-a', workId, first.runId, 'workflow-unresolved', Date.now());

    const second = await claimEligibleWorkItemExecution('tenant-a', workId, 'worker-b', 'auto', Date.now());
    expect(second.kind).toBe('started');
    if (second.kind !== 'started') throw new Error('expected second execution reservation');
    expect(second.runId).not.toBe(first.runId);
    await failWorkItemExecutionReservation('tenant-a', workId, second.runId, 'workflow-unresolved', Date.now());

    const blocked = (await getWorkItem(workId))!;
    expect(blocked).toMatchObject({ state: 'blocked', execution: { status: 'failed', attempts: 2, maxAttempts: 2 } });
    await expect(claimEligibleWorkItemExecution('tenant-a', workId, 'worker-c', 'auto', Date.now())).resolves.toEqual({ kind: 'skip' });
  });
});
