/**
 * UX_UPGRADE-crm-console ROUND 2 — XCC-4: the two-instance failures.
 *
 *  - CC-SP-13: BookingTab/SignTab kept the PREVIOUS org's rows on screen
 *    under the new org's header (indefinitely if the new fetch failed).
 *  - CC-SP-12: open link A then B fast — A's slow response landed in B's
 *    panel (last-write-wins). The fix is the BookingMonthGrid guard pattern;
 *    these tests make the responses actually interleave.
 *
 * Gap ids: XCC-4 / CC-SP-12 / CC-SP-13 in `docs/steward/UX_UPGRADE-crm-console.md`.
 * Sabotage-witnessed (wave-4 /grade-tests, w4g5-os-*): BookingTab not clearing
 * `links` on an org switch, its `loadSeq` guard on the links read, its
 * `openLinkRef` superseded-check on the bookings read, SignTab not clearing
 * `requests` on a switch, and SignTab's `loadSeq` guard in the CATCH each turn
 * a case red. The SignTab late-failure case used to assert only that the wire
 * string was absent — which SignTab never renders (CRM-UX-14) — so it passed
 * with the guard removed; it now asserts the failed-read CARD is absent and
 * org B's honest empty state is what shows.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import i18n from '../../../i18n/index.js';
import type { BookingLink, Booking } from '../bookingClient.js';
import type { SignRequestView } from '../signClient.js';

type BookingApi = typeof import('../bookingClient.js');
type SignApi = typeof import('../signClient.js');

/** Let every already-settled promise deliver (the stale responses below
 *  resolve synchronously in the test, so their delivery is microtask-only). */
const drain = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); });
};

const listBookingLinks = vi.fn<BookingApi['listBookingLinks']>();
const listBookingsForLink = vi.fn<BookingApi['listBookingsForLink']>();
vi.mock('../bookingClient.js', async (importOriginal) => ({
  ...(await importOriginal<BookingApi>()),
  listBookingLinks: (...a: Parameters<BookingApi['listBookingLinks']>) => listBookingLinks(...a),
  listBookingsForLink: (...a: Parameters<BookingApi['listBookingsForLink']>) => listBookingsForLink(...a),
}));

const listSignRequests = vi.fn<SignApi['listSignRequests']>();
vi.mock('../signClient.js', async (importOriginal) => ({
  ...(await importOriginal<SignApi>()),
  listSignRequests: (...a: Parameters<SignApi['listSignRequests']>) => listSignRequests(...a),
}));

const { BookingTab } = await import('../BookingTab.js');
const { SignTab } = await import('../SignTab.js');

const link = (id: string, title: string): BookingLink => ({
  bookingLinkId: id, slug: `s-${id}`, ownerUserId: 'u1', title, status: 'published',
  timezone: 'UTC', weeklyHours: [{ day: 1, start: '09:00', end: '17:00' }], durations: [30],
  bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, maxAdvanceDays: 30,
  createdAt: '', updatedAt: '',
});

const booking = (id: string, name: string): Booking => ({
  bookingId: id, bookingLinkId: '', slotStartUtcMs: 1754700000000, durationMin: 30,
  status: 'confirmed', inviteeName: name, inviteeEmail: `${name}@x.io`, createdAt: '',
});

const signRequest = (id: string, title: string): SignRequestView => ({
  signRequestId: id, title, status: 'sent', target: { kind: 'document', id: 'd1' }, createdAt: '', signers: [],
});

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('CC-SP-13 — org switch never shows the previous org’s rows', () => {
  it('BookingTab clears the list (and open panel) when orgId changes', async () => {
    listBookingLinks.mockResolvedValueOnce([link('l1', 'Org-A link')]);
    const { rerender } = render(<BookingTab orgId="org:A" />);
    await screen.findByText('Org-A link');
    // Org B's fetch never resolves — the old rows must STILL disappear.
    listBookingLinks.mockReturnValueOnce(new Promise(() => {}));
    rerender(<BookingTab orgId="org:B" />);
    await waitFor(() => expect(screen.queryByText('Org-A link')).toBeNull());
  });

  it('SignTab clears the previous org’s requests when orgId changes', async () => {
    listSignRequests.mockResolvedValueOnce([signRequest('r1', 'Org-A NDA')]);
    const { rerender } = render(<SignTab orgId="org:A" />);
    await screen.findByText('Org-A NDA');
    listSignRequests.mockReturnValueOnce(new Promise(() => {}));
    rerender(<SignTab orgId="org:B" />);
    await waitFor(() => expect(screen.queryByText('Org-A NDA')).toBeNull());
  });
});

describe('CC-SP-12 — interleaved bookings responses cannot cross panels', () => {
  it('link A’s SLOW response never lands in link B’s open panel', async () => {
    listBookingLinks.mockResolvedValue([link('lA', 'Link A'), link('lB', 'Link B')]);
    let resolveA!: (b: Booking[]) => void;
    listBookingsForLink.mockImplementation(async (_org: string, id: string) => {
      if (id === 'lA') return new Promise<Booking[]>((r) => { resolveA = r; });
      return [booking('b2', 'BelongsToB')];
    });
    render(<BookingTab orgId="org:1" />);
    const viewButtons = await screen.findAllByRole('button', { name: /view bookings/i });
    fireEvent.click(viewButtons[0]!); // open A (hangs)
    fireEvent.click(viewButtons[1]!); // open B (resolves)
    await screen.findByText('BelongsToB');
    resolveA([booking('b1', 'BelongsToA')]); // A's stale response lands last
    await drain();
    expect(screen.queryByText('BelongsToA')).toBeNull();
    expect(screen.getByText('BelongsToB')).toBeTruthy();
  });
});

describe('CC-SP-13 (review F1) — a LATE previous-org response must not resurrect', () => {
  it('org A’s links resolving AFTER the switch never render under org B', async () => {
    let resolveA!: (rows: BookingLink[]) => void;
    listBookingLinks.mockImplementation(async (org: string) => {
      if (org === 'org:A') return new Promise<BookingLink[]>((r) => { resolveA = r; });
      return []; // org B resolves EMPTY immediately
    });
    const { rerender } = render(<BookingTab orgId="org:A" />);
    await waitFor(() => expect(listBookingLinks).toHaveBeenCalledWith('org:A'));
    rerender(<BookingTab orgId="org:B" />);
    await waitFor(() => expect(listBookingLinks).toHaveBeenCalledWith('org:B'));
    resolveA([link('l1', 'Org-A link')]); // the stale response lands LAST
    await drain();
    expect(screen.queryByText('Org-A link')).toBeNull();
    // Positive control: org B's own (empty) answer is what is on screen.
    expect(screen.getByText(i18n.t('crm:bookingEmptyTitle'))).toBeTruthy();
  });

  it('org A’s late FAILURE never plants its error under org B (SignTab)', async () => {
    let rejectA!: (e: Error) => void;
    listSignRequests.mockImplementation(async (org: string) => {
      if (org === 'org:A') return new Promise<SignRequestView[]>((_r, rej) => { rejectA = rej; });
      return [];
    });
    const { rerender } = render(<SignTab orgId="org:A" />);
    await waitFor(() => expect(listSignRequests).toHaveBeenCalledWith('org:A'));
    rerender(<SignTab orgId="org:B" />);
    await waitFor(() => expect(listSignRequests).toHaveBeenCalledWith('org:B'));
    rejectA(new Error('org-A exploded'));
    await drain();
    // SignTab never renders the wire string (CRM-UX-14) — a planted failure
    // shows as the canonical failed-read CARD, so that is what must be absent.
    expect(screen.queryByText(i18n.t('common:loadFailedTitle'))).toBeNull();
    expect(screen.queryByText(/org-A exploded/)).toBeNull();
    // Positive control: org B's honest empty state is what shows.
    expect(screen.getByText(i18n.t('crm:signEmptyTitle'))).toBeTruthy();
  });
});

