/**
 * Docs MCP tool workflows (ADR 0392 Phase 3) — expose-tool builtin workflows
 * that surface `docs.search` / `docs.get` to external agents/IDEs, mirroring
 * `features/notebooks/mcpToolsWorkflows.ts` EXACTLY. Read-only, workflowId-
 * prefixed `docs.mcp.` + gated per-principal by the ADR 0087 projection
 * (`mcpRequiresAuth` + `mcpFeatureToggle:'docs'`). Tool schemas come from the
 * SSoT const (`docsMcpSchemas.ts`) → no drift with the backing nodes.
 *
 * @see docs/adr/0087-notebooks-as-mcp-tools.md
 */
import type { WorkflowDefinition } from '../../executor/types.js';
import { DOCS_MCP_TOOLS } from './docsMcpSchemas.js';
import { workflowVariableTypeFor } from '../../host/mcpToolVariableTypes.js';

/** workflowId prefix the MCP router + /v1/tools projection gate on. */
export const DOCS_MCP_WORKFLOW_PREFIX = 'docs.mcp.';
const EXPOSE_TOOL = 'core.openwop.mcp.expose-tool';

/**
 * Variables threaded from run inputs → the backing node's inputs, DERIVED from
 * the tool's own `inputSchema`.
 *
 * ADR 0602 § Correction log, item F (`L6`). This was a hand-kept
 * `VARS_FOR_TOOL` table sitting beside a file whose docblock calls itself "the
 * SINGLE source of truth", with nothing gating the two against each other — and
 * they had ALREADY drifted: the table said `limit` was "Max hits (default 8, max
 * 20)." where the schema said "Max hits to return (default 8, max 20).", and
 * `slug` "The docs page slug." where the schema said "The docs page slug (as
 * shown in its /docs/<slug> URL).". Two texts for one argument, shown to two
 * different audiences. The name set, the required set, the type and the
 * description now all come from the schema, so the second table cannot exist to
 * drift. (Notebooks keeps hand-written variable descriptions because ITS tool
 * schemas declare none — there is no second copy there to disagree with.)
 */
function varsForTool(spec: (typeof DOCS_MCP_TOOLS)[number]): Array<{ name: string; required: boolean; description: string }> {
  const props = spec.inputSchema.properties as Record<string, { description?: unknown }>;
  const required = new Set(spec.inputSchema.required ?? []);
  return Object.entries(props).map(([name, prop]) => {
    if (typeof prop.description !== 'string') {
      // Fail-closed, matching `workflowVariableTypeFor`: every input here is an
      // in-repo static literal, so a missing description is an authoring defect
      // caught at module evaluation, never a runtime surprise. Silently emitting
      // `undefined` would put an undescribed argument on the `/builder` +
      // `/`-picker launch form.
      throw new Error(`docs mcp tool '${spec.name}' argument '${name}' has no schema description — ADR 0602.`);
    }
    return { name, required: required.has(name), description: prop.description };
  });
}

export const docsMcpToolWorkflows: WorkflowDefinition[] = DOCS_MCP_TOOLS.map((spec) => {
  const vars = varsForTool(spec);
  const backingInputs: Record<string, unknown> = {};
  for (const v of vars) backingInputs[v.name] = { type: 'variable', variableName: v.name };
  return {
    workflowId: `${DOCS_MCP_WORKFLOW_PREFIX}${spec.name}`,
    nodes: [
      {
        nodeId: 'expose',
        typeId: EXPOSE_TOOL,
        config: { name: spec.name, description: spec.description, inputSchema: spec.inputSchema },
        outputRole: 'secondary',
      },
      {
        nodeId: 'backing',
        typeId: spec.backingType,
        ...(Object.keys(backingInputs).length > 0 ? { inputs: backingInputs } : {}),
        outputRole: 'primary',
      },
    ],
    edges: [
      { edgeId: 'e_expose_backing', sourceNodeId: 'expose', sourceOutput: 'handle', targetNodeId: 'backing', targetInput: '_order', triggerRule: 'all_success' },
    ],
    // ADR 0602 — this file says it mirrors notebooks' generator "EXACTLY", and it
    // mirrored the DEFECT too: `type: 'string' as const` for every variable made
    // `docs_search.limit` (a `number` on the wire) advertise a string launch
    // contract. Found by the `NBWF-1` parity gate, unfiled by any tracker.
    variables: vars.map((v) => ({ name: v.name, type: workflowVariableTypeFor(spec.inputSchema, v.name), description: v.description, required: v.required })),
    metadata: { kind: 'meta-workflow', feature: 'docs', mcpTool: spec.name, mcpFeatureToggle: 'docs', mcpRequiresAuth: true, mcpSafetyTier: 'read', mcpApproval: 'never' },
  };
});
