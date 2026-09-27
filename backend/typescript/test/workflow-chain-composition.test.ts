/**
 * RFC 0133 — workflow-chain composition (host implementation).
 * Sub-chains (runtime child chains, co-registered) + produced variables.
 */
import { describe, it, expect } from 'vitest';
import {
  expandChain, coRegisterSubChains, detectSubChainCycles, validateChainComposition,
  mintChildWorkflowId, MAX_SUB_CHAIN_DEPTH,
  type WorkflowChain, type SubChainDeps,
} from '../src/host/workflowChainPackLoader.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const chain = (over: Partial<WorkflowChain>): WorkflowChain => ({
  chainId: 'c.parent', version: '1.0.0', label: 'Parent', description: 'p',
  parameters: { type: 'object', properties: {} },
  dag: { nodes: [{ id: 'n1', typeId: 'core.fail', config: {} }], edges: [] },
  ...over,
});

describe('RFC 0133 §2 — produced variables → variables[]', () => {
  it('emits declared producedVariables into the expanded definition variables[] (run-scoped, no defaultValue)', () => {
    const c = chain({
      dag: { nodes: [
        { id: 'gen', typeId: 'core.fail', config: {} },
        { id: 'use', typeId: 'core.fail', inputs: { plan: { type: 'variable', variableName: 'plan' } } },
      ], edges: [{ from: 'gen', to: 'use' }] },
      producedVariables: [{ name: 'plan', producedBy: 'gen', type: 'object', description: 'the plan' }],
    });
    const def = expandChain(c);
    const v = (def.variables ?? []).find((x) => x.name === 'plan');
    expect(v).toBeTruthy();
    expect(v).toMatchObject({ name: 'plan', type: 'object', required: false });
    expect(v).not.toHaveProperty('defaultValue');
  });
});

describe('RFC 0133 — load-time closed-world validation', () => {
  it('rejects a {type:variable} read that is neither a producedVariable nor a param (variable_undeclared)', () => {
    const c = chain({ dag: { nodes: [{ id: 'use', typeId: 'core.fail', inputs: { x: { type: 'variable', variableName: 'ghost' } } }], edges: [] } });
    expect(validateChainComposition(c)?.code).toBe('variable_undeclared');
  });
  it('accepts a variable read that resolves to a producedVariable', () => {
    const c = chain({
      dag: { nodes: [{ id: 'g', typeId: 'core.fail', config: {} }, { id: 'u', typeId: 'core.fail', inputs: { x: { type: 'variable', variableName: 'v' } } }], edges: [] },
      producedVariables: [{ name: 'v', producedBy: 'g', type: 'string' }],
    });
    expect(validateChainComposition(c)).toBeNull();
  });
  it('rejects a fragment node that pins config.workflowId (chain_fragment_pins_workflow_id)', () => {
    const c = chain({ dag: { nodes: [{ id: 'n1', typeId: 'core.subWorkflow', config: { workflowId: 'wf.hardcoded' } }], edges: [] } });
    expect(validateChainComposition(c)?.code).toBe('chain_fragment_pins_workflow_id');
  });
  it('rejects a subChainRef not declared in subChains[] (sub_chain_unresolved)', () => {
    const c = chain({ dag: { nodes: [{ id: 'n1', typeId: 'core.subWorkflow', config: { subChainRef: 'nope' } }], edges: [] } });
    expect(validateChainComposition(c)?.code).toBe('sub_chain_unresolved');
  });
  it('rejects producedBy that is not a node id (produced_var_producer_unknown — a bad PRODUCER)', () => {
    expect(validateChainComposition(chain({ producedVariables: [{ name: 'v', producedBy: 'ghost', type: 'string' }] }))?.code).toBe('produced_var_producer_unknown');
  });
  it('rejects a produced/param name collision (folds into variable_undeclared per the final 7-code set)', () => {
    // The final RFC 0133 error table has NO produced_var_param_collision code — a
    // produced↔param name clash (author-time vs run-scoped channels not disjoint) is
    // reported as variable_undeclared (openwop-1 msg a2d6; spec validateVariableReads).
    const collide = chain({ parameters: { type: 'object', properties: { dupe: { type: 'string' } } }, producedVariables: [{ name: 'dupe', producedBy: 'n1', type: 'string' }] });
    expect(validateChainComposition(collide)?.code).toBe('variable_undeclared');
  });
});

describe('RFC 0133 §1.1 — sibling sub-chain cycle detection', () => {
  it('detects a two-chain cycle', () => {
    const a = chain({ chainId: 'a', subChains: [{ ref: 'b' }] });
    const b = chain({ chainId: 'b', subChains: [{ ref: 'a' }] });
    expect(detectSubChainCycles([a, b]).sort()).toEqual(['a', 'b']);
  });
  it('is empty for an acyclic pack', () => {
    const a = chain({ chainId: 'a', subChains: [{ ref: 'b' }] });
    const b = chain({ chainId: 'b' });
    expect(detectSubChainCycles([a, b])).toEqual([]);
  });
});

describe('RFC 0133 §1.3 — co-registration', () => {
  const child = chain({ chainId: 'lesson-batch', label: 'Lesson Batch', dag: { nodes: [{ id: 'x', typeId: 'core.fail', config: {} }], edges: [] } });
  const parent = chain({
    chainId: 'factory',
    dag: { nodes: [{ id: 'build', typeId: 'core.subWorkflow', config: { subChainRef: 'lesson-batch' } }], edges: [] },
    subChains: [{ ref: { packName: 'p', chainId: 'lesson-batch', version: '1' } }],
  });
  const mkDeps = (supported = true) => {
    const registered: WorkflowDefinition[] = [];
    const owned: string[] = [];
    const deps: SubChainDeps = {
      register: (d) => registered.push(d),
      own: async (id) => { owned.push(id); },
      supported,
      resolveExternal: (ref) => (ref.chainId === 'lesson-batch' ? child : null),
    };
    return { deps, registered, owned };
  };

  it('co-registers the child (child BEFORE parent), rewrites subChainRef → the minted workflowId', async () => {
    const { deps, registered, owned } = mkDeps();
    const { definition, registeredChildIds } = await coRegisterSubChains(parent, { params: {}, tenantId: 't1' }, deps);
    expect(registeredChildIds).toHaveLength(1);
    const childId = registeredChildIds[0]!;
    expect(childId).toMatch(/^wf\.lesson-batch\.sc-[0-9a-f]{12}$/);
    // Child was registered + owned (before the parent, which the ROUTE registers).
    expect(registered.map((d) => d.workflowId)).toEqual([childId]);
    expect(owned).toEqual([childId]);
    // The parent node's subChainRef is gone; workflowId now points at the child.
    // (expandChain prefixes node ids, so find by config, not the original 'build'.)
    const node = definition.nodes[0]!;
    expect((node.config as Record<string, unknown>).workflowId).toBe(childId);
    expect(node.config as Record<string, unknown>).not.toHaveProperty('subChainRef');
  });

  it('mints a DETERMINISTIC child id (same tenant+child ⇒ same id, dedup/convergent)', async () => {
    const a = await coRegisterSubChains(parent, { params: {}, tenantId: 't1' }, mkDeps().deps);
    const b = await coRegisterSubChains(parent, { params: {}, tenantId: 't1' }, mkDeps().deps);
    expect(a.registeredChildIds).toEqual(b.registeredChildIds);
    // Different tenant ⇒ different id (tenant-scoped).
    const c = await coRegisterSubChains(parent, { params: {}, tenantId: 't2' }, mkDeps().deps);
    expect(c.registeredChildIds[0]).not.toBe(a.registeredChildIds[0]);
  });

  it('refuses (sub_chain_unsupported) on a host without runtime child dispatch — never flattens', async () => {
    const { deps, registered } = mkDeps(false);
    await expect(coRegisterSubChains(parent, { params: {}, tenantId: 't1' }, deps)).rejects.toMatchObject({ code: 'sub_chain_unsupported' });
    expect(registered).toHaveLength(0); // nothing registered on refuse
  });

  it('F3 (ADR 0472 P4): a co-registered child declares its dispatch-seeded params as variables[]', async () => {
    // A child receives its inputs from the parent inputMapping at dispatch; the executor
    // only seeds DECLARED variables, so the child def MUST declare them. Path-A expandChain
    // emits none for a chain's parameters — coRegisterSubChains now backfills them.
    const seededChild = chain({
      chainId: 'lesson-batch',
      parameters: { type: 'object', properties: { candidateId: { type: 'string' }, days: { type: 'array' }, generateMedia: { type: 'boolean' } } },
      dag: { nodes: [{ id: 'x', typeId: 'core.fail', inputs: { candidateId: { type: 'variable', variableName: 'candidateId' } } }], edges: [] },
    });
    const { deps, registered } = mkDeps();
    deps.resolveExternal = (ref) => (ref.chainId === 'lesson-batch' ? seededChild : null);
    const { registeredChildIds } = await coRegisterSubChains(parent, { params: {}, tenantId: 't1' }, deps);
    const childDef = registered.find((d) => registeredChildIds.includes(d.workflowId))!;
    const names = (childDef.variables ?? []).map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(['candidateId', 'days', 'generateMedia']));
    // dispatch-seeded ⇒ no author defaultValue (SR-1 at-rest guard).
    expect((childDef.variables ?? []).every((v) => v.defaultValue === undefined)).toBe(true);
  });

  it('a chain with NO subChains returns the definition unchanged, no children', async () => {
    const { deps, registered } = mkDeps();
    const { definition, registeredChildIds } = await coRegisterSubChains(chain({ chainId: 'plain' }), { params: {}, tenantId: 't1' }, deps);
    expect(registeredChildIds).toEqual([]);
    expect(registered).toHaveLength(0);
    expect(definition.nodes).toHaveLength(1);
  });
});

describe('RFC 0133 §1.3 — deterministic tenant-scoped child id', () => {
  it('mintChildWorkflowId is keyed on exactly (tenantId, childChainId, version)', () => {
    const base = mintChildWorkflowId('t1', 'lesson-batch', '1.0.0');
    expect(base).toMatch(/^wf\.lesson-batch\.sc-[0-9a-f]{12}$/);
    expect(mintChildWorkflowId('t1', 'lesson-batch', '1.0.0')).toBe(base); // deterministic
    expect(mintChildWorkflowId('t2', 'lesson-batch', '1.0.0')).not.toBe(base); // tenant-scoped
    expect(mintChildWorkflowId('t1', 'lesson-batch', '2.0.0')).not.toBe(base); // version-pinned
    expect(mintChildWorkflowId('t1', 'other-child', '1.0.0')).not.toBe(base); // child-distinct
  });
});

describe('RFC 0133 §1.3 — depth bound (sub_chain_max_depth_exceeded)', () => {
  it('refuses when nesting exceeds MAX_SUB_CHAIN_DEPTH — the DoS backstop, distinct from a cycle', async () => {
    // A self-recursive-by-version chain: each level references a fresh child chainId
    // so it is NOT a cycle (visited-set never repeats), forcing the depth bound.
    const linkChain = (n: number): WorkflowChain => chain({
      chainId: `link-${n}`,
      dag: { nodes: [{ id: 'd', typeId: 'core.subWorkflow', config: { subChainRef: `link-${n + 1}` } }], edges: [] },
      subChains: [{ ref: { packName: 'p', chainId: `link-${n + 1}`, version: '1' } }],
    });
    const registered: WorkflowDefinition[] = [];
    const deps: SubChainDeps = {
      register: (d) => registered.push(d),
      own: async () => {},
      supported: true,
      // Every ref resolves to the next link — an unbounded chain of DISTINCT ids.
      resolveExternal: (ref) => linkChain(Number(ref.chainId.split('-')[1])),
    };
    await expect(
      coRegisterSubChains(linkChain(0), { params: {}, tenantId: 't1' }, deps),
    ).rejects.toMatchObject({ code: 'sub_chain_max_depth_exceeded' });
    expect(MAX_SUB_CHAIN_DEPTH).toBe(8);
  });
});
