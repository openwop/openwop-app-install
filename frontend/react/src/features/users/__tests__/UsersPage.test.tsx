/**
 * UsersPage — ADR 0621 D5/D7 row-action designed states (USERS-UX-11/12/14/15/16,
 * ADR 0833 D6 / USERS2-UX-1).
 *
 * Guards: the caller's own row carries no lockout actions; Disable / Sign out
 * everywhere / Delete are confirm-gated (the client is called ONLY after the
 * user confirms); the server's coded refusals (`self_lockout`, `owner_required`,
 * `legal_hold`, `validation_error`) render as designed, localized states — never
 * the raw server prose, never a generic toast.
 *
 * Observation seams: `confirm()` falls back to `window.confirm` because no
 * `ConfirmRoot` is mounted, so the gate is a spy. A `<Notice>`'s variant is
 * observed through the shared announcer — `error` announces ASSERTIVELY, every
 * other variant POLITELY (`ui/Notice.tsx`) — not through its CSS class. The
 * `<Toaster>` IS mounted, so a raw-message leak through the toast fallback is
 * visible to the absence assertions.
 *
 * Sabotage that turns it red (one per claim): drop the own-row guard; rename a
 * refusal code in `surfaceFailure`; flip a refusal's `variant`; bypass a
 * `confirm(...)`; drop the duplicate-principal precheck.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type * as UsersClient from '../usersClient.js';

const mocks = vi.hoisted(() => ({
  getMe: vi.fn<typeof UsersClient.getMe>(),
  listUsers: vi.fn<typeof UsersClient.listUsers>(),
  setUserEnabled: vi.fn<typeof UsersClient.setUserEnabled>(),
  deleteUser: vi.fn<typeof UsersClient.deleteUser>(),
  revokeUserSessions: vi.fn<typeof UsersClient.revokeUserSessions>(),
  createUser: vi.fn<typeof UsersClient.createUser>(),
}));

vi.mock('../usersClient.js', async (importActual) => {
  const actual = await importActual<typeof import('../usersClient.js')>();
  return { ...actual, ...mocks };
});
vi.mock('../SsoPanel.js', () => ({ SsoPanel: () => null }));

import { UsersPage } from '../UsersPage.js';
import { UsersApiError, type User } from '../usersClient.js';
import { currentAnnouncements } from '../../../ui/announce.js';
import { Toaster, dismiss, getToasts } from '../../../ui/toast.js';

const me: User = {
  userId: 'u-me', tenantId: 't1', principalId: 'oidc:me', email: 'me@example.com', displayName: 'Ada Admin',
  groups: [], source: 'oidc', status: 'active', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const other: User = { ...me, userId: 'u-bob', principalId: 'oidc:bob', email: 'bob@example.com', displayName: 'Bob Builder' };

beforeEach(() => {
  // Toasts are module state (an error toast persists until dismissed).
  for (const t of getToasts()) dismiss(t.id);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.getMe.mockResolvedValue(me);
  mocks.listUsers.mockResolvedValue([me, other]);
  mocks.setUserEnabled.mockResolvedValue(other);
  mocks.deleteUser.mockResolvedValue(undefined);
  mocks.revokeUserSessions.mockResolvedValue(undefined);
  mocks.createUser.mockResolvedValue(other);
});

async function renderPage(): Promise<void> {
  render(<><UsersPage /><Toaster /></>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Disable Bob Builder' })).toBeTruthy());
}

describe('UsersPage — own row (USERS-UX-14 / ADR 0621 D7)', () => {
  it('hides Disable / Sign out everywhere / Delete on the caller\'s own row, with help text', async () => {
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Disable Ada Admin' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign Ada Admin out everywhere' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Ada Admin' })).toBeNull();
    expect(screen.getByText(/Your own account — ask another admin/)).toBeTruthy();
    // …while the peer row keeps all three.
    expect(screen.getByRole('button', { name: 'Sign Bob Builder out everywhere' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete Bob Builder' })).toBeTruthy();
  });

  it('renders a server 409 self_lockout as a designed, announced error notice', async () => {
    mocks.setUserEnabled.mockRejectedValue(new UsersApiError('nope', 409, { error: 'self_lockout', message: 'nope' }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Disable Bob Builder' }));
    // `<Notice announce>` delegates to the shared announcer instead of carrying
    // its own live region (one region per message) — assert BOTH halves.
    // An ERROR notice announces assertively (the variant, observed as behavior).
    await screen.findByText(/your own account from here/);
    // The announcement comes from a passive effect that can flush after findBy sees the DOM; wait for it.
    await waitFor(() => expect(currentAnnouncements().assertive).toMatch(/your own account from here/));
    expect(screen.queryByText(/nope/)).toBeNull();
  });

  // ADR 0833 D6 / grade-ux USERS2-UX-1 — `owner_required` rides on a generic
  // `forbidden`; without the details read it fell to a toast telling an ADMIN
  // to "ask an admin".
  it('renders a server 403 owner_required as a designed, announced notice — not a generic toast', async () => {
    mocks.setUserEnabled.mockRejectedValue(new UsersApiError('nope', 403, { error: 'forbidden', message: 'nope', details: { code: 'owner_required' } }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Disable Bob Builder' }));
    await screen.findByText(/Only an owner of this workspace/);
    // A WARNING notice: announced politely, never on the assertive channel.
    await waitFor(() => expect(currentAnnouncements().polite).toMatch(/Only an owner of this workspace/));
    expect(currentAnnouncements().assertive).not.toMatch(/Only an owner of this workspace/);
    expect(screen.queryByText(/nope/)).toBeNull();
  });
});

describe('UsersPage — Disable is confirm-gated (USERS-UX-12)', () => {
  it('cancelling the confirm never calls the client', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Disable Bob Builder' }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0]?.[0]).toBe('Disable "Bob Builder"?');
    expect(mocks.setUserEnabled).not.toHaveBeenCalled();
  });

  it('confirming calls setUserEnabled(id, false) exactly once', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Disable Bob Builder' }));
    await waitFor(() => expect(mocks.setUserEnabled).toHaveBeenCalledWith('u-bob', false));
    expect(mocks.setUserEnabled).toHaveBeenCalledTimes(1);
  });

  it('Enable needs no confirm', async () => {
    mocks.listUsers.mockResolvedValue([me, { ...other, status: 'disabled' }]);
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<><UsersPage /><Toaster /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable Bob Builder' }));
    await waitFor(() => expect(mocks.setUserEnabled).toHaveBeenCalledWith('u-bob', true));
    expect(confirmSpy).not.toHaveBeenCalled();
    // A disabled user has no live session to end — no "sign out everywhere".
    expect(screen.queryByRole('button', { name: 'Sign Bob Builder out everywhere' })).toBeNull();
  });
});

describe('UsersPage — Sign out everywhere (USERS-UX-11)', () => {
  it('confirm-gated; calls the admin revoke route on confirm only', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await renderPage();
    const btn = screen.getByRole('button', { name: 'Sign Bob Builder out everywhere' });
    fireEvent.click(btn);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(mocks.revokeUserSessions).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await waitFor(() => expect(mocks.revokeUserSessions).toHaveBeenCalledWith('u-bob'));
  });
});

describe('UsersPage — Delete (USERS-UX-15)', () => {
  it('the confirm names the blast radius; a legal-hold 409 renders a localized warning notice', async () => {
    mocks.deleteUser.mockRejectedValue(new UsersApiError('This workspace is under legal hold (audit)', 409, { error: 'legal_hold', message: 'This workspace is under legal hold (audit)' }));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Bob Builder' }));
    await waitFor(() => expect(mocks.deleteUser).toHaveBeenCalledWith('u-bob'));
    expect(confirmSpy.mock.calls[0]?.[0]).toBe('Delete user "Bob Builder"?');
    await screen.findByText(/under legal hold, so user data cannot be erased/);
    // A WARNING notice: announced politely, never on the assertive channel.
    await waitFor(() => expect(currentAnnouncements().polite).toMatch(/under legal hold, so user data cannot be erased/));
    expect(currentAnnouncements().assertive).not.toMatch(/under legal hold, so user data cannot be erased/);
    // The raw server prose never reaches the page.
    expect(screen.queryByText(/legal hold \(audit\)/)).toBeNull();
  });
});

describe('UsersPage — add-user form (USERS-UX-16)', () => {
  it('a duplicate principal is refused inline (aria-invalid + role=alert) without calling the client', async () => {
    await renderPage();
    const input = screen.getByLabelText(/Principal id/);
    fireEvent.change(input, { target: { value: 'oidc:bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    const err = await screen.findByRole('alert');
    expect(err.textContent).toMatch(/already exists/);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it('a server validation_error lands on the field, localized', async () => {
    mocks.createUser.mockRejectedValue(new UsersApiError('Field `principalId` is required', 400, { error: 'validation_error', message: 'Field `principalId` is required', details: { field: 'principalId' } }));
    await renderPage();
    fireEvent.change(screen.getByLabelText(/Principal id/), { target: { value: 'oidc:new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    const err = await screen.findByRole('alert');
    expect(err.textContent).toMatch(/single token without spaces/);
    expect(err.textContent).not.toMatch(/Field `principalId`/);
  });
});
