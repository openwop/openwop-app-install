/**
 * Issue 6043 — the cookie-session half: a password or bound session signed out in
 * another tab. Re-checking `/me` when the tab returns, a move from a user to a
 * definitive "no user" reloads; a tab that signed itself out does not; a tab that was
 * never signed in does not; a transport failure is not "no user".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getMe: vi.fn(), reload: vi.fn() }));
vi.mock('../../features/users/usersClient.js', async (orig) => ({ ...(await orig<typeof import('../../features/users/usersClient.js')>()), getMe: () => h.getMe(), getMeIfSignedIn: () => h.getMe() }));
vi.mock('../reloadIntoSession.js', () => ({ reloadIntoSession: () => h.reload() }));

const { refreshBackendSession, __resetBackendSessionForTest } = await import('../backendSession.js');
const { __resetShellIdentityForTest, noteOwnSignOut } = await import('../shellIdentity.js');
const { UsersApiError } = await import('../../features/users/usersClient.js');
const signedOut = () => new UsersApiError('Sign in to access your account.', 401, { error: 'sign_in_required' });

beforeEach(() => { __resetBackendSessionForTest(); __resetShellIdentityForTest(); h.getMe.mockReset(); h.reload.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('issue 6043 — backend session signed out elsewhere', () => {
  it('a signed-in tab whose session ends elsewhere reloads', async () => {
    h.getMe.mockResolvedValueOnce({ userId: 'u1' }).mockRejectedValueOnce(signedOut());
    await refreshBackendSession();
    expect(h.reload).not.toHaveBeenCalled();
    await refreshBackendSession();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('the probe\'s 204 (no user, issue 5991) after a signed-in snapshot reloads too', async () => {
    h.getMe.mockResolvedValueOnce({ userId: 'u1' }).mockResolvedValueOnce(null);
    await refreshBackendSession();
    await refreshBackendSession();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('this tab\'s own sign-out does not reload', async () => {
    h.getMe.mockResolvedValueOnce({ userId: 'u1' }).mockRejectedValueOnce(signedOut());
    await refreshBackendSession();
    noteOwnSignOut();
    await refreshBackendSession();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('a tab that was never signed in does not reload, and a transport failure is not a sign-out', async () => {
    h.getMe.mockRejectedValueOnce(signedOut());
    await refreshBackendSession();
    expect(h.reload, 'never signed in').not.toHaveBeenCalled();
    h.getMe.mockResolvedValueOnce({ userId: 'u1' }).mockRejectedValueOnce(new Error('network'));
    await refreshBackendSession();
    await refreshBackendSession();
    expect(h.reload, 'network failure').not.toHaveBeenCalled();
  });
});
