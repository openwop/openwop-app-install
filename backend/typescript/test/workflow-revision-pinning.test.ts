/**
 * ADR 0474 P1a-2 — run-pins-revision. Pins:
 *  - run creation stamps `run.metadata.definitionRevision` (the lifecycle-
 *    stripped content hash of the definition it resolved);
 *  - after the head moves, a pinned run re-resolves its ORIGINAL definition
 *    (`resolvedFrom: 'revision'`);
 *  - an unpinned (legacy) run and a pruned pin fall back to head-by-id
 *    (`resolvedFrom: 'head'`) — exactly the pre-0474 behavior;
 *  - re-presenting a deterministic run id returns the existing run and never
 *    attempts a second insert.
 *
 * Double guard (named): the deterministic-id early return in `runStarter.ts` is
 * backed by the insert-conflict catch, which also returns the existing run, so
 * "same id comes back" cannot fail with either alone. The case therefore COUNTS
 * inserts — the early return is the only path that skips the second one
 * (8fw5g5-wrp-dedupe-r2).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { ensureSuspendManagerInstalled } from '../src/bootstrap/suspend.js';
import { ensureEventLogInstalled } from '../src/bootstrap/eventLog.js';
import { ensureInvocationLogInstalled } from '../src/bootstrap/invocationLog.js';
import { startWorkflowRun } from '../src/host/runStarter.js';
import { resolveRunDefinition } from '../src/host/resolveRunDefinition.js';
import { recordRevision, deleteWorkflowRevisions } from '../src/host/workflowRevisions.js';
import { revisionHashOf } from '../src/host/definitionHash.js';
import { registerWorkflow, deleteRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { removeOwnership } from '../src/host/workflowOwnership.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TENANT = 'org:pin-test';
let storage: Storage;
let hostSuite: ReturnType<typeof createHostAdapterSuite>;
const cleanup: string[] = [];

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-pin-')) });
  ensureNodesRegistered();
  ensureSuspendManagerInstalled(storage);
  ensureEventLogInstalled(storage);
  ensureInvocationLogInstalled(storage);
  hostSuite = createHostAdapterSuite({ storage });
});
afterEach(async () => {
  for (const id of cleanup.splice(0)) {
    deleteRegisteredWorkflow(id);
    await deleteWorkflowRevisions(id);
    await removeOwnership(TENANT, id);
  }
});

function def(id: string, nodes: Array<{ nodeId: string; typeId: string }>): WorkflowDefinition {
  return { workflowId: id, nodes, edges: [], metadata: { name: 'Pin Test' } };
}

const AT = '2026-09-20T00:00:00.000Z';
function runRow(runId: string, workflowId: string, metadata: Record<string, unknown>): RunRecord {
  return { runId, workflowId, tenantId: TENANT, status: 'completed', inputs: null, metadata, configurable: {}, createdAt: AT, updatedAt: AT };
}

const SETTLE_POLLS = 100;
/** Wait for the run to leave pending/running; THROWS (naming it) if it never does. */
async function settle(runId: string): Promise<void> {
  for (let i = 0; i < SETTLE_POLLS; i += 1) {
    const run = await storage.getRun(runId);
    if (run && run.status !== 'pending' && run.status !== 'running') return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`run ${runId} did not settle after ${SETTLE_POLLS} polls`);
}

describe('run pins its definition revision (ADR 0474)', () => {
  it('creation stamps the pin; after a head edit the run re-resolves its ORIGINAL definition', async () => {
    const id = 'pin-wf-original';
    cleanup.push(id);
    const v1 = def(id, [{ nodeId: 'a', typeId: 'core.noop' }]);
    registerWorkflow(v1);
    await recordRevision(TENANT, v1);

    const runId = await startWorkflowRun({ storage, hostSuite }, { tenantId: TENANT, workflowId: id });
    expect(runId).toBeTruthy();
    await settle(runId!);
    const run = (await storage.getRun(runId!))!;
    expect((run.metadata as Record<string, unknown>).definitionRevision).toBe(revisionHashOf(v1));

    // Head moves: two nodes now.
    const v2 = def(id, [{ nodeId: 'a', typeId: 'core.noop' }, { nodeId: 'b', typeId: 'core.noop' }]);
    registerWorkflow(v2);
    await recordRevision(TENANT, v2);

    const resolved = await resolveRunDefinition(run, hostSuite.workflowCatalog);
    expect(resolved?.resolvedFrom).toBe('revision');
    expect(resolved?.definition.nodes.length).toBe(1); // the ORIGINAL, not the head
  });

  it('returns a matching deterministic run without scheduling a duplicate start', async () => {
    const id = 'pin-wf-deterministic-start';
    cleanup.push(id);
    const definition = def(id, [{ nodeId: 'a', typeId: 'core.noop' }]);
    registerWorkflow(definition);
    await recordRevision(TENANT, definition);

    const inserts = vi.spyOn(storage, 'insertRun');
    try {
      const first = await startWorkflowRun({ storage, hostSuite }, {
        tenantId: TENANT, workflowId: id, runId: 'kanban-work-run-deterministic-test',
      });
      const second = await startWorkflowRun({ storage, hostSuite }, {
        tenantId: TENANT, workflowId: id, runId: 'kanban-work-run-deterministic-test',
      });
      expect(first).toBe('kanban-work-run-deterministic-test');
      expect(second).toBe(first);
      // The duplicate start never reaches the store: ONE insert across both calls.
      expect(inserts.mock.calls.filter(([r]) => r.runId === 'kanban-work-run-deterministic-test')).toHaveLength(1);
      expect(await storage.getRun(first!)).toMatchObject({ tenantId: TENANT, workflowId: id });
      await settle(first!);
    } finally {
      inserts.mockRestore();
    }
  });

  it('an unpinned legacy run resolves the head (pre-0474 behavior)', async () => {
    const id = 'pin-wf-legacy';
    cleanup.push(id);
    const v1 = def(id, [{ nodeId: 'a', typeId: 'core.noop' }]);
    registerWorkflow(v1);
    const legacyRun = runRow('legacy-1', id, {});
    const resolved = await resolveRunDefinition(legacyRun, hostSuite.workflowCatalog);
    expect(resolved?.resolvedFrom).toBe('head');
    expect(resolved?.definition.nodes.length).toBe(1);
  });

  it('a pruned/missing pinned revision degrades honestly to head', async () => {
    const id = 'pin-wf-pruned';
    cleanup.push(id);
    const v2 = def(id, [{ nodeId: 'a', typeId: 'core.noop' }, { nodeId: 'b', typeId: 'core.noop' }]);
    registerWorkflow(v2);
    const pinnedGone = runRow('pruned-1', id, { definitionRevision: 'deadbeef'.repeat(8) });
    const resolved = await resolveRunDefinition(pinnedGone, hostSuite.workflowCatalog);
    expect(resolved?.resolvedFrom).toBe('head');
    expect(resolved?.definition.nodes.length).toBe(2);
  });
});
