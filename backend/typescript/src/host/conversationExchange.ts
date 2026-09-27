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
 *
 * ADR 0327 P1 — this file is the ORCHESTRATOR of the `host/exchange/` pipeline:
 * validate (`validateTurn`) → authorize (`authorizeResolve`) → transcribe
 * (`transcribeAudio`) → dispatch (`dispatchTurn`) → persist (`persistExchange`),
 * with `loadTurns`/`contentParts` as shared leaves. Public exports are preserved
 * via the re-exports below; edges point ONE way (orchestrator → leaves — no
 * exchange/* module imports this file).
 */

import { getEventLog } from '../executor/eventLog.js';
import { type ResolvedAgentManifest } from '../executor/agentRegistry.js';
import { composeChatContext, groundingHonestyNotice } from './chatContext.js';
import { makeTurn, type ConversationTurn } from './conversation.js';
import { participantRosterOf, isParticipant } from './multiPartyConversation.js';
import { contextEconomy } from './contextEconomy.js';
import { windowTranscript, transcriptBudgetConfig } from './transcriptBudget.js';
import { resolveConversationModelTarget, type ConversationModelTierInput } from '../features/model-router/applyRoute.js';
import { OpenwopError, type InterruptRecord, type RunRecord } from '../types.js';
import { stripSecretsFromPersisted } from '../byok/ephemeralRunSecrets.js';
import { sanitizeFreeText, sanitizeFreeTextDeep } from '../byok/textRedaction.js';
import { claimExchange, commitExchange, releaseExchange } from './conversationExchangeIdem.js';
import { checkDeepInvestigationBudget } from './runBudgetService.js';
import { getAgentProfile } from './agentProfileService.js';
import { createLogger } from '../observability/logger.js';
import { runConversationAgentToolTurn, conversationToolTurnEligible, applyGroupRoomScaffoldNotice } from './conversationToolLoop.js';
import type { AgentEvent } from './agentDispatch.js';
import type { ContentPart } from '../providers/dispatch.js';
import type { ProviderPolicyResolver } from './index.js';
import type { Storage } from '../storage/storage.js';
import { parseResolveBody, validateExchangeContent } from './exchange/validateTurn.js';
import { authorizeConversationResolve } from './exchange/authorizeResolve.js';
import { foldVoiceClipTranscript } from './exchange/transcribeAudio.js';
import { asText, isContentParts, hasAttachmentPart, makeNoContribution, producedNothing } from './exchange/contentParts.js';
import { resolvePersonaNames } from './agentIdentity.js';
import { loadTurns } from './exchange/loadTurns.js';
import { dispatchReply, turnsToMessages, maybeStampModelRoute, resolveModelProvenance, type ByokBudgetNotice, type DeepRunBudgetNotice, type ExchangeNotice } from './exchange/dispatchTurn.js';
import { persistExchangedPair, mirrorTurnToChannel, autotitleAfterExchange, maybeExtractMemoryOnClose } from './exchange/persistExchange.js';
import { buildRunDispatchTurns, appendRunTurnDirect, type TurnRunDispatch } from './turnRunDispatch.js';

// ── Public surface (preserved across the ADR 0327 P1 split) ────────────────
export { loadTurns, __resetTurnsCacheForTests } from './exchange/loadTurns.js';
export { computeRouteStamp, resolveModelProvenance } from './exchange/dispatchTurn.js';
export type { ByokBudgetNotice, DeepRunBudgetNotice, ExchangeNotice } from './exchange/dispatchTurn.js';
export type { ConversationResolve } from './exchange/validateTurn.js';

/** Structured logger — NOTE the file's `log` is the run EVENT log (getEventLog), not this. */
const logger = createLogger('host.conversationExchange');

/** Resume callback (the route injects `resolveAndResume`) — only `close` uses it. */
export type ResumeFn = (interruptId: string, value: unknown) => Promise<void>;

export interface ConversationResolveResult {
  operation: 'exchange' | 'close';
  conversationId: string;
  turns: ConversationTurn[];
  /** ADR 0178 / XCH-GRP-3 — a non-blocking advisory for THIS exchange: a BYOK
   *  spend soft-warning, or a deep-investigation budget degrade. Host-internal
   *  only: rides this result object, never a persisted turn/event or the wire.
   *  The BYOK warning is computed on the synchronous path only (the async path
   *  acks before its dispatch); the deep degrade is decided BEFORE dispatch, so
   *  it rides both paths. */
  notice?: ExchangeNotice;
}

/** Optional host deps for the conversation. `policyResolver` (the route injects
 *  `hostSuite.providerPolicyResolver`) enables the ADR 0089 agent tool loop — a
 *  tool-bearing @mentioned agent runs its observe→act loop instead of a single
 *  narration. Absent ⇒ the legacy single-completion path (no regression). */
export interface ConversationHostDeps {
  policyResolver?: ProviderPolicyResolver;
  /** CS-BE-1 (conversation-stack audit) — the AUTHENTICATED HTTP caller of the
   *  resolve route (undefined for anonymous/unresolvable callers). Every
   *  exchange/close is gated on this caller's conversation visibility below;
   *  absent ⇒ only legacy/unowned conversations pass (fail-closed for owned). */
  callerUserId?: string;
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

/** ADR 0089 Phase 4 (Option B) + ADR 0373 — should THIS @mentioned agent be
 *  dispatched as a nested deep-investigation RUN rather than the inline turn
 *  loop? True iff the agent is tool-bearing (its tool loop would engage for the
 *  run's EFFECTIVE provider — the per-exchange override included) AND deep
 *  investigation is activated for it. Default-off.
 *
 *  SYNC + PURE by design (ADR 0373 Phase 1 review): the profile read that
 *  decides `deepActivated` happens at the ONE call site, right beside the
 *  budget read, so both I/O steps of the deep decision are visible together in
 *  the orchestrator instead of one hiding in here.
 *
 *  `deepActivated` is the ADR 0373 host-ext capability
 *  (`AgentProfile.capabilities` includes `'deep-investigation'`) and is the
 *  PRIMARY source. `agent.investigationDepth === 'deep'` is the VESTIGIAL
 *  manifest field (ADR 0373 §2): no shipped agent can set it — the pack loader
 *  drops it and the SPEC agent-manifest schema forbids it — so it survives only
 *  for directly-registered agents (the ADR 0089 tests). It is checked SECOND on
 *  purpose: if a future RFC ever makes the manifest field real, the profile
 *  stays the primary switch, and deleting this OR is then a one-line change. */
export function conversationDeepInvestigationEligible(
  run: RunRecord,
  agent: ResolvedAgentManifest,
  deepActivated: boolean,
  modelOverride?: { provider?: string; model?: string },
): boolean {
  return (deepActivated || agent.investigationDepth === 'deep')
    && conversationToolTurnEligible(run, agent, modelOverride);
}

/** ADR 0373 — is the deep-investigation capability activated for this agent?
 *  Reads the agentProfile keyed by `profileId` (the rosterId for a standing
 *  agent, else the definition-level agentId — `AgentProfile.profileId` accepts
 *  both, and `getAgentProfile` is tenant-scoped fail-closed).
 *
 *  FAILS CLOSED (unlike the budget read ~20 lines below, which fails OPEN).
 *  That asymmetry is deliberate, and both sides follow ONE principle: on
 *  uncertainty, prefer the cheaper outcome that still answers the user. Here the
 *  GRANT is unverified, so we must not spend ~15x tokens on an entitlement we
 *  couldn't confirm — degrade to the inline turn. There, the feature is already
 *  activated, so a counter hiccup must not silently kill a capability the tenant
 *  switched on. Do not "harmonize" these. */
async function deepInvestigationActivated(tenantId: string, profileId: string | undefined): Promise<boolean> {
  if (!profileId) return false;
  const profile = await getAgentProfile(tenantId, profileId).catch((err: unknown) => {
    logger.warn('deep_capability_read_failed_degrading_to_inline', { profileId, err: err instanceof Error ? err.message : String(err) });
    return null;
  });
  return !!profile?.capabilities?.includes('deep-investigation');
}

/**
 * Handle one `ConversationResolve` against a suspended `core.conversationGate`.
 * Returns the operation + the conversation's turns after the operation.
 */
export async function handleConversationResolve(
  storage: Storage,
  interrupt: InterruptRecord,
  resumeValue: unknown,
  resume: ResumeFn,
  hostDeps?: ConversationHostDeps,
): Promise<ConversationResolveResult> {
  const data = (interrupt.data ?? {}) as { conversationId?: string };
  const conversationId = data.conversationId ?? `${interrupt.runId}:${interrupt.nodeId}:0`;
  const { body, operation, exchangeWebSearch, exchangePermissionMode, exchangeModelOverride, exchangeKey, to } = parseResolveBody(resumeValue);

  const run = await storage.getRun(interrupt.runId);
  if (!run) throw new OpenwopError('run_not_found', `run ${interrupt.runId} missing during conversation resolve`, 404);
  // Terminal-run 409 (ADR 0067 §Security) + the CS-BE-1 caller-visibility gate
  // (throws; masks a deny with the route's own 404 vocabulary).
  const { chatSessionId } = await authorizeConversationResolve({
    run, runId: interrupt.runId, conversationId,
    callerUserId: hostDeps?.callerUserId,
  });

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
    // (runs once, on the full transcript). FAIL-CLOSED inside the op: no grant ⇒ no
    // LLM call, so an un-opted-in close pays one point-get and nothing more.
    //
    // AWAITED (ADR 0699 D1). This used to be fire-and-forget, one line above this
    // `return` — i.e. the LLM call continued after the response flushed, where
    // `ARCHITECTURE.md:147` measures a detached continuation as "effectively never"
    // resumed under `cpu-throttling=true`. Awaiting is the only shape with guaranteed
    // CPU; the op bounds itself so a hung provider cannot wedge the close.
    await maybeExtractMemoryOnClose(run, existing);
    return { operation, conversationId, turns: [...existing, finalTurn] };
  }

  // ── exchange ───────────────────────────────────────────────────────────
  const rawContent = body.turn?.content;
  validateExchangeContent(rawContent, conversationId); // RFC 0005 §E — 422 on an empty turn

  // Idempotency (ADR 0067 §Phase 2): a stable client `exchangeKey` lets a retried
  // POST short-circuit instead of appending a second turn pair. The dedup index
  // is a host-ext sidecar — NOT a field on the normative conversation.exchanged
  // event (that would be a wire change). Absent key ⇒ legacy behavior (no dedup).
  // ORDERING (kept visible in the orchestrator per the split's review): claim
  // BEFORE dispatch; release on failure; commit only after both turns are durable.
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

  // RT-10 — a VOICE-CLIP turn (audio parts, no typed text) is transcribed host-side
  // FIRST, so the user's spoken words become part of THEIR turn (fail-soft: any
  // failure ⇒ the turn stays audio-only and the model still hears the raw audio).
  const effectiveContent: unknown = await foldVoiceClipTranscript(run, rawContent);
  // Redact secrets from the user's text BEFORE it is persisted OR sent to the
  // model (a pasted key must not leak into the event log, channel, or prompt).
  // `userText` stays the TEXT projection (routing / knowledge retrieval / channel
  // mirror / agent-loop task) — media parts appear as short markers, never base64.
  const userText = sanitizeFreeText(asText(effectiveContent));
  // The STORED turn keeps the real multimodal parts (deep-redacted inside text
  // parts) so `turnsToMessages` hands the model the actual audio/image bytes.
  const userContent: string | ContentPart[] = isContentParts(effectiveContent)
    ? (sanitizeFreeTextDeep(effectiveContent) as ContentPart[])
    : userText;
  const userTurn = makeTurn({
    conversationId, turnIndex: nextIndex, role: 'user', from: 'user',
    content: userContent, ts: Date.now(), groupId: conversationId, ...(to ? { to } : {}),
  });

  // Resolve the addressed agent + compose its persona scaffold via the ONE
  // context owner (ADR 0199 — extracted so realtime voice composes the same
  // brain). All prior semantics preserved: tenant-checked persona, identity
  // anchor, board `injectedContextBlock`, owner-subject KB with the IDOR guard.
  //
  // KEY (unchanged): ConversationMeta is keyed by the chat `sessionId`, NOT the
  // run-derived gate conversationId; the run carries it in metadata, with the
  // gate id as the additive fallback for older clients / conformance.
  // (`chatSessionId` comes from the authorize step — the CS-BE-1 gate derives it once.)
  const actingUserId0 = run.metadata?.['actingUserId'];
  const composed = await composeChatContext(run.tenantId, {
    ...(to ? { agentId: to } : {}),
    conversationId: chatSessionId ?? conversationId,
    ...(typeof actingUserId0 === 'string' && actingUserId0.length > 0 ? { callerUserId: actingUserId0 } : {}),
    seedText: userText,
    // WF-RCL-4 — the run this exchange rides. Until the field existed, the chat
    // lane's twin.recall audit rows could never name their run/conversation.
    runId: interrupt.runId,
    // PR #3409 review F1 — the per-TURN dispatch identity for the consent-
    // ledger replay guard. One conversation = ONE run, so bare runId deduped
    // every recall after turn 1. `nextIndex` is recomputed identically on a
    // retried exchange (a failed attempt persists no turns), so a genuine
    // retry still collapses to one row.
    dispatchId: `turn:${nextIndex}`,
  });
  // H1 / ADR 0588 D5 — the LIKENESS GATE on the turn path. The two lanes that
  // carried it before were both room-CREATION lanes, so a boardroom opened while
  // the seed's fabricated acknowledgement was still in place stayed live in the
  // sidebar, fully seated, and composed turns normally after the ack was
  // stripped. Refuse BEFORE anything durable happens for this turn, and release
  // the idempotency claim first so a later retry (after the owner acknowledges)
  // is not stranded at 409 by an `in_progress` key.
  if (composed.conveneRefusal) {
    if (exchangeKey) await releaseExchange(run.tenantId, conversationId, exchangeKey);
    throw new OpenwopError('validation_error', composed.conveneRefusal, 422, {
      field: 'livingPersonaAck', conversationId, ...(composed.meta?.boardId ? { boardId: composed.meta.boardId } : {}),
    });
  }
  const { agent, tenantOk, meta: convMeta, systemPrompt: scaffold, identity: agentIdentity } = composed;
  const answeringId = agent && tenantOk ? agent.agentId : undefined;
  // CS-GB-1 — the tier inputs every model resolution this turn shares: the
  // SERVER-derived conversation type + the answering agent's declared
  // modelClass. Fed to the ONE resolver so a group room's reasoning-class
  // advisor steps up to the run provider's own class default (never a
  // cross-provider move), unless a stamp/override already chose the model.
  const modelTier: ConversationModelTierInput = {
    ...(convMeta?.type ? { conversationType: convMeta.type } : {}),
    ...(agent && tenantOk && agent.modelClass ? { agentModelClass: agent.modelClass } : {}),
  };

  // XCH-GRP-1 — capability honesty on group turns: when the group-room
  // tool-loop opt-out (#1831) routes this turn to the single-completion path,
  // the scaffold says so. The gate predicate and the notice live together in
  // conversationToolLoop.ts (ONE owner — they can never disagree); applied
  // post-composition because composeChatContext is shared with voice.
  const groupNotedScaffold = applyGroupRoomScaffoldNotice(scaffold, modelTier);
  // WF-BOA-4 — the degradation ledger this composition computed is CONSUMED, not
  // discarded. `features/voice/realtime/routes.ts` was the sole reader; the text
  // lane — the one that fans out N advisors and then SYNTHESISES over them —
  // dropped it, so an ungrounded advisor spoke under its own name and the
  // moderator concluded from it.
  const groundingNotice = groundingHonestyNotice(composed.degraded);
  if (groundingNotice) {
    log.append({
      runId: interrupt.runId, nodeId: interrupt.nodeId, type: 'openwop-app.conversation.context-degraded',
      payload: { conversationId, degraded: composed.degraded, ...(answeringId ? { speakerId: answeringId } : {}) },
    }).catch(() => { /* disclosure is best-effort; never fails the turn */ });
  }
  // RCL-UX-1 — recall SUCCESS was invisible everywhere while only failure had a
  // signal. Emit a host event so the acting caller's feed can mark the reply as
  // memory-shaped ("drew on your shared memories"). Post-ADR 0589 §D2 the
  // caller IS the owner, so this is first-party disclosure, not a leak; the
  // payload names no content. Best-effort like the degradation event above.
  if (composed.borrowedRecalled) {
    log.append({
      runId: interrupt.runId, nodeId: interrupt.nodeId, type: 'openwop-app.conversation.recall-used',
      payload: { conversationId, ...(answeringId ? { speakerId: answeringId } : {}) },
    }).catch(() => { /* disclosure is best-effort; never fails the turn */ });
  }
  const effectiveScaffold = groundingNotice ? `${groupNotedScaffold}\n\n${groundingNotice}` : groupNotedScaffold;

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
  const toolAgent = agent && tenantOk && answeringId && hostDeps?.policyResolver && conversationToolTurnEligible(run, agent, exchangeModelOverride)
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
  // XCH-GRP-3 (2026-07-15) — the deep path is the ENDORSED exception to the
  // #1831 group opt-out (an explicit @mention is human-ELECTED value, not a
  // cadence fan-out), but it is the one path that dispatches a whole
  // tool-running agent run (~15x the tokens of a chat turn), so a mention-storm
  // in ONE room is a real burst. Budget it per room, per window.
  //
  // Over budget DEGRADES to the inline turn below — the user still gets an
  // answer, with `deepDegradedNotice` telling them why it wasn't the deeper one
  // (#1829's "degrade, never hard-fail"). A budget-store hiccup fails OPEN to
  // the deep dispatch: the ADR 0318 posture that a config/counter read failing
  // must never silently kill a feature.
  // ADR 0373 — the capability read (fails CLOSED) and the XCH-GRP-3 budget read
  // (fails OPEN) are the two I/O steps of the deep decision; they sit together
  // here on purpose. `agentIdentity.profileId` is the id composeChatContext
  // already resolved above — no second reverse roster scan.
  // Gated on `startAgentMentionRun` too: without the host's run-starter the deep
  // path is IMPOSSIBLE, so the profile read would be pure waste on every
  // tool-bearing mention turn (point-get, but the chat hot path pays it).
  const deepPossible = !!(agent && answeringId && toolAgent && hostDeps?.startAgentMentionRun);
  const deepActivated = deepPossible
    ? await deepInvestigationActivated(run.tenantId, agentIdentity?.profileId)
    : false;
  const startDeepRun = deepPossible && agent
    && conversationDeepInvestigationEligible(run, agent, deepActivated, exchangeModelOverride)
    ? hostDeps?.startAgentMentionRun
    : undefined;
  let deepDegradedNotice: DeepRunBudgetNotice | undefined;
  if (startDeepRun) {
    const budget = await checkDeepInvestigationBudget(storage, run.tenantId, conversationId).catch((err: unknown) => {
      logger.warn('deep_run_budget_check_failed_allowing', { conversationId, err: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (budget && !budget.allowed) {
      logger.info('deep_run_budget_exceeded_degrading_to_inline', {
        conversationId, tenantId: run.tenantId, current: budget.current, limit: budget.limit,
      });
      deepDegradedNotice = { code: 'deep_run_budget_exceeded', limit: budget.limit };
    }
  }
  if (startDeepRun && answeringId && !deepDegradedNotice) {
    const inputs = (run.inputs ?? {}) as { provider?: unknown; model?: unknown; credentialRef?: unknown };
    // ADR 0373 Phase 1 — hand the nested run the SAME effective model the inline
    // path would have used. `agentRunnerNode.resolveParams` takes provider/model
    // VERBATIM and does no override resolution of its own, so this hand-off IS
    // the nested run's model decision. Reading `run.inputs` raw (the pre-0373
    // bug) ignored BOTH the per-exchange override and the `metadata.modelRoute`
    // stamp, so eligibility could be judged on one provider while the run
    // dispatched on another. `resolveConversationModelTarget` is the ONE
    // resolver every other model decision on this path already shares — never a
    // second precedence chain here. `credentialRef` is deliberately NOT
    // per-exchange overridable (agentMentionConfigurable registers the BYOK ref).
    const deepTarget = resolveConversationModelTarget({
      runInputs: inputs, metadata: run.metadata,
      ...(exchangeModelOverride ? { override: exchangeModelOverride } : {}),
    });
    let mentionRunId: string | null;
    try {
      mentionRunId = await startDeepRun({
        tenantId: run.tenantId,
        agentId: answeringId,
        task: userText,
        // `'unknown'` is `effectiveModelTarget`'s sentinel for "no model in
        // run.inputs" (applyRoute.ts:77), NOT a model — it must never reach the
        // nested run, or the managed tier would dispatch on a garbage model id
        // where it previously (correctly) passed none and let `preferManaged`
        // pick. Same guard `dispatchTurn.ts:93` applies to this resolver.
        ...(deepTarget.provider ? { provider: deepTarget.provider } : {}),
        ...(deepTarget.model && deepTarget.model !== 'unknown' ? { model: deepTarget.model } : {}),
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
    const modelProv = resolveModelProvenance(run, exchangeModelOverride, modelTier);
    const agentTurn = makeTurn({
      conversationId, turnIndex: agentIndex, role: 'agent',
      from: answeringId, content: { kind: 'workflow_run', runId: mentionRunId, agentId: answeringId },
      ts: Date.now(), groupId: conversationId, agent: { agentId: answeringId, ...(modelProv ? { model: modelProv } : {}) },
      // RFC 0101 — explicit per-turn speaker attribution (the agent instance id).
      speakerId: answeringId,
    });
    await persistExchangedPair({
      runId: interrupt.runId, nodeId: interrupt.nodeId, conversationId,
      entries: [[nextIndex, userTurn], [agentIndex, agentTurn]],
    });
    mirrorTurnToChannel(interrupt.runId, { messageId: userTurn.messageId, role: 'user', content: userText, timestamp: new Date(userTurn.ts).toISOString() });
    mirrorTurnToChannel(interrupt.runId, {
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
  // ADR 0665 D5 — resolve the CAST for the narrative `[Persona]:` relay. Only ids
  // that will actually be cast are resolved: an agent turn by someone OTHER than
  // the agent now answering. A 1:1 chat yields an empty set and pays nothing, so
  // this is a council-only cost on the per-turn hot path.
  const castIds = new Set<string>();
  for (const t of budgetedExisting) {
    const id = t.role === 'agent' ? t.agent?.agentId : undefined;
    if (id && id !== answeringId) castIds.add(id);
  }
  // Fail-soft: a roster/registry fault leaves the map empty and every speaker
  // falls back to its slug — the pre-0665 rendering, never a blank cast.
  const personaNameById = castIds.size > 0
    ? await resolvePersonaNames(run.tenantId, castIds).catch((err: unknown) => {
      logger.warn('persona_cast_resolve_failed', { conversationId, error: err instanceof Error ? err.message : String(err) });
      return new Map<string, string>();
    })
    : undefined;
  const messages = turnsToMessages([...budgetedExisting, userTurn], effectiveScaffold, answeringId, personaNameById);
  if (omittedCount > 0 && messages[0]?.role === 'system') {
    // Tell the model context was elided so it doesn't assume it has everything.
    messages[0] = {
      ...messages[0],
      content: `${asText(messages[0].content)}\n\n[Context budget: ${omittedCount} earlier turn(s) omitted; the ${budgetedExisting.length} most recent are shown.]`,
    };
  }
  // ADR 0079 §Phase 1 — stream the reply's tokens as canonical `output.chunk`
  // events on the gate node so a subscribed client renders them live. Transient
  // (stream-only, never folded into a channel); the authoritative turn is the
  // `conversation.exchanged` event below. Best-effort: a delta-emit failure must
  // not break the reply.
  const onDelta = async (delta: string): Promise<void> => {
    try {
      await log.append({
        runId: interrupt.runId, nodeId: interrupt.nodeId, type: 'output.chunk',
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
  // ADR 0178 — the BYOK spend soft-warning for this exchange's agent turn, captured
  // from dispatchReply and threaded onto the SYNC result object (never persisted).
  let budgetNotice: ByokBudgetNotice | undefined;
  // The generate → emit → commit body. Runs synchronously by default (its throw
  // becomes the route's clean 4xx/5xx); under the async flag it runs in the
  // background after the POST is acked (see below).
  const finishExchange = async (): Promise<ConversationTurn[]> => {
    let completion: string;
    // Runs this turn's tools ignited. Materialized by THIS function — it holds
    // the single turnIndex allocation (`nextIndex`) and builds the response — so
    // the bubble can neither collide with the user turn nor go missing from
    // `turns`. See `host/turnRunDispatch.ts`.
    let runDispatches: readonly TurnRunDispatch[] = [];
    try {
      // ADR 0089 — tool-bearing agent: run the observe→act loop. A `null` return
      // (managed tier / non-tool provider / no resolvable tool / missing key)
      // falls through to the single completion below, so non-tool agents and
      // unsupported providers are unaffected.
      // ADR 0130 Phase 3c — stamp the routed model ONCE (first exchange), BEFORE
      // the tool loop (CS-GB-1: the stamp previously landed after it, so a
      // tenant's group-tier rule never applied to the first tool-loop turn).
      await maybeStampModelRoute(run, userText, storage, convMeta?.type, hasAttachmentPart(effectiveContent));
      let toolText: string | null = null;
      if (toolAgent && hostDeps?.policyResolver) {
        const toolTurn = await runConversationAgentToolTurn({
          run, agent: toolAgent, systemPrompt: effectiveScaffold, history: messages.slice(1),
          runId: interrupt.runId, nodeId: interrupt.nodeId,
          conversationId, storage,
          policyResolver: hostDeps.policyResolver, onEvent: onAgentEvent,
          ...(exchangeWebSearch !== undefined ? { webSearch: exchangeWebSearch } : {}),
          ...(exchangePermissionMode !== undefined ? { permissionMode: exchangePermissionMode } : {}),
          // CS-GB-1 — the loop resolves its model through the ONE resolver too.
          ...(exchangeModelOverride ? { modelOverride: exchangeModelOverride } : {}),
          tier: modelTier,
        });
        if (toolTurn) {
          if (toolTurn.error) {
            // The loop failed AFTER a tool may already have ignited a real run.
            // The throw below persists nothing (dispatch-first ⇒ cleanly
            // retryable), so surface any ignited run through the out-of-band
            // append instead — otherwise a live run would exist with NOTHING in
            // the conversation pointing at it, which is the exact invisibility
            // this change removes. Best-effort; never masks the original error.
            for (const d of toolTurn.runDispatches ?? []) {
              await appendRunTurnDirect(storage, run.tenantId, conversationId, d, interrupt.nodeId);
            }
            throw new OpenwopError('internal_error', `Agent tool turn failed: ${toolTurn.error.message}`, 502, { conversationId, toolError: toolTurn.error.code });
          }
          runDispatches = toolTurn.runDispatches ?? [];
          toolText = toolTurn.text;
          // The tool path has no token streaming (callAIWithTools is non-stream);
          // emit the settled answer once so subscribers render it before the turn.
          await onDelta(toolText);
        }
      }
      const reply = toolText != null ? { completion: toolText } : await dispatchReply(run, messages, onDelta, exchangeWebSearch, exchangeModelOverride, modelTier);
      completion = sanitizeFreeText(reply.completion);
      if ('budgetWarning' in reply && reply.budgetWarning) budgetNotice = reply.budgetWarning; // ADR 0178
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
    const modelProv = resolveModelProvenance(run, exchangeModelOverride, modelTier);
    // ADR 0665 D4 — an advisor that produced NOTHING did not contribute, and the
    // transcript must say so rather than carry an attributed empty turn the chair
    // then synthesises over as if it were assent.
    //
    // The `runDispatches` clause is the case this would otherwise get WRONG: a
    // tool-bearing agent can settle with no prose because it ignited a run, and
    // the run bubbles render right below this turn. That agent DID contribute —
    // marking it silent would be a second false record, in the other direction.
    //
    // Non-halting by construction: this branch changes the turn's CONTENT and
    // nothing else. It does not throw, so the exchange still succeeds, `errored`
    // stays false, and the boardroom cadence dispatches the remaining advisors
    // and the synthesis.
    const noContribution = producedNothing(completion, runDispatches.length);
    const agentContent: unknown = noContribution ? makeNoContribution(answeringId) : completion;
    const agentTurn = makeTurn({
      conversationId, turnIndex: agentIndex, role: 'agent',
      from: answeringId ?? 'assistant', content: agentContent, ts: Date.now(), groupId: conversationId,
      ...(answeringId ? { agent: { agentId: answeringId, ...(modelProv ? { model: modelProv } : {}) } } : {}),
      // RFC 0101 — explicit per-turn speaker attribution (the agent instance id).
      // The fallback `'assistant'` turn (no resolved agent — the 1:1 chat) names
      // its `from` as the speaker: the closed v2 turn def REQUIRES `speakerId` on
      // every `role:'agent'` turn, and since ADR 0746 put `parts` on every turn,
      // RFC 0205's `turn-parts-emitted` leg fails a parts-bearing turn that does
      // not validate (ADR 0755, WIT-ART-2). With a declared multi-party ROSTER an
      // unresolved speaker is NOT stamped — `'assistant'` is no participant, and
      // naming a non-member would be the false attribution RFC 0101 rejects.
      ...(answeringId ? { speakerId: answeringId } : participants ? {} : { speakerId: 'assistant' }),
    });
    // Runs ignited by this turn's tools render AFTER the agent's narration —
    // "I started it" then the live run bubble. Allocated from the SAME counter
    // as the user/agent turns (the collision fix) and persisted in the SAME
    // call, so there is one writer and one atomic append.
    const runTurns = buildRunDispatchTurns(conversationId, runDispatches, agentIndex + 1);
    await persistExchangedPair({
      runId: interrupt.runId, nodeId: interrupt.nodeId, conversationId,
      entries: [[nextIndex, userTurn], [agentIndex, agentTurn], ...runTurns.map((t) => [t.turnIndex, t] as [number, ConversationTurn])],
    });
    mirrorTurnToChannel(interrupt.runId, { messageId: userTurn.messageId, role: 'user', content: userText, timestamp: new Date(userTurn.ts).toISOString() });
    mirrorTurnToChannel(interrupt.runId, {
      // The channel mirror carries a string — project the typed non-contribution
      // through the ONE text projection so the two records cannot disagree.
      messageId: agentTurn.messageId, role: 'assistant', content: asText(agentContent),
      timestamp: new Date(agentTurn.ts).toISOString(), ...(answeringId ? { agentId: answeringId } : {}),
    });
    for (const t of runTurns) {
      // The channel mirror carries a string; the authoritative
      // `conversation.exchanged` turn holds the structured reference the chat
      // reads (same split as the ADR 0089 deep-investigation bubble above).
      mirrorTurnToChannel(interrupt.runId, {
        messageId: t.messageId, role: 'assistant', content: JSON.stringify(t.content),
        timestamp: new Date(t.ts).toISOString(), ...(answeringId ? { agentId: answeringId } : {}),
      });
    }

    // Commit the idempotency claim now that both turns are durable: a later retry
    // of this key short-circuits to the appended turns instead of dispatching again.
    if (exchangeKey) await commitExchange(run.tenantId, conversationId, exchangeKey, nextIndex, agentIndex, Date.now());

    // ADR 0151 — first-exchange auto-titling (fire-and-forget + fail-closed in
    // the binding; emits `openwop-app.conversation.titled` so the FE rail/tab updates live).
    autotitleAfterExchange({
      run, chatSessionId, conversationId, nodeId: interrupt.nodeId,
      userText, replyText: completion, storage,
    });

    // `runTurns` rides the response: without it the bubble is persisted but
    // absent from what the client renders, so the Workflow-progress rail reads
    // "No workflow runs yet" while a real run is executing (the reported bug).
    return [...existing, userTurn, agentTurn, ...runTurns];
  };

  // ADR 0079 §Phase 3 — async exchange (flag-gated, default OFF). When enabled,
  // ack the POST immediately and finish generation in the BACKGROUND so the reply
  // rides the CDN-bypassing run SSE instead of a blocking `/api` POST — removing
  // the ~60s Firebase ceiling for long replies. The reply's `output.chunk`
  // deltas and the authoritative `conversation.exchanged` turns stream on the run
  // event log; the client waits for that settle signal before reconciling. A
  // failure AFTER the ack can no longer be a POST 4xx, so it surfaces as a
  // terminal `openwop-app.ai.message-error` event (must-fix #2) and releases the claim
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
          runId: interrupt.runId, nodeId: interrupt.nodeId, type: 'openwop-app.ai.message-error',
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
    // XCH-GRP-3: the deep degrade is decided BEFORE dispatch, so unlike the BYOK
    // warning it can ride the async ack too.
    return { operation, conversationId, turns: existing, ...(deepDegradedNotice ? { notice: deepDegradedNotice } : {}) };
  }

  const syncTurns = await finishExchange();
  // The deep degrade wins the single notice slot: it explains a CAPABILITY
  // change the user can see (no run bubble), where the BYOK warning is advisory
  // and will re-fire on the next turn anyway.
  const notice: ExchangeNotice | undefined = deepDegradedNotice ?? budgetNotice;
  return { operation, conversationId, turns: syncTurns, ...(notice ? { notice } : {}) };
}
