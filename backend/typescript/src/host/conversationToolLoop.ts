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

import { createAiProvidersAdapter, providerSupportsToolCalling } from '../aiProviders/aiProvidersHost.js';
import { createAgentToolProvider, builtinAgentToolIds } from './agentToolProvider.js';
import { compileAgentTools, runChatToolLoop, type AgentEvent } from './agentDispatch.js';
import { resolveAgentToolPermissions } from './agentProfileService.js';
import { resolveAgentToolAllowlistOverride } from './agentToolAllowlistService.js';
import { isManagedCredentialRef, managedProviderIdFromRef, dispatchManagedToolsRound } from '../providers/managedProvider.js';
import { compactToolSchema } from '../providers/toolSchemaCompaction.js';
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
import { getCapabilityRules, getUnknownToolPolicy } from '../features/capability-firewall/ruleStore.js';
import type { ResolvedAgentManifest } from '../executor/agentRegistry.js';
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
export function conversationToolTurnEligible(run: RunRecord, agent: ResolvedAgentManifest): boolean {
  if (!agent.toolAllowlist || agent.toolAllowlist.length === 0) return false;
  const inputs = (run.inputs ?? {}) as { provider?: unknown; credentialRef?: unknown };
  const credentialRef = typeof inputs.credentialRef === 'string' ? inputs.credentialRef : 'managed:openwop-free';
  // Managed (free) tier — backed by MiniMax, which now has a native tool-calling
  // round (dispatchManagedToolsRound enforces the same caps + provider hiding).
  if (isManagedCredentialRef(credentialRef)) return true;
  const provider = typeof inputs.provider === 'string' ? inputs.provider : undefined;
  return !!provider && providerSupportsToolCalling(provider);
}

/**
 * Run the agent's tool loop for one conversation turn, or return `null` to fall
 * back to a single completion. The agent's `toolAllowlist` is §A14-filtered to
 * the host's built-in tools; the loop only runs when ≥1 tool resolves AND the
 * run's provider supports native tool-calling.
 */
export async function runConversationAgentToolTurn(params: AgentToolTurnParams): Promise<AgentToolTurnResult | null> {
  const { run, agent, systemPrompt, history, runId, nodeId, policyResolver, onEvent } = params;

  // Pure-persona agent / managed tier / non-tool-calling provider ⇒ single
  // completion (same synchronous gate the caller used to decide async).
  if (!conversationToolTurnEligible(run, agent)) return null;

  const inputs = (run.inputs ?? {}) as { provider?: unknown; model?: unknown; credentialRef?: unknown; webSearch?: unknown };
  const credentialRef = typeof inputs.credentialRef === 'string' ? inputs.credentialRef : 'managed:openwop-free';

  // §A14-filtered, compiled tool surface (shared by both transports). No
  // resolvable tool ⇒ a loop would be a no-op; take the single completion.
  const toolProvider = createAgentToolProvider({ tenantId: run.tenantId, runId });
  // ADR 0104 — apply a super-admin tool-allowlist override (per tenant+agent) to what
  // the chat agent is offered, exactly as runAgentDispatchLive does. Absent ⇒ the
  // manifest allowlist.
  const allowlistOverride = await resolveAgentToolAllowlistOverride(run.tenantId, agent.agentId);
  const tools = compileAgentTools(agent, builtinAgentToolIds(), toolProvider.resolveTool, allowlistOverride);
  if (tools.length === 0) return null;

  // Resolve the tool-calling transport. The MANAGED (free) tier routes through
  // dispatchManagedToolsRound (daily caps + server key + provider hiding); BYOK
  // uses the policy-enforcing provider adapter. The loop is fed the USER-FACING
  // id as provider/model so the underlying managed provider never reaches an
  // event (the `agent.reasoned` summary names provider/model).
  let callAIWithTools: (r: AiToolCallRequest) => Promise<AiToolCallResult>;
  let loopProvider: string;
  let loopModel: string;
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
    const provider = typeof inputs.provider === 'string' ? inputs.provider : '';
    const model = typeof inputs.model === 'string' ? inputs.model : 'unknown';
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
    loopWebSearch = resolveWebSearchPreference(params.webSearch, inputs.webSearch);
  }

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
  // ADR 0150 — in `safe` mode (default) we gate the SENSITIVE tools even when the tenant has no
  // firewall rules (the permission-mode baseline that restores the code-exec gate). In `bypass`
  // we still build the hook so any tenant `deny` rules apply, but require-approval is downgraded.
  // Skip the hook entirely only when there's nothing to enforce: bypass + rule-less ⇒ true no-op.
  const bypass = params.permissionMode === 'bypass';
  if (fwRules.length > 0 || !bypass) {
    const rules = fwRules;
    const unknownToolPolicy = await getUnknownToolPolicy(run.tenantId);
    firewall = buildFirewallHook({
      rules, approvedTools, unknownToolPolicy,
      requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, // ADR 0150 — gated in `safe`, allowed in `bypass`
      bypassApproval: bypass,
      onUnclassified: (toolName) => log.debug('firewall_unclassified_tool', { toolName, unknownToolPolicy }),
    });
    if (params.storage && rules.length > 0) {
      const md = computeFirewallStamp(run.metadata ?? {}, rules, new Date().toISOString());
      if (md) { try { await params.storage.updateRun(run.runId, { metadata: md }); run.metadata = md; } catch { /* best-effort */ } }
    }
  }

  const loop = await runChatToolLoop(
    {
      provider: loopProvider, model: loopModel, credentialRef,
      systemPrompt,
      messages: history,
      tools,
      agentId: agent.agentId,
      persona: agent.persona,
      ...(maxRounds ? { maxRounds } : {}),
      ...(loopWebSearch ? { webSearch: true } : {}),
      ...(toolPermissions ? { toolPermissions } : {}),
      ...(capabilityScope ? { capabilityScope } : {}),
      ...(firewall ? { firewall } : {}),
      ...(onEvent ? { onEvent } : {}),
    },
    { callAIWithTools, executeTool: toolProvider.executeTool },
  );

  // ADR 0132 Phase 3 — record any tool call the agent deferred for approval so the
  // conversation can surface an interrupt.approval card + the FE can list pending
  // approvals (Phase 4 route). Idempotent + decision-preserving (never resets an
  // already-resolved decision). Best-effort: a ledger write must not break the turn.
  const pendingApprovals = loop.pendingApprovals ?? [];
  for (const p of pendingApprovals) {
    try { await recordToolApprovalRequested(run.tenantId, params.conversationId, p.toolName); }
    catch { /* best-effort — the agent's reply already told the user it is pending */ }
  }

  return {
    text: loop.finalText,
    events: loop.events,
    ...(loop.error ? { error: loop.error } : {}),
    ...(pendingApprovals.length ? { pendingApprovals } : {}),
  };
}
