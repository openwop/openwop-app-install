/**
 * UCP over the inbound MCP server (ADR 0178 Phase 2) — the ADR 0087 declarative-workflow
 * pattern (like notebooks-as-MCP-tools). Each tool is a 2-node built-in workflow:
 *
 *     expose (core.openwop.mcp.expose-tool)   — the tool manifest, scanned STATICALLY by
 *        │ handle (ordering-only edge)          mcpServerRegistry for tools/list
 *        ▼
 *     backing (feature.commerce.nodes.<op>)   — runs LAST → its output is the CallToolResult
 *
 * So an MCP agent can browse the catalog + place an order against an openwop-app merchant
 * WITHOUT the raw UCP REST — the same commerce source of truth (`ctx.features.commerce`),
 * no new store. Gated by the `commerce-ucp` toggle + auth via the workflow metadata
 * (`mcpFeatureToggle`/`mcpRequiresAuth`, read by mcpServerRegistry.isToolAllowed) — the
 * tools are listed/callable ONLY for a non-anonymous caller whose tenant has UCP enabled.
 * No host-layer commerce coupling (the mechanism is generic).
 *
 * Rides the already-Accepted RFC 0020 (inbound MCP) as CONTENT — no new OpenWOP RFC
 * (the ADR 0087 precedent). Order placement creates a demo-mode PENDING/unpaid order
 * (no charge, no fulfillment — those are separate gated steps); payment is Phase 3 (AP2).
 *
 * A2A-skill exposure of the same commerce capability is the next transport increment
 * (the app's A2A server publishes agent CARDS, not a tool registry, so it is a distinct
 * integration — the commerce agent over A2A). Logged in ADR 0178 Phase 2; MCP leads per
 * the ADR's transport-priority open question.
 *
 * @see docs/adr/0178-ucp-universal-commerce-protocol.md
 * @see docs/adr/0087-notebooks-as-mcp-tools.md
 */
import type { WorkflowDefinition } from '../../../executor/types.js';
import { workflowVariableTypeFor } from '../../../host/mcpToolVariableTypes.js';

/** workflowId prefix for the UCP MCP tool workflows (feature-scoped, greppable). */
export const UCP_MCP_WORKFLOW_PREFIX = 'commerce.ucp.mcp.';
const EXPOSE_TOOL = 'core.openwop.mcp.expose-tool';
type JsonSchema = Record<string, unknown>;

interface ToolSpec {
  id: string; name: string; description: string;
  inputSchema: JsonSchema;
  backingType: string;
  /** Threaded run-input → backing-node variables. NO `type` here: it is derived
   *  from `inputSchema` by `workflowVariableTypeFor` (ADR 0602 item F). */
  variables: Array<{ name: string; required: boolean; description: string }>;
  safetyTier: 'read' | 'write';
  /** MCP tool-approval posture (read by the tool loop). Reads stay 'never';
   *  order placement is 'conditional' (gap plan §5B B3): the SERVICE-layer
   *  threshold gate is authoritative — this metadata is defense-in-depth. */
  approval: 'never' | 'conditional';
}

const ORG_VAR = { name: 'orgId', required: true, description: 'The merchant org id.' };

const TOOLS: ToolSpec[] = [
  {
    id: 'catalog-search', name: 'ucp-catalog-search',
    description: 'Browse a merchant’s UCP shopping catalog (name/price/availability). Inputs: { orgId, q? }.',
    inputSchema: { type: 'object', properties: { orgId: { type: 'string' }, q: { type: 'string' } }, required: ['orgId'], additionalProperties: false },
    backingType: 'feature.commerce.nodes.list-products',
    variables: [ORG_VAR, { name: 'q', required: false, description: 'Optional search query.' }],
    safetyTier: 'read',
    approval: 'never',
  },
  {
    id: 'place-order', name: 'ucp-place-order',
    description: 'Place an order against a merchant (demo-mode: creates a PENDING, unpaid order — no charge; payment is a separate step). Inputs: { orgId, lines:[{productId,quantity}], contactId? }.',
    inputSchema: {
      type: 'object',
      properties: {
        orgId: { type: 'string' },
        lines: { type: 'array', items: { type: 'object', properties: { productId: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } }, required: ['productId', 'quantity'], additionalProperties: false }, minItems: 1 },
        contactId: { type: 'string' },
      },
      required: ['orgId', 'lines'], additionalProperties: false,
    },
    backingType: 'feature.commerce.nodes.create-order',
    variables: [ORG_VAR, { name: 'lines', required: true, description: 'Order lines.' }, { name: 'contactId', required: false, description: 'Optional CRM contact id.' }],
    safetyTier: 'write',
    approval: 'conditional',
  },
];

function buildToolWorkflow(spec: ToolSpec): WorkflowDefinition {
  const backingInputs: Record<string, unknown> = {};
  for (const v of spec.variables) backingInputs[v.name] = { type: 'variable', variableName: v.name };
  return {
    workflowId: `${UCP_MCP_WORKFLOW_PREFIX}${spec.id}`,
    nodes: [
      { nodeId: 'expose', typeId: EXPOSE_TOOL, config: { name: spec.name, description: spec.description, inputSchema: spec.inputSchema }, outputRole: 'secondary' },
      { nodeId: 'backing', typeId: spec.backingType, inputs: backingInputs, outputRole: 'primary' },
    ],
    // Ordering-only edge: the backing node runs AFTER expose so it completes last (its
    // output is the CallToolResult). `_order` is ignored by the backing node.
    edges: [{ edgeId: 'e_expose_backing', sourceNodeId: 'expose', sourceOutput: 'handle', targetNodeId: 'backing', targetInput: '_order', triggerRule: 'all_success' }],
    // ADR 0602 § Correction log, item F — the type is DERIVED from this tool's own
    // `inputSchema` by the ONE shared mapper, not hand-written per variable. The
    // hand-written copies were correct today, but they are the same shape the
    // `NBWF-1` defect had: a second place to state a type, with nothing forcing
    // the two to agree except an author noticing.
    variables: spec.variables.map((v) => ({ name: v.name, type: workflowVariableTypeFor(spec.inputSchema, v.name), description: v.description, required: v.required })),
    // Gated in mcpServerRegistry.isToolAllowed via the metadata (the schema-locked
    // expose-tool config can't carry these). Catalog reads stay approval:'never';
    // order placement is 'conditional' (gap plan §5B B3) — the commerceService
    // threshold gate is the authoritative money guard, this flag is defense-in-depth.
    metadata: { kind: 'meta-workflow', feature: 'commerce', mcpTool: spec.name, mcpFeatureToggle: 'commerce-ucp', mcpRequiresAuth: true, mcpSafetyTier: spec.safetyTier, mcpApproval: spec.approval },
  };
}

/** The UCP MCP tool workflows the commerce feature contributes to the built-in catalog. */
export const ucpMcpToolWorkflows: WorkflowDefinition[] = TOOLS.map(buildToolWorkflow);
