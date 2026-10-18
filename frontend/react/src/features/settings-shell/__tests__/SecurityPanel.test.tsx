/**
 * SecurityPanel (ADR 0389 P1) — render-path coverage with the Firebase module
 * and users client mocked: SSO-managed accounts get the IdP notice (no enroll
 * UI), Firebase-less sessions get the sign-in hint, and the session chip is a
 * LABELED state (never color alone). The live enroll flow needs a real
 * Identity-Platform project and is verified manually.
 *
 * PROTECTED (security posture). Sabotage-witnessed (wave 52): dropping either
 * SSO source from `ssoManaged`, un-suppressing the chip for SSO accounts,
 * removing the no-Firebase-user branch, or widening the one-factor backup prompt
 * / two-factor covered affirmation each turn a case red.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { SecurityPanel } from '../SecurityPanel.js';
import type { AuthUser, MfaFactor } from '../../../auth/firebase.js';

const mocks = vi.hoisted(() => ({
  getMySecurity: vi.fn<typeof import('../../users/usersClient.js').getMySecurity>(),
  getCurrentUser: vi.fn<typeof import('../../../auth/firebase.js').getCurrentUser>(),
  listMfaFactors: vi.fn<typeof import('../../../auth/firebase.js').listMfaFactors>(),
}));

// Never enumerate a module mock: spread the real module and override the seams,
// so an import the panel adds later (e.g. `revokeMySessions`) is never undefined.
vi.mock('../../users/usersClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../users/usersClient.js')>()),
  getMySecurity: mocks.getMySecurity,
}));

vi.mock('../../../auth/firebase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../auth/firebase.js')>()),
  getCurrentUser: mocks.getCurrentUser,
  listMfaFactors: mocks.listMfaFactors,
}));

const USER: AuthUser = { uid: 'u1', email: 'a@b.co', displayName: null, photoURL: null, providerIds: [] };

beforeEach(() => {
  mocks.getMySecurity.mockReset();
  mocks.getCurrentUser.mockReset();
  mocks.listMfaFactors.mockReset();
  mocks.listMfaFactors.mockResolvedValue([]);
});
afterEach(cleanup);

describe('SecurityPanel', () => {
  it.each(['saml', 'scim'] as const)('SSO-provisioned account (%s) → IdP-managed notice, no enroll button', async (source) => {
    mocks.getMySecurity.mockResolvedValue({ source, mfaSessionVerified: true });
    // A SIGNED-IN Firebase user: only `ssoManaged` can hide enrollment here (with
    // no user, the no-Firebase branch would hide it too and the case proved nothing).
    mocks.getCurrentUser.mockReturnValue(USER);
    render(<SecurityPanel />);
    await waitFor(() => expect(screen.getByText(/settings are managed there/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /authenticator app/i })).toBeNull();
    // The session chip is SUPPRESSED for IdP-managed accounts (their second
    // factor happens at the IdP — the Firebase-claim mark can't see it).
    expect(screen.queryByText(/2FA verified this session/i)).toBeNull();
    expect(screen.queryByText(/Single-factor session/i)).toBeNull();
  });

  it('no Firebase user → sign-in hint instead of enrollment', async () => {
    mocks.getMySecurity.mockResolvedValue({ source: 'oidc', mfaSessionVerified: false });
    mocks.getCurrentUser.mockReturnValue(null);
    render(<SecurityPanel />);
    await waitFor(() => expect(screen.getByText(/Sign in with your identity provider/i)).toBeTruthy());
    expect(screen.getByText(/Single-factor session/i)).toBeTruthy();
  });

  it('Firebase user without factors → enroll button + empty state', async () => {
    mocks.getMySecurity.mockResolvedValue({ source: 'oidc', mfaSessionVerified: false });
    mocks.getCurrentUser.mockReturnValue(USER);
    render(<SecurityPanel />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Set up authenticator app/i })).toBeTruthy());
    expect(screen.getByText(/No second factor enrolled yet/i)).toBeTruthy();
  });
});

describe('SecurityPanel — backup-factor recovery affordance (ADR 0389 § Correction)', () => {
  // Identity Platform ships NO second-factor recovery, so a backup authenticator
  // is the only self-service way out of a lost device. The panel must SAY so.
  const factor = (uid: string): MfaFactor => ({ uid, displayName: 'Authenticator app', enrolledAt: '2026-07-01T00:00:00.000Z' });

  it('exactly one factor → prompts for a backup, naming the consequence', async () => {
    mocks.getMySecurity.mockResolvedValue({ source: 'oidc', mfaSessionVerified: true });
    mocks.getCurrentUser.mockReturnValue(USER);
    mocks.listMfaFactors.mockResolvedValue([factor('f1')]);
    render(<SecurityPanel />);
    await waitFor(() => expect(screen.getByText(/Add a second authenticator as backup/i)).toBeTruthy());
    expect(screen.getByText(/cannot recover this account yourself/i)).toBeTruthy();
    // One factor is NOT covered: the affirmation must be absent.
    expect(screen.queryByText(/You have a backup authenticator/i)).toBeNull();
  });

  it('two factors → the prompt is replaced by the covered affirmation', async () => {
    mocks.getMySecurity.mockResolvedValue({ source: 'oidc', mfaSessionVerified: true });
    mocks.getCurrentUser.mockReturnValue(USER);
    mocks.listMfaFactors.mockResolvedValue([factor('f1'), factor('f2')]);
    render(<SecurityPanel />);
    await waitFor(() => expect(screen.getByText(/You have a backup authenticator/i)).toBeTruthy());
    expect(screen.queryByText(/Add a second authenticator as backup/i)).toBeNull();
  });

  it('zero factors → neither backup message (nothing to back up yet)', async () => {
    mocks.getMySecurity.mockResolvedValue({ source: 'oidc', mfaSessionVerified: false });
    mocks.getCurrentUser.mockReturnValue(USER);
    mocks.listMfaFactors.mockResolvedValue([]);
    render(<SecurityPanel />);
    await waitFor(() => expect(screen.getByText(/No second factor enrolled yet/i)).toBeTruthy());
    expect(screen.queryByText(/Add a second authenticator as backup/i)).toBeNull();
    expect(screen.queryByText(/You have a backup authenticator/i)).toBeNull();
  });
});
