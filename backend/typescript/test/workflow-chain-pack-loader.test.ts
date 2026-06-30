/**
 * Workflow-chain pack loader + expansion (ADR 0152 / RFC 0013).
 *
 * Retires the architect's #1 risk (R2): expansion is FROZEN + deterministic, the
 * expanded definition validates (R8), and persisting it via the existing builder
 * registry resolves byte-identically (R3) — so a `:fork` replays the same DAG.
 * Exercises the real vendored pack (examples/workflow-chain-packs/market-intel-digest).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  getChain,
  listChains,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { registerWorkflow, getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';

beforeAll(() => {
  _resetChainRegistryForTest();
  const { installed, errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]); // the vendored pack must be schema-valid + load clean
  expect(installed.length).toBeGreaterThan(0);
});

describe('workflow-chain pack loader — discovery', () => {
  it('loads the vendored core.openwop.workflows.market-intel pack + its chain', () => {
    const entry = getChain('market-intel.digest');
    expect(entry).not.toBeNull();
    expect(entry!.packName).toBe('core.openwop.workflows.market-intel');
    expect(entry!.chain.dag.nodes.length).toBe(4);
    expect(listChains().some((c) => c.chain.chainId === 'market-intel.digest')).toBe(true);
  });

  it('returns null for an unknown chain', () => {
    expect(getChain('nope.missing')).toBeNull();
  });
});

describe('workflow-chain pack loader — expansion (RFC 0013 §expansion)', () => {
  const chain = () => getChain('market-intel.digest')!.chain;

  it('expands to a validated WorkflowDefinition with params substituted + ids rewritten', () => {
    const def = expandChain(chain(), { params: { topic: 'AI ops tooling' } });
    // workflowId carries the deterministic expansion id
    expect(def.workflowId).toMatch(/^market-intel\.digest:[0-9a-f]{12}$/);
    // node ids are rewritten with the collision-free prefix; published typeIds preserved
    expect(def.nodes).toHaveLength(4);
    for (const n of def.nodes) expect(n.nodeId.startsWith('market-intel-digest_')).toBe(true);
    expect(def.nodes.map((n) => n.typeId)).toEqual([
      'market-intel.ai-discovery',
      'market-intel.voc-extraction',
      'market-intel.opportunity-scoring',
      'core.ai.chatCompletion',
    ]);
    // {{params.topic}} fully substituted — no placeholder leaks
    const synth = def.nodes.find((n) => n.typeId === 'core.ai.chatCompletion')!;
    const sys = (synth.config as { systemPrompt: string }).systemPrompt;
    expect(sys).toContain('AI ops tooling');
    expect(sys).not.toContain('{{params');
    // edges mapped from {from,to} → {sourceNodeId,targetNodeId} with rewritten ids
    expect(def.edges).toHaveLength(3);
    for (const e of def.edges!) {
      expect(e.sourceNodeId.startsWith('market-intel-digest_')).toBe(true);
      expect(e.targetNodeId.startsWith('market-intel-digest_')).toBe(true);
    }
    // terminal node (synthesize) is the primary deliverable
    expect(def.nodes.filter((n) => n.outputRole === 'primary')).toHaveLength(1);
    expect(synth.outputRole).toBe('primary');
    // provenance metadata
    expect(def.metadata?.source).toBe('workflow-chain-pack');
    expect(def.metadata?.chainId).toBe('market-intel.digest');
  });

  it('R2 — expansion is FROZEN/deterministic: same (chain,params) ⇒ byte-identical', () => {
    const a = expandChain(chain(), { params: { topic: 'X', audience: 'CFOs' } });
    const b = expandChain(chain(), { params: { topic: 'X', audience: 'CFOs' } });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a)); // including node-id rewrite + workflowId
  });

  it('different params ⇒ a different (still deterministic) expansion id', () => {
    const a = expandChain(chain(), { params: { topic: 'X' } });
    const b = expandChain(chain(), { params: { topic: 'Y' } });
    expect(a.workflowId).not.toBe(b.workflowId);
  });

  it('R3 — persisting the frozen expansion via the builder registry resolves identically', () => {
    const def = expandChain(chain(), { params: { topic: 'Renewals' } });
    registerWorkflow(def);
    const resolved = getRegisteredWorkflow(def.workflowId);
    expect(resolved).toBeDefined();
    expect(JSON.stringify(resolved)).toBe(JSON.stringify(def)); // byte-stable → :fork-safe
  });

  it('chain_parameter_invalid — a missing required param is rejected', () => {
    expect(() => expandChain(chain(), { params: {} })).toThrow(/chain_parameter_invalid/);
  });

  it('R8/chain_unresolvable_typeid — an unknown typeId is rejected when a resolver is supplied', () => {
    expect(() => expandChain(chain(), { params: { topic: 'X' }, isTypeIdKnown: () => false })).toThrow(
      /chain_unresolvable_typeid/,
    );
    // and passes when the resolver knows the typeIds
    expect(() => expandChain(chain(), { params: { topic: 'X' }, isTypeIdKnown: () => true })).not.toThrow();
  });
});
