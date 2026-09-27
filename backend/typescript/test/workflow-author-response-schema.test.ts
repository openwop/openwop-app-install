/**
 * ADR 0673 D3 (`WFAWF-15`) — the schema the MODEL is handed and the validator that gates the
 * write must agree.
 *
 * Born red: `RESPONSE_SCHEMA` required `edgeId`, which is only a legacy host ALIAS — the
 * canonical field is `id` (`workflowDefinitionValidation.ts:526`: *"`id` WINS when both are
 * present — the canonical field is the one the schema declares"*). So every workflow the
 * model has ever authored was taught the wrong field name, and the schema was pinned to
 * nothing.
 *
 * **Why this is a BEHAVIOURAL round-trip and not schema-vs-schema.** Two generation sources
 * were proposed for the prompt schema and both are wrong:
 *   - the validator reads no schema at runtime (imperative code — nothing to generate from);
 *   - `schemas/workflow-definition.schema.json` is the WIRE shape, requiring `id` plus
 *     `name`/`version`/`triggers`/`variables`/`metadata`/`settings` — a definition generated
 *     from it is REJECTED by the host at `workflowDefinitionValidation.ts:401`, which requires
 *     `workflowId`.
 * So the guard pins the thing that actually gates the write: a definition that satisfies the
 * prompt schema must PASS the validator.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACK_SRC = readFileSync(join(REPO, 'packs', 'feature.workflow-author.nodes', 'index.mjs'), 'utf8');

/** The shape the prompt schema declares REQUIRED for an edge. */
const requiredEdgeFields = (): string[] => {
  const m = /required: \['(id|edgeId)', 'sourceNodeId', 'targetNodeId'\]/.exec(PACK_SRC);
  expect(m, 'the edge `required` block must be findable — otherwise this test pins nothing').toBeTruthy();
  return [m![1], 'sourceNodeId', 'targetNodeId'];
};

describe('ADR 0673 D3 — the model is taught the field the validator actually reads', () => {
  it('leg 1: the prompt schema requires the CANONICAL edge id, not the legacy alias', () => {
    expect(requiredEdgeFields()[0],
      '`edgeId` is an alias kept for existing callers; teaching it to the model is teaching the wrong name',
    ).toBe('id');
    expect(PACK_SRC, 'and the alias must not linger as the declared property either').not.toMatch(/\n {10}edgeId: \{/);
  });

  it('leg 2 (the round-trip): a definition shaped by the prompt schema PASSES the validator', () => {
    // Exactly the fields RESPONSE_SCHEMA declares required, nothing more.
    const authored = {
      workflowId: 'authored.roundtrip',
      nodes: [
        { nodeId: 'a', typeId: 'core.flow.noop' },
        { nodeId: 'b', typeId: 'core.flow.noop' },
      ],
      edges: [{ id: 'e1', sourceNodeId: 'a', targetNodeId: 'b' }],
    };
    expect(() => validateWorkflowDefinition(authored), 'the write gate must accept what the model is told to produce').not.toThrow();
  });

  it('leg 3: the WIRE schema is a DIFFERENT shape — generating from it would be rejected', () => {
    // Recorded as a test so the next reader does not re-propose it (I proposed it twice).
    const wire = JSON.parse(readFileSync(join(REPO, 'schemas', 'workflow-definition.schema.json'), 'utf8')) as {
      required?: string[];
    };
    expect(wire.required, 'the wire shape keys on `id`').toContain('id');
    expect(wire.required, 'while the host requires `workflowId`').not.toContain('workflowId');
    // ...and a definition built to the wire's required set fails the host validator.
    const wireShaped = {
      id: 'authored.wire', name: 'n', version: '1', nodes: [{ nodeId: 'a', typeId: 'core.flow.noop' }],
      edges: [], triggers: [], variables: {}, metadata: {}, settings: {},
    };
    expect(() => validateWorkflowDefinition(wireShaped as never)).toThrow();
  });

  it('leg 4: the legacy alias still WORKS at the validator — the fix narrows the prompt, not the contract', () => {
    const legacy = {
      workflowId: 'authored.legacy',
      nodes: [{ nodeId: 'a', typeId: 'core.flow.noop' }, { nodeId: 'b', typeId: 'core.flow.noop' }],
      edges: [{ edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b' }],
    };
    expect(() => validateWorkflowDefinition(legacy as never), 'existing callers must keep working').not.toThrow();
  });
});

/**
 * ADR 0673 D4 (`WFAWF-16`) — the id bounds are enforced, not merely promised.
 *
 * Born red: `NODE_ID_PATTERN` and `EDGE_ID_PATTERN` were unbounded (`+`), while BOTH error
 * messages said `[a-zA-Z0-9_-]{1,64}` (corrected to {1,128}: sub-chain prefixing mints ids up to 87) — and the authoring repair loop feeds that text back to
 * the model. So the code told the model a constraint it did not keep, and a 200-character
 * node id (a storage key) passed validation.
 */
describe('ADR 0673 D4 — the id patterns keep the promise their error text makes', () => {
  it('leg 1: an over-long node id is REFUSED, and the message is the one the model repairs against', () => {
    const long = 'n'.repeat(129);
    expect(() => validateWorkflowDefinition({
      workflowId: 'authored.longid', nodes: [{ nodeId: long, typeId: 'core.flow.noop' }], edges: [],
    } as never)).toThrow(/\{1,128\}/);
  });

  it('leg 2: an over-long EDGE id is refused too — the sibling defect', () => {
    expect(() => validateWorkflowDefinition({
      workflowId: 'authored.longedge',
      nodes: [{ nodeId: 'a', typeId: 'core.flow.noop' }, { nodeId: 'b', typeId: 'core.flow.noop' }],
      edges: [{ id: 'e'.repeat(129), sourceNodeId: 'a', targetNodeId: 'b' }],
    } as never)).toThrow(/\{1,128\}/);
  });

  it('leg 3: a 128-char id is ACCEPTED — the bound is exact, not one off', () => {
    expect(() => validateWorkflowDefinition({
      workflowId: 'authored.exact', nodes: [{ nodeId: 'n'.repeat(128), typeId: 'core.flow.noop' }], edges: [],
    } as never)).not.toThrow();
  });

  // REGRESSION WITNESS for the defect this bound actually had. The first cut of D4 used the
  // {1,64} the error text advertised, which turned 14 test files red: chain expansion mints
  // `<chainId dots->underscores>_<12-hex>_<nodeId>`, and a SUB-CHAIN prefixes an already-
  // prefixed id AGAIN. These two ids are verbatim from that run - 66 and 87 characters. If
  // anyone re-tightens the bound toward the advertised 64, this leg goes red before the
  // fourteen chain suites do, and names the reason.
  it('leg 4: real chain-expansion ids (single- and double-prefixed) are ACCEPTED', () => {
    const singlePrefixed = 'campaign-studio_campaign-orchestration_a001317ad3f5_kernel-approve';
    const doublePrefixed = 'openwop-app_cdp_sync-to-openwop-host_a9e28c3fdf1a_prepare-onward_b7c1d2e3f4a5_emit';
    expect(singlePrefixed.length).toBe(66);
    expect(doublePrefixed.length).toBeGreaterThan(80);
    for (const id of [singlePrefixed, doublePrefixed]) {
      expect(() => validateWorkflowDefinition({
        workflowId: 'authored.realchain', nodes: [{ nodeId: id, typeId: 'core.flow.noop' }], edges: [],
      } as never), id).not.toThrow();
    }
  });
});
