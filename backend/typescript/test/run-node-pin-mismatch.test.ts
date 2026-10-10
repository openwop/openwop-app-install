/**
 * grade-data D-3 — a definition records the node versions it was built against
 * (ADR 0766 D3 `expandedFrom.nodePins`, D-6 `nodePins`). A run on a host where a
 * loaded node is at a DIFFERENT version is stamped `metadata.nodePinMismatches`
 * (and logged), so it no longer runs, forks and exports silently. The stamp is
 * written once: a fork keeps its parent's record.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

let storage: Storage;
const TYPE = 'test.d3.pinned-node';

beforeAll(async () => {
  storage = await openStorage('memory://');
  getNodeRegistry().register({ typeId: TYPE, version: '1.2.0', async execute() { return { status: 'success', outputs: {} }; } });
});

const def = (metadata: Record<string, unknown>): WorkflowDefinition => ({
  workflowId: 'wf.d3', nodes: [{ nodeId: 'n1', typeId: TYPE }], edges: [], metadata,
} as unknown as WorkflowDefinition);
const run = (runId: string, metadata: Record<string, unknown> = {}): RunRecord => {
  const now = new Date().toISOString();
  return { runId, workflowId: 'wf.d3', tenantId: 't-d3', status: 'running', inputs: {}, metadata, configurable: {}, createdAt: now, updatedAt: now } as RunRecord;
};

describe('run-start node pin check (grade-data D-3)', () => {
  it('stamps a chain-expansion pin the loaded module does not honour', async () => {
    const r = run('r-d3-1');
    await insertRunWithStartContext(storage, r, { definition: def({ expandedFrom: { nodePins: { [TYPE]: '1.1.0' } } }) });
    expect(r.metadata?.nodePinMismatches).toEqual([{ typeId: TYPE, pinned: '1.1.0', installed: '1.2.0' }]);
  });

  it('reads a direct definition\'s nodePins too, and stays silent when the pin is honoured', async () => {
    const miss = run('r-d3-2');
    await insertRunWithStartContext(storage, miss, { definition: def({ nodePins: { [TYPE]: '1.0.0' } }) });
    expect(miss.metadata?.nodePinMismatches).toHaveLength(1);
    const ok = run('r-d3-3');
    await insertRunWithStartContext(storage, ok, { definition: def({ nodePins: { [TYPE]: '1.2.0' } }) });
    expect(ok.metadata?.nodePinMismatches).toBeUndefined();
  });

  it('a fork keeps the parent\'s record verbatim', async () => {
    const parentRecord = [{ typeId: TYPE, pinned: '0.9.0', installed: '1.1.0' }];
    const fork = run('r-d3-4', { nodePinMismatches: parentRecord });
    await insertRunWithStartContext(storage, fork, { definition: def({ nodePins: { [TYPE]: '1.1.0' } }), derivedFromRun: true });
    expect(fork.metadata?.nodePinMismatches).toEqual(parentRecord);
  });
});
