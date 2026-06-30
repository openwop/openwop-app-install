/**
 * ReviewInboxPanel (ADR 0068) — the one place a person sees every pending human
 * review: runtime interrupts AND pre-execution approvals, in one list, each
 * rendered by the shared ReviewCard.
 *
 * ADR 0074 — reads/writes through the shared `reviewStatusStore` (the single
 * client source of truth), so a decision made HERE updates every other surface
 * and a decision made elsewhere (Runs screen, in-chat card, another client)
 * updates THIS list live. No local fetch — the store hydrates + stays live off
 * the broadcast signal; this panel just connects (ref-counted) while mounted.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StateCard, Notice } from '../../ui/index.js';
import { InboxIcon, AlertIcon } from '../../ui/icons/index.js';
import { ReviewCard } from './ReviewCard.js';
import { useReviewStatusStore, useReviewList } from './reviewStatusStore.js';

interface Props {
  /** Optional: jump to a source surface (run detail) from a card. */
  onOpenRun?: (runId: string) => void;
  /** Open the artifact workbench for a review pinned to (artifactId, revisionId). */
  onOpenArtifact?: (artifactId: string, revisionId?: string) => void;
}

export function ReviewInboxPanel({ onOpenArtifact }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const reviews = useReviewList();
  const loading = useReviewStatusStore((s) => s.loading);
  const error = useReviewStatusStore((s) => s.error);
  const connect = useReviewStatusStore((s) => s.connect);
  const disconnect = useReviewStatusStore((s) => s.disconnect);
  const refresh = useReviewStatusStore((s) => s.refresh);
  const decideInStore = useReviewStatusStore((s) => s.decide);
  const [notice, setNotice] = useState<string | null>(null);

  // Ref-counted: the rail (ChatSidebar) also connects so the badge stays live
  // when this tab is closed; sharing the subscription here is a no-op beyond
  // the refcount.
  useEffect(() => {
    void connect();
    return () => disconnect();
  }, [connect, disconnect]);

  const decide = async (reviewId: string, action: string, body: { value?: unknown; note?: string }): Promise<void> => {
    await decideInStore(reviewId, action, body);
    setNotice(t('reviewDecisionRecorded'));
  };

  if (loading && reviews.length === 0) {
    return <StateCard loading title={t('reviewInboxLoading')} />;
  }
  if (error && reviews.length === 0) {
    return (
      <StateCard
        icon={<AlertIcon />}
        title={t('reviewInboxErrorTitle')}
        body={error}
        action={<button type="button" className="secondary btn-sm" onClick={() => void refresh()}>{t('common:retry')}</button>}
      />
    );
  }
  if (reviews.length === 0) {
    return (
      <StateCard
        icon={<InboxIcon />}
        title={t('reviewInboxEmptyTitle')}
        body={t('reviewInboxEmptyBody')}
      />
    );
  }

  return (
    <section className="review-inbox" aria-label={t('reviewInboxLabel')}>
      {notice ? <Notice variant="success">{notice}</Notice> : null}
      <ul className="review-inbox__list">
        {reviews.map((r) => (
          <li key={r.reviewId}>
            <ReviewCard review={r} onDecide={(action, body) => decide(r.reviewId, action, body)} {...(onOpenArtifact ? { onOpenArtifact } : {})} />
          </li>
        ))}
      </ul>
    </section>
  );
}
