/**
 * UX_UPGRADE-crm-console ROUND 2 — XCC-3: booking operator honesty.
 *
 *  - CC-SP-4: the visitor's note was collected on the public page and shown
 *    to NO ONE — the operator's bookings table never rendered it.
 *  - CC-SP-11: a booking link was CREATE-ONLY. `updateBookingLink` accepted
 *    every field all along; the only affordance a typo'd link had was Delete.
 *
 * Sabotage that turns it red (wave-4 /grade-tests probes, 6/6 witnessed): the
 * note cell rendering nothing; `description` dropped from the PATCH; an
 * unchanged schedule or duration always sent; Cancel a no-op; the PATCH
 * aimed at the wrong link id.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type * as BookingClient from '../bookingClient.js';
import type { Booking, BookingLink } from '../bookingClient.js';

const listBookingLinks = vi.fn<typeof BookingClient.listBookingLinks>();
const createBookingLink = vi.fn<typeof BookingClient.createBookingLink>();
const updateBookingLink = vi.fn<typeof BookingClient.updateBookingLink>();
const listBookingsForLink = vi.fn<typeof BookingClient.listBookingsForLink>();
vi.mock('../bookingClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listBookingLinks: (...a: Parameters<typeof BookingClient.listBookingLinks>) => listBookingLinks(...a),
  createBookingLink: (...a: Parameters<typeof BookingClient.createBookingLink>) => createBookingLink(...a),
  updateBookingLink: (...a: Parameters<typeof BookingClient.updateBookingLink>) => updateBookingLink(...a),
  listBookingsForLink: (...a: Parameters<typeof BookingClient.listBookingsForLink>) => listBookingsForLink(...a),
}));

const { BookingTab } = await import('../BookingTab.js');

const link = (id: string, title: string, over: Partial<BookingLink> = {}): BookingLink => ({
  bookingLinkId: id, slug: `slug-${id}`, ownerUserId: 'u1', title, status: 'published',
  timezone: 'UTC', weeklyHours: [{ day: 1, start: '09:00', end: '17:00' }], durations: [30],
  bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, maxAdvanceDays: 30,
  createdAt: '', updatedAt: '', ...over,
});

beforeEach(() => { vi.resetAllMocks(); });
afterEach(cleanup);

describe('CC-SP-4 — the visitor note reaches the operator', () => {
  it('renders inviteeNote in the bookings table', async () => {
    listBookingLinks.mockResolvedValue([link('l1', 'Intro call')]);
    const booking: Booking = {
      bookingId: 'b1', bookingLinkId: 'l1', slotStartUtcMs: 1754700000000, durationMin: 30,
      status: 'confirmed', inviteeName: 'Ana', inviteeEmail: 'ana@x.io',
      inviteeNote: 'Please focus on the pricing question', createdAt: '',
    };
    listBookingsForLink.mockResolvedValue([booking]);
    render(<BookingTab orgId="org:1" />);
    fireEvent.click(await screen.findByRole('button', { name: /view bookings/i }));
    await screen.findByText('Please focus on the pricing question');
  });
});

describe('CC-SP-11 — the edit affordance', () => {
  it('Edit prefills the form and Save PATCHes through updateBookingLink', async () => {
    const l = link('l1', 'Intro call', { description: 'Old desc' });
    listBookingLinks.mockResolvedValue([l]);
    updateBookingLink.mockResolvedValue({ ...l, title: 'Renamed call' });
    render(<BookingTab orgId="org:1" />);
    fireEvent.click(await screen.findByRole('button', { name: /edit intro call/i }));
    const titleInput = screen.getByDisplayValue('Intro call');
    fireEvent.change(titleInput, { target: { value: 'Renamed call' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateBookingLink).toHaveBeenCalled());
    const [, id, patch] = updateBookingLink.mock.calls[0]!;
    expect(id).toBe('l1');
    expect(patch).toMatchObject({ title: 'Renamed call', description: 'Old desc' });
    // The list reflects the server's answer.
    await screen.findByText('Renamed call');
  });

  it('Cancel leaves the link untouched and returns the form to create mode', async () => {
    listBookingLinks.mockResolvedValue([link('l1', 'Intro call')]);
    render(<BookingTab orgId="org:1" />);
    fireEvent.click(await screen.findByRole('button', { name: /edit intro call/i }));
    expect(screen.getByDisplayValue('Intro call')).toBeTruthy(); // prefilled (edit mode)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(updateBookingLink).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /create/i })).toBeTruthy();
    // …and the form is CLEARED, not merely relabelled: the edited link's title
    // is gone from the input.
    expect(screen.queryByDisplayValue('Intro call')).toBeNull();
  });
});

describe('CC-SP-11 (review F3/F4) — edit clears and preserves correctly', () => {
  it('blanking the description on edit SENDS the empty string (clearing was a silent no-op)', async () => {
    const l = link('l1', 'Intro call', { description: 'Old desc' });
    listBookingLinks.mockResolvedValue([l]);
    const { description: _cleared, ...withoutDescription } = l;
    updateBookingLink.mockResolvedValue(withoutDescription);
    render(<BookingTab orgId="org:1" />);
    fireEvent.click(await screen.findByRole('button', { name: /edit intro call/i }));
    fireEvent.change(screen.getByDisplayValue('Old desc'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateBookingLink).toHaveBeenCalled());
    expect(updateBookingLink.mock.calls[0]![2].description).toBe('');
  });

  it('an UNCHANGED schedule is omitted from the patch — an API-authored varied schedule survives a title edit', async () => {
    const varied = link('l1', 'Varied', {
      weeklyHours: [{ day: 1, start: '09:00', end: '12:00' }, { day: 3, start: '14:00', end: '18:00' }],
      durations: [30, 60],
    });
    listBookingLinks.mockResolvedValue([varied]);
    updateBookingLink.mockResolvedValue({ ...varied, title: 'Renamed' });
    render(<BookingTab orgId="org:1" />);
    fireEvent.click(await screen.findByRole('button', { name: /edit varied/i }));
    fireEvent.change(screen.getByDisplayValue('Varied'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateBookingLink).toHaveBeenCalled());
    const patch = updateBookingLink.mock.calls[0]![2];
    // The form COLLAPSES per-day hours/multi-durations; sending its flattened
    // shape would destroy the varied config on an unrelated rename.
    expect('weeklyHours' in patch).toBe(false);
    expect('durations' in patch).toBe(false);
    expect(patch.title).toBe('Renamed');
  });
});

