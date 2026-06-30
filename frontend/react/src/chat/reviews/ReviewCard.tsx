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

import { useState } from 'react';
import { StatusBadge } from '../../ui/index.js';
import { CheckIcon, XIcon, ClockIcon, ShieldIcon, BotIcon, UserIcon, AlertIcon, FileTextIcon } from '../../ui/icons/index.js';
import { formatDate } from '../../i18n/format.js';
import { useTranslation } from 'react-i18next';
import type { ReviewRequest, ReviewAction } from './reviewClient.js';
import { AssetPreviewModal } from './AssetPreviewModal.js';

interface Props {
  review: ReviewRequest;
  /** Decide the review. Resolves when the backend has dispatched the decision. */
  onDecide: (action: string, body: { value?: unknown; note?: string }) => Promise<void>;
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

  async function decide(action: ReviewAction): Promise<void> {
    setBusy(action.action);
    setError(null);
    try {
      // `requiresValue` actions need a typed resume value the host validates; the
      // generic inbox card has no schema form yet, so it sends an empty object
      // (the gate's resume schema renders fully in the dedicated panel — v1).
      await onDecide(action.action, {
        ...(action.requiresValue ? { value: {} } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
        <span className="review-card__kind">{review.kind}</span>
        {review.workflowName ? (
          <span className="review-card__from muted u-fs-11">{t('reviewFromWorkflow', { workflow: review.workflowName })}</span>
        ) : null}
        {review.risk ? (
          <span className={`chip ${RISK_CHIP[review.risk.level] ?? 'chip--muted'}`} title={review.risk.reasons.join('; ')}>
            <AlertIcon size={12} /> {t('reviewRiskLabel', { level: review.risk.level })}
          </span>
        ) : null}
        <span className="review-card__spacer" />
        {resolved ? <StatusBadge status={review.status} /> : null}
      </header>

      {review.summary ? <p className="review-card__summary">{review.summary}</p> : null}

      {hasAssets || (review.artifactId && onOpenArtifact) ? (
        <div className="review-card__evidence">
          {hasAssets ? (
            <button
              type="button"
              className="secondary btn-sm u-flex u-items-center u-gap-2"
              onClick={() => setPreviewOpen(true)}
            >
              <FileTextIcon size={14} /> {t('reviewPreview')}
            </button>
          ) : null}
          {review.artifactId && onOpenArtifact ? (() => {
            const artifactId = review.artifactId;
            const revisionId = review.revisionId;
            return (
              <button
                type="button"
                className="secondary btn-sm u-flex u-items-center u-gap-2"
                onClick={() => onOpenArtifact(artifactId, revisionId)}
              >
                <FileTextIcon size={14} /> {t('reviewOpenArtifact')}
              </button>
            );
          })() : null}
        </div>
      ) : null}

      {review.policy ? (
        <div className="review-card__quorum" aria-label={t('reviewQuorumAria', { approvals: review.policy.approvals, required: review.policy.requiredApprovals })}>
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
          {!compact ? (
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
            {review.actions.map((a) => {
              const { cls, glyph } = actionStyle(a);
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
                  {a.label ?? titleCase(a.action)}
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
