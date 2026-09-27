/**
 * ADR 0311 P3 — the board's "Needs review" lane: pending reviews whose
 * provenance names THIS board (heartbeat proposals from its cards), rendered
 * read-time from the ADR 0068 projection on the SHARED ReviewCard. A VIEW,
 * never an owner — no card rows are minted per approval; decisions dispatch to
 * the existing review actions. Renders nothing when the board has no pending
 * reviews (the common case stays visually unchanged).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listReviews, decideReview, type ReviewRequest } from '../chat/reviews/reviewClient.js';
import { ReviewCard } from '../chat/reviews/ReviewCard.js';

export function BoardReviewsSection({ boardId }: { boardId: string }): JSX.Element | null {
  const { t } = useTranslation('kanban');
  const [reviews, setReviews] = useState<ReviewRequest[]>([]);

  const load = useCallback(() => {
    void listReviews('pending', { boardId })
      .then(setReviews)
      .catch(() => { /* fail-soft: the review inbox remains the full surface */ });
  }, [boardId]);
  useEffect(() => { load(); }, [load]);

  if (reviews.length === 0) return null;
  return (
    <section aria-label={t('needsReviewHeading')} className="surface-card u-pad-2 u-flex u-flex-col u-gap-2">
      <h3 className="u-fs-13 u-m-0">{t('needsReviewHeading')}</h3>
      {reviews.map((r) => (
        <ReviewCard
          key={r.reviewId}
          review={r}
          compact
          onDecide={async (action, body) => { await decideReview(r.reviewId, action, body); load(); }}
        />
      ))}
    </section>
  );
}
