/**
 * Market-intel research chain (ADR 0403 Phase 4) — the workflow is an
 * extract → angles → targeting → approve DAG whose node typeIds all exist in the
 * pack manifest (the chain-testing convention).
 *
 * Since ADR 0472 P4 the RUNNING definition is expanded from the chain pack
 * (`examples/workflow-chain-packs/campaign-brief`, chainId
 * `campaign-studio.market-intel`) and registered chain-backed by
 * `registerLegacyDefsChainBacked(MARKET_INTEL_WORKFLOWS)`, which only restores each
 * node's `outputRole` from the in-tree array. So these cases assert the expanded,
 * registered definition and the chain's own typeIds — not the array (wave 30
 * grade-tests: a broken chain edge or typeId stayed green against the array).
 * "Migrated out of the builtin quarantine and loadable as a chain" is owned by
 * test/builtin-workflow-ratchet.test.ts › MIGRATION REACHABILITY (cut here, wave
 * 30 — both went red under the same chainId sabotage).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { MARKET_INTEL_WORKFLOWS, MARKET_INTEL_WORKFLOW_ID } from '../src/features/campaign-brief/intelWorkflows.js';
import { registerLegacyDefsChainBacked } from '../src/features/index.js';
import { getChainBackedWorkflow } from '../src/host/chainBackedWorkflows.js';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  getChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const STEPS = ['extract_voc', 'generate_angles', 'build_targeting', 'approve'] as const;

/** Chain-backed node ids may be prefixed — map one back to its chain step id. */
const step = (nodeId: string): string => STEPS.find((s) => nodeId === s || nodeId.endsWith(`_${s}`)) ?? nodeId;

let loadErrors: unknown[] = [];

beforeAll(() => {
  initHostExtPersistence(openSqliteStorage(':memory:'));
  _resetChainRegistryForTest();
  loadErrors = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() }).errors;
  registerLegacyDefsChainBacked(MARKET_INTEL_WORKFLOWS);
});

describe('campaign-studio.market-intel workflow', () => {
  it('is a valid extract → angles → targeting → approve DAG with briefId + platform variables', () => {
    expect(loadErrors).toEqual([]);
    const wf = getChainBackedWorkflow(MARKET_INTEL_WORKFLOW_ID);
    expect(wf, 'the market-intel workflow must register chain-backed').toBeTruthy();
    expect(wf!.nodes.map((n) => step(n.nodeId))).toEqual([...STEPS]);
    expect((wf!.edges ?? []).map((e) => [step(e.sourceNodeId), step(e.targetNodeId)])).toEqual([
      ['extract_voc', 'generate_angles'],
      ['generate_angles', 'build_targeting'],
      ['build_targeting', 'approve'],
    ]);
    // The chain's required parameters are the run's inputs.
    const required = getChain(MARKET_INTEL_WORKFLOW_ID)!.chain.parameters.required;
    expect(Array.isArray(required) ? [...required].sort() : required).toEqual(['briefId', 'platform']);
    // The human gate is the primary output — intel is reviewed, not auto-consumed.
    const last = wf!.nodes.at(-1)!;
    expect(last.typeId.split('@')[0]).toBe('core.approvalGate');
    expect(last.outputRole).toBe('primary');
    expect(wf!.nodes.filter((n) => n.outputRole === 'primary')).toHaveLength(1);
  });

  it('every non-core typeId exists in the pack manifest (no dangling node refs)', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'packs', 'feature.campaign-brief.nodes', 'pack.json'), 'utf8')) as { nodes: Array<{ typeId: string }> };
    const declared = new Set<string>(manifest.nodes.map((n) => n.typeId));
    const chain = getChain(MARKET_INTEL_WORKFLOW_ID);
    expect(chain, 'the market-intel chain must load').toBeTruthy();
    const nodes = chain!.chain.dag.nodes;
    expect(nodes).toHaveLength(4);
    for (const node of nodes) {
      const typeId = node.typeId.split('@')[0]!;
      if (typeId.startsWith('core.')) continue;
      expect(declared.has(typeId), `${typeId} missing from the pack manifest`).toBe(true);
    }
  });
});
