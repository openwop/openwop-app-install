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
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { InboxIcon, AlertIcon } from '../../ui/icons/index.js';
import { ReviewCard } from '../../chat/reviews/ReviewCard.js';
import { useReviewStatusStore, useReviewList } from '../../chat/reviews/reviewStatusStore.js';
import { isKickTodoReviewKind } from './kicktodoReviewKinds.js';

export function SafetyInboxPage(): JSX.Element {
  const { t } = useTranslation('kicktodo-admin');
  const all = useReviewList();
  const reviews = all.filter((r) => isKickTodoReviewKind(r.kind));
  const loading = useReviewStatusStore((s) => s.loading);
  const error = useReviewStatusStore((s) => s.error);
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
    await decideInStore(reviewId, action, body);
    setNotice(t('decisionRecorded'));
  };

  return (
    <div className="page" data-walkthrough="admin-kicktodo-safety.page">
      <header className="page-header">
        <h1 className="page-header__title">{t('safetyTitle')}</h1>
        <p className="page-header__lede">{t('safetyLede')}</p>
      </header>

      {/* Honest scope note: authority is enforced server-side; this surface only
          presents the queue + delegates the decision (§3.4 / B15). */}
      <Notice variant="info">{t('safetyAuthorityNote')}</Notice>

      {(!initialized || loading) && reviews.length === 0 && <StateCard loading title={t('safetyTitle')} />}
      {error && reviews.length === 0 && (
        <StateCard announce icon={<AlertIcon aria-hidden />} title={t('safetyErrorTitle')} body={error}
          action={<Button variant="quiet" size="sm" onClick={() => void refresh()}>{t('retry')}</Button>} />
      )}
      {initialized && !loading && !error && reviews.length === 0 && (
        <StateCard icon={<InboxIcon aria-hidden />} title={t('safetyEmptyTitle')} body={t('safetyEmptyBody')} />
      )}

      {reviews.length > 0 && (
        <section className="review-inbox" aria-label={t('safetyTitle')}>
          {notice ? <Notice variant="success" announce={notice}>{notice}</Notice> : null}
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
