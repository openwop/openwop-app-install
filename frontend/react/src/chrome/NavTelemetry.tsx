/**
 * Workspace navigation telemetry — beacon + member disclosure (ADR 0512).
 *
 * Renders in the authed app shell beside the other top-of-shell banners. When
 * the `workspace-nav-telemetry` sub-toggle resolves ON for this tenant:
 *
 *  - a route change posts ONE counts-only beacon: the matched manifest route
 *    PATTERN (never the concrete URL — no ids leave the client) × the consumed
 *    navigation source (chrome/navSource.ts). Fire-and-forget; the server
 *    aggregates at write time (no per-user trail ever exists) and re-checks
 *    BOTH toggles, so the client check is a courtesy, not the gate;
 *  - members see a dismissible disclosure banner (localStorage, per browser)
 *    naming exactly what is recorded — measuring members quietly is the
 *    failure mode this component exists to prevent.
 *
 * Toggle OFF (the default everywhere): renders nothing, posts nothing.
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFeatureAccess } from '../featureToggles/FeatureAccessContext.js';
import { featureFor } from './features.js';
import { consumeNavSource } from './navSource.js';
import { config, fetchOpts, authedHeaders } from '../client/config.js';
import { XIcon } from '../ui/icons/index.js';
import { IconButton } from '../ui/IconButton.js';

const DISMISS_KEY = 'openwop:nav-telemetry-disclosure:dismissed';

export function NavTelemetry(): JSX.Element | null {
  const { t } = useTranslation('chrome');
  const location = useLocation();
  const { enabled } = useFeatureAccess('workspace-nav-telemetry');
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    // Consume the stamp UNCONDITIONALLY so a stale source never survives a
    // toggle flip; only post when the surface is on.
    const source = consumeNavSource();
    if (!enabled) return;
    const route = featureFor(location.pathname)?.path;
    if (!route) return; // unmatched routes (404s etc.) are not evidence
    void fetch(`${config.baseUrl}/host/openwop-app/analytics/nav`, fetchOpts({
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authedHeaders() },
      keepalive: true,
      body: JSON.stringify({ route, source }),
    })).catch(() => undefined); // measurement never breaks the page
  }, [location.pathname, enabled]);

  if (!enabled || dismissed) return null;
  return (
    <div className="demo-host-banner" role="note">
      <span className="demo-host-banner-text">{t('navTelemetryDisclosure')}</span>
      <IconButton
        className="demo-host-banner-close"
        label={t('navTelemetryDismiss')}
        icon={<XIcon size={14} />}
        onClick={() => { setDismissed(true); try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ } }}
      />
    </div>
  );
}
