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
 * prompt schema must PASS the validator. (A former leg asserted the second bullet against the
 * vendored wire schema; probe-proven unable to fail — the wire-shaped body throws for reasons
 * unrelated to `workflowId` — and cut in wave 18. The rationale lives here instead.)
 *
 * The schema is read where the MODEL receives it — the `responseSchema` `draft` hands to
 * `ctx.callAI` — not grepped from source. The legacy-alias behaviour at the validator is
 * `workflow-edge-id-wire-spelling.test.ts`'s claim ("still accepts the host alias `edgeId`").
 *
 * SABOTAGE (wave 18, probe-witnessed): edge `required` → `edgeId` reds leg 1; dropping
 * `targetNodeId` (edge) or `typeId` (node) from `required` reds leg 2; resolving the edge id
 * from `edgeId` only reds leg 2.
 */
import { describe, expect, it } from 'vitest';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';
import * as pack from '../../../packs/feature.workflow-author.nodes/index.mjs';

interface ObjSchema { required?: string[]; properties?: Record<string, ObjSchema>; items?: ObjSchema }

/** The `responseSchema` the draft node actually hands the model. */
async function promptSchema(): Promise<ObjSchema> {
  let captured: ObjSchema | undefined;
  await pack.draft({
    inputs: { intent: 'capture the schema', maxAttempts: 1 },
    features: {
      'workflow-author': {
        getCatalog: async () => ({ nodes: [] }),
        validateDraft: async () => ({ ok: true, errors: [] }),
      },
    },
    callAI: async (req: { responseSchema: ObjSchema }) => {
      captured = req.responseSchema;
      return { data: { workflowId: 'x', nodes: [{ nodeId: 'a', typeId: 'core.flow.noop' }] } };
    },
  });
  expect(captured, 'draft must pass a responseSchema to ctx.callAI').toBeTruthy();
  return captured!;
}

/** Placeholder values for exactly the keys a `required` list names. */
const VALUES: Record<string, unknown> = {
  workflowId: 'authored.roundtrip', nodeId: 'a', typeId: 'core.flow.noop',
  id: 'e1', edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b',
};
const pick = (required: string[] | undefined, overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  Object.fromEntries((required ?? []).map((k) => [k, k in overrides ? overrides[k] : VALUES[k]]));

describe('ADR 0673 D3 — the model is taught the field the validator actually reads', () => {
  it('leg 1: the prompt schema requires the CANONICAL edge id, not the legacy alias', async () => {
    const edge = (await promptSchema()).properties?.edges?.items;
    expect(edge?.required,
      '`edgeId` is an alias kept for existing callers; teaching it to the model is teaching the wrong name',
    ).toEqual(['id', 'sourceNodeId', 'targetNodeId']);
    expect(Object.keys(edge?.properties ?? {}), 'and the alias must not linger as a declared property either').not.toContain('edgeId');
  });

  it('leg 2 (the round-trip): a definition shaped by the prompt schema PASSES the validator', async () => {
    // Built from EXACTLY the fields the schema declares required, nothing more — so a
    // schema that stops requiring something the validator needs goes red here.
    const schema = await promptSchema();
    const nodeReq = schema.properties?.nodes?.items?.required;
    const edgeReq = schema.properties?.edges?.items?.required;
    const authored = {
      ...pick(schema.required),
      nodes: [pick(nodeReq, { nodeId: 'a' }), pick(nodeReq, { nodeId: 'b' })],
      edges: [pick(edgeReq)],
    };
    expect(() => validateWorkflowDefinition(authored), 'the write gate must accept what the model is told to produce').not.toThrow();
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
    })).toThrow(/\{1,128\}/);
  });

  it('leg 2: an over-long EDGE id is refused too — the sibling defect', () => {
    expect(() => validateWorkflowDefinition({
      workflowId: 'authored.longedge',
      nodes: [{ nodeId: 'a', typeId: 'core.flow.noop' }, { nodeId: 'b', typeId: 'core.flow.noop' }],
      edges: [{ id: 'e'.repeat(129), sourceNodeId: 'a', targetNodeId: 'b' }],
    })).toThrow(/\{1,128\}/);
  });

  it('leg 3: a 128-char id is ACCEPTED — the bound is exact, not one off', () => {
    expect(() => validateWorkflowDefinition({
      workflowId: 'authored.exact', nodes: [{ nodeId: 'n'.repeat(128), typeId: 'core.flow.noop' }], edges: [],
    })).not.toThrow();
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
      }), id).not.toThrow();
    }
  });
});
