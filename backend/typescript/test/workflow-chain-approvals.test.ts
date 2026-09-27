/**
 * Approvals workflow-chain pack (ADR 0198) — the Microsoft-canon marquee:
 * Request Sign-off (open gate) + Two-Stage Sign-off (sequential approval
 * chains via DAG composition, not a new primitive). The repo-wide conventions
 * suite covers gating/live-param rules automatically.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadWorkflowChainPacks,
  getChain,
  listChains,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN_TREE_ROOT = join(__dirname, '..', '..', '..', 'examples', 'workflow-chain-packs');

beforeAll(() => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: [IN_TREE_ROOT] });
  expect(errors).toEqual([]);
});

const PACK = 'core.openwop.workflows.approvals';
const CHAINS = ['approvals.request-sign-off', 'approvals.two-stage-sign-off'];

const KNOWN_TYPEIDS = new Set([
  'core.ai.chatCompletion',
  'core.chat.approvalGate',
  'feature.notifications.nodes.notify',
]);

describe('approvals pack — discovery + typeIds', () => {
  it('loads both chains with the Approvals category', () => {
    for (const id of CHAINS) {
      const entry = getChain(id);
      expect(entry, id).not.toBeNull();
      expect(entry!.packName).toBe(PACK);
      expect(entry!.category).toBe('Approvals');
    }
    expect(listChains().filter((c) => c.packName === PACK)).toHaveLength(2);
  });

  it.each(CHAINS)('%s references only registered typeIds', (id) => {
    const chain = getChain(id)!.chain;
    for (const n of chain.dag.nodes) {
      expect(KNOWN_TYPEIDS.has(n.typeId), `${id}:${n.id} → ${n.typeId}`).toBe(true);
    }
  });
});

describe('approvals pack — gate shapes', () => {
  it('request-sign-off is a zero-config OPEN gate (no approver refs, no required params beyond the item)', () => {
    const chain = getChain('approvals.request-sign-off')!.chain;
    const gate = chain.dag.nodes.find((n) => n.typeId === 'core.chat.approvalGate')!;
    expect(gate.config).toEqual({});
    expect(((chain.parameters as { required?: string[] }).required)).toEqual(['item']);
  });

  it('two-stage composes SEQUENTIAL gates: stage two is downstream of stage one', () => {
    const chain = getChain('approvals.two-stage-sign-off')!.chain;
    const gates = chain.dag.nodes.filter((n) => n.typeId === 'core.chat.approvalGate');
    expect(gates).toHaveLength(2);
    // Each stage's approver is a live param wired into approverRefs.
    expect((gates[0]!.config as { approverRefs?: string[] }).approverRefs).toEqual(['{{params.stageOneApprover}}']);
    expect((gates[1]!.config as { approverRefs?: string[] }).approverRefs).toEqual(['{{params.stageTwoApprover}}']);
    // Ordering: stageOne → stageTwo edge exists (the sequential-chain composition).
    expect(chain.dag.edges?.some((e) => e.from === 'stageOne' && e.to === 'stageTwo')).toBe(true);
  });

  it.each(CHAINS)('%s expands deterministically; params FROZEN at expansion (Path A)', (id) => {
    const chain = getChain(id)!.chain;
    const def = expandChain(chain, { params: { item: 'Q3 vendor contract' } });
    expect(def.nodes.filter((n) => n.outputRole === 'primary')).toHaveLength(1);
    expect(expandChain(chain, { params: { item: 'Q3 vendor contract' } })).toEqual(def);
    // Path A: no run-overridable variables[]; params frozen into config, so the
    // persisted definition contains no residual {{params.*}} tokens.
    expect(def.variables).toBeUndefined();
    expect(JSON.stringify(def.nodes)).not.toContain('{{params');
  });
});
