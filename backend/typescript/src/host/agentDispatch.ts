/**
 * RFC 0070 — dispatch a pack-declared manifest agent (the runtime floor).
 *
 * Resolves an agent from the AgentRegistry (RFC 0003) and runs ONE deterministic
 * agent turn, honoring the floor contracts:
 *   - system prompt resolved from the manifest (RFC 0003 §C);
 *   - tool surface filtered to the agent's `toolAllowlist` (RFC 0002 §A14);
 *   - inbound task validated against `handoff.taskSchemaRef` and the produced
 *     result against `handoff.returnSchemaRef` (RFC 0003 §D), when the host
 *     advertises `agents.manifestRuntime.handoffValidation`;
 *   - confidence-threshold escalation (RFC 0002 §F): a sub-threshold decision
 *     escalates instead of proceeding;
 *   - attributed `agent.*` events (RFC 0002 §A) carrying the agentId;
 *   - BYOK/SR-1: no credential material is placed in events or the result.
 *
 * Two turn modes share the SAME floor contracts (tool filtering, §D schema
 * validation, §F escalation, SR-1):
 *   - `runAgentDispatch` — the DETERMINISTIC seam (no model call). Replay-safe
 *     and conformance-stable; proves the dispatch CONTRACTS, not model quality.
 *     This stays the default so the conformance harness is unaffected.
 *   - `runAgentDispatchLive` — a REAL model turn via an injected `callAI`
 *     (the host's `ctx.callAI`, managed or BYOK). The agent's `modelClass` is
 *     resolved to a concrete `(provider, model)` (modelClassResolver) and, when
 *     a return schema is declared, the call runs in structured-output mode and
 *     the parsed payload is validated against it.
 *
 * Backs `POST /v1/host/openwop-app/agents/{agentId}/dispatch` (live when the request
 * sets `live: true` and the host wired an AI adapter).
 *
 * @see RFCS/0070-agent-manifest-runtime.md
 */

import Ajv2020 from 'ajv/dist/2020.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../executor/agentRegistry.js';
import { computeArgsHash } from './toolHooks.js';
import { evaluateToolPermission, agentToolPermissionsEnabled, type ToolPermissions } from './agentToolPermissions.js';
import { resolveAgentToolPermissions } from './agentProfileService.js';
import { resolveAgentToolAllowlistOverride } from './agentToolAllowlistService.js';
import { applyToolResultTransform } from './toolResultTransform.js';
import type { CompactionDecision } from '../executor/types.js';
import { neutralizeUntrusted, fenceUntrustedItems, fenceUntrustedBlock } from './untrustedContent.js';
import type {
  AiCallRequest,
  AiCallResult,
  AiCallMessage,
  AiToolCallRequest,
  AiToolCallResult,
  AiCitation,
} from '../executor/types.js';
import { resolveModelForClass, type ResolveModelOptions } from './modelClassResolver.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.agentDispatch');

/** Bound on observe→act rounds in a tool-using turn — mirrors the chat
 *  dispatcher's MAX_TOOL_ROUNDS and the RFC 0058 loop-iteration intent. */
const DEFAULT_MAX_TOOL_ROUNDS = 5;

/** Shared validator instance. `strict:false` matches the host's other Ajv
 *  call sites (mcpServerRouter, envelopeAcceptor); tool `$id`s are stripped
 *  before compile to avoid the long-lived-instance `$id` collision the agent
 *  registry warns about. */
const toolAjv = new Ajv2020({ strict: false, allErrors: true });

export class AgentNotFoundError extends Error {
  constructor(public agentId: string) {
    super(`agent '${agentId}' is not installed on this host`);
    this.name = 'AgentNotFoundError';
  }
}

export interface AgentDispatchRequest {
  /** The manifest agentId to dispatch. */
  agentId: string;
  /** Inbound task payload (validated against handoff.taskSchemaRef). */
  task?: unknown;
  /** Tool surface the host offers this turn; intersected with toolAllowlist. */
  availableTools?: string[];
  /** Per-run confidence threshold override (RFC 0002 §F). */
  confidenceThreshold?: number;
  /** Deterministic hook: the confidence the turn emits (default 0.9). Lets a
   *  caller drive the §F escalation path without a live model. */
  simulateConfidence?: number;
  /** Honor handoff schema validation (mirrors the host's
   *  agents.manifestRuntime.handoffValidation advertisement). Default true. */
  validateHandoff?: boolean;
  /** ADR 0099 — optional tool-output compaction decision. The dispatch route
   *  resolves it from the toggle (this path is runless ⇒ no run.metadata stamp,
   *  no replay surface). Absent ⇒ identity (no compaction). */
  compaction?: CompactionDecision;
}

export interface AgentEvent {
  type: 'agent.reasoned' | 'agent.decided' | 'agent.toolCalled' | 'agent.toolReturned' | 'agent.verified';
  agentId: string;
  [k: string]: unknown;
}

export interface AgentDispatchResult {
  agentId: string;
  persona: string;
  modelClass: string;
  status: 'completed' | 'failed' | 'escalated';
  /** toolAllowlist-filtered surface actually offered to the agent (§A14). */
  toolSurface: string[];
  confidence: number;
  threshold: number;
  events: AgentEvent[];
  result?: unknown;
  error?: { code: string; message: string };
  /** Whether this turn made a real model call (live) or ran the deterministic
   *  seam. Lets callers/telemetry distinguish the two. */
  live?: boolean;
  /** Concrete provider/model the live turn resolved from the agent's modelClass
   *  (absent for the deterministic seam). */
  provider?: string;
  model?: string;
}

/** RFC 0002 §A14 — intersect the host-offered tools with the agent's allowlist.
 *  Absent allowlist ⇒ no tools (the conservative host policy from the schema). */
function filterTools(available: string[], allowlist: string[] | undefined): string[] {
  if (!allowlist) return [];
  const allow = new Set(allowlist);
  return available.filter((t) => allow.has(t));
}

/** Build a minimal value satisfying a (simple) JSON Schema 2020-12 object so the
 *  deterministic turn can produce a return-schema-conformant result. Covers the
 *  common top-level `required` + `type` shape; anything richer falls back to {}. */
function stubFromSchema(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 8) return { ok: true };
  const s = schema as {
    type?: string; required?: string[];
    properties?: Record<string, unknown>; items?: unknown;
  };
  if (s.type && s.type !== 'object') return stubScalar(s.type);
  const out: Record<string, unknown> = {};
  for (const key of s.required ?? []) {
    const propSchema = s.properties?.[key] as { type?: string } | undefined;
    // Recurse into required object properties so nested `required` constraints
    // are satisfied (not just top-level scalars).
    out[key] = propSchema?.type === 'object'
      ? stubFromSchema(propSchema, depth + 1)
      : stubScalar(propSchema?.type);
  }
  return out;
}
function stubScalar(type: string | undefined): unknown {
  switch (type) {
    case 'string': return 'ok';
    case 'number': case 'integer': return 0;
    case 'boolean': return true;
    case 'array': return [];
    case 'object': return {};
    default: return 'ok';
  }
}

/**
 * Dispatch one turn of a manifest agent. Throws AgentNotFoundError when the
 * agentId is not in the registry (caller maps to 404).
 */
export function runAgentDispatch(req: AgentDispatchRequest): AgentDispatchResult {
  const agent = getAgentRegistry().get(req.agentId);
  if (!agent) throw new AgentNotFoundError(req.agentId);

  const validate = req.validateHandoff !== false;
  // ADR 0104 — the super-admin tool-allowlist override is NOT applied on this
  // DETERMINISTIC seam: it is synchronous, carries no tenant, and makes no model
  // call (A2A floor / workforce-eval / RFC-0070 REST), so nothing is offered to a
  // live model here. The override governs the two model-offering paths only
  // (runAgentDispatchLive + the chat tool-loop).
  const toolSurface = filterTools(req.availableTools ?? [], agent.toolAllowlist);
  const confidence = typeof req.simulateConfidence === 'number' ? req.simulateConfidence : 0.9;
  const threshold = typeof req.confidenceThreshold === 'number'
    ? req.confidenceThreshold
    : (agent.confidence?.defaultThreshold ?? 0.7);

  const base = (status: AgentDispatchResult['status'], extra: Partial<AgentDispatchResult>): AgentDispatchResult => ({
    agentId: agent.agentId, persona: agent.persona, modelClass: agent.modelClass,
    status, toolSurface, confidence, threshold, events: [], ...extra,
  });

  // §D inbound task validation (RFC 0003 §D), gated on handoffValidation. Uses
  // the validator pre-compiled at load — no per-dispatch Ajv recompile.
  if (validate && agent.handoff?.validateTask) {
    const r = agent.handoff.validateTask(req.task);
    if (!r.ok) {
      return base('failed', { error: { code: 'task_schema_violation', message: r.errors ?? 'task schema validation failed' } });
    }
  }

  // The deterministic turn: a reasoning event, then a decision. (No model call,
  // no credentials — SR-1 holds by construction.)
  const events: AgentEvent[] = [
    { type: 'agent.reasoned', agentId: agent.agentId, summary: `${agent.persona} evaluated the task against ${toolSurface.length} permitted tool(s).` },
  ];

  // §F confidence escalation — below threshold MUST escalate, not proceed.
  if (confidence < threshold) {
    events.push({ type: 'agent.decided', agentId: agent.agentId, decision: 'escalate', confidence });
    return base('escalated', { events });
  }

  // Produce a deterministic result; when a return schema is declared, make it
  // conform (and validate via the pre-compiled validator, RFC 0003 §D).
  const result = agent.handoff?.returnSchema ? stubFromSchema(agent.handoff.returnSchema) : { ok: true, agentId: agent.agentId };
  if (validate && agent.handoff?.validateReturn) {
    const r = agent.handoff.validateReturn(result);
    if (!r.ok) {
      events.push({ type: 'agent.decided', agentId: agent.agentId, decision: 'final', confidence });
      return base('failed', { events, error: { code: 'return_schema_violation', message: r.errors ?? 'return schema validation failed' } });
    }
  }
  events.push({ type: 'agent.decided', agentId: agent.agentId, decision: 'final', confidence });
  return base('completed', { events, result });
}

// ── Live dispatch (real model turn) ──────────────────────────────────────

/** A bound `ctx.callAI` (from `createAiProvidersAdapter(scope).callAI`). Injected
 *  so this module stays free of the heavy adapter/secrets construction and is
 *  unit-testable with a mock. */
export type CallAi = (req: AiCallRequest) => Promise<AiCallResult>;

/** A resolved tool the agent may call this turn — the callable subset of an
 *  RFC 0078 `ToolDescriptor` (name + description + JSON-Schema inputs). */
export interface AgentToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Resolve an allowlisted tool name to its callable def. Names that don't
 *  resolve are dropped from the offered surface (a host that can't describe a
 *  tool does not offer it to the model). */
export type ResolveAgentTool = (name: string) => AgentToolDef | undefined;

/** Execute one model-requested tool call. Injected so this module stays free
 *  of the host tool-hook / MCP construction and is unit-testable with a mock. */
export type ExecuteAgentTool = (
  call: { name: string; input: Record<string, unknown> },
) => Promise<{ content: string; isError?: boolean }>;

/** Bound `ctx.callAIWithTools` (a single Anthropic tool-calling round). */
export type CallAiWithTools = (req: AiToolCallRequest) => Promise<AiToolCallResult>;

/** A minimal read+write view of the host's cross-run agent memory (RFC 0004
 *  four-op `MemoryAdapter`, host-internal by design per RFC 0080 §B). Injected
 *  so dispatch stays free of the concrete memory surface and is unit-testable.
 *  Reads/writes are tenant-scoped by the caller (CTI-1); SR-1 redaction is the
 *  writer's responsibility. */
/** Memory-entry tag marking a turn summary that was DERIVED FROM UNTRUSTED
 *  knowledge (ADR 0038 §C, review fix): the turn read untrusted KB/memory, so its
 *  result may echo it. Recall FENCES tagged entries (never re-injects them as
 *  trusted), closing the second-order launder via the agent's own output. The
 *  adapter maps this tag onto `read().contentTrust` (recency + RAG metadata). */
export const MEMORY_UNTRUSTED_TAG = 'derived-from-untrusted';

export interface AgentMemoryPort {
  /** Resolve a memory scope to its entries (most-relevant-first). The OPTIONAL
   *  `query` enables embedding-relevance recall (A5/RAG): when supplied, entries
   *  are ranked by semantic similarity to it; when omitted, the scope's recency
   *  order is returned (back-compat — RFC 0080 §B keeps the memory query
   *  host-internal, so widening the read is additive, not a wire change).
   *  `contentTrust:'untrusted'` (from the `MEMORY_UNTRUSTED_TAG` tag) ⇒ the
   *  caller MUST fence the entry, never inject it as agent-trusted. */
  read(scope: string, query?: string): Promise<ReadonlyArray<{ content: string; contentTrust?: 'trusted' | 'untrusted' }>>;
  /** Append a durable entry to the scope. */
  write(scope: string, entry: { content: string; tags?: string[] }): Promise<void>;
}

/** A read-only retrieval over an agent's bound knowledge (ADR 0038). Returns the
 *  task-relevant chunks WITH their source titles so the injected context can be
 *  cited. `kind` distinguishes a cited KB document chunk (`'kb'`) from a private
 *  recalled memory fact (`'memory'`) — so dispatch can skip the memory-kind
 *  chunks when it ALREADY injected the agent's memory via the `memoryShape`
 *  recall path (no double-injection). `contentTrust` (ADR 0038 §C / RFC 0021):
 *  `'untrusted'` chunks (provider/trigger-derived — Drive import, webhook/email
 *  auto-ingest) are FENCED at injection, never presented as agent-trusted;
 *  `'trusted'` (default) is the tenant's own manually-curated content. Composed
 *  in the host route layer. */
export type AgentKnowledgeRetrieve = (
  query: string,
) => Promise<ReadonlyArray<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust?: 'trusted' | 'untrusted' }>>;

export interface LiveDispatchDeps {
  /** The real provider call (managed or BYOK), already scoped to a run/tenant. */
  callAI: CallAi;
  /** Provider/model resolution hints. Defaults to `preferManaged: true` so an
   *  agent can take a real turn with no BYOK setup. */
  modelOptions?: ResolveModelOptions;
  /** BYOK credentialRef to pass through (non-managed turns). */
  credentialRef?: string;
  /** Caller tenant — used to resolve a standing agent's tool `permissions` for
   *  the ADR 0102 per-tool gate. Absent ⇒ the gate stays ungated for this turn. */
  tenantId?: string;
  /** Tool-calling round fn (e.g. `adapter.callAIWithTools`). When present
   *  together with `executeTool` + `resolveTool` AND the agent has a non-empty
   *  resolvable tool surface, the live turn runs a bounded observe→act loop
   *  (RFC 0064) instead of a single completion. Absent ⇒ single-shot. */
  callAIWithTools?: CallAiWithTools;
  /** Resolve allowlisted tool names (§A14-filtered) to callable defs. */
  resolveTool?: ResolveAgentTool;
  /** Execute a tool call the model requested. */
  executeTool?: ExecuteAgentTool;
  /** Max observe→act rounds; bounds runaway loops. Default 5. */
  maxToolRounds?: number;
  /** Cross-run agent memory (RFC 0004). When present together with
   *  `memoryScope` AND the agent declares `memoryShape.longTerm`, the live turn
   *  reads prior memory into its context and writes a turn summary on a
   *  completed turn. Absent ⇒ no memory I/O (today's behavior). */
  memory?: AgentMemoryPort;
  /** Tenant-scoped memory scope (CTI-1) for this agent's `memoryRef`. */
  memoryScope?: string;
  /** Per-agent knowledge retrieval (ADR 0038). When present, the live turn
   *  retrieves from the agent's bound KB collections (cited docs) for the task
   *  text and injects the top chunks — with their source titles — into the
   *  turn's opening context, alongside the memory recall block. Composed by the
   *  HOST ROUTE LAYER from host-owned primitives (`agentProfile.knowledge` + the
   *  `KnowledgeBackend` seam), so core dispatch stays feature-agnostic. Absent ⇒
   *  no knowledge I/O (today's behavior). Best-effort: a failure degrades to no
   *  knowledge block, never fails the turn. */
  knowledgeRetrieve?: AgentKnowledgeRetrieve;
  /** ADR 0044 Phase 2 — BORROWED, second-party content: a granted twin agent
   *  recalling its OWNER's corpus (a different principal). Structurally
   *  always-fenced — dispatch funnels EVERY chunk this returns into the UNTRUSTED
   *  block (neutralized), with NO trusted path, regardless of the chunk's own
   *  `contentTrust`. So borrowed personal memory is cited-as-data, never followed
   *  as instructions, and a future edit cannot accidentally promote it to trusted.
   *  Composed in the host route layer ONLY when the `twin-recall` toggle is on AND
   *  a live `TwinGrant` is active (`twinService.getActiveGrant`). Absent ⇒ no
   *  cross-subject recall (today's behavior). Best-effort. */
  borrowedRetrieve?: AgentKnowledgeRetrieve;
  /** RFC 0090 — an independent critic over the actor's result. When present, the
   *  live turn runs it before completing, emits `agent.verified`, and (when
   *  `verifierGating`) gates: a non-`pass` verdict escalates instead of
   *  completing. Best-effort: a verifier that throws does not block the turn. */
  verifier?: AgentVerifier;
  /** RFC 0090 §B — enforce the verdict as a commit gate. */
  verifierGating?: boolean;
}

/** An independent critic over an actor's result (RFC 0090). Returns a verdict;
 *  the host emits the content-free `agent.verified` event from it. */
export type AgentVerifier = (args: {
  agentId: string;
  target: string;
  result: unknown;
}) => Promise<{ verdict: 'pass' | 'fail' | 'revise'; agentId?: string; criteria?: string[]; confidence?: number }>;

/** RFC 0090 — run the injected verifier over a completed result, emit the
 *  content-free `agent.verified` event, and report whether a gating host must
 *  withhold the commit. Best-effort: a verifier error leaves the turn ungated. */
async function runVerifier(
  agent: ResolvedAgentManifest,
  deps: LiveDispatchDeps,
  events: AgentEvent[],
  result: unknown,
): Promise<{ gated: boolean }> {
  if (!deps.verifier) return { gated: false };
  let verdict: Awaited<ReturnType<AgentVerifier>>;
  try {
    verdict = await deps.verifier({ agentId: agent.agentId, target: agent.agentId, result });
  } catch (err) {
    // Verifier threw — fail open (ungated) but make the failure visible (ENG-4).
    log.warn('agent_verifier_failed', { agentId: agent.agentId, error: err instanceof Error ? err.message : String(err) });
    return { gated: false };
  }
  events.push({
    type: 'agent.verified',
    agentId: verdict.agentId ?? 'core.openwop.verifier',
    target: agent.agentId,
    verdict: verdict.verdict,
    ...(verdict.criteria ? { criteria: verdict.criteria } : {}),
    ...(typeof verdict.confidence === 'number' ? { confidence: verdict.confidence } : {}),
  });
  return { gated: deps.verifierGating === true && verdict.verdict !== 'pass' };
}

/** A resolved tool plus its pre-compiled argument validator. */
export interface CompiledTool {
  def: AgentToolDef;
  validate: (input: Record<string, unknown>) => { ok: boolean; errors?: string };
}

/** Map the §A14-filtered tool surface to compiled, callable tool defs. Tools
 *  the host can't describe (no `resolveTool` hit) are silently dropped. */
function resolveAgentTools(
  toolSurface: readonly string[],
  resolveTool: ResolveAgentTool | undefined,
): CompiledTool[] {
  if (!resolveTool) return [];
  const out: CompiledTool[] = [];
  for (const name of toolSurface) {
    const def = resolveTool(name);
    if (def) out.push({ def, validate: compileToolValidator(def.inputSchema) });
  }
  return out;
}

/** Compile an agent's tools for `runChatToolLoop`: §A14-filter `availableTools`
 *  to the agent's `toolAllowlist`, then resolve+validate each. Exported so the
 *  chat conversation path reuses the SAME §A14 filtering + compilation as
 *  `runAgentDispatchLive` (ADR 0089 — one owner, review finding #5).
 *
 *  `allowlistOverride` (ADR 0104): when the caller has resolved a super-admin
 *  tool-allowlist override for this (tenant, agent), it FULL-REPLACES the manifest
 *  allowlist for what the model is offered. The caller owns the async resolution
 *  (this fn stays sync); absent ⇒ the manifest `toolAllowlist`. */
export function compileAgentTools(
  agent: ResolvedAgentManifest,
  availableTools: readonly string[],
  resolveTool: ResolveAgentTool | undefined,
  allowlistOverride?: readonly string[],
): CompiledTool[] {
  const allow = allowlistOverride ? [...allowlistOverride] : agent.toolAllowlist;
  return resolveAgentTools(filterTools([...availableTools], allow), resolveTool);
}

/** Pre-compile an args validator for a tool's `inputSchema`. A schema that
 *  fails to compile yields a permissive validator (so a malformed descriptor
 *  never hard-fails dispatch) — the real MCP path uses strict Ajv per
 *  `mcp-server-untrusted-args`. */
function compileToolValidator(
  schema: Record<string, unknown>,
): (input: Record<string, unknown>) => { ok: boolean; errors?: string } {
  try {
    const { $id: _drop, ...rest } = schema as Record<string, unknown>;
    const validate = toolAjv.compile(rest);
    return (input) => {
      const ok = validate(input) as boolean;
      return ok ? { ok: true } : { ok: false, errors: toolAjv.errorsText(validate.errors) };
    };
  } catch (err) {
    // Tool-arg schema failed to compile — fail open (accept args) but log it,
    // since silently skipping validation weakens the tool boundary (ENG-4).
    log.warn('agent_tool_schema_compile_failed', { error: err instanceof Error ? err.message : String(err) });
    return () => ({ ok: true });
  }
}

// ── Cross-run agent memory (A4 — RFC 0004 four-op MemoryAdapter, host-internal) ──

/** This turn touches memory iff the agent opts in (`memoryShape.longTerm`) AND
 *  the host wired a memory port + scope. Narrows `deps` so callers get the
 *  port/scope non-optionally. */
function memoryEnabled(
  agent: ResolvedAgentManifest,
  deps: LiveDispatchDeps,
): deps is LiveDispatchDeps & { memory: AgentMemoryPort; memoryScope: string } {
  return Boolean(agent.memoryShape?.longTerm && deps.memory && deps.memoryScope);
}

/** The turn's opening messages: the task, optionally preceded by a read-only
 *  block of prior memory. Memory is host-trusted (it came from this tenant's
 *  own prior runs), so it is NOT wrapped as UNTRUSTED. Reads are best-effort —
 *  a failure degrades to the bare task, never fails the turn. */
async function buildInitialMessages(
  agent: ResolvedAgentManifest,
  req: AgentDispatchRequest,
  deps: LiveDispatchDeps,
): Promise<{ messages: AiCallMessage[]; consumedUntrusted: boolean }> {
  const task = taskToMessage(req.task);

  // Neutralize untrusted content so it cannot forge prompt structure (fake
  // "Task:" / section headers, a spoofed END marker) — collapse whitespace +
  // defang embedded fence markers. Shared with the chat-turn knowledge path so
  // the two boundaries can't drift (ADR 0038 §C).
  const neutralize = neutralizeUntrusted;
  const untrustedItems: string[] = [];

  // Memory recall (A4/A5 — RFC 0004), gated on the agent opting in. Entries carry
  // `contentTrust`; an untrusted-DERIVED summary (a prior turn that consumed
  // untrusted knowledge — MEMORY_UNTRUSTED_TAG) is FENCED here, never recalled as
  // trusted (closes the second-order launder via the agent's own output).
  const memoryRecalled = memoryEnabled(agent, deps);
  let memoryRecall = '';
  if (memoryRecalled) {
    let entries: ReadonlyArray<{ content: string; contentTrust?: 'trusted' | 'untrusted' }> = [];
    try {
      // A5 — pass the task text as the recall query so a RAG-backed port returns
      // the most semantically-relevant prior memory (a recency-only port ignores it).
      entries = await deps.memory.read(deps.memoryScope, task);
    } catch (err) {
      log.warn('agent_memory_read_failed', { error: err instanceof Error ? err.message : String(err) });
      entries = [];
    }
    const trustedMem = entries.filter((e) => e.contentTrust !== 'untrusted');
    if (trustedMem.length > 0) memoryRecall = trustedMem.map((e) => `- ${e.content}`).join('\n');
    for (const e of entries) if (e.contentTrust === 'untrusted') untrustedItems.push(`- ${neutralize(e.content)}`);
  }

  // Per-agent bound-knowledge block (ADR 0038 §C). Trusted KB → the cited block;
  // untrusted KB (Drive import / trigger auto-ingest) → the fenced block, so
  // untrusted external content is never presented as agent-trusted (RFC 0021 —
  // prevents taint-laundering an auto-ingested prompt-injection payload). The
  // `memoryShape` recall above already injected this agent's memory, so memory-kind
  // chunks are DROPPED here (no double-injection).
  let knowledgeBlock = '';
  if (deps.knowledgeRetrieve) {
    let chunks: ReadonlyArray<{ content: string; title?: string; kind: 'kb' | 'memory'; contentTrust?: 'trusted' | 'untrusted' }> = [];
    try {
      chunks = await deps.knowledgeRetrieve(task);
    } catch (err) {
      log.warn('agent_knowledge_retrieve_failed', { error: err instanceof Error ? err.message : String(err) });
      chunks = [];
    }
    const filtered = memoryRecalled ? chunks.filter((c) => c.kind !== 'memory') : chunks;
    const trusted = filtered.filter((c) => c.contentTrust !== 'untrusted');
    if (trusted.length > 0) {
      knowledgeBlock = trusted.map((c) => (c.title ? `- [${c.title}] ${c.content}` : `- ${c.content}`)).join('\n');
    }
    for (const c of filtered) {
      if (c.contentTrust === 'untrusted') {
        untrustedItems.push(c.title ? `- [${neutralize(c.title)}] ${neutralize(c.content)}` : `- ${neutralize(c.content)}`);
      }
    }
  }

  // ADR 0044 §C/Phase 2 — BORROWED content (a twin agent recalling its owner's
  // corpus). Structurally fenced: EVERY chunk goes to the untrusted block, no
  // trusted path exists here (the security invariant is in the code shape, not a
  // marking convention). `kind`/`contentTrust` are ignored — second-party personal
  // data is always cited-as-data. Best-effort.
  if (deps.borrowedRetrieve) {
    let borrowed: ReadonlyArray<{ content: string; title?: string }> = [];
    try {
      borrowed = await deps.borrowedRetrieve(task);
    } catch (err) {
      log.warn('agent_borrowed_retrieve_failed', { error: err instanceof Error ? err.message : String(err) });
      borrowed = [];
    }
    for (const c of borrowed) {
      untrustedItems.push(c.title ? `- [${neutralize(c.title)}] ${neutralize(c.content)}` : `- ${neutralize(c.content)}`);
    }
  }

  const consumedUntrusted = untrustedItems.length > 0;
  if (!memoryRecall && !knowledgeBlock && !consumedUntrusted) {
    return { messages: [{ role: 'user', content: task }], consumedUntrusted: false };
  }
  const sections: string[] = [];
  if (knowledgeBlock) sections.push(`Relevant knowledge for this agent (cite the bracketed source):\n${knowledgeBlock}`);
  if (consumedUntrusted) {
    sections.push(fenceUntrustedItems(untrustedItems));
  }
  if (memoryRecall) sections.push(`Relevant memory from earlier runs:\n${memoryRecall}`);
  sections.push(`Task:\n${task}`);
  return { messages: [{ role: 'user', content: sections.join('\n\n') }], consumedUntrusted };
}

/** Persist a concise summary of a completed turn. Best-effort — a write
 *  failure never changes the turn's outcome. CTI-1 is the caller's scope
 *  responsibility; SR-1 redaction the port's. */
async function persistTurnSummary(
  agent: ResolvedAgentManifest,
  req: AgentDispatchRequest,
  deps: LiveDispatchDeps,
  result: unknown,
  consumedUntrusted: boolean,
): Promise<void> {
  if (!memoryEnabled(agent, deps)) return;
  try {
    // If the turn consumed UNTRUSTED knowledge, its result may echo it — mark the
    // summary derived-from-untrusted so recall FENCES it next run, never recalling
    // it as trusted (ADR 0038 §C review fix — no second-order launder via output).
    const tags = consumedUntrusted ? [agent.agentId, MEMORY_UNTRUSTED_TAG] : [agent.agentId];
    await deps.memory.write(deps.memoryScope, { content: summarizeForMemory(req.task, result), tags });
  } catch (err) {
    // Best-effort memory write — don't fail the turn, but surface it (ENG-4).
    log.warn('agent_memory_write_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

function summarizeForMemory(task: unknown, result: unknown): string {
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  const t = typeof task === 'string' ? task : JSON.stringify(task) ?? '';
  const r = typeof result === 'string' ? result : JSON.stringify(result) ?? '';
  return `Task: ${clip(t, 280)} → Result: ${clip(r, 280)}`;
}


/** Render the inbound task into a single user message. */
function taskToMessage(task: unknown): string {
  if (task === undefined || task === null) return 'Begin the task.';
  if (typeof task === 'string') return task;
  try {
    return JSON.stringify(task, null, 2);
  } catch {
    return String(task);
  }
}

/** Pull a numeric self-confidence from a structured result. Uses the reserved
 *  `_confidence` meta-field, NOT a bare `confidence` — a bare key would collide
 *  with an agent's own domain schema (e.g. a result field literally named
 *  `confidence`) and spuriously drive §F escalation. */
function confidenceFromData(data: unknown): number | undefined {
  if (data && typeof data === 'object' && typeof (data as { _confidence?: unknown })._confidence === 'number') {
    return (data as { _confidence: number })._confidence;
  }
  return undefined;
}

/**
 * Dispatch one LIVE turn of a manifest agent — a real model call via the
 * injected `callAI`, wrapped in the same floor contracts as the deterministic
 * seam: tool-allowlist filtering (§A14), §D task/return schema validation,
 * §F confidence escalation, and SR-1 (no credential material in the result).
 *
 * The agent's `modelClass` is resolved to a concrete `(provider, model)` here
 * (modelClassResolver). When the agent declares a return schema, the call runs
 * in structured-output mode and the parsed payload is validated against it.
 *
 * Throws AgentNotFoundError when the agentId is not installed (caller → 404).
 * Provider failures are returned as `status: 'failed'` with the provider's
 * error code — they are not thrown.
 */
export async function runAgentDispatchLive(
  req: AgentDispatchRequest,
  deps: LiveDispatchDeps,
): Promise<AgentDispatchResult> {
  const agent = getAgentRegistry().get(req.agentId);
  if (!agent) throw new AgentNotFoundError(req.agentId);

  const validate = req.validateHandoff !== false;
  // ADR 0104 — apply the super-admin tool-allowlist override (per tenant+agent) to
  // what THIS host offers the model. Resolved live (like the ADR 0102 permission
  // gate); recorded runs replay recorded output, so past runs are unaffected. No
  // `host:` restriction — pack agents (e.g. the Chief of Staff) are covered. Absent
  // override ⇒ the manifest allowlist.
  const overrideAllow = deps.tenantId ? await resolveAgentToolAllowlistOverride(deps.tenantId, agent.agentId) : undefined;
  const toolSurface = filterTools(req.availableTools ?? [], overrideAllow ?? agent.toolAllowlist);
  const threshold = typeof req.confidenceThreshold === 'number'
    ? req.confidenceThreshold
    : (agent.confidence?.defaultThreshold ?? 0.7);

  const base = (status: AgentDispatchResult['status'], extra: Partial<AgentDispatchResult>): AgentDispatchResult => ({
    agentId: agent.agentId, persona: agent.persona, modelClass: agent.modelClass,
    status, toolSurface, confidence: 1, threshold, events: [], live: true, ...extra,
  });

  // §D inbound task validation.
  if (validate && agent.handoff?.validateTask) {
    const r = agent.handoff.validateTask(req.task);
    if (!r.ok) {
      return base('failed', { error: { code: 'task_schema_violation', message: r.errors ?? 'task schema validation failed' } });
    }
  }

  // Resolve modelClass → concrete (provider, model). Default to the managed tier
  // so no BYOK is required for an out-of-the-box live turn.
  const resolved = resolveModelForClass(agent.modelClass, deps.modelOptions ?? { preferManaged: true });
  if (!resolved) {
    return base('failed', { error: { code: 'no_model_available', message: `no provider/model resolves for modelClass '${agent.modelClass}'` } });
  }
  const credentialRef = resolved.managed ? `managed:${resolved.provider}` : (deps.credentialRef ?? resolved.provider);

  // RFC 0002 §A14 + RFC 0064 — when the agent has a non-empty resolvable tool
  // surface AND the host wired the tool-calling deps, take a tool-using turn:
  // a bounded observe→act loop that actually offers the §A14-filtered tools to
  // the model and executes what it calls. Without these deps we fall through to
  // the single completion below (no regression for hosts that don't wire tools).
  const compiledTools = resolveAgentTools(toolSurface, deps.resolveTool);
  if (compiledTools.length > 0 && deps.callAIWithTools && deps.executeTool) {
    return runToolLoop(agent, req, deps, {
      provider: resolved.provider,
      model: resolved.model,
      credentialRef,
      threshold,
      toolSurface,
      tools: compiledTools,
    });
  }

  const initial = await buildInitialMessages(agent, req, deps);
  const request: AiCallRequest = {
    provider: resolved.provider,
    model: resolved.model,
    systemPrompt: agent.systemPrompt,
    messages: initial.messages,
    credentialRef,
    ...(agent.handoff?.returnSchema ? { responseSchema: agent.handoff.returnSchema as Record<string, unknown> } : {}),
  };

  let out: AiCallResult;
  try {
    out = await deps.callAI(request);
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'provider_error';
    return base('failed', {
      provider: resolved.provider, model: resolved.model,
      error: { code, message: err instanceof Error ? err.message : String(err) },
    });
  }

  const result = agent.handoff?.returnSchema ? out.data : { content: out.content ?? '' };
  // §F confidence escalation — only when the model's structured output declares
  // a numeric confidence (we never fabricate one for a live turn).
  const confidence = confidenceFromData(out.data) ?? (typeof req.simulateConfidence === 'number' ? req.simulateConfidence : 1);
  const events: AgentEvent[] = [
    { type: 'agent.reasoned', agentId: agent.agentId, summary: `${agent.persona} ran a ${resolved.provider}/${resolved.model} turn over ${toolSurface.length} permitted tool(s).` },
  ];
  if (confidence < threshold) {
    events.push({ type: 'agent.decided', agentId: agent.agentId, decision: 'escalate', confidence });
    return base('escalated', { provider: resolved.provider, model: resolved.model, confidence, events });
  }

  // §D return-schema validation against the real model output.
  if (validate && agent.handoff?.returnSchema && agent.handoff.validateReturn) {
    const r = agent.handoff.validateReturn(result);
    if (!r.ok) {
      events.push({ type: 'agent.decided', agentId: agent.agentId, decision: 'final', confidence });
      return base('failed', {
        provider: resolved.provider, model: resolved.model, confidence, events,
        error: { code: 'return_schema_violation', message: r.errors ?? 'return schema validation failed' },
      });
    }
  }
  // RFC 0090 — independent verifier before commit; a gating fail escalates.
  const verdict = await runVerifier(agent, deps, events, result);
  if (verdict.gated) {
    events.push({ type: 'agent.decided', agentId: agent.agentId, decision: 'escalate', confidence });
    return base('escalated', { provider: resolved.provider, model: resolved.model, confidence, events });
  }
  events.push({ type: 'agent.decided', agentId: agent.agentId, decision: 'final', confidence });
  await persistTurnSummary(agent, req, deps, result, initial.consumedUntrusted);
  return base('completed', { provider: resolved.provider, model: resolved.model, confidence, events, result });
}

interface ToolLoopCtx {
  provider: string;
  model: string;
  credentialRef: string;
  threshold: number;
  toolSurface: string[];
  tools: CompiledTool[];
}

/** Inputs to the shared observe→act core (`runChatToolLoop`). */
export interface ChatToolLoopOpts {
  provider: string;
  model: string;
  credentialRef: string;
  /** System prompt (agent persona scaffold) — passed to the model each round. */
  systemPrompt: string;
  /** Prior turns (conversation history or task messages). Copied internally. */
  messages: AiCallMessage[];
  /** §A14-filtered, compiled tools the model may call this turn. */
  tools: CompiledTool[];
  agentId: string;
  persona: string;
  maxRounds?: number;
  /** Enable the provider's NATIVE web search/grounding each round, using the
   *  provider key — when the run's provider advertises it (ADR 0101). */
  webSearch?: boolean;
  compaction?: CompactionDecision;
  /** ADR 0102 — the agent's profile tool `permissions` (read/write/never). When
   *  present AND the `OPENWOP_AGENT_TOOL_PERMISSIONS_ENABLED` flag is on, a tool
   *  call off the agent's allowlist is refused before it executes. Absent ⇒ no
   *  per-tool gate (the manifest §A14 allowlist + ADR 0036 still apply). */
  toolPermissions?: ToolPermissions;
  /** ADR 0132 — the per-conversation capability scope (RESOLVED effective set) for
   *  this turn. A NARROWING that ANDs *after* the ADR 0102 gate (never widens): the
   *  model is offered only `enabled` tools, and a call whose name is not in
   *  `enabled` is refused (`agent.toolReturned{status:'forbidden'}`) before it
   *  executes — covering a forced/hallucinated call to a disabled-but-permitted
   *  tool. Typed inline so this loop owner imports no feature (the
   *  `host/` boundary). `requireApproval` is honored in Phase 3 (per-call approval
   *  interrupt); in Phase 2 it is carried but does not yet suspend. Absent ⇒ no
   *  per-conversation narrowing (the unchanged path). */
  capabilityScope?: { enabled: string[]; requireApproval: string[] };
  /** ADR 0135 — the Capability Firewall callback (injected so this loop owner imports no
   *  feature). Evaluated per tool call AFTER the §A14/ADR 0132/ADR 0102 gates, over the
   *  within-turn set of tools already run vs the tool about to run. `deny` → forbidden;
   *  `require-approval` → the same per-tool deferral as the ADR 0132 approval. Absent ⇒
   *  no firewall (the unchanged path). */
  firewall?: { evaluate: (seenToolNames: readonly string[], nextToolName: string) => { decision: 'allow' | 'deny' | 'require-approval'; reason?: string } };
  /** Best-effort per-event sink so a host can stream live tool progress
   *  (`agent.reasoned` / `agent.toolCalled` / `agent.toolReturned`). A throw is
   *  swallowed — observability must never break the turn. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

/** ADR 0132 Phase 3 — a tool call the agent attempted that is gated behind
 *  per-conversation approval. The loop does NOT execute it (the in-process loop
 *  cannot suspend mid-iteration); it records the request so the conversation can
 *  surface an `interrupt.approval` card. On approve the tool executes on the
 *  agent's re-attempt (the loop folds the recorded decision); on deny it is
 *  forbidden. Carries no secret material (args are model-authored). */
export interface PendingToolApproval {
  toolName: string;
  callId: string;
  input: Record<string, unknown>;
}

/** Result of the shared loop. `error` set ⇒ a provider call failed mid-loop. */
export interface ChatToolLoopResult {
  finalText: string;
  finalData: unknown;
  events: AgentEvent[];
  rounds: number;
  error?: { code: string; message: string };
  /** ADR 0132 Phase 3 — tool calls deferred for per-conversation approval (not
   *  executed). Empty/absent ⇒ none. */
  pendingApprovals?: PendingToolApproval[];
}

/**
 * The SINGLE owner of the agent tool-calling loop (RFC 0002 §A14 + RFC 0064).
 * Operates over pre-built `messages` so BOTH the agent-dispatch path
 * (`runToolLoop`, which adds its §F/§D/verifier tail) and the chat conversation
 * (`host/conversationToolLoop`, which streams the final turn) reuse it — no
 * second tool executor, no forked enforcement (ADR 0089 §4, review finding #1/#5).
 *
 * Each round offers the §A14-filtered tools to the model; per tool call it:
 *   - refuses a call outside the allowlist (`agent.toolReturned{status:'forbidden'}`);
 *   - validates args against the tool's `inputSchema` BEFORE executing
 *     (`status:'invalid_args'` — the untrusted-args posture on native transport);
 *   - otherwise emits `agent.toolCalled` → executes via `executeTool` → emits
 *     `agent.toolReturned{status, durationMs}` (RFC 0064), then compacts the
 *     result (ADR 0099) before it re-enters the model context.
 * The loop ends when the model stops calling tools or `maxRounds` is hit.
 */
export async function runChatToolLoop(
  opts: ChatToolLoopOpts,
  deps: {
    callAIWithTools: NonNullable<LiveDispatchDeps['callAIWithTools']>;
    executeTool: NonNullable<LiveDispatchDeps['executeTool']>;
  },
): Promise<ChatToolLoopResult> {
  const { provider, model, credentialRef, systemPrompt, tools, agentId, persona } = opts;
  const maxRounds = typeof opts.maxRounds === 'number' && opts.maxRounds > 0 ? Math.floor(opts.maxRounds) : DEFAULT_MAX_TOOL_ROUNDS;
  const messages: AiCallMessage[] = [...opts.messages];
  // ADR 0132 — a per-conversation capability scope offers the model only the
  // `enabled` tools (the agent's full compiled `tools` stays available for the
  // execution-time lookup + the defensive in-loop scope check below). A `null`
  // set ⇒ the unchanged full surface.
  const scopeEnabled = opts.capabilityScope ? new Set(opts.capabilityScope.enabled) : null;
  const offeredTools = scopeEnabled ? tools.filter((t) => scopeEnabled.has(t.def.name)) : tools;
  const toolDefs = offeredTools.map((t) => t.def);
  // ADR 0132 Phase 3 — tools enabled but gated behind per-conversation approval.
  // A call to one is NOT executed; it is collected as a pending approval (the
  // in-process loop cannot suspend mid-iteration) and the model is told it is
  // pending so the turn completes. The conversation surfaces an interrupt.approval
  // card; on approve the agent re-attempts and the loop executes it (the fold
  // happens upstream, in conversationToolLoop).
  const requireApprovalSet = opts.capabilityScope ? new Set(opts.capabilityScope.requireApproval) : null;
  const pendingApprovals: PendingToolApproval[] = [];
  // ADR 0135 — the within-turn set of tool names already run, fed to the firewall to
  // detect risky COMBINATIONS (read-then-egress). Accumulated across this turn's rounds.
  const firewallSeen: string[] = [];
  const events: AgentEvent[] = [];
  const emit = async (e: AgentEvent): Promise<void> => {
    events.push(e);
    if (opts.onEvent) { try { await opts.onEvent(e); } catch { /* best-effort observability */ } }
  };
  await emit({ type: 'agent.reasoned', agentId, summary: `${persona} ran a ${provider}/${model} tool-using turn over ${tools.length} permitted tool(s).` });

  let lastText = '';
  let lastData: unknown;
  let rounds = 0;
  // Native web-search/grounding sources accumulated across rounds, deduped by
  // URL, appended as a Sources footer (ADR 0101 Phase 2).
  const citationsByUrl = new Map<string, AiCitation>();
  for (let round = 0; round < maxRounds; round += 1) {
    rounds = round + 1;
    let out: AiToolCallResult;
    try {
      out = await deps.callAIWithTools({ provider, model, systemPrompt, messages: [...messages], credentialRef, tools: toolDefs, ...(opts.webSearch ? { webSearch: true } : {}) });
    } catch (err) {
      return {
        finalText: lastText, finalData: lastData, events, rounds,
        error: { code: (err as { code?: string })?.code ?? 'provider_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
    if (typeof out.content === 'string' && out.content) lastText = out.content;
    if (out.data !== undefined) lastData = out.data;
    for (const c of out.citations ?? []) { if (c.url && !citationsByUrl.has(c.url)) citationsByUrl.set(c.url, c); }
    const calls = out.toolCalls ?? [];
    if (calls.length === 0) break; // model produced a final answer
    if (out.content) messages.push({ role: 'assistant', content: out.content });
    for (const call of calls) {
      const compiled = tools.find((t) => t.def.name === call.name);
      // §A14 — a call to a tool not on the allowlist is refused, never executed.
      if (!compiled) {
        await emit({ type: 'agent.toolReturned', agentId, toolName: call.name, callId: call.id, status: 'forbidden' });
        messages.push({ role: 'user', content: `Tool "${call.name}" is not permitted for this agent.` });
        continue;
      }
      // ADR 0132 — per-conversation capability scope (the fourth AND-term). A call
      // to a tool NOT in this conversation's effective `enabled` set is refused
      // before it executes — even if the agent's permissions (ADR 0102) would
      // allow it. The model is only offered `enabled` tools above, so this is the
      // defensive boundary for a forced/hallucinated call to a disabled-but-
      // permitted tool. NARROWING only: the scope is intersected with the ceiling
      // at resolution time, so it can never grant beyond the agent's permissions.
      // The forbidden verdict is recorded (RFC 0064) so replay reuses it verbatim.
      if (scopeEnabled && !scopeEnabled.has(call.name)) {
        await emit({ type: 'agent.toolReturned', agentId, toolName: call.name, callId: call.id, status: 'forbidden' });
        messages.push({ role: 'user', content: `Tool "${call.name}" is not enabled for this conversation.` });
        continue;
      }
      // ADR 0132 Phase 3 — per-conversation approval gate. The tool is enabled but
      // requires a human approval first: do NOT execute it. Collect it as a pending
      // approval (deduped by name — one card per tool this turn) and tell the model
      // it was requested, not performed, so the turn completes gracefully. The
      // conversation surfaces an interrupt.approval card; on approve the agent
      // re-attempts and the loop (with the decision folded out of requireApproval
      // upstream) executes it. NARROWING only — approval never grants beyond the
      // ceiling. Recorded as agent.toolReturned{forbidden} is wrong here (it is not
      // forbidden, it is deferred), so it carries a distinct message + the pending
      // list; the requested/resolved decision is recorded by the conversation.
      if (requireApprovalSet && requireApprovalSet.has(call.name)) {
        if (!pendingApprovals.some((p) => p.toolName === call.name)) {
          pendingApprovals.push({ toolName: call.name, callId: call.id, input: call.input });
        }
        await emit({ type: 'agent.toolReturned', agentId, toolName: call.name, callId: call.id, status: 'forbidden' });
        messages.push({ role: 'user', content: `Tool "${call.name}" requires human approval for this conversation. The action was requested for review, not performed. Do not retry it; explain that it is awaiting approval.` });
        continue;
      }
      // ADR 0102 — per-tool read/write permission gate (host-local guardrail).
      // Fail-closed for an agent that opted into a tool allowlist; ungated
      // otherwise. Runs in SHADOW mode by default: whenever the agent carries
      // `permissions`, the verdict is always computed + logged (so ops can
      // validate real tool names against the seeded allowlists with the gate
      // OFF), but a denied call is only BLOCKED when the env flag is on. The
      // verdict is recorded in `agent.toolReturned{forbidden}` so a replay reuses
      // it deterministically (no re-resolution).
      if (opts.toolPermissions) {
        const perm = evaluateToolPermission(call.name, opts.toolPermissions);
        if (!perm.allowed) {
          const enforcing = agentToolPermissionsEnabled();
          log.info('agent_tool_permission_denied', { agentId, toolName: call.name, reason: perm.reason, enforced: enforcing });
          if (enforcing) {
            await emit({ type: 'agent.toolReturned', agentId, toolName: call.name, callId: call.id, status: 'forbidden' });
            messages.push({ role: 'user', content: `Tool "${call.name}" is blocked by ${persona}'s guardrails (${perm.reason}).` });
            continue;
          }
        }
      }
      // ADR 0135 — Capability Firewall: the LAST gate (most context). Evaluate the
      // COMBINATION of capability classes this turn has exercised vs the tool about to
      // run. `deny` → forbidden; `require-approval` → the same per-tool deferral as the
      // ADR 0132 approval (collected as a pending approval, recorded upstream). Runs
      // after the per-tool gates; narrows only.
      if (opts.firewall) {
        const fw = opts.firewall.evaluate(firewallSeen, call.name);
        if (fw.decision === 'deny') {
          // CGOV-6: operator-alertable audit on a firewall denial (mirrors the
          // ADR 0102 perm gate's `agent_tool_permission_denied`). No secret material
          // (tool name + reason only); the verdict is also recorded as a run event.
          log.info('capability_firewall_blocked', { agentId, toolName: call.name, decision: 'deny', reason: fw.reason });
          await emit({ type: 'agent.toolReturned', agentId, toolName: call.name, callId: call.id, status: 'forbidden' });
          messages.push({ role: 'user', content: `Tool "${call.name}" is blocked by the capability firewall: ${fw.reason ?? 'risky combination'}.` });
          continue;
        }
        if (fw.decision === 'require-approval') {
          log.info('capability_firewall_blocked', { agentId, toolName: call.name, decision: 'require-approval', reason: fw.reason });
          if (!pendingApprovals.some((p) => p.toolName === call.name)) {
            pendingApprovals.push({ toolName: call.name, callId: call.id, input: call.input });
          }
          await emit({ type: 'agent.toolReturned', agentId, toolName: call.name, callId: call.id, status: 'forbidden' });
          messages.push({ role: 'user', content: `Tool "${call.name}" requires approval (capability firewall: ${fw.reason ?? 'risky combination'}). Requested for review, not performed; do not retry — explain it is awaiting approval.` });
          continue;
        }
      }
      const v = compiled.validate(call.input);
      if (!v.ok) {
        await emit({ type: 'agent.toolReturned', agentId, toolName: call.name, callId: call.id, status: 'invalid_args' });
        messages.push({ role: 'user', content: `Tool "${call.name}" arguments failed validation: ${v.errors ?? 'invalid'}.` });
        continue;
      }
      firewallSeen.push(call.name); // ADR 0135 — this tool's classes now count toward later combinations this turn
      await emit({ type: 'agent.toolCalled', agentId, toolName: call.name, callId: call.id, argsHash: computeArgsHash(call.input), transport: 'native' });
      const startedAt = Date.now();
      let execOut: { content: string; isError?: boolean };
      try {
        execOut = await deps.executeTool({ name: call.name, input: call.input });
      } catch (err) {
        execOut = { content: `tool_execution_failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      await emit({ type: 'agent.toolReturned', agentId, toolName: call.name, callId: call.id, status: execOut.isError ? 'error' : 'ok', durationMs: Date.now() - startedAt });
      const compactedContent = applyToolResultTransform(execOut.content, { decision: opts.compaction, toolName: call.name });
      // RFC 0021 prompt-injection boundary: a tool result is untrusted, model-
      // and (for web-search/HTTP tools) attacker-influenceable content. Fence it
      // as data-only before it re-enters the context so embedded instructions
      // ("ignore previous…", a spoofed task) can't hijack the agent loop — the
      // same posture KB/memory get (`fenceUntrustedItems` above), structure
      // preserved so JSON/multi-result bodies stay parseable. Compact THEN fence,
      // so the fence wraps exactly what the model sees.
      messages.push({ role: 'user', content: `Result of ${call.name}: ${fenceUntrustedBlock(compactedContent, `tool ${call.name}`)}` });
    }
  }
  // WSRCH-3 — observability for provider-native web search: when a turn ASKED for
  // web search, emit a structured line an operator can alert on (did search fire,
  // how many sources came back, was it grounded). `grounded:false` with
  // `webSearchRequested:true` is the "answered confidently without researching"
  // signal this ADR 0101 work set out to make visible.
  if (opts.webSearch) {
    log.info('web_search_grounding', {
      agentId, provider, model, rounds,
      webSearchRequested: true,
      citationCount: citationsByUrl.size,
      grounded: citationsByUrl.size > 0,
    });
  }
  return {
    finalText: appendSourcesFooter(lastText, [...citationsByUrl.values()]),
    finalData: lastData, events, rounds,
    ...(pendingApprovals.length ? { pendingApprovals } : {}),
  };
}

/** Append a compact markdown Sources list for native web-search/grounding
 *  citations (ADR 0101 Phase 2). No-op when there are none, or when the model's
 *  own text already linked them. Shared by the tool loop AND the single-
 *  completion conversation reply, so plain grounded chat surfaces sources too.
 *  The param is a minimal structural type so both the executor `AiCitation` and
 *  the provider `Citation` satisfy it without cross-layer coupling. */
export function appendSourcesFooter(text: string, citations: ReadonlyArray<{ url: string; title?: string }>): string {
  if (citations.length === 0) return text;
  const fresh = citations.filter((c) => !text.includes(c.url));
  if (fresh.length === 0) return text;
  const list = fresh.map((c) => `- [${c.title ?? c.url}](${c.url})`).join('\n');
  return text ? `${text}\n\n**Sources**\n${list}` : `**Sources**\n${list}`;
}

/**
 * A bounded observe→act loop for a tool-using agent turn. Each round offers the
 * §A14-filtered tools to the model; for every tool the model calls the host:
 *   - refuses a call outside the allowlist (`agent.toolReturned{status:'forbidden'}`);
 *   - validates args against the tool's `inputSchema` BEFORE executing
 *     (`status:'invalid_args'` on failure — the `mcp-server-untrusted-args`
 *     posture applied to the native transport);
 *   - otherwise emits `agent.toolCalled` (argsHash, transport) → executes via the
 *     injected `executeTool` → emits `agent.toolReturned{status, durationMs}` (RFC 0064).
 * The loop ends when the model stops calling tools or `maxToolRounds` is hit;
 * then it applies §F confidence escalation + §D return-schema validation exactly
 * like the single-shot path.
 */
async function runToolLoop(
  agent: ResolvedAgentManifest,
  req: AgentDispatchRequest,
  deps: LiveDispatchDeps,
  ctx: ToolLoopCtx,
): Promise<AgentDispatchResult> {
  const { provider, model, credentialRef, threshold, toolSurface, tools } = ctx;
  const validate = req.validateHandoff !== false;
  const initial = await buildInitialMessages(agent, req, deps);

  // ADR 0102 — resolve the standing agent's tool permissions (undefined for a
  // pack/manifest agent or when no tenant is supplied ⇒ the gate stays ungated).
  const toolPermissions = deps.tenantId
    ? await resolveAgentToolPermissions(deps.tenantId, agent.agentId)
    : undefined;

  // Delegate the observe→act loop to the SHARED core (runChatToolLoop) — the one
  // owner of §A14 per-call enforcement + RFC 0064 tool-event emission. This path
  // keeps the agent-specific TAIL below (§F confidence, §D return-schema, RFC 0090
  // verifier, persistTurnSummary) that the chat path does not need.
  const loop = await runChatToolLoop(
    {
      provider, model, credentialRef,
      systemPrompt: agent.systemPrompt,
      messages: initial.messages,
      tools,
      agentId: agent.agentId,
      persona: agent.persona,
      ...(typeof deps.maxToolRounds === 'number' ? { maxRounds: deps.maxToolRounds } : {}),
      ...(req.compaction ? { compaction: req.compaction } : {}),
      ...(toolPermissions ? { toolPermissions } : {}),
    },
    { callAIWithTools: deps.callAIWithTools!, executeTool: deps.executeTool! },
  );
  const events = loop.events;

  const finish = (status: AgentDispatchResult['status'], extra: Partial<AgentDispatchResult>): AgentDispatchResult => ({
    agentId: agent.agentId,
    persona: agent.persona,
    modelClass: agent.modelClass,
    status,
    toolSurface,
    confidence: 1,
    threshold,
    events,
    live: true,
    provider,
    model,
    ...extra,
  });

  if (loop.error) {
    return finish('failed', { error: loop.error });
  }

  const lastData = loop.finalData;
  const result = agent.handoff?.returnSchema ? lastData : { content: loop.finalText };
  const confidence = confidenceFromData(lastData) ?? (typeof req.simulateConfidence === 'number' ? req.simulateConfidence : 1);

  // §F confidence escalation.
  if (confidence < threshold) {
    events.push({ type: 'agent.decided', agentId: agent.agentId, decision: 'escalate', confidence });
    return finish('escalated', { confidence });
  }
  // §D return-schema validation against the real model output.
  if (validate && agent.handoff?.returnSchema && agent.handoff.validateReturn) {
    const r = agent.handoff.validateReturn(result);
    if (!r.ok) {
      events.push({ type: 'agent.decided', agentId: agent.agentId, decision: 'final', confidence });
      return finish('failed', { confidence, error: { code: 'return_schema_violation', message: r.errors ?? 'return schema validation failed' } });
    }
  }
  // RFC 0090 — independent verifier before commit; a gating fail escalates.
  const verdict = await runVerifier(agent, deps, events, result);
  if (verdict.gated) {
    events.push({ type: 'agent.decided', agentId: agent.agentId, decision: 'escalate', confidence });
    return finish('escalated', { confidence });
  }
  events.push({ type: 'agent.decided', agentId: agent.agentId, decision: 'final', confidence });
  await persistTurnSummary(agent, req, deps, result, initial.consumedUntrusted);
  return finish('completed', { confidence, result });
}

/** Read-only inventory of installed manifest agents (registry-backed). */
export function listManifestAgents(): ResolvedAgentManifest[] {
  return [...getAgentRegistry().list()];
}
