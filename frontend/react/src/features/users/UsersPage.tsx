/**
 * Users & Authentication page (host-extension product feature — ADR 0002).
 *
 * Gates on useFeatureAccess('users'): while the feature is off the nav entry is
 * hidden (Sidebar) and this page shows a disabled state (defense-in-depth — the
 * backend also 404s). When on, it shows the caller's own durable record (the
 * reconciliation seam, GET /me), the tenant's users, an add form, and per-user
 * disable/enable/delete lifecycle actions.
 *
 * Captured IdP `groups` are shown read-only — mapping them to roles is ADR 0006
 * (RBAC), deliberately NOT a control on this page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { createUser, deleteUser, getMe, listUsers, setUserEnabled, signupLocal, type User } from './usersClient.js';

export function UsersPage(): JSX.Element {
  const users = useFeatureAccess('users');
  const [rows, setRows] = useState<User[] | null>(null);
  const [me, setMe] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [principalId, setPrincipalId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupBusy, setSignupBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    void getMe()
      .then(setMe)
      .catch(() => setMe(null));
    void listUsers()
      .then(setRows)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load users.'));
  }, []);

  useEffect(() => {
    if (users.enabled) load();
  }, [users.enabled, load]);

  const add = useCallback(async () => {
    if (!principalId.trim()) return;
    setBusy(true);
    try {
      await createUser({ principalId: principalId.trim(), ...(displayName.trim() ? { displayName: displayName.trim() } : {}) });
      setPrincipalId('');
      setDisplayName('');
      load();
      toast.success('User added.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Add failed.');
    } finally {
      setBusy(false);
    }
  }, [principalId, displayName, load]);

  const signup = useCallback(async () => {
    if (!signupEmail.trim() || signupPassword.length < 8) return;
    setSignupBusy(true);
    try {
      await signupLocal({ email: signupEmail.trim(), password: signupPassword });
      setSignupEmail('');
      setSignupPassword('');
      load();
      toast.success('Local account created.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Signup failed.');
    } finally {
      setSignupBusy(false);
    }
  }, [signupEmail, signupPassword, load]);

  const toggleEnabled = useCallback(async (u: User) => {
    try {
      await setUserEnabled(u.userId, u.status !== 'active');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed.');
    }
  }, [load]);

  const remove = useCallback(async (id: string) => {
    try {
      await deleteUser(id);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed.');
    }
  }, [load]);

  const columns = useMemo<DataColumn<User>[]>(() => [
    { key: 'principal', header: 'Principal', render: (u) => u.displayName ?? u.principalId },
    { key: 'email', header: 'Email', cellClass: 'muted', render: (u) => u.email ?? '—' },
    { key: 'source', header: 'Source', render: (u) => <span className="chip">{u.source}</span> },
    { key: 'groups', header: 'Groups', cellClass: 'muted', render: (u) => (u.groups.length ? u.groups.join(', ') : '—') },
    { key: 'status', header: 'Status', render: (u) => <span className="chip">{u.status}</span> },
    {
      key: 'actions',
      header: '',
      render: (u) => (
        <span className="action-bar">
          <button type="button" className="btn-ghost" onClick={() => void toggleEnabled(u)}>
            {u.status === 'active' ? 'Disable' : 'Enable'}
          </button>
          <button type="button" className="btn-ghost" onClick={() => void remove(u.userId)} aria-label={`Delete ${u.displayName ?? u.principalId}`}>Delete</button>
        </span>
      ),
    },
  ], [toggleEnabled, remove]);

  if (users.loading) return <Skeleton />;
  if (!users.enabled) {
    return (
      <section className="u-grid u-gap-4">
        <PageHeader eyebrow="Platform" title="Users & Authentication" />
        <StateCard title="Users is not enabled" body="Ask an administrator to turn on the Users feature in Admin → Feature toggles." />
      </section>
    );
  }

  return (
    <section className="u-grid u-gap-4">
      <PageHeader eyebrow="Platform" title="Users & Authentication" lede="Durable accounts behind the authenticated principal — the identity foundation (ADR 0002)." />
      {error ? <Notice variant="error">{error}</Notice> : null}
      {me ? (
        <Notice variant="info">
          Signed in as <strong>{me.displayName ?? me.principalId}</strong> (source: {me.source}; status: {me.status}).
        </Notice>
      ) : null}

      <div className="surface-card u-p-4 surface-form">
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">Principal id</span>
          <input value={principalId} onChange={(e) => setPrincipalId(e.target.value)} placeholder="oidc:sub-123" />
        </label>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">Display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Jane Doe" />
        </label>
        <button type="button" className="btn-primary" disabled={busy || !principalId.trim()} onClick={() => void add()}>
          Add user
        </button>
      </div>

      <div className="surface-card u-p-4 surface-form">
        <span className="users-section-hint">Create a local account (email + password)</span>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">Email</span>
          <input type="email" value={signupEmail} onChange={(e) => setSignupEmail(e.target.value)} placeholder="jane@acme.test" />
        </label>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">Password (min 8)</span>
          <input type="password" value={signupPassword} onChange={(e) => setSignupPassword(e.target.value)} placeholder="••••••••" />
        </label>
        <button type="button" className="btn-primary" disabled={signupBusy || !signupEmail.trim() || signupPassword.length < 8} onClick={() => void signup()}>
          Create account
        </button>
      </div>

      <DataTable
        rows={rows ?? []}
        rowKey={(u) => u.userId}
        columns={columns}
        caption="Users"
        empty={
          rows === null
            ? <SkeletonRows rows={3} columns={[180, 160, 90, 120, 90, 120]} />
            : <p className="muted">No users yet — add one above, or sign in to create your record.</p>
        }
      />
    </section>
  );
}
