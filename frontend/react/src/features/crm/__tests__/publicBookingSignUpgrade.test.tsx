/**
 * UX_UPGRADE-crm-public — the visitor-facing booking + signing upgrades.
 *
 * The load-bearing behaviours: times render in the VISITOR's zone by default
 * (a slot is a UTC instant, so only the rendering changes — but rendering the
 * host's zone to someone in another country is how cross-timezone bookings go
 * wrong), and a signer ends up holding a copy of what they signed, dated by the
 * SERVER, not by their own clock.
 *
 * Gap ids: B-G1 / B-G2 / S-G1 in `docs/steward/UX_UPGRADE-crm-public.md`.
 * Sabotage-witnessed (wave-4 /grade-tests, w4g5-pb-* / w4g5-ps-*): the zone
 * options ordered host-first, the switcher shown for a single zone, the name
 * error never set, `signedAt` taken from the client clock, the copy offered
 * without a server instant, and the copy offered after a DECLINE each turn a
 * case red. (The declined case used to never decline — it asserted the
 * pre-action page, which holds no link either, so it could not fail.)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { PublicLinkView } from '../bookingClient.js';
import type { SignPublicView } from '../signClient.js';

type BookingApi = typeof import('../bookingClient.js');
type SignApi = typeof import('../signClient.js');
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const getPublicLink = vi.fn<BookingApi['getPublicLink']>();
const getPublicSlots = vi.fn<BookingApi['getPublicSlots']>();
const claimSlot = vi.fn<BookingApi['claimSlot']>();
vi.mock('../bookingClient.js', () => ({
  getPublicLink: (...a: Parameters<BookingApi['getPublicLink']>) => getPublicLink(...a),
  getPublicSlots: (...a: Parameters<BookingApi['getPublicSlots']>) => getPublicSlots(...a),
  claimSlot: (...a: Parameters<BookingApi['claimSlot']>) => claimSlot(...a),
}));

const getSignView = vi.fn<SignApi['getSignView']>();
const submitSignature = vi.fn<SignApi['submitSignature']>();
const declineSignature = vi.fn<SignApi['declineSignature']>();
vi.mock('../signClient.js', () => ({
  getSignView: (...a: Parameters<SignApi['getSignView']>) => getSignView(...a),
  submitSignature: (...a: Parameters<SignApi['submitSignature']>) => submitSignature(...a),
  declineSignature: (...a: Parameters<SignApi['declineSignature']>) => declineSignature(...a),
}));

// The decline path asks first (`ui/confirm`); answer yes.
const confirmSpy = vi.hoisted(() => vi.fn<typeof import('../../../ui/confirm.js')['confirm']>());
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmSpy }));

const { PublicBookingPage } = await import('../PublicBookingPage.js');
const { PublicSignPage } = await import('../PublicSignPage.js');

/** A fixed instant with an unambiguous zone split: 2026-08-03T16:00Z is
 *  12:00 in New York and 01:00 (next day) in Tokyo. */
const SLOT = Date.UTC(2026, 7, 3, 16, 0, 0);

const LINK: PublicLinkView = {
  slug: 'intro', title: 'Intro call', description: '', location: '',
  timezone: 'America/New_York', durations: [30], minNoticeMin: 0, maxAdvanceDays: 14,
};

/** Pin the VISITOR's zone. Setting TZ is how the runtime actually reports a
 *  zone through `Intl.DateTimeFormat().resolvedOptions()` — mocking the Intl
 *  constructor instead breaks every OTHER formatting call in the component. */
const REAL_TZ = process.env.TZ;
function withVisitorZone(zone: string): void {
  process.env.TZ = zone;
}

/**
 * Pin the CLOCK, not just the slot — the slot was already pinned and that was
 * the bug.
 *
 * `SLOT` is a fixed instant (deliberately: 16:00Z is 12:00 in New York only
 * under EDT, so relativising the DATE would break the zone assertions every
 * winter). But `PublicBookingPage.tsx:95` reads the real clock —
 * `useRef(Date.now())` — and passes it as `nowMs`. `BookingMonthGrid` opens the
 * grid on `civilMonthOf(nowMs, tz)` (`:59`) — the civil month in the VISITOR's
 * zone — and renders only the returned slots that fall in the displayed month.
 * So this fixture is visible exactly while the real clock sits in the same civil
 * month as `SLOT`, and invisible the moment it does not. Unchanged since
 * 2026-08-08, green on 2026-08-26, red by 2026-09-01.
 *
 * CORRECTED — this comment first said the cause was the `maxAdvanceDays: 14`
 * horizon, and that was a guess dressed as a finding. #3591 diagnosed the civil
 * month independently and was right. Both explanations survive the obvious
 * check, because pinning the clock cures either one, so the sabotage that
 * "verified" the fix could not tell them apart. What discriminates is moving
 * `now` while holding the fix:
 *
 *     now = SLOT - 1d   same month, slot ahead        6 passed
 *     now = SLOT + 12d  SAME month, slot in the PAST  6 passed   <- kills "horizon"
 *     now = SLOT - 40d  different month               2 failed
 *     now = SLOT + 30d  different month               2 failed
 *
 * The slot being 12 days past and outside any forward horizon still passes; only
 * the month matters. A FIX WORKING IS NOT EVIDENCE FOR WHY IT WORKS — when two
 * mechanisms predict the same repair, vary the input that separates them.
 * (Practically: a slot in a different month is unreachable no matter how the
 * clock is pinned, so the pin must land in `SLOT`'s civil month.)
 *
 * PINNING ONE SIDE OF A COMPARISON IS NOT PINNING THE TEST. Both the instant and
 * `now` have to be fixed, or their RELATIONSHIP drifts even though each looks
 * pinned in isolation.
 *
 * `shouldAdvanceTime` because `waitFor` polls on timers and would otherwise hang.
 */
beforeEach(() => {
  vi.resetAllMocks();
  confirmSpy.mockResolvedValue(true);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(SLOT - 24 * 60 * 60 * 1000);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); if (REAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = REAL_TZ; });

describe('public booking — visitor timezone (B-G1)', () => {
  it('renders slots in the VISITOR’s zone by default and offers the host’s zone', async () => {
    withVisitorZone('Asia/Tokyo');
    getPublicLink.mockResolvedValue(LINK);
    getPublicSlots.mockResolvedValue({ slots: [SLOT], timezone: 'America/New_York' });
    render(<PublicBookingPage slug="intro" />);

    await screen.findByText('Intro call');
    const picker = await screen.findByLabelText(/time zone/i);
    // Default is the visitor's zone, and it says so.
    expect((picker as HTMLSelectElement).value).toBe('Asia/Tokyo');
    expect(screen.getByText(/in your time zone/i)).toBeTruthy();
    // Both zones are offered, labelled by whose they are.
    const options = Array.from((picker as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(['Asia/Tokyo', 'America/New_York']);

    // Tokyo is UTC+9, so 16:00Z is 01:00 the NEXT day — the slot button must
    // show Tokyo's hour, not New York's noon.
    await waitFor(() => expect(screen.getByRole('button', { name: /01:00|1:00/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^12:00 PM$|^12:00$/ })).toBeNull();

    // Switching to the host's zone re-renders the SAME instant as noon.
    fireEvent.change(picker, { target: { value: 'America/New_York' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /12:00/ })).toBeTruthy());
    expect(screen.getByText(/in the host’s time zone/i)).toBeTruthy();
  });

  it('shows NO switcher when the visitor is already in the host’s zone', async () => {
    withVisitorZone('America/New_York');
    getPublicLink.mockResolvedValue(LINK);
    getPublicSlots.mockResolvedValue({ slots: [SLOT], timezone: 'America/New_York' });
    render(<PublicBookingPage slug="intro" />);
    await screen.findByText('Intro call');
    expect(screen.queryByLabelText(/time zone/i)).toBeNull();
  });
});

describe('public booking — per-field errors (B-G2)', () => {
  it('names WHICH detail is wrong instead of one combined message', async () => {
    withVisitorZone('America/New_York');
    getPublicLink.mockResolvedValue(LINK);
    getPublicSlots.mockResolvedValue({ slots: [SLOT], timezone: 'America/New_York' });
    render(<PublicBookingPage slug="intro" />);
    await screen.findByText('Intro call');

    fireEvent.click(await screen.findByRole('button', { name: /12:00/ }));
    const email = await screen.findByLabelText(/email/i);
    fireEvent.change(email, { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm|book/i }));

    await waitFor(() => expect(screen.getByText(/valid email address/i)).toBeTruthy());
    expect(screen.getByText(/enter your name/i)).toBeTruthy();
    // Both controls are individually marked, not just a banner.
    expect((await screen.findByLabelText(/email/i)).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText(/your name/i).getAttribute('aria-invalid')).toBe('true');
    expect(claimSlot).not.toHaveBeenCalled();
  });
});

describe('public signing — the signer keeps a copy (S-G1)', () => {
  const VIEW: SignPublicView = {
    signRequestId: 'sr:1', title: 'Service agreement', status: 'sent', signerId: 'sg:1',
    signerEmail: 'ada@example.test', signerStatus: 'pending', yourTurn: true,
    contentMarkdown: '## Terms\n\nYou agree to the thing.',
    legalNotice: 'Clicking Sign creates a legally binding electronic signature.',
  };

  it('offers a download whose content is what was shown, dated by the SERVER', async () => {
    getSignView.mockResolvedValue(VIEW);
    submitSignature.mockResolvedValue({ status: 'completed', signedAt: '2026-08-03T16:00:00.000Z' });
    render(<PublicSignPage token="tok" />);

    await screen.findByText('Service agreement');
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Ada Lovelace' } });
    // R2 S-G2 — signing now requires the explicit acknowledgment; the button
    // stays disabled until it's checked (the consent the server records).
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /^sign$/i }));

    const link = await screen.findByRole('link', { name: /download a copy/i });
    const copy = decodeURIComponent(link.getAttribute('href')!.replace(/^data:text\/markdown;charset=utf-8,/, ''));
    expect(copy).toContain('# Service agreement');
    expect(copy).toContain('You agree to the thing.');          // what they saw
    expect(copy).toContain('Ada Lovelace <ada@example.test>');   // who signed
    expect(copy).toContain('2026-08-03T16:00:00.000Z');          // the SERVER's instant
    expect(copy).toContain('legally binding');                   // the scope accepted
    expect(link.getAttribute('download')).toBe('Service-agreement.md');
  });

  it('offers NO copy to a returning signer, who has no signature instant to cite', async () => {
    getSignView.mockResolvedValue({ ...VIEW, signerStatus: 'signed' });
    render(<PublicSignPage token="tok" />);
    await screen.findByText(/Service agreement/);
    expect(screen.queryByRole('link', { name: /download a copy/i })).toBeNull();
  });

  it('offers no copy when the signer DECLINED', async () => {
    getSignView.mockResolvedValue(VIEW);
    declineSignature.mockResolvedValue({ status: 'declined' });
    render(<PublicSignPage token="tok" />);
    await screen.findByText('Service agreement');
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(declineSignature).toHaveBeenCalledWith('tok'));
    // The page reached the DECLINED outcome — only then is "no link" a claim.
    expect(await screen.findByText('Declined')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /download a copy/i })).toBeNull();
  });
});
