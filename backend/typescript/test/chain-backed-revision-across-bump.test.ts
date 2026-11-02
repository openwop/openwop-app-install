/**
 * grade-data D-1 — a run on a CHAIN-BACKED workflow resolves its OWN definition
 * after the chain's version is bumped.
 *
 * Chain-backed definitions are re-expanded every boot, and their node ids derive
 * from `chainId@chain.version`. A run stamps `metadata.definitionRevision`
 * (runInsert.ts), and `resolveRunDefinition` looks that revision up — but until
 * this fix nothing recorded a revision for the chain-backed lane, so a run paused
 * across a bump (ADR 0766 P3 bumped all 185) resumed against the new head, whose
 * node ids differ: checkpoints hydrate by node id, so completed nodes read as
 * unrun and an interrupt's node vanished.
 *
 * TST-CCB-2. Red when: `registerChainBackedWorkflow` stops recording the revision
 * (`recordRevision`), or `resolveRunDefinition` stops preferring the pinned revision
 * row over the head.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { _resetChainRegistryForTest, loadWorkflowChainPacks } from '../src/host/workflowChainPackLoader.js';
import { getChainBackedWorkflow, registerChainBackedWorkflow, _resetChainBackedWorkflowsForTest } from '../src/host/chainBackedWorkflows.js';
import { getRevision } from '../src/host/workflowRevisions.js';
import { revisionHashOf } from '../src/host/definitionHash.js';
import { resolveRunDefinition } from '../src/host/resolveRunDefinition.js';
import type { RunRecord } from '../src/types.js';

const CHAIN_ID = 'test.chain-backed.revision';

const roots: string[] = [];
function loadChain(version: string, nodes: string[]): void {
  const root = mkdtempSync(join(tmpdir(), 'owp-cb-rev-'));
  roots.push(root);
  mkdirSync(join(root, 'p'));
  writeFileSync(join(root, 'p', 'pack.json'), JSON.stringify({
    name: 'vendor.test.cb-revision', version, kind: 'workflow-chain', engines: { openwop: '>=1.0.0 <3.0.0' },
    chains: [{
      chainId: CHAIN_ID, version, label: 'CB revision', description: 'fixture',
      parameters: { type: 'object', properties: {} },
      dag: { nodes: nodes.map((id) => ({ id, typeId: 'core.flow.noop@1.0.0' })), edges: [] },
    }],
  }));
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: [root] });
  if (errors.length) throw new Error(JSON.stringify(errors));
}

/** registerChainBackedWorkflow records the revision fire-and-forget; wait for the
 *  row itself to exist (the real condition), never a fixed sleep. */
async function revisionRecorded(): Promise<string> {
  const def = getChainBackedWorkflow(CHAIN_ID);
  expect(def, 'chain-backed workflow did not register').toBeTruthy();
  const hash = revisionHashOf(def!);
  await vi.waitFor(async () => { expect(await getRevision(CHAIN_ID, hash)).not.toBeNull(); }, { timeout: 2000, interval: 5 });
  return hash;
}

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  _resetChainBackedWorkflowsForTest();
});
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

describe('grade-data D-1 — chain-backed runs survive a chain-version bump', () => {
  it('a run stamped before the bump resolves the pre-bump definition from its revision', async () => {
    loadChain('1.0.0', ['a']);
    registerChainBackedWorkflow(CHAIN_ID);
    const stamped = await revisionRecorded();
    const before = getChainBackedWorkflow(CHAIN_ID)!;

    // The bump: new chain version, new content, re-registered as a boot would.
    loadChain('1.0.1', ['a', 'b']);
    registerChainBackedWorkflow(CHAIN_ID);
    await revisionRecorded();
    const after = getChainBackedWorkflow(CHAIN_ID)!;
    expect(revisionHashOf(after)).not.toBe(stamped);

    const run: RunRecord = {
      runId: 'r1', workflowId: CHAIN_ID, tenantId: 'host', status: 'running', inputs: {},
      metadata: { definitionRevision: stamped }, configurable: {},
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const resolved = await resolveRunDefinition(run, { getWorkflow: async (id) => (id === CHAIN_ID ? { workflowId: id, definition: after } : null) });
    expect(resolved?.resolvedFrom, 'the pinned revision must be found — falling back to head is the defect').toBe('revision');
    expect(resolved?.definition.nodes.map((n) => n.nodeId)).toEqual(before.nodes.map((n) => n.nodeId));
    expect(resolved?.definition.nodes).toHaveLength(1); // the pre-bump shape, not the 2-node head
  });
});
