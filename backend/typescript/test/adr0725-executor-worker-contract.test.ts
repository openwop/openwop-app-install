/**
 * ADR 0725 — the executor reads the event seat as a WORKER (contract 1), even
 * when a major-2 request launched it.
 *
 * `routes/runs.ts` launches `void executeRun(...)` from inside the negotiated
 * request, and `storage/eventEraAdapter.ts` parks the request's contract in
 * AsyncLocalStorage — so without this guard the executor's parent-log reads on a
 * major-2 `:fork` came back projected, one carry step away from persisting a
 * read projection into the child log (RFC 0041 §C byte-equivalence).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRun } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { currentContract, runUnderContract } from '../src/storage/eventEraAdapter.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const storage: Storage = await openStorage('memory://');
setEventLogBackend(storage);
setSuspendBackend(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0725-')) });

const observed: number[] = [];
beforeAll(() => {
  getNodeRegistry().register({
    typeId: 'test.observe-contract',
    version: '1.0.0',
    async execute() {
      observed.push(currentContract());
      return { status: 'success', outputs: { output: null } };
    },
  });
});
async function newRun(): Promise<RunRecord> {
  const now = new Date().toISOString();
  const run: RunRecord = { runId: `run-${Math.random().toString(36).slice(2)}`, workflowId: 'wf.contract', tenantId: 'demo', status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
  await storage.insertRun(run);
  return run;
}
const def: WorkflowDefinition = { workflowId: 'wf.contract', nodes: [{ nodeId: 'a', typeId: 'test.observe-contract' }], edges: [] };

describe('ADR 0725 — executeRun enters the worker contract at its one owner', () => {
  it('negative control: the observer sees the ambient contract (2) when no executor is between them', async () => {
    observed.length = 0;
    await runUnderContract(2, async () => { observed.push(currentContract()); });
    expect(observed).toEqual([2]);
  });
  it('a run launched from INSIDE a major-2 request context executes under contract 1', async () => {
    observed.length = 0;
    const run = await newRun();
    const result = await runUnderContract(2, () => executeRun(storage, run, def));
    expect(result.status).toBe('completed');
    expect(observed, 'the node body — and every seat read the executor takes — runs as a worker').toEqual([1]);
  });
  it('a run launched with no context at all is also a worker (not the `?? 1` fallback by accident)', async () => {
    observed.length = 0;
    const run = await newRun();
    await executeRun(storage, run, def);
    expect(observed).toEqual([1]);
  });
});
