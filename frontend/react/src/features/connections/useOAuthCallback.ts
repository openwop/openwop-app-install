/**
 * OAuth callback toast (ADR 0024 / ADR 0025). Surfaces the outcome of the
 * provider consent redirect — the provider bounces the browser back to the
 * surface that started the flow (`?connected=…` or `?connectError=…&reason=…`) —
 * then strips those params from the URL. Shared by the standalone Connections
 * page AND the profile's Connections tab, so a connect started from either lands
 * the user back where they were, with a single source for the copy + effect.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from '../../ui/toast.js';

/** i18n keys for the callback's `reason` codes. */
const OAUTH_ERROR_KEY = {
  consent_denied: 'callbackConsentDenied',
  invalid_state: 'callbackInvalidState',
  missing_params: 'callbackMissingParams',
  exchange_failed: 'callbackExchangeFailed',
} as const;

export function useOAuthCallbackToast(): void {
  const { t } = useTranslation('connections');
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const connected = searchParams.get('connected');
    const connectError = searchParams.get('connectError');
    if (!connected && !connectError) return;
    if (connected) toast.success(t('callbackConnected', { provider: connected }));
    else if (connectError) {
      const reason = searchParams.get('reason') ?? '';
      const key = OAUTH_ERROR_KEY[reason as keyof typeof OAUTH_ERROR_KEY];
      toast.error(key ? t(key) : t('callbackGenericError', { provider: connectError }));
    }
    const next = new URLSearchParams(searchParams);
    next.delete('connected');
    next.delete('connectError');
    next.delete('reason');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, t]);
}
