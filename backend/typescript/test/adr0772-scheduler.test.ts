/**
 * ADR 0772 D4 — two scheduler defects, each driven through `executeRun` (the
 * real drain loop), not through the helper that was wrong.
 *
 *  - `RRWF-5`: a fan-in whose edges carry only the CANONICAL `id` (what
 *    `workflow-definition.schema.json` declares, and what the validator accepts)
 *    threw `undefined.localeCompare` inside `releaseDownstream`.
 *  - `RRWF-8`: a pause requested while a node waited on its retry backoff
 *    persisted that node `running`; after resume nothing re-popped it and the
 *    run ended `scheduler stalled`.
 *
 * Red when (wave 60 probes, tracker TST-BRB-8): the fan-in sort key reads only
 * `edgeId` (the TypeError returns), or the pause drain point ignores a pending
 * retry timer.
 *
 * The id-only edges are built WITHOUT a cast: a typed definition, then each edge's
 * `edgeId` moved to `id` at runtime. That is the unvalidated shape the scheduler must
 * survive; `validateWorkflowDefinition` now copies `id` into `edgeId`, so a posted
 * definition never reaches the scheduler this way.
 */
import { describe, expect, it } from 'vitest';
import { executeRun, type SerializedSnapshot } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { requestRunPause, clearRunPause } from '../src/executor/runLifecycle.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-0772-sched-')) });
ensureNodesRegistered();

const attempts = new Map<string, number>();
getNodeRegistry().register({
  typeId: 'test.adr0772.pause-on-first-failure',
  version: '1.0.0',
  async execute(ctx) {
    const n = (attempts.get(ctx.runId) ?? 0) + 1;
    attempts.set(ctx.runId, n);
    if (n === 1) {
      // The pause lands while this node's retry backoff is pending.
      requestRunPause(ctx.runId, { drainPolicy: 'drain-current-node', requestedAt: new Date().toISOString() });
      return { status: 'failure', error: { code: 'upstream_unavailable', message: 'first try fails' } };
    }
    return { status: 'success', outputs: { attempt: n } };
  },
});

async function newRun(workflowId: string): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-0772-s-${Math.random().toString(36).slice(2)}`,
    workflowId,
    tenantId: 'demo',
    status: 'pending',
    inputs: {},
    metadata: {},
    configurable: {},
    createdAt: now,
    updatedAt: now,
  };
  await storage.insertRun(run);
  return run;
}

describe('ADR 0772 D4 (RRWF-5) — a canonical-shape fan-in runs', () => {
  it('two incoming edges carrying only `id` join without a TypeError', async () => {
    const edges: NonNullable<WorkflowDefinition['edges']> = [
      { edgeId: 'a-join', sourceNodeId: 'a', targetNodeId: 'join' },
      { edgeId: 'b-join', sourceNodeId: 'b', targetNodeId: 'join' },
    ];
    // The canonical wire shape: `id` only, no `edgeId`.
    for (const e of edges) {
      Reflect.set(e, 'id', e.edgeId);
      Reflect.deleteProperty(e, 'edgeId');
    }
    const def: WorkflowDefinition = {
      workflowId: 'wf.0772.fanin',
      nodes: [
        { nodeId: 'a', typeId: 'core.noop', config: {} },
        { nodeId: 'b', typeId: 'core.noop', config: {} },
        { nodeId: 'join', typeId: 'core.noop', config: {} },
      ],
      edges,
    };
    expect(edges.map((e) => Object.keys(e).sort())).toEqual([['id', 'sourceNodeId', 'targetNodeId'], ['id', 'sourceNodeId', 'targetNodeId']]);
    const run = await newRun(def.workflowId);
    const result = await executeRun(storage, run, def);
    expect(result.status).toBe('completed');
    const events = await storage.listEvents(run.runId);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'join')).toBe(true);
  });
});

describe('ADR 0772 D4 (RRWF-8) — a pause during a retry backoff is resumable', () => {
  it('the retrying node is paused READY and completes on resume', async () => {
    const def: WorkflowDefinition = {
      workflowId: 'wf.0772.pause-retry',
      nodes: [{ nodeId: 'flaky', typeId: 'test.adr0772.pause-on-first-failure', config: { retry: { maxAttempts: 2 } } }],
      edges: [],
    };
    const run = await newRun(def.workflowId);
    const first = await executeRun(storage, run, def);
    expect(first.status).toBe('paused');
    const paused = await storage.getRun(run.runId);
    const meta = paused?.metadata as { pausedNodeIds?: string[] } | undefined;
    expect(meta?.pausedNodeIds, 'the node waiting on its backoff must be recorded as ready').toContain('flaky');

    clearRunPause(run.runId);
    const snapshot = JSON.parse(String(paused!.schedulerSnapshot)) as SerializedSnapshot;
    const resumed = await executeRun(storage, { ...paused!, status: 'paused' }, def, { resumeSnapshot: snapshot });
    expect(resumed.status).toBe('completed');
    expect(attempts.get(run.runId)).toBe(2);
  });
});
