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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { MARKET_INTEL_WORKFLOWS, MARKET_INTEL_WORKFLOW_ID, KERNEL_WORKFLOWS, KERNEL_WORKFLOW_ID } from '../src/features/campaign-brief/intelWorkflows.js';
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
  registerLegacyDefsChainBacked(KERNEL_WORKFLOWS);
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

describe('ADR 1020 P2 — the brief chains as they run', () => {
  it('messaging-kernel: generate (staged) → approve → promote, the kernel reaching promote by data edges; promote is the primary output', () => {
    const wf = getChainBackedWorkflow(KERNEL_WORKFLOW_ID)!;
    const byStep = (s: string) => wf.nodes.find((n) => n.nodeId === s || n.nodeId.endsWith(`_${s}`))!;
    expect(byStep('generate_kernel').config).toMatchObject({ stageKernel: true });
    expect(byStep('promote').typeId.split('@')[0]).toBe('feature.campaign-brief.nodes.promote-kernel');
    const into = (target: string) => (wf.edges ?? []).filter((e) => e.targetNodeId === byStep(target).nodeId).map((e) => [e.sourceNodeId === byStep('approve').nodeId ? 'approve' : 'generate_kernel', e.sourceOutput ?? null, e.targetInput ?? null]);
    expect(into('promote')).toEqual(expect.arrayContaining([['approve', null, null], ['generate_kernel', 'kernel', 'kernel'], ['generate_kernel', 'briefVersion', 'briefVersion'], ['generate_kernel', 'priorKernelAt', 'priorKernelAt']]));
    expect(wf.nodes.filter((n) => n.outputRole === 'primary').map((n) => n.nodeId)).toEqual([byStep('promote').nodeId]);
  });

  it('market-intel: the platform is a closed enum, and the checkpoint says research is already saved', () => {
    const chain = getChain(MARKET_INTEL_WORKFLOW_ID)!.chain;
    expect((chain.parameters.properties as Record<string, { enum?: string[] }>).platform!.enum).toEqual(['meta', 'google', 'linkedin', 'tiktok']);
    const gate = chain.dag.nodes.find((n) => n.id === 'approve')!;
    expect(String((gate.config as Record<string, unknown>).prompt)).toContain('saved to the brief');
  });
});

describe('ADR 1020 (grade-code M2) — every chain that saves a kernel stages it first', () => {
  it('a chain with promote-kernel sets stageKernel on its generator and wires kernel + briefVersion into promote', () => {
    const roots = defaultWorkflowChainPackRoots();
    let checked = 0;
    for (const root of roots) {
      for (const dir of readdirSync(root)) {
        const file = join(root, dir, 'pack.json');
        if (!existsSync(file)) continue;
        const pack = JSON.parse(readFileSync(file, 'utf8')) as { kind?: string; chains?: Array<{ chainId: string; dag: { nodes: Array<{ id: string; typeId: string; config?: Record<string, unknown> }>; edges: Array<{ from: string; to: string }> } }> };
        if (pack.kind !== 'workflow-chain') continue;
        for (const chain of pack.chains ?? []) {
          const promote = chain.dag.nodes.filter((n) => n.typeId.split('@')[0] === 'feature.campaign-brief.nodes.promote-kernel');
          if (promote.length === 0) continue;
          for (const p of promote) {
            checked += 1;
            const into = chain.dag.edges.filter((e) => e.to.split('.')[0] === p.id);
            const kernelEdge = into.find((e) => e.to === `${p.id}.kernel`);
            const versionEdge = into.find((e) => e.to === `${p.id}.briefVersion`);
            expect(into.find((e) => e.to === `${p.id}.priorKernelAt`), `${chain.chainId}: ${p.id} is not told which kernel it replaces`).toBeTruthy();
            expect(kernelEdge, `${chain.chainId}: ${p.id} gets no kernel`).toBeTruthy();
            expect(versionEdge, `${chain.chainId}: ${p.id} gets no briefVersion`).toBeTruthy();
            const generator = chain.dag.nodes.find((n) => n.id === kernelEdge!.from.split('.')[0])!;
            expect(generator.typeId.split('@')[0]).toBe('feature.campaign-brief.nodes.generate-kernel');
            expect(generator.config, `${chain.chainId}: ${generator.id} saves before the approval`).toMatchObject({ stageKernel: true });
          }
        }
      }
    }
    expect(checked, 'the scan found no promote-kernel at all').toBeGreaterThanOrEqual(2);
  });
});
