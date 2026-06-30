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

import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageFeed } from './MessageFeed.js';
import { WelcomeCard } from './WelcomeCard.js';
import { ChatInput } from './ChatInput.js';
import { useFeatureAccess } from '../featureToggles/FeatureAccessContext.js';

// Lazy — voice mode (+ its client) stays out of the entry chunk; only loaded when the
// `voice` toggle is enabled and the affordance actually renders (ADR 0138 P3).
const LiveVoiceController = lazy(() => import('./voice/LiveVoiceController.js').then((m) => ({ default: m.LiveVoiceController })));
import type { LiveVoiceState } from './voice/LiveVoiceController.js';
import type { ChatMessage } from './types.js';
import type { ContentPart } from './hooks/useChatSession.js';

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
  onFeedback: (messageId: string, feedback: 'positive' | 'negative' | null) => void;
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
  /** Optional localStorage key for composer-draft persistence (crash/refresh
   *  restore). Passed straight to ChatInput; embeds omit it for an ephemeral
   *  composer. */
  draftKey?: string;
}

export function ConversationView(props: ConversationViewProps): JSX.Element {
  const { t } = useTranslation('chat');
  const {
    messages, tenantId, error, isSending, onPickSuggestion,
    onSend, onCancel, supportsAudioInput, supportsImageInput, supportsPdfInput,
    onResolveInterrupt, onRegenerate, onFeedback, onReconfigureBYOK, onBranchFrom,
    hasOlderMessages, isLoadingEarlier, onLoadEarlier, isHydrating = false, progress, footerSlot,
    renderEmptyState, composerModifiers, voiceAgentId, draftKey,
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
  const leadingControls = composerModifiers ?? undefined;

  return (
    <>
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
          onFeedback={onFeedback}
          onReconfigureBYOK={onReconfigureBYOK}
          hasOlderMessages={hasOlderMessages}
          isLoadingEarlier={isLoadingEarlier}
          onLoadEarlier={onLoadEarlier}
        />
      )}

      {error && <div className="alert error u-m-2 u-fs-12">{error}</div>}

      {footerSlot ? <div className="cv-spine">{footerSlot}</div> : null}

      {voiceAccess.enabled ? (
        <Suspense fallback={null}>
          <LiveVoiceController
            {...(voiceAgentId ? { agentId: voiceAgentId } : {})}
            onSend={(text) => onSend(text)}
            isSending={isSending}
            messages={messages}
            onState={setLiveVoice}
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
          placeholder={isSending ? t('generatingPlaceholder') : t('composerPlaceholder')}
          supportsAudioInput={supportsAudioInput}
          supportsImageInput={supportsImageInput}
          supportsPdfInput={supportsPdfInput}
          {...(draftKey ? { draftKey } : {})}
          {...(leadingControls ? { leadingControls } : {})}
          {...(voiceAccess.enabled && liveVoice ? { liveVoice } : {})}
        />
        </div>
      </div>
    </>
  );
}
