/**
 * UX_UPGRADE-invitations ROUND 2 — InvitesSection's FIRST tests (XIN-4).
 * The inviter side was a zero-test surface; these pin the R2 honesty fixes:
 *  - a failed list read is NOT "no pending invites" (warning + retry);
 *  - the 422 undeliverable refusal renders operator-actionable copy, never
 *    the raw API string;
 *  - an expired row is labelled, not left looking pending.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { listInvites, createInvite, revokeInvite } = vi.hoisted(() => ({
  listInvites: vi.fn(), createInvite: vi.fn(), revokeInvite: vi.fn(),
}));
vi.mock('../invitesClient.js', async (orig) => ({
  ...(await orig<typeof import('../invitesClient.js')>()),
  listInvites, createInvite, revokeInvite,
}));
vi.mock('../../featureToggles/FeatureAccessContext.js', async () => {
  const { makeFeatureAccess } = await import('../../featureToggles/__testing__/makeFeatureAccess.js');
  return { useFeatureAccess: () => makeFeatureAccess() };
});
const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: toastError } }));
const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
vi.mock('../../ui/confirm.js', () => ({ confirm: confirmMock }));

import { InvitesSection } from '../InvitesSection.js';
import { GlobalLiveRegion } from '../../ui/announce.js';
import { formatDateTime } from '../../i18n/format.js';

const INVITE = { inviteId: 'inv1', email: 'bob@acme.test', role: 'editor', expiresAt: new Date(Date.now() + 86_400_000).toISOString() };

/** The app-shell ASSERTIVE region (ADR 0363) — what a failed action sounds like.
 *  `ui/Notice.tsx:18` disclaims the inline role=alert, so this is the witness.
 *  Hosted in a DETACHED node so the sr-only copy never doubles a `screen.*`
 *  page query; the announcer is module-level, so a test snapshots the region
 *  BEFORE acting and asserts it CHANGED (`announce` alternates a zero-width
 *  marker on repeats, so a stale identical message cannot satisfy it). */
const liveHost = document.createElement('div');
const assertive = (): string => liveHost.querySelector('[data-owp-live="assertive"]')?.textContent ?? '';

const mount = async (): Promise<void> => {
  render(<GlobalLiveRegion />, { container: liveHost });
  render(<InvitesSection orgId="org:1" canManage assignableRoleIds={['viewer', 'editor', 'admin']} roleLabel={(r: string) => r} />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listInvites.mockResolvedValue([INVITE]);
  confirmMock.mockResolvedValue(true);
});

describe('R2 IN-SP-7 — the inviter list tells the truth', () => {
  it('a failed list read shows the warning + retry, never silently "no invites"', async () => {
    listInvites.mockRejectedValueOnce(new Error('http 500')).mockResolvedValueOnce([INVITE]);
    await mount();
    await screen.findByText(/couldn.t be loaded/i);
    expect(screen.queryByText(/http 500/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('bob@acme.test');
  });

  it('an EXPIRED row is labelled, not left looking pending', async () => {
    listInvites.mockResolvedValue([{ ...INVITE, expiresAt: new Date(Date.now() - 60_000).toISOString() }]);
    await mount();
    await screen.findByText('bob@acme.test');
    expect(screen.getByText(/expired/i)).toBeTruthy();
    expect(screen.queryByText(/expires/i)).toBeNull();
  });
});

describe('R2 IN-SP-1 — the undeliverable refusal reaches the operator as guidance', () => {
  it('a 422 {reason: undeliverable} renders the connect-a-sender copy, no raw API string', async () => {
    createInvite.mockRejectedValue(Object.assign(new Error('createInvite returned 422'), {
      status: 422, body: { details: { reason: 'undeliverable' } },
    }));
    await mount();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await screen.findByText(/set one up on the email page/i);
    expect(screen.queryByText(/returned 422/)).toBeNull();
    expect(toastSuccess).not.toHaveBeenCalled(); // the OLD bug: success over a zombie
  });
});

describe('review F4 — an invalid address gets fix-the-input copy, never retry-flavored', () => {
  it('a 400 {reason: invalid_email} renders the check-the-address message', async () => {
    createInvite.mockRejectedValue(Object.assign(new Error('createInvite returned 400'), {
      status: 400, body: { details: { reason: 'invalid_email' } },
    }));
    await mount();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'junk@nodot' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await screen.findByText(/doesn.t look like a valid email/i);
    expect(screen.queryByText(/couldn.t be created. try again/i)).toBeNull();
  });
});

describe('ORGINV-UX-7 — inviter-side action feedback reaches assistive tech', () => {
  it('(a) a create failure is ANNOUNCED through the shell region, assertively', async () => {
    createInvite.mockRejectedValue(new Error('boom'));
    await mount();
    const before = assertive();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await screen.findByText(/couldn.t be created/i);
    expect(assertive()).not.toBe(before);
    expect(assertive()).toContain('The invitation couldn’t be created. Try again.');
  });

  it('(b) a REJECTED address marks the input invalid and points it at the message; the next edit clears it', async () => {
    createInvite.mockRejectedValue(Object.assign(new Error('createInvite returned 400'), {
      status: 400, body: { details: { reason: 'invalid_email' } },
    }));
    await mount();
    const input = screen.getByLabelText(/email/i);
    expect(input.getAttribute('aria-invalid')).toBeNull();
    fireEvent.change(input, { target: { value: 'junk@nodot' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await screen.findByText(/doesn.t look like a valid email/i);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/doesn.t look like a valid email/i);
    // The flag describes the REJECTED value, not the field: editing lifts it.
    fireEvent.change(input, { target: { value: 'junk@nodot.example' } });
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });

  it('(b′) an UNDELIVERABLE refusal is not the address\'s fault — the input is NOT marked invalid', async () => {
    createInvite.mockRejectedValue(Object.assign(new Error('createInvite returned 422'), {
      status: 422, body: { details: { reason: 'undeliverable' } },
    }));
    await mount();
    const input = screen.getByLabelText(/email/i);
    fireEvent.change(input, { target: { value: 'new@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await screen.findByText(/set one up on the email page/i);
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(assertive()).toContain('couldn’t be delivered');
  });

  it('(c) a successful revoke gives a localized toast naming the address (toast.success announces)', async () => {
    revokeInvite.mockResolvedValue(undefined);
    await mount();
    await screen.findByText('bob@acme.test');
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    await act(async () => {});
    expect(revokeInvite).toHaveBeenCalledWith('org:1', 'inv1');
    expect(toastSuccess).toHaveBeenCalledWith('Invitation for bob@acme.test revoked.');
  });

  it('(c′) a FAILED revoke toasts nothing and announces the failure Notice', async () => {
    revokeInvite.mockRejectedValue(new Error('http 500'));
    await mount();
    await screen.findByText('bob@acme.test');
    const before = assertive();
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    await screen.findByText(/revoking the invitation failed/i);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(assertive()).not.toBe(before);
    expect(assertive()).toContain('Revoking the invitation failed.');
  });
});

describe('ORGINV-UX-9 — a pending row says WHO invited and WHEN it lapses, relatively', () => {
  it('surfaces createdByName from the wire and renders expiry as <time dateTime> with relative phrasing', async () => {
    const expiresAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    listInvites.mockResolvedValue([{ ...INVITE, expiresAt, createdByName: 'Ana Silva' }]);
    await mount();
    const container = document.body;
    await screen.findByText('bob@acme.test');
    expect(screen.getByText(/invited by Ana Silva/i)).toBeTruthy();
    const time = container.querySelector('li time');
    expect(time?.getAttribute('datetime')).toBe(expiresAt);
    expect(time?.textContent).toMatch(/expires in 3 days/i);
    // The absolute stamp is still reachable (title), not lost to the relative phrase.
    expect(time?.getAttribute('title')).toBeTruthy();
  });

  it('a row with no inviter recorded shows no "invited by" fragment', async () => {
    await mount();
    await screen.findByText('bob@acme.test');
    expect(screen.queryByText(/invited by/i)).toBeNull();
  });
});

describe('ORGINV-UX-10 — the submit uses Button loading (aria-busy), keeping its name', () => {
  it('in flight: aria-busy + disabled, the label is still "Send invite" (no "Inviting…" rename)', async () => {
    let resolveCreate: (v: { delivery: 'sent' }) => void = () => {};
    createInvite.mockReturnValue(new Promise((res) => { resolveCreate = res; }));
    await mount();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@acme.test' } });
    const btn = screen.getByRole('button', { name: /send invite/i }) as HTMLButtonElement;
    fireEvent.click(btn);
    await act(async () => {});
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.disabled).toBe(true);
    expect(screen.getByRole('button', { name: /send invite/i })).toBe(btn);
    expect(screen.queryByRole('button', { name: /inviting/i })).toBeNull();
    await act(async () => { resolveCreate({ delivery: 'sent' }); });
    expect(btn.getAttribute('aria-busy')).toBeNull();
  });
});

describe('review F5 — expiry is live, not serialization-time', () => {
  it('a row the server marked expired:false that has since lapsed still shows Expired + Resend', async () => {
    listInvites.mockResolvedValue([{ ...INVITE, expired: false, expiresAt: new Date(Date.now() - 60_000).toISOString() }]);
    await mount();
    await screen.findByText('bob@acme.test');
    expect(screen.getByText(/expired/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /resend/i })).toBeTruthy();
  });
});

describe('ORGINV-UX-1 — loading and true-empty are designed states, never "render nothing"', () => {
  it('shows a loading placeholder while the list read is in flight (a misread here invites a link-killing re-send)', async () => {
    let resolveList: (v: typeof INVITE[]) => void = () => {};
    listInvites.mockReturnValue(new Promise((res) => { resolveList = res; }));
    await mount();
    expect(screen.getByText(/loading pending invitations/i)).toBeTruthy();
    expect(screen.queryByText(/no pending invitations/i)).toBeNull(); // loading is NOT "empty"
    await act(async () => { resolveList([INVITE]); });
    expect(screen.queryByText(/loading pending invitations/i)).toBeNull();
    await screen.findByText('bob@acme.test');
  });

  it('a truly empty list says so', async () => {
    listInvites.mockResolvedValue([]);
    await mount();
    expect(screen.getByText(/no pending invitations/i)).toBeTruthy();
    expect(screen.queryByText(/loading pending invitations/i)).toBeNull();
  });
});

describe('ORGINV-UX-2 — an expired row offers a one-click Resend with the replace-at-mint consequence stated', () => {
  it('resends via createInvite with the SAME email + role after a confirm that names the consequence', async () => {
    listInvites.mockResolvedValue([{ ...INVITE, expiresAt: new Date(Date.now() - 60_000).toISOString() }]);
    createInvite.mockResolvedValue({ delivery: 'sent' });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /resend/i }));
    await act(async () => {});
    // The confirm body states the replace-at-mint consequence (old link dies).
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringMatching(/stops working/i),
    }));
    expect(createInvite).toHaveBeenCalledWith('org:1', 'bob@acme.test', 'editor');
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('a declined confirm resends nothing', async () => {
    listInvites.mockResolvedValue([{ ...INVITE, expiresAt: new Date(Date.now() - 60_000).toISOString() }]);
    confirmMock.mockResolvedValue(false);
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /resend/i }));
    await act(async () => {});
    expect(createInvite).not.toHaveBeenCalled();
  });

  it('a live (non-expired) row has no Resend', async () => {
    await mount();
    await screen.findByText('bob@acme.test');
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull();
  });
});

describe('ORGINV-UX-3 — a successful action retires the stale failure banner', () => {
  it('a failed create then a SUCCESSFUL revoke clears the create-failure Notice', async () => {
    createInvite.mockRejectedValueOnce(new Error('boom'));
    revokeInvite.mockResolvedValue(undefined);
    await mount();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await screen.findByText(/couldn.t be created/i);

    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    await act(async () => {});
    expect(revokeInvite).toHaveBeenCalledWith('org:1', 'inv1');
    expect(screen.queryByText(/couldn.t be created/i)).toBeNull(); // the stale banner is gone
  });

  it('a failed create then a SUCCESSFUL resend clears it too', async () => {
    listInvites.mockResolvedValue([{ ...INVITE, expiresAt: new Date(Date.now() - 60_000).toISOString() }]);
    createInvite.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ delivery: 'sent' });
    await mount();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@acme.test' } });
    // "Send invite" exactly — /send/i would also match the row's Resend button.
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await screen.findByText(/couldn.t be created/i);

    fireEvent.click(screen.getByRole('button', { name: /resend/i }));
    await act(async () => {});
    expect(screen.queryByText(/couldn.t be created/i)).toBeNull();
  });
});

describe('ADR 0564 D4 — a declined invitation is VISIBLE to the inviter', () => {
  const declinedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const DECLINED = { ...INVITE, status: 'declined' as const, declinedAt };

  it('renders a labelled Declined chip carrying declinedAt in its title, outranking Expired, with Revoke AND Resend', async () => {
    // Also expired — the decline is the more informative fact and wins.
    listInvites.mockResolvedValue([{ ...DECLINED, expiresAt: new Date(Date.now() - 60_000).toISOString() }]);
    await mount();
    await screen.findByText('bob@acme.test');
    const chip = screen.getByText(/^declined$/i);
    expect(chip.className).toContain('chip');
    expect(chip.getAttribute('title')).toBe(`Declined ${formatDateTime(declinedAt)}`);
    expect(screen.queryByText(/^expired$/i)).toBeNull();
    // Relative, visible without hover, in a <time dateTime> like the pending rows.
    const time = document.body.querySelector('li time');
    expect(time?.getAttribute('datetime')).toBe(declinedAt);
    expect(time?.textContent).toMatch(/declined 2 days ago/i);
    expect(screen.getByRole('button', { name: /revoke/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /resend/i })).toBeTruthy();
  });

  it('Resend on a declined row says the recipient declined the previous one, then mints as usual', async () => {
    listInvites.mockResolvedValue([DECLINED]);
    createInvite.mockResolvedValue({ delivery: 'sent' });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /resend/i }));
    await act(async () => {});
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringMatching(/declined the previous one/i),
    }));
    expect(confirmMock.mock.calls[0]?.[0]?.body).toMatch(/stops working/i); // the replace-at-mint consequence is still stated
    expect(createInvite).toHaveBeenCalledWith('org:1', 'bob@acme.test', 'editor');
  });

  it('a pending row keeps the plain Resend copy (no false "they declined")', async () => {
    listInvites.mockResolvedValue([{ ...INVITE, expiresAt: new Date(Date.now() - 60_000).toISOString() }]);
    createInvite.mockResolvedValue({ delivery: 'sent' });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /resend/i }));
    await act(async () => {});
    expect(confirmMock.mock.calls[0]?.[0]?.body).not.toMatch(/declined/i);
  });
});

describe('ADR 0622 D5 — a failed re-invite says the EARLIER invitation is still valid, never "nothing was kept"', () => {
  it('422 {reason: delivery_failed, priorInviteStillValid: true}', async () => {
    createInvite.mockRejectedValue(Object.assign(new Error('createInvite returned 422'), {
      status: 422, body: { details: { reason: 'delivery_failed', cause: 'send_failed', priorInviteStillValid: true } },
    }));
    await mount();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'bob@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await screen.findByText(/earlier invitation for this address may still be valid/i);
    expect(screen.queryByText(/nothing was kept/i)).toBeNull();
    expect(assertive()).toContain('may still be valid');
  });

  it('422 {reason: undeliverable, priorInviteStillValid: true} keeps the configuration guidance AND the prior-valid fact', async () => {
    createInvite.mockRejectedValue(Object.assign(new Error('createInvite returned 422'), {
      status: 422, body: { details: { reason: 'undeliverable', cause: 'no_connection', priorInviteStillValid: true } },
    }));
    await mount();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'bob@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    const notice = await screen.findByText(/earlier invitation for this address may still be valid/i);
    expect(notice.textContent).toMatch(/email page/i);
  });

  it('without the flag the existing copy is unchanged (a first invite that failed really kept nothing)', async () => {
    createInvite.mockRejectedValue(Object.assign(new Error('createInvite returned 422'), {
      status: 422, body: { details: { reason: 'delivery_failed', cause: 'send_failed' } },
    }));
    await mount();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await screen.findByText(/nothing was kept/i);
    expect(screen.queryByText(/still valid/i)).toBeNull();
  });
});
