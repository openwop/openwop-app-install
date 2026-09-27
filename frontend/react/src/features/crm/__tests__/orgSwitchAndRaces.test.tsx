/**
 * UX_UPGRADE-crm-console ROUND 2 — XCC-4: the two-instance failures.
 *
 *  - CC-SP-13: BookingTab/SignTab kept the PREVIOUS org's rows on screen
 *    under the new org's header (indefinitely if the new fetch failed).
 *  - CC-SP-12: open link A then B fast — A's slow response landed in B's
 *    panel (last-write-wins). The fix is the BookingMonthGrid guard pattern;
 *    these tests make the responses actually interleave.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { BookingLink, Booking } from '../bookingClient.js';

const listBookingLinks = vi.fn();
const listBookingsForLink = vi.fn();
vi.mock('../bookingClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listBookingLinks: (...a: unknown[]) => listBookingLinks(...a),
  listBookingsForLink: (...a: unknown[]) => listBookingsForLink(...a),
}));

const listSignRequests = vi.fn();
vi.mock('../signClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listSignRequests: (...a: unknown[]) => listSignRequests(...a),
}));

const { BookingTab } = await import('../BookingTab.js');
const { SignTab } = await import('../SignTab.js');

const link = (id: string, title: string): BookingLink => ({
  bookingLinkId: id, slug: `s-${id}`, ownerUserId: 'u1', title, status: 'published',
  timezone: 'UTC', weeklyHours: [{ day: 1, start: '09:00', end: '17:00' }], durations: [30],
  bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, maxAdvanceDays: 30,
  createdAt: '', updatedAt: '',
} as BookingLink);

const booking = (id: string, name: string): Booking => ({
  bookingId: id, bookingLinkId: '', slotStartUtcMs: 1754700000000, durationMin: 30,
  status: 'confirmed', inviteeName: name, inviteeEmail: `${name}@x.io`, createdAt: '',
} as Booking);

beforeEach(() => vi.clearAllMocks());
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
    listSignRequests.mockResolvedValueOnce([{ signRequestId: 'r1', title: 'Org-A NDA', status: 'pending', target: { kind: 'document', id: 'd1' }, signers: [] }]);
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
    // Give the microtask a beat, then assert A's rows did NOT replace B's.
    await new Promise((r) => setTimeout(r, 20));
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
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Org-A link')).toBeNull();
  });

  it('org A’s late FAILURE never plants its error under org B (SignTab)', async () => {
    let rejectA!: (e: Error) => void;
    listSignRequests.mockImplementation(async (org: string) => {
      if (org === 'org:A') return new Promise((_r, rej) => { rejectA = rej; });
      return [];
    });
    const { rerender } = render(<SignTab orgId="org:A" />);
    await waitFor(() => expect(listSignRequests).toHaveBeenCalledWith('org:A'));
    rerender(<SignTab orgId="org:B" />);
    await waitFor(() => expect(listSignRequests).toHaveBeenCalledWith('org:B'));
    rejectA(new Error('org-A exploded'));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/org-A exploded/)).toBeNull();
  });
});

