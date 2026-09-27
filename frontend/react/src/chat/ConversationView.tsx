/**
 * ConversationView — the reusable, slimmed conversation body (ADR 0073):
 * message feed (or welcome empty-state) + inline error + an optional footer slot
 * + the composer. **No header, no left rail, no right progress panel** — those
 * are chrome the full chat surface (`ChatSidebar`) wraps around this.
 *
 * Presentational by design: it owns NO chat state and never calls
 * `useChatSession` (so a surface has exactly ONE session/SSE subscription — the
 * parent's). Both the full chat surface and an embedded panel render this same
 * component; the parent supplies the flex column (full surface: `ChatHeader` +
 * `ConversationView`; embed: just `ConversationView`).
 *
 * @see docs/adr/0073-embeddable-conversation-view.md
 */

import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageFeed } from './MessageFeed.js';
// ADV-UX-1 — lazy: the notice pulls `advisoryBoardClient` and only ever mounts in
// a board conversation, so a static import would put it in the EAGER chat entry
// chunk. Same posture as the other conditional chat chrome above.
//
// CORRECTED 2026-08-20 (ADR 0588 L1 / ADVB-10). This used to say the static
// import "pushed the entry over its gzip budget". It did not — re-measured with
// the budget script's own `zlib.gzipSync`, BOTH forms passed, and the split was
// worth single-digit bytes because `advisoryBoardClient` is already static in
// the entry graph via `chat/conversations/convene.ts`. What is true is that the
// entry runs CLOSE to its budget, so the split is cheap insurance, not the
// difference between passing and failing. `scripts/check-bundle-budget.mjs` is
// the authority on the current numbers — read it rather than trusting a figure
// quoted here, which is exactly how the false claim survived the measurement
// that falsified it.
const BoardDisclaimerNotice = lazy(() => import('./conversations/BoardDisclaimerNotice.js').then((m) => ({ default: m.BoardDisclaimerNotice })));
import { WelcomeCard } from './WelcomeCard.js';
import { ChatInput } from './ChatInput.js';
import { useFeatureAccess } from '../featureToggles/FeatureAccessContext.js';

// Lazy — voice mode (+ its client) stays out of the entry chunk; only loaded when the
// `voice` toggle is enabled and the affordance actually renders (ADR 0138 P3).
const LiveVoiceController = lazy(() => import('./voice/LiveVoiceController.js').then((m) => ({ default: m.LiveVoiceController })));
import type { LiveVoiceState } from './voice/LiveVoiceController.js';
import { useVoiceTranscriptStream } from './voice/useVoiceTranscriptStream.js';
import type { ChatMessage } from './types.js';
import type { ContentPart } from './hooks/useChatSession.js';
import type { AgentMentionEntry } from './lib/agentMentions.js';

export interface ConversationViewProps {
  messages: readonly ChatMessage[];
  tenantId: string;
  error: string | null;
  /** Turn in flight — drives the composer's disabled/placeholder + Stop affordance. */
  isSending: boolean;

  // Empty state — defaults to the chat-page WelcomeCard; a surface (e.g. the
  // builder embed) can supply a context-aware one. Receives the same composer-
  // seed callback as the default so example prompts still work.
  onPickSuggestion: (text: string) => void;
  renderEmptyState?: (onPick: (text: string) => void) => ReactNode;

  // Composer
  onSend: (text: string, attachments?: readonly ContentPart[]) => void;
  onCancel: (() => void | Promise<void>) | null;
  supportsAudioInput: boolean;
  supportsImageInput: boolean;
  supportsPdfInput: boolean;

  // Conversation-level feed handlers (an embed wants these too).
  onResolveInterrupt: (messageId: string, value: unknown, nodeId?: string) => Promise<void>;
  onRegenerate: (messageId: string) => void;
  /** Optional since ADR 0195 D3b — multi-party surfaces suppress the private
   *  feedback thumbs (reactions are the public affordance there). */
  onFeedback?: (messageId: string, feedback: 'positive' | 'negative' | null) => void;
  onReconfigureBYOK: () => void;
  /** ADR 0117 Phase 4 — branch from a specific turn (fromSeq = messages-to-seed).
   *  Optional: an embed without branching omits it. */
  onBranchFrom?: (fromSeq: number) => void;
  hasOlderMessages: boolean;
  isLoadingEarlier: boolean;
  onLoadEarlier: () => void;
  /** True while a multi-tab tab hydrates its thread from the backend (ADR 0140) — show
   *  a loading state instead of the new-chat welcome. Optional; the singleton/embed
   *  surfaces never set it. */
  isHydrating?: boolean;

  /** Workflow-progress RAIL coupling — chrome the full surface has and an embed
   *  does NOT. Omit it entirely in an embed (feed renders with no focus + a
   *  no-op open). Grouped so the embed drops one object, not two noops. */
  progress?: {
    focusedMessageId: string | null;
    onOpen: (messageId: string) => void;
  };

  /** Optional content rendered between the feed and the composer (e.g. the
   *  project "Convene the team" bar on the full surface). Embeds omit it. */
  footerSlot?: ReactNode;

  /** Optional next-message modifier chips (web search, workflow tools) rendered
   *  at the composer. The full surface supplies them; embeds omit them. */
  composerModifiers?: ReactNode;
  /** The scoped agent for voice mode — its per-agent voice is used for spoken replies
   *  (ADR 0138). Omitted when the surface isn't agent-scoped → the host default voice. */
  voiceAgentId?: string;
  /** ADR 0199 — the chat sessionId, threaded to the live-voice session so its
   *  instructions carry the conversation's (visibility-gated) transcript digest. */
  voiceConversationId?: string;
  /** ADR 0304 D3 auto-voice — the surface says this conversation is a live
   *  boardroom (a board attached, or a cadence in flight), so voice sessions run
   *  the multi-speaker loop and every advisor turn is spoken in its own voice. */
  voiceBoardActive?: boolean;
  /** ADR 0304 P2 residue — mirror the live-boardroom floor (the agent being
   *  voiced right now, or null) up to the surface, which renders the lineup's
   *  speaking pulse. The lineup lives OUTSIDE this view (MembersPane / the deck
   *  strip), so the surface owns the state. */
  onVoiceSpeakingAgent?: (agentId: string | null) => void;
  /** Optional localStorage key for composer-draft persistence (crash/refresh
   *  restore). Passed straight to ChatInput; embeds omit it for an ephemeral
   *  composer. */
  draftKey?: string;
  /** ADR 0021 extension — inline per-message comments. The full chat surface
   *  supplies { orgId, sessionId } when the `comments` toggle is on; embeds omit
   *  it, so the slimmed conversation stays comment-free. */
  commentsContext?: { orgId: string; sessionId: string };
  /** RT-9 — whole spoken turns from a realtime voice session, surfaced as chat
   *  bubbles (transcripts, not sends — the realtime model already answered by
   *  voice). The full surface supplies it; embeds may omit it. ADR 0304 D4 —
   *  `agentId` names the SPEAKER (the session's scoped agent) so assistant
   *  bubbles attribute per agent; absent on user turns / unscoped sessions. */
  onLiveTranscript?: (text: string, role: 'user' | 'assistant', turnId: string, final: boolean, agentId?: string, agentPersona?: string) => void;
  /** Reload this conversation from the durable store. Supplied by surfaces that own a
   *  backend session so the OpenAI realtime path can pull in server-persisted transcripts
   *  live (that browser holds audio-only WebRTC — no client transcript). Absent on
   *  embeds/1:1-without-backend (no live OpenAI transcripts there, just on reopen). */
  onReloadConversation?: (sessionId: string) => Promise<void>;

  /** ADR 0192 D8 — channel-aware surface overrides. All optional; absent on
   *  1:1/embed surfaces (behavior unchanged). */
  /** Composer placeholder override (`Message #name` in a channel). */
  composerPlaceholder?: string;
  /** Channel-scoped `@` entries (the channel's agent members, server slugs) —
   *  replaces the tenant-wide agent list in the composer autocomplete. */
  mentionEntries?: readonly AgentMentionEntry[];
  /** `subjectRef → display` for feed attribution in multi-party conversations. */
  authorDirectory?: ReadonlyMap<string, { displayName: string; kind: 'user' | 'agent' | 'other' }>;
  /** The caller's own subjectRef — own-message alignment in channels. */
  viewerSubjectRef?: string;
  /** ADR 0195 D5 — multi-party message affordances (react/edit/delete). */
  messageActions?: {
    onToggleReaction: (messageId: string, emoji: string, currentlyMine: boolean) => void;
    onEdit: (messageId: string, newText: string) => void;
    onDelete: (messageId: string) => void;
  };
  /** ADV-UX-1 — the board this conversation is bound to, when it is a boardroom.
   *  Drives the simulated-persona disclaimer ADR 0040:345 requires "in chat".
   *  Absent on every non-board surface (behaviour unchanged). */
  boardId?: string;
  /** ADR 0202 D5 — "New messages" divider index + summarize action. */
  unreadFromIndex?: number;
  onSummarize?: () => void;
  summarizeBusy?: boolean;
}

export function ConversationView(props: ConversationViewProps): JSX.Element {
  const { t } = useTranslation('chat');
  const {
    messages, tenantId, error, isSending, onPickSuggestion,
    onSend, onCancel, supportsAudioInput, supportsImageInput, supportsPdfInput,
    onResolveInterrupt, onRegenerate, onFeedback, onReconfigureBYOK, onBranchFrom,
    hasOlderMessages, isLoadingEarlier, onLoadEarlier, isHydrating = false, progress, footerSlot,
    renderEmptyState, composerModifiers, voiceAgentId, voiceConversationId, voiceBoardActive, onVoiceSpeakingAgent, draftKey, commentsContext, onLiveTranscript, onReloadConversation,
    composerPlaceholder, mentionEntries, authorDirectory, viewerSubjectRef, messageActions,
    unreadFromIndex, onSummarize, summarizeBusy, boardId,
  } = props;
  // Default the rail-coupled props when no progress chrome is present (embed).
  const focusedWorkflowMessageId = progress?.focusedMessageId ?? null;
  const onOpenWorkflowProgress = progress?.onOpen ?? (() => { /* no progress rail in this surface */ });

  // Voice mode (ADR 0138) — the full-duplex composer affordance, gated on the `voice` toggle.
  // It owns the turn loop (mic → transcript → the chat's reply, voiced back, with barge-in) —
  // the chat generates the reply (no second chat). Mounted whenever voice is enabled (it must
  // persist THROUGH `isSending` so it can voice the reply). The reply text it speaks is the
  // most recent assistant message.
  const voiceAccess = useFeatureAccess('voice');
  // ADR 0147 — live voice is now the headless LiveVoiceController (no standalone
  // pill); its state drives the ONE composer mic. leadingControls carries only
  // the next-message modifiers.
  const [liveVoice, setLiveVoice] = useState<LiveVoiceState | null>(null);
  // OpenAI realtime path: its browser gets audio-only WebRTC (no transcript), so the
  // server-published frame is the only live signal — subscribe while a session is live and
  // reload from the store. Gated inside the hook to the OpenAI provider; a no-op otherwise
  // (Gemini streams + persists transcripts client-side via onLiveTranscript).
  useVoiceTranscriptStream(
    voiceConversationId,
    Boolean(onReloadConversation) && (liveVoice?.active ?? false),
    onReloadConversation ?? (async () => { /* no backend session on this surface */ }),
  );
  // ADR 0304 P2 residue — mirror the boardroom floor up to the surface's lineup.
  const speakingAgentId = liveVoice?.boardVoice?.speakingAgentId ?? null;
  useEffect(() => {
    onVoiceSpeakingAgent?.(speakingAgentId);
  }, [speakingAgentId, onVoiceSpeakingAgent]);
  const leadingControls = composerModifiers ?? undefined;

  return (
    <>
      {boardId ? <Suspense fallback={null}><BoardDisclaimerNotice boardId={boardId} /></Suspense> : null}
      {messages.length === 0 ? (
        isHydrating ? (
          <div className="u-flex-1 u-flex u-items-center u-justify-center u-text-muted" role="status">
            {t('multiTabHydrating')}
          </div>
        ) : (
          <div className="u-flex-1 u-overflow-y-auto">
            {renderEmptyState ? renderEmptyState(onPickSuggestion) : <WelcomeCard onPickSuggestion={onPickSuggestion} />}
          </div>
        )
      ) : (
        <MessageFeed
          messages={messages}
          tenantId={tenantId}
          onResolveInterrupt={onResolveInterrupt}
          onOpenWorkflowProgress={onOpenWorkflowProgress}
          focusedWorkflowMessageId={focusedWorkflowMessageId}
          onRegenerate={onRegenerate}
          {...(onBranchFrom ? { onBranchFrom } : {})}
          {...(onFeedback ? { onFeedback } : {})}
          onReconfigureBYOK={onReconfigureBYOK}
          hasOlderMessages={hasOlderMessages}
          isLoadingEarlier={isLoadingEarlier}
          onLoadEarlier={onLoadEarlier}
          {...(commentsContext ? { commentsContext } : {})}
          {...(authorDirectory ? { authorDirectory } : {})}
          {...(viewerSubjectRef ? { viewerSubjectRef } : {})}
          {...(messageActions ? { messageActions } : {})}
          {...(unreadFromIndex !== undefined ? { unreadFromIndex } : {})}
          {...(onSummarize ? { onSummarize } : {})}
          {...(summarizeBusy ? { summarizeBusy } : {})}
        />
      )}

      {error && <div role="alert" className="alert error u-m-2 u-fs-12">{error}</div>}

      {footerSlot ? <div className="cv-spine">{footerSlot}</div> : null}

      {voiceAccess.enabled ? (
        <Suspense fallback={null}>
          <LiveVoiceController
            {...(voiceAgentId ? { agentId: voiceAgentId } : {})}
            {...(voiceConversationId ? { conversationId: voiceConversationId } : {})}
            onSend={(text) => onSend(text)}
            isSending={isSending}
            messages={messages}
            onState={setLiveVoice}
            {...(onLiveTranscript ? { onLiveTranscript } : {})}
            {...(voiceBoardActive !== undefined ? { boardActive: voiceBoardActive } : {})}
          />
        </Suspense>
      ) : null}
      {/* Full-width border bar; the composer itself centers on the shared spine
          (.cv-spine) so it lines up with the empty-state column above. */}
      <div className="u-p-3 u-border-t">
        <div className="cv-spine">
        <ChatInput
          onSend={onSend}
          onCancel={onCancel}
          disabled={isSending}
          disabledReason={isSending ? t('turnInFlight') : undefined}
          placeholder={isSending ? t('generatingPlaceholder') : (composerPlaceholder ?? t('composerPlaceholder'))}
          supportsAudioInput={supportsAudioInput}
          supportsImageInput={supportsImageInput}
          supportsPdfInput={supportsPdfInput}
          {...(mentionEntries ? { mentionEntries } : {})}
          {...(draftKey ? { draftKey } : {})}
          {...(leadingControls ? { leadingControls } : {})}
          {...(voiceAccess.enabled && liveVoice ? { liveVoice } : {})}
        />
        </div>
      </div>
    </>
  );
}
