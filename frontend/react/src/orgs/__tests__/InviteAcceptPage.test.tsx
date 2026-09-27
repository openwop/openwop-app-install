/**
 * UX_UPGRADE-invitations — the accept page (IN-G1..IN-G4).
 *
 * The property that matters most is a NEGATIVE one: merely loading this page
 * must not join you to anything. The old flow redeemed the token in a mount
 * effect, so anything that followed the link — a mail-client link scanner, a
 * chat unfurler, a browser prefetch — silently accepted on the recipient's
 * behalf. Joining an organisation now takes a deliberate click.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const previewInvite = vi.fn();
const acceptInvite = vi.fn();
const declineInvitation = vi.fn();
// The real module is spread so the typed-error helper (`inviteErrorDetails`)
// is the shipped one — a test that re-implements it would pin its own copy.
vi.mock('../invitesClient.js', async (orig) => ({
  ...(await orig<typeof import('../invitesClient.js')>()),
  previewInvite: (...a: unknown[]) => previewInvite(...a),
  acceptInvite: (...a: unknown[]) => acceptInvite(...a),
  declineInvitation: (...a: unknown[]) => declineInvitation(...a),
}));
// ADR 0564 D3 — Decline is confirm-gated; the dialog host is not mounted here.
const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
vi.mock('../../ui/confirm.js', () => ({ confirm: confirmMock }));

const listMyWorkspaces = vi.fn();
const switchWorkspace = vi.fn();
vi.mock('../../client/workspaceClient.js', () => ({
  listMyWorkspaces: (...a: unknown[]) => listMyWorkspaces(...a),
  switchWorkspace: (...a: unknown[]) => switchWorkspace(...a),
}));

const useAuth = vi.fn();
vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => useAuth() }));
vi.mock('../../auth/SignInButton.js', () => ({ SignInButton: () => <button type="button">Sign in</button> }));

// ORGINV-UX-11 — the in-card "Switch account" runs the SAME sign-out triple the
// header menu does (Firebase session + backend cookie + shared session store).
const { firebaseSignOut, backendLogout, setBackendSessionUser } = vi.hoisted(() => ({
  firebaseSignOut: vi.fn(), backendLogout: vi.fn(), setBackendSessionUser: vi.fn(),
}));
vi.mock('../../auth/firebase.js', async (orig) => ({
  ...(await orig<typeof import('../../auth/firebase.js')>()),
  signOut: firebaseSignOut,
}));
vi.mock('../../features/users/usersClient.js', async (orig) => ({
  ...(await orig<typeof import('../../features/users/usersClient.js')>()),
  logout: backendLogout,
}));
vi.mock('../../auth/backendSession.js', async (orig) => ({
  ...(await orig<typeof import('../../auth/backendSession.js')>()),
  setBackendSessionUser,
}));

const { InviteAcceptPage } = await import('../InviteAcceptPage.js');
const { GlobalLiveRegion } = await import('../../ui/announce.js');

/** The app-shell live regions (ADR 0363) — what a screen reader actually hears.
 *  Asserting THESE, not a `role` attribute, is the #2615/#2616 lesson. Hosted in
 *  a DETACHED node so the sr-only copy of a message never doubles a page query
 *  (`screen.*` searches document.body). The announcer is module-level state, so
 *  a test snapshots the region BEFORE acting and asserts it CHANGED: `announce`
 *  alternates a zero-width marker on a repeat, so even the same text twice is a
 *  new value — a stale message from an earlier test cannot satisfy this. */
const liveHost = document.createElement('div');
const assertive = (): string => liveHost.querySelector('[data-owp-live="assertive"]')?.textContent ?? '';
const polite = (): string => liveHost.querySelector('[data-owp-live="polite"]')?.textContent ?? '';

const PREVIEW = { orgId: 'org:1', orgName: 'Acme', role: 'editor', email: 'bob@acme.test', expiresAt: '2026-08-01T00:00:00.000Z' };

const signedIn = () => useAuth.mockReturnValue({ user: { userId: 'u1', email: 'bob@acme.test' }, loading: false });
const signedOut = () => useAuth.mockReturnValue({ user: null, loading: false });

const renderPage = (token = 'tok') => {
  render(<GlobalLiveRegion />, { container: liveHost });
  return render(<MemoryRouter initialEntries={[`/invitations/accept?token=${token}`]}><InviteAcceptPage /></MemoryRouter>);
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.head.querySelector('meta[name="robots"]')?.remove();
});

describe('invitation accept — loading the page never joins anything (IN-G2)', () => {
  it('previews and WAITS for an explicit click', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    acceptInvite.mockResolvedValue({ orgId: 'org:1' });
    renderPage();

    await screen.findByText(/Join Acme/i);
    // The whole point: nothing has been redeemed yet.
    expect(acceptInvite).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }));
    await waitFor(() => expect(acceptInvite).toHaveBeenCalledWith('tok'));
    await screen.findByText(/now a member of Acme/i);
  });

  it('shows WHAT is being joined — org, role, invited address and expiry', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    const { container } = renderPage();
    await screen.findByText(/Join Acme/i);
    expect(screen.getByText(/join as editor/i)).toBeTruthy();
    expect(screen.getByText(/bob@acme.test/)).toBeTruthy();
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-01T00:00:00.000Z');
  });

  it('a double-click cannot redeem twice', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    acceptInvite.mockReturnValue(new Promise(() => { /* never settles */ }));
    renderPage();
    await screen.findByText(/Join Acme/i);
    const btn = screen.getByRole('button', { name: /accept invitation/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(acceptInvite).toHaveBeenCalledTimes(1);
    // ORGINV-UX-10 — in flight the control is aria-busy + disabled and KEEPS
    // its accessible name (no "Accepting…" rename, no bare spinner).
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /accept invitation/i })).toBe(btn);
  });
});

describe('ORGINV-UX-6 — the outcome of Accept is SPOKEN and focus is placed, not dropped', () => {
  it('done: the title reaches the ASSERTIVE shell region and focus lands on the org CTA', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    acceptInvite.mockResolvedValue({ orgId: 'org:1' });
    renderPage();
    await screen.findByText(/Join Acme/i);
    const before = assertive();
    fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }));
    await screen.findByText(/now a member of Acme/i);
    // User-initiated → assertive (a polite queue could swallow it behind other chatter).
    expect(assertive()).not.toBe(before);
    expect(assertive()).toContain('You have joined the organization');
    expect(polite()).not.toContain('You have joined');
    // The Accept button unmounted; focus must NOT be on <body>.
    const cta = screen.getByRole('link', { name: /open acme/i });
    await waitFor(() => expect(document.activeElement).toBe(cta));
  });

  it('already-member: its own title is announced and its CTA focused', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    acceptInvite.mockResolvedValue({ memberId: 'm1', orgId: PREVIEW.orgId, alreadyMember: true });
    renderPage();
    await screen.findByText(/Join Acme/i);
    const before = assertive();
    fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }));
    await screen.findByText(/already a member/i);
    expect(assertive()).not.toBe(before);
    expect(assertive()).toContain('You’re already a member');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: /open acme/i })));
  });

  it('a GENERIC failure is announced assertively and Accept is re-enabled AND refocused', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    acceptInvite.mockRejectedValue(Object.assign(new Error('http 500'), { status: 500 }));
    renderPage();
    await screen.findByText(/Join Acme/i);
    const btn = screen.getByRole('button', { name: /accept invitation/i });
    const before = assertive();
    fireEvent.click(btn);
    await screen.findByText(/may be expired, revoked/i);
    expect(assertive()).not.toBe(before);
    expect(assertive()).toContain('The invitation may be expired, revoked, or issued to a different email address.');
    // `loading` disabled the button (which drops focus); a retryable failure
    // hands it back so the keyboard user is one Enter from retrying.
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(btn));
  });
});

describe('invitation accept — signed out (IN-G1)', () => {
  it('still shows what the invitation IS before asking anyone to sign in', async () => {
    signedOut();
    previewInvite.mockResolvedValue(PREVIEW);
    renderPage();
    // The preview read is unauthenticated by design, so a recipient can decide
    // whether creating an account is even worth it.
    await screen.findByText(/Join Acme/i);
    expect(screen.getByText(/join as editor/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy();
    expect(acceptInvite).not.toHaveBeenCalled();
  });
});

describe('invitation accept — failure states (IN-G3/IN-G4)', () => {
  it('marks the page noindex and restores the head on unmount', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    const v = renderPage();
    await screen.findByText(/Join Acme/i);
    await waitFor(() => expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex,nofollow'));
    v.unmount();
    await waitFor(() => expect(document.head.querySelector('meta[name="robots"]')).toBeNull());
  });

  it('explains an email mismatch instead of printing the raw API error', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    // R2 IN-SP-10 — the page discriminates by STATUS (403 = the ownership
    // gate), never by matching English prose; the mock carries the real shape.
    acceptInvite.mockRejectedValue(Object.assign(new Error('acceptInvite returned 403'), { status: 403 }));
    renderPage();
    await screen.findByText(/Join Acme/i);
    const before = assertive();
    fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }));

    await screen.findByText(/sent to a different email address/i);
    // The developer-facing string must not reach the page.
    expect(screen.queryByText(/returned 403/)).toBeNull();
    // ORGINV-UX-6 — the failure is SPOKEN (assertive: the user just acted).
    expect(assertive()).not.toBe(before);
    expect(assertive()).toContain('This invitation was sent to a different email address.');
    // ORGINV-UX-11 — the SAME account cannot succeed, so Accept stays disabled
    // and the recovery action lives IN the card, taking focus.
    expect((screen.getByRole('button', { name: /accept invitation/i }) as HTMLButtonElement).disabled).toBe(true);
    const switchBtn = screen.getByRole('button', { name: /switch account/i });
    await waitFor(() => expect(document.activeElement).toBe(switchBtn));
  });

  it('ORGINV-UX-11 — Switch account signs out the way the header menu does and STAYS on the token URL', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    acceptInvite.mockRejectedValue(Object.assign(new Error('acceptInvite returned 403'), { status: 403 }));
    firebaseSignOut.mockResolvedValue(undefined);
    backendLogout.mockResolvedValue(undefined);
    renderPage();
    await screen.findByText(/Join Acme/i);
    fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }));
    await screen.findByText(/sent to a different email address/i);

    fireEvent.click(screen.getByRole('button', { name: /switch account/i }));
    await waitFor(() => expect(backendLogout).toHaveBeenCalledTimes(1));
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);
    expect(setBackendSessionUser).toHaveBeenCalledWith(null);
    // No navigation: the preview (token still in the URL) is what the next
    // sign-in resumes on — the mismatch banner and its disabled Accept are gone.
    await waitFor(() => expect(screen.queryByText(/sent to a different email address/i)).toBeNull());
    expect(screen.getByText(/Join Acme/i)).toBeTruthy();
    expect(previewInvite).toHaveBeenCalledTimes(1); // no reload, no re-read
    expect((screen.getByRole('button', { name: /accept invitation/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a revoked/used token (4xx) lands on the GONE state — with its actionable next step', async () => {
    signedIn();
    previewInvite.mockRejectedValue(Object.assign(new Error('gone'), { status: 400 }));
    renderPage();
    // The old assertion here matched /invitation/i — which every state the
    // page can render contains (near-vacuous, flagged by the R2 source grade).
    // Assert the SPECIFIC state and its recovery copy instead.
    await screen.findByText(/no longer valid/i);
    expect(screen.getByText(/ask the person who invited you/i)).toBeTruthy();
    expect(acceptInvite).not.toHaveBeenCalled();
  });

  it('R2 IN-SP-2/8 — an EXPIRED invite says expired; a 500 gets RETRY, never a dead-link claim', async () => {
    signedIn();
    previewInvite.mockRejectedValue(Object.assign(new Error('expired'), { status: 400, body: { details: { reason: 'expired' } } }));
    renderPage();
    await screen.findByText(/invitation has expired/i);

    cleanup();
    previewInvite
      .mockRejectedValueOnce(Object.assign(new Error('http 500'), { status: 500 }))
      .mockResolvedValueOnce(PREVIEW);
    renderPage();
    await screen.findByText(/couldn.t load this invitation/i);
    expect(screen.queryByText(/no longer valid|missing its token/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText(/Join Acme/i);
  });

  it('R2 IN-SP-3/13 — already-a-member renders its own state; the done CTA lands IN the org', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    acceptInvite.mockResolvedValue({ memberId: 'm1', orgId: PREVIEW.orgId, alreadyMember: true });
    renderPage();
    await screen.findByText(/Join Acme/i);
    fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }));
    await screen.findByText(/already a member/i);
    // ORGINV-UX-4 — the CTA names the org it opens, not generic "Organizations".
    const cta = screen.getByRole('link', { name: /open acme/i }) as HTMLAnchorElement;
    expect(cta.getAttribute('href')).toContain(`org=${encodeURIComponent(PREVIEW.orgId)}`);
  });

  it('R2 IN-R2-1 — the preview names the inviter when the wire carries one', async () => {
    signedIn();
    previewInvite.mockResolvedValue({ ...PREVIEW, invitedBy: 'Ana Silva' });
    renderPage();
    await screen.findByText(/Ana Silva invited you/i);
  });
});

describe('R3 (F9 follow-on) — a cross-workspace accept switches the ACTIVE workspace, or says why it cannot', () => {
  const acceptedInWs = { orgId: 'org:1', tenantId: 'ws:design', memberId: 'm1' };

  it('same-workspace accept keeps the plain link CTA and asks the workspace list NOTHING extra it does not need', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    acceptInvite.mockResolvedValue({ ...acceptedInWs, tenantId: 'ws:design' });
    listMyWorkspaces.mockResolvedValue({ active: 'ws:design', workspaces: [{ workspaceId: 'ws:design', name: 'Design', kind: 'shared' }] });
    renderPage();
    await screen.findByText(/Join Acme/i);
    fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }));
    await screen.findByText(/now a member of Acme/i);
    // Active matches → the ordinary link (org-named, ORGINV-UX-4), no switch disclosure.
    expect(screen.getByRole('link', { name: /open acme/i })).toBeTruthy();
    expect(screen.queryByText(/switch your active workspace/i)).toBeNull();
    expect(switchWorkspace).not.toHaveBeenCalled();
  });

  it('a DIFFERENT shared workspace the caller belongs to: the CTA switches first, then lands in the org', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    acceptInvite.mockResolvedValue(acceptedInWs);
    listMyWorkspaces.mockResolvedValue({ active: 'user:me', workspaces: [{ workspaceId: 'ws:design', name: 'Design Team', kind: 'shared' }] });
    switchWorkspace.mockResolvedValue({ ok: true, active: 'ws:design' });
    const assign = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, 'location', { value: { ...orig, assign }, writable: true, configurable: true });
    try {
      renderPage();
      await screen.findByText(/Join Acme/i);
      fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }));
      await screen.findByText(/now a member of Acme/i);
      // The disclosure names the workspace; the CTA is a BUTTON, not a bare link.
      expect(screen.getByText(/Design Team workspace/i)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /open acme/i }));
      await waitFor(() => expect(switchWorkspace).toHaveBeenCalledWith('ws:design'));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/orgs?org=org%3A1'));
    } finally {
      Object.defineProperty(window, 'location', { value: orig, writable: true, configurable: true });
    }
  });

  it('a workspace the caller CANNOT open: no dead CTA — the honest ask-for-access copy instead', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    acceptInvite.mockResolvedValue(acceptedInWs);
    listMyWorkspaces.mockResolvedValue({ active: 'user:me', workspaces: [] });
    renderPage();
    await screen.findByText(/Join Acme/i);
    fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }));
    await screen.findByText(/now a member of Acme/i);
    expect(screen.getByText(/cannot open yet/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /open (acme|organizations)/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /open (acme|organizations)/i })).toBeNull();
    // ORGINV-UX-6 — with no CTA to take focus, the card itself does (never <body>).
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.textContent).toContain('You have joined the organization');
  });

  it('a failed workspace read falls back to the plain CTA — the courtesy layer never blocks the accept', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    acceptInvite.mockResolvedValue(acceptedInWs);
    listMyWorkspaces.mockRejectedValue(new Error('offline'));
    renderPage();
    await screen.findByText(/Join Acme/i);
    fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }));
    await screen.findByText(/now a member of Acme/i);
    expect(screen.getByRole('link', { name: /open acme/i })).toBeTruthy();
  });
});

describe('ADR 0564 D3 — Decline is a deliberate, confirmed act with a terminal state the recipient hears', () => {
  it('a cancelled confirm declines NOTHING; a confirmed one POSTs the token — the confirm is danger-styled and names the org', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    declineInvitation.mockResolvedValue({ inviteId: 'inv1', orgId: 'org:1', status: 'declined', declinedAt: '2026-09-02T00:00:00.000Z' });
    confirmMock.mockResolvedValueOnce(false);
    renderPage();
    await screen.findByText(/Join Acme/i);
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({
      danger: true,
      title: expect.stringMatching(/Acme/),
      body: expect.stringMatching(/invite you again/i),
    }));
    expect(declineInvitation).not.toHaveBeenCalled();
    expect(screen.getByText(/Join Acme/i)).toBeTruthy(); // still on the preview

    confirmMock.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    await waitFor(() => expect(declineInvitation).toHaveBeenCalledWith('tok'));
    await screen.findByText(/you declined this invitation/i);
    // Nothing was accepted along the way, and the undo path is stated.
    expect(acceptInvite).not.toHaveBeenCalled();
    expect(screen.getByText(/not a member of Acme/i)).toBeTruthy();
    expect(screen.getByText(/ask them to re-invite you/i)).toBeTruthy();
  });

  it('the declined state is announced ASSERTIVELY and takes focus (the Decline button unmounted; never <body>)', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    declineInvitation.mockResolvedValue({ inviteId: 'inv1', orgId: 'org:1', status: 'declined', declinedAt: '2026-09-02T00:00:00.000Z' });
    confirmMock.mockResolvedValue(true);
    renderPage();
    await screen.findByText(/Join Acme/i);
    const before = assertive();
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    await screen.findByText(/you declined this invitation/i);
    expect(assertive()).not.toBe(before);
    expect(assertive()).toContain('You declined this invitation');
    expect(polite()).not.toContain('You declined');
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.textContent).toContain('You declined this invitation');
    // Terminal: no Accept left to click.
    expect(screen.queryByRole('button', { name: /accept invitation/i })).toBeNull();
  });

  it('a preview that answers `reason: declined` lands on the declined terminal state, not the generic "gone"', async () => {
    signedIn();
    previewInvite.mockRejectedValue(Object.assign(new Error('declined'), { status: 400, body: { details: { reason: 'declined' } } }));
    renderPage();
    await screen.findByText(/you declined this invitation/i);
    expect(screen.getByText(/ask them to re-invite you/i)).toBeTruthy();
    expect(screen.queryByText(/no longer valid/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /accept invitation/i })).toBeNull();
    expect(acceptInvite).not.toHaveBeenCalled();
    expect(declineInvitation).not.toHaveBeenCalled();
  });

  it('signed OUT: no Decline button — the copy says declining needs sign-in too (ADR 0564 D2)', async () => {
    signedOut();
    previewInvite.mockResolvedValue(PREVIEW);
    renderPage();
    await screen.findByText(/Join Acme/i);
    expect(screen.queryByRole('button', { name: /^decline$/i })).toBeNull();
    expect(screen.getByText(/declining also needs you to sign in/i)).toBeTruthy();
  });
});

describe('ADR 0622 D7 — a self-set (unverified) address is refused with its ONE actionable step', () => {
  it('403 {reason: email_unverified} on accept: the admin/IdP guidance, both actions disabled, Switch account focused', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    acceptInvite.mockRejectedValue(Object.assign(new Error('acceptInvite returned 403'), {
      status: 403, body: { details: { reason: 'email_unverified' } },
    }));
    renderPage();
    await screen.findByText(/Join Acme/i);
    const before = assertive();
    fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }));
    await screen.findByText(/set by you and isn.t verified/i);
    expect(screen.getByText(/sign in through your identity provider so your verified address is used/i)).toBeTruthy();
    // USERS-20 review B1 — a personal-tenant user HAS no workspace administrator; the copy must not point at one.
    expect(screen.queryByText(/workspace administrator/i)).toBeNull();
    // It is NOT the mismatch copy — the address matched; provenance failed.
    expect(screen.queryByText(/sent to a different email address/i)).toBeNull();
    expect(screen.queryByText(/returned 403/)).toBeNull();
    expect(assertive()).not.toBe(before);
    expect(assertive()).toContain('isn’t verified');
    expect((screen.getByRole('button', { name: /accept invitation/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^decline$/i }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /switch account/i })));
  });

  it('the same gate on DECLINE gets the same state (the decline gate IS the accept gate)', async () => {
    signedIn();
    previewInvite.mockResolvedValue(PREVIEW);
    confirmMock.mockResolvedValue(true);
    declineInvitation.mockRejectedValue(Object.assign(new Error('declineInvitation returned 403'), {
      status: 403, body: { details: { reason: 'email_unverified' } },
    }));
    renderPage();
    await screen.findByText(/Join Acme/i);
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    await screen.findByText(/set by you and isn.t verified/i);
    expect(screen.queryByText(/you declined this invitation/i)).toBeNull();
    expect(screen.getByRole('button', { name: /switch account/i })).toBeTruthy();
  });
});
