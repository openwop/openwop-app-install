import { useTranslation } from 'react-i18next';
import { Skeleton } from '../../ui/Skeleton.js';

/**
 * The loading state of a public CMS page (front page, pricing, blog post).
 *
 * It renders inside the same `.cms-public-page` box the loaded page uses, and
 * `--loading` holds that box at a full viewport's height. A short loading strip
 * let the site footer sit in view at load and then jump off-screen when the
 * content arrived: one layout shift of 0.12–0.14 on app.openwop.dev, and the
 * largest source of CLS 0.12 on an adopter's public site (measured 2026-11-27).
 */
export function PublicPageLoading(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="cms-public-page cms-public-page--loading">
      <div className="u-p-4" role="status" aria-label={t('loading')}><Skeleton /></div>
    </div>
  );
}
