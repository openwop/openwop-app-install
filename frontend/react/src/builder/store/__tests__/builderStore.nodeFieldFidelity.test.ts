/**
 * H37 — duplicate and copy/paste must carry EVERY node field.
 *
 * `cloneNodes` and `pasteNodes` (and the clipboard entry `copySelection`
 * builds) used to rebuild a `BuilderNode` field-by-field as
 * `{id, kind, name, position, config, inputs}`. Any field the list did not
 * name was silently dropped: duplicating a terminal node marked with the RFC
 * 0065 `outputRole` advisory (ADR 0440 P1) produced a copy WITHOUT it, and
 * copy→paste did the same — the exact defect class ADR 0523/0524 fixed for
 * `inputs` on the import/export lane, one lane over.
 *
 * `backend/typescript/test/node-field-contract-parity.test.ts` cannot see this:
 * it reads the source text of the three DECLARED contracts (producer / ingest /
 * round-trip) and says so in its own docblock — field-by-field reconstructions
 * inside function bodies are invisible to it. Hence a BEHAVIOURAL test.
 *
 * The load-bearing case is the last one: it asserts over EVERY own enumerable
 * field of the source rather than a named list, so it guards fields that do not
 * exist yet (`compensation` / `irreversibleEffect` per RFC 0157/0151, and
 * whatever comes after) without anybody remembering to come back here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useBuilderStore } from '../builderStore.js';
import { copySelection, pasteClipboard, clearClipboardForTest } from '../../nodeClipboard.js';
import { serializeWorkflow } from '../../schema/serialize.js';
import type { BuilderNode, SavedWorkflow } from '../../schema/workflow.js';

const emptyWf: SavedWorkflow = {
  id: 'wf-h37', name: 'H37', version: '1.0.0', nodes: [], edges: [], createdAt: 'now', updatedAt: 'now',
};
const s = () => useBuilderStore.getState();

/** The two fields a copy MUST mint fresh; everything else has to survive. */
const MINTED_FIELDS = new Set(['id', 'position']);

/** Install one node verbatim (bypassing `addNode`, which builds from the
 *  catalog) so a test can pin fields the store has no editor for. */
function seedNode(node: BuilderNode): void {
  useBuilderStore.setState({ nodes: [node], selectedNodeId: node.id, selectedNodeIds: [node.id] });
}

function otherThan(ids: string[]): BuilderNode {
  const copies = s().nodes.filter((n) => !ids.includes(n.id));
  expect(copies).toHaveLength(1);
  return copies[0]!;
}

beforeEach(() => {
  s().loadFromSaved(emptyWf);
  clearClipboardForTest();
});

describe('H37 — duplicate carries every node field', () => {
  it('duplicating a node marked outputRole:primary keeps the advisory', () => {
    const id = s().addNode('noop', { x: 10, y: 20 });
    s().updateNode(id, { outputRole: 'primary' });
    s().cloneNodes([id]);

    const copy = otherThan([id]);
    expect(copy.outputRole).toBe('primary');
    // …and the copy is a real copy, not the source re-selected.
    expect(copy.id).not.toBe(id);
    expect(copy.position).toEqual({ x: 42, y: 52 });
  });

  it('duplicating a node WITHOUT outputRole does not invent one', () => {
    const id = s().addNode('noop', { x: 0, y: 0 });
    expect('outputRole' in s().nodes[0]!).toBe(false);
    s().cloneNodes([id]);

    const copy = otherThan([id]);
    expect(copy.outputRole).toBeUndefined();
    expect('outputRole' in copy).toBe(false);
    // Belt and braces: even if a key with an undefined value ever appeared,
    // it must not reach the wire as a null. (`serialize` emits the field only
    // when `!== undefined`, so absent and undefined are equivalent there —
    // this pins that equivalence rather than trusting it.)
    const wire = serializeWorkflow({ ...emptyWf, nodes: [copy], edges: [] });
    // `in` on the real `BackendNode` — no widening cast. A cast to
    // `Record<string, unknown>` would be the wrong instrument twice over: it
    // is a TS2352 (the types don't overlap) and it would let this assertion
    // survive `outputRole` being removed from `BackendNode` altogether.
    expect('outputRole' in wire.nodes[0]!).toBe(false);
  });
});

describe('H37 — copy→paste carries every node field', () => {
  it('round-trips outputRole through the real clipboard codec', () => {
    const id = s().addNode('noop', { x: 10, y: 20 });
    s().updateNode(id, { outputRole: 'secondary', inputs: { query: '{{params.q}}' } });
    s().setSelection([id]);

    expect(copySelection()).toBe(1);
    expect(pasteClipboard()).toBe(1);

    const pasted = otherThan([id]);
    expect(pasted.outputRole).toBe('secondary');
    expect(pasted.inputs).toEqual({ query: '{{params.q}}' });
    // Distinct containers — the paste must not alias the source's objects.
    expect(pasted.inputs).not.toBe(s().nodes.find((n) => n.id === id)!.inputs);
  });

  it('pasting a node WITHOUT outputRole does not invent one', () => {
    const id = s().addNode('noop', { x: 0, y: 0 });
    s().setSelection([id]);
    copySelection();
    pasteClipboard();

    const pasted = otherThan([id]);
    expect('outputRole' in pasted).toBe(false);
  });

  it('a clipboard entry captured by an OLDER build (narrow shape) still pastes', () => {
    // Pre-H37 entries carried only kind/name/config[/inputs] + dx/dy. Feed
    // exactly that shape to `pasteNodes` — a widened entry type must not make
    // the narrow one unpastable.
    s().pasteNodes(
      [{ kind: 'noop', name: 'Legacy', config: { a: 1 }, dx: 0, dy: 0 }],
      { x: 5, y: 6 },
    );
    expect(s().nodes).toHaveLength(1);
    expect(s().nodes[0]).toMatchObject({ kind: 'noop', name: 'Legacy', config: { a: 1 }, position: { x: 5, y: 6 } });
    expect('outputRole' in s().nodes[0]!).toBe(false);
  });
});

describe('H37 — the generic guard: no field is dropped, named or not', () => {
  /** A node carrying every field `BuilderNode` declares today PLUS a field it
   *  does not — standing in for the next one somebody adds (RFC 0157
   *  `compensation`, RFC 0151 `irreversibleEffect`, …). Both lanes must carry
   *  it without this test ever learning its name. */
  const rich = {
    id: 'n_source',
    kind: 'noop',
    name: 'Rich node',
    position: { x: 100, y: 200 },
    config: { retries: 3, nested: { deep: true } },
    inputs: { to: '{{params.recipient}}' },
    outputRole: 'primary',
    futureFieldNobodyHasWrittenYet: { compensation: 'core.undo', irreversibleEffect: true },
  } as unknown as BuilderNode;

  function assertCarried(copy: BuilderNode): void {
    const source = rich as unknown as Record<string, unknown>;
    const carried = copy as unknown as Record<string, unknown>;
    const expectedKeys = Object.keys(source).filter((k) => !MINTED_FIELDS.has(k)).sort();
    // Every surviving key, and NO extra invented ones.
    expect(Object.keys(carried).filter((k) => !MINTED_FIELDS.has(k)).sort()).toEqual(expectedKeys);
    for (const k of expectedKeys) expect(carried[k]).toEqual(source[k]);
    expect(copy.id).not.toBe(rich.id);
  }

  it('cloneNodes carries every own enumerable field except id/position', () => {
    seedNode(rich);
    s().cloneNodes([rich.id]);
    assertCarried(otherThan([rich.id]));
  });

  it('copy→paste carries every own enumerable field except id/position', () => {
    seedNode(rich);
    s().setSelection([rich.id]);
    expect(copySelection()).toBe(1);
    expect(pasteClipboard()).toBe(1);
    assertCarried(otherThan([rich.id]));
  });

  it('mutating a clone\'s containers does not reach back into the source', () => {
    seedNode(rich);
    s().cloneNodes([rich.id]);
    const copy = otherThan([rich.id]);
    (copy.config as Record<string, unknown>).retries = 99;
    (copy.inputs as Record<string, unknown>).to = 'clobbered';
    const source = s().nodes.find((n) => n.id === rich.id)!;
    expect(source.config).toEqual({ retries: 3, nested: { deep: true } });
    expect(source.inputs).toEqual({ to: '{{params.recipient}}' });
  });
});
