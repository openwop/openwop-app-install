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

import { maybeCaptureExecuteTool } from './evals/toolBoundary.js';
import { createAiProvidersAdapter, providerSupportsToolCalling, toolRoundResult, AiProviderError, CREDENTIAL_PROVIDERS } from '../aiProviders/aiProvidersHost.js';
import { explicitRefNamesOtherProvider } from '../aiProviders/credentialRefLadder.js';
import { createScopedAgentToolProvider, builtinAgentToolIds, builtinAgentTool } from './agentToolProvider.js';
import { resolveToolCapability } from '../features/capability-firewall/toolCapabilityResolver.js';
import { createTurnRunDispatchCollector, type TurnRunDispatch } from './turnRunDispatch.js';
import { createChatClarificationCollector, isChatAskEnabled, type ChatClarificationAsk } from './clarificationChat.js';
import { ASK_USER_TOOL } from './clarificationLift.js';
import type { ServedModel } from './turnAttribution.js';
import { compileAgentTools, runChatToolLoop, type AgentEvent, managedLimitCode } from './agentDispatch.js';
import { resolveAgentToolPermissionSet } from './agentProfileService.js';
import { resolveAgentIdentity } from './agentIdentity.js';
import { agentOffersToolBaseline, effectiveToolAllowlist, resolveAgentToolAllowlistOverride } from './agentToolAllowlistService.js';
import { isManagedCredentialRef, managedProviderIdFromRef, dispatchManagedToolsRound } from '../providers/managedProvider.js';
import { featureForToolName } from './managedCredits.js';
import { dietToolSurface } from '../providers/toolSchemaCompaction.js';
import { resolveConversationModelTarget, unchosenModelTarget, type ConversationModelTierInput, type ConversationModelTargetInput } from '../features/model-router/applyRoute.js';
import type { RoutingTarget } from '../features/model-router/routeTurn.js';
import { resolveUserNamedSecret } from '../byok/userNamedSecret.js';
import { createLogger } from '../observability/logger.js';
import { listToolApprovals, recordToolApprovalRequested, claimApprovedToolApprovals, returnUnspentToolApprovals, makeApprovalGrant, deleteSpentCallApprovals, scopeFoldRows, type ApprovalGrant, type ToolApprovalRecord } from '../features/conversation-tools/approvalLedger.js';
import { computeFirewallStamp } from '../features/capability-firewall/firewallHook.js';
import { buildLaneFirewall, safeModeBaseline } from './laneFirewall.js';
import { resolveConversationToolGate } from './conversationToolScope.js';
import { toolAuthorityHolds } from './conversationVisibility.js';
import type { ResolvedAgentManifest } from '../executor/agentRegistry.js';
import { readCompactionDecision } from '../executor/compaction.js';
import type { AiCallMessage, AiToolCallRequest, AiToolCallResult } from '../executor/types.js';
import { isStreamIncompleteError, type ChatMessage } from '../providers/dispatch.js';
import type { ProviderPolicyResolver } from './index.js';
import type { RunRecord } from '../types.js';
import type { Storage } from '../storage/storage.js';
import { resolveWebSearchPreference } from './webSearchPreference.js';
import { planExemptOfRunMetadata } from './operatorPlanExemption.js';

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
  /** ADR 1001 D7 — the agent ended its turn with questions (`openwop:ask-user`). */
  clarificationAsk?: ChatClarificationAsk;
  /** ADR 0986 D1 — what ANSWERED: the loop's provider and the model it actually
   *  used after any bump fallback (a managed TIER id on the managed path). */
  served?: ServedModel;
}

/**
 * ADR 1042 D9 ("Owner full, others narrow", user decision 2026-11-03) — the tool
 * scope of a channel turn that is NOT the owner's own linked account (an approved
 * outside sender, any group, a relay contact). The turn is offered ONLY the
 * configured agent's explicit allowlist (no ADR 0315 default-on baseline), and of
 * that only tools that cannot change anything: a builtin whose declared `effect` is
 * `read`, not held by the safe-mode baseline, and with no classified egress. An
 * unknown tool (MCP, unclassified) is not offered. Empty ⇒ no tools: the model
 * answers from its instructions and the conversation alone.
 */
export interface ChannelToolScope {
  mode: 'narrow';
  /** Absent ⇒ the SERVED agent's own explicit allowlist (its super-admin override,
   *  else its manifest), resolved in the loop — never re-read from the registry by a
   *  caller, so it always matches the agent version that answers (ADR 1014). */
  allowlist?: readonly string[];
}

/**
 * ADR 1042 D9 — the hand-kept, REVIEWED list of tools a narrow channel turn (an
 * outside sender, a group, a relay contact) may ever be offered. THIS LIST IS THE
 * GATE: a tool is offered only if the lane's configured agent allowlists it AND it
 * is listed here. It starts EMPTY on purpose (fail closed): every workspace tool
 * reads something the owner can see and an outsider should not, so a tool joins
 * only after a review that it reads nothing sensitive, across tenants included.
 * Add an id with the review's reasoning beside it, and add it to the pinned list in
 * `adr1042-channel-safe-tools.test.ts` (which also proves each id is still offered).
 */
export const CHANNEL_SAFE_READ_TOOLS: ReadonlySet<string> = new Set<string>([
  // CHAN-F8 review, 2026-11-10 (user decision "propose and enable"). 140 builtins pass the
  // mechanical conditions; 11 read nothing an outsider should not see. Each note says what
  // the tool reads. Left OFF on purpose: every tool that reads workspace, org, owner or
  // conversation data (the other 129); `feature.workflow-author.nodes.draft` (its result
  // names the packs this workspace disabled); and four that read nothing but look broken
  // when run as a chat tool (`core.openwop.data.jsonpath-query`, `feature.assistant.nodes.prioritize`,
  // `feature.crm.nodes.segment-vocabulary`, `feature.crm.nodes.validate-segment`).
  'openwop:schema.lookup', // host-global node, canvas and artifact-type registries; run() ignores the tenant (schemaLookup.ts)
  'openwop:ask-user', // reads nothing: echoes the model's own questions and ends the turn (agent-clarification/askUserTool.ts)
  'openwop:slides.catalog', // a constant, host-written block catalog; the tenant only gates the toggle (slides/surface.ts)
  'openwop:app-builder.catalog', // a constant component catalog (app-builder/componentCatalog.ts projectComponentCatalog)
  'openwop:accessibility.check', // grades only its own input (accessibility/agentTools.ts checkContentA11y)
  'openwop:feature.workflow-author.nodes.validate', // stateless check of the given definition against the shared node catalog
  'openwop:core.openwop.data.json-schema-validate', // pure local validator, no $ref fetching (packs/core.openwop.data)
  'openwop:core.flow.split-in-batches', // pure slice of the given array (packs/core.openwop.flow)
  'openwop:core.flow.aggregate-text', // pure join of the given items (packs/core.openwop.flow)
  'openwop:feature.insights-suite.nodes.variance-compute', // pure: its inputs and config only (packs/feature.insights-suite.nodes)
  'openwop:feature.insights-suite.nodes.talent-score', // pure: its inputs and config only (packs/feature.insights-suite.nodes)
]);

/** The tool ids a narrow channel turn may be offered (fail-closed, see `ChannelToolScope`):
 *  on the agent's allowlist AND on `CHANNEL_SAFE_READ_TOOLS` (`safeList`, injectable for
 *  tests only), and as extra conditions a builtin, not held by the safe-mode baseline,
 *  with no classified egress, and declaring `effect: 'read'`. */
export function narrowChannelToolIds(allowlist: readonly string[], safeList: ReadonlySet<string> = CHANNEL_SAFE_READ_TOOLS): string[] {
  const baseline = safeModeBaseline().tools;
  return allowlist.filter((id) => {
    if (!safeList.has(id)) return false;
    const tool = builtinAgentTool(id);
    if (!tool || tool.effect !== 'read') return false;
    if (baseline.has(id)) return false;
    const egress = resolveToolCapability(id)?.egress;
    return egress === undefined || egress === 'none';
  });
}

/** Review N1 — is this conversation run a NARROW channel conversation (stamped at
 *  creation by channel-ingress, `run.metadata.channelIngress.scope === 'narrow'`)? */
export function isNarrowChannelRun(run: Pick<RunRecord, 'metadata'>): boolean {
  const ci = (run.metadata as Record<string, unknown> | undefined)?.['channelIngress'];
  return typeof ci === 'object' && ci !== null && (ci as { scope?: unknown }).scope === 'narrow';
}

/** Review N1 — the scope a turn actually runs under: the per-turn channel scope when
 *  given, else NARROW for any turn of a narrow channel conversation (the agent's own
 *  explicit allowlist, never the baseline), else none. */
export function effectiveTurnScope(
  run: Pick<RunRecord, 'metadata'>,
  perTurn: ChannelToolScope | undefined,
  override: readonly string[] | undefined,
  agentAllowlist: readonly string[] | undefined,
): ChannelToolScope | undefined {
  const served = override ?? agentAllowlist ?? [];
  if (perTurn) return perTurn.allowlist ? perTurn : { mode: 'narrow', allowlist: served };
  return isNarrowChannelRun(run) ? { mode: 'narrow', allowlist: served } : undefined;
}

/** The allowlist a chat turn compiles its tools from: the narrow channel scope
 *  when given (ADR 1042 D9), else the ADR 0315 resolver (override ?? manifest ∪
 *  default-on baseline). */
export function turnToolAllowlist(
  agentAllowlist: readonly string[] | undefined,
  override: readonly string[] | undefined,
  toolScope: ChannelToolScope | undefined,
  offersBaseline: boolean,
): string[] {
  return toolScope?.mode === 'narrow' ? narrowChannelToolIds(toolScope.allowlist ?? override ?? agentAllowlist ?? []) : effectiveToolAllowlist(agentAllowlist, override, offersBaseline);
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
  /** ADR 1017 D2 — the wire message id the exchange reserved for this turn's agent
   *  reply; handed to the tools so a saved artifact can be shown under that turn. */
  turnMessageId?: string;
  /** ADR 0132 — storage handle for the best-effort capability-scope provenance
   *  stamp (`run.metadata.capabilityScope`). Optional: absent ⇒ enforce live, skip
   *  the stamp (enforcement never depends on it). */
  storage?: Storage;
  /** Best-effort per-event sink so the caller can stream live tool progress. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  /** Per-exchange native web-search override (ADR 0101). Beats the run-input
   *  open-time default; honored on the BYOK path only. */
  webSearch?: boolean;
  /** Per-exchange permission mode (ADR 0150). `safe` (default) holds the high-blast-radius
   *  tools (the safe-mode baseline — `laneFirewall.safeModeBaseline()`) for an approval in
   *  the conversation's ledger, surfaced by the chat's pending-approval notice (ADR 0834 D6;
   *  there is no `interrupt.approval` card for chat tool calls). `bypass` skips ONLY those
   *  baseline asks, and ONLY when `callerPrincipal` is the run's acting principal (ADR 0834
   *  D2/D3); a tenant/platform/enforce ask, a hard `deny`, RBAC, budgets and sandbox
   *  isolation bind in either mode. */
  permissionMode?: 'safe' | 'bypass';
  /** ADR 0834 D3 — the HTTP caller as `req.userId ?? principalId` (the derivation
   *  `actingUserId` was stamped with). Absent ⇒ a `bypass` is not honoured. */
  callerPrincipal?: string;
  /** ADR 0124 Phase 3 / CS-GB-1 — the per-exchange model switch, now honored on
   *  tool-loop turns exactly as on the single-completion path. */
  modelOverride?: { provider?: string; model?: string };
  /** CS-GB-1 — conversation type + answering agent's modelClass for the
   *  same-provider class-tier default (group reasoning rooms). */
  tier?: ConversationModelTierInput;
  /** ADR 1016 D3 — this exchange's model route (`resolveTurnModelRoute`). */
  route?: RoutingTarget | null;
  /** ADR 1042 D9 — a narrow channel turn (see `ChannelToolScope`). Absent ⇒ the agent's usual tools. */
  toolScope?: ChannelToolScope;
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
export function conversationToolTurnEligible(run: RunRecord, _agent: ResolvedAgentManifest, modelOverride?: { provider?: string; model?: string }, route?: RoutingTarget | null): boolean {
  // ADR 0315 — the default-on baseline means no agent is "pure persona"
  // anymore: eligibility reduces to provider tool-calling support. (The old
  // empty-manifest bail-out predates the baseline.)
  const inputs = (run.inputs ?? {}) as { provider?: unknown; credentialRef?: unknown };
  const credentialRef = typeof inputs.credentialRef === 'string' ? inputs.credentialRef : 'managed:openwop-free';
  // Managed (free) tier — backed by MiniMax, which now has a native tool-calling
  // round (dispatchManagedToolsRound enforces the same caps + provider hiding).
  if (isManagedCredentialRef(credentialRef)) return true;
  // CS-GB-1 — eligibility judges the provider that will ACTUALLY dispatch
  // (this turn's route, ADR 1016, and the in-chat override included), not the raw run input. Before
  // this the loop read raw inputs and silently ignored both.
  const target = resolveConversationModelTarget({ runInputs: inputs, metadata: run.metadata, ...(modelOverride ? { override: modelOverride } : {}), route });
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
 * after a short backoff, ONLY for a rate limit or a transient 5xx
 * (`isTransientProviderFailure`; the 5xx half added 2026-10-03) —
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
  // The DAILY allowance is not a burst: a retry four seconds later meets the
  // same wall, so it is excluded here and surfaced as what it is.
  if (managedLimitCode(err)) return false;
  if (err instanceof AiProviderError) return err.code === 'provider_rate_limited';
  if (!(err instanceof Error)) return false;
  return /^[a-z][a-z0-9-]*_429:/i.test(err.message);
}

/** Upstream statuses that mean "overloaded right now", not "your request is
 *  wrong". MEASURED 2026-10-03 (ADR 0773 G-10b, Gemini eval): Google answered
 *  `gemini-3.8-flash` with 503 UNAVAILABLE "experiencing high demand" for
 *  minutes at a time, and every chat turn that met one died on the first call
 *  ("Agent tool turn failed: Provider 5xx.") with nothing in the log saying
 *  which status or why. 501 and 505+ are permanent, so they are not here. */
const TRANSIENT_5XX = new Set([500, 502, 503, 504]);

/** A failure worth exactly ONE retry: an upstream rate limit (above), a
 *  transient 5xx, or a stream the provider closed before its finish reason
 *  (ADR 1026). Same two shapes as the 429 check — the TYPED
 *  `provider_unavailable` from aiProvidersHost (BYOK) and the RAW error the
 *  managed dispatchers propagate. Retrying is safe for the same reason the 429
 *  retry is: the retried call is the model request alone, and no tool has run
 *  for it. */
export function isTransientProviderFailure(err: unknown): boolean {
  if (isProviderRateLimited(err)) return true;
  if (managedLimitCode(err)) return false;
  if (err instanceof AiProviderError) {
    return err.code === 'provider_unavailable'
      && (TRANSIENT_5XX.has(Number(err.details.status)) || err.details.reason === 'stream_incomplete');
  }
  if (isStreamIncompleteError(err)) return true;
  if (!(err instanceof Error)) return false;
  const m = /^[a-z][a-z0-9-]*_(\d{3}):/i.exec(err.message);
  return !!m && TRANSIENT_5XX.has(Number(m[1]));
}

/** What a retry log line may say about the failure: code and status, plus at
 *  most 200 chars of the provider's own message (its words, e.g. "high
 *  demand" — never our request, which is not part of the error). */
export function providerFailureFields(err: unknown): Record<string, unknown> {
  if (err instanceof AiProviderError) {
    const up = err.details.upstreamMessage;
    return {
      code: err.code,
      ...(err.details.status !== undefined ? { status: err.details.status } : {}),
      ...(typeof err.details.reason === 'string' ? { reason: err.details.reason } : {}),
      ...(typeof up === 'string' && up ? { upstreamMessage: up.slice(0, 200) } : {}),
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  const m = /^[a-z][a-z0-9-]*_(\d{3}):\s*([\s\S]*)$/i.exec(msg);
  return m ? { status: Number(m[1]), upstreamMessage: m[2]!.slice(0, 200) } : { message: msg.slice(0, 200) };
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
      if (!isTransientProviderFailure(err)) throw err;
      log.warn(isProviderRateLimited(err) ? 'provider_rate_limited_retrying_once' : 'provider_unavailable_retrying_once',
        { backoffMs, ...providerFailureFields(err) });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      try {
        return await call(r);
      } catch (again) {
        // The turn fails now; say why, or the next reader sees only "Provider 5xx."
        log.warn('provider_retry_failed', providerFailureFields(again));
        throw again;
      }
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


/**
 * ADR 1042 CHAN-F3 (security review H2) + ADR 0834 FW2-D1 (CHAN-F2) — the approvals a
 * turn may use, as ONE per-call grant every gate of the turn asks (the ADR 0132 scope
 * gate and the firewall), and how the turn settles them when its loop returns or throws.
 *
 *  - Not acting as the conversation's owner: nothing is usable (ADR 0834 D3).
 *  - An in-app turn: tool-wide (`conversation`) approvals cover any call of the tool; a
 *    `call` approval covers the one call whose arguments it was shown, and is DELETED
 *    after the turn spends it.
 *  - A channel-ingress turn: only `call` approvals count (exact arguments), each covers
 *    ONE call. The rows are CLAIMED (compare-and-delete) before the loop, so two
 *    instances cannot both spend one; `settle()` hands back the claims not spent.
 */
export async function approvalsForTurn(input: {
  channelTurn: boolean; actsAsOwner: boolean; approvals: readonly ToolApprovalRecord[];
}): Promise<{ grant: ApprovalGrant; settle: () => Promise<void> }> {
  const none = async (): Promise<void> => undefined;
  if (!input.actsAsOwner) return { grant: makeApprovalGrant([], { singleUse: true, requireDigest: true }), settle: none };
  if (!input.channelTurn) {
    const grant = makeApprovalGrant(input.approvals, { singleUse: false, requireDigest: false });
    return { grant, settle: () => deleteSpentCallApprovals(grant.spent()) };
  }
  const claimed = await claimApprovedToolApprovals(input.approvals);
  const grant = makeApprovalGrant(claimed, { singleUse: true, requireDigest: true });
  return {
    grant,
    settle: () => (claimed.length ? returnUnspentToolApprovals(claimed, new Set(grant.spent().map((r) => r.toolName))) : none()),
  };
}

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
  if (!conversationToolTurnEligible(run, agent, params.modelOverride, params.route)) return null;

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
  // ADR 0832 D3 — the member who caused an actorless turn (a channel post): it
  // bounds which orgs the turn's knowledge reads reach, and grants nothing.
  const orgScopeSubject = (run.metadata as { orgScopeSubject?: unknown } | undefined)?.orgScopeSubject;
  // ADR 1108 — the operator plan exemption the run was created under (reserved,
  // request-stamped); the tools re-check it against the allowlist per call.
  // It is BORROWED authority, exactly like a `bypass` (ADR 0834 D3): it reaches
  // the turn's tools ONLY when the person posting this turn IS the run's acting
  // principal. A participant posting into the operator's shared conversation, or
  // any channel-ingress turn, gets none — else a customer could spend the
  // operator's exemption on paywalled tools (priced ⟹ gated).
  const planExempt = planExemptOfRunMetadata(run.metadata as Record<string, unknown> | undefined)
    && typeof actingUserId === 'string'
    && toolAuthorityHolds(params.callerPrincipal, actingUserId)
    && !(run.metadata as Record<string, unknown> | undefined)?.['channelIngress']
    ? true : undefined;
  // ADR 0309 — the conversation the promise is made in rides the scope too, so
  // the schedule-followup tool's delivery destination is unforgeable (it takes
  // no conversation input; same threading rationale as actingUserId above).
  const chatSessionId = (run.metadata as { chatSessionId?: unknown } | undefined)?.chatSessionId;
  // ADR 0132 — the per-conversation stores (capability scope on ConversationMeta,
  // the tool-approval ledger, the ADR 0136 intent ledger) are keyed by the chat
  // SESSION id, exactly as `exchange/authorizeResolve.ts` and the exchange's
  // `composeChatContext` call key ConversationMeta; the run-derived gate id
  // (`runId:nodeId:0`) is only the fallback for a run with no session stamp.
  // Reading them by `params.conversationId` (the gate id) meant a scope, an
  // approval or a ledger set from the chat UI (which writes by session id) never
  // reached the loop for any chat-started run.
  const conversationStateKey = typeof chatSessionId === 'string' && chatSessionId ? chatSessionId : params.conversationId;
  // A run a tool ignites this turn is recorded here and materialized by the
  // EXCHANGE (one turnIndex allocator; the response owner) — see
  // `host/turnRunDispatch.ts` for the collision + invisibility this replaces.
  const runDispatchCollector = createTurnRunDispatchCollector();
  // ADR 1001 D7 — the chat ask: offered, and its sink wired, only when the
  // tenant's toggle is on. The sink is the ONLY way the tool can end a turn, and
  // only this transport supplies one (voice and the run lane never do).
  const chatAskOn = await isChatAskEnabled(run.tenantId);
  const clarificationCollector = chatAskOn ? createChatClarificationCollector() : undefined;
  // ADR 0324 — composed through the ONE scope composer (shared with the
  // realtime voice bridge) so the fail-closed fields can't drift per transport.
  const toolProvider = createScopedAgentToolProvider({
    tenantId: run.tenantId, runId, agentProfileId: identity.profileId,
    ...(typeof actingUserId === 'string' && actingUserId ? { actingUserId } : {}),
    ...(typeof personalTenant === 'string' && personalTenant ? { personalTenant } : {}),
    ...(typeof orgScopeSubject === 'string' && orgScopeSubject ? { orgScopeSubject } : {}),
    ...(planExempt ? { planExempt } : {}),
    ...(typeof chatSessionId === 'string' && chatSessionId ? { conversationId: chatSessionId } : {}),
    onRunDispatched: runDispatchCollector.sink,
    ...(clarificationCollector ? { onClarificationAsk: clarificationCollector.sink } : {}),
    ...(params.turnMessageId ? { turnMessageId: params.turnMessageId } : {}),
  });
  // ADR 0104 — apply a super-admin tool-allowlist override (per tenant+agent) to what
  // the chat agent is offered, exactly as runAgentDispatchLive does. Absent ⇒ the
  // manifest allowlist.
  const allowlistOverride = await resolveAgentToolAllowlistOverride(run.tenantId, agent.agentId);
  // ADR 0315 — one resolver: override (full-replace) ?? manifest ∪ baseline.
  // ADR 1042 D9 — a narrow channel turn replaces the allowlist (full-replace, the
  // override's own semantics) with the configured agent's read-only explicit tools.
  // Review N1 — a NARROW channel conversation stays narrow for EVERY turn, an in-app
  // turn the owner sends from the main chat included: its history holds outsiders'
  // text, so no full-tools turn may ever read it. Without a per-turn scope the
  // agent's own explicit allowlist (never the baseline) is filtered the narrow way.
  const turnScope = effectiveTurnScope(run, params.toolScope, allowlistOverride, agent.toolAllowlist);
  // ADR 1055 D4 — a `text-only` profile turns the baseline off for this agent.
  const offersBaseline = await agentOffersToolBaseline(run.tenantId, agent);
  const turnAllowlist = turnToolAllowlist(agent.toolAllowlist, allowlistOverride, turnScope, offersBaseline);
  const tools = compileAgentTools(agent, builtinAgentToolIds(), toolProvider.resolveTool, turnAllowlist)
    .filter((t) => chatAskOn || t.def.name !== ASK_USER_TOOL);
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
    // ADR 0821 D4 — the first round of a turn is the chat itself (`chat`); a later
    // round exists to process the PREVIOUS round's tool results, so it is
    // attributed to the owning feature of the tool(s) it called (the first one
    // with a known owner), else `chat`.
    let roundFeature = 'chat';
    callAIWithTools = async (r) => {
      const featureId = roundFeature;
      const round = await dispatchManagedToolsRound({
        userFacingProvider,
        tenantId: run.tenantId,
        featureId,
        // ADR 0693 — the acting participant, so a shared workspace does not pool
        // one free-tier allowance across everyone in it. Read from run.metadata
        // (fork-safe, already resolved above), and absent is legal.
        ...(typeof actingUserId === 'string' && actingUserId ? { actingSubject: actingUserId } : {}),
        messages: [{ role: 'system', content: r.systemPrompt ?? '' }, ...r.messages.map(toChatMessage)],
        // ADR 0148 A3 — tool-surface diet (gated; off ⇒ unchanged). Sibling site:
        // aiProviders/aiProvidersHost.ts (BYOK/workflow tools-round adapter).
        // ADR 1003 D4 — the one funnel, which also reports what the diet did.
        tools: dietToolSurface(r.tools, run.tenantId),
        ...(r.cacheConversation ? { cacheConversation: true } : {}),
      });
      roundFeature = round.toolUses.map((t) => featureForToolName(t.name)).find((f): f is string => f !== null) ?? 'chat';
      return toolRoundResult(round);
    };
  } else {
    // CS-GB-1 — the ONE resolver (override > stamp > same-provider class tier >
    // inputs); the loop previously read raw inputs, so a stamped group-tier
    // route, the in-chat model switch, AND an advisor's reasoning class were
    // all silently ignored on tool-loop turns.
    const targetInput: ConversationModelTargetInput = {
      runInputs: inputs, metadata: run.metadata,
      ...(params.modelOverride ? { override: params.modelOverride } : {}),
      ...(params.tier ? { tier: params.tier } : {}),
      route: params.route,
    };
    const target = resolveConversationModelTarget(targetInput);
    const provider = target.provider ?? '';
    const model = target.model;
    // BYOK-direct: resolve the tenant key (SR-1 — never enters an event/prompt).
    // Missing key ⇒ fall back so the single-completion path surfaces the canonical
    // `credential_unavailable` (no duplicated error vocabulary here).
    // ADR 0779 D6 (grade-code BYOKCD-9) — a key named for ANOTHER vendor is not
    // even read here: fall back, and the single-completion path refuses it with
    // the one typed answer (`credential_unavailable`, reason
    // `explicit_ref_wrong_provider`) before its own `resolveSecret`.
    if (explicitRefNamesOtherProvider(provider, credentialRef, CREDENTIAL_PROVIDERS) !== null) return null;
    const apiKey = await resolveUserNamedSecret(credentialRef, { tenantId: run.tenantId });
    if (!apiKey) return null;
    const adapter = createAiProvidersAdapter({
      runId, nodeId, tenantId: run.tenantId, attempt: 1,
      secrets: { [credentialRef]: apiKey },
      policyResolver,
    });
    callAIWithTools = adapter.callAIWithTools;
    loopProvider = provider;
    loopModel = model;
    // ADR 1016 D4b — the same resolve WITHOUT the tier AND WITHOUT the route:
    // differs only when the reasoning-class bump or the router chose the model
    // above, and is then the degrade target if that model cannot serve this key.
    loopFallbackModel = unchosenModelTarget(targetInput, target)?.model ?? null;
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
  // ADR 0775 D3 — a chat turn carries only the REGISTRY id (no roster id), so
  // every roster member sharing it binds (tightest wins). The registry id alone
  // never resolved a roster agent's permissions (`ARWF-4`); the identity
  // resolved above is FIRST-WINS on a shared agentRef, so it is not used here.
  const toolPermissions = await resolveAgentToolPermissionSet(run.tenantId, agent.agentId, agent.agentId);

  // ADR 0132 — per-conversation capability scope (the fourth AND-term). Resolved LIVE
  // each turn through the ONE resolver voice shares (ADR 0834 D5,
  // `conversationToolScope.ts`): config ∩ approved intent ledger, against THIS turn's
  // ceiling, approval decisions folded. Live (not a stamp) keeps a revocation honest on
  // `:fork` — tighter wins (ADR 0132 §replay correction). The run.metadata stamps are
  // best-effort provenance for the inspector, NEVER the enforcement source.
  // ADR 0834 D3 / FW2-CD-1 — the conversation's approvals are the OWNER's, given for the
  // owner's own actions. A run acting as someone else in the same conversation (a fork
  // re-stamps `actingUserId` to the forker but keeps `chatSessionId`) must not spend them,
  // and its held calls must not land in the owner's ledger as asks the owner never saw
  // coming. Folded only when the acting principal IS the owner.
  const actingPrincipal = typeof actingUserId === 'string' ? actingUserId : undefined;
  const approvals = await listToolApprovals(run.tenantId, conversationStateKey);
  const channelTurn = Boolean((run.metadata as Record<string, unknown> | undefined)?.['channelIngress']);
  const gate = await resolveConversationToolGate({
    tenantId: run.tenantId, conversationKey: conversationStateKey,
    // CHAN-F2 — the scope fold takes denials and in-app tool-wide approvals only. A `call`
    // approval, and every approval on a channel turn, is answered per call by the turn's
    // grant at the dispatch gate (it used to fold every row, claimed or not).
    ceiling: tools.map((t) => t.def.name), approvals: scopeFoldRows(approvals, channelTurn),
    foldApprovalsOnlyFor: actingPrincipal ?? '',
    run, ...(params.storage ? { storage: params.storage } : {}),
  });
  const capabilityScope = gate.scope;
  const actsAsOwner = toolAuthorityHolds(actingPrincipal, gate.ownerUserId);
  // ADR 1042 (security review H2) — a channel-ingress turn spends each approval on the
  // ONE call it lets through, so the next call of that tool (any arguments, any later
  // turn) asks the owner again. CHAN-F3: the approvals are CLAIMED (compare-and-delete)
  // here, before the loop, and only the rows this turn won are folded, so two instances
  // running turns on one conversation cannot both spend one approval. Unspent claims
  // go back after the loop (`returnUnspentToolApprovals`).
  const turnApprovals = await approvalsForTurn({ channelTurn, actsAsOwner, approvals });

  // ADR 0150 / ADR 0834 D3 — `bypass` is honoured only for the principal the tools ACT
  // AS (`run.metadata.actingUserId`). A participant can read and post in a shared
  // conversation, but their bypass would spend the owner's authority — so it runs `safe`
  // (fail-safe, not refused: the message itself is legitimate).
  const bypass = params.permissionMode === 'bypass' && toolAuthorityHolds(params.callerPrincipal, actingPrincipal);
  if (params.permissionMode === 'bypass' && !bypass) {
    log.info('permission_mode_bypass_refused', { conversationId: params.conversationId, caller: params.callerPrincipal ? 'other-principal' : 'none' });
  }

  // ADR 0135 / ADR 0834 D1 — the capability firewall, built by the ONE lane factory and
  // ALWAYS (the old skip — bypass + rule-less + default-allow — is how a lane could be
  // firewall-less at all). The factory wires decision + shadow logging.
  // H2 / CHAN-F3 + FW2-D1 — the hook asks the turn's grant per call; the grant records what it
  // spent, and the turn settles it once the loop returns (or throws).
  const { hook: firewall, posture: fw } = await buildLaneFirewall({
    tenantId: run.tenantId, lane: 'chat', bypass,
    grant: turnApprovals.grant,
    resource: params.conversationId, dedupeKey: runId,
  });
  // ADR 0397 — stamp the resolved posture for provenance. Written when there are rules, a
  // deny mode, or a platform floor — so an enforce/platform-governed run is not
  // misrepresented as ungoverned. It does not drive evaluation (re-resolved live).
  if (params.storage && (fw.rules.length > 0 || fw.mode !== 'default-allow' || fw.platformRules.length > 0)) {
    const md = computeFirewallStamp(run.metadata ?? {}, fw.rules, new Date().toISOString(), { mode: fw.mode, defaultDenyVerdict: fw.defaultDenyVerdict, platformRules: fw.platformRules });
    if (md) { try { await params.storage.updateRun(run.runId, { metadata: md }); run.metadata = md; } catch { /* best-effort */ } }
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
  // ADR 0889 D9 — opt-in tool-boundary capture for eval cases (off ⇒ the same executor).
  const chatExecuteTool = await maybeCaptureExecuteTool(toolProvider.executeTool, { tenantId: run.tenantId, runId, agentId: agent.agentId, segment: nodeId, lane: 'chat' });

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
      firewall, // decisions are logged by the hook itself (ADR 0834 D1)
      approvalGrant: turnApprovals.grant, // FW2-D1 — the same grant answers the ADR 0132 scope gate
      ...(onEvent ? { onEvent } : {}),
    },
    { callAIWithTools, executeTool: chatExecuteTool },
  );
  // A class-bumped model that can't serve this key (429 quota / 404 preview
  // access) degrades to the tenant's own selection instead of failing the turn.
  const loopRun = runLoopWithBumpFallback(runOnce, loopModel, loopFallbackModel);
  // CHAN-F3 — whether the loop returns or throws, spent claims stay deleted (the call
  // they allowed has run) and the rest go back.
  const { result: loop, modelUsed } = await loopRun.finally(() => turnApprovals.settle());

  // ADR 0132 Phase 3 — record any tool call the agent deferred for approval, with the
  // ask's origin and arguments, so the composer's conversation-tools control shows it
  // (ADR 0834 D6 — there is no `interrupt.approval` card for chat tool calls). Only for
  // the owner's own run (FW2-CD-1). Decision-preserving; best-effort — a ledger write
  // must not break the turn.
  const runDispatches = runDispatchCollector.drain();
  const clarificationAsk = clarificationCollector?.drain();
  const pendingApprovals = loop.pendingApprovals ?? [];
  for (const p of actsAsOwner ? pendingApprovals : []) {
    try { await recordToolApprovalRequested(run.tenantId, conversationStateKey, p.toolName, { ...(p.origin ? { origin: p.origin } : {}), input: p.input, lane: channelTurn ? 'channel' : 'app' }); }
    catch { /* best-effort — the agent's reply already told the user it is pending */ }
  }

  return {
    text: loop.finalText,
    events: loop.events,
    served: { provider: loopProvider, model: modelUsed, ...(isManagedCredentialRef(credentialRef) ? { managed: true as const } : {}) },
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
    // ADR 1001 D7 — the turn ended on a question; the exchange persists it.
    ...(clarificationAsk && !loop.error ? { clarificationAsk } : {}),
  };
}
