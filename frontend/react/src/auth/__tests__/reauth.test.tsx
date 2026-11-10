/**
 * `withRecentLogin` + the re-authentication dialog, with the real `stepUp.ts`
 * running against a mocked Firebase SDK handed over by `stepUpContext()` (the
 * module boundary every re-authentication call goes through).
 *
 * Covers: an email/password account re-authenticates with the password the
 * person TYPED (`reauthenticateWithCredential`), an MFA challenge raised during
 * re-authentication is finished in the same dialog, a second refusal surfaces
 * instead of looping, no dialog host = the original error, and account delete
 * retries only its Firebase step.
 *
 * Origin: #5392 (re-authenticate in place, then retry).
 *
 * Sabotage-witnessed (2026-10-29, re-measured in /grade-tests wave 80):
 *   - dropping the retry in `withRecentLogin` reds the password, wrong-password,
 *     MFA, second-refusal and delete cases; retrying twice reds the
 *     second-refusal case;
 *   - passing a constant instead of the typed password, or dropping `readOnly`
 *     on the email, reds the password case;
 *   - silencing a wrong-password error reds that case; not trimming the code
 *     reds the MFA case;
 *   - mapping a cancel to the original error, or not clearing the stashed MFA
 *     challenge on cancel, reds the cancel case;
 *   - mapping "no host" to a cancel reds the no-host case;
 *   - opening the dialog for an unrelated error reds the pass-through case;
 *   - deleteAccount without `withRecentLogin`, re-sending the backend DELETE in
 *     the retry, or not mapping a cancel to `RequiresRecentLoginError` reds the
 *     matching delete case.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { ReauthRoot } from '../ReauthRoot.js';
import { ReauthCancelledError, registerReauthPresenter, withRecentLogin } from '../reauth.js';
import { config } from '../../client/config.js';

const fb = vi.hoisted(() => {
  const user = { email: 'ada@example.com', providerData: [{ providerId: 'password' }] };
  const mod = {
    EmailAuthProvider: { credential: vi.fn((email: string, password: string) => ({ email, password })) },
    reauthenticateWithCredential: vi.fn<(u: unknown, c: unknown) => Promise<void>>(),
    reauthenticateWithPopup: vi.fn(),
  };
  return {
    user,
    mod,
    stashMfa: vi.fn<(err: unknown) => boolean>(),
    completeMfaSignIn: vi.fn<(code: string, uid?: string) => Promise<void>>(),
    clearPendingMfaChallenge: vi.fn(),
    deleteCurrentFirebaseUser: vi.fn<() => Promise<void>>(),
  };
});

vi.mock('../firebase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../firebase.js')>()),
  stepUpContext: async () => ({ auth: { currentUser: fb.user }, mod: fb.mod, stashMfa: fb.stashMfa }),
  completeMfaSignIn: fb.completeMfaSignIn,
  clearPendingMfaChallenge: fb.clearPendingMfaChallenge,
  getPendingMfaHints: () => [],
  deleteCurrentFirebaseUser: fb.deleteCurrentFirebaseUser,
}));

const RECENT = Object.assign(new Error('Firebase: Error (auth/requires-recent-login).'), { code: 'auth/requires-recent-login' });

beforeEach(() => {
  fb.mod.reauthenticateWithCredential.mockReset().mockResolvedValue(undefined);
  fb.mod.EmailAuthProvider.credential.mockClear();
  fb.stashMfa.mockReset().mockReturnValue(false);
  fb.completeMfaSignIn.mockReset().mockResolvedValue(undefined);
  fb.clearPendingMfaChallenge.mockReset();
  fb.deleteCurrentFirebaseUser.mockReset();
});
afterEach(cleanup);

describe('withRecentLogin — re-authentication dialog', () => {
  it('email/password: shows the email read-only, reauthenticates with the TYPED password, retries once', async () => {
    render(<ReauthRoot />);
    const action = vi.fn<() => Promise<string>>().mockRejectedValueOnce(RECENT).mockResolvedValueOnce('done');
    const result = withRecentLogin(action);

    await screen.findByRole('dialog', { name: "Confirm it's you" });
    const email = await screen.findByLabelText('Email') as HTMLInputElement;
    expect(email.value).toBe('ada@example.com');
    expect(email.readOnly).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'hunter2-typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await expect(result).resolves.toBe('done');
    expect(fb.mod.EmailAuthProvider.credential).toHaveBeenCalledWith('ada@example.com', 'hunter2-typed');
    expect(fb.mod.reauthenticateWithCredential).toHaveBeenCalledWith(fb.user, { email: 'ada@example.com', password: 'hunter2-typed' });
    expect(action).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a wrong password keeps the dialog open with the non-enumerating error', async () => {
    fb.mod.reauthenticateWithCredential.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'auth/wrong-password' }));
    render(<ReauthRoot />);
    const action = vi.fn<() => Promise<void>>().mockRejectedValueOnce(RECENT).mockResolvedValueOnce(undefined);
    const result = withRecentLogin(action);

    fireEvent.change(await screen.findByLabelText(/^Password/), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Invalid email or password.');
    expect(action).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'right' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(result).resolves.toBeUndefined();
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('an MFA challenge during reauth is finished in the same dialog, then the action retries', async () => {
    fb.mod.reauthenticateWithCredential.mockRejectedValueOnce(Object.assign(new Error('mfa'), { code: 'auth/multi-factor-auth-required' }));
    fb.stashMfa.mockReturnValueOnce(true);
    render(<ReauthRoot />);
    const action = vi.fn<() => Promise<void>>().mockRejectedValueOnce(RECENT).mockResolvedValueOnce(undefined);
    const result = withRecentLogin(action);

    fireEvent.change(await screen.findByLabelText(/^Password/), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    fireEvent.change(await screen.findByLabelText(/^Authenticator code/), { target: { value: ' 123456 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await expect(result).resolves.toBeUndefined();
    expect(fb.completeMfaSignIn).toHaveBeenCalledWith('123456', undefined);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('cancel rejects with ReauthCancelledError, never retries, and drops any stashed MFA challenge', async () => {
    render(<ReauthRoot />);
    const action = vi.fn<() => Promise<void>>().mockRejectedValue(RECENT);
    const result = withRecentLogin(action);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await expect(result).rejects.toBeInstanceOf(ReauthCancelledError);
    expect(action).toHaveBeenCalledTimes(1);
    expect(fb.clearPendingMfaChallenge).toHaveBeenCalled();
  });

  it('a second requires-recent-login after reauth propagates the original error (no loop)', async () => {
    const off = registerReauthPresenter((settle) => settle(true));
    try {
      const action = vi.fn<() => Promise<void>>().mockRejectedValue(RECENT);
      await expect(withRecentLogin(action)).rejects.toBe(RECENT);
      expect(action).toHaveBeenCalledTimes(2);
    } finally { off(); }
  });

  it('with no dialog host mounted, the original error propagates unchanged', async () => {
    const action = vi.fn<() => Promise<void>>().mockRejectedValue(RECENT);
    await expect(withRecentLogin(action)).rejects.toBe(RECENT);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('other errors pass straight through without opening the dialog', async () => {
    // Settles at once, so a misrouted error retries and fails fast instead of
    // parking `withRecentLogin` on a dialog that never answers.
    const presented = vi.fn((settle: (ok: boolean) => void) => settle(true));
    const off = registerReauthPresenter(presented);
    try {
      const boom = Object.assign(new Error('x'), { code: 'auth/network-request-failed' });
      await expect(withRecentLogin(() => Promise.reject(boom))).rejects.toBe(boom);
      expect(presented).not.toHaveBeenCalled();
    } finally { off(); }
  });
});

describe('deleteAccount — retries only the Firebase step after reauth', () => {
  const okFetch = (): Response => new Response(JSON.stringify({ deleted: true, runs: 1, events: 2, interrupts: 0, workflows: 0, secrets: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('requires-recent-login on user.delete → reauth → user.delete retried; backend DELETE sent once', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okFetch());
    fb.deleteCurrentFirebaseUser.mockRejectedValueOnce(RECENT).mockResolvedValueOnce(undefined);
    const off = registerReauthPresenter((settle) => settle(true));
    try {
      const { deleteAccount } = await import('../deleteAccount.js');
      await expect(deleteAccount()).resolves.toMatchObject({ deleted: true });
      expect(fb.deleteCurrentFirebaseUser).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe(`${config.baseUrl}/host/openwop-app/account`);
      expect(fetchMock.mock.calls[0]![1]?.method).toBe('DELETE');
    } finally { off(); fetchMock.mockRestore(); }
  });

  it('cancelled reauth → RequiresRecentLoginError (the dialog keeps its honest message)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okFetch());
    fb.deleteCurrentFirebaseUser.mockRejectedValue(RECENT);
    const off = registerReauthPresenter((settle) => settle(false));
    try {
      const { deleteAccount, RequiresRecentLoginError } = await import('../deleteAccount.js');
      await expect(deleteAccount()).rejects.toBeInstanceOf(RequiresRecentLoginError);
      expect(fb.deleteCurrentFirebaseUser).toHaveBeenCalledTimes(1);
    } finally { off(); fetchMock.mockRestore(); }
  });
});
