/**
 * RFC 0121 CLEARED subscription provider — GitHub Copilot connect (ADR 0757).
 *
 * Unlike the at-own-risk card, there is no ToS-risk acknowledgement: GitHub's own
 * Copilot SDK documentation sanctions an app making Copilot requests on behalf of
 * users who authorize it. The user connects through GitHub's consent screen; the
 * token is minted and stored host-side at their personal user scope, and this
 * component never sees it. Rendered only when the host advertises
 * `github.copilot` (i.e. the operator configured the OAuth App + sidecar).
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { Notice } from '../ui/index.js';
import { ShieldIcon } from '../ui/icons/index.js';
import { connectCopilot, disconnectCopilot } from './lib/byokClient.js';

type Status = 'connected' | 'disconnected' | 'error' | null;

/** Read (and consume) the `?copilot=` result the OAuth callback appends. */
function readCallbackStatus(): Status {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const v = params.get('copilot');
  if (v !== 'connected' && v !== 'error') return null;
  params.delete('copilot');
  params.delete('reason');
  const qs = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
  return v;
}

export function CopilotConnectCard(): JSX.Element {
  const { t } = useTranslation('byok');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setStatus(readCallbackStatus()); }, []);

  async function onConnect(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const { authorizeUrl } = await connectCopilot(window.location.pathname);
      window.location.assign(authorizeUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function onDisconnect(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await disconnectCopilot();
      setStatus('disconnected');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="surface-card">
      <div className="keys-provider-head action-bar u-justify-between">
        <div className="keys-provider-name u-iflex u-gap-2">
          <span className="chip">
            <span className="u-iflex u-gap-1"><ShieldIcon size={13} aria-hidden /> {t('copilot.title')}</span>
          </span>
        </div>
      </div>
      <p className="muted">{t('copilot.intro')}</p>
      <p className="muted">{t('copilot.scopeNote')}</p>
      <p className="muted">{t('copilot.personalOnly')}</p>

      {status === 'connected' && <Notice variant="success" announce={t('copilot.connected')}>{t('copilot.connected')}</Notice>}
      {status === 'disconnected' && <Notice variant="info">{t('copilot.disconnected')}</Notice>}
      {status === 'error' && <Notice variant="error" announce={t('copilot.error')}>{t('copilot.error')}</Notice>}
      {error && <Notice variant="error" announce={error}>{error}</Notice>}

      <div className="u-flex u-gap-2 u-justify-end">
        <Button variant="secondary" onClick={() => { void onDisconnect(); }} disabled={busy}>{t('copilot.disconnect')}</Button>
        <Button variant="primary" onClick={() => { void onConnect(); }} disabled={busy}>{t('copilot.connect')}</Button>
      </div>
    </div>
  );
}
