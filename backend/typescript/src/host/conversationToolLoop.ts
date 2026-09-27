/**
 * Chat-driven agent tool turn (ADR 0089 Phase 1).
 *
 * When an @mentioned agent in a conversation has a resolvable tool surface, the
 * conversation runs the agent's observe→act loop instead of a single bare
 * completion — so the agent ACTUALLY retrieves/acts rather than only narrating
 * (the "dead end at Retrieving evidence" root cause). It REUSES the one owner of
 * the loop (`runChatToolLoop`) + the SAME tool compilation (`compileAgentTools`,
 * §A14) + the SAME provider adapter (`createAiProvidersAdapter`, which enforces
 * provider policy) + the SAME tool executor (`createAgentToolProvider`) that the
 * agent-dispatch route uses — no second tool path (review finding #1/#5).
 *
 * Two transports: the MANAGED (free) tier routes through
 * `dispatchManagedToolsRound` (the same daily caps + server key + underlying-
 * provider hiding as `dispatchManagedChat`, but a single MiniMax tool round);
 * BYOK routes through the policy-enforcing provider adapter. The loop is fed the
 * USER-FACING credential id as provider/model, so the underlying managed
 * provider never reaches an event.
 *
 * Falls back (returns `null`) — the caller then takes the existing single
 * completion — when: the BYOK provider is not tool-calling-capable, the agent
 * has no resolvable tools, or the BYOK key is unavailable (the single-completion
 * path surfaces the canonical `credential_unavailable`). So enabling this NEVER
 * regresses a non-tool agent.
 *
 * Gate coverage (ADR 0089 §2 / review finding #1): this path enforces the
 * SECURITY-critical gates — §A14 tool-allowlist (inside `runChatToolLoop`) and
 * provider policy (inside the adapter's `callAIWithTools`) — and tenant scoping
 * (the conversation already checks `agent.ownerTenant`; the adapter + tool
 * provider are tenant-bound). It does NOT replicate the agent-dispatch route's
 * RFC 0092 capability-REQUIREMENT degrade (an agent declaring a capability the
 * host doesn't advertise). That is a quality/honesty edge — not a safety gate —
 * and is not reached by a tool-only agent. The modality gate is a no-op here
 * (conversation turns are text). If a capability-requiring agent becomes
 * chat-driven, factor the route's capability check into a shared gate and call
 * it here (tracked follow-up).
 */

import { createAiProvidersAdapter, providerSupportsToolCalling, AiProviderError } from '../aiProviders/aiProvidersHost.js';
import { createScopedAgentToolProvider, builtinAgentToolIds } from './agentToolProvider.js';
import { createTurnRunDispatchCollector, type TurnRunDispatch } from './turnRunDispatch.js';
import { compileAgentTools, runChatToolLoop, type AgentEvent } from './agentDispatch.js';
import { resolveAgentToolPermissions } from './agentProfileService.js';
import { resolveAgentIdentity } from './agentIdentity.js';
import { effectiveToolAllowlist, resolveAgentToolAllowlistOverride } from './agentToolAllowlistService.js';
import { isManagedCredentialRef, managedProviderIdFromRef, dispatchManagedToolsRound } from '../providers/managedProvider.js';
import { compactToolSchema } from '../providers/toolSchemaCompaction.js';
import { resolveConversationModelTarget, type ConversationModelTierInput } from '../features/model-router/applyRoute.js';
import { contextEconomy } from './contextEconomy.js';
import { resolveSecret } from '../byok/secretResolver.js';
import { getConversationMeta, type ConversationCapabilityScope } from './conversationStore.js';
import { createLogger } from '../observability/logger.js';
import { resolveCapabilityScope, isNarrowing, applyApprovalDecisions, intersectScopes } from '../features/conversation-tools/scopeResolver.js';
import { ledgerToScope, computeIntentLedgerStamp, readIntentLedgerStamp } from '../features/intent-ledger/ledgerProjection.js';
import { getLedger, saveLedger } from '../features/intent-ledger/ledgerStore.js';
import { computeCapabilityScopeStamp } from '../features/conversation-tools/capabilityScopeStamp.js';
import { listToolApprovals, recordToolApprovalRequested } from '../features/conversation-tools/approvalLedger.js';
import { buildFirewallHook, computeFirewallStamp, SENSITIVE_APPROVAL_TOOLS, type FirewallHook } from '../features/capability-firewall/firewallHook.js';
import { getCapabilityRules, getUnknownToolPolicy, getFirewallMode, getDefaultDenyVerdict, getPlatformRules } from '../features/capability-firewall/ruleStore.js';
import { recordGovernanceDecision } from './governanceDecisionLog.js';
import type { ResolvedAgentManifest } from '../executor/agentRegistry.js';
import { readCompactionDecision } from '../executor/compaction.js';
import type { AiCallMessage, AiToolCallRequest, AiToolCallResult } from '../executor/types.js';
import type { ChatMessage } from '../providers/dispatch.js';
import type { ProviderPolicyResolver } from './index.js';
import type { RunRecord } from '../types.js';
import type { Storage } from '../storage/storage.js';
import { resolveWebSearchPreference } from './webSearchPreference.js';

const log = createLogger('host.conversationToolLoop');

/** Map a loop message to the managed dispatch's ChatMessage shape (text — the
 *  conversation tool path is text; non-text parts degrade to empty). */
function toChatMessage(m: AiCallMessage): ChatMessage {
  return { role: m.role, content: typeof m.content === 'string' ? m.content : '' };
}

export interface AgentToolTurnResult {
  /** The agent's final answer after the tool loop settled. */
  text: string;
  /** The loop's `agent.*` events (reasoned / toolCalled / toolReturned). */
  events: AgentEvent[];
  /** A provider/loop error, when the loop failed mid-flight. */
  error?: { code: string; message: string };
  /** ADR 0132 Phase 3 — tool calls the agent deferred for per-conversation approval
   *  (recorded in the ledger; surfaced as interrupt.approval cards). Absent ⇒ none. */
  pendingApprovals?: { toolName: string; callId: string; input: Record<string, unknown> }[];
  /** Workflow runs this turn's tools ignited (`host/turnRunDispatch.ts`). The
   *  EXCHANGE materializes one `workflow_run` turn per entry — it owns turnIndex
   *  allocation and the response, so the bubble lands at a correct index and
   *  reaches the client without a reload. Empty ⇒ no run was dispatched. */
  runDispatches?: TurnRunDispatch[];
}

export interface AgentToolTurnParams {
  run: RunRecord;
  agent: ResolvedAgentManifest;
  /** The composed persona scaffold (the system prompt). */
  systemPrompt: string;
  /** Prior conversation turns (NOT including the system message). */
  history: AiCallMessage[];
  runId: string;
  nodeId: string;
  policyResolver: ProviderPolicyResolver;
  /** ADR 0132 — the conversation this turn belongs to (keys the capability-scope
   *  config on `ConversationMeta`). */
  conversationId: string;
  /** ADR 0132 — storage handle for the best-effort capability-scope provenance
   *  stamp (`run.metadata.capabilityScope`). Optional: absent ⇒ enforce live, skip
   *  the stamp (enforcement never depends on it). */
  storage?: Storage;
  /** Best-effort per-event sink so the caller can stream live tool progress. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  /** Per-exchange native web-search override (ADR 0101). Beats the run-input
   *  open-time default; honored on the BYOK path only. */
  webSearch?: boolean;
  /** Per-exchange permission mode (ADR 0150). `safe` (default) gates the high-blast-radius
   *  tools (`SENSITIVE_APPROVAL_TOOLS`) behind the firewall's `interrupt.approval` card;
   *  `bypass` downgrades any `require-approval` to allow (the user pre-authorized this turn).
   *  A hard `deny`, RBAC, budgets, and sandbox isolation still bind in either mode. */
  permissionMode?: 'safe' | 'bypass';
  /** ADR 0124 Phase 3 / CS-GB-1 — the per-exchange model switch, now honored on
   *  tool-loop turns exactly as on the single-completion path. */
  modelOverride?: { provider?: string; model?: string };
  /** CS-GB-1 — conversation type + answering agent's modelClass for the
   *  same-provider class-tier default (group reasoning rooms). */
  tier?: ConversationModelTierInput;
}

/**
 * SYNCHRONOUS pre-check: will a tool turn engage for this (run, agent)? True iff
 * the agent declares tools AND the run's credential is a tool-calling-capable
 * BYOK provider (NOT the managed tier — its underlying provider has no native
 * tool-calling round here). Lets the conversation decide BEFORE dispatch whether
 * to take the async-settle path (a multi-round loop must not block the HTTP turn)
 * — without forcing async for agents that will fall back to a single completion.
 * Mirrors the early returns in `runConversationAgentToolTurn` (the remaining
 * async checks — key resolution, tool compilation — can still fall back).
 */
export function conversationToolTurnEligible(run: RunRecord, _agent: ResolvedAgentManifest, modelOverride?: { provider?: string; model?: string }): boolean {
  // ADR 0315 — the default-on baseline means no agent is "pure persona"
  // anymore: eligibility reduces to provider tool-calling support. (The old
  // empty-manifest bail-out predates the baseline.)
  const inputs = (run.inputs ?? {}) as { provider?: unknown; credentialRef?: unknown };
  const credentialRef = typeof inputs.credentialRef === 'string' ? inputs.credentialRef : 'managed:openwop-free';
  // Managed (free) tier — backed by MiniMax, which now has a native tool-calling
  // round (dispatchManagedToolsRound enforces the same caps + provider hiding).
  if (isManagedCredentialRef(credentialRef)) return true;
  // CS-GB-1 — eligibility judges the provider that will ACTUALLY dispatch
  // (route stamp / in-chat override included), not the raw run input. Before
  // this the loop read raw inputs and silently ignored both.
  const target = resolveConversationModelTarget({ runInputs: inputs, metadata: run.metadata, ...(modelOverride ? { override: modelOverride } : {}) });
  return !!target.provider && providerSupportsToolCalling(target.provider);
}

/**
 * Run the agent's tool loop for one conversation turn, or return `null` to fall
 * back to a single completion. The agent's `toolAllowlist` is §A14-filtered to
 * the host's built-in tools; the loop only runs when ≥1 tool resolves AND the
 * run's provider supports native tool-calling.
 */
/**
 * Bounded 429 resilience for the chat tool loop's MODEL calls. The boardroom
 * cadence fires advisor turns back-to-back, so a burst can trip a provider's
 * per-minute limit mid-board and kill the whole turn (the 2026-07-14
 * "Agent tool turn failed: Provider rate-limited" board failure). ONE retry
 * after a short backoff, ONLY for the typed `provider_rate_limited` failure —
 * the retried call is the pure completion request; executed tools are never
 * re-run. Every other failure propagates unchanged. Backoff is env-tunable
 * via OPENWOP_PROVIDER_429_RETRY_MS (0 disables). Exported for tests.
 */
/** Is this failure an upstream rate limit? Matches the TYPED
 *  `provider_rate_limited` (the BYOK adapter's aiProvidersHost mapping) AND
 *  the RAW `<provider>_429:` dispatcher shape — the managed tier
 *  (dispatchMiniMaxToolsRound / dispatchManagedChat) propagates upstream 429s
 *  unmapped, so an instanceof-only check silently exempted the whole free
 *  tier from the retry (grade-pass RESIL-2). Exported for dispatchTurn's
 *  single-completion seam and for tests. */
export function isProviderRateLimited(err: unknown): boolean {
  if (err instanceof AiProviderError) return err.code === 'provider_rate_limited';
  if (!(err instanceof Error)) return false;
  return /^[a-z][a-z0-9-]*_429:/i.test(err.message);
}

/** The shared 429 backoff (OPENWOP_PROVIDER_429_RETRY_MS; 0 disables). */
export function rateLimitBackoffMs(waitMs?: number): number {
  const envMs = Number(process.env.OPENWOP_PROVIDER_429_RETRY_MS);
  return waitMs ?? (Number.isFinite(envMs) && envMs >= 0 ? Math.floor(envMs) : 4000);
}

export function withRateLimitRetry(
  call: (r: AiToolCallRequest) => Promise<AiToolCallResult>,
  waitMs?: number,
): (r: AiToolCallRequest) => Promise<AiToolCallResult> {
  const backoffMs = rateLimitBackoffMs(waitMs);
  if (backoffMs === 0) return call;
  return async (r) => {
    try {
      return await call(r);
    } catch (err) {
      if (!isProviderRateLimited(err)) throw err;
      log.warn('provider_rate_limited_retrying_once', { backoffMs });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return call(r);
    }
  };
}

/** Failure codes that mean "THIS MODEL can't serve this key right now" — the
 *  reasoning-class bump should degrade back to the tenant's selected model
 *  rather than kill the turn: a free-tier Google key has ~zero quota on pro
 *  models (instant 429) and no access to previews (404 → model_not_supported),
 *  while the tenant's own selected flash tier works fine (the 2026-07-14
 *  board incident — plain chats answered, every advisor turn died). */
export const MODEL_FALLBACK_ERROR_CODES: ReadonlySet<string> = new Set(['provider_rate_limited', 'model_not_supported']);

/**
 * Run the loop on the (possibly class-bumped) primary model; if it fails with
 * a model-availability code AND a distinct fallback (the tenant's un-bumped
 * selection) exists, run ONCE more on the fallback. An advisor answering on
 * the selected model beats a dead board. Exported for tests.
 */
export async function runLoopWithBumpFallback<T extends { error?: { code: string; message: string } }>(
  runOnce: (model: string) => Promise<T>,
  primaryModel: string,
  fallbackModel: string | null,
): Promise<{ result: T; modelUsed: string }> {
  const first = await runOnce(primaryModel);
  if (fallbackModel && fallbackModel !== primaryModel && first.error && MODEL_FALLBACK_ERROR_CODES.has(first.error.code)) {
    log.warn('class_bump_model_failed_falling_back', { code: first.error.code, from: primaryModel, to: fallbackModel });
    return { result: await runOnce(fallbackModel), modelUsed: fallbackModel };
  }
  return { result: first, modelUsed: primaryModel };
}

/**
 * Product call (2026-07-15, #1831): multi-voice GROUP rooms (advisory boards,
 * project convenes) do NOT run the tool loop — a cadence of tool-looping
 * advisors fires up to maxRounds×N model calls in tight succession and
 * bombards the provider (free tiers die mid-board), while advisor grounding
 * already rides the prompt-side knowledge injection (ADR 0043 Phase 5B).
 * One completion per voice. Channels/workspace/1:1 chats keep the loop.
 * Operator escape hatch: OPENWOP_GROUP_ROOM_TOOL_LOOP=true restores it.
 *
 * THE one predicate for that gate — the tool-loop skip and the scaffold's
 * "tools are not available" honesty line (conversationExchange) must never
 * disagree, so both call this instead of copying the condition.
 */
export function groupRoomToolLoopOptedOut(tier: ConversationModelTierInput | undefined): boolean {
  return tier?.conversationType === 'group' && process.env.OPENWOP_GROUP_ROOM_TOOL_LOOP !== 'true';
}

/** XCH-GRP-1 — the capability-honesty line for opted-out group turns. Persona
 *  prompts (lint-pinned to real tool ids) otherwise over-promise ("I'll file
 *  that for you") on turns where no tools are offered. Kept HERE beside the
 *  gate so the skip and the notice are constitutionally unable to disagree.
 *  Scoped to WORKSPACE tools only (grade-pass finding, 2026-07-15): group
 *  single-completion turns can still carry provider-native web search
 *  (`resolveWebSearchPreference` has no conversation-type gate), so the notice
 *  must not deny searching — that would be the new lie. */
export const GROUP_ROOM_NO_TOOLS_NOTICE =
  "Workspace tools are not available in this room: you cannot create items, schedule work, or read workspace data this turn. Answer from the context provided in this conversation, and do not promise workspace actions you cannot perform.";

/** Append the no-tools notice to a composed scaffold IFF this turn's tool loop
 *  is opted out. Callers on the text path apply this AFTER composeChatContext —
 *  never inside it, which is shared with realtime voice (ADR 0199), where
 *  delegated advisors DO keep their tools (single floor-holder — the #1831
 *  burst shape can't occur there). */
export function applyGroupRoomScaffoldNotice(scaffold: string, tier: ConversationModelTierInput | undefined): string {
  return groupRoomToolLoopOptedOut(tier) ? `${scaffold}\n\n${GROUP_ROOM_NO_TOOLS_NOTICE}` : scaffold;
}

export async function runConversationAgentToolTurn(params: AgentToolTurnParams): Promise<AgentToolTurnResult | null> {
  const { run, agent, systemPrompt, history, runId, nodeId, policyResolver, onEvent } = params;

  if (groupRoomToolLoopOptedOut(params.tier)) return null;

  // Pure-persona agent / managed tier / non-tool-calling provider ⇒ single
  // completion (same synchronous gate the caller used to decide async).
  if (!conversationToolTurnEligible(run, agent, params.modelOverride)) return null;

  const inputs = (run.inputs ?? {}) as { provider?: unknown; model?: unknown; credentialRef?: unknown; webSearch?: unknown };
  const credentialRef = typeof inputs.credentialRef === 'string' ? inputs.credentialRef : 'managed:openwop-free';

  // §A14-filtered, compiled tool surface (shared by both transports). No
  // resolvable tool ⇒ a loop would be a no-op; take the single completion.
  // ADR 0277 P2 — name the executing agent's PROFILE id on the tool scope so
  // the knowledge tools honor its bound collections (TTL-cached resolve).
  const identity = await resolveAgentIdentity(run.tenantId, agent.agentId, { allowReverseScan: true });
  // ADR 0308 — thread the run owner's durable principal (ADR 0024 §4 stamp)
  // onto the tool scope: the deliverable tools (documents.draft, …) need the
  // ACTING USER for ownership + org-membership RBAC, and fail closed without
  // one (system runs have no human — correctly no acting user).
  const actingUserId = (run.metadata as { actingUserId?: unknown } | undefined)?.actingUserId;
  // ADR 0627 D3 (review S2) — the owner's OWN personal tenant rides the same
  // stamp (`routes/runs.ts` from `req.personalTenant`), so a req-less tenant
  // gate can grant the implicit owner of an `anon:`/`user:` sandbox.
  const personalTenant = (run.metadata as { personalTenant?: unknown } | undefined)?.personalTenant;
  // ADR 0309 — the conversation the promise is made in rides the scope too, so
  // the schedule-followup tool's delivery destination is unforgeable (it takes
  // no conversation input; same threading rationale as actingUserId above).
  const chatSessionId = (run.metadata as { chatSessionId?: unknown } | undefined)?.chatSessionId;
  // A run a tool ignites this turn is recorded here and materialized by the
  // EXCHANGE (one turnIndex allocator; the response owner) — see
  // `host/turnRunDispatch.ts` for the collision + invisibility this replaces.
  const runDispatchCollector = createTurnRunDispatchCollector();
  // ADR 0324 — composed through the ONE scope composer (shared with the
  // realtime voice bridge) so the fail-closed fields can't drift per transport.
  const toolProvider = createScopedAgentToolProvider({
    tenantId: run.tenantId, runId, agentProfileId: identity.profileId,
    ...(typeof actingUserId === 'string' && actingUserId ? { actingUserId } : {}),
    ...(typeof personalTenant === 'string' && personalTenant ? { personalTenant } : {}),
    ...(typeof chatSessionId === 'string' && chatSessionId ? { conversationId: chatSessionId } : {}),
    onRunDispatched: runDispatchCollector.sink,
  });
  // ADR 0104 — apply a super-admin tool-allowlist override (per tenant+agent) to what
  // the chat agent is offered, exactly as runAgentDispatchLive does. Absent ⇒ the
  // manifest allowlist.
  const allowlistOverride = await resolveAgentToolAllowlistOverride(run.tenantId, agent.agentId);
  // ADR 0315 — one resolver: override (full-replace) ?? manifest ∪ baseline.
  const tools = compileAgentTools(agent, builtinAgentToolIds(), toolProvider.resolveTool, effectiveToolAllowlist(agent.toolAllowlist, allowlistOverride));
  if (tools.length === 0) return null;

  // Resolve the tool-calling transport. The MANAGED (free) tier routes through
  // dispatchManagedToolsRound (daily caps + server key + provider hiding); BYOK
  // uses the policy-enforcing provider adapter. The loop is fed the USER-FACING
  // id as provider/model so the underlying managed provider never reaches an
  // event (the `agent.reasoned` summary names provider/model).
  let callAIWithTools: (r: AiToolCallRequest) => Promise<AiToolCallResult>;
  let loopProvider: string;
  let loopModel: string;
  // The tenant's UN-bumped selection, when a reasoning-class bump moved the
  // turn off it — the degrade target for MODEL_FALLBACK_ERROR_CODES.
  let loopFallbackModel: string | null = null;
  // Native web-search/grounding rides the BYOK path only — the managed (MiniMax)
  // tier has no native search, so it degrades to no grounding (ADR 0101).
  let loopWebSearch = false;

  if (isManagedCredentialRef(credentialRef)) {
    const userFacingProvider = managedProviderIdFromRef(credentialRef);
    loopProvider = userFacingProvider;
    loopModel = userFacingProvider;
    callAIWithTools = async (r) => {
      const round = await dispatchManagedToolsRound({
        userFacingProvider,
        tenantId: run.tenantId,
        // ADR 0693 — the acting participant, so a shared workspace does not pool
        // one free-tier allowance across everyone in it. Read from run.metadata
        // (fork-safe, already resolved above), and absent is legal.
        ...(typeof actingUserId === 'string' && actingUserId ? { actingSubject: actingUserId } : {}),
        messages: [{ role: 'system', content: r.systemPrompt ?? '' }, ...r.messages.map(toChatMessage)],
        // ADR 0148 A3 — tool-surface diet (gated; off ⇒ unchanged). Sibling site:
        // aiProviders/aiProvidersHost.ts (BYOK/workflow tools-round adapter).
        tools: r.tools.map((t) => ({ ...t, inputSchema: compactToolSchema(t.inputSchema, contextEconomy().toolDiet) })),
      });
      return {
        content: round.text,
        toolCalls: round.toolUses.map((t) => ({ id: t.id, name: t.name, input: t.input })),
      };
    };
  } else {
    // CS-GB-1 — the ONE resolver (override > stamp > same-provider class tier >
    // inputs); the loop previously read raw inputs, so a stamped group-tier
    // route, the in-chat model switch, AND an advisor's reasoning class were
    // all silently ignored on tool-loop turns.
    const target = resolveConversationModelTarget({
      runInputs: inputs, metadata: run.metadata,
      ...(params.modelOverride ? { override: params.modelOverride } : {}),
      ...(params.tier ? { tier: params.tier } : {}),
    });
    const provider = target.provider ?? '';
    const model = target.model;
    // BYOK-direct: resolve the tenant key (SR-1 — never enters an event/prompt).
    // Missing key ⇒ fall back so the single-completion path surfaces the canonical
    // `credential_unavailable` (no duplicated error vocabulary here).
    const apiKey = await resolveSecret(credentialRef, { tenantId: run.tenantId });
    if (!apiKey) return null;
    const adapter = createAiProvidersAdapter({
      runId, nodeId, tenantId: run.tenantId, attempt: 1,
      secrets: { [credentialRef]: apiKey },
      policyResolver,
    });
    callAIWithTools = adapter.callAIWithTools;
    loopProvider = provider;
    loopModel = model;
    // Same resolve WITHOUT the tier ⇒ the un-bumped selection; differs only
    // when the reasoning-class bump chose the model above.
    const selected = resolveConversationModelTarget({
      runInputs: inputs, metadata: run.metadata,
      ...(params.modelOverride ? { override: params.modelOverride } : {}),
    });
    loopFallbackModel = selected.model !== model ? selected.model : null;
    loopWebSearch = resolveWebSearchPreference(params.webSearch, inputs.webSearch);
  }
  // Both transports get the bounded 429 retry — see withRateLimitRetry above.
  callAIWithTools = withRateLimitRetry(callAIWithTools);

  // Per-turn budget: bound observe→act rounds (Phase 3). Default is the loop's
  // own DEFAULT_MAX_TOOL_ROUNDS; ops can raise it for long-horizon research
  // agents (or lower it to cap cost) via OPENWOP_CONVERSATION_MAX_TOOL_ROUNDS.
  const maxRoundsEnv = Number(process.env.OPENWOP_CONVERSATION_MAX_TOOL_ROUNDS);
  const maxRounds = Number.isFinite(maxRoundsEnv) && maxRoundsEnv > 0 ? Math.floor(maxRoundsEnv) : undefined;

  // ADR 0102 — resolve the standing agent's tool permissions (undefined for a
  // pack/manifest agent ⇒ the gate stays ungated). The gate self-runs in shadow
  // mode (log-only) until the enforcement flag is on.
  const toolPermissions = await resolveAgentToolPermissions(run.tenantId, agent.agentId);

  // ADR 0132 — per-conversation capability scope (the fourth AND-term), ONLY when
  // the `conversation-tools` toggle is ON for the tenant. Resolve the conversation's
  // scope CONFIG against THIS turn's ceiling (the compiled tool ids) into the
  // effective set the loop enforces. Read LIVE each turn (not a frozen stamp): the
  // scope is deterministic + per-turn tool decisions are recorded (ADR 0089 §Q4), so
  // live resolution is replay/fork-safe AND keeps the control honest + tighter-wins
  // on :fork (ADR 0132 §replay correction). The run.metadata stamp is best-effort
  // provenance for the inspector — NEVER the enforcement source.
  // The conversation's resolved approval decisions (shared by the ADR 0132 scope fold
  // and the ADR 0135 firewall's already-approved short-circuit).
  const approvals = await listToolApprovals(run.tenantId, params.conversationId);
  const approvedTools = new Set(approvals.filter((a) => a.status === 'approved').map((a) => a.toolName));

  let capabilityScope: { enabled: string[]; requireApproval: string[] } | undefined;
  {
    // ADR 0132 — conversation-tools is always-on (toggle removed); resolve the
    // conversation's scope every turn. Absent config ⇒ isNarrowing false ⇒ no-op.
    const ceiling = tools.map((t) => t.def.name);
    let scopeConfig = (await getConversationMeta(run.tenantId, params.conversationId))?.capabilityScope;

    // ADR 0136 — fold an APPROVED intent ledger into the scope (ledger ∩ chipset, never
    // widens). Stamp the mission contract once (replay-safe). out_of_mandate (relative
    // TTL elapsed off the stamped resolvedAt) ⇒ enabled:[] (the agent may talk, not act).
    // Always-on (toggle removed) — a no-op unless the conversation has an approved ledger.
    {
      const ledger = await getLedger(run.tenantId, params.conversationId);
      if (ledger?.status === 'approved') {
        if (params.storage) {
          const md = computeIntentLedgerStamp(run.metadata ?? {}, ledger, new Date().toISOString());
          if (md) { try { await params.storage.updateRun(run.runId, { metadata: md }); run.metadata = md; } catch { /* best-effort */ } }
        }
        const anchor = readIntentLedgerStamp(run.metadata)?.resolvedAt;
        const expired = ledger.expiresAtRelMs !== undefined && anchor !== undefined && (Date.now() - Date.parse(anchor)) > ledger.expiresAtRelMs;
        if (expired) {
          log.info('intent_ledger_out_of_mandate', { conversationId: params.conversationId, ledgerId: ledger.ledgerId });
          try { await saveLedger({ ...ledger, status: 'expired' }); } catch { /* best-effort */ }
        }
        const ledgerScope: ConversationCapabilityScope = expired ? { mode: 'restricted', enabled: [] } : ledgerToScope(ledger);
        scopeConfig = intersectScopes(scopeConfig, ledgerScope);
      }
    }

    if (isNarrowing(ceiling, scopeConfig)) {
      capabilityScope = applyApprovalDecisions(resolveCapabilityScope(ceiling, scopeConfig), approvals);
      if (params.storage) {
        const md = computeCapabilityScopeStamp(run.metadata ?? {}, capabilityScope, new Date().toISOString());
        if (md) {
          try { await params.storage.updateRun(run.runId, { metadata: md }); run.metadata = md; }
          catch { /* best-effort provenance — never break the turn */ }
        }
      }
    }
  }

  // ADR 0135 — Capability Firewall. Always-on (toggle removed) but RULE-LESS by default:
  // skip building the hook entirely when the tenant has no rules, so an unconfigured
  // tenant pays zero cost + sees zero behavior change. Already-approved tools short-circuit
  // (no feature→feature import — host/ passes approvedTools). Best-effort rule-set stamp.
  let firewall: FirewallHook | undefined;
  const fwRules = await getCapabilityRules(run.tenantId); // tenant store, or [] (rule-less default)
  // ADR 0397 — the tenant's enforcement posture (resolved live, like capabilityScope; the
  // stamp below records it for provenance but does NOT drive evaluation — see the stamp note).
  const fwMode = await getFirewallMode(run.tenantId);
  const fwDefaultDenyVerdict = await getDefaultDenyVerdict(run.tenantId);
  const fwPlatformRules = await getPlatformRules(); // ADR 0397 P5 — global floor (AND under tenant)
  const denyMode = fwMode !== 'default-allow';
  // ADR 0150 — in `safe` mode (default) we gate the SENSITIVE tools even when the tenant has no
  // firewall rules (the permission-mode baseline that restores the code-exec gate). In `bypass`
  // we still build the hook so any tenant `deny` rules apply, but require-approval is downgraded.
  // ADR 0397 — a deny MODE (shadow/enforce) also always needs the hook, even rule-less and even
  // under bypass (an enforce hard-deny is never bypassed). Skip only the true no-op:
  // default-allow + rule-less + bypass.
  const bypass = params.permissionMode === 'bypass';
  if (fwRules.length > 0 || denyMode || fwPlatformRules.length > 0 || !bypass) {
    const rules = fwRules;
    const unknownToolPolicy = await getUnknownToolPolicy(run.tenantId);
    firewall = buildFirewallHook({
      rules, approvedTools, unknownToolPolicy,
      requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, // ADR 0150 — gated in `safe`, allowed in `bypass`
      gateHostMediatedEgress: true, // ADR 0610 D5 / PMC-1 — gate the host-mediated egress CLASS in safe mode (bypass downgrades)
      bypassApproval: bypass,
      mode: fwMode,
      defaultDenyVerdict: fwDefaultDenyVerdict,
      platformRules: fwPlatformRules, // ADR 0397 P5 — the global floor
      onUnclassified: (toolName) => log.debug('firewall_unclassified_tool', { toolName, unknownToolPolicy }),
      // ADR 0397 shadow — record the computed would-block (call still proceeds).
      onShadowWouldBlock: (toolName, wouldBe) => {
        void recordGovernanceDecision({
          tenantId: run.tenantId,
          kind: 'firewall',
          outcome: 'allow', // shadow APPLIED allow — the tool ran; this is a would-block record.
          reason: 'shadow (log-only): would block under enforce',
          resource: params.conversationId,
          detail: { toolName, decision: wouldBe, shadow: true, wouldBlock: wouldBe },
        });
      },
    });
    // ADR 0397 — stamp the resolved posture for provenance. Written when there are rules, a
    // deny mode, or a platform floor — so an enforce/platform-governed run is not
    // misrepresented as ungoverned. Records the posture verbatim; it does not itself drive
    // fork evaluation (evaluation re-resolves live, like capabilityScope).
    if (params.storage && (rules.length > 0 || denyMode || fwPlatformRules.length > 0)) {
      const md = computeFirewallStamp(run.metadata ?? {}, rules, new Date().toISOString(), { mode: fwMode, defaultDenyVerdict: fwDefaultDenyVerdict, platformRules: fwPlatformRules });
      if (md) { try { await params.storage.updateRun(run.runId, { metadata: md }); run.metadata = md; } catch { /* best-effort */ } }
    }
  }

  // ADR 0604 (TOCC-1 / TOCWF-3) — the CHAT lane's compaction decision.
  //
  // `runChatToolLoop` has accepted a `compaction` option since ADR 0099 Phase 1
  // and this call site passed fifteen keys, none of them that one — so
  // `applyToolResultTransform` short-circuited on `!ctx.decision` at EVERY chat
  // turn and the feature was IDENTITY on the lane `FEATURES.md`,
  // `ARCHITECTURE.md` ("Covers chat…") and ADR 0099's pass-3 note all named as
  // its flagship surface. The ADR had conflated the `bootstrap/nodes.ts`
  // heartbeat node — whose tool names are regex-validated to exclude `:` and
  // `.`, so no `openwop:*` id can ever reach it — with the interactive `/` chat.
  //
  // Read from the run's OWN frozen metadata, the same reader the executor uses
  // (`executor.ts` → `readCompactionDecision`), so the chat lane inherits the
  // run-start freeze and stays replay-safe. Never re-resolved here: a live
  // toggle read at turn time is exactly what the freeze exists to prevent.
  const compaction = readCompactionDecision(run.metadata);

  const runOnce = (model: string) => runChatToolLoop(
    {
      // ADR 0680 D3 — attribute the compaction savings telemetry.
      tenantId: run.tenantId,
      provider: loopProvider, model, credentialRef,
      systemPrompt,
      messages: history,
      tools,
      agentId: agent.agentId,
      persona: agent.persona,
      ...(compaction ? { compaction } : {}),
      ...(maxRounds ? { maxRounds } : {}),
      ...(loopWebSearch ? { webSearch: true } : {}),
      ...(toolPermissions ? { toolPermissions } : {}),
      ...(capabilityScope ? { capabilityScope } : {}),
      ...(firewall ? { firewall } : {}),
      // ADR 0397 Phase 1 — decision observability: record firewall verdicts that
      // narrowed a call to the unified governance decision log. Fire-and-forget
      // (recordGovernanceDecision swallows its own errors) so the hot loop adds no
      // await; the closure captures the tenant so agentDispatch stays feature-free.
      ...(firewall ? { onFirewallDecision: (d: { toolName: string; decision: 'deny' | 'require-approval'; reason?: string; ruleId?: string }) => {
        void recordGovernanceDecision({
          tenantId: run.tenantId,
          kind: 'firewall',
          // Both verdicts blocked the call this turn (deny outright, or held pending
          // approval) — neither let the tool proceed, so the coarse outcome is `deny`.
          // `detail.decision` carries the true tri-state for the decisions view.
          outcome: 'deny',
          ...(d.reason ? { reason: d.reason } : {}),
          resource: params.conversationId,
          detail: { toolName: d.toolName, decision: d.decision, ...(d.ruleId ? { ruleId: d.ruleId } : {}) },
        });
      } } : {}),
      ...(onEvent ? { onEvent } : {}),
    },
    { callAIWithTools, executeTool: toolProvider.executeTool },
  );
  // A class-bumped model that can't serve this key (429 quota / 404 preview
  // access) degrades to the tenant's own selection instead of failing the turn.
  const { result: loop, modelUsed } = await runLoopWithBumpFallback(runOnce, loopModel, loopFallbackModel);

  // ADR 0132 Phase 3 — record any tool call the agent deferred for approval so the
  // conversation can surface an interrupt.approval card + the FE can list pending
  // approvals (Phase 4 route). Idempotent + decision-preserving (never resets an
  // already-resolved decision). Best-effort: a ledger write must not break the turn.
  const runDispatches = runDispatchCollector.drain();
  const pendingApprovals = loop.pendingApprovals ?? [];
  for (const p of pendingApprovals) {
    try { await recordToolApprovalRequested(run.tenantId, params.conversationId, p.toolName); }
    catch { /* best-effort — the agent's reply already told the user it is pending */ }
  }

  return {
    text: loop.finalText,
    events: loop.events,
    // Name the provider/model in the surfaced failure — a bare "Provider
    // rate-limited." hid WHICH model was rejected and cost real debugging
    // hours (the class-bumped model differs from the tenant's selection).
    // Provider/model already appear in agent.reasoned events, so no new
    // information is exposed.
    ...(loop.error ? { error: { ...loop.error, message: `${loop.error.message} (${loopProvider}/${modelUsed})` } } : {}),
    ...(pendingApprovals.length ? { pendingApprovals } : {}),
    // Surfaced even when `loop.error` is set: the run was already IGNITED, so
    // hiding it because the narration failed is exactly the dishonesty this
    // seam exists to remove. The earlier `return null` paths precede any tool
    // execution, so they can carry no dispatch.
    ...(runDispatches.length ? { runDispatches } : {}),
  };
}
