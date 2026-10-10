/**
 * EmbeddedConversation — the one AI chat, embedded slimmed into another surface
 * (ADR 0073 Phase 3). Owns its OWN ephemeral session (`useChatSession({ persist:
 * false })` — task-scoped, never touches the user's main chat session/index),
 * scopes it to a given agent, and renders the slimmed <ConversationView> (no
 * header, no rails, no progress panel). The first consumer is the workflow
 * builder's "Create with AI", scoped to the Workflow Architect.
 *
 * Reuses the full chat machinery (turns/streaming/interrupts/BYOK/workflow
 * dispatch) — NOT a second chat. Its submit path is the CORE subset (command →
 * /workflow → @agent → send); it deliberately omits the full surface's project
 * convene / board `@@` cadence (those are chrome concerns, ADR 0073 §Phase 3).
 *
 * @see docs/adr/0073-embeddable-conversation-view.md
 */

import { ContinueInFullChat } from './ContinueInFullChat.js';
import { useTranslation } from 'react-i18next';
import { EyeIcon } from '../ui/icons/index.js';
import { Notice } from '../ui/Notice.js';
import { setConversationFocus } from '../client/chatSessionsClient.js';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useChatSession, type ContentPart } from './hooks/useChatSession.js';
import { useAgentMentions } from './lib/agentMentions.js';
import { useScopeToAgent } from './activeAgents/useScopeToAgent.js';
import { ConversationView } from './ConversationView.js';
// Lazy for the same entry-weight reason as ChatSidebar (the strip pulls the
// full review-card tree; embeds shouldn't pay it until reviews exist).
const ConversationReviewsStrip = lazy(() =>
  import('./reviews/ConversationReviewsStrip.js').then((m) => ({ default: m.ConversationReviewsStrip })));
import { runCoreSubmit } from './lib/chatSubmit.js';
import { registerDefaultCommands } from './registry/defaultCommands.js';
import { getProvider } from '../byok/lib/providers.js';
import type { BYOKActiveConfig } from '../byok/lib/useBYOKConfig.js';

registerDefaultCommands();

/** ADR 0773 — a tool-loop step as the embed saw it: the tool NAME and phase
 *  only. `agent.toolReturned` carries no result payload (RFC 0064), so this is
 *  a trigger to re-read authoritative state, never a result channel. */
export interface EmbedToolActivity {
  toolName: string;
  phase: 'called' | 'returned';
  failed: boolean;
}

/** ADR 0773 — the consumer's pre-send hook. A refusal blocks the turn and its
 *  `reason` is shown above the composer; it is never sent half-prepared. */
export type EmbedBeforeSend = (conversationId: string, conversationRunId?: string) => Promise<{ ok: true } | { ok: false; reason: string }>;

export function EmbeddedConversation({
  agentId, config, tenantId = 'demo', onReconfigureBYOK, renderEmptyState, onTurnSettled,
  contextLabel, density = 'dock', beforeSend, onConversationId, onToolActivity, prompt, stopSignal, focus,
}: {
  /** Agent to scope this conversation to (e.g. the Workflow Architect). */
  agentId: string;
  /** A valid BYOK config — the host surface gates on it before rendering this. */
  config: BYOKActiveConfig;
  tenantId?: string;
  onReconfigureBYOK: () => void;
  /** Context-aware empty state (e.g. a workflow-authoring welcome). Receives the
   *  composer-seed callback so example prompts dispatch a real turn. */
  renderEmptyState?: (onPick: (text: string) => void) => ReactNode;
  /** ADR 0596 — fired once each time a turn finishes (sending true → false).
   *  The embed does NOT hand the consumer the turn's content: `agent.toolReturned`
   *  (RFC 0064) carries `{toolName, status, durationMs}` and NO result payload, so
   *  a tool's return value is not on the wire and cannot be relayed. This is a
   *  "something may have changed, re-read your own state" tick — the consumer
   *  learns what happened from an authoritative host read, never from the chat. */
  onTurnSettled?: () => void;
  /** ADR 0768 P5 — see EmbeddedChatPanel. */
  contextLabel?: ReactNode;
  density?: 'dock' | 'pocket';
  /** ADR 0773 — runs at the ONE embed submit choke, before EVERY send path
   *  (composer, suggestion chips, `prompt`). A refusal blocks the turn. */
  beforeSend?: EmbedBeforeSend;
  /** ADR 0773 — the chat session id this embed speaks as (the tool scope's
   *  `conversationId`), reported on mount and whenever it changes. */
  onConversationId?: (conversationId: string) => void;
  /** ADR 0773 — each tool call / return seen on this conversation, once. */
  onToolActivity?: (activity: EmbedToolActivity) => void;
  /** ADR 0773 — a consumer-initiated turn (a builder "Ask" / "Explain" /
   *  "Diagnose"). Sent once per `id`, through the same submit path as a typed
   *  message, when the conversation is idle. */
  prompt?: { id: number; text: string } | null;
  /** ADR 0773 G-05e — bump to stop the in-flight turn from outside (a builder
   *  "Stop" on its progress strip). The same `cancel` the composer's stop uses. */
  stopSignal?: number;
  focus?: { kind: 'canvas'; id: string; label: ReactNode };
}): JSX.Element {
  const { t } = useTranslation('chat');
  const {
    session, isSending, error, send, cancel, reset, resolveInterrupt, runWorkflowMention,
    regenerate, setFeedback, hasOlderMessages, isLoadingEarlier, loadEarlierMessages, activeAgents,
  } = useChatSession({ persist: false });
  const { entries: agentEntries, isLoading: agentsLoading } = useAgentMentions();
  // ADR 0777 — bind this conversation to the entity beside it. The label says
  // "this …" ONLY after the server accepted (it verified the caller may read the
  // entity); until then, or on refusal, the honest workspace-wide label stays.
  // Re-binds when the session is reset (new id) or the entity changes.
  const [focusAccepted, setFocusAccepted] = useState(false);
  const focusKind = focus?.kind;
  const focusId = focus?.id;
  useEffect(() => {
    setFocusAccepted(false);
    if (!focusKind || !focusId) return undefined;
    let live = true;
    void setConversationFocus(session.id, { kind: focusKind, id: focusId }).then((ok) => { if (live) setFocusAccepted(ok); });
    return () => { live = false; };
  }, [session.id, focusKind, focusId]);
  const shownLabel = focus && focusAccepted ? focus.label : contextLabel;
  const agentScoped = useScopeToAgent(activeAgents, agentEntries, agentId);
  // The exit from that wait: the catalog has loaded and this agent is NOT in it
  // (disabled or uninstalled). Send anyway rather than hold the prompt forever.
  // "Loaded" alone is not enough — in the render where the catalog lands, the
  // agent is present but not yet scoped, and sending then reopens the race.
  const agentAbsent = !agentsLoading && !agentEntries.some((e) => e.agentId === agentId || e.slug === agentId.toLowerCase());
  const promptReady = agentScoped || agentAbsent;

  const onRegenerate = useCallback((id: string) => { void regenerate(id, config); }, [regenerate, config]);

  // ADR 0596 — the turn-settled tick. Edge-triggered on the true → false
  // transition so a consumer re-reads once per turn, not once per render.
  const wasSending = useRef(false);
  useEffect(() => {
    if (wasSending.current && !isSending) onTurnSettled?.();
    wasSending.current = isSending;
  }, [isSending, onTurnSettled]);

  // Per-model capability hints (mirror ChatSidebar) so the composer flags
  // unsupported attachments honestly.
  const activeModel = (() => {
    try { return getProvider(config.provider).models.find((m) => m.id === config.model) ?? null; } catch { return null; }
  })();
  const supportsAudioInput = activeModel?.audioInput === true;
  const supportsImageInput = activeModel?.capabilities?.includes('vision') === true;
  const supportsPdfInput = supportsImageInput && (config.provider === 'anthropic' || config.provider === 'google');

  // CORE submit subset (shared, ADR 0140 G1): command → /workflow → @agent → send. No
  // convene/board (those are the full surface's interceptors); the embed has no
  // system-message surface, so emitSystem is a no-op.
  useEffect(() => { onConversationId?.(session.id); }, [session.id, onConversationId]);

  // ADR 0773 — surface each tool call/return ONCE (the run SSE replays from
  // seq 0 on reconnect; `applyToolActivity` de-dupes the cards, this de-dupes
  // the callback).
  const seenTools = useRef(new Map<string, 'called' | 'returned'>());
  useEffect(() => {
    if (!onToolActivity) return;
    for (const m of session.messages.slice(-4)) {
      for (const c of m.agentEvents?.toolCalls ?? []) {
        const phase = c.finishedAt ? 'returned' : 'called';
        const prior = seenTools.current.get(c.callId);
        if (prior === phase || prior === 'returned') continue;
        if (!prior && phase === 'returned') onToolActivity({ toolName: c.toolName, phase: 'called', failed: false });
        seenTools.current.set(c.callId, phase);
        onToolActivity({ toolName: c.toolName, phase, failed: Boolean(c.error) });
      }
    }
  }, [session.messages, onToolActivity]);

  const [gateError, setGateError] = useState<string | null>(null);

  const onUserSubmit = useCallback(async (text: string, attachments?: readonly ContentPart[]) => {
    if (beforeSend) {
      const verdict = await beforeSend(session.id, session.conversationRunId);
      if (!verdict.ok) { setGateError(verdict.reason); return; }
    }
    setGateError(null);
    await runCoreSubmit(text, attachments, {
      config, send, reset, cancel, runWorkflowMention, activeAgents, agentEntries,
      emitSystem: () => { /* embed has no system-message surface */ },
    });
  }, [send, cancel, reset, config, runWorkflowMention, agentEntries, activeAgents, beforeSend, session.id, session.conversationRunId]);

  const lastStop = useRef(stopSignal);
  useEffect(() => {
    if (stopSignal === undefined || stopSignal === lastStop.current) return;
    lastStop.current = stopSignal;
    if (isSending) cancel();
  }, [stopSignal, isSending, cancel]);

  // ADR 0773 — a consumer prompt is sent once per id, only when idle AND once
  // the embed is scoped to its agent. Sent earlier (the catalog still loading),
  // the turn went out as plain chat with none of the agent's tools.
  const sentPrompt = useRef<number | null>(null);
  useEffect(() => {
    if (!prompt || isSending || !promptReady || sentPrompt.current === prompt.id) return;
    sentPrompt.current = prompt.id;
    void onUserSubmit(prompt.text);
  }, [prompt, isSending, promptReady, onUserSubmit]);

  return (
    <div className={`u-flex u-flex-col u-flex-1 u-minh-0 embed-conv embed-conv--${density}`}>
      {shownLabel !== undefined ? (
        <p className="embed-context-strip">
          <EyeIcon size={13} />
          <span>{t('embedCanSee')} <strong>{shownLabel}</strong></span>
        </p>
      ) : null}
      {/* ADR 0473 — parity with the two primary surfaces (ChatSidebar/TabSession):
          reviews that trace back to THIS embedded conversation (the Workflow
          Architect's proposals, notably) render where the promise was made. */}
      <Suspense fallback={null}>
        <ConversationReviewsStrip conversationId={session.id} isSending={isSending} />
      </Suspense>
      <ConversationView
        messages={session.messages}
        tenantId={tenantId}
        voiceAgentId={agentId}
        // ADR 0277 — thread the conversationId like the two primary surfaces
        // (ChatSidebar/TabSession): the voice controller keys the remembered
        // agent choice by it, and the ADR 0199 transcript digest can fire the
        // moment an embed's conversation carries server-side meta. An ephemeral
        // embed's id resolves no meta backend-side — harmless, never blocking.
        voiceConversationId={session.id}
        error={error}
        isSending={isSending}
        onPickSuggestion={(t) => onUserSubmit(t)}
        {...(renderEmptyState ? { renderEmptyState } : {})}
        onSend={onUserSubmit}
        onCancel={cancel}
        supportsAudioInput={supportsAudioInput}
        supportsImageInput={supportsImageInput}
        agentEntries={agentEntries}
        supportsPdfInput={supportsPdfInput}
        onResolveInterrupt={resolveInterrupt}
        onRegenerate={onRegenerate}
        onFeedback={setFeedback}
        onReconfigureBYOK={onReconfigureBYOK}
        hasOlderMessages={hasOlderMessages}
        isLoadingEarlier={isLoadingEarlier}
        onLoadEarlier={loadEarlierMessages}
        composerCompact={density === 'pocket'}
        // ADR 0768 P4 — the one handoff to the full chat (promote on click).
        footerSlot={(
          <>
            {gateError ? <Notice variant="warning" announce={gateError}>{gateError}</Notice> : null}
            <ContinueInFullChat session={session} agentId={agentId} disabled={isSending} />
          </>
        )}
      />
    </div>
  );
}
