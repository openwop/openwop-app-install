/**
 * OfflineEntitlementState (ADR 0873 D12) — what `EntitlementGuard` renders when the
 * access resolution could not reach the server and the feature has no last-known
 * grant. NOT lazy, unlike `LockedState`: it renders only offline, and the service
 * worker precaches the entry's static graph alone, so a lazy chunk would fail to
 * load exactly when this is shown. Its imports are ones the entry already holds.
 *
 * It says the access check needs a connection, never that the feature is locked:
 * offline we do not know. The provider re-resolves on the browser's `online`
 * event, so the card clears on its own; the button is for a reconnect the browser
 * does not announce.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../ui/StateCard.js';
import { Button } from '../ui/Button.js';
import { GlobeIcon } from '../ui/icons/index.js';

export function OfflineEntitlementState({ onRetry }: { onRetry: () => void }): ReactElement {
  const { t } = useTranslation('chrome');
  return (
    <section className="u-grid u-gap-4 u-p-4">
      <StateCard
        icon={<GlobeIcon />}
        title={t('offlineEntitlementTitle')}
        body={t('offlineEntitlementBody')}
        action={<Button onClick={onRetry}>{t('offlineEntitlementRetry')}</Button>}
        announce
      />
    </section>
  );
}
