/**
 * ADR 0473 — the composed-workflow payload section of the shared ReviewCard:
 * the LIVE step list with pack-role risk badges, edited/expired notices,
 * frozen run inputs, and the builder deep-link. Data-driven off
 * `review.composedWorkflow` — one card model (ADR 0068), no second card.
 *
 * Lazy-loaded by ReviewCard (composed reviews only), keeping the section out
 * of the entry chunk — the strip/inbox live on the entry path and the 200 kB
 * budget was already at the line.
 */

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertIcon, ClockIcon, WorkflowIcon } from '../../ui/icons/index.js';
import { formatCurrency, formatDate } from '../../i18n/format.js';
import type { ReviewRequest } from './reviewClient.js';

/** Per-step role badge: chip class + localized label key. Roles come from the
 *  pack manifests via the projection; `unclassified` (no declared role) is
 *  policy-equivalent to a side effect, so it warns too. */
const ROLE_BADGE: Record<string, { cls: string; key: string }> = {
  pure: { cls: 'chip--muted', key: 'composedRolePure' },
  read: { cls: 'chip--muted', key: 'composedRoleRead' },
  gate: { cls: 'chip--accent', key: 'composedRoleGate' },
  action: { cls: 'chip--warning', key: 'composedRoleAction' },
  'side-effect': { cls: 'chip--warning', key: 'composedRoleSideEffect' },
  'streaming-output': { cls: 'chip--warning', key: 'composedRoleStreaming' },
  unclassified: { cls: 'chip--warning', key: 'composedRoleUnclassified' },
};

export function ComposedWorkflowSection({ review }: { review: ReviewRequest }): JSX.Element | null {
  const { t } = useTranslation('chat');
  const cw = review.composedWorkflow;
  if (!cw) return null;
  const steps = cw.steps ?? [];
  const moreSteps = Math.max(0, cw.nodeCount - steps.length);
  const inputCount = cw.runInputs ? Object.keys(cw.runInputs).length : 0;
  const hasInputs = inputCount > 0;
  // grade-ux U2 — the live view is instance-dependent: when it's absent the
  // card can neither show the steps nor pin approve-what-you-see, so it must
  // SAY so and route the decision through the builder (whose save-then-approve
  // regenerates the live view). ReviewCard suppresses the Approve verb in this
  // state; this notice explains why.
  const degraded = review.actions.length > 0 && !cw.expired && !cw.liveDefinitionHash;
  return (
    <section className="review-card__composed u-flex u-flex-col u-gap-2" aria-label={t('composedSectionAria')}>
      {cw.editedSinceProposed && !cw.expired ? (
        <p className="chip chip--warning u-fs-11 u-m-0" role="status">
          <AlertIcon size={12} /> {t('composedEdited')}
        </p>
      ) : null}
      {cw.expired ? (
        <p className="chip chip--danger u-fs-11 u-m-0" role="status">
          <ClockIcon size={12} /> {t('composedExpiredNotice')}
        </p>
      ) : null}
      {degraded ? (
        <p className="chip chip--warning u-fs-11 u-m-0" role="status">
          <AlertIcon size={12} /> {t('composedPreviewUnavailable')}
        </p>
      ) : null}
      <p className="muted u-fs-11 u-m-0">{t('composedEvidence', { nodes: cw.nodeCount, edges: cw.edgeCount })}</p>
      {typeof cw.estimatedFloorUsd === 'number' ? (
        <p className="muted u-fs-11 u-m-0" title={t('composedEstimateTitle')}>
          {t('composedEstimate', { usd: formatCurrency(cw.estimatedFloorUsd, 'USD', { maximumFractionDigits: 4 }), count: cw.estimatedAiNodes ?? 0 })}
        </p>
      ) : null}
      {steps.length > 0 ? (
        <ol className="review-card__steps u-flex u-flex-col u-gap-1">
          {steps.map((s) => {
            const badge = ROLE_BADGE[s.role] ?? { cls: 'chip--warning', key: 'composedRoleUnclassified' };
            return (
              <li key={s.nodeId} className="u-flex u-items-center u-gap-2 u-fs-12">
                <code className="review-card__step-type" title={s.nodeId}>{s.typeId}</code>
                <span className={`chip ${badge.cls} u-fs-10`}>{t(badge.key)}</span>
              </li>
            );
          })}
          {moreSteps > 0 ? <li className="muted u-fs-11">{t('composedMoreSteps', { count: moreSteps })}</li> : null}
        </ol>
      ) : null}
      {hasInputs ? (
        <details className="review-card__trace">
          <summary>{t('composedInputs')} <span className="muted">({inputCount})</span></summary>
          <pre className="review-card__inputs u-fs-11">{JSON.stringify(cw.runInputs, null, 2)}</pre>
        </details>
      ) : null}
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        {review.workflowId ? (
          <Link to={`/builder/${review.workflowId}`} className="secondary btn-sm u-flex u-items-center u-gap-2">
            <WorkflowIcon size={14} /> {t('composedOpenBuilder')}
          </Link>
        ) : null}
        {cw.expiresAt && !cw.expired ? (
          <span className="muted u-fs-11">{t('composedExpires', { date: formatDate(cw.expiresAt) })}</span>
        ) : null}
      </div>
    </section>
  );
}

export default ComposedWorkflowSection;
