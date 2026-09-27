/**
 * ADR 0474 P1a-2 — run-pins-revision. Pins:
 *  - run creation stamps `run.metadata.definitionRevision` (the lifecycle-
 *    stripped content hash of the definition it resolved);
 *  - after the head moves, a pinned run re-resolves its ORIGINAL definition
 *    (`resolvedFrom: 'revision'`);
 *  - an unpinned (legacy) run and a pruned pin fall back to head-by-id
 *    (`resolvedFrom: 'head'`) — exactly the pre-0474 behavior.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
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
  return { workflowId: id, nodes, edges: [], metadata: { name: 'Pin Test' } } as unknown as WorkflowDefinition;
}

async function settle(runId: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const run = await storage.getRun(runId);
    if (run && run.status !== 'pending' && run.status !== 'running') return;
    await new Promise((res) => setTimeout(res, 20));
  }
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

    const first = await startWorkflowRun({ storage, hostSuite }, {
      tenantId: TENANT, workflowId: id, runId: 'kanban-work-run-deterministic-test',
    });
    const second = await startWorkflowRun({ storage, hostSuite }, {
      tenantId: TENANT, workflowId: id, runId: 'kanban-work-run-deterministic-test',
    });
    expect(first).toBe('kanban-work-run-deterministic-test');
    expect(second).toBe(first);
    expect(await storage.getRun(first!)).toMatchObject({ tenantId: TENANT, workflowId: id });
    await settle(first!);
  });

  it('an unpinned legacy run resolves the head (pre-0474 behavior)', async () => {
    const id = 'pin-wf-legacy';
    cleanup.push(id);
    const v1 = def(id, [{ nodeId: 'a', typeId: 'core.noop' }]);
    registerWorkflow(v1);
    const legacyRun = {
      runId: 'legacy-1', workflowId: id, tenantId: TENANT, status: 'completed',
      inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x',
    } as never;
    const resolved = await resolveRunDefinition(legacyRun, hostSuite.workflowCatalog);
    expect(resolved?.resolvedFrom).toBe('head');
    expect(resolved?.definition.nodes.length).toBe(1);
  });

  it('a pruned/missing pinned revision degrades honestly to head', async () => {
    const id = 'pin-wf-pruned';
    cleanup.push(id);
    const v2 = def(id, [{ nodeId: 'a', typeId: 'core.noop' }, { nodeId: 'b', typeId: 'core.noop' }]);
    registerWorkflow(v2);
    const pinnedGone = {
      runId: 'pruned-1', workflowId: id, tenantId: TENANT, status: 'completed',
      inputs: null, metadata: { definitionRevision: 'deadbeef'.repeat(8) }, configurable: {},
      createdAt: 'x', updatedAt: 'x',
    } as never;
    const resolved = await resolveRunDefinition(pinnedGone, hostSuite.workflowCatalog);
    expect(resolved?.resolvedFrom).toBe('head');
    expect(resolved?.definition.nodes.length).toBe(2);
  });
});
