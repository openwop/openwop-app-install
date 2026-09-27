/**
 * ADR 0440 P1 — builder round-trip fidelity.
 *
 * A builder "open" is not read-only: the autosave is a 1.5s debounce on any
 * store edit (builderStore), so merely renaming a workflow rewrites the stored
 * definition. Before this ADR that write silently:
 *
 *   - renamed every node (`t1…t5` → `ui_walkthrough_step_0…`), orphaning the
 *     run events that reference those ids — runs re-resolve their definition by
 *     id with NO per-run snapshot (ADR 0369), and the walkthrough funnel keys
 *     `stalledByNode` off them;
 *   - dropped `metadata.walkthrough`, which is exactly what
 *     `features/walkthroughs/surface.ts` gates `isWalkthrough()` on — so the
 *     walkthrough vanished from `ctx.features.walkthroughs.listWalkthroughs`
 *     while `/walkthroughs` still listed it (that page filters on the
 *     workflowId prefix), making the damage invisible where a user would look;
 *   - dropped the RFC 0065 `outputRole` advisory on import.
 *
 * The invariant asserted here is the FIXED POINT over a definition **as the
 * host stores it** (post-`validateWorkflowDefinition`), not `deserialize(
 * serialize(x)) === x` over an arbitrary definition — the host validator drops
 * fields on POST and `serialize` omits the display name by design, so the
 * literal identity can never hold and asserting it would force the test to be
 * weakened later.
 */
import { describe, it, expect } from 'vitest';
import { serializeWorkflow } from '../serialize.js';
import { fromCanonicalDefinition } from '../deserialize.js';
import type { SavedWorkflow } from '../workflow.js';

/** A definition in the shape the host actually persists (the 5-field node
 *  whitelist `validateWorkflowDefinition` emits: nodeId, typeId, config, inputs,
 *  outputRole). Typed structurally so the malformed-import fixtures below need no
 *  casts.
 *
 *  §Correction 2026-08-03 — this interface said "5-field" in prose while listing
 *  FOUR, and the missing one was `inputs`. Because no fixture ever carried it,
 *  the fixed-point assertion below could not observe that the round-trip DELETES
 *  it: the test encoded the bug it was meant to catch. 114 of 169 shipped chains
 *  author node `inputs` (187 nodes) — including every email recipient and every
 *  notify headline. */
interface StoredDefinition {
  workflowId: string;
  metadata: Record<string, unknown>;
  nodes: Array<{ nodeId: string; typeId: string; config?: Record<string, unknown>; outputRole?: 'primary' | 'secondary'; inputs?: Record<string, unknown>; compensation?: Record<string, unknown>; irreversibleEffect?: boolean }>;
  edges: Array<{ edgeId: string; sourceNodeId: string; targetNodeId: string }>;
}

const STORED_WALKTHROUGH: StoredDefinition = {
  workflowId: 'walkthrough.campaign-studio.first-brief',
  metadata: { name: 'Campaign Studio: your first brief', walkthrough: true },
  nodes: [
    { nodeId: 't1', typeId: 'core.noop', config: { actionId: 'a.one', narration: 'n1' }, inputs: { subject: 'a pinned input the round-trip must not eat' } },
    { nodeId: 't2', typeId: 'core.noop', config: { actionId: 'a.two', hitl: true } },
    { nodeId: 't3', typeId: 'core.noop', config: { expect: 'a.done' }, outputRole: 'primary' as const },
    // RFC 0151 §B / RFC 0157 — a compensated node and an irreversible one. Same
    // class as `inputs` above: the builder has no editor for either, and a field
    // it cannot edit is exactly the field a round trip quietly eats.
    {
      nodeId: 't4',
      typeId: 'core.noop',
      compensation: { nodeTypeId: 'core.payment.refund', requiresApproval: true, waiveRequiresApproval: false, retry: { maxAttempts: 3 } },
    },
    { nodeId: 't5', typeId: 'core.noop', irreversibleEffect: true },
  ],
  edges: [
    { edgeId: 'e1', sourceNodeId: 't1', targetNodeId: 't2' },
    { edgeId: 'e2', sourceNodeId: 't2', targetNodeId: 't3' },
  ],
};

/** Rebuild the SavedWorkflow the builder holds after opening `def`, mirroring
 *  `backendStore.loadWorkflow`'s two-tier metadata split. */
function open(def: StoredDefinition): SavedWorkflow {
  const d = fromCanonicalDefinition(def);
  const { name: _name, lifecycle: _lifecycle, ...carried } = def.metadata;
  return {
    id: def.workflowId,
    name: typeof def.metadata.name === 'string' ? def.metadata.name : def.workflowId,
    version: '1.0.0',
    nodes: d.nodes,
    edges: d.edges,
    createdAt: 'now',
    updatedAt: 'now',
    metadata: carried,
  };
}

/** Mirror of `backendStore.mergeDefinitionMetadata` — the single seam where the
 *  builder-owned keys overlay the carried ones. */
function save(wf: SavedWorkflow): Record<string, unknown> {
  // Spread into a fresh literal rather than `as Record<string, unknown>`:
  // TS2352 rejects that conversion, and the compiler's own suggestion
  // (`as unknown as`) is a banned pattern in this repo. The spread is
  // cast-free and structurally identical.
  const def: Record<string, unknown> = { ...serializeWorkflow(wf) };
  return {
    ...def,
    metadata: {
      ...(wf.metadata ?? {}),
      ...((def.metadata as Record<string, unknown> | undefined) ?? {}),
      name: wf.name,
      ...(wf.lifecycle ? { lifecycle: wf.lifecycle } : {}),
    },
  };
}

describe('ADR 0440 P1 — open→save is a fixed point for what the host stores', () => {
  it('preserves every node id (the run-history reference)', () => {
    const out = save(open(STORED_WALKTHROUGH));
    const ids = (out.nodes as Array<{ nodeId: string }>).map((n) => n.nodeId);
    expect(ids).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('preserves edge endpoints against the preserved ids', () => {
    const out = save(open(STORED_WALKTHROUGH));
    const edges = out.edges as Array<{ sourceNodeId: string; targetNodeId: string }>;
    expect(edges.map((e) => [e.sourceNodeId, e.targetNodeId])).toEqual([['t1', 't2'], ['t2', 't3']]);
  });

  it('preserves metadata keys the builder does not model', () => {
    const out = save(open(STORED_WALKTHROUGH));
    // THE regression: an autosave used to erase this, un-registering the
    // walkthrough from the ctx surface while the page still listed it.
    expect((out.metadata as Record<string, unknown>).walkthrough).toBe(true);
  });

  it('preserves node config verbatim', () => {
    const out = save(open(STORED_WALKTHROUGH));
    const nodes = out.nodes as Array<{ config?: Record<string, unknown> }>;
    expect(nodes[0]!.config).toEqual({ actionId: 'a.one', narration: 'n1' });
    expect(nodes[1]!.config).toEqual({ actionId: 'a.two', hitl: true });
  });

  it('preserves node inputs verbatim', () => {
    // The assertion the file was missing. Note WHY the neighbouring fixed-point
    // test cannot stand in for it: that test compares a SECOND round-trip to the
    // first, and the loss happens on the FIRST. Stripping is idempotent, so the
    // pipeline is a perfectly stable fixed point AT THE LOSSY VALUE. An
    // idempotence check can never detect a loss that occurs before its baseline.
    const out = save(open(STORED_WALKTHROUGH));
    const nodes = out.nodes as Array<{ inputs?: Record<string, unknown> }>;
    expect(nodes[0]!.inputs).toEqual({ subject: 'a pinned input the round-trip must not eat' });
  });

  it('preserves the RFC 0065 outputRole advisory across import+export', () => {
    const out = save(open(STORED_WALKTHROUGH));
    const nodes = out.nodes as Array<{ outputRole?: string }>;
    expect(nodes[2]!.outputRole).toBe('primary');
  });

  it('preserves the RFC 0151 §B compensation declaration verbatim (RFC 0157)', () => {
    // The same defect as `inputs`, and the worst-consequence instance of it: a
    // chain-instantiated workflow carries its compensator through expansion and
    // registration, then the FIRST builder autosave — which a rename alone
    // triggers — deletes it. Nothing fails at that moment. The loss only shows up
    // later, when something goes wrong and the unwind reports a clean `none` for
    // a run that committed real effects.
    const out = save(open(STORED_WALKTHROUGH));
    const nodes = out.nodes as Array<{ compensation?: Record<string, unknown> }>;
    // RFC 0151 §B (S36) — `waiveRequiresApproval: false` is in the fixture on
    // purpose. The builder holds `compensation` as an OPAQUE blob, so it should
    // ride through untouched; asserting the whole object with `toEqual` is what
    // PROVES that rather than assuming it. An explicit `false` is the value a
    // partial/allowlisting serializer would most easily lose.
    expect(nodes[3]!.compensation).toEqual({
      nodeTypeId: 'core.payment.refund',
      requiresApproval: true,
      waiveRequiresApproval: false,
      retry: { maxAttempts: 3 },
    });
  });

  it('preserves the RFC 0151 §B UQ4 irreversibleEffect statement', () => {
    const out = save(open(STORED_WALKTHROUGH));
    const nodes = out.nodes as Array<{ irreversibleEffect?: boolean }>;
    expect(nodes[4]!.irreversibleEffect).toBe(true);
  });

  it('does not INVENT either field on a node that declared neither', () => {
    // The mirror-image failure: materializing `compensation: {}` or
    // `irreversibleEffect: false` would make the host reject the save (the §B
    // block is closed and requires `nodeTypeId`), and would state an
    // author-intent nobody expressed.
    const out = save(open(STORED_WALKTHROUGH));
    const nodes = out.nodes as Array<{ compensation?: unknown; irreversibleEffect?: unknown }>;
    expect(nodes[0]!.compensation).toBeUndefined();
    expect(nodes[0]!.irreversibleEffect).toBeUndefined();
  });

  it('is STABLE — a second open→save changes nothing (true fixed point)', () => {
    const once = save(open(STORED_WALKTHROUGH));
    const reloaded: StoredDefinition = {
      workflowId: STORED_WALKTHROUGH.workflowId,
      metadata: once.metadata as Record<string, unknown>,
      nodes: once.nodes as StoredDefinition['nodes'],
      edges: once.edges as StoredDefinition['edges'],
    };
    const twice = save(open(reloaded));
    expect(twice.nodes).toEqual(once.nodes);
    expect(twice.edges).toEqual(once.edges);
    expect((twice.metadata as Record<string, unknown>).walkthrough).toBe(true);
  });

  it('a RENAME still wins — builder-owned keys overlay the carried copy', () => {
    const opened = open(STORED_WALKTHROUGH);
    const out = save({ ...opened, name: 'Renamed by the user' });
    expect((out.metadata as Record<string, unknown>).name).toBe('Renamed by the user');
    expect((out.metadata as Record<string, unknown>).walkthrough).toBe(true); // still carried
  });

  it('a lifecycle draft flag still round-trips (the ADR 0369 case this generalizes)', () => {
    const opened = open(STORED_WALKTHROUGH);
    const out = save({ ...opened, lifecycle: { transient: true, generatedBy: 'workflow-builder' } });
    expect((out.metadata as Record<string, unknown>).lifecycle).toEqual({ transient: true, generatedBy: 'workflow-builder' });
  });
});

describe('ADR 0440 P1 — id fallback still guarantees wire validity', () => {
  const WIRE_NODE_ID = /^[a-zA-Z0-9_-]+$/;

  it('sanitizes a file-imported id that cannot go on the wire', () => {
    const def = {
      ...STORED_WALKTHROUGH,
      nodes: [{ nodeId: 'has spaces/and.dots', typeId: 'core.noop', config: {} }],
      edges: [],
    };
    const out = save(open(def));
    const id = (out.nodes as Array<{ nodeId: string }>)[0]!.nodeId;
    expect(id).toMatch(WIRE_NODE_ID);
    expect(id).not.toBe('has spaces/and.dots');
  });

  it('de-duplicates when a generated id would collide with a preserved one', () => {
    // The real collision: node A's PRESERVED id is exactly what the fallback
    // would generate for node B (kind `core.noop` at index 1 → `core_noop_1`).
    const def = {
      ...STORED_WALKTHROUGH,
      nodes: [
        { nodeId: 'core_noop_1', typeId: 'core.noop', config: {} },
        { nodeId: 'bad id!', typeId: 'core.noop', config: {} },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 'core_noop_1', targetNodeId: 'bad id!' }],
    };
    const out = save(open(def));
    const ids = (out.nodes as Array<{ nodeId: string }>).map((n) => n.nodeId);
    expect(ids[0]).toBe('core_noop_1');          // preserved
    expect(new Set(ids).size).toBe(ids.length);  // and the fallback stepped aside
    for (const id of ids) expect(id).toMatch(WIRE_NODE_ID);
  });
});

/**
 * NOTIF-UX-3 — the run-time input BINDINGS.
 *
 * `inputs` is REQUIRED on `WorkflowNode` in
 * `schemas/workflow-definition.schema.json`, and it is where the `{{params.*}}`
 * bindings live that `tokenSubstitution` resolves at run time. `BuilderNode` had
 * no field for it, so import dropped it and export could not emit what it never
 * held — opening a parameterised workflow and saving it stripped every binding.
 *
 * This suite is where that should have been caught, and its absence is why the
 * defect survived: the ADR 0440 fixture above carries no bindings, so every
 * assertion in it passed while the field was being destroyed. A fixture that
 * lacks the field cannot fail on the field.
 *
 * Why it is worse than a dropped hint (which is what `outputRole` was): per
 * ADR 0507 an absent/embedded param does NOT fail loudly. It freezes to `''`,
 * the node SUCCEEDS on empty input, and the run looks plausible — an extractor
 * asked to read an invoice that is not there obliges.
 */
const STORED_PARAMETERISED: StoredDefinition = {
  workflowId: 'wf.seed.commerce-order-lookup',
  metadata: { name: 'Order lookup' },
  nodes: [
    // Shapes copied from real chain packs (examples/workflow-chain-packs/*).
    { nodeId: 'trigger', typeId: 'core.noop', inputs: {} },
    { nodeId: 'order', typeId: 'core.noop', inputs: { orgId: '{{params.orgId}}', orderId: '{{params.orderId}}' } },
    { nodeId: 'search', typeId: 'core.noop', inputs: { query: '{{params.query}}' }, config: { k: 5 } },
    { nodeId: 'notify', typeId: 'core.noop', inputs: { title: 'Cited Web Brief' } },
  ],
  edges: [
    { edgeId: 'e1', sourceNodeId: 'trigger', targetNodeId: 'order' },
    { edgeId: 'e2', sourceNodeId: 'order', targetNodeId: 'search' },
    { edgeId: 'e3', sourceNodeId: 'search', targetNodeId: 'notify' },
  ],
};

describe('NOTIF-UX-3 — open→save preserves run-time input bindings', () => {
  const byId = (out: Record<string, unknown>): Record<string, Record<string, unknown> | undefined> =>
    Object.fromEntries(
      (out.nodes as Array<{ nodeId: string; inputs?: Record<string, unknown> }>).map((n) => [n.nodeId, n.inputs]),
    );

  it('carries every {{params.*}} binding through a round trip', () => {
    const out = byId(save(open(STORED_PARAMETERISED)));
    expect(out.order, 'the order node lost its parameter bindings').toEqual({
      orgId: '{{params.orgId}}',
      orderId: '{{params.orderId}}',
    });
    expect(out.search).toEqual({ query: '{{params.query}}' });
  });

  it('preserves a LITERAL binding too, not just token-shaped ones', () => {
    // A naive fix that only forwarded strings containing `{{` would pass the
    // test above and still destroy this.
    expect(byId(save(open(STORED_PARAMETERISED))).notify).toEqual({ title: 'Cited Web Brief' });
  });

  it('does not invent bindings for a node that has none', () => {
    // `inputs: {}` is emitted as absent, matching how a builder-authored node
    // (which has no bindings) already serialises — the round trip must not add
    // a field the host did not store.
    const out = byId(save(open(STORED_PARAMETERISED)));
    expect(out.trigger).toBeUndefined();
  });

  it('survives a SECOND round trip — the "open it twice" case users hit', () => {
    // The reported symptom was "opening and saving a repaired workflow re-breaks
    // it", i.e. the damage shows on the next cycle, not the first.
    const once = save(open(STORED_PARAMETERISED)) as unknown as StoredDefinition;
    const twice = byId(save(open(once)));
    expect(twice.order).toEqual({ orgId: '{{params.orgId}}', orderId: '{{params.orderId}}' });
  });
});

/**
 * ADR 0524 Phase E (`PHE-3`) — an EDIT to a preset input survives the round trip.
 *
 * WHY THIS GAP MATTERED. Phase E's own tests assert the Inspector writes the
 * right thing into the STORE. They stop there. Every defect this whole program
 * chased lived one layer further out — at the serialize/deserialize seam, where
 * eight separate field allowlists each had the power to silently drop `inputs`,
 * and where the ADR 0440 fixture above *encoded the bug it was meant to catch*
 * by never carrying an `inputs` field at all.
 *
 * So a test that proves "the user's edit reached the store" proves nothing about
 * whether it reaches the server. These do.
 *
 * The load-bearing case is the CLEAR. Every other assertion here would still
 * pass under an implementation that resurrects deleted values — resurrection
 * only shows up when the expected value is *absence*.
 */
describe('ADR 0524 Phase E — an edited preset input survives serialize→deserialize', () => {
  const inputsById = (out: Record<string, unknown>): Record<string, Record<string, unknown> | undefined> =>
    Object.fromEntries(
      (out.nodes as Array<{ nodeId: string; inputs?: Record<string, unknown> }>).map((n) => [n.nodeId, n.inputs]),
    );

  /** The stored shape after a user EDITS `t1`'s preset input in the Inspector. */
  const EDITED: StoredDefinition = {
    ...STORED_WALKTHROUGH,
    nodes: STORED_WALKTHROUGH.nodes.map((n) =>
      n.nodeId === 't1' ? { ...n, inputs: { subject: 'edited by a human' } } : n,
    ),
  };

  it('fixture guard: the unedited fixture still carries an input to lose', () => {
    // The ADR 0440 §Correction above exists because this fixture ONCE carried no
    // `inputs` at all, which made the fixed-point assertion unable to observe a
    // deletion. If that ever regresses, every assertion below is vacuous.
    expect(inputsById(save(open(STORED_WALKTHROUGH))).t1).toBeTruthy();
  });

  it('an edited value reaches the persisted definition verbatim', () => {
    expect(inputsById(save(open(EDITED))).t1).toEqual({ subject: 'edited by a human' });
  });

  it('THE LOAD-BEARING ONE: a CLEARED input stays cleared through the round trip', () => {
    // The payoff of ADR 0523/0524/E0/E. A user clears the last preset input;
    // the serializer must emit its absence, and the deserializer must not
    // reinstate it. Resurrection is invisible to every assertion that expects a
    // VALUE — it only shows against an expected absence.
    const cleared: StoredDefinition = {
      ...STORED_WALKTHROUGH,
      nodes: STORED_WALKTHROUGH.nodes.map((n) => {
        if (n.nodeId !== 't1') return n;
        const { inputs: _dropped, ...rest } = n;
        return rest;
      }),
    };
    const out = inputsById(save(open(cleared)));
    const t1 = out.t1;
    expect(
      t1 === undefined || Object.keys(t1).length === 0,
      `a cleared preset input came back as ${JSON.stringify(t1)}`,
    ).toBe(true);
  });

  it('a cleared input stays cleared across TWO cycles', () => {
    // The sibling `{{params.*}}` test above exists because the damage showed on
    // the SECOND cycle, not the first — an open/save pair can look lossless once
    // and still drift. Same shape, same guard.
    const cleared: StoredDefinition = {
      ...STORED_WALKTHROUGH,
      nodes: STORED_WALKTHROUGH.nodes.map((n) => {
        if (n.nodeId !== 't1') return n;
        const { inputs: _dropped, ...rest } = n;
        return rest;
      }),
    };
    const once = save(open(cleared)) as unknown as StoredDefinition;
    const twice = inputsById(save(open(once)));
    const t1 = twice.t1;
    expect(t1 === undefined || Object.keys(t1).length === 0).toBe(true);
  });

  it('clearing ONE input does not disturb another node’s inputs', () => {
    const twoCarriers: StoredDefinition = {
      ...STORED_WALKTHROUGH,
      nodes: STORED_WALKTHROUGH.nodes.map((n) =>
        n.nodeId === 't2' ? { ...n, inputs: { keep: 'me' } } : n,
      ),
    };
    const clearedT1: StoredDefinition = {
      ...twoCarriers,
      nodes: twoCarriers.nodes.map((n) => {
        if (n.nodeId !== 't1') return n;
        const { inputs: _dropped, ...rest } = n;
        return rest;
      }),
    };
    const out = inputsById(save(open(clearedT1)));
    expect(out.t2, 'clearing one node’s input disturbed another').toEqual({ keep: 'me' });
  });

  it('a {type:static} envelope survives the round trip as an envelope', () => {
    // Phase E preserves the envelope on edit; the seam must not flatten it back
    // to a bare string, which the executor reads differently.
    const withEnvelope: StoredDefinition = {
      ...STORED_WALKTHROUGH,
      nodes: STORED_WALKTHROUGH.nodes.map((n) =>
        n.nodeId === 't1' ? { ...n, inputs: { prompt: { type: 'static', value: 'Approve this?' } } } : n,
      ),
    };
    expect(inputsById(save(open(withEnvelope))).t1).toEqual({
      prompt: { type: 'static', value: 'Approve this?' },
    });
  });
});
