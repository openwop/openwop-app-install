/**
 * Connections manager body (ADR 0024) — the OAuth-consent + api_key/bearer
 * connect form, org-sharing, per-connection test + write re-consent, and the
 * connections table, WITHOUT a page header, the feature-gate, or the OAuth
 * callback-param handling (those are page/routing concerns the caller owns).
 * Both the standalone Connections page (`ConnectionsPage`) and the profile's
 * Connections tab (ADR 0025) render this, so the connect/revoke/test logic lives
 * in exactly one place. No feature-gate is needed: Connections graduated off its
 * toggle to a permanent, always-on surface (ADR 0024 § Correction), so the
 * backend serves these routes unconditionally.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { toast } from '../../ui/toast.js';
import { PlugIcon } from '../../ui/icons/index.js';
import { getEffectiveAccess } from '../../client/accessClient.js';
import { useHub } from '../../chrome/hubContext.js';
import {
  listProviders,
  listConnections,
  createConnection,
  revokeConnection,
  beginOAuth,
  testConnection,
  type Provider,
  type Connection,
} from './connectionsClient.js';

export function ConnectionsManager({ returnPath = '/connections' }: { returnPath?: string } = {}): JSX.Element {
  const { t } = useTranslation('connections');
  // Inside the Access Hub (ADR 0144) the Workspace·Personal pill scopes the view:
  // Personal shows the caller's own connections, Workspace the org-shared ones.
  // Outside the hub (`embedded:false`) nothing is filtered — the standalone page
  // and the profile tab show every connection exactly as before.
  const { embedded, scope } = useHub();
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [rows, setRows] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState('servicenow');
  const [secret, setSecret] = useState('');
  const [shareScope, setShareScope] = useState<'user' | 'org'>('user');
  const [canManageOrg, setCanManageOrg] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    // FP-4: settle each resource independently — a providers failure must not
    // also blank out the (separately-fetched) connections list, and vice versa.
    void Promise.allSettled([listProviders(), listConnections()]).then(([pRes, cRes]) => {
      if (pRes.status === 'fulfilled') setProviders(pRes.value);
      if (cRes.status === 'fulfilled') setRows(cRes.value);
      const failed = [pRes, cRes].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      if (failed.length > 0) {
        const reason = failed[0]!.reason;
        setError(reason instanceof Error ? reason.message : t('loadFailed'));
      }
    });
    // Only offer org-shared creation to a caller who can actually complete it
    // (host:connections:manage) — don't surface an action that would 403.
    void getEffectiveAccess()
      .then((a) => setCanManageOrg(a.scopes.includes('host:connections:manage')))
      .catch(() => setCanManageOrg(false));
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  // When embedded, the scope pill — not the in-form selector — decides sharing:
  // Personal ⇒ a user connection; Workspace ⇒ org-shared (only if the caller can
  // manage org connections, else fall back to a user connection).
  useEffect(() => {
    if (embedded) setShareScope(scope === 'workspace' && canManageOrg ? 'org' : 'user');
  }, [embedded, scope, canManageOrg]);

  // Scope-filter the table only inside the hub (org-shared have an orgId; personal
  // do not). Outside the hub, show everything (no behavior change).
  const displayRows = useMemo(() => {
    if (!embedded || rows === null) return rows;
    return rows.filter((c) => (scope === 'personal' ? !c.orgId : Boolean(c.orgId)));
  }, [embedded, scope, rows]);

  const selected = useMemo(() => providers?.find((p) => p.id === provider) ?? null, [providers, provider]);

  const connect = useCallback(async () => {
    if (!selected || !secret.trim()) return;
    setBusy(true);
    try {
      const kind = selected.kind === 'bearer' ? 'bearer' : 'api_key';
      await createConnection({ provider, kind, secret: secret.trim(), scope: shareScope });
      setSecret('');
      load();
      toast.success(
        shareScope === 'org'
          ? t('connectedForOrg', { label: selected.label })
          : t('connected', { label: selected.label }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('connectFailed'));
    } finally {
      setBusy(false);
    }
  }, [selected, provider, secret, shareScope, load, t]);

  const connectOAuth = useCallback(async (providerId: string, label: string, opts: { write?: boolean } = {}) => {
    setConnecting(providerId);
    try {
      // Hand off to the provider's consent screen; the callback returns to the
      // surface that started the flow (the page, or the profile's Connections tab).
      const authorizeUrl = await beginOAuth(providerId, returnPath, opts);
      window.location.assign(authorizeUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('couldNotStart', { label }));
      setConnecting(null);
    }
  }, [returnPath, t]);

  const revoke = useCallback(
    async (id: string) => {
      try {
        await revokeConnection(id);
        load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('revokeFailed'));
      }
    },
    [load, t],
  );

  const test = useCallback(
    async (c: Connection) => {
      try {
        const { ok } = await testConnection(c.connectionId);
        if (ok) toast.success(t('connectionHealthy', { name: c.displayName }));
        else toast.error(t('connectionNeedsReconnect', { name: c.displayName }));
        load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('testFailed'));
      }
    },
    [load, t],
  );

  const providersById = useMemo(() => new Map((providers ?? []).map((p) => [p.id, p])), [providers]);

  /** A connection can be upgraded to write when its provider declares write
   *  scopes the connection doesn't yet hold (ADR 0024 Phase C write re-consent). */
  const writeState = useCallback(
    (c: Connection): { offerable: boolean; granted: boolean } => {
      const writeScopes = providersById.get(c.provider)?.writeScopes ?? [];
      if (c.kind !== 'oauth2' || writeScopes.length === 0) return { offerable: false, granted: false };
      const granted = writeScopes.every((s) => c.scopes.includes(s));
      return { offerable: !granted, granted };
    },
    [providersById],
  );

  const columns = useMemo<DataColumn<Connection>[]>(
    () => [
      { key: 'displayName', header: t('colConnection'), render: (c) => c.displayName },
      { key: 'provider', header: t('colProvider'), render: (c) => <span className="chip">{c.provider}</span> },
      {
        key: 'sharing',
        header: t('colSharing'),
        render: (c) => (
          <span className="action-bar">
            <span className="chip chip--muted">{c.orgId ? t('sharingOrganization') : t('sharingPersonal')}</span>
            {writeState(c).granted ? <span className="chip chip--muted">{t('sharingWrite')}</span> : null}
          </span>
        ),
      },
      { key: 'status', header: t('colStatus'), render: (c) => <StatusBadge status={c.status} /> },
      {
        key: 'actions',
        header: '',
        render: (c) => {
          const prov = providersById.get(c.provider);
          return (
            <span className="action-bar">
              {writeState(c).offerable && prov ? (
                <button type="button" className="btn-ghost" onClick={() => void connectOAuth(prov.id, t('grantWriteAccessConnect', { label: prov.label }), { write: true })} aria-label={t('grantWriteAccessLabel', { name: c.displayName })}>{t('grantWriteAccess')}</button>
              ) : null}
              <button type="button" className="btn-ghost" onClick={() => void test(c)} aria-label={t('testConnectionLabel', { name: c.displayName })}>{t('test')}</button>
              <button type="button" className="btn-ghost" onClick={() => void revoke(c.connectionId)} aria-label={t('revokeConnectionLabel', { name: c.displayName })}>{t('revoke')}</button>
            </span>
          );
        },
      },
    ],
    [revoke, test, connectOAuth, providersById, writeState, t],
  );

  // Providers that connect via a posted secret (api_key/bearer) vs. those that
  // connect via the OAuth consent flow (oauth2). `providers === null` until the
  // first load resolves — the form is loading-aware so the <select> never flashes
  // empty (the surface paints progressively, no full-page skeleton).
  const loadingProviders = providers === null;
  const secretProviders = (providers ?? []).filter((p) => p.kind === 'api_key' || p.kind === 'bearer');
  const oauthProviders = (providers ?? []).filter((p) => p.kind === 'oauth2');

  return (
    <div className="u-grid u-gap-4">
      {error ? <Notice variant="error">{error}</Notice> : null}

      {oauthProviders.length > 0 ? (
        <div className="surface-card u-p-4 u-grid u-gap-3">
          <div className="u-grid u-gap-1">
            <span className="u-label-sm">{t('connectWithConsent')}</span>
            <p className="muted">{t('consentBlurb')}</p>
          </div>
          <div className="action-bar">
            {oauthProviders.map((p) => (
              <button
                key={p.id}
                type="button"
                className="btn-ghost"
                disabled={!p.oauthConfigured || connecting !== null}
                onClick={() => void connectOAuth(p.id, t('connectProviderConnect', { label: p.label }))}
                aria-label={t('connectProvider', { label: p.label })}
                title={p.oauthConfigured ? undefined : t('oauthNotConfiguredTitle', { label: p.label })}
              >
                {connecting === p.id ? t('connectingProvider', { label: p.label }) : t('connectProvider', { label: p.label })}
              </button>
            ))}
          </div>
          {oauthProviders.some((p) => !p.oauthConfigured) ? (
            <p className="muted">{t('notConfiguredHint')}</p>
          ) : null}
        </div>
      ) : null}

      <div className="surface-card u-p-4 surface-form">
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('providerLabel')}</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={loadingProviders}>
            {loadingProviders
              ? <option value={provider}>{t('loadingProviders')}</option>
              : secretProviders.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
          </select>
        </label>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('secretLabel')}</span>
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={t('secretPlaceholder')} autoComplete="off" />
        </label>
        {canManageOrg && !embedded ? (
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('sharedWith')}</span>
            <select value={shareScope} onChange={(e) => setShareScope(e.target.value as 'user' | 'org')}>
              <option value="user">{t('shareJustMe')}</option>
              <option value="org">{t('shareOrganization')}</option>
            </select>
          </label>
        ) : null}
        <button type="button" className="btn-primary" disabled={busy || loadingProviders || !secret.trim()} onClick={() => void connect()}>
          {t('connect')}
        </button>
      </div>

      <DataTable
        rows={displayRows ?? []}
        rowKey={(c) => c.connectionId}
        columns={columns}
        caption={t('tableCaption')}
        empty={
          rows === null
            ? <SkeletonRows rows={2} columns={[200, 110, 110, 110, 140]} />
            : <StateCard icon={<PlugIcon />} title={t('noConnectionsTitle')} body={t('noConnectionsBody')} />
        }
      />
    </div>
  );
}
