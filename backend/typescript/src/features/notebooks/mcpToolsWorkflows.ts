/**
 * Notebooks as MCP tools (ADR 0087) — the expose-tool built-in workflows that
 * register the notebook read operations on the host's RFC 0020 inbound MCP server.
 *
 * Each workflow is a 2-node graph:
 *   expose  (core.openwop.mcp.expose-tool)  — carries the tool manifest
 *      │  handle                              (name/description/inputSchema), scanned
 *      ▼                                       STATICALLY by mcpServerRegistry for
 *   backing (feature.notebooks.nodes.<op>)   tools/list; the edge only ORDERS so the
 *                                            backing node completes LAST → its output
 *                                            is the CallToolResult (runWorkflowSync
 *                                            reads the last node.completed).
 *
 * The MCP `arguments` (validated against the manifest inputSchema before run start)
 * seed the run inputs, which seed the workflow variables, which feed the backing
 * node — so `notebookId`/`query`/`topK` reach the surface read. Org-visibility +
 * tenant scoping are the host surface's job (the run's tenant comes from the caller's
 * principal); read-only, replay-safe.
 *
 * These appear in `tools/list` / `/v1/tools` ONLY when the caller is authenticated
 * (non-anonymous) and the `notebooks` toggle is on for their tenant — gated in
 * mcpServerRouter + the /v1/tools projection by the `notebooks.mcp.` workflowId
 * prefix (ADR 0087 P1.b / P3; the generic global workflowsRegistry is unchanged).
 *
 * @see docs/adr/0087-notebooks-as-mcp-tools.md
 */

import type { WorkflowDefinition } from '../../executor/types.js';

/** workflowId prefix the MCP router + /v1/tools projection gate on (auth + the
 *  `notebooks` toggle). Exported so the gate and the tests share one constant. */
export const NOTEBOOK_MCP_WORKFLOW_PREFIX = 'notebooks.mcp.';

const EXPOSE_TOOL = 'core.openwop.mcp.expose-tool';
type JsonSchema = Record<string, unknown>;

interface ToolSpec {
  id: string; // workflowId suffix
  name: string; // MCP tool name (notebook-*)
  description: string;
  inputSchema: JsonSchema;
  backingType: string; // feature.notebooks.nodes.<op>
  /** Variable names threaded from run inputs → the backing node's inputs. */
  variables: Array<{ name: string; required: boolean; description: string }>;
}

const NOTEBOOK_ID_VAR = { name: 'notebookId', required: true, description: 'The notebook id.' };
const QUERY_VAR = { name: 'query', required: true, description: 'The search/ask query.' };
const TOPK_VAR = { name: 'topK', required: false, description: 'Max results.' };

const TOOLS: ToolSpec[] = [
  {
    id: 'list', name: 'notebook-list',
    description: 'List the research notebooks you can access in this workspace.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    backingType: 'feature.notebooks.nodes.list-notebooks',
    variables: [],
  },
  {
    id: 'get', name: 'notebook-get',
    description: 'Get one research notebook by id (name + bound collection).',
    inputSchema: { type: 'object', properties: { notebookId: { type: 'string' } }, required: ['notebookId'], additionalProperties: false },
    backingType: 'feature.notebooks.nodes.get-notebook',
    variables: [NOTEBOOK_ID_VAR],
  },
  {
    id: 'list-sources', name: 'notebook-list-sources',
    description: "List a notebook's sources (each with its per-source context level).",
    inputSchema: { type: 'object', properties: { notebookId: { type: 'string' } }, required: ['notebookId'], additionalProperties: false },
    backingType: 'feature.notebooks.nodes.list-sources',
    variables: [NOTEBOOK_ID_VAR],
  },
  {
    id: 'list-notes', name: 'notebook-list-notes',
    description: "List a notebook's notes.",
    inputSchema: { type: 'object', properties: { notebookId: { type: 'string' } }, required: ['notebookId'], additionalProperties: false },
    backingType: 'feature.notebooks.nodes.list-notes',
    variables: [NOTEBOOK_ID_VAR],
  },
  {
    id: 'search', name: 'notebook-search',
    description: "Semantic search over a notebook's sources — ranked hits + citations.",
    inputSchema: {
      type: 'object',
      properties: { notebookId: { type: 'string' }, query: { type: 'string' }, topK: { type: 'integer', minimum: 1, maximum: 50 } },
      required: ['notebookId', 'query'], additionalProperties: false,
    },
    backingType: 'feature.notebooks.nodes.search',
    variables: [NOTEBOOK_ID_VAR, QUERY_VAR, TOPK_VAR],
  },
  {
    id: 'ask', name: 'notebook-ask',
    description: "Grounded retrieval over a notebook — returns a fenced, cited context block for your model to answer from.",
    inputSchema: {
      type: 'object',
      properties: { notebookId: { type: 'string' }, query: { type: 'string' }, topK: { type: 'integer', minimum: 1, maximum: 50 } },
      required: ['notebookId', 'query'], additionalProperties: false,
    },
    backingType: 'feature.notebooks.nodes.ask',
    variables: [NOTEBOOK_ID_VAR, QUERY_VAR, TOPK_VAR],
  },
];

function buildToolWorkflow(spec: ToolSpec): WorkflowDefinition {
  const backingInputs: Record<string, unknown> = {};
  for (const v of spec.variables) backingInputs[v.name] = { type: 'variable', variableName: v.name };
  return {
    workflowId: `${NOTEBOOK_MCP_WORKFLOW_PREFIX}${spec.id}`,
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
    // Ordering-only edge: the backing node runs AFTER expose so it completes last
    // (its output is the CallToolResult). `handle` is ignored by the backing node.
    edges: [
      { edgeId: 'e_expose_backing', sourceNodeId: 'expose', sourceOutput: 'handle', targetNodeId: 'backing', targetInput: '_order', triggerRule: 'all_success' },
    ],
    variables: spec.variables.map((v) => ({ name: v.name, type: 'string', description: v.description, required: v.required })),
    // `mcpFeatureToggle` + `mcpRequiresAuth` are read by mcpServerRegistry → the
    // router/`/v1/tools` gate (ADR 0087 P3): the tool is listed/callable ONLY for a
    // non-anonymous caller whose `notebooks` toggle is on. Generic host mechanism —
    // no notebooks coupling in the host layer (the schema-locked expose-tool config
    // can't carry these, so they ride the workflow metadata).
    metadata: { kind: 'meta-workflow', feature: 'notebooks', mcpTool: spec.name, mcpFeatureToggle: 'notebooks', mcpRequiresAuth: true, mcpSafetyTier: 'read', mcpApproval: 'never' },
  };
}

// ── WRITE tools (ADR 0087 OQ-1 — HITL-gated) ──────────────────────────────────
// Each is a 3-node chain: expose (manifest) → approval (core.hitl.approval-request,
// suspends the run for a human decision) → write (the decision-gated backing node).
// The write executes only after a workspace member approves, so an untrusted MCP
// client can never silently mutate the workspace. ToolDescriptor: safetyTier:'write'
// + approval:'always'.

const APPROVAL = 'core.hitl.approval-request';

interface WriteToolSpec {
  id: string;
  name: string;
  description: string;
  approvalPrompt: string;
  inputSchema: JsonSchema;
  backingType: string;
  variables: Array<{ name: string; required: boolean; description: string }>;
}

const CONTENT_VAR = { name: 'content', required: true, description: 'The note content.' };
const TITLE_VAR = { name: 'title', required: false, description: 'Source title.' };
const TEXT_VAR = { name: 'text', required: true, description: 'Source text to ingest.' };

const WRITE_TOOLS: WriteToolSpec[] = [
  {
    id: 'add-source', name: 'notebook-add-source',
    description: 'Add a text source to a notebook (requires human approval).',
    approvalPrompt: 'An MCP client requests adding a source to this notebook. Approve?',
    inputSchema: {
      type: 'object',
      properties: { notebookId: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' } },
      required: ['notebookId', 'text'], additionalProperties: false,
    },
    backingType: 'feature.notebooks.nodes.mcp-add-source',
    variables: [NOTEBOOK_ID_VAR, TITLE_VAR, TEXT_VAR],
  },
  {
    id: 'create-note', name: 'notebook-create-note',
    description: 'Add a note to a notebook (requires human approval).',
    approvalPrompt: 'An MCP client requests creating a note in this notebook. Approve?',
    inputSchema: {
      type: 'object',
      properties: { notebookId: { type: 'string' }, content: { type: 'string' } },
      required: ['notebookId', 'content'], additionalProperties: false,
    },
    backingType: 'feature.notebooks.nodes.mcp-create-note',
    variables: [NOTEBOOK_ID_VAR, CONTENT_VAR],
  },
];

function buildWriteToolWorkflow(spec: WriteToolSpec): WorkflowDefinition {
  const backingInputs: Record<string, unknown> = {};
  for (const v of spec.variables) backingInputs[v.name] = { type: 'variable', variableName: v.name };
  return {
    workflowId: `${NOTEBOOK_MCP_WORKFLOW_PREFIX}${spec.id}`,
    nodes: [
      {
        nodeId: 'expose',
        typeId: EXPOSE_TOOL,
        config: { name: spec.name, description: spec.description, inputSchema: spec.inputSchema },
        outputRole: 'secondary',
      },
      {
        nodeId: 'approval',
        typeId: APPROVAL,
        inputs: { prompt: { type: 'static', value: spec.approvalPrompt } },
        outputRole: 'secondary',
      },
      {
        nodeId: 'write',
        typeId: spec.backingType,
        inputs: backingInputs,
        outputRole: 'primary',
      },
    ],
    edges: [
      // expose → approval (ordering); approval suspends for a human decision, which
      // gates the write. The write completes only on resume-with-accept.
      { edgeId: 'e_expose_approval', sourceNodeId: 'expose', sourceOutput: 'handle', targetNodeId: 'approval', targetInput: '_order', triggerRule: 'all_success' },
      { edgeId: 'e_approval_write', sourceNodeId: 'approval', sourceOutput: 'decision', targetNodeId: 'write', targetInput: 'decision', triggerRule: 'all_success' },
    ],
    variables: spec.variables.map((v) => ({ name: v.name, type: 'string', description: v.description, required: v.required })),
    metadata: { kind: 'meta-workflow', feature: 'notebooks', mcpTool: spec.name, mcpFeatureToggle: 'notebooks', mcpRequiresAuth: true, mcpSafetyTier: 'write', mcpApproval: 'always' },
  };
}

export const notebookMcpToolWorkflows: readonly WorkflowDefinition[] = [
  ...TOOLS.map(buildToolWorkflow),
  ...WRITE_TOOLS.map(buildWriteToolWorkflow),
];

/** The tool names this feature exposes (for tests + the /v1/tools projection). */
export const NOTEBOOK_MCP_TOOL_NAMES: readonly string[] = [...TOOLS, ...WRITE_TOOLS].map((t) => t.name);
