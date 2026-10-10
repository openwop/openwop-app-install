/**
 * ADR 0785 P3 / D6 — the MCP tools a paired Claude Code reaches this host with.
 *
 * Each tool is an expose-tool workflow (chain-backed through the shared
 * `mcp-tool-projections` pack — never an in-tree registration of the workflow)
 * over an in-tree backing node (the ADR 0393 app-builder precedent). The nodes
 * are thin: every one calls the SAME function its HTTP/chat twin calls.
 *
 *   claude-code-my-todos      read   ensurePersonalBoard + listCards  ≡ GET /kanban/boards/personal
 *   claude-code-add-todo      write  ensurePersonalBoard + createCard ≡ the agent tool's filing path
 *   claude-code-schema-lookup read   lookupAppSchemas                  ≡ openwop:schema.lookup
 *
 * Who a call acts for: an MCP run is stamped `metadata.actingUserId` = the
 * caller's principal (`apikey:<keyId>` for a device key). The node resolves that
 * key to its PAIRED DEVICE, and the device to the human who approved it — their
 * personal workspace and canonical user id were captured at approval (the two
 * inputs the personal-board route derives from its request). A key that is not a
 * paired device's gets a typed refusal: these tools are Claude Code's, not every
 * developer key's. Fail empty without an acting user (CLAUDE.md non-negotiable).
 *
 * Deliberately NOT here (ADR 0785 P3 correction): board-wide kanban, run and
 * interrupt tools. Their access rules (`authorizeBoard`, `loadOwnedRun`) are
 * request-bound and private to their route files; a tool must SHARE its route's
 * predicate, never re-implement it, so those tools wait for that extraction.
 */
import { createHash } from 'node:crypto';
import { getNodeRegistry } from '../../executor/nodeRegistry.js';
import type { NodeContext, NodeOutcome, WorkflowDefinition } from '../../executor/types.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { createCard, ensurePersonalBoard, getCard, listCards, notifyBoardChanged, todoColumnOf } from '../../host/kanbanService.js';
import { lookupAppSchemas } from '../../host/schemaLookup.js';
import { createClaudeCodePermissionApproval, getApproval, resolveApproval } from '../../host/approvalService.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { sanitizeFreeText } from '../../byok/textRedaction.js';
import { workflowVariableTypeFor } from '../../host/mcpToolVariableTypes.js';
import { CLAUDE_CODE_TOGGLE, claudeCodeOperatorEnabled } from './constants.js';
import { deviceForKey, type DeviceRecord } from './pairingService.js';

export const CC_MCP_NODE_PREFIX = 'claude-code.mcp-node.';
export const CC_MCP_WORKFLOW_PREFIX = 'claude-code.mcp.';
const EXPOSE_TOOL = 'core.openwop.mcp.expose-tool';

type Exec = (ctx: NodeContext) => Promise<NodeOutcome>;
const fail = (code: string, message: string): NodeOutcome => ({ status: 'failure', error: { code, message } });
const inputsOf = (ctx: NodeContext): Record<string, unknown> =>
  (ctx.inputs && typeof ctx.inputs === 'object' ? ctx.inputs : {}) as Record<string, unknown>;

/** The paired device (and so the human) an MCP call acts for, or a typed refusal. */
async function actingDevice(ctx: NodeContext): Promise<{ device: DeviceRecord } | { refused: NodeOutcome }> {
  if (!claudeCodeOperatorEnabled()) return { refused: fail('feature_disabled', 'Claude Code is not available on this host.') };
  const acting = ctx.actingUserId;
  if (!acting) return { refused: fail('acting_user_required', 'This tool acts for a person; the call named none.') };
  if (!acting.startsWith('apikey:')) return { refused: fail('device_required', 'Only a paired Claude Code device can call this tool.') };
  const device = await deviceForKey(acting.slice('apikey:'.length), ctx.tenantId);
  if (!device) return { refused: fail('device_required', 'Only a paired Claude Code device can call this tool.') };
  const toggle = await resolveOne(CLAUDE_CODE_TOGGLE, { tenantId: device.tenantId, userId: device.subject }).catch(() => null);
  if (!toggle?.enabled) return { refused: fail('feature_disabled', 'Claude Code is not enabled for this workspace.') };
  return { device };
}

async function personalBoardOf(device: DeviceRecord): Promise<Awaited<ReturnType<typeof ensurePersonalBoard>> | NodeOutcome> {
  if (!device.personalTenant || !device.ownerUserId) {
    return fail('repair_required', 'This device was paired before your board could be linked. Pair it again from the Claude Code page.');
  }
  return ensurePersonalBoard(device.personalTenant, device.ownerUserId);
}
const isOutcome = (v: unknown): v is NodeOutcome => typeof v === 'object' && v !== null && 'status' in v;

function node(id: string, execute: Exec, opts?: { sideEffecting?: boolean }): { typeId: string; version: string; sideEffecting?: boolean; execute: Exec } {
  return { typeId: `${CC_MCP_NODE_PREFIX}${id}`, version: '1.0.0', ...(opts?.sideEffecting ? { sideEffecting: true } : {}), execute };
}

let registered = false;

export function registerClaudeCodeMcpNodes(): void {
  if (registered) return;
  registered = true;
  const registry = getNodeRegistry();

  registry.register(node('my-todos', async (ctx) => {
    const acting = await actingDevice(ctx);
    if ('refused' in acting) return acting.refused;
    const board = await personalBoardOf(acting.device);
    if (isOutcome(board)) return board;
    const columns = new Map(board.columns.map((c) => [c.id, c.name]));
    const cards = (await listCards(board.id)).map((c) => ({
      cardId: c.id, title: c.title, column: columns.get(c.columnId) ?? c.columnId,
      ...(c.dueAt ? { dueAt: c.dueAt } : {}), ...(c.priority ? { priority: c.priority } : {}),
    }));
    return { status: 'success', outputs: { board: { boardId: board.id, name: board.name }, cards } };
  }));

  registry.register(node('add-todo', async (ctx) => {
    const acting = await actingDevice(ctx);
    if ('refused' in acting) return acting.refused;
    const input = inputsOf(ctx);
    const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
    if (!title) return fail('validation_error', '`title` is required.');
    if (title.length > 300) return fail('validation_error', '`title` must be at most 300 characters.');
    const detail = typeof input.detail === 'string' ? input.detail.trim().slice(0, 4000) : '';
    const board = await personalBoardOf(acting.device);
    if (isOutcome(board)) return board;
    const todo = todoColumnOf(board);
    if (!todo) return fail('no_todo_column', 'Your board has no To Do column.');
    // Deterministic id per (run, title, detail): a retried call returns the same card.
    const key = createHash('sha256').update([ctx.runId, acting.device.deviceId, title, detail].join('\u0000')).digest('hex').slice(0, 32);
    const cardId = `card-cc-${key}`;
    const alreadyFiled = (await getCard(cardId)) !== null;
    const card = await createCard({
      boardId: board.id, columnId: todo.id, cardId, title,
      ...(detail ? { description: detail } : {}),
      source: 'api', sourceLabel: 'Claude Code', createdBy: acting.device.ownerUserId,
    });
    if (!alreadyFiled) notifyBoardChanged(board.id);
    return { status: 'success', outputs: { filed: true, alreadyFiled, cardId: card.id, title: card.title, board: board.name } };
  }, { sideEffecting: true }));

  // ADR 0785 P4 — the headless task's permission prompts
  // (`--permission-prompts host --permission-prompt-tool mcp__openwop__claude-code-permission`).
  // Files an approval card in the ONE queue for the device's human, notifies THEM
  // (never a tenant-wide broadcast), and waits — bounded — for the decision. The
  // answer is the permission-result shape the CLI validates (read from the
  // installed 2.1.285 schema): allow {updatedInput} | deny {message}.
  registry.register(node('permission', async (ctx) => {
    const acting = await actingDevice(ctx);
    if ('refused' in acting) return acting.refused;
    const input = inputsOf(ctx);
    const toolName = typeof input.tool_name === 'string' ? input.tool_name.slice(0, 120) : '';
    if (!toolName) return fail('validation_error', '`tool_name` is required.');
    const toolInput = input.input && typeof input.input === 'object' ? input.input as Record<string, unknown> : {};
    const device = acting.device;
    const approval = await createClaudeCodePermissionApproval({
      tenantId: device.tenantId,
      ownerSubject: device.subject,
      permission: {
        deviceId: device.deviceId, deviceLabel: device.label, tool: toolName,
        summary: summarizePermission(toolName, toolInput),
        inputDigest: createHash('sha256').update(JSON.stringify(toolInput)).digest('hex'),
      },
    });
    try {
      await getNotificationEmitter().emit({
        tenantId: device.tenantId,
        recipientUserId: device.ownerUserId ?? device.subject,
        type: 'openwop-app.workflow.approval-needed',
        priority: 'high',
        title: `Claude Code on ${device.label} is asking to use ${toolName}`,
        message: sanitizeFreeText(summarizePermission(toolName, toolInput)),
        actionUrl: `/inbox?approval=${encodeURIComponent(approval.approvalId)}`,
        metadata: { approvalId: approval.approvalId, kind: 'claude-code-permission' },
      });
    } catch { /* best-effort, like every notification emit */ }

    const decided = await waitForDecision(approval.approvalId);
    if (decided === 'approved') return { status: 'success', outputs: { behavior: 'allow', updatedInput: toolInput } };
    if (decided === 'rejected') {
      const note = (await getApproval(approval.approvalId))?.note;
      return { status: 'success', outputs: { behavior: 'deny', message: note ? `Denied in the app: ${note}` : 'Denied in the app.' } };
    }
    // No decision in time: close the card (so it cannot be approved into the void
    // later). A prompt nobody answered never becomes a yes. `on_timeout: 'defer'`
    // is the interactive hook's request: it gets `timedOut` so it can hand the
    // prompt back to the person at the terminal instead of denying.
    await resolveApproval(approval.approvalId, { status: 'rejected', note: 'No decision within the time limit.' }).catch(() => null);
    const defer = input.on_timeout === 'defer';
    return { status: 'success', outputs: { behavior: 'deny', message: 'Nobody answered in the app in time, so this was denied.', ...(defer ? { timedOut: true } : {}) } };
  }, { sideEffecting: true }));

  registry.register(node('schema-lookup', async (ctx) => {
    const acting = await actingDevice(ctx);
    if ('refused' in acting) return acting.refused;
    const r = await lookupAppSchemas(inputsOf(ctx));
    return r.ok ? { status: 'success', outputs: { schema: r.value } } : fail(r.error, r.message);
  }));
}

/** How long a headless task waits for a human (the MCP request is held open). */
export const PERMISSION_WAIT_MS = 240_000;
const PERMISSION_POLL_MS = 1500;
let pollOverride: { waitMs: number; pollMs: number } | null = null;
/** Test-only: shrink the wait. */
export function __setPermissionWaitForTest(v: { waitMs: number; pollMs: number } | null): void { pollOverride = v; }

async function waitForDecision(approvalId: string): Promise<'approved' | 'rejected' | 'timeout'> {
  const { waitMs, pollMs } = pollOverride ?? { waitMs: PERMISSION_WAIT_MS, pollMs: PERMISSION_POLL_MS };
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const a = await getApproval(approvalId);
    if (a?.status === 'approved') return 'approved';
    if (a && a.status !== 'pending') return 'rejected';
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return 'timeout';
}

/** A short, human-readable line for the card — never the whole input (it may carry secrets). */
export function summarizePermission(tool: string, input: Record<string, unknown>): string {
  const str = (k: string): string | undefined => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  const detail = str('command') ?? str('file_path') ?? str('path') ?? str('url') ?? str('pattern')
    ?? Object.keys(input).slice(0, 6).join(', ');
  return sanitizeFreeText(`${tool}${detail ? ` — ${detail}` : ''}`).slice(0, 300);
}

// ── The expose-tool workflows (their DAGs also live in the mcp-tool-projections chain pack) ──

interface ToolSpec {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown> & { properties: Record<string, unknown> };
  safetyTier: 'read' | 'write';
  variables: Array<{ name: string; required: boolean; description: string }>;
}

const SPECS: ToolSpec[] = [
  {
    id: 'my-todos', name: 'claude-code-my-todos',
    description: 'List the cards on YOUR personal board in this app (title, column, due date). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    safetyTier: 'read', variables: [],
  },
  {
    id: 'add-todo', name: 'claude-code-add-todo',
    description: 'File a todo card in the To Do column of YOUR personal board in this app, visible to you there. Use it for work you are committing to but not doing now. Never auto-executed.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short, specific todo title.' },
        detail: { type: 'string', description: 'Optional self-contained context for whoever picks it up.' },
      },
      required: ['title'], additionalProperties: false,
    },
    safetyTier: 'write',
    variables: [
      { name: 'title', required: true, description: 'Todo title.' },
      { name: 'detail', required: false, description: 'Optional context.' },
    ],
  },
  {
    id: 'permission', name: 'claude-code-permission',
    description: 'Permission prompt tool for Claude Code headless tasks started by this app: asks the device owner in the app and returns allow or deny. Not for direct use.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'The tool Claude Code wants to use.' },
        input: { type: 'object', description: 'The tool input Claude Code proposes.' },
        tool_use_id: { type: 'string', description: 'Claude Code\'s id for this tool use.' },
        on_timeout: { type: 'string', enum: ['deny', 'defer'], description: 'deny (headless tasks) or defer (the interactive hook hands the prompt back to the terminal).' },
      },
      required: ['tool_name', 'input'], additionalProperties: true,
    },
    safetyTier: 'write',
    variables: [
      { name: 'tool_name', required: true, description: 'Tool name.' },
      { name: 'input', required: true, description: 'Proposed tool input.' },
      { name: 'tool_use_id', required: false, description: 'Tool-use id.' },
      { name: 'on_timeout', required: false, description: 'deny | defer.' },
    ],
  },
  {
    id: 'schema-lookup', name: 'claude-code-schema-lookup',
    description: 'Look up the schemas this app enforces, BEFORE authoring: workflow-node type schemas (kind "node", names[]), a canvas type\'s component catalog (kind "canvas-component", canvasTypeId), or artifact types (kind "artifact-type"). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['node', 'canvas-component', 'artifact-type'], description: 'Which schema family.' },
        names: { type: 'array', items: { type: 'string' }, description: 'Node typeIds or artifact-type ids.' },
        canvasTypeId: { type: 'string', description: 'The canvas type (kind "canvas-component").' },
      },
      required: ['kind'], additionalProperties: false,
    },
    safetyTier: 'read',
    variables: [
      { name: 'kind', required: true, description: 'Schema family.' },
      { name: 'names', required: false, description: 'Ids to fetch.' },
      { name: 'canvasTypeId', required: false, description: 'Canvas type.' },
    ],
  },
];

function buildToolWorkflow(spec: ToolSpec): WorkflowDefinition {
  const backingInputs: Record<string, unknown> = {};
  for (const v of spec.variables) backingInputs[v.name] = { type: 'variable', variableName: v.name };
  return {
    workflowId: `${CC_MCP_WORKFLOW_PREFIX}${spec.id}`,
    nodes: [
      { nodeId: 'expose', typeId: EXPOSE_TOOL, config: { name: spec.name, description: spec.description, inputSchema: spec.inputSchema }, outputRole: 'secondary' },
      { nodeId: 'backing', typeId: `${CC_MCP_NODE_PREFIX}${spec.id}`, ...(Object.keys(backingInputs).length > 0 ? { inputs: backingInputs } : {}), outputRole: 'primary' },
    ],
    edges: [
      { edgeId: 'e_expose_backing', sourceNodeId: 'expose', sourceOutput: 'handle', targetNodeId: 'backing', targetInput: '_order', triggerRule: 'all_success' },
    ],
    variables: spec.variables.map((v) => ({ name: v.name, type: workflowVariableTypeFor(spec.inputSchema, v.name), description: v.description, required: v.required })),
    // ADR 0087 gates: listed/callable only for a non-anonymous caller whose
    // `claude-code` toggle is on. `mcpApproval:'never'` for the write: it files
    // onto the caller's OWN board, a visible backlog that is never auto-executed
    // (the agent tool's semantics; the app-builder MCP-write precedent).
    metadata: { kind: 'meta-workflow', feature: 'claude-code', mcpTool: spec.name, mcpFeatureToggle: CLAUDE_CODE_TOGGLE, mcpRequiresAuth: true, mcpSafetyTier: spec.safetyTier, mcpApproval: 'never' },
  };
}

export const claudeCodeMcpToolWorkflows: WorkflowDefinition[] = SPECS.map(buildToolWorkflow);
