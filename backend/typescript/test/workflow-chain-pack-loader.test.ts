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
  prettifyPackCategory,
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

  it('RFC 0013 Path A — expands to a validated WorkflowDefinition: {{params.*}} FROZEN at expansion, ids rewritten', () => {
    const def = expandChain(chain(), { params: { topic: 'AI ops tooling' } });
    // workflowId carries the deterministic expansion id (now folds canonical params)
    expect(def.workflowId).toMatch(/^market-intel\.digest:[0-9a-f]{12}$/);
    // node ids are rewritten with the collision-free prefix; published typeIds preserved
    expect(def.nodes).toHaveLength(4);
    for (const n of def.nodes) expect(n.nodeId.startsWith('market-intel_digest_')).toBe(true);
    expect(def.nodes.map((n) => n.typeId)).toEqual([
      'market-intel.ai-discovery',
      'market-intel.voc-extraction',
      'market-intel.opportunity-scoring',
      'core.ai.chatCompletion',
    ]);
    // Path A: params are FROZEN into config at expansion time — NOT materialized
    // as run-overridable variables[]. The persisted definition is portable: it
    // carries the concrete value and ZERO {{params.*}} / {{inputs.*}} tokens.
    expect(def.variables).toBeUndefined();
    const synth = def.nodes.find((n) => n.typeId === 'core.ai.chatCompletion')!;
    const sys = (synth.config as { systemPrompt: string }).systemPrompt;
    expect(sys).toContain('AI ops tooling');     // frozen value
    expect(sys).not.toContain('{{params');       // no token survives (portability)
    expect(sys).not.toContain('{{inputs');
    // provenance anchor for re-parameterization (re-expand with new params).
    // Records the RESOLVED params frozen into the definition — provided values
    // plus any schema defaults (here `audience` defaults to '') — so re-expansion
    // reproduces byte-identically.
    expect(def.metadata?.expandedFrom).toMatchObject({
      chainId: 'market-intel.digest',
      version: chain().version,
      params: { topic: 'AI ops tooling' },
    });
    expect((def.metadata?.expandedFrom as { params: Record<string, unknown> }).params.topic).toBe('AI ops tooling');
    // edges mapped with rewritten ids; terminal node is primary; provenance kept
    expect(def.edges).toHaveLength(3);
    expect(def.nodes.filter((n) => n.outputRole === 'primary')).toHaveLength(1);
    expect(synth.outputRole).toBe('primary');
    expect(def.metadata?.source).toBe('workflow-chain-pack');
    expect(def.metadata?.chainId).toBe('market-intel.digest');
  });

  it('R2 — expansion is deterministic: same (chain,params) ⇒ byte-identical', () => {
    const a = expandChain(chain(), { params: { topic: 'X', audience: 'CFOs' } });
    const b = expandChain(chain(), { params: { topic: 'X', audience: 'CFOs' } });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a)); // including node-id rewrite + workflowId
  });

  it('collision-safe (RFC 0013 §expansion step 6): different params ⇒ DIFFERENT workflowId + different frozen value', () => {
    const a = expandChain(chain(), { params: { topic: 'X' } });
    const b = expandChain(chain(), { params: { topic: 'Y' } });
    // Path A freezes params into config, so the expansion id MUST fold the
    // canonical params — else two drops of the same chain with different params
    // collide on the same workflowId and overwrite each other in the owned store.
    expect(a.workflowId).not.toBe(b.workflowId);
    const sysA = (a.nodes.find((n) => n.typeId === 'core.ai.chatCompletion')!.config as { systemPrompt: string }).systemPrompt;
    const sysB = (b.nodes.find((n) => n.typeId === 'core.ai.chatCompletion')!.config as { systemPrompt: string }).systemPrompt;
    expect(sysA).toContain('X');
    expect(sysB).toContain('Y');
    expect(sysA).not.toBe(sysB);
  });

  it('R3 — persisting the expansion via the builder registry resolves identically', () => {
    const def = expandChain(chain(), { params: { topic: 'Renewals' } });
    registerWorkflow(def);
    const resolved = getRegisteredWorkflow(def.workflowId);
    expect(resolved).toBeDefined();
    expect(JSON.stringify(resolved)).toBe(JSON.stringify(def)); // byte-stable → :fork-safe
  });

  it('"just copy" (no params): still expands portably — no variables[], ZERO residual tokens (frozen empty)', () => {
    const def = expandChain(chain(), { params: {} });
    // no throw. Under Path A there is no run-time deferral: a missing param with
    // no schema default resolves to empty at expansion (the token is substituted
    // away, not carried). The persisted definition therefore contains NO
    // {{params.*}} / {{inputs.*}} tokens — portability holds even for the
    // form-less "copy" flow. (The reusable "fill values per run" ergonomic for
    // required params is the deferred mode — RFC 0124 / WCP4 — not Path A.)
    expect(def.variables).toBeUndefined();
    expect(JSON.stringify(def.nodes)).not.toContain('{{params.topic}}');
    expect(JSON.stringify(def.nodes)).not.toContain('{{inputs.topic}}');
    expect(def.metadata?.expandedFrom).toMatchObject({ chainId: 'market-intel.digest', params: {} });
  });

  it('R8/chain_unresolvable_typeid — an unknown typeId is rejected when a resolver is supplied', () => {
    expect(() => expandChain(chain(), { params: { topic: 'X' }, isTypeIdKnown: () => false })).toThrow(
      /chain_unresolvable_typeid/,
    );
    // and passes when the resolver knows the typeIds
    expect(() => expandChain(chain(), { params: { topic: 'X' }, isTypeIdKnown: () => true })).not.toThrow();
  });

  it('prettifyPackCategory title-cases the pack leaf and upper-cases abbreviations', () => {
    expect(prettifyPackCategory('core.openwop.workflows.exec-ops')).toBe('Exec Ops');
    expect(prettifyPackCategory('core.openwop.workflows.finance')).toBe('Finance');
    expect(prettifyPackCategory('core.openwop.workflows.market-intel')).toBe('Market Intel');
    expect(prettifyPackCategory('core.openwop.workflows.it-support')).toBe('IT Support');
    expect(prettifyPackCategory('core.openwop.workflows.people-hr')).toBe('People HR');
  });
});
