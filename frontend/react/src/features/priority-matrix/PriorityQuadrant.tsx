/**
 * PriorityQuadrant — the 2×2 impact×effort matrix view of a priority list (the
 * page's namesake, previously deferred). Four labeled buckets: Quick wins
 * (high impact, low effort — the winner, clay-tinted), Big bets, Fill-ins, and
 * Reconsider; each idea lands in exactly one by its benefit/cost split
 * (`placeIdeas`). Ideas missing a score on either axis sit in an Unscored tray.
 * Read-only and token-only — scoring stays the List view's job.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../i18n/format.js';
import { placeIdeas, QUADRANT_ORDER, type QuadrantId } from './quadrant.js';
import type { CriteriaSet, RankedIdea } from './priorityMatrixClient.js';

export function PriorityQuadrant({ ideas, criteriaSet }: { ideas: RankedIdea[]; criteriaSet: CriteriaSet }): JSX.Element {
  const { t } = useTranslation('priority-matrix');
  const { quadrants, unscored } = useMemo(() => placeIdeas(ideas, criteriaSet), [ideas, criteriaSet]);

  const META: Record<QuadrantId, { label: string; cls: string }> = {
    'quick-wins': { label: t('quadQuickWins'), cls: 'pm-quad--quickwins' },
    'big-bets': { label: t('quadBigBets'), cls: 'pm-quad--bigbets' },
    'fill-ins': { label: t('quadFillIns'), cls: 'pm-quad--fillins' },
    reconsider: { label: t('quadReconsider'), cls: 'pm-quad--reconsider' },
  };

  return (
    <div className="pm-matrix">
      <div className="pm-matrix-grid" role="group" aria-label={t('viewMatrix')}>
        {QUADRANT_ORDER.map((q) => (
          <section key={q} className={`pm-quad ${META[q].cls}`} aria-label={META[q].label}>
            <header className="pm-quad-head">
              <span className="pm-quad-title">{META[q].label}</span>
              <span className="muted u-fs-11">{formatNumber(quadrants[q].length)}</span>
            </header>
            {quadrants[q].length === 0 ? (
              <span className="muted u-fs-12">{t('quadEmpty')}</span>
            ) : (
              <ul className="pm-quad-ideas">
                {quadrants[q].map((idea) => (
                  <li key={idea.card.id} className="pm-quad-idea">
                    <span className="muted u-fs-11">#{formatNumber(idea.rank)}</span>
                    <span className="pm-quad-idea-title">{idea.card.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
      <p className="pm-matrix-legend muted u-fs-12">{t('matrixLegend')}</p>

      {unscored.length > 0 ? (
        <div className="surface-card u-flex u-flex-col u-gap-1">
          <span className="u-label-sm">{t('matrixUnscored', { count: unscored.length, formattedCount: formatNumber(unscored.length) })}</span>
          <span className="muted u-fs-12">{t('matrixUnscoredHint')}</span>
          <div className="u-flex u-gap-2 u-wrap u-mt-1">
            {unscored.map((i) => <span key={i.card.id} className="chip chip--muted">{i.card.title}</span>)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
