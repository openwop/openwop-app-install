/**
 * ADR 0603 §2 / `PODWF-1` — a CORPUS-WIDE fail-open parameter drop.
 *
 * `buildChainBackedDefinition` restores the bare launch-contract param names onto
 * `def.variables[]` and every node input (un-prefixing the deferred materialization),
 * and used to leave `metadata.deferredParameterAliases` — the RFC 0124 G1 map that
 * `deferredConfigurableInputs` translates a run's `configurable` overlay THROUGH —
 * pointing at the PRE-rename names.
 *
 * The failure was FAIL-OPEN, which is why nobody saw it:
 *   `configurableSchema` is keyed by the BARE name, so validation passes (no 400);
 *   the run starts; the alias maps `episodeId` onto a variable name NO declaration
 *   carries; `seedRunVariables` seeds NOTHING; every node then reads `undefined` and
 *   the eventual error surfaces deep inside a node and never names the parameter.
 *
 * These tests EXECUTE the drop (they seed a real run bag through the real
 * `deferredConfigurableInputs` → `seedRunVariables` path). A test that only inspected
 * the metadata object would be a weaker witness — the metadata is the mechanism, the
 * empty bag is the harm.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest,
  listChains,
} from '../src/host/workflowChainPackLoader.js';
import { buildChainBackedDefinition, _resetChainBackedWorkflowsForTest } from '../src/host/chainBackedWorkflows.js';
import {
  deferredConfigurableInputs, seedRunVariables, snapshotRunVariables, clearRunVariables,
} from '../src/host/variablesRuntime.js';

beforeAll(() => {
  _resetChainRegistryForTest();
  _resetChainBackedWorkflowsForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);
});

const aliasesOf = (def: { metadata?: Record<string, unknown> }): Record<string, string> =>
  (def.metadata?.deferredParameterAliases ?? {}) as Record<string, string>;

/** The real run-creation path: `configurable` overlay → alias translation → bag. */
function seedBag(
  runId: string,
  def: { metadata?: Record<string, unknown>; variables?: ReadonlyArray<{ name: string }> },
  configurable: Record<string, unknown>,
): Record<string, unknown> | null {
  clearRunVariables(runId);
  seedRunVariables(
    runId,
    def.variables as never,
    deferredConfigurableInputs(def, configurable, undefined),
  );
  return snapshotRunVariables(runId);
}

describe('PODWF-1 — the `configurable` launch lane actually reaches the run bag', () => {
  it('podcasts.generate: `configurable:{episodeId}` seeds `episodeId` (was: an EMPTY bag)', () => {
    const def = buildChainBackedDefinition('podcasts.generate');
    // The mechanism: after the bare-name restore, the alias is bare → bare.
    expect(aliasesOf(def)).toEqual({ episodeId: 'episodeId' });
    // The harm: the bag. This is the assertion the defect actually broke.
    expect(seedBag('podwf1-pod', def, { episodeId: 'ep_A' })).toEqual({ episodeId: 'ep_A' });
  });

  it('a MULTI-param chain seeds every overridden param (notebooks.mcp.search)', () => {
    const def = buildChainBackedDefinition('notebooks.mcp.search');
    const bag = seedBag('podwf1-nb', def, { notebookId: 'nb_1', query: 'why', topK: 3 });
    expect(bag).toMatchObject({ notebookId: 'nb_1', query: 'why', topK: 3 });
  });
});

describe('PODWF-1 — the corpus, measured rather than asserted from a table', () => {
  it('EVERY chain-backed definition\'s alias values are DECLARED variables', () => {
    let built = 0;
    let withAliases = 0;
    const broken: string[] = [];
    for (const c of listChains()) {
      let def;
      try { def = buildChainBackedDefinition(c.chain.chainId); } catch { continue; }
      built++;
      const aliases = aliasesOf(def);
      if (Object.keys(aliases).length === 0) continue;
      withAliases++;
      const declared = new Set((def.variables ?? []).map((v) => v.name));
      const bad = Object.entries(aliases).filter(([, v]) => !declared.has(v));
      if (bad.length) broken.push(`${c.chain.chainId}: ${bad.map(([k, v]) => `${k}->${v}`).join(', ')}`);
    }
    // NON-VACUITY FLOORS — these would FAIL on the regression this test guards.
    // MEASURED on this tree: 179 chains load, 138 carry a deferred-param alias map,
    // and before the fix ALL 138 were broken. A floor of "> 0" would have passed with
    // the fix reverted (there would still be chains and still be alias maps); what
    // could NOT survive the revert is a population this size with ZERO breakage.
    expect(built).toBeGreaterThanOrEqual(170);
    expect(withAliases).toBeGreaterThanOrEqual(130);
    expect(broken, `alias→variable mismatches (fail-open configurable drops)`).toEqual([]);
  });

  it('a FULL `configurable` overlay round-trips into the bag for every param-carrying chain', () => {
    // Population: EVERY loaded chain — a strict SUPERSET of the 39 ADR 0472 MIGRATED
    // ids (measured separately: 39 MIGRATED chainIds all load, 34 of them carry a
    // non-empty alias map). Stated that way deliberately: this test iterates what it
    // can enumerate by CALL, and does not restate the ratchet's hand-written table.
    // The previous assertion above proves the aliases RESOLVE; this one proves that
    // resolution survives the whole overlay→bag path for every param at once.
    let checked = 0;
    for (const id of listChains().map((c) => c.chain.chainId)) {
      let def;
      try { def = buildChainBackedDefinition(id); } catch { continue; }
      const aliases = aliasesOf(def);
      const params = Object.keys(aliases);
      if (params.length === 0) continue;
      const bag = seedBag(`podwf1-${id}`, def, Object.fromEntries(params.map((p) => [p, `v_${p}`])));
      expect(Object.keys(bag ?? {}).sort(), `bag for ${id}`).toEqual([...params].sort());
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(130);
  });
});

describe('PODWF-1 — the cure MERGES; it never replaces the metadata', () => {
  it('the alias rewrite leaves every other chain-derived metadata key intact', () => {
    const def = buildChainBackedDefinition('podcasts.generate');
    // A `def.metadata = { ...src.metadata }` cure would have deleted all of these —
    // trading one silent no-op for another.
    expect(def.metadata).toMatchObject({
      source: 'workflow-chain-pack',
      chainId: 'podcasts.generate',
      expansionMode: 'deferred',
    });
    expect(def.metadata?.expandedFrom).toBeTruthy();
  });

  it('an alias whose variable was NOT renamed is left exactly as it was', () => {
    // RFC 0133 §2 produced variables are used VERBATIM (no prefix) and are never
    // renamed by the restore loop, so nothing about them may be rewritten either.
    const def = buildChainBackedDefinition('kicktodo.plan-generation');
    const declared = new Set((def.variables ?? []).map((v) => v.name));
    for (const [bare, varName] of Object.entries(aliasesOf(def))) {
      expect(declared.has(varName), `${bare}->${varName} must resolve`).toBe(true);
    }
    expect(declared.has('plan'), 'the produced variable survives the rewrite').toBe(true);
  });

  it('the MCP-projection lane keeps its ADR 0087 gates AND its aliases', async () => {
    // `registerMcpProjectionWorkflows` restored `src.metadata` with a REPLACE, which
    // deleted the alias map for 3 of the 4 sampled projections — making the fix above
    // structurally unreachable for that whole lane. It now merges.
    const { registerMcpProjectionWorkflows } = await import('../src/features/index.js');
    const { getChainBackedWorkflow } = await import('../src/host/chainBackedWorkflows.js');
    registerMcpProjectionWorkflows();
    const def = getChainBackedWorkflow('notebooks.mcp.search');
    expect(def, 'the projection must register').toBeTruthy();
    // The gates are byte-identical to the source (the reason the replace existed).
    expect(def!.metadata).toMatchObject({ kind: 'meta-workflow', mcpRequiresAuth: true });
    // ...and the chain-derived keys the replace used to destroy are still there.
    expect(aliasesOf(def!)).toEqual({ notebookId: 'notebookId', query: 'query', topK: 'topK' });
    expect(seedBag('podwf1-mcp', def!, { notebookId: 'nb_9', query: 'q' }))
      .toEqual({ notebookId: 'nb_9', query: 'q' });
  });
});
