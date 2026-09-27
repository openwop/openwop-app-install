/**
 * Users & Authentication page (host-extension product feature — ADR 0002).
 *
 * Graduated off the feature toggle on 2026-06-11 (feature.ts § Correction):
 * a permanent admin surface rendered unconditionally. Shows the caller's own
 * durable record (the reconciliation seam, GET /me), the tenant's users, an
 * add form, and per-user disable/enable/delete lifecycle actions.
 *
 * Collection chrome follows the §4.5 canon: one `.filterbar` row (search +
 * status/source facets, rule 13), Grid alongside the table via the shared
 * `<ViewToggle>` (rule 11 — DataTable operate-surface posture, the Keys/Library
 * precedent), localized `status_*`/`source_*` chips, and a designed zero-match
 * state with a clear-filters action.
 *
 * Captured IdP `groups` are shown read-only — mapping them to roles is ADR 0006
 * (RBAC), deliberately NOT a control on this page.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { UserIcon } from '../../ui/icons/index.js';
import { StateCard } from '../../ui/StateCard.js';
import { Trans, useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';

import { confirm } from '../../ui/confirm.js';
import { Notice } from '../../ui/Notice.js';
import { TextField } from '../../ui/Field.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { toast } from '../../ui/toast.js';
import {
  createUser,
  deleteUser,
  getMe,
  listUsers,
  revokeUserSessions,
  setUserEnabled,
  UsersApiError,
  type User,
  type UserSource,
  type UserStatus,
} from './usersClient.js';
import { SsoPanel } from './SsoPanel.js';

const userLabel = (u: User): string => u.displayName ?? u.principalId;

/** A refusal the page renders as a DESIGNED notice rather than a toast:
 *  the server's `self_lockout` (ADR 0621 D7) and `legal_hold` (CONS-4) 409s. */
interface PageRefusal { variant: 'warning' | 'error'; text: string }

const codeOf = (err: unknown): string | undefined => (err instanceof UsersApiError ? err.code : undefined);

export function UsersPage(): JSX.Element {
  const { t } = useTranslation('users');
  const [rows, setRows] = useState<User[] | null>(null);
  // USERS-UX-2 — the list read FAILED (distinct from `rows === null`, still
  // loading): a failed load must render an honest failed state with a retry,
  // never a permanent skeleton (the meFailed precedent, one state over).
  const [listFailed, setListFailed] = useState(false);
  const [me, setMe] = useState<User | null>(null);
  const [meFailed, setMeFailed] = useState(false);
  const [principalId, setPrincipalId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  // USERS-UX-16 — inline field error for the known add-user failure classes.
  const [addError, setAddError] = useState<string | null>(null);
  // USERS-UX-14/15 — a designed, localized refusal (never raw server English).
  const [refusal, setRefusal] = useState<PageRefusal | null>(null);
  // Collection-kit state (rule 13) + the grid⇄table view (rule 11).
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | UserStatus>('');
  const [sourceFilter, setSourceFilter] = useState<'' | UserSource>('');
  const [viewMode, setViewMode] = useViewMode('users', 'list');

  const load = useCallback(() => {
    setListFailed(false);
    void getMe()
      .then((u) => { setMe(u); setMeFailed(false); })
      .catch(() => { setMe(null); setMeFailed(true); });
    void listUsers()
      .then((users) => { setRows(users); setListFailed(false); })
      // ONE failure surface: the announced failed StateCard (below) owns this —
      // a second role=alert Notice would double-render AND double-announce.
      .catch(() => setListFailed(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Localize a lifecycle failure by its CODE. The two 409 refusals become a
   *  page notice; everything else is a toast in the user's language. */
  const surfaceFailure = useCallback((err: unknown, fallbackKey: string): void => {
    const code = codeOf(err);
    if (code === 'self_lockout') {
      setRefusal({ variant: 'error', text: t('selfLockoutRefused') });
      return;
    }
    if (code === 'legal_hold') {
      setRefusal({ variant: 'warning', text: t('legalHoldRefused') });
      return;
    }
    toast.error(err instanceof UsersApiError ? loadErrorMessage(t, err) : t(fallbackKey));
  }, [t]);

  const add = useCallback(async () => {
    const id = principalId.trim();
    if (!id) { setAddError(t('addRequired')); return; }
    // The backend create is idempotent (one record per principal), so a
    // duplicate would silently return the EXISTING row as "added" — say so
    // before submitting instead.
    if (/\s/.test(id)) { setAddError(t('addInvalidPrincipal')); return; }
    if ((rows ?? []).some((u) => u.principalId === id)) { setAddError(t('addDuplicate')); return; }
    setBusy(true);
    setAddError(null);
    try {
      await createUser({ principalId: id, ...(displayName.trim() ? { displayName: displayName.trim() } : {}) });
      setPrincipalId('');
      setDisplayName('');
      load();
      toast.success(t('userAdded'));
    } catch (err) {
      if (codeOf(err) === 'validation_error') setAddError(t('addInvalidPrincipal'));
      else surfaceFailure(err, 'addFailed');
    } finally {
      setBusy(false);
    }
  }, [principalId, displayName, rows, load, surfaceFailure, t]);

  const toggleEnabled = useCallback(async (u: User) => {
    const enable = u.status !== 'active';
    const name = userLabel(u);
    // USERS-UX-12 / ADR 0621 D5 — Disable now ends every live session of the
    // user immediately, so it is confirm-gated with copy that says exactly
    // that. Enable is reversible-by-nature and needs no gate.
    if (!enable && !(await confirm({
      title: t('disableUserConfirm', { name }),
      body: t('disableUserBody'),
      danger: true,
      confirmLabel: t('disable'),
    }))) return;
    setRefusal(null);
    try {
      await setUserEnabled(u.userId, enable);
      load();
      toast.success(t(enable ? 'userEnabled' : 'userDisabled', { name }));
    } catch (err) {
      surfaceFailure(err, 'updateFailed');
    }
  }, [load, surfaceFailure, t]);

  const remove = useCallback(async (id: string, name: string) => {
    // USERS-UX-15 — the route runs the full subject erasure (profile, memory,
    // every stored record); the confirm names that blast radius (the
    // account-menu `deleteAccountBody` precedent), not just "cannot be undone".
    if (!(await confirm({ title: t('deleteUserConfirm', { name }), body: t('deleteUserBody', { name }), danger: true, confirmLabel: t('common:delete') }))) return;
    setRefusal(null);
    try {
      await deleteUser(id);
      load();
      toast.success(t('userDeleted', { name }));
    } catch (err) {
      surfaceFailure(err, 'deleteFailed');
    }
  }, [load, surfaceFailure, t]);

  // USERS-UX-11 / ADR 0621 D5 — admin "Sign out everywhere": ends every live
  // session of the user without touching their status.
  const revokeSessions = useCallback(async (u: User) => {
    const name = userLabel(u);
    if (!(await confirm({
      title: t('revokeUserConfirm', { name }),
      body: t('revokeUserBody'),
      danger: true,
      confirmLabel: t('signOutEverywhere'),
    }))) return;
    setRefusal(null);
    try {
      await revokeUserSessions(u.userId);
      toast.success(t('userSessionsRevoked', { name }));
    } catch (err) {
      surfaceFailure(err, 'revokeFailed');
    }
  }, [surfaceFailure, t]);

  // Facet options derive from the loaded rows (never offer an empty facet).
  const sources = useMemo(() => [...new Set((rows ?? []).map((u) => u.source))], [rows]);

  // View filters feed a SEPARATE memo (rule 12) — `rows` stays the unfiltered SoT.
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((u) =>
      (!q || (u.displayName ?? '').toLowerCase().includes(q) || u.principalId.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q))
      && (!statusFilter || u.status === statusFilter)
      && (!sourceFilter || u.source === sourceFilter));
  }, [rows, query, statusFilter, sourceFilter]);

  const clearFilters = useCallback(() => { setQuery(''); setStatusFilter(''); setSourceFilter(''); }, []);

  // Rule 6/11 — Card and Row derive from the SAME cell helpers so the two
  // views never diverge (localized chips: a raw enum in a chip is an i18n defect).
  const statusChip = useCallback((u: User): JSX.Element => (
    <span className={u.status === 'active' ? 'chip chip--success' : 'chip chip--muted'}>{t(`status_${u.status}`)}</span>
  ), [t]);
  const sourceChip = useCallback((u: User): JSX.Element => <span className="chip">{t(`source_${u.source}`)}</span>, [t]);
  const userActions = useCallback((u: User): JSX.Element => {
    // USERS-UX-14 / ADR 0621 D7 — the caller's OWN row carries none of the
    // lockout actions (disable / sign-out-everywhere / delete would evict the
    // admin mid-click); the server refuses them too (`409 self_lockout`).
    if (me && me.userId === u.userId) {
      return <span className="muted u-fs-12">{t('ownRowHint')}</span>;
    }
    return (
      <span className="action-bar">
        {/* USERS-UX-7 — a per-row accessible name (Delete's pattern): a screen
            reader tabbing the table otherwise hears an undifferentiated wall of
            "Disable" buttons with no target. */}
        <Button
          variant="quiet"
          onClick={() => void toggleEnabled(u)}
          aria-label={t(u.status === 'active' ? 'disableRowLabel' : 'enableRowLabel', { name: userLabel(u) })}
        >
          {u.status === 'active' ? t('disable') : t('enable')}
        </Button>
        {/* Rendered beside Disable because both ride the same server predicate
            (`host:members:manage`); a disabled row has no live session to end. */}
        {u.status === 'active' ? (
          <Button variant="quiet" onClick={() => void revokeSessions(u)} aria-label={t('revokeRowLabel', { name: userLabel(u) })}>
            {t('signOutEverywhere')}
          </Button>
        ) : null}
        <Button variant="quiet" onClick={() => void remove(u.userId, userLabel(u))} aria-label={t('deleteRowLabel', { name: userLabel(u) })}>{t('common:delete')}</Button>
      </span>
    );
  }, [me, toggleEnabled, revokeSessions, remove, t]);

  const columns = useMemo<DataColumn<User>[]>(() => [
    { key: 'principal', header: t('colPrincipal'), render: (u) => userLabel(u) },
    // USERS-UX-3: the prop is `cellClassName` — `cellClass` was silently dropped.
    { key: 'email', header: t('colEmail'), cellClassName: 'muted', render: (u) => u.email ?? '—' },
    { key: 'source', header: t('colSource'), render: (u) => sourceChip(u) },
    { key: 'groups', header: t('colGroups'), cellClassName: 'muted', render: (u) => (u.groups.length ? u.groups.join(', ') : '—') },
    { key: 'status', header: t('colStatus'), render: (u) => statusChip(u) },
    { key: 'actions', header: '', render: (u) => userActions(u) },
  ], [statusChip, sourceChip, userActions, t]);

  // One designed state for both views: skeleton → failed (USERS-UX-2, with a
  // retry — a failed read must never present as an eternal skeleton) →
  // true-empty → zero-match (with a clear-filters action, never a blank region).
  const emptyState = rows === null
    ? listFailed
      ? (
        <StateCard
          icon={<UserIcon size={20} />}
          title={t('loadUsersFailed')}
          announce
          action={<Button variant="secondary" onClick={load}>{t('common:retry')}</Button>}
        />
      )
      : <SkeletonRows rows={3} columns={[180, 160, 90, 120, 90, 120]} />
    : rows.length === 0
      ? <StateCard icon={<UserIcon size={20} />} title={t('noUsers')} />
      : (
        <StateCard
          icon={<UserIcon size={20} />}
          title={t('noMatchTitle')}
          body={t('noMatchBody')}
          action={<Button variant="secondary" onClick={clearFilters}>{t('clearFilters')}</Button>}
        />
      );

  return (
    <section data-walkthrough="users.page" className="u-grid u-gap-4">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {me ? (
        <Notice variant="info">
          <Trans
            t={t}
            i18nKey="signedInAs"
            values={{ name: userLabel(me), source: t(`source_${me.source}`), status: t(`status_${me.status}`) }}
            components={[<strong key="name" />]}
          />
        </Notice>
      ) : null}

      {meFailed ? <Notice variant="warning" announce={t('meFailed')}>{t('meFailed')}</Notice> : null}

      {refusal ? <Notice variant={refusal.variant} announce={refusal.text}>{refusal.text}</Notice> : null}

      {/* Enterprise SSO (SAML / SCIM) status + integration endpoints (RFC 0050).
          NOT gated on `me`: this is HOST capability configuration, not personal
          data. Gating it on the personal-record read meant a failed `getMe`
          removed the SSO panel from the security admin page entirely — an
          unrelated failure hiding the surface an admin came here to check. */}
      <SsoPanel />

      {/* USERS-UX-16 — the shared field primitive: label↔control association,
          `required`, `aria-invalid` + an inline `role=alert` error for the known
          failure classes (empty / malformed / duplicate principal). */}
      <form className="surface-card u-p-4 surface-form" noValidate onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <TextField
          label={t('fieldPrincipalId')}
          required
          value={principalId}
          onChange={(e) => { setPrincipalId(e.target.value); if (addError) setAddError(null); }}
          placeholder={t('principalIdPlaceholder')}
          help={t('principalIdHelp')}
          error={addError}
          autoComplete="off"
          spellCheck={false}
        />
        <TextField
          label={t('fieldDisplayName')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t('displayNamePlaceholder')}
          autoComplete="off"
        />
        <Button variant="primary" type="submit" loading={busy}>
          {t('addUser')}
        </Button>
      </form>

      {/* One filterbar row (rule 13) — gated on the UNFILTERED total so it can't
          vanish mid-search; the view toggle rides the same row (rule 11). */}
      {rows !== null && rows.length > 0 ? (
        <div className="filterbar" role="group" aria-label={t('filterGroup')}>
          {rows.length > 3 ? (
            <>
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterPlaceholder')}
                aria-label={t('filterAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select className="ui-input filterbar-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | UserStatus)} aria-label={t('filterStatusLabel')}>
                <option value="">{t('allStatuses')}</option>
                <option value="active">{t('status_active')}</option>
                <option value="disabled">{t('status_disabled')}</option>
              </select>
              {sources.length > 1 ? (
                <select className="ui-input filterbar-select" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as '' | UserSource)} aria-label={t('filterSourceLabel')}>
                  <option value="">{t('allSources')}</option>
                  {sources.map((s) => <option key={s} value={s}>{t(`source_${s}`)}</option>)}
                </select>
              ) : null}
            </>
          ) : null}
          <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" labels={{ list: t('viewTable') }} />
        </div>
      ) : null}

      {viewMode === 'grid' && rows !== null && rows.length > 0 ? (
        visibleRows.length === 0 ? emptyState : (
          <div className="card-grid">
            {visibleRows.map((u) => (
              <div key={u.userId} className="surface-card u-gap-2">
                <div className="u-flex u-items-center u-gap-2 u-wrap">
                  <strong className="u-fs-15">{userLabel(u)}</strong>
                  {statusChip(u)}
                </div>
                <span className="u-label-sm">{u.email ?? u.principalId}</span>
                <div className="u-flex u-items-center u-gap-2 u-wrap">
                  {sourceChip(u)}
                  {u.groups.length ? <span className="u-label-sm">{u.groups.join(', ')}</span> : null}
                </div>
                {userActions(u)}
              </div>
            ))}
          </div>
        )
      ) : (
        <DataTable
          rows={visibleRows}
          rowKey={(u) => u.userId}
          columns={columns}
          caption={t('captionUsers')}
          empty={emptyState}
          // USERS-UX-9 — stacked mobile reflow: every header is a plain string,
          // so each cell can carry its column label at ≤640px instead of
          // relying on horizontal scroll. (Type-compatible: not `selectable`.)
          stack
        />
      )}
    </section>
  );
}
