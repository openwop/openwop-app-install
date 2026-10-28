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
 *
 * One TOTP per account (2026-10-24), sabotage-witnessed: showing the set-up
 * button beside an enrolled TOTP, keying it off factor COUNT instead of TOTP,
 * dropping the enrollment backup tip, or unmapping the limit error each turn a
 * case red.
 *
 * Enrollment QR (2026-10-23), sabotage-witnessed: removing every `clearQr()`,
 * dropping the generation guard, awaiting the encode on the busy path, putting
 * the secret in the alt, silencing the library-failure branch, or logging the
 * otpauth URI each turn a case red.
 *
 * Disclosure + naming (2026-10-23), sabotage-witnessed: rendering the key
 * outside the <details>, not opening it when the QR fails, ignoring the typed
 * name, or not resetting it (on cancel and on start) each turn a case red.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { SecurityPanel } from '../SecurityPanel.js';
import type { AuthUser, MfaFactor } from '../../../auth/firebase.js';

const mocks = vi.hoisted(() => ({
  getMySecurity: vi.fn<typeof import('../../users/usersClient.js').getMySecurity>(),
  getCurrentUser: vi.fn<typeof import('../../../auth/firebase.js').getCurrentUser>(),
  listMfaFactors: vi.fn<typeof import('../../../auth/firebase.js').listMfaFactors>(),
  startTotpEnrollment: vi.fn<typeof import('../../../auth/firebase.js').startTotpEnrollment>(),
  completeTotpEnrollment: vi.fn<typeof import('../../../auth/firebase.js').completeTotpEnrollment>(),
  cancelTotpEnrollment: vi.fn<typeof import('../../../auth/firebase.js').cancelTotpEnrollment>(),
  toDataURL: vi.fn<(text: string, opts?: unknown) => Promise<string>>(),
  reportFactorEvent: vi.fn<typeof import('../../users/usersClient.js').reportFactorEvent>(),
}));

vi.mock('qrcode', () => ({ default: { toDataURL: mocks.toDataURL }, toDataURL: mocks.toDataURL }));

// Never enumerate a module mock: spread the real module and override the seams,
// so an import the panel adds later (e.g. `revokeMySessions`) is never undefined.
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
  completeTotpEnrollment: mocks.completeTotpEnrollment,
  cancelTotpEnrollment: mocks.cancelTotpEnrollment,
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

describe('SecurityPanel — backup-factor recovery affordance (ADR 0389 § Correction 2026-10-24)', () => {
  // Identity Platform ships NO second-factor recovery and holds ONE TOTP factor
  // per account, so the self-service backup is the same authenticator on a
  // second device. The panel must say that, and never offer an enrollment the
  // platform refuses (auth/maximum-second-factor-count-exceeded, measured on
  // kicktodo-prod 2026-10-23).
  const factor = (uid: string, factorId = 'totp'): MfaFactor => ({ uid, displayName: 'Authenticator app', enrolledAt: '2026-07-01T00:00:00.000Z', factorId });
  const setUpButton = (): HTMLElement | null => screen.queryByRole('button', { name: /Set up authenticator app/i });

  it('exactly one TOTP factor → backup means a second DEVICE, and no second enrollment is offered', async () => {
    mocks.getMySecurity.mockResolvedValue({ source: 'oidc', mfaSessionVerified: true });
    mocks.getCurrentUser.mockReturnValue(USER);
    mocks.listMfaFactors.mockResolvedValue([factor('f1')]);
    render(<SecurityPanel />);
    await waitFor(() => expect(screen.getByText(/same authenticator on a second device/i)).toBeTruthy());
    expect(screen.getByText(/cannot recover this account yourself/i)).toBeTruthy();
    expect(screen.queryByText(/Add a second authenticator/i)).toBeNull();
    expect(setUpButton()).toBeNull();
    // One factor is NOT covered: the affirmation must be absent.
    expect(screen.queryByText(/You have a backup authenticator/i)).toBeNull();
  });

  it('two factors (TOTP + phone) → the covered affirmation and the one-authenticator hint, no set-up button', async () => {
    mocks.getMySecurity.mockResolvedValue({ source: 'oidc', mfaSessionVerified: true });
    mocks.getCurrentUser.mockReturnValue(USER);
    mocks.listMfaFactors.mockResolvedValue([factor('f1'), factor('f2', 'phone')]);
    render(<SecurityPanel />);
    await waitFor(() => expect(screen.getByText(/You have a backup authenticator/i)).toBeTruthy());
    expect(screen.queryByText(/same authenticator on a second device/i)).toBeNull();
    expect(screen.getByText(/Each account holds one authenticator app/i)).toBeTruthy();
    expect(setUpButton()).toBeNull();
  });

  it('a phone factor only → TOTP can still be added', async () => {
    mocks.getMySecurity.mockResolvedValue({ source: 'oidc', mfaSessionVerified: true });
    mocks.getCurrentUser.mockReturnValue(USER);
    mocks.listMfaFactors.mockResolvedValue([factor('p1', 'phone')]);
    render(<SecurityPanel />);
    await waitFor(() => expect(setUpButton()).toBeTruthy());
  });

  it('zero factors → neither backup message (nothing to back up yet), and the set-up button', async () => {
    mocks.getMySecurity.mockResolvedValue({ source: 'oidc', mfaSessionVerified: false });
    mocks.getCurrentUser.mockReturnValue(USER);
    mocks.listMfaFactors.mockResolvedValue([]);
    render(<SecurityPanel />);
    await waitFor(() => expect(screen.getByText(/No second factor enrolled yet/i)).toBeTruthy());
    expect(screen.queryByText(/same authenticator on a second device/i)).toBeNull();
    expect(screen.queryByText(/You have a backup authenticator/i)).toBeNull();
    expect(setUpButton()).toBeTruthy();
  });

  it('enrollment says how to keep a backup while the code is on screen', async () => {
    mocks.getMySecurity.mockResolvedValue({ source: 'oidc', mfaSessionVerified: false });
    mocks.getCurrentUser.mockReturnValue(USER);
    mocks.startTotpEnrollment.mockReset().mockResolvedValue({ secretKey: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP' });
    mocks.toDataURL.mockReset().mockResolvedValue('data:image/png;base64,iVBORw0KGgo=');
    render(<SecurityPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Set up authenticator app/i }));
    expect(await screen.findByText(/Scan this same code on a second device/i)).toBeTruthy();
  });

  it('the platform limit error is explained, not echoed raw', async () => {
    mocks.getMySecurity.mockResolvedValue({ source: 'oidc', mfaSessionVerified: false });
    mocks.getCurrentUser.mockReturnValue(USER);
    mocks.startTotpEnrollment.mockReset().mockRejectedValue(
      Object.assign(new Error('Firebase: Too many TOTP based second factors enrolled for this account. (auth/maximum-second-factor-count-exceeded).'), { code: 'auth/maximum-second-factor-count-exceeded' }),
    );
    render(<SecurityPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Set up authenticator app/i }));
    expect(await screen.findByText(/This account already has an authenticator app/i)).toBeTruthy();
    expect(screen.queryByText(/Too many TOTP based second factors/i)).toBeNull();
  });
});

describe('SecurityPanel — enrollment QR code (the otpauth URI carries the TOTP secret)', () => {
  const SECRET = 'JBSWY3DPEHPK3PXP';
  const OTPAUTH = `otpauth://totp/KickTodo:a%40b.co?secret=${SECRET}&issuer=KickTodo`;
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';

  beforeEach(() => {
    mocks.getMySecurity.mockResolvedValue({ source: 'oidc', mfaSessionVerified: false });
    mocks.getCurrentUser.mockReturnValue(USER);
    mocks.startTotpEnrollment.mockReset().mockResolvedValue({ secretKey: SECRET, otpauthUrl: OTPAUTH });
    mocks.completeTotpEnrollment.mockReset().mockResolvedValue(undefined);
    mocks.cancelTotpEnrollment.mockReset();
    mocks.toDataURL.mockReset().mockResolvedValue(PNG);
    mocks.reportFactorEvent.mockReset().mockResolvedValue(undefined);
  });

  const startEnroll = async (): Promise<void> => {
    render(<SecurityPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Set up authenticator app/i }));
  };

  it('encodes the otpauth URI in the browser into a data: image whose label never reads out the secret, beside the manual key', async () => {
    await startEnroll();
    const img = await screen.findByRole('img', { name: /QR code to scan/i });
    expect(mocks.toDataURL).toHaveBeenCalledWith(OTPAUTH, expect.anything());
    // A data: URL only — no QR service, no image URL, so no request carries the secret.
    expect(img.getAttribute('src')).toBe(PNG);
    expect(img.getAttribute('alt')).not.toContain(SECRET);
    // The manual-entry fallback stays (accessibility, and cameras that can't scan).
    expect(screen.getByText(SECRET.replace(/(.{4})/g, '$1 ').trim())).toBeTruthy();
    expect(screen.getByText(/Add this key to your authenticator app by hand/i)).toBeTruthy();
  });

  // The <img> lives inside the pending form, so "gone after cancel" alone is
  // vacuous. The real exposure is the NEXT enrollment showing the PREVIOUS
  // secret's QR while its own encode is still running.
  it.each([
    ['cancel', (): void => { fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i })); }],
    ['completion', (): void => {
      fireEvent.change(screen.getByLabelText(/verification code/i), { target: { value: '123456' } });
      fireEvent.click(screen.getByRole('button', { name: /Turn on 2FA/i }));
    }],
  ] as const)('after %s, a new enrollment never shows the previous secret\'s QR', async (_label, end) => {
    await startEnroll();
    await screen.findByRole('img', { name: /QR code to scan/i });
    end();
    const again = await screen.findByRole('button', { name: /Set up authenticator app/i });
    mocks.startTotpEnrollment.mockResolvedValue({ secretKey: 'KRSXG5CTMVRXEZLU', otpauthUrl: 'otpauth://totp/x?secret=KRSXG5CTMVRXEZLU' });
    mocks.toDataURL.mockReturnValue(new Promise<string>(() => {}));
    fireEvent.click(again);
    await screen.findByText('KRSX G5CT MVRX EZLU');
    expect(screen.queryByRole('img', { name: /QR code to scan/i })).toBeNull();
  });

  it('a slow encode from an abandoned enrollment never paints into the next one', async () => {
    let finishFirst!: (v: string) => void;
    mocks.toDataURL.mockReturnValueOnce(new Promise<string>((r) => { finishFirst = r; }));
    await startEnroll();
    await waitFor(() => expect(mocks.toDataURL).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    // Second enrollment: a different secret, its own encode still running.
    mocks.startTotpEnrollment.mockResolvedValue({ secretKey: 'KRSXG5CTMVRXEZLU', otpauthUrl: 'otpauth://totp/x?secret=KRSXG5CTMVRXEZLU' });
    mocks.toDataURL.mockReturnValueOnce(new Promise<string>(() => {}));
    fireEvent.click(await screen.findByRole('button', { name: /Set up authenticator app/i }));
    await screen.findByText('KRSX G5CT MVRX EZLU');
    // The FIRST secret's QR now finishes — it must not appear beside the second key.
    finishFirst('data:image/png;base64,FIRST');
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('img', { name: /QR code to scan/i })).toBeNull();
  });

  it('when the QR library fails, it says so and the manual key still works', async () => {
    mocks.toDataURL.mockRejectedValue(new Error('chunk load failed'));
    await startEnroll();
    expect(await screen.findByText(/QR code could not be shown/i)).toBeTruthy();
    expect(screen.queryByRole('img', { name: /QR code to scan/i })).toBeNull();
    expect(screen.getByText(SECRET.replace(/(.{4})/g, '$1 ').trim())).toBeTruthy();
  });

  it('never logs, stores or sends the secret or the otpauth URI', async () => {
    const setLocal = vi.spyOn(Storage.prototype, 'setItem');
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await startEnroll();
    await screen.findByRole('img', { name: /QR code to scan/i });
    const seen = JSON.stringify([setLocal.mock.calls, ...logs.map((l) => l.mock.calls), fetchSpy.mock.calls]);
    expect(seen).not.toContain(SECRET);
    setLocal.mockRestore(); logs.forEach((l) => l.mockRestore()); fetchSpy.mockRestore();
  });
});

describe('SecurityPanel — manual-key disclosure and factor naming', () => {
  const SECRET = 'JBSWY3DPEHPK3PXP';
  const OTPAUTH = `otpauth://totp/KickTodo:a%40b.co?secret=${SECRET}&issuer=KickTodo`;

  beforeEach(() => {
    mocks.getMySecurity.mockResolvedValue({ source: 'oidc', mfaSessionVerified: false });
    mocks.getCurrentUser.mockReturnValue(USER);
    mocks.startTotpEnrollment.mockReset().mockResolvedValue({ secretKey: SECRET, otpauthUrl: OTPAUTH });
    mocks.completeTotpEnrollment.mockReset().mockResolvedValue(undefined);
    mocks.cancelTotpEnrollment.mockReset();
    mocks.reportFactorEvent.mockReset().mockResolvedValue(undefined);
    mocks.toDataURL.mockReset().mockResolvedValue('data:image/png;base64,iVBORw0KGgo=');
  });

  const startEnroll = async (): Promise<void> => {
    render(<SecurityPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Set up authenticator app/i }));
  };
  const disclosureOf = (): HTMLDetailsElement => {
    const summary = screen.getByText(/Can't scan the code\?/i);
    const details = summary.closest('details');
    if (!details) throw new Error('the manual key is not inside a <details> disclosure');
    return details;
  };

  it('with a QR on screen, the manual key starts collapsed behind "Can\'t scan the code?"', async () => {
    await startEnroll();
    await screen.findByRole('img', { name: /QR code to scan/i });
    const details = disclosureOf();
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(SECRET.slice(0, 4));
  });

  it('when the QR cannot be drawn, the disclosure opens itself', async () => {
    mocks.toDataURL.mockRejectedValue(new Error('chunk load failed'));
    await startEnroll();
    await screen.findByText(/QR code could not be shown/i);
    expect(disclosureOf().open).toBe(true);
  });

  it.each([
    ['the name the person typed', '  iPhone  ', 'iPhone'],
    ['the default name when left blank', '   ', 'Authenticator app'],
  ] as const)('enrolls under %s', async (_label, typed, expected) => {
    await startEnroll();
    fireEvent.change(await screen.findByLabelText(/Name this authenticator/i), { target: { value: typed } });
    fireEvent.change(screen.getByLabelText(/verification code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Turn on 2FA/i }));
    await waitFor(() => expect(mocks.completeTotpEnrollment).toHaveBeenCalledWith('123456', expected));
  });

  it('a name typed for an abandoned enrollment does not carry into the next one', async () => {
    await startEnroll();
    fireEvent.change(await screen.findByLabelText(/Name this authenticator/i), { target: { value: 'Old phone' } });
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Set up authenticator app/i }));
    expect((await screen.findByLabelText(/Name this authenticator/i) as HTMLInputElement).value).toBe('');
  });
});
