/**
 * Single chat message bubble. User vs assistant differentiated by:
 *   - alignment (right vs left)
 *   - background (accent vs surface-2)
 *   - text color (white vs default)
 *
 * Streaming bubbles get a subtle pulsing cursor at the end of content.
 * Bubbles with `meta.error` render in a warn-tinted state.
 */

import { Button } from '../ui/Button.js';
import { memo, useState, useSyncExternalStore, type CSSProperties, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { ChatMessage } from './hooks/useChatSession.js';
import { messageText } from './hooks/useChatSession.js';
import {
  type ReturnTarget, getReturnTarget, subscribeReturnTarget,
  stagePendingApply, clearReturnTarget,
} from './returnTarget.js';
import { MessageRenderer } from './MessageRenderer.js';
import { ThoughtsDisclosure } from './ThoughtsDisclosure.js';
import { ThinkingIndicator } from './ThinkingIndicator.js';
import { useStreamCadence } from './hooks/useStreamCadence.js';
import { ToolCallCard, HandoffIndicator, DecisionBadge, VerificationCard } from './AgentEventCards.js';
import { EnvelopeEventsTimeline, hasEnvelopeEvents } from './EnvelopeEventsTimeline.js';
import { EnvelopeInspector } from './EnvelopeInspector.js';
import { useFeatureAccess } from '../featureToggles/FeatureAccessContext.js';
import { ReasoningDisclosure } from './ReasoningDisclosure.js';
import { ErrorCard } from './ErrorCard.js';
import { formatUsd, turnCostUsd } from './lib/cost.js';
import { formatNumber, formatTime } from '../i18n/format.js';
import { CheckIcon, GlobeIcon, MicIcon, RotateCwIcon, SparklesIcon, ThumbsDownIcon, ThumbsUpIcon, FileTextIcon } from '../ui/icons/index.js';
import { voiceCtxBlockLabels } from './voiceCtxLabels.js';
import { REACTION_EMOJI } from '../client/chatSessionsClient.js';
import { Avatar } from '../ui/Avatar.js';
import { AgentAvatar } from '../agents/AgentAvatar.js';
import { roleThemeForAgentId } from '../agents/roleTheme.js';
import { slugToName } from './lib/agentMentions.js';
// A7 — lazy: the held-approval card is rare; keep its client + UI out of the
// entry bundle (the budget gate flagged the static import at +0.3 kB gzip).
const VoiceApprovalNotice = lazy(() => import('./voice/VoiceApprovalNotice.js').then((m) => ({ default: m.VoiceApprovalNotice })));

function hasContent(content: ChatMessage['content']): boolean {
  if (typeof content === 'string') return content.length > 0;
  return content.length > 0;
}

interface Props {
  message: ChatMessage;
  /** Drop this assistant bubble + re-send the prior user message.
   *  Wired from useChatSession via MessageFeed. */
  onRegenerate?: (messageId: string) => void;
  /** Record / clear positive / negative feedback on this assistant bubble. */
  onFeedback?: (messageId: string, feedback: 'positive' | 'negative' | null) => void;
  /** ADR 0117 Phase 4 — branch a new conversation seeded through THIS turn. Passed as
   *  a STABLE callback + a number (not a per-item closure) so MessageBubble's memo
   *  isn't defeated during streaming. */
  onBranchFrom?: (fromSeq: number) => void;
  branchSeq?: number;
  /** Open the BYOK settings wizard (called from the error card's
   *  "Open BYOK settings" CTA when credentials are missing/expired). */
  onReconfigureBYOK?: () => void;
  /** ADR 0192 D8 — channel mode. `isOwn` decides alignment (other humans also
   *  post role:'user'); `channelAuthor` + `showAttribution` render the sender
   *  header (Avatar + name + timestamp) on non-own bubbles at author changes.
   *  Absent on 1:1 surfaces — behavior unchanged. */
  channelAuthor?: { displayName: string; kind: 'user' | 'agent' | 'other' };
  isOwn?: boolean;
  showAttribution?: boolean;
  /** ADR 0195 D5 — multi-party message affordances: react (everyone), edit +
   *  delete (own messages). Present only on channel/group surfaces; the
   *  feedback thumbs are suppressed there (the D3b boundary ruling). */
  channelActions?: {
    /** May this viewer edit/delete THIS message (own message)? */
    canModify: boolean;
    onToggleReaction: (messageId: string, emoji: string, currentlyMine: boolean) => void;
    onEdit: (messageId: string, newText: string) => void;
    onDelete: (messageId: string) => void;
  };
}

/** Hover-revealed toolbar at the bottom of a settled assistant bubble.
 *  Copy writes the message text to the clipboard with a 2-second
 *  "Copied!" confirmation. Regenerate calls back into useChatSession.
 *  Thumbs toggle a feedback state persisted with the session — pressing
 *  the same direction twice clears it. */
function MessageActions({
  message,
  onRegenerate,
  onFeedback,
  onBranchFrom,
  branchSeq,
  returnTarget,
}: {
  message: ChatMessage;
  onRegenerate?: (id: string) => void;
  onFeedback?: (id: string, fb: 'positive' | 'negative' | null) => void;
  onBranchFrom?: (fromSeq: number) => void;
  branchSeq?: number;
  returnTarget?: ReturnTarget | null;
}): JSX.Element {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(messageText(message));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable; silently ignore */
    }
  }

  // ADR 0334 5b-2 — "Apply to <launcher>": hand THIS assistant response back to
  // the surface that deep-linked into the chat (e.g. the document editor), which
  // applies it as a tracked suggestion on mount. Generic — the chat never knows
  // what the launcher does with the text.
  function applyBack(tgt: ReturnTarget): void {
    stagePendingApply({ canvasId: tgt.canvasId, from: tgt.from, to: tgt.to, text: messageText(message) });
    clearReturnTarget();
    void navigate(tgt.returnPath);
  }

  return (
    <div className="message-actions msgbubble-actions">
      <button type="button" className="msgbubble-action-btn" onClick={copy} aria-label={t('copyMessage')}>
        {copied ? (
          <span className="u-iflex u-items-center u-gap-1">
            <CheckIcon size={13} /> {t('copied')}
          </span>
        ) : t('copy')}
      </button>
      {returnTarget && (
        <button type="button" className="msgbubble-action-btn"
          onClick={() => applyBack(returnTarget)}
          aria-label={t('applyToTarget', { target: returnTarget.label })}
          title={t('applyToTarget', { target: returnTarget.label })}>
          <span className="u-iflex u-items-center u-gap-1">
            <FileTextIcon size={13} /> {t('applyToTargetShort')}
          </span>
        </button>
      )}
      {onRegenerate && (
        <button
          type="button"
          className="msgbubble-action-btn"
          onClick={() => onRegenerate(message.id)}
          aria-label={t('regenerateResponse')}
          title={t('rerunPriorMessage')}
        >
          <span className="u-iflex u-items-center u-gap-1">
            <RotateCwIcon size={13} /> {t('regenerate')}
          </span>
        </button>
      )}
      {onBranchFrom && branchSeq != null && (
        <button
          type="button"
          className="msgbubble-action-btn"
          onClick={() => onBranchFrom(branchSeq)}
          aria-label={t('branchFromHere')}
          title={t('branchFromHereTitle')}
        >
          {t('branch')}
        </button>
      )}
      {onFeedback && (
        <>
          <button
            type="button"
            className={`msgbubble-action-btn ${message.feedback === 'positive' ? 'msgbubble-action-btn-pressed' : ''}`}
            onClick={() =>
              onFeedback(message.id, message.feedback === 'positive' ? null : 'positive')
            }
            aria-label={t('goodResponse')}
            aria-pressed={message.feedback === 'positive'}
          >
            <ThumbsUpIcon size={13} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className={`msgbubble-action-btn ${message.feedback === 'negative' ? 'msgbubble-action-btn-pressed' : ''}`}
            onClick={() =>
              onFeedback(message.id, message.feedback === 'negative' ? null : 'negative')
            }
            aria-label={t('badResponse')}
            aria-pressed={message.feedback === 'negative'}
          >
            <ThumbsDownIcon size={13} strokeWidth={1.75} />
          </button>
        </>
      )}
    </div>
  );
}

/** ADR 0195 D5 — the multi-party hover affordances + reaction chips. Rendered
 *  INSIDE the bubble box, below the content: the persistent chip row (counts,
 *  `mine` highlighted, click-to-toggle) and a hover bar with the curated
 *  reaction picker + Edit/Delete on the viewer's own messages. */
function ChannelMessageExtras({ message, actions }: {
  message: ChatMessage;
  actions: NonNullable<Props['channelActions']>;
}): JSX.Element {
  const { t } = useTranslation('chat');
  const { t: tc } = useTranslation('common');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const mineByEmoji = new Map((message.reactions ?? []).map((r) => [r.emoji, r.mine]));

  if (editing) {
    const commit = (): void => {
      const trimmed = draft.trim();
      setEditing(false);
      if (trimmed && trimmed !== messageText(message)) actions.onEdit(message.id, trimmed);
    };
    return (
      <div className="u-mt-1-5">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
          }}
          rows={2}
          className="msgbubble-edit-input"
          aria-label={t('editMessageAria')}
        />
        <div className="u-flex u-gap-2 u-justify-end u-mt-1">
          <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>{tc('cancel')}</Button>
          <Button variant="primary" size="sm" onClick={commit}>{tc('save')}</Button>
        </div>
      </div>
    );
  }

  return (
    <>
      {(message.reactions?.length ?? 0) > 0 && (
        <div className="msgbubble-reactions" role="group" aria-label={t('reactionsGroupAria')}>
          {message.reactions!.map((r) => (
            <button
              key={r.emoji}
              type="button"
              className={`msgbubble-reaction-chip${r.mine ? ' is-mine' : ''}`}
              onClick={() => actions.onToggleReaction(message.id, r.emoji, r.mine)}
              aria-pressed={r.mine}
              aria-label={t('reactionChipAria', { emoji: r.emoji, count: r.count })}
            >
              <span aria-hidden>{r.emoji}</span>
              <span className="msgbubble-reaction-count" aria-hidden>{r.count}</span>
            </button>
          ))}
        </div>
      )}
      <div className="message-actions msgbubble-actions">
        {REACTION_EMOJI.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="msgbubble-action-btn msgbubble-react-btn"
            onClick={() => actions.onToggleReaction(message.id, emoji, mineByEmoji.get(emoji) === true)}
            aria-label={t('reactWithAria', { emoji })}
            title={t('reactWithAria', { emoji })}
          >
            {emoji}
          </button>
        ))}
        {actions.canModify && (
          <>
            <button
              type="button"
              className="msgbubble-action-btn"
              onClick={() => { setDraft(messageText(message)); setEditing(true); }}
              aria-label={t('editMessageAria')}
            >
              {tc('edit')}
            </button>
            <button
              type="button"
              className="msgbubble-action-btn"
              onClick={() => actions.onDelete(message.id)}
              aria-label={t('deleteMessageAria')}
            >
              {tc('delete')}
            </button>
          </>
        )}
      </div>
    </>
  );
}

function MessageBubbleInner({ message, onRegenerate, onFeedback, onBranchFrom, branchSeq, onReconfigureBYOK, channelAuthor, isOwn, showAttribution, channelActions }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  // Gate B (ADR 0196): the wire-shape inspector is an engineering surface —
  // present only when the `developer-tools` toggle resolves enabled. Context
  // read only; notifies on resolution/auth change, so the memo stays effective.
  const devTools = useFeatureAccess('developer-tools');
  // ADR 0334 5b-2 — a launcher (e.g. the document editor) may have staged a
  // return-target; if so, assistant bubbles offer an "Apply" action.
  const returnTarget = useSyncExternalStore(subscribeReturnTarget, getReturnTarget, getReturnTarget);
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isError = !!message.meta?.error;
  // ADR 0192 D8 — channel mode aligns by AUTHOR, not role: another member's
  // post is role:'user' but renders left with the surface treatment.
  const alignEnd = isOwn ?? isUser;

  // Data-cadenced motion: the thinking heartbeat + streaming caret share one
  // tempo derived from how fast content + reasoning are actually arriving.
  // Hook runs unconditionally (before the isSystem early return) per rules-of-hooks.
  const streamLen = messageText(message).length + (message.thoughts?.content.length ?? 0);
  const cadence = useStreamCadence(streamLen, !!message.isStreaming);

  // Attribution: which agent produced this assistant turn. The default OpenWOP
  // Assistant carries no agentId, so no header — only a named agent (e.g. a
  // council advisor) gets the avatar + name, so a reply is never an unattributed
  // blob. Name is the humanized @handle; the persona tagline is the secondary line.
  const attribution = (!isUser && !isSystem && !isError && (message.agentSlug || message.agentPersona || message.agentId))
    ? {
        // A clean @handle humanizes to the name; else the persona display name
        // verbatim (the voice path stamps this — a raw agentId would otherwise
        // slugify into e.g. "Host:ava Fdf5f7f0"); the id is the last resort.
        name: message.agentSlug
          ? slugToName(message.agentSlug)
          : (message.agentPersona ?? slugToName(message.agentId ?? '')),
        tagline: message.agentSlug ? message.agentPersona : undefined,
        roleTheme: roleThemeForAgentId(message.agentId),
      }
    : null;

  if (isSystem) {
    // A7 (ADR 0467 follow-on) — a held voice tool call renders as an
    // interactive Approve/Deny card (authority enforced server-side).
    if (message.meta?.kind === 'voice-approval-request' && message.meta.toolName && message.meta.callId && message.meta.fcId) {
      return (
        <Suspense fallback={<div className="alert warning msgbubble-system" role="alert">{typeof message.content === 'string' ? message.content : ''}</div>}>
          <VoiceApprovalNotice toolName={message.meta.toolName} callId={message.meta.callId} fcId={message.meta.fcId} />
        </Suspense>
      );
    }
    // System messages (from slash-command handlers like /help) render
    // as a muted info banner, not a bubble. They're always text.
    // Grade-ux fix (2026-07-09): GOVERNANCE-failure notices (the voice
    // sideband degradation, meta.kind 'voice-degraded') must not look like a
    // benign /help note — they get the warning treatment AND role="alert" so
    // a screen-reader user hears the degradation when it streams in live.
    const isWarning = message.meta?.kind === 'voice-degraded';
    // Track-3 i18n — a KNOWN meta.kind renders its localized string; the
    // stored (English) content stays the fallback for unknown kinds and
    // stale bundles, so nothing ever renders blank.
    const text = isWarning
      ? t('voiceDegradedNotice', { defaultValue: typeof message.content === 'string' ? message.content : '' })
      : typeof message.content === 'string' ? message.content : '';
    return (
      <div className={`alert ${isWarning ? 'warning' : 'info'} msgbubble-system`} {...(isWarning ? { role: 'alert' } : {})}>
        {text}
      </div>
    );
  }

  // ADR 0195 D2 — a tombstoned message renders as a quiet placeholder row.
  // Detection is by the server-stamped meta.deletedAt, NEVER the content
  // sentinel; no content, no actions, no reactions.
  if (message.meta?.deletedAt) {
    return (
      <div className="msgbubble-row" style={{ justifyContent: alignEnd ? 'flex-end' : 'flex-start' }}>
        <div className="msgbubble-tombstone">{t('messageDeleted')}</div>
      </div>
    );
  }

  return (
    <div
      className={`msgbubble-row ${alignEnd ? 'u-justify-end' : 'u-justify-start'}`}
    >
      {/* Geometry + the role/error variants live in .msgbubble-box CSS (§10 /
          CHAT-5); whiteSpace + wordBreak are applied inside MessageRenderer's
          text segments so code blocks keep their own `white-space: pre`. */}
      {/* data-streaming lets the ADR 0565 selection-rewrite overlay skip
          bubbles whose text is still changing under the selection. */}
      <div className="msgbubble-box" data-role={isError ? 'error' : alignEnd ? 'user' : 'assistant'} {...(message.isStreaming ? { 'data-streaming': 'true' } : {})}>
        {attribution && (
          <div className="msgbubble-attribution">
            <AgentAvatar persona={attribution.name} roleTheme={attribution.roleTheme} size={22} showBadge={false} alt="" />
            <span className="msgbubble-attribution-text">
              <span className="msgbubble-attribution-name">{attribution.name}</span>
              {attribution.tagline ? <span className="msgbubble-attribution-tagline">{attribution.tagline}</span> : null}
            </span>
          </div>
        )}
        {/* ADR 0192 D8 — channel sender header: the SAME quiet attribution
            grammar, driven by the resolved author (humans get the hue-wash
            avatar; agent authors the clay circle) + a mono timestamp. Grouping
            (showAttribution) keeps consecutive same-author runs calm. */}
        {!attribution && channelAuthor && showAttribution && (
          <div className="msgbubble-attribution">
            <Avatar name={channelAuthor.displayName} size={22} kind={channelAuthor.kind === 'agent' ? 'agent' : 'user'} />
            <span className="msgbubble-attribution-text">
              <span className="msgbubble-attribution-name">
                {channelAuthor.displayName}
                {/* ADR 0202 D4 — a bot badge marks an agent-authored message. */}
                {channelAuthor.kind === 'agent' && <span className="msgbubble-bot-badge">{t('botBadge')}</span>}
              </span>
            </span>
            {message.createdAt && (
              <time className="msgbubble-attribution-time" dateTime={message.createdAt} aria-label={t('messageTimestampAria', { time: formatTime(message.createdAt) })}>
                {formatTime(message.createdAt)}
              </time>
            )}
          </div>
        )}
        {/* ADV-UX-5 / WF-BOA-8 — an orchestrator-authored hand-off, labelled as
            such. Without this the transcript reads as the human saying "As
            chair, synthesize the board's perspectives into a clear
            recommendation." — words they never typed. */}
        {isUser && message.orchestrated && (
          <span className="msgbubble-orchestrated u-fs-11 u-o-70">{t('orchestratedTurnLabel')}</span>
        )}
        {!isUser && message.thoughts && (
          <ThoughtsDisclosure thoughts={message.thoughts} />
        )}
        {hasContent(message.content)
          ? <MessageRenderer content={message.content} markdown={!isUser} rendering={isUser ? undefined : message.meta?.rendering} />
          : message.isStreaming && !message.thoughts
            ? <ThinkingIndicator durationVar={cadence} />
            : isError
              ? <span className="u-o-70">{t('noResponseSeeError')}</span>
              : null}
        {message.isStreaming && hasContent(message.content) && (
          <span className="msgbubble-cursor" aria-hidden style={{ '--msg-caret-dur': cadence } as CSSProperties} />
        )}
        {/* ADR 0195 D1 — the server-stamped edit marker. */}
        {message.meta?.editedAt && (
          <span className="msgbubble-edited muted" title={message.meta.editedAt}>{t('messageEdited')}</span>
        )}
        {/* VOXUX-1 — spoken turns (realtime voice transcripts) carry a quiet
            provenance marker: without it a mixed thread gives no way to tell
            what was said aloud vs typed (icon decorative; the LABEL carries it). */}
        {message.meta?.source === 'voice-realtime' && !message.isStreaming && (
          <span className="msgbubble-voicemark muted"><MicIcon size={11} aria-hidden /> {t('spokenTurn')}</span>
        )}
        {/* RCL-UX-1 — the recall-use marker: this reply drew on the viewer's
            OWN shared memories (post-ADR 0589 the acting caller IS the twin's
            owner, so this is first-party disclosure, not a leak). Same quiet
            provenance grammar as the spoken-turn mark above. */}
        {!isUser && message.meta?.twinRecalled && !message.isStreaming && (
          <span className="msgbubble-voicemark muted"><SparklesIcon size={11} aria-hidden /> {t('twinRecallUsed')}</span>
        )}
        {/* ADR 0665 D4 — the advisor answered with nothing. Rendered as a muted
            note rather than an empty bubble: an empty bubble in a council reads as
            assent, and the chair synthesises over the same transcript. role="note",
            like the reduced-context notice below — it accompanies a settled turn,
            it is not a live interruption. */}
        {!isUser && message.meta?.noContribution && !message.isStreaming && (
          <span className="msgbubble-voicemark muted" role="note">{t('noContributionNotice')}</span>
        )}
        {/* RCL-UX-2 / RCL-7 — the reduced-context notice. The backend has told
            the MODEL what failed to load since WF-BOA-4; this is the first
            surface that tells the HUMAN the reply was composed without it.
            Labels ride the same localized voiceCtxBlock catalog as the voice
            chip (one vocabulary for one ledger). role="note", not alert: it
            renders with the settled reply, not as a live interruption. */}
        {!isUser && !message.isStreaming && (message.meta?.degradedBlocks?.length ?? 0) > 0 && (
          <div className="alert warning u-fs-12" role="note">
            {t('contextDegradedNotice', { blocks: voiceCtxBlockLabels((k) => t(k), message.meta?.degradedBlocks ?? []) })}
          </div>
        )}
        {/* ADR 0195 D5 — multi-party affordances (reaction chips + hover bar
            with the curated picker and own-message Edit/Delete). The feedback
            thumbs never render alongside these (the D3b boundary ruling). */}
        {channelActions && !message.isStreaming && !isError && (
          <ChannelMessageExtras message={message} actions={channelActions} />
        )}
        {message.meta?.error && (
          <ErrorCard
            error={message.meta.error}
            {...(onReconfigureBYOK ? { onReconfigure: onReconfigureBYOK } : {})}
            {...(onRegenerate ? { onRetry: () => onRegenerate(message.id) } : {})}
          />
        )}
        {!isUser && message.reasoning && (
          <ReasoningDisclosure reasoning={message.reasoning} />
        )}
        {!isUser && hasEnvelopeEvents(message.envelopeEvents) && message.envelopeEvents && (
          <EnvelopeEventsTimeline
            envelopeEvents={message.envelopeEvents}
            {...(onReconfigureBYOK ? { onReconfigure: onReconfigureBYOK } : {})}
          />
        )}
        {!isUser && message.agentEvents && (
          <div className="u-mt-2">
            {message.agentEvents.handoffs.map((h, i) => (
              <HandoffIndicator key={`h-${i}-${h.at}`} handoff={h} />
            ))}
            {message.agentEvents.toolCalls.map((tc) => (
              <ToolCallCard key={`tc-${tc.callId}`} call={tc} />
            ))}
            {message.agentEvents.decisions.map((d, i) => (
              <DecisionBadge key={`d-${i}-${d.at}`} decision={d} />
            ))}
            {(message.agentEvents.verified ?? []).map((v, i) => (
              <VerificationCard key={`v-${i}-${v.at}`} verified={v} />
            ))}
          </div>
        )}
        {!isUser && !message.isStreaming && message.meta && !message.meta.error && (
          <div className="muted u-mt-1-5 u-fs-11 u-o-70">
            {message.meta.provider && message.meta.model && (
              <span>{message.meta.provider}/{message.meta.model}</span>
            )}
            {message.meta.inputTokens != null && (
              <span>{t('tokensIn', { count: formatNumber(message.meta.inputTokens) })}</span>
            )}
            {message.meta.outputTokens != null && (
              <span>{t('tokensOut', { count: formatNumber(message.meta.outputTokens) })}</span>
            )}
            {(() => {
              const cost = turnCostUsd(message.meta);
              return cost != null ? <span> · {formatUsd(cost)}</span> : null;
            })()}
            {message.meta.citations && message.meta.citations.length > 0 && (
              <span className="u-iflex u-items-center u-gap-1 u-ml-1">
                · <GlobeIcon size={11} /> {t('sources', { count: message.meta.citations.length })}
              </span>
            )}
          </div>
        )}
        {!isUser && !message.isStreaming && !isError && hasContent(message.content) && (onRegenerate || onFeedback || (onBranchFrom && branchSeq != null) || returnTarget) && (
          <MessageActions
            message={message}
            {...(onRegenerate ? { onRegenerate } : {})}
            {...(onFeedback ? { onFeedback } : {})}
            {...(onBranchFrom && branchSeq != null ? { onBranchFrom, branchSeq } : {})}
            returnTarget={returnTarget}
          />
        )}
        {/* Wire-shape inspector — collapsed by default; opens to show
            every `agent.*` + `envelope.*` event the turn emitted. Mounted
            only under the `developer-tools` toggle (ADR 0196 Gate B). */}
        {!isUser && !message.isStreaming && devTools.enabled && (
          <EnvelopeInspector message={message} />
        )}
        {!isUser && !message.isStreaming && message.meta?.citations && message.meta.citations.length > 0 && (
          <div className="u-mt-2 u-flex u-wrap u-gap-1-5">
            {message.meta.citations.map((c, i) => {
              let host = '';
              try { host = new URL(c.url).host.replace(/^www\./, ''); } catch { host = c.url; }
              // Citation URLs come from provider web-search results — only ever link
              // out over http(s). A non-web scheme (e.g. javascript:) renders as inert
              // text, never an href (defence-in-depth alongside React + CSP).
              const safe = /^https?:\/\//i.test(c.url);
              const label = `[${i + 1}] ${c.title ?? host}`;
              return safe ? (
                <a
                  key={`${i}-${c.url}`}
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={c.title ?? c.url}
                  className="msgbubble-citation"
                >
                  {label}
                </a>
              ) : (
                <span key={`${i}-${c.url}`} title={c.title ?? c.url} className="msgbubble-citation">
                  {label}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// Memoized (GAP-ANALYSIS E14): the streaming reducer remaps the message array
// on every token but preserves object identity for UNCHANGED messages
// (`.map(m => isStreaming ? {...m} : m)`), so a default shallow compare lets
// every settled bubble skip re-render+re-parse while only the streaming bubble
// updates. Effective as long as the callback props are stable (they are
// useCallback-stabilized at the ChatSidebar source).
export const MessageBubble = memo(MessageBubbleInner);
