/**
 * RFC 0133 migration — `plan-generation` builtin → chain pack.
 *
 * The `openwop-app.kicktodo.plan-generation` builtin (deprecated ADR 0072 array)
 * migrated to `examples/workflow-chain-packs/kicktodo-plan-generation/` — the
 * cleanest of the 5 format-ext-blocked builtins: a pure RFC 0133 §2 produced-variable
 * case (`generate` writes `plan` to the run bag, `decompose` reads it by name) with
 * no sub-chain and no conditional edges. This is the reference conversion for the
 * produced-variable pattern, and it proves the chain now shows in the builder gallery
 * + `/` picker (a code-pinned builtin never does). It replaces the builtin-array
 * dataflow assertion that used to live in `kicktodo-builtin-workflow-dataflow.test.ts`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  getChain,
  expandChain,
  validateChainComposition,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { kicktodoCreatorBuiltinWorkflows } from '../src/features/kicktodo-creator/builtinWorkflows.js';

beforeAll(() => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  // Every vendored pack — including the migrated plan-generation pack, which uses the
  // RFC 0133 `producedVariables` field the vendored manifest schema now accepts —
  // MUST load clean.
  expect(errors).toEqual([]);
});

describe('plan-generation migrated OUT of the deprecated builtin array', () => {
  it('is no longer a code-pinned builtin', () => {
    expect(
      kicktodoCreatorBuiltinWorkflows.some((w) => w.workflowId === 'openwop-app.kicktodo.plan-generation'),
    ).toBe(false);
  });
});

describe('plan-generation chain pack (RFC 0133 produced-variable pattern)', () => {
  const chain = () => getChain('kicktodo.plan-generation')!.chain;

  it('loads from the vendored pack + is namespaced as a chain', () => {
    const entry = getChain('kicktodo.plan-generation');
    expect(entry).not.toBeNull();
    expect(entry!.packName).toBe('core.openwop.workflows.kicktodo-plan-generation');
    expect(entry!.chain.dag.nodes.map((n) => n.id).sort()).toEqual(['decompose', 'generate']);
  });

  it('declares `plan` as a produced variable (producedBy the generate node) — closed-world clean', () => {
    const c = chain();
    expect(c.producedVariables).toEqual([
      expect.objectContaining({ name: 'plan', producedBy: 'generate', type: 'object' }),
    ]);
    // validateChainComposition: decompose reads {type:variable plan}; plan resolves
    // to the produced variable, the {{params.*}} run inputs resolve to parameters.
    expect(validateChainComposition(c)).toBeNull();
  });

  it('expands with `plan` emitted VERBATIM into variables[] (unprefixed, so the read resolves)', () => {
    const def = expandChain(chain(), {
      deferred: true,
      params: { candidateId: 'cand:1', topic: 'sleep', audience: 'busy pros', authorSubject: 'user:a1' },
    });
    const names = (def.variables ?? []).map((v) => v.name);
    // The produced variable is emitted with its EXACT declared name (no expansion
    // prefix) so the decompose node's {type:variable plan} read binds to it.
    expect(names).toContain('plan');
    // The 5 run-input parameters materialize (deferred mode) with the collision-free
    // prefix — they are per-run, not frozen.
    expect(names.some((n) => n.endsWith('_candidateId'))).toBe(true);
    // decompose still reads the produced plan (the whole point of the produced-variable
    // pattern — a value written to the bag with no typed output port).
    const decompose = def.nodes.find((n) => n.nodeId.endsWith('decompose'))!;
    expect(JSON.stringify(decompose.inputs)).toContain('"variableName":"plan"');
  });
});
