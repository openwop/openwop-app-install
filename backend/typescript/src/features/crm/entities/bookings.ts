/**
 * CRM bookings (ADR 0402 §a) — one atomic slot claim on a booking link. The
 * primary id IS the slot tuple `${bookingLinkId}:${slotStartUtcMs}`, so an
 * insert-if-absent compare-and-swap on that key is the double-book gate itself
 * (no separate lock): the second visitor to claim a slot loses the CAS and gets
 * `slot_taken`. A client `Idempotency-Key` stored on the row makes a genuine
 * retry return the SAME booking rather than a false `slot_taken`.
 *
 * @see docs/adr/0402-crm-booking-and-esign.md
 */

import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { nowIso } from './shared.js';

export type BookingStatus = 'confirmed' | 'cancelled';

export interface Booking {
  /** `${bookingLinkId}:${slotStartUtcMs}` — the slot tuple, the CAS key. */
  bookingId: string;
  tenantId: string;
  orgId: string;
  bookingLinkId: string;
  slotStartUtcMs: number;
  durationMin: number;
  status: BookingStatus;
  /** Client replay guard — a retry carrying the same key returns this row. */
  idempotencyKey?: string;
  inviteeName: string;
  inviteeEmail: string;
  inviteeNote?: string;
  /** The captured/matched CRM contact + meeting activity. */
  contactId?: string;
  activityId?: string;
  videoLink?: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string;
}

function isBooking(v: unknown): Booking | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  if (typeof b.bookingId !== 'string' || typeof b.bookingLinkId !== 'string' || typeof b.slotStartUtcMs !== 'number') return null;
  return v as Booking;
}

const bookings = new DurableCollection<Booking>('crm:booking', (b) => b.bookingId, isBooking, (b) => b.tenantId);

/** Deterministic slot key — the collection primary id. */
export function bookingIdFor(bookingLinkId: string, slotStartUtcMs: number): string {
  return `${bookingLinkId}:${slotStartUtcMs}`;
}

export async function getBooking(tenantId: string, orgId: string, bookingId: string): Promise<Booking | null> {
  const b = await bookings.get(bookingId);
  return b && b.tenantId === tenantId && b.orgId === orgId ? b : null;
}

/** Booking by id WITHOUT the org guard — for the public manage path, where the
 *  capability token (not org membership) is the authority; still tenant-checked
 *  by the caller against the resolved link. */
export async function getBookingById(bookingId: string): Promise<Booking | null> {
  return bookings.get(bookingId);
}

/** All bookings for one link — a BOUNDED prefix scan (the slot key is
 *  `${linkId}:...`), used for slot subtraction + the per-link daily cap. */
export async function listBookingsForLink(bookingLinkId: string): Promise<Booking[]> {
  return bookings.listByPrefix(`${bookingLinkId}:`);
}

export async function listBookings(tenantId: string, orgId: string, filter: { bookingLinkId?: string; status?: BookingStatus } = {}): Promise<Booking[]> {
  return (await bookings.listForTenantIndexed(tenantId))
    .filter(
      (b) =>
        b.orgId === orgId &&
        (filter.bookingLinkId === undefined || b.bookingLinkId === filter.bookingLinkId) &&
        (filter.status === undefined || b.status === filter.status),
    )
    .sort((a, b) => b.slotStartUtcMs - a.slotStartUtcMs);
}

export type ClaimResult =
  | { outcome: 'claimed'; booking: Booking }
  | { outcome: 'replayed'; booking: Booking }
  | { outcome: 'slot_taken' };

/**
 * Atomically claim a slot. `row.bookingId` MUST be `bookingIdFor(...)`.
 *  - No row yet → insert-if-absent CAS wins → `claimed`.
 *  - A CONFIRMED row with the SAME `idempotencyKey` → `replayed` (the caller's
 *    own retry — never a duplicate, never a false conflict).
 *  - A CANCELLED row → the slot is free → CAS(expected=cancelled, next=row).
 *  - Otherwise → `slot_taken`.
 */
export async function claimBooking(row: Booking): Promise<ClaimResult> {
  const inserted = await bookings.compareAndSwap(null, row);
  if (inserted) return { outcome: 'claimed', booking: row };
  const existing = await bookings.get(row.bookingId);
  if (!existing) {
    // Lost a race that then vanished — one more insert attempt.
    return (await bookings.compareAndSwap(null, row)) ? { outcome: 'claimed', booking: row } : { outcome: 'slot_taken' };
  }
  if (row.idempotencyKey !== undefined && existing.idempotencyKey === row.idempotencyKey) {
    return { outcome: 'replayed', booking: existing };
  }
  if (existing.status === 'cancelled') {
    const swapped = await bookings.compareAndSwap(existing, row);
    return swapped ? { outcome: 'claimed', booking: row } : { outcome: 'slot_taken' };
  }
  return { outcome: 'slot_taken' };
}

/** Persist a mutation to an existing booking (contact/activity linkage, cancel). */
export async function putBooking(next: Booking): Promise<void> {
  await bookings.put({ ...next, updatedAt: nowIso() });
}

/** Delete every booking row for a link (the delete-link cascade), returning the
 *  removed rows so the caller can revoke their `booking_manage` tokens. */
export async function deleteBookingsForLink(bookingLinkId: string): Promise<Booking[]> {
  const rows = await listBookingsForLink(bookingLinkId);
  for (const b of rows) await bookings.delete(b.bookingId);
  return rows;
}

/** Count of ACTIVE (confirmed) bookings for a link created on the given UTC
 *  calendar day — the per-link daily abuse cap. */
export function countBookingsCreatedOn(rows: Booking[], dayIsoPrefix: string): number {
  return rows.filter((b) => b.status === 'confirmed' && b.createdAt.startsWith(dayIsoPrefix)).length;
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __clearBookings(): Promise<void> {
  await bookings.__clear();
}
