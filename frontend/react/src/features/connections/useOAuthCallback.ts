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
import { toast } from '../../ui/toast.js';

/** Human copy for the callback's `reason` codes. */
const OAUTH_ERROR_COPY: Record<string, string> = {
  consent_denied: 'Consent was declined.',
  invalid_state: 'The consent session expired — please try again.',
  missing_params: 'The provider response was incomplete — please try again.',
  exchange_failed: 'Could not complete the token exchange. Please try again.',
};

export function useOAuthCallbackToast(): void {
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const connected = searchParams.get('connected');
    const connectError = searchParams.get('connectError');
    if (!connected && !connectError) return;
    if (connected) toast.success(`${connected} connected.`);
    else if (connectError) {
      const reason = searchParams.get('reason') ?? '';
      toast.error(OAUTH_ERROR_COPY[reason] ?? `Could not connect ${connectError}.`);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('connected');
    next.delete('connectError');
    next.delete('reason');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
}
