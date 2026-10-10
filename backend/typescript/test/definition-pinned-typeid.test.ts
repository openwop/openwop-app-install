/**
 * grade-data D-6 — a directly submitted definition may carry exact node pins
 * (`typeId@x.y.z`, the v2 ids grammar / RFC 0177 §E.1). The validator is the one
 * choke: it normalizes to the bare id the registry and executor key on, keeps the
 * pin in `metadata.nodePins`, and refuses a range or a conflicting pin.
 */
import { describe, expect, it } from 'vitest';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';

const def = (typeIds: string[]) => ({
  workflowId: 'wf.pinned',
  nodes: typeIds.map((typeId, i) => ({ nodeId: `n${i}`, typeId })),
  edges: typeIds.slice(1).map((_, i) => ({ id: `e${i}`, sourceNodeId: `n${i}`, targetNodeId: `n${i + 1}` })),
});

describe('validateWorkflowDefinition — pinned typeIds (grade-data D-6)', () => {
  it('normalizes an exact pin to the bare id and records it', () => {
    const out = validateWorkflowDefinition(def(['core.flow.noop@1.0.0', 'core.flow.noop@1.0.0']));
    expect(out.nodes.map((n) => n.typeId)).toEqual(['core.flow.noop', 'core.flow.noop']);
    expect(out.metadata?.nodePins).toEqual({ 'core.flow.noop': '1.0.0' });
  });

  it('leaves an unpinned definition without nodePins', () => {
    const out = validateWorkflowDefinition(def(['core.flow.noop']));
    expect(out.metadata?.nodePins).toBeUndefined();
  });

  it('refuses a ranged pin', () => {
    expect(() => validateWorkflowDefinition(def(['core.flow.noop@^1.0.0']))).toThrow(/MUST be exact/);
  });

  it('refuses two versions of one type', () => {
    expect(() => validateWorkflowDefinition(def(['core.flow.noop@1.0.0', 'core.flow.noop@1.1.0']))).toThrow(/cannot run two versions/);
  });
});
