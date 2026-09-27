/**
 * SHARE-UX-1/2/3 — the three ways this surface lied about DEAD links.
 *
 * Each block below pins one of them, and each names what it does NOT cover:
 *  - SHARE-UX-1: an orphaned link (row alive, resource deleted) told the
 *    recipient "may have been revoked by its owner" while the owner's list still
 *    filed it under "Active links". Covered on BOTH sides. Not covered: the
 *    server's own `reason` emission (backend `sharing-rekey-migration` and
 *    `sharing-erasure-retention` own that).
 *  - SHARE-UX-2: expired links rendered under a heading asserting they were
 *    active, with the words "expires <past date>" beneath. Covered: the
 *    partition + the chip. Not covered: the collapsed section's own a11y.
 *  - SHARE-UX-3: "URL copied to your clipboard" was claimed unconditionally.
 *    Covered: the SharingPage mint. The canvas chassis and chat paths route
 *    through the same shared helper but are asserted by their own suites'
 *    absence of `navigator.clipboard.writeText` — stated so the gap is visible
 *    rather than implied.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';

const { listOrgs, listLinks, listResources, createLink, revokeLink } = vi.hoisted(() => ({
  listOrgs: vi.fn(), listLinks: vi.fn(), listResources: vi.fn(), createLink: vi.fn(), revokeLink: vi.fn(),
}));
vi.mock('../sharingClient.js', async (orig) => ({
  ...(await orig<typeof import('../sharingClient.js')>()),
  listOrgs, listLinks, listResources, createLink, revokeLink,
}));

const { toastSuccess, toastError, toastWarning } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn(), toastWarning: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: toastError, warning: toastWarning } }));
const copyMock = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as { ok: boolean }));
vi.mock('../../../ui/copyToClipboard.js', () => ({ copyToClipboard: copyMock }));
const confirmFn = vi.hoisted(() => vi.fn());
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmFn, ConfirmRoot: () => null }));

import { SharingPage } from '../SharingPage.js';
import { linkStatus, isLinkLive, type ShareLink } from '../sharingClient.js';

const ORG = { orgId: 'o1', name: 'Acme' };
const base = {
  resourceType: 'cms_page' as const, resourceId: 'p1',
  createdAt: '2026-08-01T09:00:00.000Z', revoked: false,
};
const PAST = '2026-08-03T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

const mount = async (): Promise<void> => {
  render(<SharingPage />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  copyMock.mockResolvedValue({ ok: true });
  listOrgs.mockResolvedValue([ORG]);
  listResources.mockResolvedValue([{ id: 'r1', label: 'Q3 deck' }]);
});

describe('SHARE-UX-2 — link status is derived, not assumed', () => {
  it('classifies revoked / expired / expiring / orphaned / live, in that precedence', () => {
    const now = Date.parse('2026-08-18T00:00:00.000Z');
    const s = (l: Partial<ShareLink>): string => linkStatus({ ...base, tokenHash: 'h', ...l } as ShareLink, now);
    // Revocation is deliberate and outranks a lapsed clock.
    expect(s({ revoked: true, expiresAt: PAST })).toBe('revoked');
    expect(s({ expiresAt: PAST })).toBe('expired');
    // An UNPARSEABLE expiry reads as expired — the server's own fail-closed
    // branch. A row must never claim to work where the resolver would refuse.
    expect(s({ expiresAt: 'not-a-date' })).toBe('expired');
    expect(s({ expiresAt: '2026-08-20T00:00:00.000Z' })).toBe('expiring');
    expect(s({ expiresAt: FUTURE })).toBe('live');
    expect(s({ resourceMissing: true })).toBe('orphaned');
    // An orphan still RESOLVES the gate (and then 404s), so it counts as live
    // for the "which of these are still out there?" question.
    expect(isLinkLive({ ...base, tokenHash: 'h', resourceMissing: true } as ShareLink, now)).toBe(true);
    expect(isLinkLive({ ...base, tokenHash: 'h', expiresAt: PAST } as ShareLink, now)).toBe(false);
  });

  // SHUX-5 — the ONE dead state this file did not cover, and the file's own
  // docblock says it exists to stop the row answering "which of these still
  // work?" wrongly in the non-conservative direction. A link at its view cap is
  // refused by the server on EVERY public lane (ADR 0644 D2 + D8 closed the card
  // and frame-view lanes), yet `linkStatus` never compared viewCount to maxViews,
  // so the row rendered a green Live chip under "Active links" and invited the
  // owner to re-send a URL that 404s.
  it('a link at its VIEW CAP is not live, and outranks the soft states', () => {
    const now = Date.parse('2026-08-18T00:00:00.000Z');
    const s = (l: Partial<ShareLink>): string => linkStatus({ ...base, tokenHash: 'h', ...l } as ShareLink, now);
    expect(s({ viewCount: 3, maxViews: 3 })).toBe('cap-reached');
    expect(s({ viewCount: 4, maxViews: 3 })).toBe('cap-reached');   // over, defensively
    // Non-vacuity in both directions: under the cap, and no cap at all.
    expect(s({ viewCount: 2, maxViews: 3 })).toBe('live');
    expect(s({ viewCount: 99 })).toBe('live');
    // Terminal states still outrank it — re-enabling nothing brings those back.
    expect(s({ viewCount: 3, maxViews: 3, revoked: true })).toBe('revoked');
    expect(s({ viewCount: 3, maxViews: 3, expiresAt: PAST })).toBe('expired');
    // …and it outranks the REVERSIBLE ones, because the server refuses it today.
    expect(s({ viewCount: 3, maxViews: 3, featureDisabled: true })).toBe('cap-reached');
    expect(isLinkLive({ ...base, tokenHash: 'h', viewCount: 3, maxViews: 3 } as ShareLink, now)).toBe(false);
  });

  it('an EXPIRED link is out of "Active links" and reads in the past tense', async () => {
    listLinks.mockResolvedValue([
      { ...base, tokenHash: 'dead', label: 'Lapsed preview', expiresAt: PAST },
      { ...base, tokenHash: 'alive', label: 'Working preview', expiresAt: FUTURE },
    ]);
    await mount();

    // The live one is on screen with a Live chip…
    await screen.findByText('Working preview');
    expect(screen.getByText(/^Live$/)).toBeTruthy();
    // …and the expired one is NOT rendered among the active rows. Before the
    // fix it sat right there, captioned "expires 3 Aug 2026".
    expect(screen.queryByText('Lapsed preview')).toBeNull();
    // Exactly ONE row is rendered, and it is the live one — the expired row is
    // not merely de-emphasised, it is not in the active list at all. (Counted
    // by the per-row revoke control; the mint form's "Expires in days" LABEL
    // also matches a naive /expires/ text query, which is why this counts rows.)
    expect(screen.getAllByRole('button', { name: /^revoke$/i })).toHaveLength(1);
    expect(screen.queryByText(/^Expired$/)).toBeNull();

    // It is not hidden either — the owner can open the dead section and see WHY.
    fireEvent.click(screen.getByRole('button', { name: /expired and revoked links \(1\)/i }));
    await screen.findByText('Lapsed preview');
    expect(screen.getByText(/^Expired$/)).toBeTruthy();
    // The caption is now past tense ("expired <date>"), where it used to
    // promise a future expiry for a date that had already passed. Matched by
    // shape (a date follows) so the locale's format is not asserted.
    expect(screen.getAllByText(/^expired\s+\S+\s*\d/i).length).toBeGreaterThan(0);
  });
});

describe('SHARE-UX-1 — an orphaned link is named on the owner’s side', () => {
  it('marks the row and explains what the recipient sees', async () => {
    listLinks.mockResolvedValue([{ ...base, tokenHash: 'orph', resourceId: 'page-9f3c', resourceMissing: true }]);
    await mount();
    // It used to render the raw opaque id with no marker of any kind.
    await screen.findByText(/^Content deleted$/);
    expect(screen.getByText(/no longer exists/i)).toBeTruthy();
  });
});

describe('SHARE-1 HONESTY — a link whose OWNING FEATURE is off is not “Live”', () => {
  it('takes the status, the chip and an explanation — and leaves the Active list', async () => {
    // R2 review F1. SHARE-1 made `document`, `commerce_*` and `creative_brief`
    // darkenable, so `resolveActiveLink` now 404s those tokens while the toggle
    // is off. The server computed that boolean and discarded it, so this row
    // rendered `chip--success` "Live" — the owner's half of the same lie the
    // recipient's half of this suite pins.
    //
    // What this discriminates: the status derivation, the row copy, and the
    // Active/dead partition. It does NOT discriminate the server's emission of
    // `featureDisabled` (`sharing-owning-feature-gate.test.ts` owns that).
    const now = Date.parse('2026-08-18T00:00:00.000Z');
    const s = (l: Partial<ShareLink>): string => linkStatus({ ...base, tokenHash: 'h', ...l } as ShareLink, now);
    expect(s({ featureDisabled: true })).toBe('feature-off');
    // It does NOT outrank the two TERMINAL states — re-enabling the feature
    // would not bring a revoked or lapsed link back, so those still win.
    expect(s({ featureDisabled: true, revoked: true })).toBe('revoked');
    expect(s({ featureDisabled: true, expiresAt: PAST })).toBe('expired');
    // …but it DOES outrank every state that claims the link works. An
    // expires-soon link that is currently darkened is not "Expires soon".
    expect(s({ featureDisabled: true, expiresAt: '2026-08-20T00:00:00.000Z' })).toBe('feature-off');
    expect(s({ featureDisabled: true, expiresAt: FUTURE })).toBe('feature-off');
    expect(isLinkLive({ ...base, tokenHash: 'h', featureDisabled: true } as ShareLink, now)).toBe(false);

    listLinks.mockResolvedValue([
      { ...base, resourceType: 'document', tokenHash: 'off', label: 'Q3 SOW', featureDisabled: true },
      { ...base, tokenHash: 'alive', label: 'Working preview' },
    ]);
    await mount();

    // Not under "Active links" — that heading was asserting the opposite.
    await screen.findByText('Working preview');
    expect(screen.queryByText('Q3 SOW')).toBeNull();
    expect(screen.queryByText(/^Feature turned off$/)).toBeNull();

    // …and in the dead section it says what happened and how to undo it.
    fireEvent.click(screen.getByRole('button', { name: /expired and revoked links \(1\)/i }));
    await screen.findByText('Q3 SOW');
    expect(screen.getByText(/^Feature turned off$/)).toBeTruthy();
    expect(screen.getByText(/turn the feature back on/i)).toBeTruthy();
  });
});

describe('SHARE-UX-3 — the copy claim depends on the copy', () => {
  it('a FAILED clipboard write never produces "copied", and the URL stays on screen', async () => {
    createLink.mockResolvedValue({ ...base, tokenHash: 'h2', token: 'raw-token-xyz' });
    listLinks.mockResolvedValue([]);
    copyMock.mockResolvedValue({ ok: false });
    await mount();
    fireEvent.change(screen.getByLabelText(/resource$/i), { target: { value: 'r1' } });
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));

    await waitFor(() => expect(toastWarning).toHaveBeenCalled());
    // R2 review F6 — the VARIANT is part of the claim. A failure reported through
    // `toast.success` is a green tick that auto-dismisses in 4s; the words said
    // "could NOT be copied" while the channel said the opposite, on the one
    // message the user has to act on before the token is unrecoverable.
    expect(toastSuccess, 'a failed copy must not be reported as a success').not.toHaveBeenCalled();
    const said = toastWarning.mock.calls.map((c) => String(c[0])).join(' | ');
    expect(said, 'the app must not claim a copy it did not make').not.toMatch(/copied to your clipboard/i);
    expect(said).toMatch(/could NOT be copied/i);
    // The unrepeatable token (ADR 0448 P2) is still recoverable by hand.
    expect(screen.getByText(/raw-token-xyz/)).toBeTruthy();
    expect(screen.getByText(/copy this link manually/i)).toBeTruthy();
  });

  it('a SUCCESSFUL write is still allowed to say so', async () => {
    createLink.mockResolvedValue({ ...base, tokenHash: 'h3', token: 'raw-token-ok' });
    listLinks.mockResolvedValue([]);
    copyMock.mockResolvedValue({ ok: true });
    await mount();
    fireEvent.change(screen.getByLabelText(/resource$/i), { target: { value: 'r1' } });
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(String(toastSuccess.mock.calls[0]![0])).toMatch(/copied to your clipboard/i);
  });
});
