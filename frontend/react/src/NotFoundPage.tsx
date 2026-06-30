/**
 * NotFoundPage — catch-all for unmatched routes. The app host rewrites every
 * path to index.html (SPA), so without a `<Route path="*">` any unknown URL
 * — a typo, a stale bookmark, or a feature not in this deployment yet —
 * renders a blank <main>. This gives the visitor orientation instead.
 */
import { Trans, useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';

export function NotFoundPage() {
  const { t } = useTranslation('chrome');
  const { pathname } = useLocation();
  return (
    <section>
      <div className="card">
        <h2 className="u-mt-0">{t('notFoundTitle')}</h2>
        <p className="muted">
          <Trans
            t={t}
            i18nKey="notFoundBody"
            values={{ path: pathname }}
            components={{ 0: <code /> }}
          />
        </p>
        <nav aria-label={t('notFoundGoTo')} className="u-flex u-gap-3 u-wrap">
          <Link to="/builder">{t('notFoundWorkflows')}</Link>
          <Link to="/">{t('notFoundChat')}</Link>
          <Link to="/runs">{t('notFoundRuns')}</Link>
        </nav>
      </div>
    </section>
  );
}
