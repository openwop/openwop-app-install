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
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { StatusBadge } from '../../ui/StatusBadge.js';
import { toast } from '../../ui/toast.js';
import { PlugIcon } from '../../ui/icons/index.js';
import { Notice } from '../../ui/Notice.js';
import { useScopeWriteAccess, writeErrorMessage } from '../../lib/writeAccess.js';
import { classifyHttpError } from '../../client/classifyHttpError.js';
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
import { DataSourceDialog } from './DataSourceDialog.js';

/** Which axis a row is shared on (ADR 0780): a USER row is the caller's own; an
 *  ORG row is shared by grant; a row with neither is the WORKSPACE default. The
 *  last used to be labelled "Personal" because only `orgId` was read. */
type Axis = 'personal' | 'org' | 'workspace';
const axisOf = (c: Connection): Axis => (c.userId ? 'personal' : c.orgId ? 'org' : 'workspace');

/** Group the connector catalog by commercial vendor ("Microsoft 365", "Google", …)
 *  so a company connects by the vendors it does business with. A provider with no
 *  declared vendor falls back to its own label (a one-connector group), so nothing
 *  is hidden. Vendors sort alphabetically; providers keep the API's label order. */
function groupByVendor(list: Provider[]): { vendor: string; items: Provider[] }[] {
  const groups = new Map<string, Provider[]>();
  for (const p of list) {
    const key = p.vendor ?? p.label;
    const bucket = groups.get(key);
    if (bucket) bucket.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.entries()]
    .map(([vendor, items]) => ({ vendor, items }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor));
}

export function ConnectionsManager({ returnPath = '/connections' }: { returnPath?: string } = {}): JSX.Element {
  const { t } = useTranslation('connections');
  // Inside the Access Hub (ADR 0144) the Workspace·Personal pill scopes the view:
  // Personal shows the caller's own connections, Workspace the org-shared ones.
  // Outside the hub (`embedded:false`) nothing is filtered — the standalone page
  // and the profile tab show every connection exactly as before.
  const { embedded, scope } = useHub();
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [rows, setRows] = useState<Connection[] | null>(null);
  const [providersFailed, setProvidersFailed] = useState(false);
  const [rowsFailed, setRowsFailed] = useState(false);
  const [provider, setProvider] = useState('servicenow');
  const [secret, setSecret] = useState('');
  // ADR 0201 — the SMTP connection is a multi-field form (host/port/user/pass/
  // secure) packaged into ONE sealed secret blob; the rest of the providers post
  // a single secret string.
  const [smtp, setSmtp] = useState({ host: '', port: '587', user: '', pass: '', secure: false });
  const [shareScope, setShareScope] = useState<'user' | 'org'>('user');
  const [canManageOrg, setCanManageOrg] = useState(false);
  const [scopeUnknown, setScopeUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  // ADR 0780 D1 — binding a credential needs `workspace:write`; a Viewer is not
  // offered the connect controls (fail-open while access is unknown). Revoking
  // and testing one's OWN row stay open to every role, as on the server.
  const canWrite = useScopeWriteAccess('workspace:write');
  // The row whose Test/Revoke is in flight — its buttons are disabled meanwhile.
  const [pending, setPending] = useState<string | null>(null);
  // ADR 0783 D1 — the row whose data-source dialog is open.
  const [sourceFor, setSourceFor] = useState<Connection | null>(null);
  const captionRef = useRef<HTMLTableCaptionElement>(null);
  // An always-rendered landing spot for focus after a row goes away: when the
  // revoked row was the last (or the only search match) the table is replaced
  // by a state card and the caption above no longer exists (grade-ux `CONNUX-6`).
  const listHeadingRef = useRef<HTMLHeadingElement>(null);

  const loadProviders = useCallback(() => {
    setProviders(null);
    setProvidersFailed(false);
    void listProviders()
      .then((value) => { setProviders(value); setProvidersFailed(false); })
      .catch(() => setProvidersFailed(true));
  }, []);
  const loadRows = useCallback(() => {
    setRows(null);
    setRowsFailed(false);
    void listConnections()
      .then((value) => { setRows(value); setRowsFailed(false); })
      .catch(() => setRowsFailed(true));
  }, []);
  // After a row action: re-read WITHOUT blanking the table, so the button that
  // had focus (and the one the confirm dialog restores focus to) is not
  // unmounted into a skeleton (grade-ux `CONNUX-6`).
  const refreshRows = useCallback(async () => {
    try {
      setRows(await listConnections());
      setRowsFailed(false);
    } catch {
      setRowsFailed(true);
    }
  }, []);
  const load = useCallback(() => {
    // FP-4: settle each resource independently — a providers failure must not
    // also blank out the (separately-fetched) connections list, and vice versa.
    loadProviders();
    loadRows();
    // Only offer org-shared creation to a caller who can actually complete it
    // (host:connections:manage) — don't surface an action that would 403.
    // Fail-CLOSED on a failed scope read is the right security posture and is
    // kept — but it must not be SILENT. Without the scope the org-share control
    // disappears AND the default share scope narrows from 'org' to 'user', so an
    // admin who does hold the scope would quietly create a user-scoped connection
    // believing it was shared. `scopeUnknown` only adds the explanation.
    void getEffectiveAccess()
      .then((a) => { setCanManageOrg(a.scopes.includes('host:connections:manage')); setScopeUnknown(false); })
      .catch(() => { setCanManageOrg(false); setScopeUnknown(true); });
  }, [loadProviders, loadRows]);

  useEffect(() => {
    load();
  }, [load]);

  // When embedded, the scope pill — not the in-form selector — decides sharing:
  // Personal ⇒ a user connection; Workspace ⇒ org-shared (only if the caller can
  // manage org connections, else fall back to a user connection).
  useEffect(() => {
    if (embedded) setShareScope(scope === 'workspace' && canManageOrg ? 'org' : 'user');
  }, [embedded, scope, canManageOrg]);

  // Scope-filter the table only inside the hub: Personal shows the caller's own
  // rows, Workspace the shared ones (org AND workspace-default). Outside the hub,
  // show everything (no behavior change).
  const displayRows = useMemo(() => {
    if (!embedded || rows === null) return rows;
    return rows.filter((c) => (scope === 'personal' ? axisOf(c) === 'personal' : axisOf(c) !== 'personal'));
  }, [embedded, scope, rows]);

  // §4.5 collection kit — gated search over the connections table (name or the
  // provider's display name). Feeds a separate memo over the unfiltered rows.
  const [query, setQuery] = useState('');

  const selected = useMemo(() => providers?.find((p) => p.id === provider) ?? null, [providers, provider]);
  const isSmtp = selected?.id === 'smtp';
  const smtpValid = Boolean(smtp.host.trim() && smtp.user.trim() && smtp.pass && Number(smtp.port) > 0);

  /** A failed write, said plainly: a refusal is the caller's missing authority
   *  (`common:error_forbidden`), a 409 means the connection changed elsewhere,
   *  anything else keeps the action's own localized copy (never raw server text). */
  const failure = useCallback((err: unknown, fallback: string): string => {
    if (classifyHttpError(err).kind === 'forbidden') {
      // A provider-allowlist refusal is a POLICY, not the caller's role — telling
      // an admin "you don't have permission" would point at the wrong fix.
      const details = (err as { body?: { details?: { provider?: unknown } } } | null)?.body?.details;
      if (typeof details?.provider === 'string') return t('providerNotAllowed');
      return writeErrorMessage(t, err);
    }
    if ((err as { status?: unknown } | null)?.status === 409) return t('changedElsewhere');
    return fallback;
  }, [t]);

  const connect = useCallback(async () => {
    if (!selected) return;
    if (isSmtp ? !smtpValid : !secret.trim()) return;
    setBusy(true);
    try {
      if (isSmtp) {
        // Package the dial target + auth into ONE sealed secret; the host also
        // becomes the connection's display name.
        const blob = JSON.stringify({ host: smtp.host.trim(), port: Number(smtp.port), secure: smtp.secure, user: smtp.user.trim(), pass: smtp.pass });
        await createConnection({ provider: 'smtp', kind: 'basic', secret: blob, scope: shareScope, displayName: smtp.host.trim() });
        setSmtp({ host: '', port: '587', user: '', pass: '', secure: false });
      } else {
        const kind = selected.kind === 'bearer' ? 'bearer' : 'api_key';
        await createConnection({ provider, kind, secret: secret.trim(), scope: shareScope });
        setSecret('');
      }
      // Re-read the rows only: `load()` also re-fetched providers, which disabled
      // the focused Connect button mid-flight and dropped focus to <body>.
      await refreshRows();
      toast.success(
        shareScope === 'org'
          ? t('connectedForOrg', { label: selected.label })
          : t('connected', { label: selected.label }),
      );
    } catch (err) {
      toast.error(failure(err, t('connectFailed')));
    } finally {
      setBusy(false);
    }
  }, [selected, isSmtp, smtpValid, smtp, provider, secret, shareScope, refreshRows, t, failure]);

  const connectOAuth = useCallback(async (providerId: string, label: string, opts: { write?: boolean } = {}) => {
    setConnecting(providerId);
    try {
      // Hand off to the provider's consent screen; the callback returns to the
      // surface that started the flow (the page, or the profile's Connections tab).
      const authorizeUrl = await beginOAuth(providerId, returnPath, opts);
      window.location.assign(authorizeUrl);
    } catch (err) {
      toast.error(failure(err, t('couldNotStart', { label })));
      setConnecting(null);
    }
  }, [returnPath, t, failure]);

  const revoke = useCallback(
    async (c: Connection) => {
      if (!(await confirm({ title: t('revokeConfirm'), danger: true, confirmLabel: t('revokeConfirmLabel') }))) return;
      setPending(c.connectionId);
      try {
        await revokeConnection(c.connectionId);
        await refreshRows();
        toast.success(t('revoked', { name: c.displayName }));
        // The row (and its focused button) is gone: land focus on the table, or on
        // the list heading when the table itself was replaced by a state card.
        (captionRef.current ?? listHeadingRef.current)?.focus();
      } catch (err) {
        toast.error(failure(err, t('revokeFailed')));
      } finally {
        setPending(null);
      }
    },
    [refreshRows, failure, t],
  );

  const test = useCallback(
    async (c: Connection) => {
      setPending(c.connectionId);
      try {
        const { ok } = await testConnection(c.connectionId);
        if (ok) toast.success(t('connectionHealthy', { name: c.displayName }));
        else toast.error(t('connectionNeedsReconnect', { name: c.displayName }));
        await refreshRows();
      } catch (err) {
        toast.error(failure(err, t('testFailed')));
      } finally {
        setPending(null);
      }
    },
    [refreshRows, failure, t],
  );

  /** May the caller manage this row? Their own always; a shared (org or
   *  workspace) row only with `host:connections:manage` — the server refuses the
   *  rest, so the buttons are not offered. */
  const canManageRow = useCallback((c: Connection) => axisOf(c) === 'personal' || canManageOrg, [canManageOrg]);

  const providersById = useMemo(() => new Map((providers ?? []).map((p) => [p.id, p])), [providers]);
  const providerLabel = useCallback((c: Connection) => providersById.get(c.provider)?.label ?? c.provider, [providersById]);

  const visibleRows = useMemo(() => {
    const base = displayRows ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((c) => c.displayName.toLowerCase().includes(q) || providerLabel(c).toLowerCase().includes(q));
  }, [displayRows, query, providerLabel]);

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
      {
        key: 'displayName',
        header: t('colConnection'),
        render: (c) => (
          <span className="u-grid">
            <span>{c.displayName}</span>
            {c.externalSubject ? <span className="u-label-sm muted">{t('accountLine', { account: c.externalSubject })}</span> : null}
            {c.dataSource ? <span className="u-label-sm muted">{t('dataSourceLine', { url: c.dataSource.baseUrl })}</span> : null}
          </span>
        ),
      },
      { key: 'provider', header: t('colProvider'), render: (c) => <span className="chip">{providerLabel(c)}</span> },
      {
        key: 'sharing',
        header: t('colSharing'),
        render: (c) => (
          <span className="action-bar">
            <span className="chip chip--muted">{axisOf(c) === 'org' ? t('sharingOrganization') : axisOf(c) === 'workspace' ? t('sharingWorkspace') : t('sharingPersonal')}</span>
            {writeState(c).granted ? <span className="chip chip--muted">{t('sharingWrite')}</span> : null}
          </span>
        ),
      },
      { key: 'status', header: t('colStatus'), render: (c) => <StatusBadge status={c.status} label={t(`status_${c.status}`, { defaultValue: c.status })} /> },
      {
        key: 'actions',
        header: '',
        render: (c) => {
          const prov = providersById.get(c.provider);
          if (!canManageRow(c)) return <span className="chip chip--muted">{t('managedByAdmin')}</span>;
          const own = axisOf(c) === 'personal';
          const needsReconnect = c.kind === 'oauth2' && (c.status === 'needs-reconsent' || c.status === 'expired');
          const busyRow = pending === c.connectionId;
          return (
            <span className="action-bar">
              {own && canWrite && needsReconnect && prov?.oauthConfigured ? (
                <Button variant="primary" disabled={busyRow || connecting !== null} onClick={() => void connectOAuth(prov.id, t('connectProviderConnect', { label: prov.label }))} aria-label={t('reconnectLabel', { name: c.displayName })}>{t('reconnect')}</Button>
              ) : null}
              {own && canWrite && writeState(c).offerable && prov ? (
                <Button variant="quiet" disabled={busyRow} onClick={() => void connectOAuth(prov.id, t('grantWriteAccessConnect', { label: prov.label }), { write: true })} aria-label={t('grantWriteAccessLabel', { name: c.displayName })}>{t('grantWriteAccess')}</Button>
              ) : null}
              {/* aria-disabled, never native `disabled`: the focused button would lose
                  focus to <body> the moment it disabled (grade-ux `CONNUX-6`, WCAG 2.4.3). */}
              {/* ADR 0783 D1 — a data source is a WORKSPACE write (the server also
                  requires one), so it is offered only to a writer on an active row. */}
              {canWrite && c.status === 'active' ? (
                <Button variant="quiet" aria-disabled={busyRow || undefined} onClick={() => { if (!busyRow) setSourceFor(c); }} aria-label={t('dataSourceLabel', { name: c.displayName })}>{t('dataSourceAction')}</Button>
              ) : null}
              <Button variant="quiet" aria-disabled={busyRow || undefined} onClick={() => { if (!busyRow) void test(c); }} aria-label={t('testConnectionLabel', { name: c.displayName })}>{t('test')}</Button>
              <Button variant="quiet" aria-disabled={busyRow || undefined} onClick={() => { if (!busyRow) void revoke(c); }} aria-label={t('revokeConnectionLabel', { name: c.displayName })}>{t('revoke')}</Button>
            </span>
          );
        },
      },
    ],
    [revoke, test, connectOAuth, providersById, providerLabel, writeState, canManageRow, canWrite, pending, connecting, t],
  );

  // Providers that connect via a posted secret (api_key/bearer) vs. those that
  // connect via the OAuth consent flow (oauth2). `providers === null` until the
  // first load resolves — the form is loading-aware so the <select> never flashes
  // empty (the surface paints progressively, no full-page skeleton).
  const loadingProviders = providers === null && !providersFailed;
  // api_key/bearer post a single secret; SMTP (basic) posts a sealed multi-field
  // blob — both live in this same "connect via a posted secret" form (ADR 0201).
  const secretProviders = (providers ?? []).filter((p) => p.kind === 'api_key' || p.kind === 'bearer' || p.id === 'smtp');
  const oauthProviders = (providers ?? []).filter((p) => p.kind === 'oauth2');

  return (
    <div className="u-grid u-gap-4">
      {providersFailed ? (
        <StateCard announce icon={<PlugIcon />} title={t('providersLoadFailedTitle')} body={t('providersLoadFailedBody')}
          action={<Button variant="secondary" onClick={loadProviders}>{t('common:retry')}</Button>} />
      ) : null}

      {!canWrite ? <Notice variant="info">{t('readOnlyNotice')}</Notice> : null}

      {canWrite && oauthProviders.length > 0 ? (
        <div className="surface-card u-p-4 u-grid u-gap-3">
          <div className="u-grid u-gap-1">
            <span className="u-label-sm">{t('connectWithConsent')}</span>
            <p className="muted">{t('consentBlurb')}</p>
          </div>
          <div className="u-grid u-gap-3">
            {groupByVendor(oauthProviders).map(({ vendor, items }) => (
              <div key={vendor} className="u-grid u-gap-1" role="group" aria-label={vendor}>
                <span className="u-label-sm muted">{vendor}</span>
                <div className="action-bar">
                  {items.map((p) => (
                    <Button
                      key={p.id}
                      variant="quiet"
                      disabled={!p.oauthConfigured || connecting !== null}
                      onClick={() => void connectOAuth(p.id, t('connectProviderConnect', { label: p.label }))}
                      aria-label={t('connectProvider', { label: p.label })}
                      title={p.oauthConfigured ? undefined : t('oauthNotConfiguredTitle', { label: p.label })}
                    >
                      {connecting === p.id ? t('connectingProvider', { label: p.label }) : t('connectProvider', { label: p.label })}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {oauthProviders.some((p) => !p.oauthConfigured) ? (
            <p className="muted">{t('notConfiguredHint')}</p>
          ) : null}
        </div>
      ) : null}

      {canWrite && !providersFailed ? <div className="surface-card u-p-4 surface-form">
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('providerLabel')}</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={loadingProviders}>
            {loadingProviders
              ? <option value={provider}>{t('loadingProviders')}</option>
              : groupByVendor(secretProviders).map(({ vendor, items }) => (
                <optgroup key={vendor} label={vendor}>
                  {items.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </optgroup>
              ))}
          </select>
        </label>
        {isSmtp ? (
          <>
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('smtpHost')}</span>
              <input type="text" value={smtp.host} onChange={(e) => setSmtp((s) => ({ ...s, host: e.target.value }))} placeholder={t('smtpHostPlaceholder')} autoComplete="off" />
            </label>
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('smtpPort')}</span>
              <input type="number" inputMode="numeric" value={smtp.port} onChange={(e) => setSmtp((s) => ({ ...s, port: e.target.value }))} placeholder="587" autoComplete="off" />
            </label>
            <label className="u-flex u-items-center u-gap-2">
              <input type="checkbox" checked={smtp.secure} onChange={(e) => setSmtp((s) => ({ ...s, secure: e.target.checked }))} />
              <span className="u-label-sm">{t('smtpSecure')}</span>
            </label>
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('smtpUser')}</span>
              <input type="text" value={smtp.user} onChange={(e) => setSmtp((s) => ({ ...s, user: e.target.value }))} placeholder={t('smtpUserPlaceholder')} autoComplete="off" />
            </label>
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('smtpPass')}</span>
              <input type="password" value={smtp.pass} onChange={(e) => setSmtp((s) => ({ ...s, pass: e.target.value }))} placeholder={t('smtpPassPlaceholder')} autoComplete="off" />
            </label>
          </>
        ) : (
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('secretLabel')}</span>
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={t('secretPlaceholder')} autoComplete="off" />
          </label>
        )}
        {scopeUnknown && !embedded ? (
          <p className="u-label-sm muted u-m-0">{t('shareScopeUnknown')}</p>
        ) : null}
        {canManageOrg && !embedded ? (
          <label className="u-grid u-gap-1">
            <span className="u-label-sm">{t('sharedWith')}</span>
            <select value={shareScope} onChange={(e) => setShareScope(e.target.value as 'user' | 'org')}>
              <option value="user">{t('shareJustMe')}</option>
              <option value="org">{t('shareOrganization')}</option>
            </select>
          </label>
        ) : null}
        <Button variant="primary" disabled={busy || loadingProviders || (isSmtp ? !smtpValid : !secret.trim())} onClick={() => void connect()}>
          {t('connect')}
        </Button>
      </div> : null}

      <h2 ref={listHeadingRef} tabIndex={-1} className="sr-only">{t('tableCaption')}</h2>
      {(displayRows?.length ?? 0) > 3 ? (
        <div className="filterbar" role="group" aria-label={t('filterGroup')}>
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('filterPlaceholder')}
            aria-label={t('filterAria')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
      {rowsFailed ? (
        <StateCard announce icon={<PlugIcon />} title={t('connectionsLoadFailedTitle')} body={t('connectionsLoadFailedBody')}
          action={<Button variant="secondary" onClick={loadRows}>{t('common:retry')}</Button>} />
      ) : displayRows !== null && displayRows.length > 0 && visibleRows.length === 0 ? (
        <StateCard icon={<PlugIcon />} title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" onClick={() => setQuery('')}>{t('clearFilters')}</Button>} />
      ) : (
        <DataTable
          rows={visibleRows}
          rowKey={(c) => c.connectionId}
          columns={columns}
          caption={t('tableCaption')}
          captionRef={captionRef}
          empty={
            rows === null
              ? <SkeletonRows rows={2} columns={[200, 110, 110, 110, 140]} />
              : <StateCard icon={<PlugIcon />} title={t('noConnectionsTitle')} body={canWrite ? t('noConnectionsBody') : t('noConnectionsBodyReadOnly')} />
          }
        />
      )}
      {sourceFor ? (
        <DataSourceDialog
          connection={sourceFor}
          onClose={() => setSourceFor(null)}
          onSaved={(message) => { setSourceFor(null); toast.success(message); void refreshRows(); }}
        />
      ) : null}
    </div>
  );
}
