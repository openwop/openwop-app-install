/**
 * ADR 0553 P2 — the `mcp-2026-07-28` codec (host as MCP server).
 *
 * The current revision is not a newer dialect of 2025-06-18; it is a different
 * protocol over the same JSON-RPC envelope, and this file is the whole of the
 * difference on the inbound side:
 *
 *   - **Stateless.** No `initialize`, no `notifications/initialized`, no
 *     `Mcp-Session-Id`. `initialize` here is `-32601`, LOUDLY — a host that
 *     quietly answered it would let a client believe it had a session.
 *   - **Self-describing.** `params._meta` MUST carry
 *     `io.modelcontextprotocol/protocolVersion` and `clientCapabilities`; the
 *     three headers MUST agree with the body, and disagreement is `-32020` at
 *     HTTP 400 (fail closed — the whole point of the header is that a proxy or
 *     a confused client cannot make the two halves mean different things).
 *   - **`server/discover`** replaces the handshake and MUST report
 *     `supportedVersions[]` equal to `capabilities.mcp.protocolVersions`: the
 *     OpenWOP discovery document and the MCP discovery answer are two views of
 *     one fact. Both derive from `MCP_SUPPORTED_VERSIONS`, so they cannot
 *     disagree.
 *   - **`resultType` on every result**, and `CacheableResult` (`ttlMs` +
 *     `cacheScope`) on every list/read.
 *   - **MRTR instead of callbacks.** A run that reaches `waiting-input` /
 *     `waiting-approval` answers the IN-FLIGHT `tools/call` with
 *     `input_required` + a bound `requestState`; the legacy live
 *     `elicitation/create` / `sampling/createMessage` callbacks are
 *     legacy-profile-only and there is NO silent fallback to them.
 *
 * WHAT THIS FILE IS NOT. It is not a second registry and not a second
 * authorization path: every meaning comes from `host/mcpSemantics.ts`, which
 * both codecs share. What lives here is the wire.
 *
 * EXTENSIONS ARE OPAQUE (§D). This codec reads exactly the `_meta` keys named
 * in `mcpProfile.ts` and ignores every other one — it neither refuses an
 * unknown extension nor grants it anything. `capabilities.extensions` on a
 * request is read for nothing at all. That is why `features[]` does NOT claim
 * `extensions`: honouring none is the position, and claiming to honour them
 * would be the lie.
 *
 * @see spec/v1/mcp-integration.md §"MCP 2026-07-28 versioned composition"
 */

import {
  MCP_CURRENT_VERSION,
  MCP_ERR_HEADER_MISMATCH,
  MCP_ERR_MISSING_CLIENT_CAPABILITY,
  MCP_METHOD_HEADER,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_LOG_LEVEL,
  MCP_META_PROTOCOL_VERSION,
  MCP_META_SERVER_INFO,
  MCP_NAME_HEADER,
  MCP_SUPPORTED_VERSIONS,
  MCP_CURRENT_PROFILE,
} from './mcpProfile.js';
import {
  callTool,
  coerceContentText,
  findPromptDescription,
  findResourceMimeType,
  getPrompt,
  isMcpRefusal,
  promptsView,
  readResource,
  resourcesView,
  resourceTemplatesView,
  resumeInterrupt,
  toolsView,
  type McpRunOutcome,
  type McpSemanticDeps,
  type McpToolCallResult,
} from './mcpSemantics.js';
import { mcpRequestDigest, mintMcpRequestState, verifyMcpRequestState } from './mcpRequestState.js';
import { classifyMcpRpcOutcome, recordMcpRequest, recordProtocolVersion } from '../observability/metricSeams.js';
import {
  isErrorResponse,
  rpcError,
  rpcSuccess,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './mcpJsonRpc.js';
import type { InterruptRecord } from '../types.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.mcpCurrentCodec');

/** Cache hints (§D). Lists are short-lived; discovery is stable. */
const LIST_TTL_MS = 60_000;
const DISCOVER_TTL_MS = 3_600_000;

/**
 * §D — `cacheScope` follows the TENANT BOUNDARY, not a guess about volatility.
 * Every list this host serves is derived from `listToolsForPrincipal` and the
 * caller's tenant, so `private` is the only honest value; `public` is permitted
 * only when the result is byte-identical for every caller, which for a
 * multi-tenant host's tool list is never.
 */
const PRIVATE: 'private' = 'private';
/** `server/discover` describes the INTERFACE, not the caller's slice of it —
 *  byte-identical for every caller, so `public` is honest here and only here. */
const PUBLIC: 'public' = 'public';

const SERVER_INFO = { name: 'openwop-workflow-engine', version: '0.1.0' } as const;

/** An HTTP-status-carrying response: §B pins `400` on the refusals and `404` on
 *  unknown method, which a JSON-RPC-only return value cannot express. */
export interface McpCodecResponse {
  status: number;
  body: JsonRpcResponse;
}

export interface CurrentCodecInput {
  request: JsonRpcRequest;
  /** Inbound headers, lower-cased (Express normalises them already). */
  headers: Record<string, string | string[] | undefined>;
  deps: McpSemanticDeps;
}

/**
 * ADR 0556 P1 — metered at the wrapper, for the same reason the legacy router
 * is: the switch below has a return per method plus refusal paths, and a
 * per-branch counter is a counter with a hole in it the day someone adds a
 * method. `protocol.version` is recorded here too — under this revision the
 * disposition is decided per REQUEST (there is no handshake to record it at).
 */
export async function dispatchCurrent(input: CurrentCodecInput): Promise<McpCodecResponse> {
  recordProtocolVersion('mcp', 'served', MCP_CURRENT_PROFILE);
  const response = await dispatchCurrentRequest(input);
  recordMcpRequest(
    'inbound',
    input.request.method,
    classifyMcpRpcOutcome(isErrorResponse(response.body) ? response.body.error.code : undefined),
  );
  return response;
}

async function dispatchCurrentRequest(input: CurrentCodecInput): Promise<McpCodecResponse> {
  const { request, headers, deps } = input;
  const id: JsonRpcId = request.id ?? null;
  const params = request.params ?? {};
  const meta = asObject(params._meta);

  // ── Header/body agreement (§B). Checked BEFORE anything is dispatched, so a
  //    disagreeing request never reaches a registry lookup or a run. ──
  const bodyVersion = meta[MCP_META_PROTOCOL_VERSION];
  if (request.method !== 'server/discover' && bodyVersion === undefined) {
    // `server/discover` is the one method a client may issue before it knows
    // which revision to declare (upstream's discovery escape hatch).
    return refuse(id, MCP_ERR_HEADER_MISMATCH, `_meta.${MCP_META_PROTOCOL_VERSION} is REQUIRED on every request under this revision`);
  }
  if (bodyVersion !== undefined && bodyVersion !== MCP_CURRENT_VERSION) {
    // AGREEMENT BEFORE SELECTION (`mcp-integration.md` §B, clarified upstream in
    // openwop#1027 / suite 1.121.0).
    //
    // This host originally answered SUPPORT-FIRST: a body naming an unserved
    // revision got `-32022` even when it also disagreed with the header, on the
    // reasoning that the peer needs `data.supported[]` to pick another. The
    // corpus settled the opposite order, and it is the better one — when the
    // two halves of one request disagree, the host does not yet know what the
    // peer was ASKING for, so answering "I do not support X" asserts a reading
    // of a request that has no single reading. Disagreement is refused first,
    // and only a request whose halves AGREE is tested for support (the header
    // arm of that lives in `selectMcpCodec`, before this codec is reached).
    return refuse(
      id,
      MCP_ERR_HEADER_MISMATCH,
      `MCP-Protocol-Version header (${MCP_CURRENT_VERSION}) does not match _meta protocolVersion (${String(bodyVersion)})`,
    );
  }
  const methodHeader = single(headers[MCP_METHOD_HEADER]);
  if (methodHeader !== undefined && methodHeader !== request.method) {
    return refuse(id, MCP_ERR_HEADER_MISMATCH, `${MCP_METHOD_HEADER} (${methodHeader}) does not match method (${request.method})`);
  }
  const nameMismatch = checkNameHeader(request.method, params, single(headers[MCP_NAME_HEADER]));
  if (nameMismatch) return refuse(id, MCP_ERR_HEADER_MISMATCH, nameMismatch);

  // §D named mapping: `logLevel` is honoured per request and is the ONLY gate on
  // `notifications/message`. This host emits none, so honouring it is recording
  // that the client asked — not silently dropping the key as if it were unknown.
  const logLevel = meta[MCP_META_LOG_LEVEL];
  if (typeof logLevel === 'string') log.debug('mcp_current_log_level_requested', { level: logLevel, method: request.method });

  try {
    switch (request.method) {
      case 'server/discover':
        return ok(id, {
          resultType: 'complete',
          // TWO DOCUMENTS, ONE FACT (§B). Both this and `capabilities.mcp.
          // protocolVersions` in routes/discovery.ts read MCP_SUPPORTED_VERSIONS.
          supportedVersions: [...MCP_SUPPORTED_VERSIONS],
          capabilities: { tools: {}, resources: {}, prompts: {} },
          instructions:
            'OpenWOP workflow engine as an MCP server. Tools, resources and prompts are workflows exposed via core.openwop.mcp.expose-*; every call runs under an untrusted trust boundary.',
          ttlMs: DISCOVER_TTL_MS,
          cacheScope: PUBLIC,
        });

      case 'tools/list':
        return ok(id, {
          resultType: 'complete',
          tools: await toolsView(deps.principal),
          ttlMs: LIST_TTL_MS,
          cacheScope: PRIVATE,
        });

      case 'resources/list':
        return ok(id, { resultType: 'complete', resources: resourcesView(), ttlMs: LIST_TTL_MS, cacheScope: PRIVATE });

      case 'resources/templates/list':
        return ok(id, {
          resultType: 'complete',
          resourceTemplates: resourceTemplatesView(),
          ttlMs: LIST_TTL_MS,
          cacheScope: PRIVATE,
        });

      case 'prompts/list':
        return ok(id, { resultType: 'complete', prompts: promptsView(), ttlMs: LIST_TTL_MS, cacheScope: PRIVATE });

      case 'tools/call':
        return await dispatchToolsCall(id, params, deps, asObject(meta[MCP_META_CLIENT_CAPABILITIES]));

      case 'resources/read':
        return await dispatchResourcesRead(id, params, deps);

      case 'prompts/get':
        return await dispatchPromptsGet(id, params, deps);

      // Removed by this revision. Loud, never silently tolerated: a client that
      // got a `{}` back from `ping` would conclude the session lifecycle exists.
      case 'initialize':
        return notFound(id, `${request.method} does not exist under this revision — every request self-describes in _meta`);
      case 'ping':
      case 'logging/setLevel':
      case 'resources/subscribe':
      case 'resources/unsubscribe':
      case 'completion/complete':
        return notFound(id, `${request.method} was removed in this revision`);
      // §C: the legacy live callbacks are legacy-profile ONLY, and there is no
      // silent fallback to them. A current-profile peer asking for one is asking
      // this host to be a 2025-06-18 server on a 2026-07-28 wire.
      case 'sampling/createMessage':
      case 'elicitation/create':
        return notFound(
          id,
          `${request.method} is a server-initiated request replaced by MRTR in this revision (legacy profile only)`,
        );

      default:
        return notFound(id, `method '${request.method}' not implemented`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('mcp current dispatch failed', { method: request.method, error: message });
    return { status: 200, body: rpcError(id, RPC_INTERNAL_ERROR, message) };
  }
}

// ─────────────────────────────────────────────────────────────────
// tools/call + MRTR (§C.2)
// ─────────────────────────────────────────────────────────────────

/** Rounds this host will answer with `input_required` for ONE invocation before
 *  refusing. §C.1's bound is host policy; the same ceiling is applied on the
 *  server side so a client that keeps retrying a gate it never resolves cannot
 *  hold a run open indefinitely. */
const MAX_SERVER_MRTR_ROUNDS = 8;

async function dispatchToolsCall(
  id: JsonRpcId,
  params: Record<string, unknown>,
  deps: McpSemanticDeps,
  clientCapabilities: Record<string, unknown>,
): Promise<McpCodecResponse> {
  const digest = mcpRequestDigest('tools/call', params.name, params.arguments ?? {});
  const echoed = params.requestState;
  const responses = asObject(params.inputResponses);

  if (echoed !== undefined || Object.keys(responses).length > 0) {
    // ── The MRTR retry (§C.2). ──
    const verdict = verifyMcpRequestState(echoed, { principalId: deps.principal.principalId, requestDigest: digest });
    if (!verdict.ok) {
      // Uniform on the wire: a peer probing which binding it violated learns
      // nothing. The class is in the log (`mcp_request_state_rejected`).
      return { status: 200, body: rpcError(id, RPC_INVALID_PARAMS, 'requestState failed verification') };
    }
    const interrupt = await deps.storage.getInterrupt(verdict.interruptId);
    if (!interrupt || interrupt.resolvedAt) {
      return { status: 200, body: rpcError(id, RPC_INVALID_PARAMS, 'requestState failed verification') };
    }
    const key = interruptRequestKey(interrupt);
    const elicit = responses[key] ?? responses[Object.keys(responses)[0] ?? ''];
    const resume = resumeValueFromElicitResult(interrupt, elicit);
    if (!resume.ok) return { status: 200, body: rpcError(id, RPC_INVALID_PARAMS, resume.message) };
    const outcome = await resumeInterrupt(deps, interrupt.interruptId, resume.value);
    return projectToolOutcome(id, outcome, { digest, rounds: roundOf(params) + 1, principalId: deps.principal.principalId, clientCapabilities });
  }

  // `clientCapabilities` is READ, not merely accepted: §C forbids emitting an
  // `elicitation/create` in `inputRequests` to a client that did not declare
  // the capability (upstream `-32021`). This host's only `inputRequests` entry
  // IS an elicitation, so the declaration gates the whole MRTR answer.
  const result = await callTool(params.name, params.arguments, deps);
  // RFC 0199 §D.2(b): a `credential` interrupt is answered in URL mode or with
  // `isError` — NEVER the `-32021` refusal below, which would tell a client with no
  // elicitation capability to retry with one it would then use for a form.
  if (result.kind === 'awaiting-input' && result.interrupt.kind !== 'credential' && clientCapabilities.elicitation === undefined) {
    return {
      status: 400,
      body: rpcError(id, MCP_ERR_MISSING_CLIENT_CAPABILITY, 'this tool needs input and the request did not declare the elicitation client capability', {
        requiredCapabilities: ['elicitation'],
      }),
    };
  }
  return projectToolOutcome(id, result, { digest, rounds: 0, principalId: deps.principal.principalId, clientCapabilities });
}

function projectToolOutcome(
  id: JsonRpcId,
  result: McpToolCallResult,
  ctx: { digest: string; rounds: number; principalId: string; clientCapabilities: Record<string, unknown> },
): McpCodecResponse {
  if (isMcpRefusal(result)) {
    if (result.kind === 'invalid-args') {
      return {
        status: 200,
        body: rpcError(id, RPC_INVALID_PARAMS, result.message, { violations: result.violations }),
      };
    }
    return { status: 200, body: rpcError(id, RPC_INVALID_PARAMS, result.message) };
  }
  if (result.kind === 'awaiting-input') {
    if (ctx.rounds >= MAX_SERVER_MRTR_ROUNDS) {
      return {
        status: 200,
        body: rpcSuccess(id, cacheless({
          resultType: 'complete',
          content: [{ type: 'text', text: 'run exceeded the host MRTR round bound' }],
          isError: true,
        })),
      };
    }
    const plan = elicitationPlan(result.interrupt, ctx.clientCapabilities);
    if (plan.mode === 'refuse') {
      // The run stays suspended and resolvable through the REST and token surfaces;
      // this call just cannot carry the ask. No form fallback (§D.2(b)).
      return { status: 200, body: rpcSuccess(id, cacheless({ resultType: 'complete', content: [{ type: 'text', text: plan.text }], isError: true })) };
    }
    return { status: 200, body: rpcSuccess(id, inputRequiredResult(result, ctx.digest, ctx.principalId, plan)) };
  }
  if (result.kind === 'awaiting-input-opaque') {
    return { status: 200, body: rpcError(id, RPC_INTERNAL_ERROR, 'run suspended without a readable interrupt') };
  }
  return { status: 200, body: rpcSuccess(id, callToolResult(result)) };
}

/** §C.2 — the in-flight request is answered with the ask itself. */
function inputRequiredResult(
  outcome: Extract<McpRunOutcome, { kind: 'awaiting-input' }>,
  requestDigest: string,
  principalId: string,
  plan: Exclude<ElicitationPlan, { mode: 'refuse' }>,
): Record<string, unknown> {
  const { interrupt } = outcome;
  const key = interruptRequestKey(interrupt);
  return cacheless({
    resultType: 'input_required',
    inputRequests: {
      [key]: {
        method: 'elicitation/create',
        params: plan.mode === 'url'
          ? { mode: 'url', message: plan.message, url: plan.url }
          : { mode: 'form', message: plan.message, requestedSchema: plan.requestedSchema },
      },
    },
    requestState: mintMcpRequestState({
      principalId,
      runId: interrupt.runId,
      interruptId: interrupt.interruptId,
      interruptToken: interrupt.token,
      requestDigest,
    }),
  });
}

export type ElicitationPlan =
  | { mode: 'form'; message: string; requestedSchema: Record<string, unknown> }
  | { mode: 'url'; message: string; url: string }
  | { mode: 'refuse'; text: string };

/**
 * RFC 0199 §D.2 — how (and whether) an open interrupt may be put to this MCP client.
 * Binds every host with an MCP mount (RFC §C6), advertiser or not:
 *  - a `credential` interrupt goes out in URL mode (`url` = its `connectUrl`) iff
 *    THIS request declared `elicitation.url`; otherwise `isError`. Never form mode;
 *  - any other interrupt goes out in form mode only when its schema is one MCP
 *    allows (a flat object of primitive properties) and asks for nothing secret
 *    (no `writeOnly: true`, no `format: "password"`); otherwise `isError`.
 */
export function elicitationPlan(interrupt: InterruptRecord, clientCapabilities: Record<string, unknown>): ElicitationPlan {
  const data = asObject(interrupt.data);
  if (interrupt.kind === 'credential') {
    const provider = pickString(data.provider) ?? 'the provider';
    const url = pickString(data.connectUrl);
    const urlDeclared = asObject(clientCapabilities.elicitation).url !== undefined;
    if (urlDeclared && url && /^https:\/\//.test(url)) {
      return { mode: 'url', message: `Authorize ${provider}`, url };
    }
    return { mode: 'refuse', text: `Authorization with ${provider} is required and must be completed out of band; this client did not declare URL-mode elicitation. The run stays suspended.` };
  }
  const requestedSchema = requestedSchemaFor(interrupt);
  if (!isFormSafeSchema(requestedSchema)) {
    return { mode: 'refuse', text: 'This run needs input that cannot be requested through an MCP form (a nested schema, or a sensitive field). The run stays suspended; resolve it through the host.' };
  }
  return {
    mode: 'form',
    message: pickString(data.prompt, data.message, data.question) ?? 'Additional input is required to continue.',
    requestedSchema,
  };
}

const FORM_PRIMITIVES = new Set(['string', 'number', 'integer', 'boolean']);

/** MCP Elicitation §Requested Schema: a flat object whose properties are
 *  primitives (an enum of strings included; a multi-select is an array of string
 *  enum items), and — §D.2(d) / invariant `elicitation-form-no-secret` — none of
 *  them `writeOnly` or `format: "password"`. */
export function isFormSafeSchema(schema: Record<string, unknown>): boolean {
  if (schema.type !== undefined && schema.type !== 'object') return false;
  if (schema.writeOnly === true) return false;
  const props = asObject(schema.properties);
  for (const raw of Object.values(props)) {
    const prop = asObject(raw);
    if (prop.writeOnly === true || prop.format === 'password') return false;
    const type = prop.type;
    if (typeof type === 'string' && FORM_PRIMITIVES.has(type)) continue;
    if (type === undefined && Array.isArray(prop.enum)) continue;
    if (type === 'array') {
      const items = asObject(prop.items);
      const enumItems = Array.isArray(items.enum) ? items.enum : Array.isArray(items.anyOf) ? items.anyOf : null;
      if ((items.type === 'string' || items.type === undefined) && enumItems && items.format !== 'password' && items.writeOnly !== true) continue;
    }
    return false;
  }
  return true;
}

/** The MRTR key. The interrupt's NODE id: stable across the round trip, and
 *  meaningful to an operator reading a log, unlike a random one. */
function interruptRequestKey(interrupt: InterruptRecord): string {
  return interrupt.nodeId;
}

function requestedSchemaFor(interrupt: InterruptRecord): Record<string, unknown> {
  const data = asObject(interrupt.data);
  const declared = asObject(data.formSchema ?? data.answerSchema ?? interrupt.resumeSchema);
  if (Object.keys(declared).length > 0) return declared;
  const actions = Array.isArray(data.actions) ? data.actions.filter((a): a is string => typeof a === 'string') : [];
  if (actions.length > 0) {
    // An approval gate's "schema" is its action enum. Projected rather than
    // omitted so the peer can render a real choice instead of a free-text box.
    return { type: 'object', properties: { action: { type: 'string', enum: actions } }, required: ['action'] };
  }
  return { type: 'object', properties: {} };
}

/**
 * §C.2 — `ElicitResult` → the OpenWOP interrupt resume payload.
 *
 * FAIL-CLOSED ON APPROVALS, and this is the sharp edge §E names: "an
 * `inputResponses` entry that resolves an approval interrupt is honoured only
 * as the authenticated caller's action bound by the interrupt token". An
 * `accept` on an approval gate is NOT translated into whatever the gate happens
 * to call approval — the caller must name an action the gate declares, or the
 * retry is refused. Defaulting here would be exactly "MCP content advancing a
 * gate".
 */
function resumeValueFromElicitResult(
  interrupt: InterruptRecord,
  raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const elicit = asObject(raw);
  const action = elicit.action;
  if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
    return { ok: false, message: 'inputResponses entry MUST be an ElicitResult with action accept|decline|cancel' };
  }
  const content = asObject(elicit.content);
  const data = asObject(interrupt.data);
  const declared = Array.isArray(data.actions) ? data.actions.filter((a): a is string => typeof a === 'string') : [];
  if (declared.length === 0) {
    // A clarification / refinement interrupt: the delegate contract is
    // `{action, payload}` (packs/core.openwop.mcp handle-elicitation).
    return { ok: true, value: { action, payload: content } };
  }
  const named = typeof content.action === 'string' ? content.action : undefined;
  if (named !== undefined && declared.includes(named)) return { ok: true, value: { ...content, action: named } };
  if (action !== 'accept') {
    const negative = declared.find((a) => a === 'reject' || a === 'decline' || a === 'cancel' || a === 'deny');
    if (negative) return { ok: true, value: { ...content, action: negative } };
  }
  return {
    ok: false,
    message: `this gate requires content.action to be one of: ${declared.join(', ')}`,
  };
}

function callToolResult(outcome: Exclude<McpRunOutcome, { kind: 'awaiting-input' } | { kind: 'awaiting-input-opaque' }>): Record<string, unknown> {
  if (outcome.kind === 'completed') {
    return cacheless({ resultType: 'complete', content: [{ type: 'text', text: outcome.text }], isError: false });
  }
  return cacheless({ resultType: 'complete', content: [{ type: 'text', text: outcome.text }], isError: true });
}

// ─────────────────────────────────────────────────────────────────
// resources/read + prompts/get
// ─────────────────────────────────────────────────────────────────

async function dispatchResourcesRead(
  id: JsonRpcId,
  params: Record<string, unknown>,
  deps: McpSemanticDeps,
): Promise<McpCodecResponse> {
  const outcome = await readResource(params.uri, deps);
  if (isMcpRefusal(outcome)) return { status: 200, body: rpcError(id, RPC_INVALID_PARAMS, outcome.message) };
  if (outcome.kind !== 'completed') {
    return { status: 200, body: rpcError(id, RPC_INTERNAL_ERROR, `resource read failed: run ${outcome.kind}`) };
  }
  const uri = String(params.uri);
  const view: Record<string, unknown> = { uri, text: outcome.text };
  const mimeType = findResourceMimeType(uri);
  if (mimeType !== undefined) view.mimeType = mimeType;
  return ok(id, { resultType: 'complete', contents: [view], ttlMs: LIST_TTL_MS, cacheScope: PRIVATE });
}

async function dispatchPromptsGet(
  id: JsonRpcId,
  params: Record<string, unknown>,
  deps: McpSemanticDeps,
): Promise<McpCodecResponse> {
  const outcome = await getPrompt(params.name, params.arguments, deps);
  if (isMcpRefusal(outcome)) return { status: 200, body: rpcError(id, RPC_INVALID_PARAMS, outcome.message) };
  if (outcome.kind !== 'completed') {
    return { status: 200, body: rpcError(id, RPC_INTERNAL_ERROR, `prompt render failed: run ${outcome.kind}`) };
  }
  const view: Record<string, unknown> = {
    resultType: 'complete',
    messages: [{ role: 'user', content: { type: 'text', text: coerceContentText(outcome.outputs) } }],
    ttlMs: LIST_TTL_MS,
    cacheScope: PRIVATE,
  };
  const description = findPromptDescription(String(params.name));
  if (description !== undefined) view.description = description;
  return ok(id, view);
}

// ─────────────────────────────────────────────────────────────────
// Envelope helpers
// ─────────────────────────────────────────────────────────────────

function ok(id: JsonRpcId, result: Record<string, unknown>): McpCodecResponse {
  return { status: 200, body: rpcSuccess(id, withServerInfo(result)) };
}

/** §B: results SHOULD carry `_meta.serverInfo`. */
function withServerInfo(result: Record<string, unknown>): Record<string, unknown> {
  const existing = asObject(result._meta);
  return { ...result, _meta: { [MCP_META_SERVER_INFO]: SERVER_INFO, ...existing } };
}

/** §C.1/§D — an interim MRTR result and any request carrying `inputResponses` /
 *  `requestState` MUST NOT be cached. `CallToolResult` is not a `CacheableResult`
 *  either, so the absence of `ttlMs`/`cacheScope` here is the contract, not an
 *  omission — named so nobody "fixes" it by adding them. */
function cacheless(result: Record<string, unknown>): Record<string, unknown> {
  return withServerInfo(result);
}

function refuse(id: JsonRpcId, code: number, message: string): McpCodecResponse {
  return { status: 400, body: rpcError(id, code, message) };
}

function notFound(id: JsonRpcId, message: string): McpCodecResponse {
  return { status: 404, body: rpcError(id, RPC_METHOD_NOT_FOUND, message) };
}

/**
 * `Mcp-Name` MUST equal `params.name` (or `params.uri`). Upstream permits a
 * Base64 sentinel encoding when the value is not plain ASCII, so a header that
 * is not byte-equal to a NON-ASCII name is accepted rather than refused — the
 * alternative is refusing every conforming client with a non-ASCII tool name.
 * An ASCII name must match exactly.
 */
function checkNameHeader(method: string, params: Record<string, unknown>, header: string | undefined): string | null {
  if (header === undefined) return null;
  const expected = method === 'resources/read' ? params.uri : method === 'tools/call' || method === 'prompts/get' ? params.name : undefined;
  if (typeof expected !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const plainAscii = /^[\x20-\x7e]*$/.test(expected);
  if (!plainAscii) return null;
  return header === expected ? null : `${MCP_NAME_HEADER} (${header}) does not match the request's name/uri (${expected})`;
}

function roundOf(params: Record<string, unknown>): number {
  // A retry is round >= 1 by definition; the host does not trust a peer-supplied
  // counter, so the bound below is per-retry-chain rather than per-run.
  return Object.keys(asObject(params.inputResponses)).length > 0 ? 1 : 0;
}

function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

function single(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
