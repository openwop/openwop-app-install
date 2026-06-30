/**
 * Single chat message bubble. User vs assistant differentiated by:
 *   - alignment (right vs left)
 *   - background (accent vs surface-2)
 *   - text color (white vs default)
 *
 * Streaming bubbles get a subtle pulsing cursor at the end of content.
 * Bubbles with `meta.error` render in a warn-tinted state.
 */

import { memo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from './hooks/useChatSession.js';
import { messageText } from './hooks/useChatSession.js';
import { MessageRenderer } from './MessageRenderer.js';
import { ThoughtsDisclosure } from './ThoughtsDisclosure.js';
import { ThinkingIndicator } from './ThinkingIndicator.js';
import { useStreamCadence } from './hooks/useStreamCadence.js';
import { ToolCallCard, HandoffIndicator, DecisionBadge, VerificationCard } from './AgentEventCards.js';
import { EnvelopeEventsTimeline, hasEnvelopeEvents } from './EnvelopeEventsTimeline.js';
import { EnvelopeInspector } from './EnvelopeInspector.js';
import { ReasoningDisclosure } from './ReasoningDisclosure.js';
import { ErrorCard } from './ErrorCard.js';
import { formatUsd, turnCostUsd } from './lib/cost.js';
import { formatNumber } from '../i18n/format.js';
import { CheckIcon, GlobeIcon, RotateCwIcon, ThumbsDownIcon, ThumbsUpIcon } from '../ui/icons/index.js';
import { AgentAvatar } from '../agents/AgentAvatar.js';
import { roleThemeForAgent } from '../agents/roleTemplates.js';
import { slugToName } from './lib/agentMentions.js';

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
}: {
  message: ChatMessage;
  onRegenerate?: (id: string) => void;
  onFeedback?: (id: string, fb: 'positive' | 'negative' | null) => void;
  onBranchFrom?: (fromSeq: number) => void;
  branchSeq?: number;
}): JSX.Element {
  const { t } = useTranslation('chat');
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

  return (
    <div className="message-actions msgbubble-actions">
      <button type="button" className="msgbubble-action-btn" onClick={copy} aria-label={t('copyMessage')}>
        {copied ? (
          <span className="u-iflex u-items-center u-gap-1">
            <CheckIcon size={13} /> {t('copied')}
          </span>
        ) : t('copy')}
      </button>
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

function MessageBubbleInner({ message, onRegenerate, onFeedback, onBranchFrom, branchSeq, onReconfigureBYOK }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isError = !!message.meta?.error;

  // Data-cadenced motion: the thinking heartbeat + streaming caret share one
  // tempo derived from how fast content + reasoning are actually arriving.
  // Hook runs unconditionally (before the isSystem early return) per rules-of-hooks.
  const streamLen = messageText(message).length + (message.thoughts?.content.length ?? 0);
  const cadence = useStreamCadence(streamLen, !!message.isStreaming);

  // Attribution: which agent produced this assistant turn. The default OpenWOP
  // Assistant carries no agentId, so no header — only a named agent (e.g. a
  // council advisor) gets the avatar + name, so a reply is never an unattributed
  // blob. Name is the humanized @handle; the persona tagline is the secondary line.
  const attribution = (!isUser && !isSystem && !isError && (message.agentSlug || message.agentId))
    ? {
        name: slugToName(message.agentSlug ?? message.agentId ?? ''),
        tagline: message.agentPersona,
        roleTheme: roleThemeForAgent(message.agentId, []),
      }
    : null;

  if (isSystem) {
    // System messages (from slash-command handlers like /help) render
    // as a muted info banner, not a bubble. They're always text.
    const text = typeof message.content === 'string' ? message.content : '';
    return (
      <div className="alert info msgbubble-system">
        {text}
      </div>
    );
  }

  return (
    <div
      className="msgbubble-row"
      style={{ justifyContent: isUser ? 'flex-end' : 'flex-start' }}
    >
      <div style={{
        maxWidth: 'var(--max-bubble-width, 75ch)',
        padding: '8px 12px',
        borderRadius: 'var(--radius-bubble, 16px)',
        background: isError
          ? 'color-mix(in oklch, var(--color-danger) 10%, transparent)'
          : isUser
            ? 'var(--color-msg-user-bg)'
            : 'var(--color-msg-assistant-bg)',
        color: isUser ? 'var(--color-msg-user-text)' : 'var(--ink)',
        border: isError ? '1px solid var(--color-danger)' : '1px solid transparent',
        fontSize: 14,
        lineHeight: 1.5,
        // whiteSpace + wordBreak applied inside MessageRenderer's text segments
        // so code blocks can use their own `white-space: pre` formatting.
      }}>
        {attribution && (
          <div className="msgbubble-attribution">
            <AgentAvatar persona={attribution.name} roleTheme={attribution.roleTheme} size={22} showBadge={false} alt="" />
            <span className="msgbubble-attribution-text">
              <span className="msgbubble-attribution-name">{attribution.name}</span>
              {attribution.tagline ? <span className="msgbubble-attribution-tagline">{attribution.tagline}</span> : null}
            </span>
          </div>
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
        {!isUser && !message.isStreaming && !isError && hasContent(message.content) && (onRegenerate || onFeedback || (onBranchFrom && branchSeq != null)) && (
          <MessageActions
            message={message}
            {...(onRegenerate ? { onRegenerate } : {})}
            {...(onFeedback ? { onFeedback } : {})}
            {...(onBranchFrom && branchSeq != null ? { onBranchFrom, branchSeq } : {})}
          />
        )}
        {/* Wire-shape inspector — collapsed by default; opens to show
            every `agent.*` + `envelope.*` event the turn emitted. */}
        {!isUser && !message.isStreaming && (
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
