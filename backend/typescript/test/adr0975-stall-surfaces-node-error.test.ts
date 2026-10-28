/**
 * ADR 0975 D4 — a run that stalls after a terminal node failure fails WITH that
 * node's error, not `internal_error: scheduler stalled`.
 *
 * MEASURED on kicktodo.com (2026-10-25), Challenge Factory run: `extract-claims`
 * failed with `openwop-app.no_supported_claims`; `run.failed` said
 * `internal_error — scheduler stalled — no ready, no running, no suspended`, the
 * classifier turned that into "Something went wrong", and the creator never saw
 * why. The shape that stalls (reproduced here with core nodes): a failure skips
 * its downstream; a `none_failed` join is first evaluated while one of its
 * branches is still pending (`wait`), is not re-visited by the cascade, and the
 * final sweep in `inspectDisposition` applies only `skip` verdicts — so the join
 * stays pending and the loop finds nothing to run.
 *
 * Pins: the run fails; `run.failed` carries the failing node's code, message and
 * `failedNodeId`; the dead-letter row names it. A stall with NO node error keeps
 * the generic engine error (not exercised here: it needs a broken graph).
 *
 * Red when (sabotage-witnessed): the stall branch goes straight to the generic
 * `internal_error` again, or picks a node that did not fail.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeRun } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-0975-stall-')) });
ensureNodesRegistered();

getNodeRegistry().register({
  typeId: 'test.adr0975.extract-fails',
  version: '1.0.0',
  async execute() {
    return { status: 'failure', error: { code: 'openwop-app.no_supported_claims', message: 'The fetched sources supported no extractable claims.' } };
  },
});

async function newRun(workflowId: string): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: `run-0975-${Math.random().toString(36).slice(2)}`,
    workflowId, tenantId: 'demo', status: 'pending', inputs: {}, metadata: {}, configurable: {},
    createdAt: now, updatedAt: now,
  } as RunRecord;
  await storage.insertRun(run);
  return run;
}

// research → extract (fails) → plan (all_success, skipped) ┬→ decompose (none_failed)
//                                                          └→ planFail (any_failed, skipped) ─→ decompose
// `plan → decompose` is listed BEFORE `plan → planFail`, so the cascade sees the
// join while `planFail` is still pending — the Factory's `decompose` shape.
const def: WorkflowDefinition = {
  workflowId: 'wf.0975.stall',
  nodes: [
    { nodeId: 'research', typeId: 'core.noop', config: {} },
    { nodeId: 'extract', typeId: 'test.adr0975.extract-fails', config: {} },
    { nodeId: 'plan', typeId: 'core.noop', config: {} },
    { nodeId: 'planFail', typeId: 'core.noop', config: {} },
    { nodeId: 'decompose', typeId: 'core.noop', config: {} },
  ],
  edges: [
    { edgeId: 'e1', sourceNodeId: 'research', targetNodeId: 'extract' },
    { edgeId: 'e2', sourceNodeId: 'extract', targetNodeId: 'plan' },
    { edgeId: 'e3', sourceNodeId: 'plan', targetNodeId: 'decompose', triggerRule: 'none_failed' },
    { edgeId: 'e4', sourceNodeId: 'plan', targetNodeId: 'planFail', triggerRule: 'any_failed' },
    { edgeId: 'e5', sourceNodeId: 'planFail', targetNodeId: 'decompose', triggerRule: 'none_failed' },
  ],
};

describe('ADR 0975 D4 — a stall after a node failure reports that failure', () => {
  it('run.failed carries the failing node\'s code, message and failedNodeId (not "scheduler stalled")', async () => {
    const run = await newRun(def.workflowId);
    const result = await executeRun(storage, run, def);
    expect(result.status).toBe('failed');
    const events = await storage.listEvents(run.runId);
    const failed = events.find((e) => e.type === 'run.failed');
    const payload = failed?.payload as { error?: { code?: string; message?: string }; failedNodeId?: string } | undefined;
    expect(payload?.error?.code).toBe('openwop-app.no_supported_claims');
    expect(payload?.error?.message).toContain('no extractable claims');
    expect(payload?.failedNodeId).toBe('extract');
    expect(JSON.stringify(events)).not.toContain('scheduler stalled');
    const deadLetter = events.find((e) => e.type === 'run.dead_lettered');
    expect(deadLetter?.payload).toMatchObject({ nodeId: 'extract' });
  });
});
