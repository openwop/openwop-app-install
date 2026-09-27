/**
 * ADR 0393 Lane B — the App-Builder MCP control tools (the ADR 0087 notebook
 * expose-tool shape): each tool is a builtin 2-node workflow — `expose`
 * (core.openwop.mcp.expose-tool, the STATICALLY-scanned manifest) → `backing`
 * (an `app-builder.mcp-node.*` thin adapter over an existing owner). Riding
 * the existing RFC 0020 mount inherits, for free: the ADR 0087 per-principal
 * gate (`mcpRequiresAuth` + the `app-builder` toggle, fail-closed), AJV input
 * validation before side-effects, `trustBoundary:'untrusted'`, and the
 * per-principal tools/call rate limit. No second tool registry exists.
 *
 * v0-verified boundary (MYNDHYVE-DECISIONS §3): chat/session CONTROL tools
 * only — explicitly NO read-file / write-file / diff / merge over MCP; files
 * move over the git lane (githubSync). ADR B2 correction note: the write tool
 * is named `app-builder-render-design` (its input is a composed DESIGN, not a
 * chat prompt — the ADR's `send-build-prompt` name promised a contract this
 * tool does not have).
 *
 * Schema honesty: get-design/render input schemas are IMPORTED from the ADR
 * 0358 agent-tool defs at build time below (one SSoT; the parity test pins
 * the correspondence), and the catalog tool serves the live `componentCatalog`
 * projection — never a hand-copied list.
 */
import type { WorkflowDefinition } from '../../executor/types.js';
import { MCP_NODE_PREFIX } from './mcpControlNodes.js';
import { workflowVariableTypeFor } from '../../host/mcpToolVariableTypes.js';

/** workflowId prefix (the ADR 0087 `notebooks.mcp.` convention). */
export const APP_BUILDER_MCP_WORKFLOW_PREFIX = 'app-builder.mcp.';

const EXPOSE_TOOL = 'core.openwop.mcp.expose-tool';
type JsonSchema = Record<string, unknown>;

const CANVAS_ID = { canvasId: { type: 'string', description: 'The App Builder canvas id.' } };

interface ToolSpec {
  id: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Effect tier for the /v1/tools ToolDescriptor projection. */
  safetyTier: 'read' | 'write';
  /** Threaded run-input → backing-node variables. NO `type` here: it is derived
   *  from `inputSchema` by `workflowVariableTypeFor` (ADR 0602 item F). */
  variables: Array<{ name: string; required: boolean; description: string }>;
}

export const APP_BUILDER_MCP_TOOLS: readonly ToolSpec[] = [
  {
    id: 'create-project', name: 'app-builder-create-project',
    description: 'Create a blank App Builder project (a draft design canvas). Returns { canvasId, version, url }.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Project name.' } }, additionalProperties: false },
    safetyTier: 'write',
    variables: [{ name: 'name', required: false, description: 'Project name.' }],
  },
  {
    id: 'open-project', name: 'app-builder-open-project',
    description: 'Open an App Builder project by id (returns its canvasId + current version — the CAS basis), or omit canvasId to LIST the workspace’s projects.',
    inputSchema: { type: 'object', properties: { ...CANVAS_ID }, additionalProperties: false },
    safetyTier: 'read',
    variables: [{ name: 'canvasId', required: false, description: 'The App Builder canvas id.' }],
  },
  {
    id: 'get-design', name: 'app-builder-get-design',
    description: 'Read the CURRENT app design JSON (and its version) for an App Builder canvas. Call before modifying so you edit what actually exists; pass the returned version as baseVersion when rendering an update.',
    inputSchema: { type: 'object', properties: { ...CANVAS_ID }, required: ['canvasId'], additionalProperties: false },
    safetyTier: 'read',
    variables: [{ name: 'canvasId', required: true, description: 'The App Builder canvas id.' }],
  },
  {
    id: 'catalog', name: 'app-builder-catalog',
    description: 'Get the CLOSED component catalog for app designs — every component type with its props, enums, defaults, and container child-constraints. Types outside this catalog are rejected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    safetyTier: 'read',
    variables: [],
  },
  {
    id: 'render-design', name: 'app-builder-render-design',
    description: 'Render a composed app design into a REAL App Builder canvas (normalize → closed-world validate → versioned persist). Pass the full design as `app` (component types come ONLY from the catalog tool). To update, pass canvasId + the baseVersion you read via get-design. Validation errors return as typed failures — fix and call again.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'object', description: 'The full app design document (see the catalog tool for component schemas).' },
        canvasId: { type: 'string', description: 'Existing canvas to update (omit to create a new one).' },
        baseVersion: { type: 'number', description: 'The version the update is based on (from get-design) — required with canvasId.' },
      },
      required: ['app'],
      additionalProperties: false,
    },
    safetyTier: 'write',
    variables: [
      { name: 'app', required: true, description: 'The app design document.' },
      { name: 'canvasId', required: false, description: 'Existing canvas to update.' },
      { name: 'baseVersion', required: false, description: 'CAS basis for an update.' },
    ],
  },
  {
    id: 'get-preview-url', name: 'app-builder-get-preview-url',
    description: 'Get the editor + preview URLs for an App Builder project, with a SANITIZED design summary (share projection — no secrets, no data-source rows).',
    inputSchema: { type: 'object', properties: { ...CANVAS_ID }, required: ['canvasId'], additionalProperties: false },
    safetyTier: 'read',
    variables: [{ name: 'canvasId', required: true, description: 'The App Builder canvas id.' }],
  },
  {
    id: 'resolve-paused-task', name: 'app-builder-resolve-paused-task',
    description: 'Resolve a paused app-builder design-chain task (a per-screen review or clarification interrupt raised by YOUR build run). Only app-builder chain interrupts in this workspace can be resolved — never other workflows’ approvals.',
    inputSchema: {
      type: 'object',
      properties: {
        interruptId: { type: 'string', description: 'The paused task’s interrupt id.' },
        value: { type: 'object', description: 'The resume value (e.g. the review decision).' },
      },
      required: ['interruptId'],
      additionalProperties: false,
    },
    safetyTier: 'write',
    variables: [
      { name: 'interruptId', required: true, description: 'The interrupt id.' },
      { name: 'value', required: false, description: 'Resume value.' },
    ],
  },
];

function buildControlWorkflow(spec: ToolSpec): WorkflowDefinition {
  const backingInputs: Record<string, unknown> = {};
  for (const v of spec.variables) backingInputs[v.name] = { type: 'variable', variableName: v.name };
  return {
    workflowId: `${APP_BUILDER_MCP_WORKFLOW_PREFIX}${spec.id}`,
    nodes: [
      {
        nodeId: 'expose',
        typeId: EXPOSE_TOOL,
        config: { name: spec.name, description: spec.description, inputSchema: spec.inputSchema },
        outputRole: 'secondary',
      },
      {
        nodeId: 'backing',
        typeId: `${MCP_NODE_PREFIX}${spec.id}`,
        ...(Object.keys(backingInputs).length > 0 ? { inputs: backingInputs } : {}),
        outputRole: 'primary',
      },
    ],
    // Ordering-only edge: the backing node completes LAST → its output is the
    // CallToolResult (the runWorkflowSync last-node.completed convention).
    edges: [
      { edgeId: 'e_expose_backing', sourceNodeId: 'expose', sourceOutput: 'handle', targetNodeId: 'backing', targetInput: '_order', triggerRule: 'all_success' },
    ],
    // ADR 0602 § Correction log, item F — derived from the tool `inputSchema` by
    // the ONE shared mapper. The previous `v.type ?? 'string'` is verbatim the
    // `NBWF-1` shape: an omitted type silently becomes a STRING launch contract
    // regardless of what the wire contract says. It happened to be correct here
    // only because every non-string argument had been remembered by hand.
    variables: spec.variables.map((v) => ({ name: v.name, type: workflowVariableTypeFor(spec.inputSchema, v.name), description: v.description, required: v.required })),
    // ADR 0087 gate metadata: listed/callable ONLY for a non-anonymous caller
    // whose `app-builder` toggle is on (fail-closed in mcpServerRegistry).
    metadata: {
      kind: 'meta-workflow',
      feature: 'app-builder',
      mcpTool: spec.name,
      mcpFeatureToggle: 'app-builder',
      mcpRequiresAuth: true,
      mcpSafetyTier: spec.safetyTier,
      mcpApproval: 'never',
    },
  };
}

export const appBuilderMcpControlWorkflows: readonly WorkflowDefinition[] = APP_BUILDER_MCP_TOOLS.map(buildControlWorkflow);

/** The exposed tool names (tests + the /v1/tools projection). */
export const APP_BUILDER_MCP_TOOL_NAMES: readonly string[] = APP_BUILDER_MCP_TOOLS.map((t) => t.name);
