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
import { useState, lazy, Suspense } from 'react';
import { StatusBadge } from '../../ui/index.js';
import { CheckIcon, XIcon, ClockIcon, ShieldIcon, BotIcon, UserIcon, AlertIcon, FileTextIcon } from '../../ui/icons/index.js';
import { formatDate } from '../../i18n/format.js';
import { useTranslation } from 'react-i18next';
import { ReviewRequestError, type ReviewRequest, type ReviewAction } from './reviewClient.js';
import { AssetPreviewModal } from './AssetPreviewModal.js';

// ADR 0473 — lazy: the composed section renders only for composed-workflow
// reviews, and the card sits on the entry path (200 kB budget at the line).
const ComposedWorkflowSection = lazy(() => import('./ComposedWorkflowSection.js'));
// ADR 0501 step 4 — lazy for the same reason as the composed section: the strip and
// inbox sit on the entry path and the chunk budget is tight.
const PlanProposalPreview = lazy(() => import('./PlanProposalPreview.js').then((m) => ({ default: m.PlanProposalPreview })));

interface Props {
  review: ReviewRequest;
  /** Decide the review. Resolves when the backend has dispatched the decision. */
  onDecide: (action: string, body: { value?: unknown; note?: string; expectedDefinitionHash?: string }) => Promise<void>;
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

export function ReviewCard({ review, onDecide, onOpenArtifact, compact }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const resolved = review.actions.length === 0;
  const hasAssets = !!review.assets && review.assets.length > 0;
  // grade-ux U2 — without the live view the approve-what-you-see pin cannot be
  // sent; never offer a silent unpinned Approve. The composed section explains
  // and points at the builder (whose save-then-approve self-heals the view).
  const composedDegraded = !!review.composedWorkflow && !resolved && !review.composedWorkflow.expired && !review.composedWorkflow.liveDefinitionHash;
  const offeredActions = composedDegraded ? review.actions.filter((a) => a.action !== 'approve') : review.actions;

  async function decide(action: ReviewAction): Promise<void> {
    setBusy(action.action);
    setError(null);
    try {
      // `requiresValue` actions need a typed resume value the host validates; the
      // generic inbox card has no schema form yet, so it sends an empty object
      // (the gate's resume schema renders fully in the dedicated panel — v1).
      // ADR 0473 — approve-what-you-see: a composed-workflow approve echoes the
      // hash of the definition THIS card displayed; the backend refuses when
      // the live definition no longer matches (409 proposal_stale → error line).
      const liveHash = review.composedWorkflow?.liveDefinitionHash;
      await onDecide(action.action, {
        ...(action.requiresValue ? { value: {} } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(action.action === 'approve' && liveHash ? { expectedDefinitionHash: liveHash } : {}),
      });
    } catch (err) {
      // ADR 0473 — the two "still pending" 409s get localized, actionable copy
      // (the host card refreshed the live view; the raw envelope text is
      // English-only and code-prefixed).
      const reason = err instanceof ReviewRequestError ? err.reason : undefined;
      if (reason === 'proposal_stale') setError(t('composedStaleError'));
      else if (reason === 'proposal_expired') setError(t('composedExpiredNotice'));
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article
      className={`surface-card review-card${compact ? ' review-card--compact' : ''}${resolved ? '' : ` review-card--pending review-card--${review.source}`}`}
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

      {error ? <p className="review-card__error" role="alert">{error}</p> : null}

      {!resolved ? (
        <>
          {!compact || review.composedWorkflow ? (
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
  );
}
