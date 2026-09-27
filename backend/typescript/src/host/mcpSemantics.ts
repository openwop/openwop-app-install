/**
 * ADR 0553 P2 — the version-neutral MCP semantic service.
 *
 * ONE owner for what an MCP method MEANS on this host: which tools a principal
 * may see, what a `tools/call` does (start a run over the exposed workflow with
 * `trustBoundary: 'untrusted'`), what `resources/read` and `prompts/get` do, and
 * how a suspended run is resumed. The two CODECS —
 * `mcpServerRouter.ts` (`mcp-2025-06-18-legacy`) and `mcpCurrentCodec.ts`
 * (`mcp-2026-07-28`) — own only the WIRE: envelope shape, headers, `_meta`,
 * `resultType`, cache hints, error codes.
 *
 * WHY THE SPLIT, and why it is not a second registry. ADR 0553's boundaries
 * table is explicit: "Method semantics — extracted from existing
 * `mcpServerRouter`; no duplicate registry". The two revisions disagree about
 * the envelope and agree about the meaning; a host that implemented the current
 * revision as a second router would have two authorization paths, two
 * `inputSchema` validators and two trust-boundary stampers, and the day they
 * drifted the SECURITY invariants (`mcp-server-untrusted-args`,
 * ADR 0087 tool authorization) would hold on one wire and not the other. So the
 * registry stays `mcpServerRegistry.ts`, the meaning stays here, and each codec
 * is a projection.
 *
 * The outcomes below are deliberately NOT MCP shapes. `awaiting-input` is the
 * one that matters: the legacy codec projects it as an `isError` CallToolResult
 * (a suspended run has no legacy answer — the live `elicitation/create` callback
 * is a separate method there), while the current codec projects the SAME
 * outcome as an MRTR `input_required` with a bound `requestState`. Had the
 * semantic layer returned a `CallToolResult`, that difference would have had
 * nowhere to live.
 *
 * @see spec/v1/mcp-integration.md §"MCP 2026-07-28 versioned composition" §C
 * @see RFCS/0020-host-mcp-server-composition.md §D
 */

import { assertApprovalSurfaceTrusted } from './a2uiSurfaceAdmission.js';
import { randomUUID } from 'node:crypto';
import { insertRunWithStartContext } from './runInsert.js';
import { resolveLaunchWorkflow } from './resolveLaunchDefinition.js';
import { seedRunVariables } from './variablesRuntime.js';
import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from './index.js';
import type { InterruptRecord, Principal, RunRecord } from '../types.js';
import { executeRun } from '../executor/executor.js';
import {
  findElicitationHandler,
  findPromptByName,
  findResourceByUri,
  findSamplingHandler,
  findToolByName,
  isToolAllowed,
  listPrompts,
  listResources,
  listResourceTemplates,
  listToolsForPrincipal,
} from './mcpServerRegistry.js';
import { awaitRunResumeChain, resolveAndResume } from '../routes/interrupts.js';
import { compileToolSchema } from './toolSchemaValidation.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.mcpSemantics');

export interface McpSemanticDeps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
  principal: Principal;
}

/**
 * The result of a semantic operation that RUNS something. Version-neutral by
 * construction: no field here is spelled the way either revision spells it.
 */
export type McpRunOutcome =
  | { kind: 'completed'; runId: string; outputs: Record<string, unknown> | null; text: string }
  | { kind: 'failed'; runId: string; text: string }
  | { kind: 'cancelled'; runId: string; text: string }
  /** The run reached `waiting-input` / `waiting-approval` with an open interrupt. */
  | { kind: 'awaiting-input'; runId: string; interrupt: InterruptRecord }
  /** The run suspended but no interrupt row is readable — a host fault, not a peer one. */
  | { kind: 'awaiting-input-opaque'; runId: string };

/** Refusals that never start a run. Uniform on the wire, distinguished in logs. */
export type McpRefusal =
  | { kind: 'not-exposed'; message: string }
  | { kind: 'invalid-args'; message: string; violations: unknown[] }
  | { kind: 'invalid-uri'; message: string };

export type McpToolCallResult = McpRunOutcome | McpRefusal;

function isRefusal(r: McpToolCallResult): r is McpRefusal {
  return r.kind === 'not-exposed' || r.kind === 'invalid-args' || r.kind === 'invalid-uri';
}
export { isRefusal as isMcpRefusal };

// ─────────────────────────────────────────────────────────────────
// Registry projections (identical under both revisions)
// ─────────────────────────────────────────────────────────────────

export interface McpToolView {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export async function toolsView(principal: Principal): Promise<McpToolView[]> {
  // ADR 0087 — authorization-scoped: a caller sees only the tools their auth +
  // feature toggles permit (gated tools hidden from anon / toggle-off callers).
  // This is also WHY the current revision's `cacheScope` for `tools/list` is
  // `private` and never `public` (RFC 0153 §D): the list depends on the caller.
  const tools = await listToolsForPrincipal(principal);
  return tools
    .map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema }))
    // §D: ordering MUST be deterministic (upstream SHOULD → OpenWOP MUST).
    // Sorted here rather than in the current codec so the legacy list is stable
    // too — an unstable list is a bug on both wires, only normative on one.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function resourcesView(): Array<Record<string, unknown>> {
  return listResources()
    .map((r) => {
      const view: Record<string, unknown> = { uri: r.uri };
      if (r.name !== undefined) view.name = r.name;
      if (r.description !== undefined) view.description = r.description;
      if (r.mimeType !== undefined) view.mimeType = r.mimeType;
      return view;
    })
    .sort((a, b) => String(a.uri).localeCompare(String(b.uri)));
}

export function resourceTemplatesView(): Array<Record<string, unknown>> {
  return listResourceTemplates()
    .map((r) => {
      const view: Record<string, unknown> = { uriTemplate: r.uri };
      if (r.name !== undefined) view.name = r.name;
      if (r.description !== undefined) view.description = r.description;
      if (r.mimeType !== undefined) view.mimeType = r.mimeType;
      return view;
    })
    .sort((a, b) => String(a.uriTemplate).localeCompare(String(b.uriTemplate)));
}

export function promptsView(): Array<Record<string, unknown>> {
  return listPrompts()
    .map((p) => {
      const view: Record<string, unknown> = { name: p.name };
      if (p.description !== undefined) view.description = p.description;
      if (p.arguments !== undefined) view.arguments = p.arguments;
      return view;
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export { findSamplingHandler, findElicitationHandler };

// ─────────────────────────────────────────────────────────────────
// tools/call — workflow as MCP tool
// ─────────────────────────────────────────────────────────────────

export async function callTool(
  name: unknown,
  rawArgs: unknown,
  deps: McpSemanticDeps,
): Promise<McpToolCallResult> {
  const startedAt = Date.now();
  if (typeof name !== 'string' || name.length === 0) {
    return { kind: 'not-exposed', message: 'tools/call requires params.name' };
  }
  const tool = findToolByName(name);
  // ADR 0087 — fail-closed + uniform: a tool the caller isn't authorized for is
  // indistinguishable from a non-existent one (no existence leak via the error).
  if (!tool || !(await isToolAllowed(tool, deps.principal))) {
    // MCP-2 — observability for a security-sensitive external surface: the WIRE
    // error stays uniform (`not exposed`), but the LOG distinguishes unknown vs
    // unauthorized so an operator can see denial RATE + abuse on the MCP door
    // (the repo's log-as-metric convention; a denied call creates no run, so it
    // is otherwise untraced).
    log.info('mcp_tool_denied', {
      toolName: name,
      reason: tool ? 'unauthorized' : 'unknown_tool',
      principalId: deps.principal.principalId,
    });
    return { kind: 'not-exposed', message: `tool '${name}' not exposed` };
  }

  const args = asObject(rawArgs);

  // RFC 0020 §D + SECURITY/invariants.yaml mcp-server-untrusted-args:
  // arguments MUST validate against the tool's declared inputSchema
  // BEFORE any workflow side-effects.
  try {
    const validate = compileToolSchema(tool.inputSchema);
    if (!validate(args)) {
      return {
        kind: 'invalid-args',
        message: 'tool arguments failed inputSchema validation',
        violations: validate.errors ?? [],
      };
    }
  } catch (err) {
    return {
      kind: 'invalid-args',
      message: 'tool inputSchema compile failed',
      violations: [{ reason: err instanceof Error ? err.message : String(err) }],
    };
  }

  const outcome = await runWorkflow({ deps, workflowId: tool.workflowId, inputs: args });

  // MCP-2 — one structured line per executed tool call (count + latency +
  // outcome), the SRE-alertable signal for the external MCP door.
  log.info('mcp_tool_call', {
    toolName: name,
    workflowId: tool.workflowId,
    outcome: outcome.kind,
    durationMs: Date.now() - startedAt,
  });
  return outcome;
}

export async function readResource(uri: unknown, deps: McpSemanticDeps): Promise<McpToolCallResult> {
  if (typeof uri !== 'string' || uri.length === 0) {
    return { kind: 'invalid-uri', message: 'resources/read requires params.uri' };
  }
  // RFC 0020 §D: resource URIs MUST be normalized + sandboxed. Parse via
  // WHATWG URL (handles percent-decoding), reject non-allowlisted schemes,
  // then reject any path component that decodes to `..` (defeats
  // encoded-traversal: `%2e%2e%2f`, `..%2f`, `%2e%2e/`, etc.).
  if (!isSafeResourceUri(uri)) {
    return { kind: 'invalid-uri', message: 'resource uri rejected: unsupported scheme or path traversal' };
  }
  const resource = findResourceByUri(uri);
  if (!resource) return { kind: 'not-exposed', message: `resource '${uri}' not exposed` };
  return runWorkflow({ deps, workflowId: resource.workflowId, inputs: { uri } });
}

export async function getPrompt(
  name: unknown,
  rawArgs: unknown,
  deps: McpSemanticDeps,
): Promise<McpToolCallResult> {
  if (typeof name !== 'string' || name.length === 0) {
    return { kind: 'not-exposed', message: 'prompts/get requires params.name' };
  }
  const prompt = findPromptByName(name);
  if (!prompt) return { kind: 'not-exposed', message: `prompt '${name}' not exposed` };
  // RFC 0020 §D: prompt arguments are NOT template-evaluated. We pass
  // them as inputs.arguments and let the workflow do the rendering
  // explicitly (no eval, no Function constructor).
  return runWorkflow({ deps, workflowId: prompt.workflowId, inputs: { arguments: asObject(rawArgs) } });
}

/** Where the exposed `resources/read` / `prompts/get` projections need it. */
export function findResourceMimeType(uri: string): string | undefined {
  return findResourceByUri(uri)?.mimeType;
}

export function findPromptDescription(name: string): string | undefined {
  return findPromptByName(name)?.description;
}

// ─────────────────────────────────────────────────────────────────
// Resume — the MRTR retry's semantic half (RFC 0153 §C.2)
// ─────────────────────────────────────────────────────────────────

/**
 * Resolve an open interrupt on an MCP-started run and wait for the run to
 * settle again, returning the SAME outcome vocabulary as the initial call.
 *
 * Uses `resolveAndResume` — the one owner of interrupt resolution — rather than
 * writing the resolution directly, so the RFC 0051 quorum/eligibility gate, the
 * `approval.overridden` audit, the review signal, and the per-run resume
 * serialization all apply to an MRTR retry exactly as to a human clicking
 * Approve. An MCP retry that bypassed it would be "MCP content advancing a
 * gate", which §E forbids in as many words.
 *
 * The caller is authorized as an RFC 0051 CAPABILITY-TOKEN approver: the
 * `requestState` the peer echoed is HMAC-bound to this interrupt's token
 * (`mcpRequestState.ts`), and possession of that token is the RFC 0093 §B.3
 * capability. `assertTokenQuorumVote` still refuses a vote that does not name a
 * listed approver when the gate declares an explicit list.
 */
export async function resumeInterrupt(
  deps: McpSemanticDeps,
  interruptId: string,
  resumeValue: unknown,
): Promise<McpRunOutcome> {
  const interrupt = await deps.storage.getInterrupt(interruptId);
  if (!interrupt) {
    return { kind: 'failed', runId: '', text: 'interrupt no longer open' };
  }
  // RFC 0209 §C.12 (ADR 0749) — BEFORE the claim below: `resolveAndResume`
  // re-checks, but by then this path has consumed the interrupt, so a refusal
  // there would strand it (resolved, never resumed).
  try {
    await assertApprovalSurfaceTrusted(interrupt);
  } catch (err) {
    return { kind: 'failed', runId: interrupt.runId, text: err instanceof Error ? err.message : 'approval blocked by untrusted content' };
  }
  // Single use, enforced by CONSUMING the interrupt (the ENG-6 claim pattern):
  // the storage CAS flips resolved_at NULL→set and returns `won` only to the
  // first caller, so a replayed `requestState` — even one whose HMAC verifies —
  // finds nothing left to resolve.
  const wonAt = new Date().toISOString();
  const won = await deps.storage.resolveInterrupt(interrupt.interruptId, resumeValue, wonAt);
  if (!won) {
    return { kind: 'failed', runId: interrupt.runId, text: 'interrupt already resolved' };
  }
  await resolveAndResume(deps.storage, deps.hostSuite, interruptId, resumeValue, { capabilityToken: true });
  await awaitRunResumeChain(interrupt.runId);
  return await outcomeForRun(deps, interrupt.runId);
}

// ─────────────────────────────────────────────────────────────────
// Run-and-collect
// ─────────────────────────────────────────────────────────────────

/**
 * Start `workflowId` with explicit inputs and collect its outcome. Exported for
 * the LEGACY codec's two live-callback bridges (`sampling/createMessage`,
 * `elicitation/create`), which feed the inbound JSON-RPC params in as
 * `{ request }` — a shape the current profile has no counterpart for, since §C
 * replaced server-initiated requests with MRTR. The run itself is shared: same
 * untrusted boundary, same variable seeding, same outcome vocabulary.
 */
export async function runWorkflowById(
  deps: McpSemanticDeps,
  workflowId: string,
  inputs: Record<string, unknown>,
): Promise<McpRunOutcome> {
  return runWorkflow({ deps, workflowId, inputs });
}

async function runWorkflow(input: {
  deps: McpSemanticDeps;
  workflowId: string;
  inputs: Record<string, unknown>;
}): Promise<McpRunOutcome> {
  const { deps, workflowId, inputs } = input;
  const tenantId =
    deps.principal.tenants[0] && deps.principal.tenants[0] !== '*' ? deps.principal.tenants[0] : 'mcp-default';

  // ADR 0474 P1b — MCP-mounted launches are production: published-when-present.
  const wf = await resolveLaunchWorkflow(deps.hostSuite.workflowCatalog, tenantId, workflowId);
  if (!wf) {
    return { kind: 'failed', runId: '', text: `workflowId ${workflowId} unknown` };
  }

  const runId = randomUUID();
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId,
    workflowId,
    tenantId,
    status: 'pending',
    inputs,
    // RFC 0020 §D — every MCP-originated run is untrusted, on BOTH wires.
    metadata: { launchResolved: wf.launchResolved, source: 'mcp-server-mount', trustBoundary: 'untrusted' },
    configurable: {},
    createdAt: now,
    updatedAt: now,
  };
  await insertRunWithStartContext(deps.storage, run, { definition: wf.definition });

  // Seed the run's variable bag from the inbound inputs (the MCP `arguments`) per the
  // workflow's `variables[]`, so `{type:'variable'}` node inputs resolve — the
  // subWorkflowDispatcher precedent. Without this, an expose-tool workflow whose
  // backing node reads tool args via variables (e.g. the ADR 0087 notebook tools)
  // would see them undefined (executeRun only HYDRATES a previously-seeded bag).
  seedRunVariables(runId, wf.definition.variables, inputs);

  await executeRun(deps.storage, run, wf.definition, {
    policyResolver: deps.hostSuite.providerPolicyResolver,
  });
  return await outcomeForRun(deps, runId);
}

/** Read a run's terminal disposition + outputs from the event log and status. */
async function outcomeForRun(deps: McpSemanticDeps, runId: string): Promise<McpRunOutcome> {
  const run = await deps.storage.getRun(runId);
  const events = await deps.storage.listEvents(runId);
  let outputs: Record<string, unknown> | null = null;
  let error: { code: string; message: string } | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.type === 'node.completed' && outputs === null) {
      const p = e.payload as { outputs?: unknown } | undefined;
      if (p?.outputs && typeof p.outputs === 'object') outputs = p.outputs as Record<string, unknown>;
    }
    if ((e.type === 'run.failed' || e.type === 'node.failed') && error === null) {
      const p = e.payload as { error?: { code?: string; message?: string } } | undefined;
      if (p?.error) {
        error = {
          code: typeof p.error.code === 'string' ? p.error.code : 'internal_error',
          message: typeof p.error.message === 'string' ? p.error.message : 'run failed',
        };
      }
    }
  }
  const status = run?.status;
  if (status === 'completed') {
    return { kind: 'completed', runId, outputs, text: coerceContentText(outputs) };
  }
  if (status === 'failed') {
    return {
      kind: 'failed',
      runId,
      text: error ? `run failed: ${error.code}: ${error.message}` : 'run failed',
    };
  }
  if (status === 'cancelled') return { kind: 'cancelled', runId, text: 'run cancelled' };
  // Suspended. The interrupt is what the current codec turns into MRTR, so read
  // it here rather than making each codec re-derive it.
  const open = await deps.storage.listOpenInterrupts(runId);
  const first = open[0];
  if (first) return { kind: 'awaiting-input', runId, interrupt: first };
  return { kind: 'awaiting-input-opaque', runId };
}

/** RFC 0020 §D resource URI sandbox. Returns true iff the URI parses,
 *  uses an allowlisted scheme, and no decoded path segment contains a
 *  parent-directory marker (`..`) or empty/space segment. Defeats
 *  encoded-traversal attacks: `%2e%2e%2f`, `..%2f`, `%2e%2e/`, etc. */
const ALLOWED_RESOURCE_SCHEMES = new Set(['mcp:', 'openwop-resource:', 'https:']);
function isSafeResourceUri(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (!ALLOWED_RESOURCE_SCHEMES.has(parsed.protocol)) return false;
  // pathname is automatically percent-decoded for the comparison below.
  const segments = decodeURIComponent(parsed.pathname).split('/');
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed === '..' || trimmed === '.') return false;
  }
  return true;
}

export function coerceContentText(outputs: Record<string, unknown> | null): string {
  if (!outputs) return '';
  if (typeof outputs.text === 'string') return outputs.text;
  if (typeof outputs.output === 'string') return outputs.output;
  if (typeof outputs.result === 'string') return outputs.result;
  return JSON.stringify(outputs);
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
