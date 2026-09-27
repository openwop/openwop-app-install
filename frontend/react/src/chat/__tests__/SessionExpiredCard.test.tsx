/**
 * ADR 0517 fix D — the card that replaced a misdiagnosis.
 *
 * This surface exists because the chat used to answer "your session ended" with
 * "add your API key", and the user then pasted a key the server already had —
 * minting a duplicate. So its CONTENT is the fix, not decoration: it must say the
 * key is still saved, offer sign-in as the primary action, and still leave an
 * escape hatch for someone who genuinely wants to set up a key. Untested copy is
 * how a fix like this quietly rots back into the thing it replaced.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const signInGoogle = vi.fn();
let isConfigured = true;
vi.mock('../../auth/useAuth.js', () => ({
  useAuth: () => ({
    user: null, loading: false, isConfigured,
    signIn: { google: signInGoogle, github: vi.fn() },
    signOut: vi.fn(),
  }),
}));

const { SessionExpiredCard } = await import('../SessionExpiredCard.js');

beforeEach(() => { vi.clearAllMocks(); isConfigured = true; signInGoogle.mockResolvedValue(undefined); });
afterEach(cleanup);

describe('SessionExpiredCard', () => {
  it('tells the user their key is still saved — the claim the wizard contradicted', () => {
    render(<SessionExpiredCard onUseWizard={vi.fn()} />);
    // Not asserting exact prose (copy may be reworded); asserting the PROMISE,
    // because losing it is what sent people back to the key wizard.
    expect(screen.getByText(/still saved/i)).toBeTruthy();
    expect(screen.getByText(/session ended/i)).toBeTruthy();
  });

  it('offers sign-in as the action, and actually calls it', async () => {
    render(<SessionExpiredCard onUseWizard={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /sign back in/i }));
    await waitFor(() => expect(signInGoogle).toHaveBeenCalled());
  });

  it('keeps an escape hatch to the key wizard for someone who genuinely wants one', () => {
    const onUseWizard = vi.fn();
    render(<SessionExpiredCard onUseWizard={onUseWizard} />);
    fireEvent.click(screen.getByRole('button', { name: /set up a key/i }));
    expect(onUseWizard).toHaveBeenCalled();
  });

  it('hides sign-in when no auth provider is configured — never a dead button', () => {
    // White-label / local-dev deploys run without Firebase. Offering "Sign back
    // in" there would be a control that cannot work.
    isConfigured = false;
    render(<SessionExpiredCard onUseWizard={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /sign back in/i })).toBeNull();
    expect(screen.getByRole('button', { name: /set up a key/i })).toBeTruthy();
  });
});
