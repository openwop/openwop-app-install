/**
 * Conversation exchange/close handler (RFC 0005 §D/§E, MAS Phase 4).
 *
 * Drives the `core.conversationGate` lifecycle from the resolve endpoint. Per
 * RFC 0005 §D an `exchange` round-trips WITHOUT resuming the node: it appends
 * the user turn, dispatches the addressed agent, appends the agent turn (each as
 * a `conversation.exchanged` event + a `messages`-channel write), and leaves the
 * node suspended. Only `close` resumes the node (via the injected `resume`).
 *
 * Conversation history is reconstructed from the EVENT LOG (replay-safe), not
 * in-process state. Turn ids are deterministic (`conversation.ts`). The answering
 * agent's prompt is the RFC-0002 persona wrapped by the multi-agent scaffold;
 * cross-agent turns are narrative-cast `[Persona]: …` so the model never adopts
 * another agent's identity.
 */

import { getEventLog } from '../executor/eventLog.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../executor/agentRegistry.js';
import { getUser } from '../features/users/usersService.js';
import { composeAgentSystemPrompt } from './agentPromptScaffold.js';
import { getConversationMeta } from './conversationStore.js';
import { resolveSubjectAccess } from './subjectAccess.js';
import { composeKnowledgeForSubject } from './agentKnowledgeComposition.js';
import { createLogger } from '../observability/logger.js';
import { appendChannelMessage } from './channelsRuntime.js';
import { makeTurn, type ConversationTurn } from './conversation.js';
import { participantRosterOf, isParticipant } from './multiPartyConversation.js';
import { dispatchChat, type ChatMessage, type ProviderId } from '../providers/dispatch.js';
import { withLlmSpan, annotateActiveLlmSpan, PROVIDER_DISPATCH_SPAN } from '../observability/llmSpans.js';
import { contextEconomy } from './contextEconomy.js';
import { windowTranscript, transcriptBudgetConfig } from './transcriptBudget.js';
import { effectiveModelTarget, applyExchangeOverride } from '../features/model-router/applyRoute.js';
import { resolveModelRoute } from '../features/model-router/resolveRoute.js';
import type { TurnFeatures } from '../features/model-router/routeTurn.js';
import { recordUsage } from '../features/usage-analytics/usageRollupService.js';
import { extractConversationMemory } from '../features/memory-auto-extract/extractionBinding.js';
import { llmExtractFacts } from '../features/memory-auto-extract/memoryExtractor.js';
import { maybeAutotitleOnFirstExchange } from '../features/chat-autotitle/binding.js';
import { dispatchManagedChat, isManagedCredentialRef, managedProviderIdFromRef } from '../providers/managedProvider.js';
import { OpenwopError, type InterruptRecord, type RunRecord } from '../types.js';
import { isTerminalRunStatus } from '@openwop/openwop';
import { stripSecretsFromPersisted } from '../byok/ephemeralRunSecrets.js';
import { sanitizeFreeText } from '../byok/textRedaction.js';
import { resolveSecret } from '../byok/secretResolver.js';
import { resolveCompatDispatch } from './compatEndpoints.js';
import { claimExchange, commitExchange, releaseExchange } from './conversationExchangeIdem.js';
import { runConversationAgentToolTurn, conversationToolTurnEligible } from './conversationToolLoop.js';
import { appendSourcesFooter, type AgentEvent } from './agentDispatch.js';
import { resolveWebSearchPreference } from './webSearchPreference.js';
import type { ProviderPolicyResolver } from './index.js';
import type { Storage } from '../storage/storage.js';

const MAX_TOKENS = 1024;

/** Conservative top-K for owner-subject knowledge composed into a conversation
 *  turn (ADR 0084 Phase 2). Caps the grounding context a notebook/project chat
 *  injects per turn. */
const OWNER_KNOWLEDGE_TOP_K = 6;

const logger = createLogger('host.conversationExchange');

/** ADR 0120 Phase 2d — at conversation close, run consent-gated memory extraction
 *  over the full transcript (once). Fire-and-forget + FAIL-CLOSED in the op (no
 *  grant ⇒ no LLM call, no write), so it never blocks the close and is a no-op
 *  unless the acting user has granted extraction. */
function maybeExtractMemoryOnClose(run: RunRecord, turns: readonly ConversationTurn[]): void {
  const userId = run.metadata?.['actingUserId'];
  if (typeof userId !== 'string' || userId.length === 0) return;
  const transcript = turns
    .filter((t) => t.role === 'user' || t.role === 'agent')
    .map((t) => `${t.from}: ${asText(t.content)}`)
    .join('\n')
    .slice(0, 8000);
  if (!transcript.trim()) return;
  void extractConversationMemory(run.tenantId, userId, transcript, (text) => llmExtractFacts(run.tenantId, text))
    .catch((e) => logger.debug('memory extraction failed', { error: e instanceof Error ? e.message : String(e) }));
}

/** ADR 0130 Phase 3c — the model-router WRITE side (lazy first-turn stamp). On the
 *  first exchange where no route is stamped, ask the router (the decision owner) for
 *  a target and persist it into `run.metadata.modelRoute`. Written ONCE; thereafter
 *  read verbatim by `dispatchReply` (3b) on every turn + on `:fork` — never
 *  re-resolved on replay. BEST-EFFORT: any failure leaves the run's explicit model
 *  (router-inert is the safe default) and never breaks the turn. The org is the
 *  workspace-root (`scopeId ?? tenantId`), matching where the admin stored the config. */
/** Pure stamp decision: the new run.metadata to persist, or null when nothing should
 *  change. Returns null if ALREADY stamped (the replay/fork guard — never re-resolve)
 *  or if there is no routed target. Exported for unit coverage of the guard + shape. */
export function computeRouteStamp(
  metadata: Record<string, unknown>,
  target: { provider: string; model: string } | null,
): Record<string, unknown> | null {
  if (metadata['modelRoute']) return null; // already stamped (or a fork) — never re-resolve
  if (!target) return null;                // router off/unconfigured → keep the explicit model
  return { ...metadata, modelRoute: { provider: target.provider, model: target.model } };
}

async function maybeStampModelRoute(run: RunRecord, userText: string, storage: Storage): Promise<void> {
  if (run.metadata?.['modelRoute']) return; // fast-path the common already-stamped case
  try {
    const orgId = run.scopeId ?? run.tenantId;
    const features: TurnFeatures = { tokenEstimate: Math.ceil(userText.length / 4) };
    const decision = await resolveModelRoute(run.tenantId, orgId, features, Date.now());
    const metadata = computeRouteStamp(run.metadata, decision ? decision.target : null);
    if (!metadata) return;
    await storage.updateRun(run.runId, { metadata });
    run.metadata = metadata; // so THIS turn's dispatchReply reads the fresh stamp too
  } catch (e) {
    logger.debug('model-route stamp failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

/** RFC 0109 / ADR 0124 Phase 2d — resolve the `{ provider, model }` to stamp on the
 *  answering agent's turn (`agent.model`). Resolved the SAME way `dispatchReply` resolves
 *  the dispatch target — run inputs → the stamped `modelRoute` (verbatim on :fork) → the
 *  per-exchange override — so the provenance matches what actually dispatched. Non-secret
 *  (identifiers only); `undefined` when the model is the `'unknown'` sentinel (unresolved),
 *  so a turn never carries a meaningless stamp. */
export function resolveModelProvenance(run: RunRecord, override?: { provider?: string; model?: string }): { provider: string; model: string } | undefined {
  const inputs = (run.inputs ?? {}) as { provider?: unknown; model?: unknown };
  const target = applyExchangeOverride(
    effectiveModelTarget(
      typeof inputs.provider === 'string' ? inputs.provider : undefined,
      typeof inputs.model === 'string' ? inputs.model : 'unknown',
      run.metadata,
    ),
    override,
  );
  return target.provider && target.model && target.model !== 'unknown'
    ? { provider: target.provider, model: target.model }
    : undefined;
}

/** ADR 0118 Phase 2b — fire-and-forget write-through of a turn's recorded token
 *  usage into the rollup. Best-effort: a rollup failure must NEVER break the chat
 *  turn, so it is detached + the error swallowed (logged at debug). */
function recordTurnUsage(tenantId: string, provider: string, model: string, usage: { inputTokens?: number; outputTokens?: number } | undefined): void {
  if (!usage) return;
  void recordUsage(tenantId, {
    provider, model,
    ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
    at: new Date().toISOString(),
  }).catch((e) => logger.debug('usage rollup write failed', { error: e instanceof Error ? e.message : String(e) }));
}

/** ADR 0148 A2 — record the Anthropic prompt-cache token split on the active
 *  dispatch span (integer counts only; `cacheHit` is the wire-legal signal, set
 *  on `provider.usage` at the workflow emit site). No-op when caching is off
 *  (counts absent) or no span is active. */
function annotateCacheUsage(usage: { cachedReadTokens?: number; cacheWriteTokens?: number } | undefined): void {
  if (!usage) return;
  const cachedReadTokens = usage.cachedReadTokens ?? 0;
  if (cachedReadTokens <= 0 && (usage.cacheWriteTokens ?? 0) <= 0) return;
  annotateActiveLlmSpan({
    cachedReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    cacheHit: cachedReadTokens > 0,
  });
}

/** Resume callback (the route injects `resolveAndResume`) — only `close` uses it. */
export type ResumeFn = (interruptId: string, value: unknown) => Promise<void>;

export interface ConversationResolve {
  operation: 'exchange' | 'close';
  turn?: { from?: unknown; to?: unknown; content?: unknown; role?: unknown };
  outcome?: unknown;
  /** Client idempotency key (ADR 0067 §Phase 2): a stable id for THIS exchange
   *  attempt, reused verbatim across retries of the same send. When present, a
   *  retry returns the already-appended turns instead of dispatching again.
   *  (Event tailing — ADR 0067 §Phase 4 — is a frontend read optimization over
   *  `GET /runs/{id}/events?fromSeq`; the handler always folds full history here
   *  because the model prompt needs every prior turn.) */
  exchangeKey?: unknown;
  /** Per-EXCHANGE web-search/grounding override (ADR 0101 Phase 2 → deferral).
   *  When present it overrides `run.inputs.webSearch` for THIS turn, so flipping
   *  the chat toggle takes effect immediately (the run-input value is the
   *  open-time default). The conversation resume value is host-internal + not
   *  strictly validated, so this is not a wire-shape change. */
  webSearch?: unknown;
  /** Per-EXCHANGE permission mode (ADR 0150). `'safe'` (default) gates the high-blast-radius
   *  tools behind the firewall's approval card; `'bypass'` lets the agent act without asking
   *  (the user pre-authorized via the composer toolbar). Host-internal resume value (like
   *  `webSearch`) — not a wire-shape change; rides the run log ⇒ replay-deterministic. */
  permissionMode?: unknown;
}

export interface ConversationResolveResult {
  operation: 'exchange' | 'close';
  conversationId: string;
  turns: ConversationTurn[];
}

/** Reconstruct the conversation's turns from the durable event log (sorted by
 *  turnIndex). The open turn + every exchanged turn for this conversationId. */
async function loadTurns(storage: Storage, runId: string, conversationId: string): Promise<ConversationTurn[]> {
  const events = await storage.listEvents(runId);
  const turns: ConversationTurn[] = [];
  for (const e of events) {
    const p = (e.payload ?? {}) as { conversationId?: string; initialTurn?: ConversationTurn; turn?: ConversationTurn };
    if (p.conversationId !== conversationId) continue;
    if (e.type === 'conversation.opened' && p.initialTurn) turns.push(p.initialTurn);
    else if (e.type === 'conversation.exchanged' && p.turn) turns.push(p.turn);
  }
  return turns.sort((a, b) => a.turnIndex - b.turnIndex);
}

function asText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

/** Build the provider messages: the answering agent's scaffold as the single
 *  system message, then the prior turns. A prior `agent` turn written by a
 *  DIFFERENT agent than the one now answering is narrative-cast `[Persona]: …`. */
function turnsToMessages(turns: readonly ConversationTurn[], scaffold: string, answeringAgentId: string | undefined): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: scaffold }];
  for (const t of turns) {
    if (t.role === 'system') continue; // the open turn — the scaffold supersedes it
    if (t.role === 'user') {
      msgs.push({ role: 'user', content: asText(t.content) });
    } else {
      const otherAgent = t.agent?.agentId && t.agent.agentId !== answeringAgentId;
      const label = otherAgent ? `[${t.from}]: ` : '';
      msgs.push({ role: 'assistant', content: label + asText(t.content) });
    }
  }
  return msgs;
}

/** The acting human's display name for the scaffold — tenant-scoped, fail-soft. */
async function resolveUserName(run: RunRecord): Promise<string | null> {
  const uid = run.metadata?.['actingUserId'];
  if (typeof uid !== 'string' || uid.length === 0) return null;
  try {
    const user = await getUser(uid);
    if (!user || (user.tenantId && user.tenantId !== run.tenantId)) return null;
    const name = user.displayName?.trim();
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** Dispatch one agent reply for the conversation, honoring the run's provider
 *  config. Parity with `openwop-app.chat.turn`: mock + managed + BYOK-direct.
 *
 *  BYOK note (ADR 0067 §Phase 1): the per-turn node reads its key from
 *  `ctx.secrets[credentialRef]` (the executor pre-resolves a run's DECLARED
 *  secretRefs). The conversation handler has no `ctx`, so it resolves the key
 *  directly via `resolveSecret({ tenantId })` — which serves BOTH tenant-persisted
 *  (durable) and ephemeral per-run secrets. A long-lived conversation outlives an
 *  ephemeral key; when that key has expired the resolver returns null and we
 *  surface a clean `credential_unavailable` instead of a 500, so the UI can prompt
 *  the user to re-enter it rather than silently failing mid-thread. */
async function dispatchReply(run: RunRecord, messages: ChatMessage[], onDelta?: (delta: string) => Promise<void> | void, webSearchOverride?: boolean, modelOverride?: { provider?: string; model?: string }): Promise<string> {
  const inputs = (run.inputs ?? {}) as { provider?: unknown; model?: unknown; credentialRef?: unknown; webSearch?: unknown; compatEndpointId?: unknown };
  const credentialRef = typeof inputs.credentialRef === 'string' ? inputs.credentialRef : 'managed:openwop-free';
  // ADR 0130 Phase 3b — a stamped route (run.metadata.modelRoute, set once at run
  // creation) overrides the run's provider/model; read verbatim so :fork is
  // deterministic (the router never re-evaluates on replay).
  const route = effectiveModelTarget(
    typeof inputs.provider === 'string' ? inputs.provider : undefined,
    typeof inputs.model === 'string' ? inputs.model : 'unknown',
    run.metadata,
  );
  // ADR 0124 Phase 3 — a per-EXCHANGE model switch (the in-chat selector) is the
  // HIGHEST precedence for THIS turn (override > route stamp > run inputs). The
  // managed credential covers any managed model; a BYOK provider switch still
  // resolves against the run's credentialRef (the selector only offers models the
  // caller has a credential for).
  const target = applyExchangeOverride(route, modelOverride);
  const provider = target.provider;
  const model = target.model;
  // Native provider grounding for the single-completion path — BYOK only; the
  // managed tier has no native search (ADR 0101). A per-exchange override beats
  // the run-input open-time default.
  const webSearch = resolveWebSearchPreference(webSearchOverride, inputs.webSearch);

  if (provider === 'mock') {
    const r = await dispatchChat({ provider: 'mock', model, apiKey: '', messages, maxTokens: MAX_TOKENS, ...(onDelta ? { onDelta } : {}) });
    return r.completion;
  }
  if (isManagedCredentialRef(credentialRef)) {
    const r = await dispatchManagedChat({
      userFacingProvider: managedProviderIdFromRef(credentialRef),
      tenantId: run.tenantId,
      messages,
      maxTokens: MAX_TOKENS,
      ...(onDelta ? { onDelta } : {}),
    });
    return r.completion;
  }
  // `compat` (self-hosted / OpenAI-compatible, RFC 0108 / ADR 0121): route to the
  // tenant's configured endpoint. The base URL is resolved host-side and passed
  // ONLY to the compat dispatcher (which scrubs it from any error — §D); it never
  // enters an event/prompt/result. Native web search doesn't apply to a black-box
  // compat endpoint, so it is not forwarded.
  if (provider === 'compat') {
    const endpointId = typeof inputs.compatEndpointId === 'string' ? inputs.compatEndpointId : undefined;
    if (!endpointId) {
      throw new OpenwopError('validation_error', 'Conversation exchange needs a compatEndpointId for the compat provider.', 422, {});
    }
    const resolved = await resolveCompatDispatch(run.tenantId, endpointId);
    if (!resolved) {
      throw new OpenwopError('credential_unavailable', 'The configured self-hosted endpoint is unavailable — re-check the connection.', 422, { endpointId });
    }
    // ADR 0118 — instrument the dispatch with a span carrying ONLY provider/model
    // (the allowlist drops prompt/key/baseUrl); the §D base-URL never reaches it.
    const r = await withLlmSpan(PROVIDER_DISPATCH_SPAN, { provider: 'compat', model }, async () => {
      const out = await dispatchChat({ provider: 'compat', model, apiKey: resolved.apiKey, baseUrl: resolved.baseUrl, messages, maxTokens: MAX_TOKENS, ...(onDelta ? { onDelta } : {}) });
      annotateCacheUsage(out.usage); // ADR 0148 A2
      return out;
    });
    recordTurnUsage(run.tenantId, 'compat', model, r.usage); // ADR 0118 Phase 2b
    return r.completion;
  }
  // BYOK-direct: resolve the tenant's provider key and dispatch with it. SR-1:
  // the key never enters an event, prompt, or the result — only this call.
  if (!provider) {
    throw new OpenwopError('validation_error', 'Conversation exchange needs a provider for a BYOK credential.', 422, { credentialRef });
  }
  const apiKey = await resolveSecret(credentialRef, { tenantId: run.tenantId });
  if (!apiKey) {
    throw new OpenwopError(
      'credential_unavailable',
      `Provider key ${credentialRef} is unavailable (an ephemeral key may have expired). Re-enter your provider key to continue this conversation.`,
      422,
      { credentialRef },
    );
  }
  // ADR 0118 — span carries ONLY provider/model (the allowlist drops the prompt + key).
  const r = await withLlmSpan(PROVIDER_DISPATCH_SPAN, { provider, model }, async () => {
    const out = await dispatchChat({ provider: provider as ProviderId, model, apiKey, messages, maxTokens: MAX_TOKENS, ...(webSearch ? { webSearch: true } : {}), ...(onDelta ? { onDelta } : {}) });
    annotateCacheUsage(out.usage); // ADR 0148 A2
    return out;
  });
  recordTurnUsage(run.tenantId, provider, model, r.usage); // ADR 0118 Phase 2b
  // Surface native-grounding sources on the single-completion path too — same
  // Sources footer the agent tool loop appends (review fix: dispatchReply was
  // dropping r.citations, so plain grounded chat showed no sources).
  return appendSourcesFooter(r.completion, r.citations ?? []);
}

/**
 * Handle one `ConversationResolve` against a suspended `core.conversationGate`.
 * Returns the operation + the conversation's turns after the operation.
 */
/** Optional host deps for the conversation. `policyResolver` (the route injects
 *  `hostSuite.providerPolicyResolver`) enables the ADR 0089 agent tool loop — a
 *  tool-bearing @mentioned agent runs its observe→act loop instead of a single
 *  narration. Absent ⇒ the legacy single-completion path (no regression). */
export interface ConversationHostDeps {
  policyResolver?: ProviderPolicyResolver;
  /** ADR 0089 Phase 4 (Option B) — dispatch a deep-investigation @mentioned
   *  agent's tool loop as a SEPARATE persisted run (the synthetic
   *  `openwop-app.agent-mention` workflow), embedded in chat as a `workflow_run`
   *  bubble, instead of the inline turn loop. The route injects this (built from
   *  `startWorkflowRun({ storage, hostSuite }, …)`); it returns the new runId, or
   *  null when the workflow doesn't resolve. Absent ⇒ the inline path runs
   *  unchanged (no regression). */
  startAgentMentionRun?: (input: {
    tenantId: string;
    agentId: string;
    task: string;
    provider?: string;
    model?: string;
    credentialRef?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<string | null>;
}

/** ADR 0089 Phase 4 (Option B) — should THIS @mentioned agent be dispatched as a
 *  nested deep-investigation RUN rather than the inline turn loop? True iff the
 *  agent is tool-bearing (its tool loop would engage for the run's provider) AND
 *  the agent has DECLARED the opt-in (`investigationDepth: 'deep'`). Default-off:
 *  an agent without the field keeps today's inline behavior. */
export function conversationDeepInvestigationEligible(run: RunRecord, agent: ResolvedAgentManifest): boolean {
  return agent.investigationDepth === 'deep' && conversationToolTurnEligible(run, agent);
}

export async function handleConversationResolve(
  storage: Storage,
  interrupt: InterruptRecord,
  resumeValue: unknown,
  resume: ResumeFn,
  hostDeps?: ConversationHostDeps,
): Promise<ConversationResolveResult> {
  const data = (interrupt.data ?? {}) as { conversationId?: string };
  const conversationId = data.conversationId ?? `${interrupt.runId}:${interrupt.nodeId}:0`;
  const body = (resumeValue ?? {}) as ConversationResolve;
  const operation: 'exchange' | 'close' = body.operation === 'close' ? 'close' : 'exchange';
  // Per-exchange web-search override (undefined ⇒ fall back to run.inputs at dispatch).
  const exchangeWebSearch: boolean | undefined = typeof body.webSearch === 'boolean' ? body.webSearch : undefined;
  // Per-exchange permission mode (ADR 0150); anything but the explicit 'bypass' is safe (fail-safe).
  const exchangePermissionMode: 'safe' | 'bypass' | undefined = body.permissionMode === 'bypass' ? 'bypass' : body.permissionMode === 'safe' ? 'safe' : undefined;
  // ADR 0124 Phase 3 — per-exchange model switch (the in-chat selector). Host-internal
  // (not a wire-shape change, same as webSearch); undefined fields fall through.
  const bm = body as { model?: unknown; provider?: unknown };
  const exchangeModelOverride: { provider?: string; model?: string } | undefined =
    typeof bm.model === 'string' || typeof bm.provider === 'string'
      ? { ...(typeof bm.provider === 'string' ? { provider: bm.provider } : {}), ...(typeof bm.model === 'string' ? { model: bm.model } : {}) }
      : undefined;

  const run = await storage.getRun(interrupt.runId);
  if (!run) throw new OpenwopError('run_not_found', `run ${interrupt.runId} missing during conversation resolve`, 404);
  // Fail closed on a terminal run (ADR 0067 §Security): a completed/failed/
  // cancelled run's gate is gone — neither an exchange nor a close may land.
  // (The token route maps stale tokens already; this guards the node route.)
  if (isTerminalRunStatus(run.status)) {
    throw new OpenwopError('interrupt_already_resolved', `conversation run is ${run.status}; the gate is closed`, 409, { conversationId });
  }

  const existing = await loadTurns(storage, interrupt.runId, conversationId);
  const nextIndex = existing.length === 0 ? 1 : Math.max(...existing.map((t) => t.turnIndex)) + 1;
  const log = getEventLog();

  if (operation === 'close') {
    const finalTurn = makeTurn({
      conversationId, turnIndex: nextIndex, role: 'system', from: 'system',
      content: 'Conversation closed.', ts: Date.now(),
    });
    // stripSecretsFromPersisted — parity with ctx.emit; the outcome may echo data.
    await log.append({
      runId: interrupt.runId, nodeId: interrupt.nodeId, type: 'conversation.closed',
      payload: stripSecretsFromPersisted({ conversationId, turnIndex: nextIndex, finalTurn, ...(body.outcome !== undefined ? { outcome: body.outcome } : {}) }),
    });
    await resume(interrupt.interruptId, body.outcome ?? null); // resumes the suspended node
    // ADR 0120 Phase 2d — consent-gated memory auto-extraction at conversation close
    // (runs once, on the full transcript). Fire-and-forget + FAIL-CLOSED inside the
    // op (no grant ⇒ no LLM call), so it never blocks the close and is a no-op
    // unless the user has explicitly granted extraction.
    maybeExtractMemoryOnClose(run, existing);
    return { operation, conversationId, turns: [...existing, finalTurn] };
  }

  // ── exchange ───────────────────────────────────────────────────────────
  // Validate the turn (RFC 0005 §E — reject an empty/invalid exchange).
  const rawContent = body.turn?.content;
  if (rawContent === undefined || rawContent === null || asText(rawContent).trim().length === 0) {
    throw new OpenwopError('validation_error', 'Conversation exchange requires a non-empty turn.content.', 422, { conversationId });
  }

  // Idempotency (ADR 0067 §Phase 2): a stable client `exchangeKey` lets a retried
  // POST short-circuit instead of appending a second turn pair. The dedup index
  // is a host-ext sidecar — NOT a field on the normative conversation.exchanged
  // event (that would be a wire change). Absent key ⇒ legacy behavior (no dedup).
  const exchangeKey = typeof body.exchangeKey === 'string' && body.exchangeKey.length > 0 ? body.exchangeKey : undefined;
  if (exchangeKey) {
    const claim = await claimExchange(run.tenantId, conversationId, exchangeKey, Date.now());
    if (claim.outcome === 'committed') {
      // Already succeeded — the turns are already in `existing`; return them.
      return { operation, conversationId, turns: existing };
    }
    if (claim.outcome === 'in_progress') {
      throw new OpenwopError('interrupt_already_resolved', 'an exchange with this key is already in progress', 409, { conversationId });
    }
  }

  const to = typeof body.turn?.to === 'string' ? body.turn.to : undefined;
  // Redact secrets from the user's text BEFORE it is persisted OR sent to the
  // model (a pasted key must not leak into the event log, channel, or prompt).
  const userText = sanitizeFreeText(asText(rawContent));
  const userTurn = makeTurn({
    conversationId, turnIndex: nextIndex, role: 'user', from: 'user',
    content: userText, ts: Date.now(), groupId: conversationId, ...(to ? { to } : {}),
  });

  // Resolve the addressed agent + compose its persona scaffold (tenant-scoped).
  const agent = to ? await getAgentRegistry().resolve(to) : null;
  const tenantOk = !agent || !agent.ownerTenant || agent.ownerTenant === run.tenantId;
  const userName = await resolveUserName(run);
  // ADR 0079 Phase 5 — a boardroom conversation snapshots its strategy context on
  // the ConversationMeta; inject it into each advisor's prompt (absent for non-board
  // chats ⇒ omitted). Point-get, cheap; failure is non-fatal (no strategy block).
  //
  // KEY: a chat's ConversationMeta (board `injectedContextBlock`, project/notebook
  // `ownerSubject` grounding) is keyed by the chat `sessionId`, NOT the run-derived
  // gate conversationId (`${runId}:gate:0`). The chat carries its sessionId in the
  // run metadata (frontend `openConversationSession`); resolve by THAT so the
  // context actually reaches the prompt. Falls back to the gate conversationId for
  // runs opened without it (older clients / conformance), so it's purely additive.
  const chatSessionId = typeof run.metadata?.['chatSessionId'] === 'string' && run.metadata['chatSessionId'].length > 0
    ? run.metadata['chatSessionId'] as string
    : undefined;
  const convMeta = await getConversationMeta(run.tenantId, chatSessionId ?? conversationId).catch(() => null);

  // ADR 0084 Phase 2 — ground the turn in the conversation's OWNER-SUBJECT bound
  // knowledge (a notebook/project's KB sources). The block is composed via the
  // SHARED `composeKnowledgeForSubject` (same trusted-cite / untrusted-fence path
  // as live agent dispatch — notebook chunks stay fenced, never agent-trusted) and
  // injected into the agent's scaffold below.
  //
  // AUTHZ (IDOR guard): a conversation's `ownerSubject` may be membership/org-scoped
  // (a `private` project's chat). Resolve the EXCHANGING caller's access to that
  // subject — the human who authored THIS turn (the run's acting user) — before
  // composing. If access is `'none'`, compose NOTHING (skip silently — no leak).
  // `null` means the subject isn't membership-scoped (no resolver applies), so the
  // conversation's own visibility gate already governed entry ⇒ compose.
  //
  // Replay note: live retrieval (drift on :fork) is ACCEPTED, consistent with
  // agentDispatch — no recording mechanism. Best-effort: a composition failure
  // never breaks the turn.
  let knowledgeBlock = '';
  if (convMeta?.ownerSubject) {
    try {
      const callerUserId = run.metadata?.['actingUserId'];
      const caller = typeof callerUserId === 'string' && callerUserId.length > 0 ? callerUserId : undefined;
      const access = await resolveSubjectAccess(run.tenantId, convMeta.ownerSubject, caller);
      if (access !== 'none') {
        knowledgeBlock = await composeKnowledgeForSubject(run.tenantId, convMeta.ownerSubject, userText, { topK: OWNER_KNOWLEDGE_TOP_K });
      }
    } catch (err) {
      logger.warn('owner_knowledge_compose_failed', { conversationId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const scaffold = agent && agent.systemPrompt && tenantOk
    ? composeAgentSystemPrompt({ persona: agent.persona, role: agent.label, systemPrompt: agent.systemPrompt, userName, injectedContextBlock: convMeta?.injectedContextBlock, ...(knowledgeBlock ? { knowledgeBlock } : {}) })
    : 'You are a helpful AI assistant in a shared chat. Reply concisely.';
  const answeringId = agent && tenantOk ? agent.agentId : undefined;

  // RFC 0101 (ADR 0040 Phase 6) — multi-party speaker enforcement. A board-group
  // conversation declares a participant ROSTER (its `agent:<id>` members). When a
  // roster is declared, a `role:'agent'` turn MUST be spoken by a declared
  // participant; a non-participant speaker is rejected fail-closed (defense in
  // depth — the chat only ever seats cohort members, so this is an invariant
  // guard). `null` ⇒ no multi-party roster (1:1 / ungrouped chat) ⇒ the rule does
  // not apply (additive; legacy chats untouched). The agent INSTANCE id
  // (`answeringId`) is the RFC 0101 `speakerId`, stamped on the agent turn below.
  const participants = participantRosterOf(convMeta);
  if (participants && answeringId && !isParticipant(participants, answeringId)) {
    if (exchangeKey) await releaseExchange(run.tenantId, conversationId, exchangeKey);
    throw new OpenwopError(
      'validation_error',
      `Agent ${answeringId} is not a participant of this multi-party conversation.`,
      422,
      { conversationId, speakerId: answeringId },
    );
  }
  // ADR 0089 — a tool-bearing addressed agent runs its observe→act tool loop
  // (real retrieval/action) instead of a single narration. Gated on the host
  // injecting a `policyResolver` (the loop's provider adapter needs it); absent
  // ⇒ legacy single completion. Provider/credential capability is re-checked
  // inside `runConversationAgentToolTurn` (it falls back to null when the run's
  // provider has no native tool-calling path).
  const toolAgent = agent && tenantOk && answeringId && hostDeps?.policyResolver && conversationToolTurnEligible(run, agent)
    ? agent
    : null;

  // ADR 0089 Phase 4 (Option B) — when the @mentioned agent has DECLARED deep
  // investigation (`investigationDepth: 'deep'`) AND the host wired the nested
  // run-starter, dispatch its tool loop as a SEPARATE persisted run (embedded in
  // chat as a `workflow_run` bubble) instead of the inline turn loop. The agent
  // turn records the dispatched runId so the chat can attach the run's stream;
  // the run runs the SAME gated agentic path (`runAgentDispatchLive` via the
  // agent-runner node). Falls through to the inline path when not opted in or the
  // dep is absent (no regression). Honors the idempotency commit/release contract.
  if (agent && answeringId && toolAgent && hostDeps?.startAgentMentionRun && conversationDeepInvestigationEligible(run, agent)) {
    const inputs = (run.inputs ?? {}) as { provider?: unknown; model?: unknown; credentialRef?: unknown };
    let mentionRunId: string | null;
    try {
      mentionRunId = await hostDeps.startAgentMentionRun({
        tenantId: run.tenantId,
        agentId: answeringId,
        task: userText,
        ...(typeof inputs.provider === 'string' ? { provider: inputs.provider } : {}),
        ...(typeof inputs.model === 'string' ? { model: inputs.model } : {}),
        ...(typeof inputs.credentialRef === 'string' ? { credentialRef: inputs.credentialRef } : {}),
        metadata: { conversationId, parentRunId: interrupt.runId, mentionedAgentId: answeringId },
      });
    } catch (err) {
      if (exchangeKey) await releaseExchange(run.tenantId, conversationId, exchangeKey);
      const msg = err instanceof Error ? err.message : String(err);
      throw new OpenwopError('internal_error', `Deep investigation dispatch failed: ${msg}`, 502, { conversationId });
    }
    if (!mentionRunId) {
      // The synthetic workflow didn't resolve — fail closed rather than silently
      // dropping the user's request (releases the claim so a retry is clean).
      if (exchangeKey) await releaseExchange(run.tenantId, conversationId, exchangeKey);
      throw new OpenwopError('internal_error', 'Deep investigation workflow did not resolve.', 502, { conversationId });
    }
    const agentIndex = nextIndex + 1;
    // The agent turn is a `workflow_run` mention: its content references the
    // dispatched run so the chat embeds it as a streamed run bubble (the
    // run-agnostic `runWorkflowMention` seam). SR-1 parity on persist.
    const modelProv = resolveModelProvenance(run, exchangeModelOverride);
    const agentTurn = makeTurn({
      conversationId, turnIndex: agentIndex, role: 'agent',
      from: answeringId, content: { kind: 'workflow_run', runId: mentionRunId, agentId: answeringId },
      ts: Date.now(), groupId: conversationId, agent: { agentId: answeringId, ...(modelProv ? { model: modelProv } : {}) },
      // RFC 0101 — explicit per-turn speaker attribution (the agent instance id).
      speakerId: answeringId,
    });
    for (const [idx, turn] of [[nextIndex, userTurn], [agentIndex, agentTurn]] as const) {
      await log.append({
        runId: interrupt.runId, nodeId: interrupt.nodeId, type: 'conversation.exchanged',
        payload: stripSecretsFromPersisted({ conversationId, turnIndex: idx, turn }),
      });
    }
    appendChannelMessage(interrupt.runId, 'messages', { messageId: userTurn.messageId, role: 'user', content: userText, timestamp: new Date(userTurn.ts).toISOString() });
    appendChannelMessage(interrupt.runId, 'messages', {
      messageId: agentTurn.messageId, role: 'assistant',
      // The channel mirror carries a string; the authoritative `conversation.exchanged`
      // turn above holds the structured `workflow_run` reference the chat reads.
      content: JSON.stringify({ kind: 'workflow_run', runId: mentionRunId, agentId: answeringId }),
      timestamp: new Date(agentTurn.ts).toISOString(), agentId: answeringId,
    });
    if (exchangeKey) await commitExchange(run.tenantId, conversationId, exchangeKey, nextIndex, agentIndex, Date.now());
    return { operation, conversationId, turns: [...existing, userTurn, agentTurn] };
  }

  // Dispatch FIRST, then emit user + agent turns together. Idempotency: a failed
  // dispatch (rate-limit/cap) emits NOTHING, so a client retry can't leave a
  // dangling user turn that bumps turnIndex and duplicates the message.
  // ADR 0148 A1 — token-budgeted transcript (gated; off ⇒ full history as before).
  // Window the PRIOR turns (never the current `userTurn`, appended after) to the
  // last-k / char budget; the event log stays full-fidelity, so this is a
  // deterministic, replay-safe, presentation-only transform.
  const { kept: budgetedExisting, omittedCount } = contextEconomy().transcriptBudget
    ? windowTranscript(existing, transcriptBudgetConfig(), (t) => asText(t.content).length)
    : { kept: existing, omittedCount: 0 };
  const messages = turnsToMessages([...budgetedExisting, userTurn], scaffold, answeringId);
  if (omittedCount > 0 && messages[0]?.role === 'system') {
    // Tell the model context was elided so it doesn't assume it has everything.
    messages[0] = {
      ...messages[0],
      content: `${asText(messages[0].content)}\n\n[Context budget: ${omittedCount} earlier turn(s) omitted; the ${budgetedExisting.length} most recent are shown.]`,
    };
  }
  // ADR 0079 §Phase 1 — stream the reply's tokens as canonical `ai.message.chunk`
  // events on the gate node so a subscribed client renders them live. Transient
  // (stream-only, never folded into a channel); the authoritative turn is the
  // `conversation.exchanged` event below. Best-effort: a delta-emit failure must
  // not break the reply.
  const onDelta = async (delta: string): Promise<void> => {
    try {
      await log.append({
        runId: interrupt.runId, nodeId: interrupt.nodeId, type: 'ai.message.chunk',
        // SR-1 parity: strip run secrets from the streamed delta before it is
        // persisted, exactly as the authoritative `conversation.exchanged` turn
        // below — the transient chunk lands in the durable event log too, so a
        // model that echoed a secret must not leak it ahead of the sanitized turn.
        payload: stripSecretsFromPersisted({ chunk: delta, isLast: false }),
      });
    } catch { /* best-effort delta emission */ }
  };
  // ADR 0089 Phase 1/2 — record the tool loop's `agent.*` events (reasoned /
  // toolCalled / toolReturned, RFC 0064) on the gate node so a subscribed client
  // renders live tool progress ("searching… / fetched N sources"). SR-1 parity;
  // best-effort (observability must never break the turn).
  const onAgentEvent = async (ev: AgentEvent): Promise<void> => {
    try {
      await log.append({
        runId: interrupt.runId, nodeId: interrupt.nodeId, type: ev.type,
        payload: stripSecretsFromPersisted({ ...ev }),
      });
    } catch { /* best-effort agent-event emission */ }
  };
  // The generate → emit → commit body. Runs synchronously by default (its throw
  // becomes the route's clean 4xx/5xx); under the async flag it runs in the
  // background after the POST is acked (see below).
  const finishExchange = async (): Promise<ConversationTurn[]> => {
    let completion: string;
    try {
      // ADR 0089 — tool-bearing agent: run the observe→act loop. A `null` return
      // (managed tier / non-tool provider / no resolvable tool / missing key)
      // falls through to the single completion below, so non-tool agents and
      // unsupported providers are unaffected.
      let toolText: string | null = null;
      if (toolAgent && hostDeps?.policyResolver) {
        const toolTurn = await runConversationAgentToolTurn({
          run, agent: toolAgent, systemPrompt: scaffold, history: messages.slice(1),
          runId: interrupt.runId, nodeId: interrupt.nodeId,
          conversationId, storage,
          policyResolver: hostDeps.policyResolver, onEvent: onAgentEvent,
          ...(exchangeWebSearch !== undefined ? { webSearch: exchangeWebSearch } : {}),
          ...(exchangePermissionMode !== undefined ? { permissionMode: exchangePermissionMode } : {}),
        });
        if (toolTurn) {
          if (toolTurn.error) {
            throw new OpenwopError('internal_error', `Agent tool turn failed: ${toolTurn.error.message}`, 502, { conversationId, toolError: toolTurn.error.code });
          }
          toolText = toolTurn.text;
          // The tool path has no token streaming (callAIWithTools is non-stream);
          // emit the settled answer once so subscribers render it before the turn.
          await onDelta(toolText);
        }
      }
      // ADR 0130 Phase 3c — stamp the routed model ONCE (first exchange) so
      // dispatchReply's 3b read picks it up this turn and every turn/fork after.
      await maybeStampModelRoute(run, userText, storage);
      completion = sanitizeFreeText(toolText ?? await dispatchReply(run, messages, onDelta, exchangeWebSearch, exchangeModelOverride));
    } catch (err) {
      // Nothing was persisted (dispatch-first), so the turn is cleanly retryable.
      // Release the idempotency claim so a retry isn't told `in_progress` until
      // the stale window elapses — the exchange genuinely produced no turns.
      if (exchangeKey) await releaseExchange(run.tenantId, conversationId, exchangeKey);
      if (err instanceof OpenwopError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new OpenwopError('internal_error', `Conversation reply failed: ${msg}`, 502, { conversationId });
    }

    const agentIndex = nextIndex + 1;
    const modelProv = resolveModelProvenance(run, exchangeModelOverride);
    const agentTurn = makeTurn({
      conversationId, turnIndex: agentIndex, role: 'agent',
      from: answeringId ?? 'assistant', content: completion, ts: Date.now(), groupId: conversationId,
      ...(answeringId ? { agent: { agentId: answeringId, ...(modelProv ? { model: modelProv } : {}) } } : {}),
      // RFC 0101 — explicit per-turn speaker attribution (the agent instance id).
      // Absent on the fallback `'assistant'` turn (no resolved agent ⇒ no roster
      // member to attribute; that path is the 1:1 chat, not a multi-party council).
      ...(answeringId ? { speakerId: answeringId } : {}),
    });
    for (const [idx, turn] of [[nextIndex, userTurn], [agentIndex, agentTurn]] as const) {
      await log.append({
        runId: interrupt.runId, nodeId: interrupt.nodeId, type: 'conversation.exchanged',
        payload: stripSecretsFromPersisted({ conversationId, turnIndex: idx, turn }),
      });
    }
    appendChannelMessage(interrupt.runId, 'messages', { messageId: userTurn.messageId, role: 'user', content: userText, timestamp: new Date(userTurn.ts).toISOString() });
    appendChannelMessage(interrupt.runId, 'messages', {
      messageId: agentTurn.messageId, role: 'assistant', content: completion,
      timestamp: new Date(agentTurn.ts).toISOString(), ...(answeringId ? { agentId: answeringId } : {}),
    });

    // Commit the idempotency claim now that both turns are durable: a later retry
    // of this key short-circuits to the appended turns instead of dispatching again.
    if (exchangeKey) await commitExchange(run.tenantId, conversationId, exchangeKey, nextIndex, agentIndex, Date.now());

    // ADR 0151 — first-exchange auto-titling. Fire-and-forget + FAIL-CLOSED inside
    // the binding (no chat session / toggle off / already titled / manual rename ⇒
    // no-op), so it never blocks the turn and runs at most once per conversation.
    // Emits `conversation.titled` on the run log so the FE rail/tab updates live.
    {
      const actingUserId = run.metadata?.['actingUserId'];
      maybeAutotitleOnFirstExchange({
        tenantId: run.tenantId,
        userId: typeof actingUserId === 'string' && actingUserId.length > 0 ? actingUserId : undefined,
        chatSessionId,
        userText,
        replyText: completion,
        storage,
        onTitled: (title) => {
          void log.append({
            runId: interrupt.runId, nodeId: interrupt.nodeId, type: 'conversation.titled',
            payload: stripSecretsFromPersisted({ conversationId, ...(chatSessionId ? { chatSessionId } : {}), title }),
          }).catch(() => { /* best-effort title event */ });
        },
      });
    }

    return [...existing, userTurn, agentTurn];
  };

  // ADR 0079 §Phase 3 — async exchange (flag-gated, default OFF). When enabled,
  // ack the POST immediately and finish generation in the BACKGROUND so the reply
  // rides the CDN-bypassing run SSE instead of a blocking `/api` POST — removing
  // the ~60s Firebase ceiling for long replies. The reply's `ai.message.chunk`
  // deltas and the authoritative `conversation.exchanged` turns stream on the run
  // event log; the client waits for that settle signal before reconciling. A
  // failure AFTER the ack can no longer be a POST 4xx, so it surfaces as a
  // terminal `ai.message.error` event (must-fix #2) and releases the claim
  // (must-fix #1). The synchronous path below is unchanged when the flag is unset.
  // ADR 0089 Phase 0/1 — ALWAYS take the async path for a tool-bearing agent: a
  // multi-round observe→act loop (model + tool latency per round) must not block
  // the HTTP turn / the ~60s CDN ceiling. It rides the run SSE like the flagged
  // async path. Non-tool turns keep the global-flag default.
  if (process.env.OPENWOP_CONVERSATION_EXCHANGE_ASYNC === 'true' || toolAgent) {
    void finishExchange().catch(async (err) => {
      const code = err instanceof OpenwopError ? err.code : 'internal_error';
      const message = err instanceof Error ? err.message : String(err);
      try {
        await log.append({
          runId: interrupt.runId, nodeId: interrupt.nodeId, type: 'ai.message.error',
          // SR-1 parity: the provider error message is raw text — strip run
          // secrets before persisting it to the durable event log.
          payload: stripSecretsFromPersisted({ conversationId, turnIndex: nextIndex, code, message }),
        });
      } catch { /* best-effort terminal event */ }
      // Idempotent with finishExchange's inner dispatch-catch release; covers a
      // post-dispatch failure (emit/commit). A hard crash that skips even this is
      // bounded by the STALE_MS TTL in claimExchange.
      if (exchangeKey) { try { await releaseExchange(run.tenantId, conversationId, exchangeKey); } catch { /* best-effort */ } }
    });
    // Ack: the user/agent turns are NOT yet emitted, so report the pre-exchange
    // turns. The client keeps its optimistic bubble until the SSE settle signal.
    return { operation, conversationId, turns: existing };
  }

  return { operation, conversationId, turns: await finishExchange() };
}
