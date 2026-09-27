/**
 * H26 — the workflow ingest boundary accepts the CANONICAL edge-id spelling.
 *
 * `spec/v1/host-sample-test-seams.md` §24 (catalogued 2026-08-16, openwop#1028)
 * recorded a divergence rather than a capability: the sample-workflow
 * registration seam — `POST /v1/host/sample/workflows`, which rewrites onto the
 * product route `POST /v1/host/openwop-app/workflows` — accepted edges spelled
 * `{ edgeId, sourceNodeId, targetNodeId }`, while
 * `schemas/workflow-definition.schema.json` §WorkflowEdge declares `id`
 * (REQUIRED, `additionalProperties: false`). A client posting the canonical
 * document it had just validated against was answered `400 validation_error`.
 *
 * The internal `EdgeDef` (`executor/types.ts`) keeps `edgeId` — it is read by
 * the executor, the chain expander, the builder and every stored definition, so
 * renaming it would be a data migration in service of a spelling. The
 * translation therefore lives at the wire boundary, in
 * `validateWorkflowDefinition`, and BOTH spellings are pinned here: the
 * canonical one because it is the contract, the alias because dropping it would
 * break every existing caller.
 */
import { describe, expect, it } from 'vitest';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';
import { OpenwopError } from '../src/types.js';

const defWithEdge = (edge: Record<string, unknown>) => ({
  workflowId: 'test.edge-id-spelling',
  nodes: [
    { nodeId: 'a', typeId: 'core.noop' },
    { nodeId: 'b', typeId: 'core.noop' },
  ],
  edges: [edge],
});

describe('H26 — edge id spelling at the workflow ingest boundary', () => {
  it('accepts the canonical `id` from workflow-definition.schema.json', () => {
    const def = validateWorkflowDefinition(defWithEdge({ id: 'e1', sourceNodeId: 'a', targetNodeId: 'b' }));
    expect(def.edges).toEqual([{ edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b' }]);
  });

  it('still accepts the host alias `edgeId`', () => {
    const def = validateWorkflowDefinition(defWithEdge({ edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b' }));
    expect(def.edges).toEqual([{ edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b' }]);
  });

  it('the canonical `id` wins when a caller sends both', () => {
    // Not a preference so much as a rule with one defensible answer: the schema
    // declares `id`, so a document carrying both is a canonical document that
    // also carries a host extension, never the reverse.
    const def = validateWorkflowDefinition(
      defWithEdge({ id: 'canonical', edgeId: 'alias', sourceNodeId: 'a', targetNodeId: 'b' }),
    );
    expect(def.edges?.[0]?.edgeId).toBe('canonical');
  });

  it('the canonical spelling reaches the condition mapper, not just the id field', () => {
    // `normalizeEdgeCondition` takes the edge id for its error messages; feeding
    // it `e.edgeId` while the caller spelled it `id` would have produced
    // `undefined` in any condition-shape diagnostic. The wire condition shape
    // (`{type,left,right}`) must still normalize to the host `{path,op,value}`.
    const def = validateWorkflowDefinition(
      defWithEdge({
        id: 'e1',
        sourceNodeId: 'a',
        targetNodeId: 'b',
        condition: { type: 'equals', left: 'status', right: 'ok' },
      }),
    );
    expect(def.edges?.[0]?.condition).toEqual({ path: 'status', op: 'eq', value: 'ok' });
  });

  it('duplicate ids are still refused across BOTH spellings', () => {
    // The uniqueness check reads one resolved id, so mixing the spellings must
    // not smuggle a duplicate past it.
    expect(() =>
      validateWorkflowDefinition({
        workflowId: 'test.edge-id-spelling',
        nodes: [
          { nodeId: 'a', typeId: 'core.noop' },
          { nodeId: 'b', typeId: 'core.noop' },
        ],
        edges: [
          { id: 'dup', sourceNodeId: 'a', targetNodeId: 'b' },
          { edgeId: 'dup', sourceNodeId: 'b', targetNodeId: 'a' },
        ],
      }),
    ).toThrow(OpenwopError);
  });

  it('an edge with NEITHER spelling is still a validation error', () => {
    expect(() => validateWorkflowDefinition(defWithEdge({ sourceNodeId: 'a', targetNodeId: 'b' }))).toThrow(
      /edges\[0\]\.id/,
    );
  });
});
