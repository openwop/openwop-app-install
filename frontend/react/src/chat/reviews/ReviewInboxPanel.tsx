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
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
const SlaPolicySection = lazy(() => import('./SlaPolicySection.js').then((m) => ({ default: m.SlaPolicySection })));
import { useTranslation } from 'react-i18next';

import { StateCard, Notice } from '../../ui/index.js';
import { InboxIcon, AlertIcon } from '../../ui/icons/index.js';
import { ReviewCard } from './ReviewCard.js';
import { LeftRailPanelHeader } from '../leftRail/LeftRailPanelHeader.js';
import { useReviewStatusStore, useReviewList } from './reviewStatusStore.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';

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
  const errorCause = useReviewStatusStore((s) => s.errorCause);
  const initialized = useReviewStatusStore((s) => s.initialized);
  const connect = useReviewStatusStore((s) => s.connect);
  const disconnect = useReviewStatusStore((s) => s.disconnect);
  const refresh = useReviewStatusStore((s) => s.refresh);
  const decideInStore = useReviewStatusStore((s) => s.decide);
  const [notice, setNotice] = useState<{ text: string; variant: 'success' | 'info'; seq: number } | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  // Ref-counted: the rail (ChatSidebar) also connects so the badge stays live
  // when this tab is closed; sharing the subscription here is a no-op beyond
  // the refcount.
  useEffect(() => {
    void connect();
    return () => disconnect();
  }, [connect, disconnect]);

  // Closing review B1 — a new arrival must not re-announce an old outcome.
  const prevCount = useRef(reviews.length);
  useEffect(() => {
    if (reviews.length > prevCount.current) setNotice(null);
    prevCount.current = reviews.length;
  }, [reviews.length]);

  const decide = async (reviewId: string, action: string, body: { value?: unknown; note?: string }): Promise<void> => {
    setNotice(null);
    // ADR 0778 (`APUX-11`) — the card under the pressed button is dropped
    // optimistically, which sent focus to <body>. Remember the neighbour now.
    const ids = useReviewStatusStore.getState().reviews.map((r) => r.reviewId);
    const at = ids.indexOf(reviewId);
    let focusId: string | undefined = ids[at + 1] ?? ids[at - 1];
    try {
      const outcome = await decideInStore(reviewId, action, body);
      // ADR 0778 (`APUX-2`) — a 409 means someone ELSE decided: say that, never
      // "Decision recorded" for a decision that was not. `seq` makes a repeat of
      // the same text announce again (`APUX-17`).
      setNotice((prev) => ({
        text: outcome === 'already-resolved' ? t('reviewResolvedElsewhere') : t('reviewDecisionRecorded'),
        variant: outcome === 'already-resolved' ? 'info' : 'success',
        seq: (prev?.seq ?? 0) + 1,
      }));
    } catch (err) {
      focusId = reviewId; // the card is restored: put focus back on it (I3)
      throw err;
    } finally {
      requestAnimationFrame(() => {
        // Scoped to THIS panel: a strip or board card of the same review earlier
        // in the DOM must not take the focus (I3).
        const panel = panelRef.current;
        const next = focusId && panel ? panel.querySelector<HTMLElement>(`[data-review-id="${CSS.escape(focusId)}"]`) : null;
        // Last card gone: the panel itself (tabIndex=-1) holds focus, not <body>.
        (next ?? panel)?.focus();
      });
    }
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
          body={loadErrorMessage(t, errorCause ?? error)}
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
      ref={panelRef}
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
      {/* Closing review B1 — OUTSIDE the list branch: deciding the LAST card
          empties the list (optimistically, before the outcome is known), so a
          notice inside it never mounted and the final decision went unheard. */}
      {notice ? <Notice key={notice.seq} variant={notice.variant} announce={notice.text}>{notice.text}</Notice> : null}
      {body}
    </aside>
  );
}
