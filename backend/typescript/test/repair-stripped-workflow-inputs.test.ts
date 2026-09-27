/**
 * ADR 0524 Phase C — the repair planner.
 *
 * This one WRITES to tenant-owned durable state, so the tests are biased toward
 * proving what it REFUSES to do. The dangerous failure here is not "failed to
 * repair" — it is "repaired something it should have left alone", because that
 * silently overwrites a definition a user owns.
 *
 * The planner is pure and the IO shell is thin by design: everything below runs
 * without a database.
 */
import { describe, expect, it } from 'vitest';
import {
  planRepair,
  planAll,
  pickRepairSource,
  formatPlan,
  type RepairNode,
  type RepairHead,
  type RepairRevision,
} from '../../../scripts/repair-stripped-workflow-inputs.mjs';

// The REAL node identity field is `nodeId` (`executor/types.ts:403`), which is
// what `preserveDroppedFields` keys on. The first version of this helper emitted
// `id`, so all 20 tests exercised a node shape the product never produces — and
// passed. A fixture that disagrees with production asserts nothing about it.
const node = (nodeId: string, typeId: string, inputs?: Record<string, unknown>): RepairNode => ({
  nodeId,
  typeId,
  ...(inputs ? { inputs } : {}),
});

const head = (workflowId: string, nodes: RepairNode[], extra: Record<string, unknown> = {}): RepairHead => ({
  workflowId,
  definition: { workflowId, nodes, ...extra },
});

const rev = (
  workflowId: string,
  seq: number,
  nodes: RepairNode[],
  extra: Record<string, unknown> = {},
): RepairRevision => ({
  workflowId,
  seq,
  revisionHash: `h${seq}`,
  definition: { workflowId, nodes, ...extra },
});

/**
 * Read a plan/revision's nodes with a real guard rather than `!.`.
 * A missing `nodes` array is a genuine failure of the thing under test, so it
 * should fail loudly here rather than be asserted away with a non-null.
 */
function nodesOf(def: { nodes?: RepairNode[] } | undefined): RepairNode[] {
  if (!def?.nodes) throw new Error('expected the definition to carry `nodes`');
  return def.nodes;
}

describe('pickRepairSource', () => {
  it('picks the most recent revision that ACTUALLY carried inputs', () => {
    // Not simply the latest revision — the latest is usually the stripped one.
    const source = pickRepairSource([
      rev('w', 1, [node('a', 't', { q: 'old' })]),
      rev('w', 5, [node('a', 't', { q: 'new' })]),
      rev('w', 9, [node('a', 't')]),
    ]);
    expect(source?.seq).toBe(5);
  });

  it('orders by `seq`, not by array position', () => {
    // `seq` is the durable order; `createdAt` ties at millisecond resolution, so
    // trusting arrival order would pick an arbitrary revision.
    const source = pickRepairSource([
      rev('w', 9, [node('a', 't', { q: 'newest' })]),
      rev('w', 2, [node('a', 't', { q: 'older' })]),
    ]);
    expect(nodesOf(source?.definition)[0].inputs?.q).toBe('newest');
  });

  it('returns null when no revision ever carried inputs', () => {
    expect(pickRepairSource([rev('w', 1, [node('a', 't')])])).toBeNull();
    expect(pickRepairSource([])).toBeNull();
  });
});

describe('planRepair — what it REFUSES to touch', () => {
  it('refuses a head that already carries inputs', () => {
    // The whole-set precondition. Repairing a partially-filled head would
    // overwrite values the user can see.
    const plan = planRepair(
      head('w', [node('a', 't', { q: 'mine' }), node('b', 't')]),
      [rev('w', 1, [node('a', 't', { q: 'old' }), node('b', 't', { q: 'old' })])],
    );
    expect(plan).toBeNull();
  });

  it('E-UNBLOCK: refuses a head whose LATEST revision DECLARED it models inputs', () => {
    // The whole point of the stamp. Once preset inputs are editable, an empty
    // head can mean "the user cleared it" — and repairing that resurrects values
    // someone deliberately removed, which is the strip's harm pointing the other
    // way. A declaring writer settles it.
    const plan = planRepair(
      head('w', [node('a', 't')]),
      [
        rev('w', 1, [node('a', 't', { q: 'x' })]),
        { ...rev('w', 2, [node('a', 't')]), declaredFields: ['inputs', 'variables'] },
      ],
    );
    expect(plan, 'a deliberate clear was resurrected').toBeNull();
  });

  it('E-UNBLOCK: still repairs when the latest revision declared something ELSE', () => {
    // Per-field. A client that models `variables` but not node `inputs` says
    // nothing about whether the inputs zero was intentional.
    const plan = planRepair(
      head('w', [node('a', 't')]),
      [
        rev('w', 1, [node('a', 't', { q: 'x' })]),
        { ...rev('w', 2, [node('a', 't')]), declaredFields: ['variables'] },
      ],
    );
    expect(plan?.restoredNodes, 'an unrelated declaration disabled the repair').toBe(1);
  });

  it('E-UNBLOCK: an OLDER declaring revision does not veto a later stripping write', () => {
    // Only the LATEST state is authoritative. A user who declared a clear and
    // then hit the runs-index lane on a stale bundle is back to a real strip.
    const plan = planRepair(
      head('w', [node('a', 't')]),
      [
        { ...rev('w', 1, [node('a', 't')]), declaredFields: ['inputs'] },
        rev('w', 2, [node('a', 't', { q: 'x' })]),
        rev('w', 3, [node('a', 't')]),
      ],
    );
    expect(plan?.restoredNodes).toBe(1);
  });

  it('refuses when no revision has anything to restore', () => {
    expect(planRepair(head('w', [node('a', 't')]), [rev('w', 1, [node('a', 't')])])).toBeNull();
  });

  it('refuses a node whose typeId CHANGED — inputs are type-shaped', () => {
    // Restoring values authored for `core.web.search` onto a node that is now
    // `core.email.send` produces values that match the wrong schema.
    const plan = planRepair(
      head('w', [node('a', 'core.email.send')]),
      [rev('w', 1, [node('a', 'core.web.search', { query: 'x' })])],
    );
    expect(plan, 'restored inputs across a type change').toBeNull();
  });

  it('does not resurrect a node the head deleted', () => {
    const plan = planRepair(
      head('w', [node('a', 't')]),
      [rev('w', 1, [node('a', 't', { q: 'x' }), node('gone', 't', { q: 'y' })])],
    );
    expect(nodesOf(plan?.definition)).toHaveLength(1);
    expect(nodesOf(plan?.definition).map((n) => n.nodeId)).toEqual(['a']);
  });

  it('gives a node the head ADDED nothing', () => {
    const plan = planRepair(
      head('w', [node('a', 't'), node('fresh', 't')]),
      [rev('w', 1, [node('a', 't', { q: 'x' })])],
    );
    expect(plan?.restoredNodes).toBe(1);
    expect(nodesOf(plan?.definition)[1].inputs).toBeUndefined();
  });
});

describe('planRepair — what it DOES', () => {
  it('restores inputs onto surviving nodes of the same type', () => {
    const plan = planRepair(
      head('w', [node('a', 't'), node('b', 't')]),
      [rev('w', 3, [node('a', 't', { q: 'x' }), node('b', 't', { q: 'y' })])],
    );
    expect(plan?.restoredNodes).toBe(2);
    expect(nodesOf(plan?.definition)[0].inputs).toEqual({ q: 'x' });
    expect(plan?.fields).toEqual(['inputs']);
    expect(plan?.fromRevision).toBe('h3');
  });

  it('restores `variables` too, so restored refs still resolve', () => {
    // RFC 0124: an input may be `{type:'variable',variableName}`. Restoring the
    // values but not the declarations yields refs pointing at nothing.
    const plan = planRepair(
      head('w', [node('a', 't')]),
      [rev('w', 1, [node('a', 't', { q: { type: 'variable', variableName: 'topic' } })], { variables: [{ name: 'topic' }] })],
    );
    expect(plan?.fields).toContain('variables');
    expect(plan?.definition.variables).toEqual([{ name: 'topic' }]);
  });

  it('does NOT overwrite variables the head already declares', () => {
    const plan = planRepair(
      head('w', [node('a', 't')], { variables: [{ name: 'current' }] }),
      [rev('w', 1, [node('a', 't', { q: 'x' })], { variables: [{ name: 'stale' }] })],
    );
    expect(plan?.fields).not.toContain('variables');
    expect(plan?.definition.variables).toEqual([{ name: 'current' }]);
  });

  it('IDEMPOTENT: re-planning the repaired output is a no-op', () => {
    // By construction, not by a marker — after repair the head carries inputs,
    // so the precondition fails. This is the property that makes it safe to run
    // twice, which any operator eventually will.
    const revisions = [rev('w', 1, [node('a', 't', { q: 'x' })])];
    const first = planRepair(head('w', [node('a', 't')]), revisions);
    if (!first) throw new Error('the first pass planned nothing — the fixture is wrong');
    const second = planRepair({ workflowId: 'w', definition: first.definition }, revisions);
    expect(second, 'a second pass planned another write').toBeNull();
  });

  it('gives each node ITS OWN values — the cross-node contamination regression', () => {
    // THE DEFECT THIS PINS. The planner keyed on `n.id`, which no
    // WorkflowDefinition node has (`executor/types.ts:403` says `nodeId`).
    // `new Map(nodes.map(n => [undefined, n]))` collapses to ONE entry, so
    // `get(undefined)` returned the LAST source node for EVERY node — the repair
    // wrote one node's inputs onto all of them. On a mail node that is another
    // node's recipient address.
    //
    // Every other test used a single input-carrying node or asserted only a
    // COUNT, so none of them could see it. This one asserts the VALUES land on
    // the right nodes, which is the only assertion that distinguishes a correct
    // key from a broken one.
    const plan = planRepair(
      head('w', [node('a', 't'), node('b', 't')]),
      [rev('w', 1, [node('a', 't', { q: 'A-VALUE' }), node('b', 't', { q: 'B-VALUE' })])],
    );
    const byId = new Map(nodesOf(plan?.definition).map((n) => [n.nodeId, n.inputs]));
    expect(byId.get('a'), "node 'a' inherited another node's inputs").toEqual({ q: 'A-VALUE' });
    expect(byId.get('b')).toEqual({ q: 'B-VALUE' });
  });

  it('REFUSES when no source node exposes a nodeId, rather than repairing against nothing', () => {
    // The structural guard: if the identity field is ever renamed again, this
    // fails loudly instead of silently restoring the wrong values everywhere.
    const bad = { workflowId: 'w', seq: 1, definition: { nodes: [{ typeId: 't', inputs: { q: 'x' } }] } };
    expect(() => planRepair(
      head('w', [node('a', 't')]),
      [bad as unknown as RepairRevision],
    )).toThrow(/nodeId/);
  });

  it('leaves node ids untouched — the replay-safety property', () => {
    // Checkpoints are overlaid BY NODE ID. If a repair renamed ids, in-flight
    // runs would stop matching their own checkpoints.
    const before = head('w', [node('a', 't'), node('b', 't')]);
    const plan = planRepair(before, [rev('w', 1, [node('a', 't', { q: 'x' }), node('b', 't', { q: 'y' })])]);
    expect(nodesOf(plan?.definition).map((n) => n.nodeId)).toEqual(['a', 'b']);
  });
});

describe('planAll', () => {
  it('scopes revisions to their own workflow', () => {
    // A cross-workflow leak here would write one tenant's authored values into
    // another workflow entirely.
    const plans = planAll(
      [head('w1', [node('a', 't')]), head('w2', [node('a', 't')])],
      [rev('w1', 1, [node('a', 't', { q: 'w1-only' })])],
    );
    expect(plans).toHaveLength(1);
    expect(plans[0].workflowId).toBe('w1');
  });

  it('plans nothing for an empty population', () => {
    expect(planAll([], [])).toEqual([]);
  });
});

describe('formatPlan', () => {
  it('REFUSES on zero heads rather than reporting "nothing to repair"', () => {
    // Same anti-vacuity rule as the measurement tool: a wrong DSN must not read
    // as a healthy database.
    const text = formatPlan([], 0, false);
    expect(text).toContain('REFUSING TO ACT');
    expect(text).not.toContain('WOULD REPAIR');
  });

  it('says plainly that a dry run wrote nothing', () => {
    const text = formatPlan([{ workflowId: 'w', restoredNodes: 1, fields: ['inputs'], fromRevision: 'h1' }], 5, false);
    expect(text).toContain('WOULD REPAIR 1 of 5');
    expect(text).toContain('DRY RUN');
  });

  it('WARNS when a repair targets a GLOBAL wf.seed.* row', () => {
    // `wf.seed.*` is one definition every tenant runs. DATA-D / PROBE-CP1 record
    // that such a row can hold a recipient address frozen into a node input, so
    // an operator should know before typing --apply that they are touching
    // shared rows rather than tenant-owned copies.
    const text = formatPlan(
      [{ workflowId: 'wf.seed.research', restoredNodes: 1, fields: ['inputs'], fromRevision: 'h1' }],
      5,
      false,
    );
    expect(text).toContain('GLOBAL');
    expect(text).toContain('PROBE-CP1');
  });

  it('does NOT warn about global rows when none are involved', () => {
    // A permanent warning is noise and gets skipped; it has to mean something.
    const text = formatPlan(
      [{ workflowId: 'user:alice.my-flow', restoredNodes: 1, fields: ['inputs'], fromRevision: 'h1' }],
      5,
      false,
    );
    expect(text).not.toContain('GLOBAL');
  });

  it('does not claim DRY RUN once it has actually written', () => {
    const text = formatPlan([{ workflowId: 'w', restoredNodes: 1, fields: ['inputs'], fromRevision: 'h1' }], 5, true);
    expect(text).toContain('REPAIRED 1 of 5');
    expect(text, 'a real write reported itself as a dry run').not.toContain('DRY RUN');
  });
});
