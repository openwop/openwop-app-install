/**
 * Single chat message bubble. User vs assistant differentiated by:
 *   - alignment (right vs left)
 *   - background (accent vs surface-2)
 *   - text color (white vs default)
 *
 * Streaming bubbles get a subtle pulsing cursor at the end of content.
 * Bubbles with `meta.error` render in a warn-tinted state.
 */

import { memo, useState } from 'react';
import type { ChatMessage } from './hooks/useChatSession.js';
import { messageText } from './hooks/useChatSession.js';
import { MessageRenderer } from './MessageRenderer.js';
import { ThoughtsDisclosure } from './ThoughtsDisclosure.js';
import { ToolCallCard, HandoffIndicator, DecisionBadge, VerificationCard } from './AgentEventCards.js';
import { EnvelopeEventsTimeline, hasEnvelopeEvents } from './EnvelopeEventsTimeline.js';
import { EnvelopeInspector } from './EnvelopeInspector.js';
import { ReasoningDisclosure } from './ReasoningDisclosure.js';
import { ErrorCard } from './ErrorCard.js';
import { formatUsd, turnCostUsd } from './lib/cost.js';
import { CheckIcon, GlobeIcon, RotateCwIcon, ThumbsDownIcon, ThumbsUpIcon } from '../ui/icons/index.js';

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
}: {
  message: ChatMessage;
  onRegenerate?: (id: string) => void;
  onFeedback?: (id: string, fb: 'positive' | 'negative' | null) => void;
}): JSX.Element {
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
      <button type="button" className="msgbubble-action-btn" onClick={copy} aria-label="Copy message">
        {copied ? (
          <span className="u-iflex u-items-center u-gap-1">
            <CheckIcon size={13} /> Copied
          </span>
        ) : 'Copy'}
      </button>
      {onRegenerate && (
        <button
          type="button"
          className="msgbubble-action-btn"
          onClick={() => onRegenerate(message.id)}
          aria-label="Regenerate response"
          title="Re-run the prior user message"
        >
          <span className="u-iflex u-items-center u-gap-1">
            <RotateCwIcon size={13} /> Regenerate
          </span>
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
            aria-label="Good response"
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
            aria-label="Bad response"
            aria-pressed={message.feedback === 'negative'}
          >
            <ThumbsDownIcon size={13} strokeWidth={1.75} />
          </button>
        </>
      )}
    </div>
  );
}

function MessageBubbleInner({ message, onRegenerate, onFeedback, onReconfigureBYOK }: Props): JSX.Element {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isError = !!message.meta?.error;

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
        {!isUser && message.thoughts && (
          <ThoughtsDisclosure thoughts={message.thoughts} />
        )}
        {hasContent(message.content)
          ? <MessageRenderer content={message.content} markdown={!isUser} rendering={isUser ? undefined : message.meta?.rendering} />
          : message.isStreaming && !message.thoughts
            ? <span className="u-o-60">Thinking…</span>
            : isError
              ? <span className="u-o-70">No response — see error below.</span>
              : null}
        {message.isStreaming && hasContent(message.content) && (
          <span className="msgbubble-cursor" />
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
              <span> · in {message.meta.inputTokens}</span>
            )}
            {message.meta.outputTokens != null && (
              <span> · out {message.meta.outputTokens}</span>
            )}
            {(() => {
              const cost = turnCostUsd(message.meta);
              return cost != null ? <span> · {formatUsd(cost)}</span> : null;
            })()}
            {message.meta.citations && message.meta.citations.length > 0 && (
              <span className="u-iflex u-items-center u-gap-1 u-ml-1">
                · <GlobeIcon size={11} /> {message.meta.citations.length} source{message.meta.citations.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}
        {!isUser && !message.isStreaming && !isError && hasContent(message.content) && (onRegenerate || onFeedback) && (
          <MessageActions message={message} {...(onRegenerate ? { onRegenerate } : {})} {...(onFeedback ? { onFeedback } : {})} />
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
              return (
                <a
                  key={`${i}-${c.url}`}
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={c.title ?? c.url}
                  className="msgbubble-citation"
                >
                  [{i + 1}] {c.title ?? host}
                </a>
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
