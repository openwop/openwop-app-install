/**
 * The `mcp-2025-06-18-legacy` codec — MCP JSON-RPC method dispatch.
 *
 * Implements the subset of modelcontextprotocol.io 2025-06-18 the sample
 * host advertises in `capabilities.mcp.serverMount.transports`:
 *   - `initialize`, `ping`, `logging/setLevel`
 *   - `tools/list`, `tools/call`
 *   - `resources/list`, `resources/templates/list`, `resources/read`
 *   - `prompts/list`, `prompts/get`
 *   - `completion/complete`  (stub — host returns empty completion array)
 *   - `sampling/createMessage`   (bridges into ctx.callAI via handle-sampling)
 *   - `elicitation/create`        (bridges into ctx.suspend via handle-elicitation)
 *
 * ADR 0553 P2 — THIS FILE IS NOW ONE OF TWO CODECS, not the router. Everything
 * a method MEANS moved to `host/mcpSemantics.ts` (tool authorization, argument
 * validation, the untrusted run, the resource-URI sandbox); what stayed is the
 * legacy WIRE: the `initialize` handshake, the live `sampling/createMessage` and
 * `elicitation/create` callbacks, and result shapes without `resultType` or
 * cache hints. `host/mcpCurrentCodec.ts` is the `mcp-2026-07-28` half.
 *
 * The legacy profile is served UNCHANGED and stays advertised (RFC 0153 §A
 * legacy window — SHOULD NOT advertise after `MCP_LEGACY_PROFILE_SUNSET`).
 * Everything below behaves exactly as it did before the split; a peer cannot
 * tell the extraction happened, which is the point.
 *
 * All inbound traffic crosses an `untrusted` boundary per RFC 0020 §D.
 * `tools/call.arguments` validates against the registered `inputSchema`
 * BEFORE workflow start — see `SECURITY/invariants.yaml`
 * `mcp-server-untrusted-args`. The resource URI sandbox normalizes via
 * `new URL()` + allowlists schemes (`mcp:`, `https:`, `openwop-resource:`)
 * + rejects path components containing `..` after decode, defeating
 * encoded-traversal attacks (`%2e%2e%2f`, `..%2f`, etc.). Both now live in
 * `mcpSemantics.ts` so the current codec cannot drift from them.
 *
 * Downstream trustBoundary propagation (RFC 0020 §D): every MCP-originated
 * run is created with `metadata.trustBoundary: 'untrusted'`. The executor
 * reads that and surfaces it on each node's `ctx.trustBoundary` so pack
 * nodes that forward content to LLM surfaces can apply the
 * `threat-model-prompt-injection.md` UNTRUSTED-marker convention.
 *
 * @see RFCS/0020-host-mcp-server-composition.md §D
 */

import { initializeVersionOutcome,
  MCP_LEGACY_PROFILE,
} from './mcpProfile.js';
import {
  callTool,
  coerceContentText,
  findElicitationHandler,
  findPromptDescription,
  findResourceMimeType,
  findSamplingHandler,
  getPrompt,
  isMcpRefusal,
  promptsView,
  readResource,
  resourcesView,
  resourceTemplatesView,
  runWorkflowById,
  toolsView,
  type McpRunOutcome,
  type McpSemanticDeps,
  type McpToolCallResult,
} from './mcpSemantics.js';
import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from './index.js';
import type { Principal } from '../types.js';
import {
  isErrorResponse,
  rpcError,
  rpcSuccess,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
  RPC_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './mcpJsonRpc.js';
import { createLogger } from '../observability/logger.js';
import { classifyMcpRpcOutcome, recordMcpRequest, recordProtocolVersion } from '../observability/metricSeams.js';
import { _resetToolSchemaCache } from './toolSchemaValidation.js';

const log = createLogger('host.mcpServerRouter');

export interface RouterDeps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
  principal: Principal;
}

export async function dispatch(
  request: JsonRpcRequest,
  deps: RouterDeps,
): Promise<JsonRpcResponse> {
  // ADR 0556 P1 — wrapped, for the same reason as the A2A server: the switch
  // below has a return per method and a catch-all, and a per-branch counter is
  // a counter with a hole in it the day someone adds a method.
  const response = await dispatchMcpRequest(request, deps);
  recordMcpRequest(
    'inbound',
    request.method,
    classifyMcpRpcOutcome(isErrorResponse(response) ? response.error.code : undefined),
  );
  return response;
}

async function dispatchMcpRequest(
  request: JsonRpcRequest,
  deps: RouterDeps,
): Promise<JsonRpcResponse> {
  const id: JsonRpcId = request.id ?? null;
  const params = request.params ?? {};
  const semantics: McpSemanticDeps = deps;
  try {
    switch (request.method) {
      case 'initialize':
        // `params` used to be bound and then dropped on the floor here —
        // `initializeResult()` took no arguments, so the peer's requested
        // version was structurally unreachable. It is read now (ADR 0553 P1).
        return rpcSuccess(id, initializeResult(params.protocolVersion));
      case 'ping':
        return rpcSuccess(id, {});
      case 'logging/setLevel': {
        const level = typeof params.level === 'string' ? params.level : 'info';
        log.info('mcp logging/setLevel', { level });
        return rpcSuccess(id, {});
      }
      case 'tools/list':
        return rpcSuccess(id, { tools: await toolsView(deps.principal) });
      case 'tools/call':
        return projectRunOutcome(id, await callTool(params.name, params.arguments, semantics));
      case 'resources/list':
        return rpcSuccess(id, { resources: resourcesView() });
      case 'resources/templates/list':
        return rpcSuccess(id, { resourceTemplates: resourceTemplatesView() });
      case 'resources/read':
        return await dispatchResourcesRead(id, params, semantics);
      case 'prompts/list':
        return rpcSuccess(id, { prompts: promptsView() });
      case 'prompts/get':
        return await dispatchPromptsGet(id, params, semantics);
      case 'completion/complete':
        return rpcSuccess(id, { completion: { values: [], total: 0, hasMore: false } });
      case 'sampling/createMessage':
        return await dispatchSampling(id, params, semantics);
      case 'elicitation/create':
        return await dispatchElicitation(id, params, semantics);
      default:
        return rpcError(id, RPC_METHOD_NOT_FOUND, `method '${request.method}' not implemented`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('mcp dispatch failed', { method: request.method, error: message });
    return rpcError(id, RPC_INTERNAL_ERROR, message);
  }
}

function initializeResult(requestedVersion?: unknown): Record<string, unknown> {
  // Mirrors the modelcontextprotocol.io initialize/result shape for the version
  // `host/mcpProfile.ts` says this host serves on THIS profile.
  //
  // The reported version is NOT a literal any more (ADR 0553 P1). It was one,
  // in three places that disagreed: this file said one thing while the outbound
  // client probed peers with another. One owner, so they cannot drift again.
  //
  // A mismatch is reported, not enforced. Upstream's legacy-profile rule is that
  // the server answers with a version it supports and the client decides;
  // failing closed here would break standard clients that open with an older
  // version. RFC 0153 §B's fail-closed rule lives in the CURRENT codec, where
  // §B actually applies (`mcpCurrentCodec.ts`; `selectMcpCodec` refuses an
  // explicit unserved revision `-32022`). `initialize` does not exist there at
  // all, so a peer reaching this function is a legacy peer by construction.
  const outcome = initializeVersionOutcome(requestedVersion);
  // ADR 0556 P1 — the negotiation disposition. `absent` means a peer opened
  // without stating a version, which is a different population from one that
  // asked for a version this host does not serve; the mismatch is reported and
  // NOT enforced here, so this counter is the only place the difference shows.
  // `initialize` exists only on the legacy revision (see above), so a peer
  // reaching here is served the legacy profile by construction — which is
  // exactly the population the 2027-08-12 retirement needs counted.
  recordProtocolVersion(
    'mcp',
    requestedVersion === undefined ? 'absent' : outcome.mismatch ? 'mismatch' : 'served',
    outcome.mismatch ? 'none' : MCP_LEGACY_PROFILE,
  );
  if (outcome.mismatch) {
    log.info('mcp_initialize_version_mismatch', { requested: outcome.requested, served: outcome.served });
  }
  return {
    protocolVersion: outcome.served,
    serverInfo: {
      name: 'openwop-workflow-engine',
      version: '0.1.0',
    },
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      prompts: { listChanged: false },
      logging: {},
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// tools/call — workflow as MCP tool
// ─────────────────────────────────────────────────────────────────

/**
 * Pack the semantic outcome as a legacy `CallToolResult` per RFC 0020 §C.
 *
 * A SUSPENDED run has no legacy answer: the 2025-06-18 way to ask the caller
 * for more is the out-of-band `elicitation/create` callback, which is a
 * different method on a different connection. So it surfaces as an `isError`
 * result, exactly as before. The current profile is where a suspended run
 * becomes a first-class `input_required` (§C.2) — that difference is the reason
 * `mcpSemantics` returns an outcome rather than a `CallToolResult`.
 */
function projectRunOutcome(id: JsonRpcId, result: McpToolCallResult): JsonRpcResponse {
  if (isMcpRefusal(result)) {
    if (result.kind === 'invalid-args') {
      return rpcError(id, RPC_INVALID_PARAMS, result.message, { violations: result.violations });
    }
    return rpcError(id, RPC_INVALID_PARAMS, result.message);
  }
  if (result.kind === 'completed') {
    return rpcSuccess(id, { content: [{ type: 'text', text: result.text }], isError: false });
  }
  if (result.kind === 'failed') {
    return rpcSuccess(id, { content: [{ type: 'text', text: result.text }], isError: true });
  }
  // Suspended or canceled — surface as MCP error result per §C.
  const label = result.kind === 'cancelled' ? 'cancelled' : 'awaiting-input';
  return rpcSuccess(id, { content: [{ type: 'text', text: `run ${label}` }], isError: true });
}

// ─────────────────────────────────────────────────────────────────
// resources/read + prompts/get
// ─────────────────────────────────────────────────────────────────

async function dispatchResourcesRead(
  id: JsonRpcId,
  params: Record<string, unknown>,
  deps: McpSemanticDeps,
): Promise<JsonRpcResponse> {
  const outcome = await readResource(params.uri, deps);
  if (isMcpRefusal(outcome)) return rpcError(id, RPC_INVALID_PARAMS, outcome.message);
  if (outcome.kind !== 'completed') {
    return rpcError(id, RPC_INTERNAL_ERROR, `resource read failed: run ${outcome.kind}`);
  }
  const uri = String(params.uri);
  const view: Record<string, unknown> = { uri, text: outcome.text };
  const mimeType = findResourceMimeType(uri);
  if (mimeType !== undefined) view.mimeType = mimeType;
  return rpcSuccess(id, { contents: [view] });
}

async function dispatchPromptsGet(
  id: JsonRpcId,
  params: Record<string, unknown>,
  deps: McpSemanticDeps,
): Promise<JsonRpcResponse> {
  const outcome = await getPrompt(params.name, params.arguments, deps);
  if (isMcpRefusal(outcome)) return rpcError(id, RPC_INVALID_PARAMS, outcome.message);
  if (outcome.kind !== 'completed') {
    return rpcError(id, RPC_INTERNAL_ERROR, `prompt render failed: run ${outcome.kind}`);
  }
  const view: Record<string, unknown> = {
    messages: [{ role: 'user', content: { type: 'text', text: coerceContentText(outcome.outputs) } }],
  };
  const description = findPromptDescription(String(params.name));
  if (description !== undefined) view.description = description;
  return rpcSuccess(id, view);
}

// ─────────────────────────────────────────────────────────────────
// sampling/createMessage — bridge to ctx.callAI via handle-sampling node
// ─────────────────────────────────────────────────────────────────

async function dispatchSampling(
  id: JsonRpcId,
  params: Record<string, unknown>,
  deps: McpSemanticDeps,
): Promise<JsonRpcResponse> {
  const handler = findSamplingHandler();
  if (!handler) {
    return rpcError(
      id,
      RPC_METHOD_NOT_FOUND,
      'sampling/createMessage requires a workflow with core.openwop.mcp.handle-sampling',
    );
  }
  const outcome = await runHandlerWorkflow(deps, handler.workflowId, params);

  if (outcome.kind === 'completed') {
    // The handle-sampling delegate returns outputs.result = ctx.callAI result.
    const outputs = (outcome.outputs ?? {}) as Record<string, unknown>;
    const result = (outputs.result ?? {}) as Record<string, unknown>;
    return rpcSuccess(id, {
      role: 'assistant',
      content: {
        type: 'text',
        text: typeof result.content === 'string' ? result.content : JSON.stringify(result),
      },
      model: typeof result.model === 'string' ? result.model : 'unknown',
      stopReason: typeof result.finishReason === 'string' ? result.finishReason : 'endTurn',
    });
  }
  return rpcError(id, RPC_INTERNAL_ERROR, `sampling bridge failed: ${outcome.kind}`);
}

// ─────────────────────────────────────────────────────────────────
// elicitation/create — bridge to ctx.suspend via handle-elicitation node
// ─────────────────────────────────────────────────────────────────

async function dispatchElicitation(
  id: JsonRpcId,
  params: Record<string, unknown>,
  deps: McpSemanticDeps,
): Promise<JsonRpcResponse> {
  const handler = findElicitationHandler();
  if (!handler) {
    return rpcError(
      id,
      RPC_METHOD_NOT_FOUND,
      'elicitation/create requires a workflow with core.openwop.mcp.handle-elicitation',
    );
  }
  const outcome = await runHandlerWorkflow(deps, handler.workflowId, params);

  if (outcome.kind === 'awaiting-input' || outcome.kind === 'awaiting-input-opaque') {
    // Bridge dispatched and the workflow is waiting. Return a pending
    // response shape — a legacy MCP client resolves the interrupt through the
    // standard interrupt routes. (Under the current profile this same run state
    // is answered inline as MRTR `input_required`, which is the whole point of
    // §C: the current revision has no out-of-band channel to finish on.)
    return rpcSuccess(id, { action: 'pending', content: {} });
  }
  if (outcome.kind === 'completed') {
    // Workflow completed without pausing — e.g., test mode with synthetic
    // accept. Surface outputs as the elicitation response.
    const outputs = (outcome.outputs ?? {}) as Record<string, unknown>;
    return rpcSuccess(id, {
      action: typeof outputs.action === 'string' ? outputs.action : 'accept',
      content: (outputs.content ?? {}) as Record<string, unknown>,
    });
  }
  return rpcError(id, RPC_INTERNAL_ERROR, `elicitation bridge failed: ${outcome.kind}`);
}

/**
 * The two legacy CALLBACK bridges start a handler workflow with the inbound
 * JSON-RPC params as `inputs.request` — a shape neither `tools/call` nor
 * `resources/read` uses, and one that has no current-profile counterpart at all
 * (§C replaced server-initiated requests with MRTR). The RUN itself is the
 * shared semantics (same untrusted boundary, same variable seeding); only this
 * input shape is legacy.
 */
async function runHandlerWorkflow(
  deps: McpSemanticDeps,
  workflowId: string,
  params: Record<string, unknown>,
): Promise<McpRunOutcome> {
  return runWorkflowById(deps, workflowId, { request: params });
}

