/**
 * Users & Authentication page (host-extension product feature — ADR 0002).
 *
 * Graduated off the feature toggle on 2026-06-11 (feature.ts § Correction):
 * a permanent admin surface rendered unconditionally. Shows the caller's own
 * durable record (the reconciliation seam, GET /me), the tenant's users, an
 * add form, and per-user disable/enable/delete lifecycle actions.
 *
 * Captured IdP `groups` are shown read-only — mapping them to roles is ADR 0006
 * (RBAC), deliberately NOT a control on this page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { toast } from '../../ui/toast.js';
import { createUser, deleteUser, getMe, listUsers, setUserEnabled, type User } from './usersClient.js';
import { SsoPanel } from './SsoPanel.js';

export function UsersPage(): JSX.Element {
  const { t } = useTranslation('users');
  const [rows, setRows] = useState<User[] | null>(null);
  const [me, setMe] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [principalId, setPrincipalId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    void getMe()
      .then(setMe)
      .catch(() => setMe(null));
    void listUsers()
      .then(setRows)
      .catch((err) => setError(err instanceof Error ? err.message : t('loadUsersFailed')));
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const add = useCallback(async () => {
    if (!principalId.trim()) return;
    setBusy(true);
    try {
      await createUser({ principalId: principalId.trim(), ...(displayName.trim() ? { displayName: displayName.trim() } : {}) });
      setPrincipalId('');
      setDisplayName('');
      load();
      toast.success(t('userAdded'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('addFailed'));
    } finally {
      setBusy(false);
    }
  }, [principalId, displayName, load, t]);

  const toggleEnabled = useCallback(async (u: User) => {
    try {
      await setUserEnabled(u.userId, u.status !== 'active');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('updateFailed'));
    }
  }, [load, t]);

  const remove = useCallback(async (id: string) => {
    try {
      await deleteUser(id);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('deleteFailed'));
    }
  }, [load, t]);

  const columns = useMemo<DataColumn<User>[]>(() => [
    { key: 'principal', header: t('colPrincipal'), render: (u) => u.displayName ?? u.principalId },
    { key: 'email', header: t('colEmail'), cellClass: 'muted', render: (u) => u.email ?? '—' },
    { key: 'source', header: t('colSource'), render: (u) => <span className="chip">{u.source}</span> },
    { key: 'groups', header: t('colGroups'), cellClass: 'muted', render: (u) => (u.groups.length ? u.groups.join(', ') : '—') },
    { key: 'status', header: t('colStatus'), render: (u) => <span className="chip">{u.status}</span> },
    {
      key: 'actions',
      header: '',
      render: (u) => (
        <span className="action-bar">
          <button type="button" className="btn-ghost" onClick={() => void toggleEnabled(u)}>
            {u.status === 'active' ? t('disable') : t('enable')}
          </button>
          <button type="button" className="btn-ghost" onClick={() => void remove(u.userId)} aria-label={t('deleteRowLabel', { name: u.displayName ?? u.principalId })}>{t('common:delete')}</button>
        </span>
      ),
    },
  ], [toggleEnabled, remove, t]);

  return (
    <section className="u-grid u-gap-4">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}
      {me ? (
        <Notice variant="info">
          <Trans
            t={t}
            i18nKey="signedInAs"
            values={{ name: me.displayName ?? me.principalId, source: me.source, status: me.status }}
            components={[<strong key="name" />]}
          />
        </Notice>
      ) : null}

      {/* Enterprise SSO (SAML / SCIM) status + integration endpoints (RFC 0050). */}
      {me ? <SsoPanel /> : null}

      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('fieldPrincipalId')}</span>
          <input value={principalId} onChange={(e) => setPrincipalId(e.target.value)} placeholder={t('principalIdPlaceholder')} />
        </label>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('fieldDisplayName')}</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t('displayNamePlaceholder')} />
        </label>
        <button type="submit" className="btn-primary" disabled={busy || !principalId.trim()}>
          {t('addUser')}
        </button>
      </form>

      <DataTable
        rows={rows ?? []}
        rowKey={(u) => u.userId}
        columns={columns}
        caption={t('captionUsers')}
        empty={
          rows === null
            ? <SkeletonRows rows={3} columns={[180, 160, 90, 120, 90, 120]} />
            : <p className="muted">{t('noUsers')}</p>
        }
      />
    </section>
  );
}
