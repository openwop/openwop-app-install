/**
 * ReviewCard (ADR 0068) — ONE normalized card for a human review, whether it is
 * a runtime interrupt or a pending approval. Renders the source badge, risk,
 * provenance, due time, and the source-derived action buttons. The same card is
 * reused in chat, the side panel, and the inbox.
 *
 * Actions come from the authoritative backend record (`review.actions`), never
 * guessed client-side; an empty actions list ⇒ the review is resolved and the
 * card renders read-only. Disabled while a decision is in flight (stale-safe: the
 * backend 409s a second decision, but disabling avoids the round-trip).
 */

import { Button } from '../../ui/Button.js';
import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { EmailSendReviewContext } from '../../notifications/EmailSendReviewContext.js';
import { Notice, StatusBadge } from '../../ui/index.js';
import { confirm } from '../../ui/confirm.js';
import { decideErrorMessage } from '../../interrupts/decideErrorMessage.js';
import { useReviewStatusStore } from './reviewStatusStore.js';
import { CheckIcon, XIcon, ClockIcon, ShieldIcon, BotIcon, UserIcon, AlertIcon, FileTextIcon } from '../../ui/icons/index.js';
import { formatDate } from '../../i18n/format.js';
import { useTranslation } from 'react-i18next';
import { ReviewRequestError, type ReviewRequest, type ReviewAction } from './reviewClient.js';
import { AssetPreviewModal } from './AssetPreviewModal.js';
import { ReviewHandoff } from './ReviewHandoff.js';
import { CardHost } from '../registry/CardHost.js';
import { registerDefaultCards } from '../registry/defaultCards.js';
import { useCanOpenRunDetail } from '../runDetailAccess.js';

// ADR 0473 — lazy: the composed section renders only for composed-workflow
// reviews, and the card sits on the entry path (200 kB budget at the line).
const ComposedWorkflowSection = lazy(() => import('./ComposedWorkflowSection.js'));
// ADR 0501 step 4 — lazy for the same reason as the composed section: the strip and
// inbox sit on the entry path and the chunk budget is tight.
const PlanProposalPreview = lazy(() => import('./PlanProposalPreview.js').then((m) => ({ default: m.PlanProposalPreview })));
// ADR 0862 D3 — lazy for the same reason: only assistant-action reviews render it.
const AssistantActionFields = lazy(() => import('../../assistantAction/AssistantActionFields.js'));

// ADR 0778 D10 correction — the typed-answer forms are the chat's own interrupt
// cards. Only ChatTab registered them, so an embedded panel or an admin inbox
// rendering this card would get "no card registered". Idempotent.
registerDefaultCards();

/** Interrupt kinds whose answer form renders on the card. Everything else
 *  (credential, external-event, an approval gate without listed verbs, …) keeps
 *  the run link for an admin and says so for a member. */
const INLINE_ANSWER_KINDS = new Set(['clarification', 'refinement', 'cancellation']);

interface Props {
  review: ReviewRequest;
  /** Decide the review. Resolves when the backend has dispatched the decision. */
  onDecide: (action: string, body: { value?: unknown; note?: string; expectedDefinitionHash?: string; expectedContentHash?: string }) => Promise<void>;
  /** Open the artifact workbench for the pinned (artifactId, revisionId), when bound. */
  onOpenArtifact?: (artifactId: string, revisionId?: string) => void;
  /** Compact mode for the inline-in-chat placement (hides the note field). */
  compact?: boolean;
}

const RISK_CHIP: Record<string, string> = {
  low: 'chip--muted',
  medium: 'chip--warning',
  high: 'chip--danger',
  critical: 'chip--danger',
};

/* grade-ux U3 — risk levels are enums; interpolating them raw broke ×4 locale
   parity ("riesgo medium"). */
const RISK_LEVEL_KEY: Record<string, string> = {
  low: 'reviewRiskLow',
  medium: 'reviewRiskMedium',
  high: 'reviewRiskHigh',
  critical: 'reviewRiskCritical',
};

function RequesterIcon({ kind }: { kind: 'user' | 'agent' | 'system' }): JSX.Element {
  if (kind === 'agent') return <BotIcon size={14} />;
  if (kind === 'user') return <UserIcon size={14} />;
  return <ShieldIcon size={14} />;
}

/** Friendly requester: prefer the label; else strip the `kind:` prefix and
 *  shorten a UUID to its first segment (the full value stays in the title attr). */
function shortRequester(raw: string): string {
  const v = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
  const seg = v.split('-')[0];
  return seg && seg.length < v.length ? `${seg}…` : v;
}

/** Title-case a bare backend verb when the record carries no display label. */
function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Map an action verb to a button class + whether it shows the approve/deny glyph. */
function actionStyle(action: ReviewAction): { cls: string; glyph: 'check' | 'x' | null } {
  if (action.action === 'approve' || action.action === 'resolve') return { cls: 'btn-accent-solid btn-sm', glyph: 'check' };
  if (action.action === 'reject') return { cls: 'secondary btn-sm review-card__reject', glyph: 'x' };
  return { cls: 'secondary btn-sm', glyph: null };
}

/** The card also renders in router-less hosts (tests, isolated embeds), where a
 *  `<Link>` throws; a plain anchor is the honest fallback there. */
function RunLink({ runId, label }: { runId: string; label: string }): JSX.Element {
  const inRouter = useInRouterContext();
  const to = `/runs/${encodeURIComponent(runId)}`;
  // Closing review I6 — for a clarification this IS the card's primary action,
  // so it takes the action-bar button look and target size, not a footnote.
  const cls = 'secondary btn-sm u-flex u-items-center u-gap-2';
  return inRouter ? <Link to={to} className={cls}>{label}</Link> : <a href={to} className={cls}>{label}</a>;
}

export function ReviewCard({ review, onDecide, onOpenArtifact, compact }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // ADR 0778 (`APUX-10`) — `busy` needs a re-render to disable the buttons, so
  // a same-tick double click passed it twice. A synchronous ref closes that
  // window (the ApprovalCard CHAT-5 shape).
  const inFlight = useRef(false);
  // ADR 0778 (`APUX-1`) — a decision that failed on a surface that decides
  // through the shared store: the optimistic drop unmounted the card that made
  // the call, so its local error was lost. The store keeps it per review.
  const storeFailure = useReviewStatusStore((s) => s.failureById[review.reviewId]);
  const consumeFailure = useReviewStatusStore((s) => s.consumeFailure);
  const resolved = review.actions.length === 0;
  // ADR 0778 D8 (`APUX-3`) — the server says whether THIS caller may decide.
  // `false`: no buttons (they would 403); absent: unchanged behaviour.
  const mayDecide = review.canDecide !== false;
  const hasAssets = !!review.assets && review.assets.length > 0;
  // grade-ux U2 — without the live view the approve-what-you-see pin cannot be
  // sent; never offer a silent unpinned Approve. The composed section explains
  // and points at the builder (whose save-then-approve self-heals the view).
  const composedDegraded = !!review.composedWorkflow && !resolved && !review.composedWorkflow.expired && !review.composedWorkflow.liveDefinitionHash;
  const offeredActions = composedDegraded ? review.actions.filter((a) => a.action !== 'approve') : review.actions;
  // ADR 0778 D10 correction — a typed answer is collected on the card, by the
  // chat's own form for the interrupt kind, and posted through `onDecide` with
  // `value`. The run page is admin-tier, so linking there stranded members.
  const typedAction = offeredActions.find((a) => a.requiresValue);
  const answerInline = !!typedAction && review.source === 'interrupt' && !!review.answerForm && INLINE_ANSWER_KINDS.has(review.kind);
  const canOpenRun = useCanOpenRunDetail();

  /** The localized line for a failed decision: the two ADR 0473 "still
   *  pending" reasons, else the shared classification (409 → resolved
   *  elsewhere, 403 → `common:error_forbidden`, …). Never the raw server text. */
  function failureMessage(err: unknown): string {
    const reason = err instanceof ReviewRequestError ? err.reason : undefined;
    if (reason === 'proposal_stale') return t('composedStaleError');
    if (reason === 'proposal_expired') return t('composedExpiredNotice');
    // ADR 0862 — the namespace is loaded by the AssistantActionFields this card renders.
    if (reason === 'action_changed') return t('assistantAction:actionChanged');
    if (reason === 'content_hash_required') return t('assistantAction:cardOutOfDate');
    return decideErrorMessage(t, err);
  }

  async function decide(action: ReviewAction, value?: unknown): Promise<void> {
    if (inFlight.current) return;
    // ADR 0778 (`APUX-9`) — REJECT is irreversible (a rejected gate fails its
    // node; a rejected proposal is gone), and the inline ApprovalCard already
    // confirms it (ISU-12). This card did not.
    if (action.action === 'reject' && !(await confirm({
      title: review.source === 'interrupt' ? t('interrupts:rejectConfirmTitle') : t('reviewRejectConfirmTitle'),
      body: review.source === 'interrupt' ? t('interrupts:rejectConfirmBody') : t('reviewRejectConfirmBody'),
      danger: true,
      confirmLabel: t('interrupts:actionReject'),
    }))) return;
    inFlight.current = true;
    setBusy(action.action);
    setError(null);
    try {
      // ADR 0473 — approve-what-you-see: a composed-workflow approve echoes the
      // hash of the definition THIS card displayed; the backend refuses when
      // the live definition no longer matches (409 proposal_stale → error line).
      const liveHash = review.composedWorkflow?.liveDefinitionHash;
      const emailReviewHash = review.kind === 'email-campaign-send' ? review.emailSend?.reviewHash : undefined;
      // `requiresValue` actions arrive here only with the value the inline
      // answer form produced — never an invented `{}` (`APUX-4`).
      await onDecide(action.action, {
        ...(value !== undefined ? { value } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(action.action === 'approve' && liveHash ? { expectedDefinitionHash: liveHash } : {}),
        // ADR 0862 D1 — an assistant action approve echoes the hash of the fields shown.
        ...(action.action === 'approve' && review.assistantAction ? { expectedContentHash: review.assistantAction.contentHash } : {}),
        ...(action.action === 'approve' && emailReviewHash ? { expectedContentHash: emailReviewHash } : {}),
      });
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  // Take the kept failure into THIS card's state, once (closing review I1):
  // announced when it arrives, never again on a remount or a second surface.
  useEffect(() => {
    if (storeFailure === undefined) return;
    setError(failureMessage(storeFailure));
    consumeFailure(review.reviewId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- failureMessage is a pure render helper
  }, [storeFailure, consumeFailure, review.reviewId]);
  const shownError = error;

  return (
    <Suspense fallback={<p role="status">{t('common:loading')}</p>}>
    <article
      className={`surface-card review-card${compact ? ' review-card--compact' : ''}${resolved ? '' : ` review-card--pending review-card--${review.source}`}`}
      data-review-id={review.reviewId}
      tabIndex={-1}
      aria-label={t('reviewCardLabel', { summary: review.summary ?? review.kind })}
    >
      <header className="review-card__head">
        <span className={`chip review-card__source review-card__source--${review.source}`}>
          {review.source === 'interrupt' ? t('reviewSourceInflight') : t('reviewSourceProposal')}
        </span>
        <span className="review-card__kind">{review.composedWorkflow ? t('composedKindLabel') : review.kind}</span>
        {review.workflowName ? (
          <span className="review-card__from muted u-fs-11">{t('reviewFromWorkflow', { workflow: review.workflowName })}</span>
        ) : null}
        {review.risk ? (
          <span className={`chip ${RISK_CHIP[review.risk.level] ?? 'chip--muted'}`} title={review.risk.reasons.join('; ')}>
            <AlertIcon size={12} /> {t('reviewRiskLabel', { level: t(RISK_LEVEL_KEY[review.risk.level] ?? 'reviewRiskMedium') })}
          </span>
        ) : null}
        <span className="review-card__spacer" />
        {resolved ? <StatusBadge status={review.status} /> : null}
      </header>

      {review.summary ? (
        <p className="review-card__summary">
          {review.composedWorkflow ? (
            // Review F7 — the summary is AGENT-authored persuasion surface on
            // an approval card; label it as the agent's words, never the app's.
            <span className="muted u-fs-10 u-block">{t('composedAgentNote')}</span>
          ) : null}
          {review.summary}
        </p>
      ) : null}

      {review.reasoning ? (
        <details className="review-card__reasoning u-fs-12">
          <summary className="muted u-fs-11">{t('reviewReasoningLabel')}</summary>
          {/* ADR 0478 §3 — the agent's words, attributed as a CLAIM (the F7
              rule): never rendered as the app's own assessment. */}
          <p className="u-m-0">{review.reasoning}</p>
        </details>
      ) : null}

      {review.composedWorkflow ? (
        <Suspense fallback={null}>
          <ComposedWorkflowSection review={review} />
        </Suspense>
      ) : null}

      {review.assistantAction ? <AssistantActionFields payload={review.assistantAction.payload} /> : null}
      {review.kind === 'email-campaign-send' ? <EmailSendReviewContext a={review} /> : null}

      {/* ADR 0501 step 4 — only while the decision is still open: once resolved, a
          "what this would do" panel describes a choice already made. */}
      {review.planProposal && !resolved ? (
        <Suspense fallback={null}>
          <PlanProposalPreview
            enrollmentId={review.planProposal.enrollmentId}
            proposalId={review.planProposal.proposalId}
          />
        </Suspense>
      ) : null}

      {resolved && review.decisionNote ? (
        <blockquote className="review-card__decision-note muted u-fs-12" aria-label={t('reviewNoteLabel')}>
          {review.decisionNote}
        </blockquote>
      ) : null}

      {hasAssets || (review.artifactId && onOpenArtifact) ? (
        <div className="review-card__evidence">
          {hasAssets ? (
            <Button
              variant="secondary" size="sm" className="u-flex u-items-center u-gap-2"
              onClick={() => setPreviewOpen(true)}
            >
              <FileTextIcon size={14} /> {t('reviewPreview')}
            </Button>
          ) : null}
          {review.artifactId && onOpenArtifact ? (() => {
            const artifactId = review.artifactId;
            const revisionId = review.revisionId;
            return (
              <Button
                variant="secondary" size="sm" className="u-flex u-items-center u-gap-2"
                onClick={() => onOpenArtifact(artifactId, revisionId)}
              >
                <FileTextIcon size={14} /> {t('reviewOpenArtifact')}
              </Button>
            );
          })() : null}
        </div>
      ) : null}

      {/* The quorum block below carries NO aria-label. Its chips already state
          the quorum in TEXT ("N approved", "M rejected"), so a container label
          duplicated them — and on a role-less div it was PROHIBITED and ignored
          outright anyway (axe aria-prohibited-attr). Removing it is the honest
          fix; adding a role to keep it would have made AT announce the summary
          INSTEAD of the chips it duplicates. */}
      {review.policy ? (
        <div className="review-card__quorum">
          <span className="chip chip--accent">{t('reviewQuorumApproved', { approvals: review.policy.approvals, required: review.policy.requiredApprovals })}</span>
          {review.policy.rejections > 0 ? <span className="chip chip--danger">{t('reviewQuorumRejected', { count: review.policy.rejections })}</span> : null}
          <span className="review-card__quorum-meter" aria-hidden="true">
            <span className="review-card__quorum-fill" style={{ inlineSize: `${Math.min(100, Math.round((review.policy.approvals / Math.max(1, review.policy.requiredApprovals)) * 100))}%` }} />
          </span>
        </div>
      ) : null}

      <dl className="review-card__meta">
        {review.requestedBy ? (
          <div className="review-card__meta-row">
            <dt><RequesterIcon kind={review.requestedBy.kind} /> {t('reviewRequestedBy')}</dt>
            <dd title={review.requestedBy.id}>{review.requestedBy.label ?? shortRequester(review.requestedBy.id)}</dd>
          </div>
        ) : null}
        <div className="review-card__meta-row">
          <dt><ClockIcon size={14} /> {t('reviewRequested')}</dt>
          <dd>{formatDate(review.requestedAt)}</dd>
        </div>
        {review.dueAt ? (
          <div className="review-card__meta-row">
            <dt><ClockIcon size={14} /> {t('reviewDue')}</dt>
            <dd className="review-card__due">{formatDate(review.dueAt)}</dd>
          </div>
        ) : null}
      </dl>

      {review.provenanceRefs.length > 0 ? (
        <details className="review-card__trace">
          <summary>{t('artifactTabProvenance')} <span className="muted">({review.provenanceRefs.length})</span></summary>
          <ul className="review-card__provenance" aria-label={t('artifactTabProvenance')}>
            {review.provenanceRefs.map((p) => {
              const ref = p.label ?? `${p.kind}:${p.ref}`;
              return <li key={`${p.kind}:${p.ref}`} className="chip chip--muted" title={ref}>{ref}</li>;
            })}
          </ul>
        </details>
      ) : null}

      {/* ADR 0778 (`APUX-13`) — announced through the shared live region; a
          region mounted already populated may never be read out. */}
      {shownError ? <Notice variant="error" announce={shownError}>{shownError}</Notice> : null}

      {!resolved && !mayDecide ? (
        // Closing review I5 — "this step" is the interrupt wording; a proposal
        // or request is not a step. ADR 0862 — a withheld assistant card is a
        // workspace-access refusal, not exclusion from a named approver list.
        <Notice variant="info">{review.source === 'interrupt' ? t('interrupts:noRespondPermission') : review.kind === 'assistant-action' ? t('common:error_forbidden') : t('reviewNotAnApprover')}</Notice>
      ) : null}

      {!resolved && mayDecide ? (
        <>
          {answerInline && typedAction ? (
            <div className="u-mb-2">
              <CardHost
                cardType={`interrupt.${review.kind}`}
                payload={{ data: review.answerForm }}
                context={{
                  runId: review.runId ?? '',
                  tenantId: review.tenantId,
                  ...(review.nodeId ? { nodeId: review.nodeId } : {}),
                  ...(review.workflowName ? { workflowName: review.workflowName } : {}),
                }}
                isLoading={busy !== null}
                autoFocus={false}
                onAction={(_actionId, value) => decide(typedAction, value)}
              />
            </div>
          ) : null}
          {/* A typed answer IS the record; a second free-text field beside it
              reads as two answers. The note stays for verb decisions. */}
          {!answerInline && (!compact || review.composedWorkflow) ? (
            // ADR 0473 (review F4) — a composed-workflow proposal keeps the
            // note field even in the compact in-chat strip: the rejection note
            // is the OQ1 feedback record, and the strip is the primary decide
            // surface for the Workflow Architect's proposals.
            <label className="review-card__note">
              <span className="visually-hidden">{t('reviewNoteLabel')}</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('reviewNotePlaceholder')}
                rows={2}
                disabled={busy !== null}
              />
            </label>
          ) : null}
          <div className="action-bar review-card__actions">
            {offeredActions.map((a) => {
              // ADR 0778 (`APUX-4`) — a typed answer belongs in the run's own
              // interrupt form (RenderInterrupt), not an invented `{}`.
              if (a.requiresValue) {
                // Answered by the inline form above.
                if (answerInline) return null;
                // One link however many typed actions the gate offers.
                if (offeredActions.findIndex((x) => x.requiresValue) !== offeredActions.indexOf(a)) return null;
                if (!review.runId) return null;
                // A kind the card cannot answer: the run page for an admin; a
                // member cannot open it (rule 17), so say who can answer.
                return canOpenRun
                  ? <RunLink key={a.action} runId={review.runId} label={t('reviewRespondOnRun')} />
                  : <span key={a.action} className="muted u-fs-12">{t('reviewAnswerNeedsAdmin')}</span>;
              }
              const { cls, glyph } = actionStyle(a);
              // ADR 0473 — localize the composed-kind verbs (the server label
              // is an English fallback for API consumers; known verbs render
              // through i18n so ×4 locale parity holds on this card).
              const label = review.composedWorkflow
                ? (a.action === 'approve' ? t('composedApproveRun') : a.action === 'reject' ? t('composedReject') : a.label ?? titleCase(a.action))
                : a.label ?? titleCase(a.action);
              return (
                <button
                  key={a.action}
                  type="button"
                  className={`${cls} u-flex u-items-center u-gap-2`}
                  onClick={() => void decide(a)}
                  disabled={busy !== null}
                  aria-busy={busy === a.action}
                >
                  {glyph === 'check' ? <CheckIcon size={14} /> : glyph === 'x' ? <XIcon size={14} /> : null}
                  {busy === a.action ? `${label}…` : label}
                </button>
              );
            })}
          </div>
          {/* ADR 0854 D1 — ask someone else to decide (never grants authority). */}
          {review.status === 'pending' ? <ReviewHandoff reviewId={review.reviewId} canHandOff={mayDecide && !resolved} /> : null}
        </>
      ) : null}

      {hasAssets ? (
        <AssetPreviewModal
          open={previewOpen}
          assets={review.assets ?? []}
          title={review.summary ?? review.kind}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </article>
    </Suspense>
  );
}
