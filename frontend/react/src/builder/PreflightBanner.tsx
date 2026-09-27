/**
 * Pre-flight warning banner — host-capability + engine-limit breaches
 * found on a Run/Validate click. Extracted from BuilderShell.tsx (pure
 * extraction — no behavior change).
 */

import { Button } from '../ui/Button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useBuilderStore } from './store/builderStore.js';
import { beginOAuth } from '../features/connections/connectionsClient.js';
import type { PreflightIssue, LimitIssue } from './builderShellHelpers.js';

/** A connection the graph names that the caller has no ACTIVE row for
 *  (day-1 UX P9). `connectable` = the host can run the consent right now
 *  (provider installed + OAuth client configured). */
export interface UnboundConnection {
  ref: string;
  providerId: string;
  label: string;
  connectable: boolean;
}

interface PreflightBannerProps {
  preflight: { caps: PreflightIssue[]; limits: LimitIssue[]; conns: UnboundConnection[] };
  onCancel(): void;
  onRunAnyway(): void;
}

export function PreflightBanner({ preflight, onCancel, onRunAnyway }: PreflightBannerProps) {
  const { t } = useTranslation('builder');
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  async function connect(providerId: string): Promise<void> {
    setConnecting(providerId);
    setConnectError(null);
    try {
      // Come back to this canvas after consent (same-origin relative path).
      const url = await beginOAuth(providerId, window.location.pathname);
      window.location.href = url;
    } catch {
      setConnectError(t('preRunConnectError'));
      setConnecting(null);
    }
  }

  return (
    <div className="alert warning builder-toolbar-error">
      {preflight.caps.length > 0 && (
        <>
          <strong>
            {t('preflightCapsHeading', { count: preflight.caps.length })}
          </strong>{' '}
          {t('preflightCapsIntro', { count: preflight.caps.length })}{' '}
          <code>HOST_CAPABILITY_MISSING</code>:
          <ul className="preflight-issue-list">
            {preflight.caps.map((i) => (
              <li key={i.nodeId}>
                <button
                  type="button"
                  className="linklike"
                  onClick={() => useBuilderStore.getState().selectNode(i.nodeId)}
                >
                  {i.name}
                </button>{' '}
                {t('preflightNodeNeeds')} <code>{i.missing.join(', ')}</code>
              </li>
            ))}
          </ul>
          {/* ADR 0163 Phase 5 — guide setup instead of a dead end. */}
          <Link to="/connections" className="linklike">{t('configureConnectionsCta')}</Link>
        </>
      )}
      {preflight.conns.length > 0 && (
        <>
          <strong>{t('preRunConnsHeading', { count: preflight.conns.length })}</strong>{' '}
          {t('preRunConnsIntro')}
          <ul className="preflight-issue-list">
            {preflight.conns.map((c) => (
              <li key={c.ref} className="action-bar u-justify-between">
                <span>{c.label}</span>
                {c.connectable ? (
                  <Button
                    variant="secondary"
                    disabled={connecting !== null}
                    aria-busy={connecting === c.providerId}
                    onClick={() => { void connect(c.providerId); }}
                  >
                    {connecting === c.providerId ? t('preRunConnecting') : t('preflightConnectCta')}
                  </Button>
                ) : (
                  <Link to="/access?tab=connections" className="linklike">{t('configureConnectionsCta')}</Link>
                )}
              </li>
            ))}
          </ul>
          {connectError ? <p role="alert">{connectError}</p> : null}
        </>
      )}
      {preflight.limits.length > 0 && (
        <>
          <strong>
            {t('preflightLimitsHeading', { count: preflight.limits.length })}
          </strong>
          <ul className="preflight-issue-list">
            {preflight.limits.map((i) => (
              <li key={i.kind}>{i.message}</li>
            ))}
          </ul>
        </>
      )}
      <div className="button-row">
        <Button variant="secondary" onClick={onCancel}>{t('common:cancel')}</Button>
        <Button variant="primary" onClick={onRunAnyway}>{t('runAnyway')}</Button>
      </div>
    </div>
  );
}
