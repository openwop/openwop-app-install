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
  return `${origin}/api/v1/host/sample/connections/${provider}/callback`;
}

export function OAuthClientAdminPanel(): JSX.Element | null {
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
        setError(err instanceof Error ? err.message : 'Failed to load OAuth client config.');
      })
      .finally(() => setLoading(false));
  }, []);

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
      toast.success(`OAuth client saved — ${provider} can now run consent.`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(null);
    }
  }, [draft, load]);

  const remove = useCallback(async (provider: string) => {
    setBusy(provider);
    try {
      await deleteOAuthClient(provider);
      toast.success(`OAuth client removed for ${provider}.`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Remove failed.');
    } finally {
      setBusy(null);
    }
  }, [load]);

  // Non-superadmin (or still resolving the gate): render nothing.
  if (hidden) return null;
  if (loading) return null;
  if (oauthProviders.length === 0) return null;

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <div className="u-grid u-gap-1">
        <span className="u-label-sm"><KeyIcon /> OAuth client setup (operator)</span>
        <p className="muted">
          Configure each provider's OAuth app so its Connect button works — no env vars, no redeploy. Register the
          redirect URI shown below with the provider, then paste its Client ID and Secret here. The secret is sealed
          server-side and never shown again.
        </p>
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
                  {cfg?.configured ? 'Configured' : 'Not configured'}
                </span>
              </div>
              <label className="u-grid u-gap-1">
                <span className="u-label-sm">Redirect URI to register with {p.label}</span>
                <input type="text" readOnly value={redirectUriHint(p.id)} onFocus={(e) => e.currentTarget.select()} />
              </label>
              <label className="u-grid u-gap-1">
                <span className="u-label-sm">Client ID{cfg ? ` (current: ${cfg.clientId})` : ''}</span>
                <input
                  type="text"
                  value={d.clientId}
                  onChange={(e) => setField('clientId', e.target.value)}
                  placeholder={cfg ? 'replace the client id' : 'paste the OAuth client id'}
                  autoComplete="off"
                />
              </label>
              <label className="u-grid u-gap-1">
                <span className="u-label-sm">Client secret</span>
                <input
                  type="password"
                  value={d.clientSecret}
                  onChange={(e) => setField('clientSecret', e.target.value)}
                  placeholder="paste the OAuth client secret"
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
                  {cfg ? 'Replace' : 'Save'}
                </button>
                {cfg ? (
                  <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => void remove(p.id)} aria-label={`Remove OAuth client for ${p.label}`}>
                    Remove
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
