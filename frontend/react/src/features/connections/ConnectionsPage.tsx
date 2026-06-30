/**
 * Connections page (ADR 0024). Manage per-user credentials for external apps
 * (Google, Slack, ServiceNow, Zoom, …) that feed the assistant's loops.
 * Phase A: the provider catalog + api_key/bearer connect + revoke.
 * Phase B: the OAuth "Connect" consent flow (Google/Slack) + per-connection test.
 *
 * The connect/test/revoke body lives in `<ConnectionsManager>` (shared with the
 * profile's Connections tab, ADR 0025) so the logic has a single home. This page
 * owns the page-level concerns: the header and surfacing the OAuth callback
 * outcome (the provider bounces the browser back here). Connections graduated off
 * its feature toggle to a permanent admin surface (ADR 0024 § Correction), so
 * there is no feature-gate here — the page renders unconditionally.
 */
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { useHub } from '../../chrome/hubContext.js';
import { ConnectionsManager } from './ConnectionsManager.js';
import { GovernancePanel } from './GovernancePanel.js';
import { OAuthClientAdminPanel } from './OAuthClientAdminPanel.js';
import { useOAuthCallbackToast } from './useOAuthCallback.js';

export function ConnectionsPage(): JSX.Element {
  const { t } = useTranslation('connections');
  const { embedded } = useHub();
  // Surface the OAuth callback outcome (the provider bounced the browser back to
  // /connections?connected=… or ?connectError=…&reason=…), then strip the params.
  useOAuthCallbackToast();

  return (
    <section className="u-grid u-gap-4">
      {embedded ? null : <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />}
      <ConnectionsManager />
      {/* Superadmin-only panels (each hidden on 403): host OAuth client setup
          (ADR 0024 § host-managed OAuth) + workspace policy (ADR 0028). */}
      <OAuthClientAdminPanel />
      <GovernancePanel />
    </section>
  );
}
