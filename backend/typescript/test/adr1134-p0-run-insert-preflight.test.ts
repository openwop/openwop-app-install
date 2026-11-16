/**
 * Run admission preflight P0 — the preflight is wired at the run admission choke point
 * (`insertRunWithStartContext`), which every run-start path funnels through.
 *
 * Red when (witnessed with main's runInsert.ts): a fresh chain run missing a
 * declared-required param is admitted with no `preflightFindings`; under
 * `enforce` it is admitted at all, or a row is written before the refusal; a
 * fork is re-judged; or `off` still records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

vi.mock('../src/host/workflowChainPackLoader.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getChain: (id: string) => (id === 'market-intel.shift-digest'
    ? { packName: 'core.openwop.workflows.market-intel', packVersion: '1.3.0', chain: { chainId: id, parameters: { required: ['previous'], properties: { previous: { description: 'the earlier digest' } } } } }
    : null),
}));

const { insertRunWithStartContext } = await import('../src/host/runInsert.js');

const now = '2026-11-16T00:00:00.000Z';
const DEF = {
  workflowId: 'wf.copy.shift', name: 'Shift digest', nodes: [{ nodeId: 'a', typeId: 'core.noop' }], edges: [],
  metadata: { expandedFrom: { chainId: 'market-intel.shift-digest', version: '1.3.0', params: {} } },
} as unknown as WorkflowDefinition;
const run = (over: Partial<RunRecord> & { runId: string }): RunRecord => ({
  workflowId: 'wf.copy.shift', tenantId: 't1', status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now, ...over,
});
const ADMIT = { admission: { plan: 'exempt:test-fixture' as const }, definition: DEF };

let storage: Storage;
beforeEach(async () => { storage = await openStorage('memory://'); delete process.env.OPENWOP_RUN_PREFLIGHT; });
afterEach(() => { delete process.env.OPENWOP_RUN_PREFLIGHT; });

describe('Run admission preflight P0 — preflight at insertRunWithStartContext', () => {
  it('shadow (default): admits the run and records the missing parameter on it', async () => {
    await insertRunWithStartContext(storage, run({ runId: 'r-shadow' }), ADMIT);
    const stored = await storage.getRun('r-shadow');
    expect(stored).toBeTruthy();
    const findings = (stored!.metadata as { preflightFindings?: Array<{ kind: string; param: string }> }).preflightFindings;
    expect(findings?.map((f) => `${f.kind}:${f.param}`)).toEqual(['param_required:previous']);
  });

  it('a supplied input clears it', async () => {
    await insertRunWithStartContext(storage, run({ runId: 'r-ok', inputs: { previous: 'd0' } }), ADMIT);
    expect((await storage.getRun('r-ok'))!.metadata).not.toHaveProperty('preflightFindings');
  });

  it('enforce: refuses with run_preflight_failed and writes no row', async () => {
    process.env.OPENWOP_RUN_PREFLIGHT = 'enforce';
    await expect(insertRunWithStartContext(storage, run({ runId: 'r-enforce' }), ADMIT))
      .rejects.toMatchObject({ code: 'validation_error', httpStatus: 422, details: { reason: 'run_preflight_failed' } });
    expect(await storage.getRun('r-enforce')).toBeNull();
  });

  it('a fork is not re-judged, even under enforce', async () => {
    process.env.OPENWOP_RUN_PREFLIGHT = 'enforce';
    await insertRunWithStartContext(storage, run({ runId: 'r-fork', parentRunId: 'r-parent', forkMode: 'branch' }), { ...ADMIT, derivedFromRun: true });
    expect((await storage.getRun('r-fork'))!.metadata).not.toHaveProperty('preflightFindings');
  });

  it('off records nothing', async () => {
    process.env.OPENWOP_RUN_PREFLIGHT = 'off';
    await insertRunWithStartContext(storage, run({ runId: 'r-off' }), ADMIT);
    expect((await storage.getRun('r-off'))!.metadata).not.toHaveProperty('preflightFindings');
  });
});
