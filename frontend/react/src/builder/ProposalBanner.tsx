/**
 * ProposalBanner (ADR 0473 Phase 3) — shown on /builder/:id when a PENDING
 * composed-workflow proposal references the loaded draft. The builder IS the
 * payload preview (the canvas), so this is chrome, not a second card: proposer
 * attribution, the agent's one-line description, decide verbs, and a deep link
 * back to the proposing conversation.
 *
 * Approve-what-you-see, builder edition: the canvas may hold UNSAVED edits, so
 * Approve & run first persists the canvas through the builder's own
 * registration path (the caller-supplied `persistDraft` — the same serialize +
 * register the Run button uses), re-reads the review for the hash of exactly
 * what was just saved, and decides with that hash. The user approves the
 * canvas they are looking at, never a stale registered copy.
 *
 * Decides ride the SAME reviews routes as every surface (ADR 0068 — no second
 * decision path); `chat/reviews/reviewClient` is a leaf fetch client already
 * imported by kanban/interrupts/features (no chat-component edge, no cycle).
 */

import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BotIcon, CheckIcon, XIcon, MessageSquareIcon } from '../ui/icons/index.js';
import {
  listReviews,
  getReview,
  decideReview,
  ReviewRequestError,
  type ReviewRequest,
} from '../chat/reviews/reviewClient.js';
import { subscribeReviewSignal } from '../notifications/signalBus.js';
import { announce } from '../ui/announce.js';
import { useBuilderStore } from './store/builderStore.js';

export function ProposalBanner({ workflowId, persistDraft }: {
  workflowId: string;
  /** Persist the CURRENT canvas through the builder's registration path (the
   *  Run button's serialize + register). Throws on serialize/save failure. */
  persistDraft: () => Promise<void>;
}): JSX.Element | null {
  const { t } = useTranslation('builder');
  const [review, setReview] = useState<ReviewRequest | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ status: 'approved' | 'rejected'; runId?: string } | null>(null);

  const load = useCallback(() => {
    // Client-side narrow over the (authz-scoped, cap-bounded) pending list —
    // the projection has no by-workflow filter and doesn't need one for this.
    void listReviews('pending')
      .then((rows) => setReview(rows.find((r) => r.kind === 'composed-workflow' && r.workflowId === workflowId) ?? null))
      .catch(() => { /* fail-soft: the chat strip + inbox remain the decide surfaces */ });
  }, [workflowId]);
  // Review F3 — the prop can change while the old fetch is in flight: reset
  // synchronously so a stale proposal is never decidable against a new canvas.
  useEffect(() => { setReview(null); setOutcome(null); setError(null); load(); }, [workflowId, load]);
  // Review F1 — a decision made on ANY surface (chat card, inbox) refreshes
  // this banner via the same `review.updated` signal the store consumes.
  useEffect(() => subscribeReviewSignal((frame) => {
    const reviewId = (frame.metadata as { reviewId?: unknown } | undefined)?.reviewId;
    if (typeof reviewId === 'string' && reviewId === review?.reviewId) load();
  }), [review?.reviewId, load]);

  if (!review && !outcome && !error) return null;

  async function decide(action: 'approve' | 'reject'): Promise<void> {
    if (!review) return;
    // Review F3 — the canvas the user sees must belong to THIS proposal; a
    // mid-flight workflow switch aborts rather than approving the old draft
    // (grade-ux U5: refresh the banner so the no-op is visible, not silent).
    if (useBuilderStore.getState().workflowId !== review.workflowId) { load(); return; }
    setBusy(action);
    setError(null);
    try {
      let expectedDefinitionHash: string | undefined;
      if (action === 'approve') {
        // Persist the canvas FIRST, then pin the hash of exactly what landed.
        await persistDraft();
        const fresh = await getReview(review.reviewId);
        expectedDefinitionHash = fresh.composedWorkflow?.liveDefinitionHash;
      }
      const res = await decideReview(review.reviewId, action, {
        ...(expectedDefinitionHash ? { expectedDefinitionHash } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setOutcome({ status: action === 'approve' ? 'approved' : 'rejected', ...(res.runId ? { runId: res.runId } : {}) });
      setReview(null);
      // PROPU-3 — speak the outcome through the always-mounted GlobalLiveRegion.
      // The rendered outcome is a conditionally-mounted node that arrives already
      // populated, so a `role=status` on it announces nothing to most SRs; the
      // imperative announce is the house pattern (WFMU-1 / MTCU-201). Polite: it
      // is a successful result of the user's own click, not an interruption.
      announce(action === 'approve' ? t('proposalApproved') : t('proposalRejected'), { assertive: false });
    } catch (err) {
      const reason = err instanceof ReviewRequestError ? err.reason : undefined;
      const alreadyDecided = err instanceof ReviewRequestError && err.httpStatus === 409 && reason === undefined;
      const msg = reason === 'proposal_stale' ? t('proposalStaleError')
        : reason === 'proposal_expired' ? t('proposalExpiredError')
        : alreadyDecided ? t('proposalAlreadyDecided')
        : err instanceof Error ? err.message : String(err);
      setError(msg);
      announce(msg, { assertive: true }); // PROPU-3 — a decide FAILURE must interrupt
      load(); // re-narrow: a concurrent decision elsewhere clears the verbs (the error line stays)
    } finally {
      setBusy(null);
    }
  }

  if (outcome) {
    // PROPU-3 — no `role="status"`: this node mounts already populated, so a live
    // role on it announces nothing. The outcome is spoken via `announce()` in
    // `decide()`; here it is plain, navigable text (read on focus/browse).
    return (
      <div className={`alert ${outcome.status === 'approved' ? 'success' : 'warning'} builder-toolbar-error`}>
        {outcome.status === 'approved' ? <CheckIcon size={14} /> : <XIcon size={14} />}
        {outcome.status === 'approved' ? t('proposalApproved') : t('proposalRejected')}
        {outcome.runId ? (
          <Link to={`/runs/${outcome.runId}`} className="btn-link">{t('proposalViewRun')}</Link>
        ) : null}
      </div>
    );
  }

  // Review F1 — a concurrent decision elsewhere re-narrows `review` to null;
  // the error line must survive that (never a flash-and-vanish banner).
  if (!review) {
    // PROPU-3 — spoken via `announce(assertive)` in `decide()`; no mount-time
    // `role="alert"` (a conditionally-mounted alert arriving with its text does
    // not reliably announce).
    return error ? <div className="alert warning builder-toolbar-error">{error}</div> : null;
  }

  return (
    <section className="surface-card builder-proposal-banner" aria-label={t('proposalBannerAria')}>
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        <span className="chip chip--accent"><BotIcon size={12} /> {t('proposalPendingChip')}</span>
        <span className="u-fs-13">{t('proposalPendingTitle')}</span>
        {review.conversationId ? (
          // Known limitation (review F4): an EMBED-originated proposal carries
          // an ephemeral session id the main chat can't resolve — the link then
          // lands on the default chat (ChatSidebar's deep-link waits, benign).
          // Main-chat proposals resolve normally; not worth a sessions fetch here.
          <Link to={`/?conversation=${encodeURIComponent(review.conversationId)}`} className="btn-link u-fs-12">
            <MessageSquareIcon size={13} /> {t('proposalOpenConversation')}
          </Link>
        ) : null}
      </div>
      {review.summary ? (
        <p className="muted u-fs-12 u-m-0">
          <span className="muted u-fs-10 u-block">{t('proposalAgentNote')}</span>
          {review.summary}
        </p>
      ) : null}
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        <input
          type="text"
          className="builder-proposal-banner__note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('proposalNotePlaceholder')}
          disabled={busy !== null}
          aria-label={t('proposalNotePlaceholder')}
        />
        <Button
          variant="accent-solid" size="sm" className="u-flex u-items-center u-gap-2"
          onClick={() => void decide('approve')}
          disabled={busy !== null}
          aria-busy={busy === 'approve'}
        >
          <CheckIcon size={14} /> {busy === 'approve' ? `${t('proposalApproveRun')}…` : t('proposalApproveRun')}
        </Button>
        <Button
          variant="secondary" size="sm" className="review-card__reject u-flex u-items-center u-gap-2"
          onClick={() => void decide('reject')}
          disabled={busy !== null}
          aria-busy={busy === 'reject'}
        >
          <XIcon size={14} /> {busy === 'reject' ? `${t('proposalReject')}…` : t('proposalReject')}
        </Button>
      </div>
      {/* PROPU-3 — spoken via announce() in decide(); no mount-time role=alert. */}
      {error ? <p className="builder-proposal-banner__error u-fs-12 u-m-0">{error}</p> : null}
    </section>
  );
}
