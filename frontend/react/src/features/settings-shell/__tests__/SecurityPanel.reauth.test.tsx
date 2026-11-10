/**
 * SecurityPanel × the re-authentication dialog: when Firebase refuses a factor
 * change with `auth/requires-recent-login`, the panel opens the in-place
 * "Confirm it's you" dialog and retries the change once, instead of telling
 * the person to sign out and back in.
 *
 * Firebase is mocked at the module boundary (`auth/firebase.js` for the factor
 * calls, `auth/stepUp.js` for the re-authentication itself); the real
 * `withRecentLogin` seam and the real `<ReauthRoot>` host run.
 *
 * Origin: #5392 (re-authenticate in place, then retry).
 *
 * Sabotage-witnessed (2026-10-29, re-measured in /grade-tests wave 80):
 *   - calling `startTotpEnrollment()` without `withRecentLogin` reds the
 *     enrollment, cancel and second-refusal cases;
 *   - calling `unenrollMfaFactor()` without it reds the remove case;
 *   - dropping the panel's quiet `ReauthCancelledError` return reds the cancel
 *     case (the cancel message shows as an error);
 *   - a `withRecentLogin` that retries twice reds the second-refusal case.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { SecurityPanel } from '../SecurityPanel.js';
import { ReauthRoot } from '../../../auth/ReauthRoot.js';
import { ConfirmRoot } from '../../../ui/confirm.js';
import type { AuthUser, MfaFactor } from '../../../auth/firebase.js';

const mocks = vi.hoisted(() => ({
  getMySecurity: vi.fn<typeof import('../../users/usersClient.js').getMySecurity>(),
  getCurrentUser: vi.fn<typeof import('../../../auth/firebase.js').getCurrentUser>(),
  listMfaFactors: vi.fn<typeof import('../../../auth/firebase.js').listMfaFactors>(),
  startTotpEnrollment: vi.fn<typeof import('../../../auth/firebase.js').startTotpEnrollment>(),
  unenrollMfaFactor: vi.fn<typeof import('../../../auth/firebase.js').unenrollMfaFactor>(),
  reportFactorEvent: vi.fn<typeof import('../../users/usersClient.js').reportFactorEvent>(),
  getReauthMethod: vi.fn<typeof import('../../../auth/stepUp.js').getReauthMethod>(),
  reauthenticateWithProviderPopup: vi.fn<typeof import('../../../auth/stepUp.js').reauthenticateWithProviderPopup>(),
}));

vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,AAAA' } }));

vi.mock('../../users/usersClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../users/usersClient.js')>()),
  getMySecurity: mocks.getMySecurity,
  reportFactorEvent: mocks.reportFactorEvent,
}));

vi.mock('../../../auth/firebase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../auth/firebase.js')>()),
  getCurrentUser: mocks.getCurrentUser,
  listMfaFactors: mocks.listMfaFactors,
  startTotpEnrollment: mocks.startTotpEnrollment,
  unenrollMfaFactor: mocks.unenrollMfaFactor,
}));

vi.mock('../../../auth/stepUp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../auth/stepUp.js')>()),
  getReauthMethod: mocks.getReauthMethod,
  reauthenticateWithProviderPopup: mocks.reauthenticateWithProviderPopup,
}));

const USER: AuthUser = { uid: 'u1', email: 'a@b.co', displayName: null, photoURL: null, providerIds: ['google.com'] };
const RECENT = Object.assign(new Error('Firebase: Error (auth/requires-recent-login).'), { code: 'auth/requires-recent-login' });
const ENROLL = { secretKey: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x:a%40b.co?secret=JBSWY3DPEHPK3PXP' };
const FACTOR: MfaFactor = { uid: 'f1', displayName: 'Phone', enrolledAt: null, factorId: 'totp' };

function renderPanel(): void {
  render(<><SecurityPanel /><ReauthRoot /><ConfirmRoot /></>);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getMySecurity.mockResolvedValue({ source: 'oidc', mfaSessionVerified: false });
  mocks.getCurrentUser.mockReturnValue(USER);
  mocks.listMfaFactors.mockResolvedValue([]);
  mocks.reportFactorEvent.mockResolvedValue(undefined);
  mocks.getReauthMethod.mockResolvedValue({ kind: 'popup', providerId: 'google.com' });
  mocks.reauthenticateWithProviderPopup.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('SecurityPanel — recent-login re-authentication', () => {
  it('set up authenticator: requires-recent-login → dialog → reauth → enrollment retried once and shown', async () => {
    mocks.startTotpEnrollment.mockRejectedValueOnce(RECENT).mockResolvedValueOnce(ENROLL);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up authenticator app' }));

    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    expect(dialog).toBeTruthy();
    // The old dead-end copy must not appear: the dialog replaces it.
    expect(screen.queryByText(/Sign out and back in, then retry/)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));

    await screen.findByText(/Scan this QR code/);
    expect(mocks.reauthenticateWithProviderPopup).toHaveBeenCalledTimes(1);
    expect(mocks.startTotpEnrollment).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog', { name: "Confirm it's you" })).toBeNull();
  });

  it('cancel → no retry and a quiet panel (no error notice)', async () => {
    mocks.startTotpEnrollment.mockRejectedValueOnce(RECENT);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up authenticator app' }));
    await screen.findByRole('dialog', { name: "Confirm it's you" });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: "Confirm it's you" })).toBeNull());
    expect(mocks.startTotpEnrollment).toHaveBeenCalledTimes(1);
    expect(mocks.reauthenticateWithProviderPopup).not.toHaveBeenCalled();
    expect(screen.queryByText(/recent sign-in/i)).toBeNull();
    expect(screen.queryByText(/cancelled/i)).toBeNull();
    // Back to the idle state, ready to try again.
    expect((screen.getByRole('button', { name: 'Set up authenticator app' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('remove factor: requires-recent-login → reauth → unenroll retried once', async () => {
    mocks.listMfaFactors.mockResolvedValue([FACTOR]);
    mocks.unenrollMfaFactor.mockRejectedValueOnce(RECENT).mockResolvedValueOnce(undefined);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Remove — Phone/ }));
    // The lockout-adjacent confirm comes first.
    fireEvent.click(await screen.findByRole('button', { name: 'Remove factor' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => expect(mocks.unenrollMfaFactor).toHaveBeenCalledTimes(2));
    expect(mocks.unenrollMfaFactor).toHaveBeenLastCalledWith('f1');
    expect(mocks.reauthenticateWithProviderPopup).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.reportFactorEvent).toHaveBeenCalledWith('unbound', 0));
  });

  it('a second requires-recent-login after reauth surfaces the error instead of looping', async () => {
    mocks.startTotpEnrollment.mockRejectedValue(RECENT);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up authenticator app' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));

    await screen.findByText('This change needs a recent sign-in. Sign out and back in, then retry.');
    expect(mocks.startTotpEnrollment).toHaveBeenCalledTimes(2);
    expect(mocks.reauthenticateWithProviderPopup).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: "Confirm it's you" })).toBeNull();
  });
});
