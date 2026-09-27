/**
 * Model-target resolution + provider dispatch for one conversation turn
 * (ADR 0327 P1). Owns the ONE conversation model resolution path (CS-GB-1 —
 * override > stamped route > same-provider class tier > run inputs), the
 * route-stamp write side (ADR 0130 Phase 3c), turn provenance (ADR 0124
 * Phase 2d), usage/rollup/span annotations, prompt assembly, and
 * `dispatchReply` — the mock/managed/subscription/compat/BYOK dispatch braid.
 */

import { fenceUntrustedBlock } from '../untrustedContent.js';
import { createLogger } from '../../observability/logger.js';
import { dispatchChat, type ChatMessage, type ProviderId } from '../../providers/dispatch.js';
import { withLlmSpan, annotateActiveLlmSpan, PROVIDER_DISPATCH_SPAN } from '../../observability/llmSpans.js';
import { resolveConversationModelTarget, type ConversationModelTierInput } from '../../features/model-router/applyRoute.js';
// One rate-limit vocabulary across both dispatch seams (grade-pass RESIL-1/2);
// import direction is safe — conversationToolLoop never imports this module.
import { isProviderRateLimited, rateLimitBackoffMs } from '../conversationToolLoop.js';
import { resolveModelRoute } from '../../features/model-router/resolveRoute.js';
import type { TurnFeatures } from '../../features/model-router/routeTurn.js';
import { recordUsage } from '../../features/usage-analytics/usageRollupService.js';
import { dispatchManagedChat, isManagedCredentialRef, managedProviderIdFromRef } from '../../providers/managedProvider.js';
import { OpenwopError, type RunRecord } from '../../types.js';
import { resolveSecret } from '../../byok/secretResolver.js';
import { resolveCompatDispatch } from '../compatEndpoints.js';
import { isSubscriptionCredentialRef, resolveSubscriptionCredential, subscriptionDispatchEndpoint, subscriptionProviderOfRef } from '../../byok/subscriptionCredential.js';
import { assertSubscriptionProviderPermitted } from '../../byok/subscriptionCredentialScope.js';
import { COPILOT_PROVIDER_ID, copilotEndpoint } from '../../aiProviders/copilotSubscription.js';
import { appendSourcesFooter } from '../agentDispatch.js';
import { resolveWebSearchPreference } from '../webSearchPreference.js';
import { checkByokChatBudget, recordByokChatUsage } from '../../aiProviders/byokChatBudget.js';
import type { Storage } from '../../storage/storage.js';
import type { ConversationTurn } from '../conversation.js';
import { asText, isContentParts } from './contentParts.js';

const MAX_TOKENS = 1024;

// Same component name as the orchestrator — log identity is an ops surface.
const logger = createLogger('host.conversationExchange');

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

export async function maybeStampModelRoute(run: RunRecord, userText: string, storage: Storage, conversationKind?: string, hasAttachment?: boolean): Promise<void> {
  if (run.metadata?.['modelRoute']) return; // fast-path the common already-stamped case
  try {
    const orgId = run.scopeId ?? run.tenantId;
    // ADR 0130 Phase 6 — the conversation kind is SERVER-derived (ConversationMeta
    // at this exchange's compose step), so a `conversationKind` rule can't be
    // gamed by a client-asserted signal. Stamped once like every route (a room
    // that BECOMES a board after its first turn keeps its stamp — the documented
    // trade against per-turn re-resolution; canonical board chats are group-typed
    // from birth via ensureBoardChat, which is the incident's case).
    // CHAT-FIRST-PORT A8 — `hasAttachment` is the turn's REAL attachment presence
    // (image/file parts), fed by the caller so the `attachment` rule + the
    // multimodal difficulty bump genuinely fire (previously never populated).
    const features: TurnFeatures = {
      tokenEstimate: Math.ceil(userText.length / 4),
      ...(conversationKind ? { conversationKind } : {}),
      ...(hasAttachment ? { hasAttachment: true } : {}),
    };
    const decision = await resolveModelRoute(run.tenantId, orgId, features, Date.now());
    const metadata = computeRouteStamp(run.metadata, decision ? decision.target : null);
    if (!metadata) return;
    await storage.updateRun(run.runId, { metadata });
    run.metadata = metadata; // so THIS turn's dispatchReply reads the fresh stamp too
  } catch (e) {
    // CS-GB-3 — warn, not debug: a mis-stamped board chat silently ran on the
    // wrong tier for its whole life and was invisible in ops.
    logger.warn('model-route stamp failed', { runId: run.runId, error: e instanceof Error ? e.message : String(e) });
  }
}

/** RFC 0109 / ADR 0124 Phase 2d — resolve the `{ provider, model }` to stamp on the
 *  answering agent's turn (`agent.model`). Resolved the SAME way `dispatchReply` resolves
 *  the dispatch target — run inputs → the stamped `modelRoute` (verbatim on :fork) → the
 *  per-exchange override — so the provenance matches what actually dispatched. Non-secret
 *  (identifiers only); `undefined` when the model is the `'unknown'` sentinel (unresolved),
 *  so a turn never carries a meaningless stamp. */
export function resolveModelProvenance(run: RunRecord, override?: { provider?: string; model?: string }, tier?: ConversationModelTierInput): { provider: string; model: string } | undefined {
  const inputs = (run.inputs ?? {}) as { provider?: unknown; model?: unknown };
  // CS-GB-1 — the ONE resolver (override > stamp > same-provider class tier >
  // inputs), so provenance always names what actually dispatched.
  const target = resolveConversationModelTarget({ runInputs: inputs, metadata: run.metadata, ...(override ? { override } : {}), ...(tier ? { tier } : {}) });
  return target.provider && target.model && target.model !== 'unknown'
    ? { provider: target.provider, model: target.model }
    : undefined;
}

/** ADR 0118 Phase 2b — fire-and-forget write-through of a turn's recorded token
 *  usage into the rollup. Best-effort: a rollup failure must NEVER break the chat
 *  turn, so it is detached and the error is not rethrown.
 *
 *  ADR 0695 (`UAC-3`) — logged at WARN, not debug. `recordUsage` now throws only
 *  after losing 8 compare-and-swap attempts, i.e. sustained contention on one
 *  (tenant, provider, model) key. That is exactly the condition under which usage
 *  figures silently drift, so it must not sit at a level nobody ships. Detached
 *  still, so the turn is untouched. */
function recordTurnUsage(tenantId: string, provider: string, model: string, usage: { inputTokens?: number; outputTokens?: number } | undefined): void {
  if (!usage) return;
  void recordUsage(tenantId, {
    provider, model,
    ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
    at: new Date().toISOString(),
  }).catch((e) => logger.warn('usage_rollup_write_failed', { error: e instanceof Error ? e.message : String(e) }));
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

/** Build the provider messages: the answering agent's scaffold as the single
 *  system message, then the prior turns. A prior `agent` turn written by a
 *  DIFFERENT agent than the one now answering is narrative-cast `[Persona]: …`
 *  AND fenced as untrusted (ADR 0665 D2). `personaNameById` supplies the display
 *  names (ADR 0665 D5); this function stays PURE — the caller resolves them.
 *  A multimodal user turn passes its REAL parts through (the dispatchers convert
 *  per-provider — audio→inlineData/File-API, image→image_url, …); only the
 *  text projection goes into assistant-side narrative casts. */
export function turnsToMessages(
  turns: readonly ConversationTurn[],
  scaffold: string,
  answeringAgentId: string | undefined,
  personaNameById?: ReadonlyMap<string, string>,
): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: scaffold }];
  for (const t of turns) {
    if (t.role === 'system') continue; // the open turn — the scaffold supersedes it
    if (t.role === 'user') {
      msgs.push({ role: 'user', content: isContentParts(t.content) ? t.content : asText(t.content) });
    } else {
      const otherAgent = t.agent?.agentId && t.agent.agentId !== answeringAgentId;
      // ADR 0665 D2 — TAKE THE MEET at the cross-agent boundary.
      //
      // `SECURITY/threat-model-prompt-injection.md` §2a: the trust of a segment composed
      // from several inputs MUST be the meet of its inputs, and "the fail-open default is
      // the violation — a composition site that treats MISSING contentTrust as trusted
      // violates untrusted-by-default". Invariant `tool-result-trust-monotone`, tier
      // protocol, severity high.
      //
      // Another agent's turn is composed content arriving at a NEW reader. Its own context
      // may have carried untrusted ingresses — bound-knowledge chunks (already fenced in
      // ITS prompt), tool results, borrowed twin recall — so relaying it here as a bare
      // `role:'assistant'` is exactly the fail-open default.
      //
      // STRUCTURAL, not a per-turn taint bit: `ConversationTurn` carries no trust field, the
      // untrusted-ness of the speaker's context is discarded before the turn is persisted,
      // and it cannot be recovered at read time (bindings change). A write-time bit would
      // mean a new field on the RFC 0005 conversation-turn schema — a wire claim. The corpus
      // names this coarser strategy conforming: "over-tagging is conformant, coarser is
      // safer" (§2a bullet 4, conservative static reader classification).
      //
      // NOT fenced: a turn by the SAME agent now answering. Recorded as a deviation in
      // ADR 0665 D2 (`BADV-3a`), not as a carve-out the corpus grants — §2a recognises only
      // structural isolation. It is defensible because that segment never reaches a NEW
      // reader, so it raises no segment's trust; it is not dressed up as compliance.
      // ADR 0665 D5 — the CAST LIST says names. `t.from` is the raw agent slug the
      // exchange writes; this docblock, `FEATURES.md`, and the synthesis prompt
      // ("name each dissent and who holds it") all promise a narrative `[Name]:`.
      // Fall back to the slug, NEVER to a blank: an unnamed speaker in a council
      // transcript is worse than the slug it replaced.
      const speaker = (t.agent?.agentId ? personaNameById?.get(t.agent.agentId) : undefined) || t.from;
      const rendered = otherAgent
        ? fenceUntrustedBlock(`[${speaker}]: ${asText(t.content)}`, `another participant (${speaker})`)
        : asText(t.content);
      msgs.push({ role: 'assistant', content: rendered });
    }
  }
  return msgs;
}

/** ADR 0178 — the non-blocking BYOK spend soft-warning that rides the host-internal
 *  dispatch/exchange result object (NOT the wire, NOT a persisted turn/event). */
export interface ByokBudgetNotice {
  code: 'byok_budget_warning';
  usedPct: number;
  cap: number;
  /** ADR 0396 P3 — which lane warned: the superadmin org backstop (ADR 0178)
   *  or the user's own personal cap. Host-internal discriminant, not a new
   *  envelope kind; absent ⇒ 'org' (pre-0396 consumers unchanged). */
  scope?: 'org' | 'personal';
}

/** XCH-GRP-3 — the @mentioned agent declared `investigationDepth:'deep'`, but
 *  this room has spent its deep-run budget for the window, so the turn DEGRADED
 *  to a normal inline reply instead of dispatching a tool-running run. The user
 *  still got an answer; this says why it wasn't the deeper one (a silent degrade
 *  would let them believe they got an investigation they didn't). Same
 *  host-internal, non-wire, non-persisted posture as the BYOK notice. */
export interface DeepRunBudgetNotice {
  code: 'deep_run_budget_exceeded';
  limit: number;
}

/** The non-blocking advisories one exchange may carry back to the client. */
export type ExchangeNotice = ByokBudgetNotice | DeepRunBudgetNotice;

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
export async function dispatchReply(run: RunRecord, messages: ChatMessage[], onDelta?: (delta: string) => Promise<void> | void, webSearchOverride?: boolean, modelOverride?: { provider?: string; model?: string }, tier?: ConversationModelTierInput): Promise<{ completion: string; budgetWarning?: ByokBudgetNotice }> {
  const inputs = (run.inputs ?? {}) as { provider?: unknown; model?: unknown; credentialRef?: unknown; webSearch?: unknown; compatEndpointId?: unknown };
  const credentialRef = typeof inputs.credentialRef === 'string' ? inputs.credentialRef : 'managed:openwop-free';
  // ADR 0130 Phase 3b + ADR 0124 Phase 3 + CS-GB-1 — the ONE resolver:
  // exchange override > stamped route (verbatim on :fork) > SAME-provider
  // reasoning-class default (group rooms) > run inputs. The managed credential
  // covers any managed model; a BYOK provider switch still resolves against the
  // run's credentialRef (the selector only offers models the caller holds a
  // credential for).
  const target = resolveConversationModelTarget({ runInputs: inputs, metadata: run.metadata, ...(modelOverride ? { override: modelOverride } : {}), ...(tier ? { tier } : {}) });
  const provider = target.provider;
  const model = target.model;
  // Native provider grounding for the single-completion path — BYOK only; the
  // managed tier has no native search (ADR 0101). A per-exchange override beats
  // the run-input open-time default.
  const webSearch = resolveWebSearchPreference(webSearchOverride, inputs.webSearch);

  if (provider === 'mock') {
    const r = await dispatchChat({ provider: 'mock', model, apiKey: '', messages, maxTokens: MAX_TOKENS, ...(onDelta ? { onDelta } : {}) });
    return { completion: r.completion };
  }
  if (isManagedCredentialRef(credentialRef)) {
    // ADR 0721 — the acting subject MUST reach the managed dispatch, or
    // `managedUsageBucket` charges the POOLED tenant bucket and one free-tier day
    // serves an entire shared workspace. This is the same `run.metadata.actingUserId`
    // the BYOK budget below already reads; the managed branch simply never threaded it.
    const managedActingSubject = typeof run.metadata?.['actingUserId'] === 'string'
      ? (run.metadata['actingUserId'] as string)
      : undefined;
    const r = await dispatchManagedChat({
      userFacingProvider: managedProviderIdFromRef(credentialRef),
      tenantId: run.tenantId,
      messages,
      maxTokens: MAX_TOKENS,
      ...(managedActingSubject ? { actingSubject: managedActingSubject } : {}),
      ...(onDelta ? { onDelta } : {}),
    });
    return { completion: r.completion };
  }
  // RFC 0121 AT-OWN-RISK (ADR 0180) — a `subscription:<provider>` credentialRef
  // resolves the USER-scoped stored token and dispatches to the OPERATOR-configured
  // endpoint via the EXISTING OpenAI-compatible dispatcher (borrowed-session shape
  // 1, endpoint-agnostic). MECHANISM-ONLY: NO provider-private-API code — the
  // operator points OPENWOP_SUBSCRIPTION_ENDPOINT at whatever endpoint they accept
  // the risk of (off/dark by default). The endpoint is host-only (never on the
  // wire); the token never enters an event/prompt/result.
  // ADR 0757 — GitHub Copilot, the RFC 0121 CLEARED provider: the user's own
  // OAuth token (stored at their personal `user:` tenant by the connect flow)
  // goes ONLY to the loopback Copilot sidecar, which runs the turn through
  // GitHub's official SDK (gap G2). Resolved at `run.tenantId`, so it works in
  // the user's personal workspace; a shared `ws:` run fails closed with
  // credential_unavailable — run metadata is not an authenticated principal, so
  // it is never used to reach into someone's personal tenant (architect MEDIUM-7).
  if (isSubscriptionCredentialRef(credentialRef) && subscriptionProviderOfRef(credentialRef) === COPILOT_PROVIDER_ID) {
    const endpoint = copilotEndpoint();
    const token = await resolveSubscriptionCredential(credentialRef, run.tenantId);
    if (!endpoint || !token) {
      throw new OpenwopError(
        'credential_unavailable',
        'GitHub Copilot is unavailable — connect your GitHub Copilot account in your personal workspace, and the operator must run the Copilot sidecar.',
        422,
        { credentialRef },
      );
    }
    const r = await withLlmSpan(PROVIDER_DISPATCH_SPAN, { provider: 'copilot', model }, async () => {
      const out = await dispatchChat({ provider: 'copilot', model, apiKey: token, baseUrl: endpoint, messages, maxTokens: MAX_TOKENS, ...(onDelta ? { onDelta } : {}) });
      annotateCacheUsage(out.usage);
      return out;
    }, 'LLM');
    recordTurnUsage(run.tenantId, COPILOT_PROVIDER_ID, model, r.usage);
    return { completion: r.completion };
  }
  if (isSubscriptionCredentialRef(credentialRef)) {
    // ADR 0756 — a credential bound for a provider whose terms now PROHIBIT
    // third-party routing (possibly stored before that narrowing) is never
    // dispatched. Refuse before resolving the secret.
    assertSubscriptionProviderPermitted(subscriptionProviderOfRef(credentialRef));
    const endpoint = subscriptionDispatchEndpoint();
    const token = await resolveSubscriptionCredential(credentialRef, run.tenantId);
    if (!endpoint || !token) {
      throw new OpenwopError(
        'credential_unavailable',
        'Subscription dispatch is unavailable — the operator must configure an at-own-risk dispatch endpoint and a user-scoped subscription credential must be bound.',
        422,
        { credentialRef },
      );
    }
    const r = await withLlmSpan(PROVIDER_DISPATCH_SPAN, { provider: 'compat', model }, async () => {
      const out = await dispatchChat({ provider: 'compat', model, apiKey: token, baseUrl: endpoint, messages, maxTokens: MAX_TOKENS, ...(onDelta ? { onDelta } : {}) });
      annotateCacheUsage(out.usage); // ADR 0148 A2
      return out;
    }, 'LLM');
    recordTurnUsage(run.tenantId, 'subscription', model, r.usage); // ADR 0118 Phase 2b
    return { completion: r.completion };
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
    }, 'LLM'); // ADR 0118 Phase 6 — OpenInference span kind
    recordTurnUsage(run.tenantId, 'compat', model, r.usage); // ADR 0118 Phase 2b
    return { completion: r.completion };
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
  // ADR 0178 — BYOK spend hard cap: reject BEFORE dispatch when the org has already
  // reached its daily BYOK token budget (fail-closed; no-op when uncapped). Keyed
  // by the run's own (tenant, provider) — IDOR-safe, never request input.
  // ADR 0396 P3 — the PERSONAL lane rides the same check (the run's own acting
  // user); a personal cap only lowers effective spend, never raises the org cap.
  const budgetActingUser = typeof run.metadata?.['actingUserId'] === 'string' ? (run.metadata['actingUserId'] as string) : undefined;
  const budget = await checkByokChatBudget(run.tenantId, provider, budgetActingUser);
  if (budget.exceeded) {
    throw new OpenwopError('rate_limited', 'Daily BYOK spend limit reached for this workspace. Resets at 00:00 UTC.', 429, {});
  }
  if (budget.personal?.exceeded) {
    throw new OpenwopError('rate_limited', 'Your personal daily BYOK spend limit is reached. Raise or clear it under Settings → AI Usage & Budget; resets at 00:00 UTC.', 429, { code: 'byok_personal_budget_exceeded' });
  }
  // The tenant's UN-bumped selection: when the reasoning-class bump chose the
  // model above and THAT model can't serve this key (429 quota / 404 access —
  // free-tier Google keys have ~zero pro quota), degrade once to the selection
  // instead of failing the turn. Mirrors the tool loop's runLoopWithBumpFallback;
  // group-room advisor turns take THIS path since the group tool-loop opt-out.
  const selectedTarget = tier
    ? resolveConversationModelTarget({ runInputs: inputs, metadata: run.metadata, ...(modelOverride ? { override: modelOverride } : {}) })
    : null;
  const bumpFallbackModel = selectedTarget && selectedTarget.model !== model ? selectedTarget.model : null;
  const attempt = (m: string) => withLlmSpan(PROVIDER_DISPATCH_SPAN, { provider, model: m }, async () => {
    const out = await dispatchChat({ provider: provider as ProviderId, model: m, apiKey, messages, maxTokens: MAX_TOKENS, ...(webSearch ? { webSearch: true } : {}), ...(onDelta ? { onDelta } : {}) });
    annotateCacheUsage(out.usage); // ADR 0148 A2
    return out;
  }, 'LLM'); // ADR 0118 Phase 6 — OpenInference span kind
  // Rate-limit resilience parity with the tool loop (grade-pass RESIL-1): a
  // transient 429 on the SELECTED model gets one backoff+retry before the
  // turn fails — group-room advisor turns take THIS path since the group
  // tool-loop opt-out, so a burst must not kill an advisor outright. Composes
  // with the bump-fallback below: worst case is attempt(bumped) → retry →
  // attempt(selected) — three provider calls, strictly bounded.
  const attemptWithRetry = async (m: string): Promise<Awaited<ReturnType<typeof attempt>>> => {
    try {
      return await attempt(m);
    } catch (err) {
      const backoffMs = rateLimitBackoffMs();
      if (backoffMs === 0 || !isProviderRateLimited(err)) throw err;
      logger.warn('single_completion_rate_limited_retrying_once', { provider, model: m, backoffMs });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return attempt(m);
    }
  };
  let dispatchedModel = model;
  let r: Awaited<ReturnType<typeof attempt>>;
  try {
    r = await attemptWithRetry(model);
  } catch (err) {
    // Dispatcher errors carry the upstream status as `<provider>_<status>:` —
    // the same prefix aiProvidersHost maps. Only model-availability statuses
    // fall back, and only when a distinct un-bumped selection exists.
    const msg = err instanceof Error ? err.message : String(err);
    if (!bumpFallbackModel || !/^[a-z]+_(429|404):/i.test(msg)) throw err;
    logger.warn('single_completion_bump_failed_falling_back', { provider, from: model, to: bumpFallbackModel });
    dispatchedModel = bumpFallbackModel;
    r = await attempt(bumpFallbackModel);
  }
  recordTurnUsage(run.tenantId, provider, dispatchedModel, r.usage); // ADR 0118 Phase 2b
  // ADR 0178 — record REAL post-dispatch token usage against the daily BYOK budget
  // (best-effort; the same figures ADR 0118's rollup already sees).
  void recordByokChatUsage(run.tenantId, provider, r.usage?.inputTokens ?? 0, r.usage?.outputTokens ?? 0, budgetActingUser);
  // Surface native-grounding sources on the single-completion path too — same
  // Sources footer the agent tool loop appends (review fix: dispatchReply was
  // dropping r.citations, so plain grounded chat showed no sources).
  return {
    completion: appendSourcesFooter(r.completion, r.citations ?? []),
    // ADR 0178 — soft-warning: dispatch SUCCEEDED but the org crossed the threshold.
    ...(budget.personal?.warn && !budget.personal.exceeded
      ? { budgetWarning: { code: 'byok_budget_warning' as const, usedPct: budget.personal.usedPct, cap: budget.personal.cap, scope: 'personal' as const } }
      : budget.warn && !budget.exceeded
      ? { budgetWarning: { code: 'byok_budget_warning' as const, usedPct: budget.usedPct, cap: budget.cap, scope: 'org' as const } }
      : {}),
  };
}
