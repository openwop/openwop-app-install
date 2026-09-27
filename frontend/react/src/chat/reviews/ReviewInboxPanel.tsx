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

import { Button } from '../../ui/Button.js';
import { Suspense, lazy, useEffect, useState } from 'react';
const SlaPolicySection = lazy(() => import('./SlaPolicySection.js').then((m) => ({ default: m.SlaPolicySection })));
import { useTranslation } from 'react-i18next';

import { StateCard, Notice } from '../../ui/index.js';
import { InboxIcon, AlertIcon } from '../../ui/icons/index.js';
import { ReviewCard } from './ReviewCard.js';
import { LeftRailPanelHeader } from '../leftRail/LeftRailPanelHeader.js';
import { useReviewStatusStore, useReviewList } from './reviewStatusStore.js';

interface Props {
  /** Optional: jump to a source surface (run detail) from a card. */
  onOpenRun?: (runId: string) => void;
  /** Open the artifact workbench for a review pinned to (artifactId, revisionId). */
  onOpenArtifact?: (artifactId: string, revisionId?: string) => void;
  /** Close the left-rail panel (shared header + Escape), like the sibling tabs. */
  onClose: () => void;
}

export function ReviewInboxPanel({ onOpenArtifact, onClose }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const reviews = useReviewList();
  const loading = useReviewStatusStore((s) => s.loading);
  const error = useReviewStatusStore((s) => s.error);
  const initialized = useReviewStatusStore((s) => s.initialized);
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

  const headingId = 'review-inbox-panel-heading';

  const body = ((): JSX.Element => {
    if ((!initialized || loading) && reviews.length === 0) {
      return <StateCard loading title={t('reviewInboxLoading')} />;
    }
    if (error && reviews.length === 0) {
      return (
        <StateCard
          announce
          icon={<AlertIcon />}
          title={t('reviewInboxErrorTitle')}
          body={error}
          action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('common:retry')}</Button>}
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
        {notice ? <Notice variant="success" announce={notice}>{notice}</Notice> : null}
        <ul className="review-inbox__list">
          {reviews.map((r) => (
            <li key={r.reviewId}>
              <ReviewCard review={r} onDecide={(action, cardBody) => decide(r.reviewId, action, cardBody)} {...(onOpenArtifact ? { onOpenArtifact } : {})} />
            </li>
          ))}
        </ul>
      </section>
    );
  })();

  return (
    // Panel shell mirrors the Conversations/Workflow tabs (shared header +
    // Escape-to-close). eslint's noninteractive-interactions heuristic is a
    // false positive on the Escape handler here (see WorkflowProgressPanel).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <aside
      className="review-inbox-panel u-w-full u-h-full u-bg-surface u-flex u-flex-col"
      tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      aria-labelledby={headingId}
    >
      <LeftRailPanelHeader
        titleId={headingId}
        title={t('tabReviews')}
        onClose={onClose}
        closeLabel={t('closeReviews')}
      />
      {/* ADR 0478 §1 — the tenant's approval SLA ladder (lazy — the inbox is
          on the entry path and the 200 kB budget is at the line). */}
      <Suspense fallback={null}>
        <SlaPolicySection />
      </Suspense>
      {body}
    </aside>
  );
}
