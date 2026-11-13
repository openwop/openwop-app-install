/**
 * ADR 0311 P2 — the conversation-scoped review strip: pending approvals that
 * TRACE BACK to this chat (a todo filed here → the heartbeat proposed it →
 * the approval carries `conversationId`) render right where the promise was
 * made, on the SHARED `ReviewCard` (one card model — ADR 0068; approve/reject
 * dispatch to the existing review actions, never a second decision path).
 *
 * Authorization is the projection's: the list returns only reviews the caller
 * may act on, so non-approvers in the conversation simply see nothing (a
 * deliberate deviation from the ADR's "neutral chip" sketch — no partial
 * information surface at all).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listReviews, type ReviewRequest } from './reviewClient.js';
import { ReviewCard } from './ReviewCard.js';
import { useReviewStatusStore } from './reviewStatusStore.js';

export function ConversationReviewsStrip({ conversationId, isSending }: {
  conversationId: string;
  /** The chat's in-flight flag — its falling edge re-checks (a turn may have
   *  just filed the todo whose proposal lands moments later). */
  isSending: boolean;
}): JSX.Element | null {
  const { t } = useTranslation('chat');
  const [reviews, setReviews] = useState<ReviewRequest[]>([]);

  const load = useCallback(() => {
    void listReviews('pending', { conversationId })
      .then(setReviews)
      .catch(() => { /* fail-soft: the inbox panel remains the full surface */ });
  }, [conversationId]);

  // Load on conversation open + on each turn settling.
  useEffect(() => { load(); }, [load]);
  const prevSendingRef = useRef(isSending);
  useEffect(() => {
    const fellIdle = prevSendingRef.current && !isSending;
    prevSendingRef.current = isSending;
    if (fellIdle) load();
  }, [isSending, load]);

  // CC-CHAT-3 — the strip's list is read only on mount and when a turn settles,
  // so a gate resolved elsewhere (the in-feed card, the Reviews tab, another
  // person) kept live buttons here and a click answered 409. Follow the ONE
  // shared live status (the `review.updated` frames + local decisions feed it):
  // a review it knows is terminal — by id, or by the run+node a run-scoped card
  // resolved — is dropped. (The chat shell — ChatSidebar / TabChatDeck — keeps
  // the store connected to the signal bus while chat is open; the strip only reads.)
  const statusById = useReviewStatusStore((s) => s.statusById);
  const live = useMemo(() => {
    const terminal = Object.values(statusById).filter((e) => e.status !== 'pending');
    if (terminal.length === 0) return reviews;
    return reviews.filter((r) => {
      // The review's OWN entry wins (a pending entry keeps it, e.g. a reopened row);
      // the run+node match is only a fallback when the store has none for this id.
      const own = statusById[r.reviewId];
      if (own) return own.status === 'pending';
      return !(r.runId && r.nodeId && terminal.some((e) => e.runId === r.runId && e.nodeId === r.nodeId));
    });
  }, [reviews, statusById]);

  if (live.length === 0) return null;
  return (
    <section aria-label={t('conversationReviewsHeading')} className="u-flex u-flex-col u-gap-2 u-pad-2-4">
      <h4 className="muted u-fs-12 u-m-0">{t('conversationReviewsHeading')}</h4>
      {live.map((r) => (
        <ReviewCard
          key={r.reviewId}
          review={r}
          compact
          onDecide={async (action, body) => {
            // ADR 0473 (review F2) — refresh on FAILURE too: a proposal_stale
            // 409 means the draft changed; the reloaded card carries the fresh
            // liveDefinitionHash + the edited notice, so the retry can succeed.
            try {
              // ADR 0778 (`APUX-8`) — through the shared store (badge + every
              // surface update, 409 judged by status, failures survive remount).
              await useReviewStatusStore.getState().decide(r.reviewId, action, body);
            } finally {
              load();
            }
          }}
        />
      ))}
    </section>
  );
}
