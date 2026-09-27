/**
 * NotFoundPage — catch-all for unmatched routes. The app host rewrites every
 * path to index.html (SPA), so without a `<Route path="*">` any unknown URL
 * — a typo, a stale bookmark, or a feature not in this deployment yet —
 * renders a blank <main>. This gives the visitor orientation instead.
 *
 * SHELL-5/10 (ADR 0196 re-grade): renders through the <StateCard> state
 * primitive, and recovery links no longer assume reference routes that a
 * given deployment may have toggled off — home is the one safe target.
 */
import { Trans, useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { StateCard } from './ui/StateCard.js';
import { SearchIcon } from './ui/icons/index.js';

export function NotFoundPage() {
  const { t } = useTranslation('chrome');
  const { pathname } = useLocation();
  return (
    <section>
      <StateCard
        icon={<SearchIcon size={20} />}
        title={t('notFoundTitle')}
        body={
          <Trans
            t={t}
            i18nKey="notFoundBody"
            values={{ path: pathname }}
            components={{ 0: <code /> }}
          />
        }
        action={<Link className="btn" to="/">{t('notFoundHome')}</Link>}
      />
    </section>
  );
}
