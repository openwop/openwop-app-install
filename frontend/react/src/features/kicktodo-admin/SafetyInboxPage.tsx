/**
 * KickTodo Safety & approvals inbox (ADR 0438 A2) — the operator surface for the
 * KickTodo human-review decisions: community profile submissions, flagged reviews,
 * and challenge publication approvals.
 *
 * It does NOT build a parallel queue (ADR 0438 §2). It composes the ONE shared
 * review system (ADR 0068/0074): the same `reviewStatusStore` (single client
 * source of truth, live over the broadcast signal) and the same `<ReviewCard>`
 * renderer the chat inbox uses — filtered to the KickTodo approval `kind`s. A
 * decision made here updates every other surface, and the server enforces the
 * moderator/publisher authority (the FE only presents + delegates). Admin-tier:
 * `<AdminLayout>` gates the page on `isAdminCaller`; the backend routes 403 on
 * their own regardless.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { InboxIcon, AlertIcon } from '../../ui/icons/index.js';
import { ReviewCard } from '../../chat/reviews/ReviewCard.js';
import { useReviewStatusStore, useReviewList } from '../../chat/reviews/reviewStatusStore.js';
import { isKickTodoReviewKind } from './kicktodoReviewKinds.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';

export function SafetyInboxPage(): JSX.Element {
  const { t } = useTranslation('kicktodo-admin');
  const all = useReviewList();
  const reviews = all.filter((r) => isKickTodoReviewKind(r.kind));
  const loading = useReviewStatusStore((s) => s.loading);
  const error = useReviewStatusStore((s) => s.error);
  const errorCause = useReviewStatusStore((s) => s.errorCause);
  const initialized = useReviewStatusStore((s) => s.initialized);
  const connect = useReviewStatusStore((s) => s.connect);
  const disconnect = useReviewStatusStore((s) => s.disconnect);
  const refresh = useReviewStatusStore((s) => s.refresh);
  const decideInStore = useReviewStatusStore((s) => s.decide);
  const [notice, setNotice] = useState<string | null>(null);

  // Ref-counted connect, mirroring ReviewInboxPanel — the store stays live off
  // the broadcast signal; this page just shares the subscription while mounted.
  useEffect(() => {
    void connect();
    return () => disconnect();
  }, [connect, disconnect]);

  const decide = async (reviewId: string, action: string, body: { value?: unknown; note?: string }): Promise<void> => {
    setNotice(null);
    // ADR 0778 (`APUX-19`) — a 409 is someone ELSE's decision: never "recorded".
    const outcome = await decideInStore(reviewId, action, body);
    setNotice(outcome === 'already-resolved' ? t('chat:reviewResolvedElsewhere') : t('decisionRecorded'));
  };

  return (
    <div className="page" data-walkthrough="admin-kicktodo-safety.page">
      <PageHeader title={t('safetyTitle')} lede={t('safetyLede')} />

      {/* Honest scope note: authority is enforced server-side; this surface only
          presents the queue + delegates the decision (§3.4 / B15). */}
      <Notice variant="info">{t('safetyAuthorityNote')}</Notice>

      {/* Outside the list branch: deciding the LAST card empties the list
          before the outcome is known (ADR 0778, closing review B1). */}
      {notice ? <Notice variant="success" announce={notice}>{notice}</Notice> : null}

      {(!initialized || loading) && reviews.length === 0 && <StateCard loading title={t('safetyTitle')} />}
      {error && reviews.length === 0 && (
        <StateCard announce icon={<AlertIcon aria-hidden />} title={t('safetyErrorTitle')} body={loadErrorMessage(t, errorCause ?? error)}
          action={<Button variant="quiet" size="sm" onClick={() => void refresh()}>{t('retry')}</Button>} />
      )}
      {initialized && !loading && !error && reviews.length === 0 && (
        <StateCard icon={<InboxIcon aria-hidden />} title={t('safetyEmptyTitle')} body={t('safetyEmptyBody')} />
      )}

      {reviews.length > 0 && (
        <section className="review-inbox" aria-label={t('safetyTitle')}>
          <ul className="review-inbox__list">
            {reviews.map((r) => (
              <li key={r.reviewId}>
                <ReviewCard review={r} onDecide={(action, cardBody) => decide(r.reviewId, action, cardBody)} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
