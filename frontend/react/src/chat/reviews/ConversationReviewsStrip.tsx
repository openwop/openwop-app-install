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
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listReviews, decideReview, type ReviewRequest } from './reviewClient.js';
import { ReviewCard } from './ReviewCard.js';

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

  if (reviews.length === 0) return null;
  return (
    <section aria-label={t('conversationReviewsHeading')} className="u-flex u-flex-col u-gap-2 u-pad-2-4">
      <h4 className="muted u-fs-12 u-m-0">{t('conversationReviewsHeading')}</h4>
      {reviews.map((r) => (
        <ReviewCard
          key={r.reviewId}
          review={r}
          compact
          onDecide={async (action, body) => {
            // ADR 0473 (review F2) — refresh on FAILURE too: a proposal_stale
            // 409 means the draft changed; the reloaded card carries the fresh
            // liveDefinitionHash + the edited notice, so the retry can succeed.
            try {
              await decideReview(r.reviewId, action, body);
            } finally {
              load();
            }
          }}
        />
      ))}
    </section>
  );
}
