/**
 * ADR 0083 follow-up — mid-graph deliverable capture.
 *
 * Seam B captures only TERMINAL node outputs; a node that declares an `outputRole` but sits
 * MID-GRAPH (has outgoing edges — e.g. a rendered PDF that then feeds a notify) was dropped.
 * The executor now captures such nodes as durable run-artifacts at completion. Verifies:
 * a mid-graph outputRole node IS captured; a mid-graph node WITHOUT outputRole is NOT;
 * and the capture survives a LATER node failing.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRun } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { getRunArtifact, __resetRunArtifactStore } from '../src/host/runArtifactStore.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-mg-')) });
initHostExtPersistence(storage);

beforeAll(() => {
  const reg = getNodeRegistry();
  reg.register({ typeId: 'test.mg.pass', version: '1.0.0', async execute(ctx) { return { status: 'success', outputs: { output: (ctx.inputs as { input?: unknown })?.input ?? '# Rendered\nthe asset' } }; } });
  reg.register({ typeId: 'test.mg.fail', version: '1.0.0', async execute() { return { status: 'failure', error: { code: 'boom', message: 'later step failed' } }; } });
});

async function newRun(workflowId: string): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-${Math.random().toString(36).slice(2)}`,
    workflowId, tenantId: 'demo', status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  return run;
}

describe('ADR 0083 follow-up — mid-graph capture', () => {
  it('captures a MID-GRAPH outputRole node (asset → feeds a downstream node)', async () => {
    await __resetRunArtifactStore();
    const run = await newRun('wf.mg');
    const def: WorkflowDefinition = {
      workflowId: 'wf.mg',
      nodes: [
        { nodeId: 'render', typeId: 'test.mg.pass', outputRole: 'secondary' }, // mid-graph deliverable
        { nodeId: 'notify', typeId: 'test.mg.pass' }, // terminal (captured by Seam B already)
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 'render', targetNodeId: 'notify' }],
    };
    const result = await executeRun(storage, run, def);
    expect(result.status).toBe('completed');
    // the mid-graph render deliverable was captured (Seam B alone would have dropped it)
    const art = await getRunArtifact(`${run.runId}:render`);
    expect(art).not.toBeNull();
    expect(art?.kind).toBe('markdown');
    expect(art?.content).toContain('the asset');
  });

  it('does NOT capture a mid-graph node WITHOUT outputRole (plumbing stays uncaptured)', async () => {
    await __resetRunArtifactStore();
    const run = await newRun('wf.mg2');
    const def: WorkflowDefinition = {
      workflowId: 'wf.mg2',
      nodes: [
        { nodeId: 'mid', typeId: 'test.mg.pass' }, // mid-graph, no outputRole
        { nodeId: 'end', typeId: 'test.mg.pass' },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 'mid', targetNodeId: 'end' }],
    };
    await executeRun(storage, run, def);
    expect(await getRunArtifact(`${run.runId}:mid`)).toBeNull(); // not a declared deliverable
  });

  it('the mid-graph deliverable survives a LATER node failing', async () => {
    await __resetRunArtifactStore();
    const run = await newRun('wf.mg3');
    const def: WorkflowDefinition = {
      workflowId: 'wf.mg3',
      nodes: [
        { nodeId: 'render', typeId: 'test.mg.pass', outputRole: 'secondary' },
        { nodeId: 'boom', typeId: 'test.mg.fail' },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 'render', targetNodeId: 'boom' }],
    };
    const result = await executeRun(storage, run, def);
    expect(result.status).toBe('failed');
    // captured at completion, before the downstream failure — the run failed but the asset persists
    expect(await getRunArtifact(`${run.runId}:render`)).not.toBeNull();
  });
});
