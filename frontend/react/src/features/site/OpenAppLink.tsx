/**
 * The "Open app" affordance on the public front page (CORRECTION 2026-09-11).
 *
 * `/` now renders the front page for EVERY visitor when the operator's toggle is
 * on, rather than redirecting a signed-in one to `/dashboard`. Without this link
 * that trade swaps one trap for another: a signed-in visitor would land on
 * marketing at the bare domain with no signposted way back into the product.
 *
 * Deliberately SIMPLER than its sibling `EditThisPageLink`, and the difference is
 * the point. That component probes the CMS because the probe IS its authorization
 * — a 200 proves the caller can reach the page. This one authorizes nothing: it
 * links to `/dashboard`, which is behind `AppGate` and enforces its own access on
 * arrival. So it costs ZERO requests for every visitor, signed in or not, which
 * matters on the highest-traffic surface in the app (`middleware/rateLimit.ts`
 * budgets per IP — see rule 1 in `EditThisPageLink`).
 *
 * Renders nothing while auth is resolving, so the page never flashes a control
 * that is about to disappear.
 */
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/useAuth.js';

export function OpenAppLink(): JSX.Element | null {
  const { t } = useTranslation('site');
  const { user, loading } = useAuth();
  if (loading || !user) return null;
  return (
    <Link className="btn btn-sm" to="/dashboard" data-testid="open-app-link">
      {t('openApp', { defaultValue: 'Open app' })}
    </Link>
  );
}
