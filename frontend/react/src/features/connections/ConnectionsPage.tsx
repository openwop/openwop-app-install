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
import { lazy, Suspense, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../../ui/Button.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { listMyWorkspaces } from '../../client/workspaceClient.js';
import { getAttestation } from './whatsapp/whatsappClient.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { useHub } from '../../chrome/hubContext.js';
import { ConnectionsManager } from './ConnectionsManager.js';
import { GovernancePanel } from './GovernancePanel.js';
import { OAuthClientAdminPanel } from './OAuthClientAdminPanel.js';
import { VaultAdminPanel } from './VaultAdminPanel.js';
import { useOAuthCallbackToast } from './useOAuthCallback.js';

// ADR 1053 D10 — WhatsApp settings is a LAZY sub-view of this (already lazy) page,
// not a top-level route: nothing of it enters the entry chunk or the eager registry.
const WhatsAppSettings = lazy(() => import('./whatsapp/WhatsAppSettings.js').then((m) => ({ default: m.WhatsAppSettings })));

/** The entry card, shown only with the `whatsapp` toggle on. `?view=whatsapp` opens it
 *  (a shareable deep link inside the Access console). Closed, it still shows whether the
 *  no-training attestation is recorded: without it inbound WhatsApp never starts an AI
 *  workflow, and that blocking state must be visible without opening anything
 *  (grade-ux WA85UX-20). An unreadable status shows no chip, never a guess. */
export function WhatsAppEntry(): JSX.Element | null {
  const { t } = useTranslation('connections');
  const access = useFeatureAccess('whatsapp');
  const [params, setParams] = useSearchParams();
  const headingId = useId();
  const regionId = useId();
  const [attested, setAttested] = useState<boolean | null>(null);
  useEffect(() => {
    if (!access.enabled) return;
    let live = true;
    void listMyWorkspaces()
      .then((w) => getAttestation(w.active))
      .then((a) => { if (live) setAttested(a.attested); }, () => { if (live) setAttested(null); });
    return () => { live = false; };
  }, [access.enabled]);
  if (!access.enabled) return null;
  const open = params.get('view') === 'whatsapp';
  const toggle = (): void => setParams((p) => {
    const n = new URLSearchParams(p);
    if (open) n.delete('view'); else n.set('view', 'whatsapp');
    return n;
  }, { replace: true });
  return (
    <section className="surface-card u-p-4 u-grid u-gap-3" aria-labelledby={headingId}>
      <div className="u-flex u-justify-between u-items-center u-gap-2 u-wrap">
        <div className="u-flex u-items-center u-gap-2 u-wrap">
          <h2 id={headingId} className="u-fs-16 u-m-0">{t('wa_entryTitle')}</h2>
          {attested === null ? null : attested
            ? <span className="chip chip--success">{t('wa_attestedChip')}</span>
            : <span className="chip chip--warning">{t('wa_notAttestedChip')}</span>}
        </div>
        <Button variant="secondary" size="sm" aria-expanded={open} aria-controls={regionId} onClick={toggle}>{open ? t('wa_entryHide') : t('wa_entryOpen')}</Button>
      </div>
      <div id={regionId}>
        {open ? <Suspense fallback={<Skeleton />}><WhatsAppSettings onAttestationChange={setAttested} /></Suspense> : <p className="u-m-0 muted u-text-sm">{t('wa_entryBody')}</p>}
      </div>
    </section>
  );
}

export function ConnectionsPage(): JSX.Element {
  const { t } = useTranslation('connections');
  const { embedded } = useHub();
  // Surface the OAuth callback outcome (the provider bounced the browser back to
  // /connections?connected=… or ?connectError=…&reason=…), then strip the params.
  useOAuthCallbackToast();

  return (
    <section data-walkthrough="connections.page" className="u-grid u-gap-4">
      {embedded ? null : <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />}
      <WhatsAppEntry />
      <ConnectionsManager />
      {/* Superadmin-only panels (each hidden on 403): host OAuth client setup
          (ADR 0024 § host-managed OAuth) + workspace policy (ADR 0028). */}
      <OAuthClientAdminPanel />
      <VaultAdminPanel />
      <GovernancePanel />
    </section>
  );
}
