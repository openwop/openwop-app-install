/**
 * Market-intel research chain (ADR 0403 Phase 4) — the builtin workflow is a
 * valid extract → angles → targeting → approve DAG whose node typeIds all
 * exist in the pack manifest (the chain-testing convention), registered on the
 * campaign-brief feature (the CHANNEL_WORKFLOWS/ADR 0072 seam).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKET_INTEL_WORKFLOWS, MARKET_INTEL_WORKFLOW_ID } from '../src/features/campaign-brief/intelWorkflows.js';
import { LEGACY_PINNED_WORKFLOWS } from '../src/features/index.js';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  getChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

describe('campaign-studio.market-intel workflow', () => {
  it('is migrated out of the builtin quarantine and loadable as a chain (ADR 0472 P4)', () => {
    // ADR 0472 P4: market-intel left the `LEGACY_PINNED_WORKFLOWS` quarantine for a
    // chain pack keyed on the same id. The raw def array survives only as the
    // postProcess source (outputRoles) for chain-backed registration; the DAG
    // shape/typeId cases below still validate it.
    expect(LEGACY_PINNED_WORKFLOWS.map((w) => w.workflowId)).not.toContain(MARKET_INTEL_WORKFLOW_ID);
    _resetChainRegistryForTest();
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    expect(getChain(MARKET_INTEL_WORKFLOW_ID)?.chain.chainId).toBe(MARKET_INTEL_WORKFLOW_ID);
    expect(MARKET_INTEL_WORKFLOWS.map((w) => w.workflowId)).toEqual([MARKET_INTEL_WORKFLOW_ID]);
  });

  it('is a valid extract → angles → targeting → approve DAG with briefId + platform variables', () => {
    const [wf] = MARKET_INTEL_WORKFLOWS;
    expect(wf.nodes.map((n) => n.nodeId)).toEqual(['extract_voc', 'generate_angles', 'build_targeting', 'approve']);
    expect(wf.edges).toEqual([
      { edgeId: 'e_voc_angles', sourceNodeId: 'extract_voc', targetNodeId: 'generate_angles' },
      { edgeId: 'e_angles_targeting', sourceNodeId: 'generate_angles', targetNodeId: 'build_targeting' },
      { edgeId: 'e_targeting_approve', sourceNodeId: 'build_targeting', targetNodeId: 'approve' },
    ]);
    expect(wf.variables?.map((v) => v.name)).toEqual(['briefId', 'platform']);
    expect(wf.variables?.every((v) => v.required)).toBe(true);
    // The human gate is the primary output — intel is reviewed, not auto-consumed.
    expect(wf.nodes.at(-1)).toMatchObject({ typeId: 'core.approvalGate', outputRole: 'primary' });
  });

  it('every non-core typeId exists in the pack manifest (no dangling node refs)', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'packs', 'feature.campaign-brief.nodes', 'pack.json'), 'utf8'));
    const declared = new Set<string>(manifest.nodes.map((n: { typeId: string }) => n.typeId));
    for (const wf of MARKET_INTEL_WORKFLOWS) {
      for (const node of wf.nodes) {
        if (node.typeId.startsWith('core.')) continue;
        expect(declared.has(node.typeId), `${node.typeId} missing from the pack manifest`).toBe(true);
      }
    }
  });
});
