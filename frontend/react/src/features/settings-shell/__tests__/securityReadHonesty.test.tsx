/**
 * UX_UPGRADE-settings P1 — a security surface must never state a posture it
 * could not read.
 *
 * UX-SET-1: `refresh()` did `getMySecurity().catch(() => null)` and
 * `listMfaFactors().catch(() => [])`. Those two fallbacks are not neutral on
 * THIS screen — they are the exact inputs to two factual claims:
 *   • `security === null`  → the chip renders "Single-factor session"
 *   • `factors === []`     → the body renders "No second factor enrolled yet."
 * So a transient 5xx made the app assert, about an account that may have two
 * factors and a fully 2FA-verified session, that it had neither. It also
 * suppressed the accurate backup-factor guidance, which keys off the count.
 *
 * Erring toward "less secure than reality" is the safer direction, but it is
 * still false and it drives real bad actions — re-enrolling, or tearing down
 * working factors to "fix" a problem that does not exist.
 *
 * Both arms are asserted throughout: a FAILED read must say unknown, and a
 * GENUINE zero must still say "none enrolled" — otherwise the fix rots into
 * "always claim unknown", which would destroy the real onboarding prompt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({ getMySecurity: vi.fn() }));
vi.mock('../../users/usersClient.js', async (importOriginal) => {
  // Never enumerate a module mock — spread the real one and override the seam.
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getMySecurity: api.getMySecurity };
});

const fb = vi.hoisted(() => ({ getCurrentUser: vi.fn(), listMfaFactors: vi.fn() }));
vi.mock('../../../auth/firebase.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getCurrentUser: fb.getCurrentUser, listMfaFactors: fb.listMfaFactors };
});

import { SecurityPanel } from '../SecurityPanel.js';

beforeEach(() => {
  vi.clearAllMocks();
  fb.getCurrentUser.mockReturnValue({ uid: 'u1' });
  api.getMySecurity.mockResolvedValue({ mfaSessionVerified: true, ssoManaged: false });
  fb.listMfaFactors.mockResolvedValue([]);
});
afterEach(cleanup);

describe('UX-SET-1 — a failed security read states nothing about MFA posture', () => {
  it('FAILURE: says the status is unknown, not "no second factor enrolled"', async () => {
    api.getMySecurity.mockRejectedValue(new Error('sec_500'));
    fb.listMfaFactors.mockRejectedValue(new Error('factors_500'));
    render(<SecurityPanel />);

    expect(await screen.findByText(/unknown, not off/i)).toBeTruthy();
    // The two false claims must be gone.
    expect(screen.queryByText(/No second factor enrolled yet/i)).toBeNull();
    expect(screen.queryByText(/Single-factor session/i)).toBeNull();
  });

  it('EMPTY: an account that genuinely has no factors still says so', async () => {
    // The other arm — without it, "always claim unknown" would pass the test
    // above while destroying the real onboarding prompt.
    api.getMySecurity.mockResolvedValue({ mfaSessionVerified: false, ssoManaged: false });
    fb.listMfaFactors.mockResolvedValue([]);
    render(<SecurityPanel />);

    expect(await screen.findByText(/No second factor enrolled yet/i)).toBeTruthy();
    expect(screen.queryByText(/unknown, not off/i)).toBeNull();
  });

  it('ENROLLED: a real answer still renders the factors and the verified chip', async () => {
    api.getMySecurity.mockResolvedValue({ mfaSessionVerified: true, ssoManaged: false });
    fb.listMfaFactors.mockResolvedValue([{ uid: 'f1', displayName: 'Phone', enrolledAt: null }]);
    render(<SecurityPanel />);

    expect(await screen.findByText('Phone')).toBeTruthy();
    expect(screen.queryByText(/unknown, not off/i)).toBeNull();
  });

  it('FAILURE never renders the "you are covered" reassurance', async () => {
    // The dangerous direction: a false ASSURANCE is worse than a false alarm.
    api.getMySecurity.mockRejectedValue(new Error('sec_500'));
    fb.listMfaFactors.mockRejectedValue(new Error('factors_500'));
    render(<SecurityPanel />);

    await screen.findByText(/unknown, not off/i);
    expect(screen.queryByText(/backup/i)).toBeNull();
  });

  it('a PARTIAL failure (factors ok, security down) still refuses to claim the session state', async () => {
    // Promise.allSettled means one arm can succeed; the chip must not render
    // "Single-factor session" off a null security read.
    api.getMySecurity.mockRejectedValue(new Error('sec_500'));
    fb.listMfaFactors.mockResolvedValue([{ uid: 'f1', displayName: 'Phone', enrolledAt: null }]);
    render(<SecurityPanel />);

    expect(await screen.findByText(/unknown, not off/i)).toBeTruthy();
    expect(screen.queryByText(/Single-factor session/i)).toBeNull();
    // …but the factors it DID read are still shown.
    expect(screen.getByText('Phone')).toBeTruthy();
  });
});
