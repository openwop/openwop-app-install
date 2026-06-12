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
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { toast } from '../../ui/toast.js';
import { PlugIcon } from '../../ui/icons/index.js';
import { getEffectiveAccess } from '../../client/accessClient.js';
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
    void Promise.all([listProviders(), listConnections()])
      .then(([p, c]) => {
        setProviders(p);
        setRows(c);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load.'));
    // Only offer org-shared creation to a caller who can actually complete it
    // (host:connections:manage) — don't surface an action that would 403.
    void getEffectiveAccess()
      .then((a) => setCanManageOrg(a.scopes.includes('host:connections:manage')))
      .catch(() => setCanManageOrg(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selected = useMemo(() => providers?.find((p) => p.id === provider) ?? null, [providers, provider]);

  const connect = useCallback(async () => {
    if (!selected || !secret.trim()) return;
    setBusy(true);
    try {
      const kind = selected.kind === 'bearer' ? 'bearer' : 'api_key';
      await createConnection({ provider, kind, secret: secret.trim(), scope: shareScope });
      setSecret('');
      load();
      toast.success(`${selected.label} connected${shareScope === 'org' ? ' for the organization' : ''}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Connect failed.');
    } finally {
      setBusy(false);
    }
  }, [selected, provider, secret, shareScope, load]);

  const connectOAuth = useCallback(async (providerId: string, label: string, opts: { write?: boolean } = {}) => {
    setConnecting(providerId);
    try {
      // Hand off to the provider's consent screen; the callback returns to the
      // surface that started the flow (the page, or the profile's Connections tab).
      const authorizeUrl = await beginOAuth(providerId, returnPath, opts);
      window.location.assign(authorizeUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not start ${label}.`);
      setConnecting(null);
    }
  }, [returnPath]);

  const revoke = useCallback(
    async (id: string) => {
      try {
        await revokeConnection(id);
        load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Revoke failed.');
      }
    },
    [load],
  );

  const test = useCallback(
    async (c: Connection) => {
      try {
        const { ok } = await testConnection(c.connectionId);
        if (ok) toast.success(`${c.displayName} is healthy.`);
        else toast.error(`${c.displayName} needs to reconnect.`);
        load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Test failed.');
      }
    },
    [load],
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
      { key: 'displayName', header: 'Connection', render: (c) => c.displayName },
      { key: 'provider', header: 'Provider', render: (c) => <span className="chip">{c.provider}</span> },
      {
        key: 'sharing',
        header: 'Sharing',
        render: (c) => (
          <span className="action-bar">
            <span className="chip chip--muted">{c.orgId ? 'Organization' : 'Personal'}</span>
            {writeState(c).granted ? <span className="chip chip--muted">write</span> : null}
          </span>
        ),
      },
      { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
      {
        key: 'actions',
        header: '',
        render: (c) => {
          const prov = providersById.get(c.provider);
          return (
            <span className="action-bar">
              {writeState(c).offerable && prov ? (
                <button type="button" className="btn-ghost" onClick={() => void connectOAuth(prov.id, `${prov.label} write access`, { write: true })} aria-label={`Grant write access for ${c.displayName}`}>Grant write access</button>
              ) : null}
              <button type="button" className="btn-ghost" onClick={() => void test(c)} aria-label={`Test ${c.displayName}`}>Test</button>
              <button type="button" className="btn-ghost" onClick={() => void revoke(c.connectionId)} aria-label={`Revoke ${c.displayName}`}>Revoke</button>
            </span>
          );
        },
      },
    ],
    [revoke, test, connectOAuth, providersById, writeState],
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
            <span className="u-label-sm">Connect with consent</span>
            <p className="muted">
              You'll be sent to the provider to approve read access, then returned here. Your tokens are stored
              encrypted and are never shown back to you.
            </p>
          </div>
          <div className="action-bar">
            {oauthProviders.map((p) => (
              <button
                key={p.id}
                type="button"
                className="btn-ghost"
                disabled={!p.oauthConfigured || connecting !== null}
                onClick={() => void connectOAuth(p.id, `${p.label} connect`)}
                aria-label={`Connect ${p.label}`}
                title={p.oauthConfigured ? undefined : `${p.label} OAuth is not configured on this host`}
              >
                {connecting === p.id ? `Connecting ${p.label}…` : `Connect ${p.label}`}
              </button>
            ))}
          </div>
          {oauthProviders.some((p) => !p.oauthConfigured) ? (
            <p className="muted">
              Greyed-out providers aren't configured for OAuth on this host yet — the operator must add the client
              credentials.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="surface-card u-p-4 surface-form">
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">Provider (API key / token)</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={loadingProviders}>
            {loadingProviders
              ? <option value={provider}>Loading providers…</option>
              : secretProviders.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
          </select>
        </label>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">API key / token</span>
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="paste your token" autoComplete="off" />
        </label>
        {canManageOrg ? (
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">Shared with</span>
            <select value={shareScope} onChange={(e) => setShareScope(e.target.value as 'user' | 'org')}>
              <option value="user">Just me</option>
              <option value="org">Organization</option>
            </select>
          </label>
        ) : null}
        <button type="button" className="btn-primary" disabled={busy || loadingProviders || !secret.trim()} onClick={() => void connect()}>
          Connect
        </button>
      </div>

      <DataTable
        rows={rows ?? []}
        rowKey={(c) => c.connectionId}
        columns={columns}
        caption="Your connections"
        empty={
          rows === null
            ? <SkeletonRows rows={2} columns={[200, 110, 110, 110, 140]} />
            : <StateCard icon={<PlugIcon />} title="No connections yet" body="Connect an app above to let your assistant read from it." />
        }
      />
    </div>
  );
}
