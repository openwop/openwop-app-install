/**
 * Host OAuth client config — superadmin admin panel (ADR 0024 § host-managed
 * OAuth client config). Lets an operator configure each OAuth provider's app
 * (client id + secret) through the UI instead of `OPENWOP_OAUTH_*` env vars, so
 * enabling Google / Slack is self-service with no redeploy.
 *
 * Gating: the backend is the authority. We call `listOAuthClients()`; a 403
 * (ForbiddenError) means the caller isn't a superadmin, so the whole panel
 * renders nothing — it never appears for a non-operator. The client SECRET is
 * write-only (sealed server-side, never read back), mirroring the `/keys` BYOK UX.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { toast } from '../../ui/toast.js';
import { KeyIcon } from '../../ui/icons/index.js';
import {
  listProviders,
  listOAuthClients,
  setOAuthClient,
  deleteOAuthClient,
  ForbiddenError,
  type Provider,
  type OAuthClientConfig,
} from './connectionsClient.js';

/** The browser-reachable redirect URI the operator must register with the
 *  provider — the host builds the same path off `OPENWOP_OAUTH_CALLBACK_BASE_URL`
 *  (defaulting to this origin's `/api`). Shown as copy-paste guidance. */
function redirectUriHint(provider: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/api/v1/host/openwop-app/connections/${provider}/callback`;
}

export function OAuthClientAdminPanel(): JSX.Element | null {
  const { t } = useTranslation('connections');
  const [hidden, setHidden] = useState(false); // true ⇒ not a superadmin
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [configs, setConfigs] = useState<OAuthClientConfig[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { clientId: string; clientSecret: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    void Promise.all([listProviders(), listOAuthClients()])
      .then(([provs, cfgs]) => {
        setProviders(provs);
        setConfigs(cfgs);
      })
      .catch((err) => {
        if (err instanceof ForbiddenError) { setHidden(true); return; }
        setError(err instanceof Error ? err.message : t('loadOAuthClientFailed'));
      })
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const oauthProviders = useMemo(() => providers.filter((p) => p.kind === 'oauth2'), [providers]);
  const configFor = useCallback((id: string) => configs.find((c) => c.provider === id) ?? null, [configs]);

  const save = useCallback(async (provider: string) => {
    const d = draft[provider];
    if (!d?.clientId.trim() || !d?.clientSecret.trim()) return;
    setBusy(provider);
    try {
      await setOAuthClient(provider, d.clientId.trim(), d.clientSecret.trim());
      setDraft((prev) => ({ ...prev, [provider]: { clientId: '', clientSecret: '' } }));
      toast.success(t('oauthClientSaved', { provider }));
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setBusy(null);
    }
  }, [draft, load, t]);

  const remove = useCallback(async (provider: string) => {
    setBusy(provider);
    try {
      await deleteOAuthClient(provider);
      toast.success(t('oauthClientRemoved', { provider }));
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('removeFailed'));
    } finally {
      setBusy(null);
    }
  }, [load, t]);

  // Non-superadmin (or still resolving the gate): render nothing.
  if (hidden) return null;
  if (loading) return null;
  if (oauthProviders.length === 0) return null;

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <div className="u-grid u-gap-1">
        <span className="u-label-sm"><KeyIcon /> {t('oauthClientSetup')}</span>
        <p className="muted">{t('oauthClientBlurb')}</p>
      </div>

      {error ? <Notice variant="error">{error}</Notice> : null}

      <div className="u-grid u-gap-3">
        {oauthProviders.map((p) => {
          const cfg = configFor(p.id);
          const d = draft[p.id] ?? { clientId: '', clientSecret: '' };
          const setField = (field: 'clientId' | 'clientSecret', value: string) =>
            setDraft((prev) => ({ ...prev, [p.id]: { ...d, [field]: value } }));
          return (
            <div key={p.id} className="surface-card u-p-3 u-grid u-gap-2">
              <div className="action-bar" style={{ justifyContent: 'space-between' }}>
                <span className="u-label-sm">{p.label}</span>
                <span className={`chip ${cfg?.configured ? 'chip--success' : 'chip--muted'}`}>
                  {cfg?.configured ? t('configured') : t('notConfigured')}
                </span>
              </div>
              <label className="u-grid u-gap-1">
                <span className="u-label-sm">{t('redirectUriLabel', { label: p.label })}</span>
                <input type="text" readOnly value={redirectUriHint(p.id)} onFocus={(e) => e.currentTarget.select()} />
              </label>
              <label className="u-grid u-gap-1">
                <span className="u-label-sm">{cfg ? t('clientIdLabelCurrent', { clientId: cfg.clientId }) : t('clientIdLabel')}</span>
                <input
                  type="text"
                  value={d.clientId}
                  onChange={(e) => setField('clientId', e.target.value)}
                  placeholder={cfg ? t('clientIdPlaceholderReplace') : t('clientIdPlaceholder')}
                  autoComplete="off"
                />
              </label>
              <label className="u-grid u-gap-1">
                <span className="u-label-sm">{t('clientSecretLabel')}</span>
                <input
                  type="password"
                  value={d.clientSecret}
                  onChange={(e) => setField('clientSecret', e.target.value)}
                  placeholder={t('clientSecretPlaceholder')}
                  autoComplete="off"
                />
              </label>
              <div className="action-bar">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy !== null || !d.clientId.trim() || !d.clientSecret.trim()}
                  onClick={() => void save(p.id)}
                >
                  {cfg ? t('replace') : t('common:save')}
                </button>
                {cfg ? (
                  <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => void remove(p.id)} aria-label={t('removeOAuthClientLabel', { label: p.label })}>
                    {t('common:remove')}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
