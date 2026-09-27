/**
 * ADR 0524 Phase B — the measurement script's classifier.
 *
 * WHAT THIS IS GUARDING AGAINST. The whole point of Phase B is to produce a
 * number that a retirement decision will be made on. A classifier that quietly
 * folds "we cannot tell" into "clean" produces a reassuring number that means
 * nothing — and a reassuring number is far more dangerous than no number,
 * because nobody re-checks it. The UNKNOWABLE bucket is the assertion this file
 * exists to hold down.
 *
 * The second thing it holds down is PARITY. The script re-implements
 * "does this node carry inputs?" because `preserveDroppedFields`'s copy is
 * module-private. Two definitions of the same predicate is exactly how a tool
 * ends up measuring a population the guard does not act on, so the parity is
 * asserted behaviourally against the real guard rather than assumed.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyPopulation,
  nodesCarryingInputs,
  formatReport,
} from '../../../scripts/measure-stripped-workflow-inputs.mjs';
import { preserveDroppedFields } from '../src/host/preserveDroppedFields.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

/**
 * A definition with `n` nodes, the first `withInputs` of which carry inputs.
 *
 * The identity field is `nodeId` (`executor/types.ts:403`). These fixtures said
 * `id` until the sibling repair tool shipped a real defect keyed on that
 * non-existent field — nothing here READ the identity, so the wrong shape was
 * harmless, but a fixture that disagrees with production is a trap waiting for
 * the next assertion that does read it.
 */
function def(workflowId: string, nodes: number, withInputs: number): WorkflowDefinition {
  return {
    workflowId,
    nodes: Array.from({ length: nodes }, (_, i) => ({
      nodeId: `n${i}`,
      typeId: 'core.noop',
      ...(i < withInputs ? { inputs: { query: 'x' } } : {}),
    })),
    edges: [],
  } as unknown as WorkflowDefinition;
}

describe('nodesCarryingInputs', () => {
  it('counts only nodes with a NON-EMPTY inputs object', () => {
    expect(nodesCarryingInputs(def('w', 3, 2))).toBe(2);
    expect(nodesCarryingInputs(def('w', 3, 0))).toBe(0);
  });

  it('an EMPTY inputs object does not count — it carries no authored value', () => {
    const d = { workflowId: 'w', nodes: [{ nodeId: 'n0', typeId: 't', inputs: {} }], edges: [] };
    expect(nodesCarryingInputs(d)).toBe(0);
  });

  it('tolerates a malformed definition rather than throwing mid-scan', () => {
    // A scan that dies on one bad row reports nothing about the other 10,000.
    expect(nodesCarryingInputs(undefined)).toBe(0);
    expect(nodesCarryingInputs({ workflowId: 'w' })).toBe(0);
    expect(nodesCarryingInputs({ workflowId: 'w', nodes: [null, { nodeId: 'a' }] })).toBe(0);
  });

  /**
   * PARITY, over a VALUE MATRIX rather than a couple of happy cases.
   *
   * §Correction (code review). The first version of this test asserted two
   * cases — a populated object and `{}` — and both implementations agreed on
   * both, so it read as "parity proven". It was not: the script had added a
   * `typeof n.inputs === 'object'` test, and the two predicates genuinely
   * DISAGREED on `inputs: "abc"` (the guard counts it, because
   * `Object.keys('abc')` has length 3). Agreement on the cases you thought to
   * write is not parity — so the property is now driven from a table that
   * includes the truthy non-objects, which is exactly where they diverged.
   */
  it.each([
    ['a populated object', { q: 'x' }, true],
    ['an empty object', {}, false],
    ['a populated array', [1, 2], true],
    ['an empty array', [], false],
    ['a non-empty string — the case that caught the divergence', 'abc', true],
    ['an empty string', '', false],
    ['a number', 5, false],
    ['a boolean', true, false],
    ['null', null, false],
    ['undefined', undefined, false],
  ])('PARITY with the guard: %s', (_label, inputs, shouldCount) => {
    const withValue = {
      workflowId: 'w',
      nodes: [{ nodeId: 'n0', typeId: 't', ...(inputs === undefined ? {} : { inputs }) }],
      edges: [],
    } as unknown as WorkflowDefinition;
    const stripped = def('w', 1, 0);

    // 1. This counter's verdict.
    expect(nodesCarryingInputs(withValue) > 0, 'script counter').toBe(shouldCount);

    // 2. The guard's verdict, observed BEHAVIOURALLY (its counter is
    //    module-private). The guard arms only when the previous head carried
    //    inputs on >=1 node, so "did it preserve?" IS "did it count?".
    const guardCounted = preserveDroppedFields(stripped, withValue).preserved.includes('inputs');
    expect(guardCounted, 'guard verdict').toBe(shouldCount);

    // 3. The property that actually matters: they never disagree.
    expect(nodesCarryingInputs(withValue) > 0, 'script and guard disagree').toBe(guardCounted);
  });
});

describe('classifyPopulation', () => {
  it('a head with no inputs whose history HAD inputs is STRIPPED', () => {
    const r = classifyPopulation(
      [{ workflowId: 'w1', definition: def('w1', 2, 0) }],
      [{ workflowId: 'w1', tenantId: 'user:alice', definition: def('w1', 2, 2) }],
    );
    expect(r.counts.stripped).toBe(1);
    expect(r.counts.intact).toBe(0);
    expect(r.counts.unknowable).toBe(0);
  });

  it('a head that carries inputs is INTACT', () => {
    const r = classifyPopulation([{ workflowId: 'w1', definition: def('w1', 2, 1) }], []);
    expect(r.counts.intact).toBe(1);
    expect(r.counts.stripped).toBe(0);
  });

  it('THE LOAD-BEARING ONE: no inputs and no history with inputs is UNKNOWABLE, not intact', () => {
    // If this ever regresses to `intact`, every retirement decision downstream
    // is made on a number that counts "we cannot tell" as "fine".
    const r = classifyPopulation(
      [{ workflowId: 'w1', definition: def('w1', 2, 0) }],
      [{ workflowId: 'w1', tenantId: 'user:alice', definition: def('w1', 2, 0) }],
    );
    expect(r.counts.unknowable, 'an unclassifiable head was reported as clean').toBe(1);
    expect(r.counts.intact).toBe(0);
    expect(r.counts.stripped).toBe(0);
  });

  it('a head with NO revisions at all is UNKNOWABLE, not intact', () => {
    const r = classifyPopulation([{ workflowId: 'w1', definition: def('w1', 2, 0) }], []);
    expect(r.counts.unknowable).toBe(1);
  });

  it('counts DISTINCT tenants, not workflow×tenant pairs', () => {
    // A workflow can be owned by more than one tenant — the dual-ownership edge
    // `purgeTenantOwnedWorkflowDefs` handles explicitly. So BOTH directions of
    // the fan-out have to be pinned, and they need DIFFERENT shapes to pin:
    //
    //   w1 -> {alice, bob}   two tenants on one workflow
    //   w2 -> {alice}        alice again, on a second workflow
    //
    // Distinct tenants = 2 (alice, bob). Workflow×tenant pairs = 3. An earlier
    // version of this test used one workflow only, where "distinct" and "pairs"
    // both equal 2 — so it passed unchanged when the implementation was
    // sabotaged to count pairs. It asserted nothing.
    const r = classifyPopulation(
      [
        { workflowId: 'w1', definition: def('w1', 2, 0) },
        { workflowId: 'w2', definition: def('w2', 2, 0) },
      ],
      [
        { workflowId: 'w1', tenantId: 'user:alice', definition: def('w1', 2, 2) },
        { workflowId: 'w2', tenantId: 'user:alice', definition: def('w2', 2, 2) },
      ],
      [
        { workflowId: 'w1', tenantId: 'user:alice' },
        { workflowId: 'w1', tenantId: 'user:bob' },
        { workflowId: 'w2', tenantId: 'user:alice' },
      ],
    );
    expect(r.counts.stripped, 'two stripped workflows').toBe(2);
    expect(r.counts.strippedTenants, 'alice must not be counted twice').toBe(2);
  });

  it("the 'host' sentinel is not a tenant", () => {
    // `HOST_REVISION_TENANT` marks globally-shared seeded definitions. Counting
    // it would invent a tenant that does not exist.
    const r = classifyPopulation(
      [{ workflowId: 'wf.seed.x', definition: def('wf.seed.x', 1, 0) }],
      [{ workflowId: 'wf.seed.x', tenantId: 'host', definition: def('wf.seed.x', 1, 1) }],
    );
    expect(r.counts.stripped).toBe(1);
    expect(r.counts.strippedTenants).toBe(0);
    expect(r.counts.unownedHeads).toBe(1);
  });

  it('counts poisoned rollback targets (DD-0524-1)', () => {
    // Two stripped revisions of a workflow that once had inputs = two one-click
    // ways to re-break a head the guard already repaired.
    const r = classifyPopulation(
      [{ workflowId: 'w1', definition: def('w1', 2, 2) }],
      [
        { workflowId: 'w1', tenantId: 't', definition: def('w1', 2, 2) },
        { workflowId: 'w1', tenantId: 't', definition: def('w1', 2, 0) },
        { workflowId: 'w1', tenantId: 't', definition: def('w1', 2, 0) },
      ],
    );
    expect(r.counts.intact).toBe(1);
    expect(r.counts.poisonedRollbackTargets).toBe(2);
  });

  it('does not count a stripped revision of a never-populated workflow as poisoned', () => {
    const r = classifyPopulation(
      [{ workflowId: 'w1', definition: def('w1', 1, 0) }],
      [{ workflowId: 'w1', tenantId: 't', definition: def('w1', 1, 0) }],
    );
    expect(r.counts.poisonedRollbackTargets).toBe(0);
  });

  it('fixture guard: an empty population reports zeros, not a crash', () => {
    const r = classifyPopulation([], [], []);
    expect(r.counts).toMatchObject({ heads: 0, stripped: 0, intact: 0, unknowable: 0 });
  });
});

describe('formatReport', () => {
  it('warns that `stripped` is a FLOOR whenever anything is unknowable', () => {
    const r = classifyPopulation([{ workflowId: 'w1', definition: def('w1', 1, 0) }], []);
    const text = formatReport(r);
    expect(text).toContain('UNKNOWABLE');
    expect(text, 'the floor caveat is the whole point of the bucket').toContain('FLOOR');
  });

  it('does not emit the floor caveat when everything was classifiable', () => {
    // A permanent caveat is noise and gets skipped; it has to mean something.
    const r = classifyPopulation([{ workflowId: 'w1', definition: def('w1', 1, 1) }], []);
    expect(formatReport(r)).not.toContain('FLOOR');
  });

  it('REFUSES to report on an empty population instead of declaring it clean', () => {
    // §Correction (code review). The first version printed
    //   `stripped 0 … Every head was classifiable against its own history.`
    // for zero heads — so a DSN pointing at the wrong database, a drifted key
    // prefix, or an empty schema ALL produced a clean bill of health. That is
    // the "a broken check reads as a passing check" family this program exists
    // to close, reproduced inside the tool built to close it.
    const text = formatReport(classifyPopulation([], [], []));
    expect(text).toContain('REFUSING TO REPORT');
    expect(text, 'must say why a zero here is not good news').toContain('not evidence of a clean database');
    expect(text, 'must not print the reassuring all-clear line').not.toContain('Every head was classifiable');
  });

  it('still reports normally as soon as there is at least one head', () => {
    // The refusal must be triggered by an EMPTY population, not by "no findings"
    // — otherwise a genuinely clean database could never be reported as clean.
    const text = formatReport(classifyPopulation([{ workflowId: 'w', definition: def('w', 1, 1) }], []));
    expect(text).not.toContain('REFUSING TO REPORT');
    expect(text).toContain('Scanned 1 registered head(s)');
  });

  it('reports no single headline percentage', () => {
    // A "97% clean" line would be read as the answer and would silently absorb
    // the unknowable bucket. The report must stay four numbers.
    const r = classifyPopulation(
      [
        { workflowId: 'a', definition: def('a', 1, 1) },
        { workflowId: 'b', definition: def('b', 1, 0) },
      ],
      [{ workflowId: 'b', tenantId: 't', definition: def('b', 1, 1) }],
    );
    expect(formatReport(r)).not.toMatch(/\d+(\.\d+)?\s*%/);
  });
});
