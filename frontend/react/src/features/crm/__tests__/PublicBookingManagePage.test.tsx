/**
 * UX_UPGRADE-crm-public ROUND 2 — the manage page's FIRST tests (XP-R2-0/1).
 *
 * The load-bearing behaviours, each pinned against a specific regression:
 * - a failed read is DISCRIMINATED (CRMPUB-3): only a real 404/410 claims the
 *   link is dead; a 500 gets a retryable card whose Retry actually re-reads;
 * - the payload is RENDERED (CRMPUB2-4/5): invitee, duration, location, the
 *   videoLink whose only visitor surface is this page, and add-to-calendar;
 * - the reschedule grid uses the LINK's horizon, not a hardcoded 60
 *   (CRMPUB2-14), and a failed slots read is not "no times available";
 * - the rotated manage token is ADOPTED (CRMPUB2-2, review F6): after a
 *   reschedule the page does NOT re-read (a failing read would bury the
 *   success under "not found") — it renders from the response and uses the
 *   NEW token for the next action (the old one is revoked server-side);
 * - reschedule-email honesty (CRMPUB-6): confirmationEmailed=false renders the
 *   warning instead of implying delivery;
 * - cancel ends in a cancelled state that offers a rebook door.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const getManageView = vi.fn();
const getPublicSlots = vi.fn();
const cancelBooking = vi.fn();
const rescheduleBooking = vi.fn();
vi.mock('../bookingClient.js', () => ({
  getManageView: (...a: unknown[]) => getManageView(...a),
  getPublicSlots: (...a: unknown[]) => getPublicSlots(...a),
  cancelBooking: (...a: unknown[]) => cancelBooking(...a),
  rescheduleBooking: (...a: unknown[]) => rescheduleBooking(...a),
}));

const confirmFn = vi.fn();
vi.mock('../../../ui/confirm.js', () => ({
  confirm: (...a: unknown[]) => confirmFn(...a),
  ConfirmRoot: () => null,
}));

const { PublicBookingManagePage } = await import('../PublicBookingManagePage.js');

const SLOT = Date.UTC(2026, 7, 10, 16, 0, 0);
const VIEW = {
  bookingId: 'bk1', status: 'confirmed', slotStartUtcMs: SLOT, durationMin: 45,
  inviteeName: 'Ada Lovelace', timezone: 'America/New_York', title: 'Intro call',
  slug: 'intro', location: 'Room 4', videoLink: 'https://meet.example/xyz',
  maxAdvanceDays: 14, icsContent: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
};

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`http ${status}`), { status });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('manage page — discriminated failed reads (CRMPUB-3)', () => {
  it('renders a RETRYABLE card on a 500, and Retry re-reads the view', async () => {
    getManageView.mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce(VIEW);
    render(<PublicBookingManagePage token="tok1" />);

    // Not the dead-link card: the booking most likely still exists.
    await screen.findByText(/couldn.t load this booking/i);
    expect(screen.queryByText(/booking not found/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('Intro call');
    expect(getManageView).toHaveBeenCalledTimes(2);
  });

  it('renders the dead-link card ONLY on a real 404', async () => {
    getManageView.mockRejectedValue(httpError(404));
    render(<PublicBookingManagePage token="tok1" />);
    await screen.findByText(/booking not found/i);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});

describe('manage page — the payload rendered (CRMPUB2-4/5)', () => {
  it('shows invitee, duration, location, the video link, and add-to-calendar', async () => {
    getManageView.mockResolvedValue(VIEW);
    render(<PublicBookingManagePage token="tok1" />);

    await screen.findByText('Intro call');
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText(/45/)).toBeTruthy();
    expect(screen.getByText('Room 4')).toBeTruthy();
    const video = screen.getByRole('link', { name: 'https://meet.example/xyz' }) as HTMLAnchorElement;
    expect(video.href).toBe('https://meet.example/xyz');
    const ics = screen.getByRole('link', { name: /add to calendar/i }) as HTMLAnchorElement;
    expect(ics.href.startsWith('data:text/calendar')).toBe(true);
    expect(ics.getAttribute('download')).toBeTruthy();
  });
});

describe('manage page — reschedule (CRMPUB2-2/14, CRMPUB-3/6)', () => {
  // H71 — THE CLOCK IS PINNED, and this is the whole point of the block.
  //
  // This assertion used to read the real wall clock, and it was recorded on the
  // board as "the CRM flake" for weeks. It is not flaky. `BookingMonthGrid`
  // clamps the month query to the horizon:
  //
  //     from = max(monthStart_UTC - 36h, now)
  //     to   = min(nextMonthStart_UTC + 36h, now + (maxAdvanceDays + 1) * DAY)
  //
  // so a full-horizon window only survives while `now + 15d` still lands inside
  // the current civil month plus the slack. For a 31-day month that boundary is
  // the 18th at 12:00 UTC — after which the test fails EVERY run for the rest of
  // the month, then passes again for the first ~17 days of the next one.
  //
  // MEASURED 2026-08-18: solving the formula for the `now` that yields the
  // observed `14.785781412037037` gives `2026-08-18T17:08:28Z`, and the run's
  // own log is stamped 13:08:43 EDT. It reproduced to fifteen digits. Roughly
  // 40% of every month was red, which is exactly the duty cycle that gets a
  // failure labelled "flaky" and re-run instead of read.
  //
  // The fix is NOT a looser assertion — `toBeLessThan(60)` would keep the name
  // and delete the check. It is a fixed clock plus BOTH branches below, so the
  // clamp is a tested behaviour rather than a hidden dependency on today's date.
  //
  // `shouldAdvanceTime` matters: with a frozen clock `waitFor` never observes
  // elapsed time, so a failing expectation HANGS to the suite timeout instead of
  // failing. A hang is a worse outcome than the bug being fixed here.
  // Enabling fake timers WITHOUT setting a time leaves `Date.now()` at the real
  // clock, which is how this block rotted: `slotsCallAt()` pins the instant, but
  // the two tests that do not call it were left running at today's date. `SLOT`
  // is 2026-08-10, and `BookingMonthGrid` opens on `civilMonthOf(nowMs, tz)` —
  // the visitor's civil month — rendering only returned slots inside the month
  // on screen. Once real time left August the slot was off-grid and no time
  // button rendered. Green 2026-08-26, red by 2026-09-01, file unchanged since
  // 2026-08-18 — the fuse was real time, not a code change.
  //
  // CORRECTED: this said the slot "fell out of the horizon" (`maxAdvanceDays:
  // 14`). Wrong, and it was asserted from reading the props rather than from a
  // measurement. Holding the fix and moving `now`:
  //     now = SLOT - 1d    same month                    12 passed
  //     now = SLOT + 15d   SAME month, past + past-horizon 12 passed
  //     now = SLOT - 45d   different month                2 failed
  // A slot fifteen days in the past and beyond any forward horizon still passes.
  // Only the civil month decides. See the sibling note in
  // publicBookingSignUpgrade.test.tsx; #3591 had this right first.
  //
  // So the default is pinned here, for every test in the block; `slotsCallAt`
  // still overrides it where a specific `now` is the subject.
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(SLOT - 24 * 60 * 60 * 1000);
  });
  afterEach(() => { vi.useRealTimers(); });

  async function slotsCallAt(nowMs: number): Promise<unknown[]> {
    vi.setSystemTime(nowMs);
    getManageView.mockResolvedValue(VIEW);
    getPublicSlots.mockResolvedValue({ slots: [SLOT + 86_400_000] });
    render(<PublicBookingManagePage token="tok1" />);
    await screen.findByText('Intro call');
    fireEvent.click(screen.getByRole('button', { name: /reschedule/i }));
    await waitFor(() => expect(getPublicSlots).toHaveBeenCalled());
    return getPublicSlots.mock.calls[0]!;
  }

  it("asks for slots over the LINK's horizon, not a hardcoded 60 days", async () => {
    // Early in the month: `now + 15d` is still inside August, so the query
    // spans the whole horizon and nothing is clamped.
    const [slug, from, to, dur] = await slotsCallAt(Date.UTC(2026, 7, 5, 12, 0, 0));
    expect(slug).toBe('intro');
    expect(dur).toBe(45);
    // maxAdvanceDays=14 ⇒ a 15-day window, nowhere near the old 60/61.
    const windowDays = ((to as number) - (from as number)) / 86_400_000;
    expect(windowDays).toBe(15);
  });

  it('clamps the first month to the month boundary late in the month (H71)', async () => {
    // Late in the month the horizon runs past the civil month, so `to` pins to
    // `Sep 1 + 36h` and the FIRST query is shorter — the visitor pages into
    // September for the rest. This is the branch that silently reddened the
    // suite for half of every month; asserting it is what keeps the clamp
    // honest, and it is the leg that would have named the cause immediately.
    const [, from, to] = await slotsCallAt(Date.UTC(2026, 7, 25, 12, 0, 0));
    const windowDays = ((to as number) - (from as number)) / 86_400_000;
    expect(windowDays).toBe(8);
    // Still bounded by the LINK's horizon, never the old hardcoded 60.
    expect(windowDays).toBeLessThan(15);
  });

  it('a failed slots read renders the retryable slots card, NOT "no times available"', async () => {
    getManageView.mockResolvedValue(VIEW);
    getPublicSlots.mockRejectedValue(httpError(500));
    render(<PublicBookingManagePage token="tok1" />);
    await screen.findByText('Intro call');

    fireEvent.click(screen.getByRole('button', { name: /reschedule/i }));
    await screen.findByText(/couldn.t load available times/i);
    expect(screen.queryByText(/no times available/i)).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('adopts the ROTATED token from the reschedule response (the old one is revoked)', async () => {
    const NEW_SLOT = SLOT + 86_400_000;
    getManageView.mockResolvedValue(VIEW);
    getPublicSlots.mockResolvedValue({ slots: [NEW_SLOT] });
    rescheduleBooking.mockResolvedValue({
      status: 'confirmed', slotStartUtcMs: NEW_SLOT,
      manageUrl: 'https://app.example/book/manage/tok2', confirmationEmailed: true,
    });
    render(<PublicBookingManagePage token="tok1" />);
    await screen.findByText('Intro call');

    fireEvent.click(screen.getByRole('button', { name: /reschedule/i }));
    const timeBtns = await screen.findAllByRole('button', { name: /\d{1,2}:\d{2}/ });
    fireEvent.click(timeBtns[0]!);

    await waitFor(() => expect(rescheduleBooking).toHaveBeenCalledWith('tok1', NEW_SLOT));
    // Review F6 — the success renders from the RESPONSE, with no re-read: a
    // failing read of the fresh token would bury the success under "not found".
    const cancelBtn = await screen.findByRole('button', { name: /cancel booking/i });
    expect(getManageView).toHaveBeenCalledTimes(1);
    expect(getManageView).toHaveBeenCalledWith('tok1');

    // The rotated token IS adopted — the next action (cancel) uses tok2.
    confirmFn.mockResolvedValue(true);
    cancelBooking.mockResolvedValue({ status: 'cancelled' });
    fireEvent.click(cancelBtn);
    await waitFor(() => expect(cancelBooking).toHaveBeenCalledWith('tok2'));
  });

  it('confirmationEmailed=false renders the no-email warning instead of implying delivery', async () => {
    const NEW_SLOT = SLOT + 86_400_000;
    getManageView.mockResolvedValue(VIEW);
    getPublicSlots.mockResolvedValue({ slots: [NEW_SLOT] });
    // No manageUrl minted: the page renders success from the response itself.
    rescheduleBooking.mockResolvedValue({ status: 'confirmed', slotStartUtcMs: NEW_SLOT, confirmationEmailed: false });
    render(<PublicBookingManagePage token="tok1" />);
    await screen.findByText('Intro call');

    fireEvent.click(screen.getByRole('button', { name: /reschedule/i }));
    const timeBtns = await screen.findAllByRole('button', { name: /\d{1,2}:\d{2}/ });
    fireEvent.click(timeBtns[0]!);

    await screen.findByText(/couldn.t.*email|email.*couldn.t|wasn.t emailed|could not.*email/i);
    // And getManageView was NOT re-called with a revoked token.
    expect(getManageView).toHaveBeenCalledTimes(1);
  });
});

describe('manage page — cancel (honest end state)', () => {
  it('confirms, cancels, and offers a rebook door on the cancelled card', async () => {
    getManageView.mockResolvedValue(VIEW);
    confirmFn.mockResolvedValue(true);
    cancelBooking.mockResolvedValue({ status: 'cancelled' });
    render(<PublicBookingManagePage token="tok1" />);
    await screen.findByText('Intro call');

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(cancelBooking).toHaveBeenCalledWith('tok1'));
    const rebook = await screen.findByRole('link', { name: /book a new time/i }) as HTMLAnchorElement;
    expect(rebook.getAttribute('href')).toBe('/book/intro');
  });

  it('does NOT cancel when the designed confirm is declined', async () => {
    getManageView.mockResolvedValue(VIEW);
    confirmFn.mockResolvedValue(false);
    render(<PublicBookingManagePage token="tok1" />);
    await screen.findByText('Intro call');

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(cancelBooking).not.toHaveBeenCalled();
    expect(screen.getByText('Intro call')).toBeTruthy();
  });
});

describe('R3-CP1 — the optional cancellation reason', () => {
  it('sends the typed reason through cancelBooking; the label discloses the sharing', async () => {
    getManageView.mockResolvedValue(VIEW);
    confirmFn.mockResolvedValue(true);
    cancelBooking.mockResolvedValue({ status: 'cancelled' });
    render(<PublicBookingManagePage token="tok1" />);
    await screen.findByText('Intro call');

    // The consent lives in the LABEL, not a hidden behavior: the visitor is
    // told the note is shared with the host before they type a word.
    const box = screen.getByRole('textbox', { name: /shared with the host/i });
    fireEvent.change(box, { target: { value: 'Changed plans' } });
    fireEvent.click(screen.getByRole('button', { name: /^cancel booking$/i }));

    await waitFor(() => expect(cancelBooking).toHaveBeenCalledWith('tok1', 'Changed plans'));
  });

  it('an untouched reason keeps the call byte-identical to pre-R3 (one argument)', async () => {
    getManageView.mockResolvedValue(VIEW);
    confirmFn.mockResolvedValue(true);
    cancelBooking.mockResolvedValue({ status: 'cancelled' });
    render(<PublicBookingManagePage token="tok1" />);
    await screen.findByText('Intro call');
    fireEvent.click(screen.getByRole('button', { name: /^cancel booking$/i }));
    await waitFor(() => expect(cancelBooking).toHaveBeenCalledWith('tok1'));
  });
});
