/**
 * AI & connections (ADR 0438 A6) — the operator's honest view of KickTodo's
 * outbound-integration readiness. Its whole reason to exist is the B20 rule: the
 * calendar-write port must render as "awaiting adapter (no production transport)"
 * and NEVER "connected" until a transport is actually wired. This reads the REAL
 * deployment state (`getCalendarStatus` — a host-ext read, ADR 0438 §2) rather
 * than asserting a status, so it can't lie in either direction.
 *
 * Provider/BYOK health + notification delivery live at their own platform
 * authority (Connections, ADR 0024) — linked here, not re-modeled.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { getCalendarStatus } from '../../client/kicktodoIntegrationsClient.js';

export function AiConnectionsPage(): JSX.Element {
  const { t } = useTranslation('kicktodo-admin');
  const [configured, setConfigured] = useState<boolean | null | undefined>(undefined);
  const [error, setError] = useState(false);

  const reload = useCallback(async () => {
    try { setError(false); setConfigured((await getCalendarStatus()).transportConfigured); }
    catch { setError(true); setConfigured(null); }
  }, []);
  useEffect(() => { void reload(); }, [reload]); // KTUX-18 — retryable load

  return (
    <div className="page">
      <div className="action-bar">
        <Link className="btn-ghost btn-sm" to="/admin/kicktodo">{t('backToConsole')}</Link>
      </div>
      <header className="page-header">
        <h1 className="page-header__title">{t('connectionsTitle')}</h1>
        <p className="page-header__lede">{t('connectionsLede')}</p>
      </header>

      {error && (
        <>
          <Notice variant="error">{t('connectionsError')}</Notice>
          <div className="action-bar">
            <Button variant="quiet" size="sm" onClick={() => void reload()}>{t('retry')}</Button>
          </div>
        </>
      )}
      {configured === undefined && !error && <StateCard loading title={t('connectionsTitle')} />}

      {configured !== undefined && (
        <section className="surface-card" aria-label={t('calendarHeading')}>
          <h2 className="kt-eyebrow">{t('calendarHeading')}</h2>
          <div className="action-bar">
            {/* B20 — the status is READ, not assumed. Awaiting-adapter is the honest
                default; "connected" appears only when a transport is truly wired. */}
            {configured === null ? (
              <span className="chip chip--muted">{t('calendarUnknown')}</span>
            ) : configured ? (
              <span className="chip chip--success">{t('calendarConnected')}</span>
            ) : (
              <span className="chip chip--muted">{t('calendarAwaitingAdapter')}</span>
            )}
          </div>
          <p className="muted u-fs-13">{t('calendarDescription')}</p>
        </section>
      )}

      {/* Provider/BYOK health + delivery live at their own platform authority. */}
      <section className="surface-card" aria-label={t('providerHeading')}>
        <h2 className="kt-eyebrow">{t('providerHeading')}</h2>
        <p className="muted u-fs-13">{t('providerDescription')}</p>
        <div className="action-bar">
          <Link className="btn-ghost btn-sm" to="/connections">{t('openConnections')}</Link>
        </div>
      </section>
    </div>
  );
}
