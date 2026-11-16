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
 * Observation seams: `confirm()` falls back to `window.confirm(title)` where no
 * `ConfirmRoot` is mounted, so the gate is a spy. The Delete case mounts the real
 * `<ConfirmRoot>` instead, because its claim is the confirm's BODY (the blast
 * radius), which the `window.confirm` fallback drops. A cancelled confirm is checked
 * after a drain, so a handler that ignores the answer has time to call the client.
 * The announcer is module state, reset per case. A `<Notice>`'s variant is
 * observed through the shared announcer — `error` announces ASSERTIVELY, every
 * other variant POLITELY (`ui/Notice.tsx`) — not through its CSS class. The
 * `<Toaster>` IS mounted, so a raw-message leak through the toast fallback is
 * visible to the absence assertions.
 *
 * Sabotage that turns it red (one per claim): drop the own-row guard; rename a
 * refusal code in `surfaceFailure`; flip a refusal's `variant`; ignore a
 * `confirm(...)` answer; drop the Delete confirm's body; drop the duplicate-principal
 * precheck or the server `validation_error` mapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { announce, currentAnnouncements } from '../../../ui/announce.js';
import { Toaster, dismiss, getToasts } from '../../../ui/toast.js';
import { ConfirmRoot } from '../../../ui/confirm.js';

const me: User = {
  userId: 'u-me', tenantId: 't1', principalId: 'oidc:me', email: 'me@example.com', displayName: 'Ada Admin',
  groups: [], source: 'oidc', status: 'active', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const other: User = { ...me, userId: 'u-bob', principalId: 'oidc:bob', email: 'bob@example.com', displayName: 'Bob Builder' };

beforeEach(() => {
  // Toasts are module state (an error toast persists until dismissed).
  for (const t of getToasts()) dismiss(t.id);
  // The shared announcer is module state: clear both channels so no case reads
  // another case's announcement.
  announce(''); announce('', { assertive: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.getMe.mockResolvedValue(me);
  mocks.listUsers.mockResolvedValue([me, other]);
  mocks.setUserEnabled.mockResolvedValue(other);
  mocks.deleteUser.mockResolvedValue(undefined);
  mocks.revokeUserSessions.mockResolvedValue(undefined);
  mocks.createUser.mockResolvedValue(other);
});

/** Let a handler that resumed after `await confirm(...)` run to its client call. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise<void>((r) => setImmediate(r)); });
}

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
    await drain();
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
    await drain();
    expect(mocks.revokeUserSessions).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await waitFor(() => expect(mocks.revokeUserSessions).toHaveBeenCalledWith('u-bob'));
    expect(mocks.revokeUserSessions).toHaveBeenCalledTimes(1);
  });
});

describe('UsersPage — Delete (USERS-UX-15)', () => {
  it('the confirm names the blast radius; a legal-hold 409 renders a localized warning notice', async () => {
    mocks.deleteUser.mockRejectedValue(new UsersApiError('This workspace is under legal hold (audit)', 409, { error: 'legal_hold', message: 'This workspace is under legal hold (audit)' }));
    render(<><UsersPage /><Toaster /><ConfirmRoot /></>);
    const dialogName = 'Delete user "Bob Builder"?';
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Bob Builder' }));
    // The confirm names the user AND what the erasure takes with it.
    const first = await screen.findByRole('dialog', { name: dialogName });
    expect(first.textContent).toContain('This permanently erases the account of Bob Builder and every record stored under it');
    // Cancel: the client is never called.
    fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull());
    await drain();
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    // Confirm: called exactly once, for that user.
    fireEvent.click(screen.getByRole('button', { name: 'Delete Bob Builder' }));
    const second = await screen.findByRole('dialog', { name: dialogName });
    fireEvent.click(within(second).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.deleteUser).toHaveBeenCalledWith('u-bob'));
    expect(mocks.deleteUser).toHaveBeenCalledTimes(1);
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
    const input = screen.getByLabelText(/Principal id/);
    fireEvent.change(input, { target: { value: 'oidc:new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    const err = await screen.findByRole('alert');
    // The refusal came from the SERVER (the local whitespace check shows the same copy).
    expect(mocks.createUser).toHaveBeenCalledWith({ principalId: 'oidc:new' });
    expect(err.textContent).toMatch(/single token without spaces/);
    expect(err.textContent).not.toMatch(/Field `principalId`/);
    // …and it lands on the field.
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});
