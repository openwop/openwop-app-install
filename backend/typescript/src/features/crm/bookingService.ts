/**
 * CRM booking orchestration (ADR 0402 §a) — the public claim path and the
 * authenticated management operations, composed over the booking entities, the
 * tz slot math, and the existing crm/email/notification/sharing seams.
 *
 * The public claim is idempotent + double-book-safe: the booking id IS the slot
 * tuple, so the CAS in `entities/bookings.claimBooking` is the sole gate. Contact
 * capture + the meeting activity + owner notification + confirmation email are
 * best-effort AFTER the durable claim — a side-effect failure never loses the
 * visitor's slot (mirrors forms' "the lead is captured even if the follow-on
 * fails" posture), but is logged for the operator.
 *
 * @see docs/adr/0402-crm-booking-and-esign.md
 */

import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { activeProvider, emailTransportConfigured } from '../email/emailService.js';
import { createActivity, makeLinkValidators } from './crmEntitiesService.js';
import { ensureContact } from './contactsService.js';
import { type BookingLink } from './entities/bookingLinks.js';
import {
  type Booking,
  bookingIdFor,
  claimBooking as claimBookingRow,
  countBookingsCreatedOn,
  getBookingById,
  listBookingsForLink,
  deleteBookingsForLink,
  putBooking,
} from './entities/bookings.js';
import { deleteBookingLink as svcDeleteBookingLink } from './entities/bookingLinks.js';
import { generateSlots, type ClaimedSlot } from './bookingTime.js';
import { buildIcs } from './ics.js';
import { cleanString, optionalCleanString } from '../../host/boundedStrings.js';

const log = createLogger('crm.booking');

/** Per-link daily booking cap (abuse) — env-tunable like the rate-limit knobs. */
function dailyCap(): number {
  const raw = Number(process.env.OPENWOP_CRM_BOOKING_DAILY_CAP);
  return Number.isInteger(raw) && raw > 0 ? raw : 100;
}

/** Whether the public booking surface is exposed (default on when crm is on). */
export function bookingEnabled(): boolean {
  return process.env.OPENWOP_CRM_BOOKING_ENABLED !== 'false';
}

const MS_MIN = 60_000;

// ── projections ─────────────────────────────────────────────────────────────

/** Public page projection — no tenant/owner/internal fields leak. */
export function publicLinkView(link: BookingLink): Record<string, unknown> {
  return {
    slug: link.slug,
    title: link.title,
    ...(link.description ? { description: link.description } : {}),
    timezone: link.timezone,
    durations: link.durations,
    ...(link.location ? { location: link.location } : {}),
    minNoticeMin: link.minNoticeMin,
    maxAdvanceDays: link.maxAdvanceDays,
  };
}

/** Manage-page projection (behind the capability token). */
export function manageView(booking: Booking, link: BookingLink): Record<string, unknown> {
  return {
    bookingId: booking.bookingId,
    status: booking.status,
    slotStartUtcMs: booking.slotStartUtcMs,
    durationMin: booking.durationMin,
    inviteeName: booking.inviteeName,
    timezone: link.timezone,
    title: link.title,
    slug: link.slug,
    ...(booking.videoLink ? { videoLink: booking.videoLink } : {}),
    ...(link.location ? { location: link.location } : {}),
    // R2 CRMPUB2-14 — the reschedule grid's window comes from the LINK, not a
    // hardcoded client constant.
    maxAdvanceDays: link.maxAdvanceDays,
    // R2 CRMPUB2-5 — add-to-calendar is available on the manage page itself
    // (a confirmed booking's current invite), not only at claim time.
    ...(booking.status === 'confirmed' ? { icsContent: icsFor(link, booking, 'REQUEST', 0, Date.now()) } : {}),
  };
}

// ── slot listing ──────────────────────────────────────────────────────────

export interface SlotQuery { fromMs: number; toMs: number; durationMin: number }

export async function availableSlots(link: BookingLink, q: SlotQuery, nowMs: number): Promise<number[]> {
  if (!link.durations.includes(q.durationMin)) {
    throw new OpenwopError('validation_error', 'Requested duration is not offered for this link.', 400, { field: 'durationMin' });
  }
  const claimedRows = await listBookingsForLink(link.bookingLinkId);
  const claimed: ClaimedSlot[] = claimedRows
    .filter((b) => b.status === 'confirmed')
    .map((b) => ({ startUtcMs: b.slotStartUtcMs, durationMin: b.durationMin }));
  return generateSlots(
    {
      timeZone: link.timezone,
      weeklyHours: link.weeklyHours,
      durationMin: q.durationMin,
      bufferBeforeMin: link.bufferBeforeMin,
      bufferAfterMin: link.bufferAfterMin,
      minNoticeMin: link.minNoticeMin,
      maxAdvanceDays: link.maxAdvanceDays,
    },
    q.fromMs,
    q.toMs,
    nowMs,
    claimed,
  );
}

/** True iff `slotStartUtcMs` is a currently-offerable slot for `durationMin`. */
async function isOfferedSlot(link: BookingLink, slotStartUtcMs: number, durationMin: number, nowMs: number): Promise<boolean> {
  // A ±1-day window around the requested instant is enough to regenerate it.
  const slots = await availableSlots(link, { fromMs: slotStartUtcMs - MS_MIN, toMs: slotStartUtcMs + MS_MIN, durationMin }, nowMs);
  return slots.includes(slotStartUtcMs);
}

// ── the public claim ────────────────────────────────────────────────────────

export interface ClaimInput {
  slotStartUtcMs: number;
  durationMin: number;
  inviteeName: string;
  inviteeEmail: string;
  inviteeNote?: string;
  idempotencyKey?: string;
  baseUrl: string;
  nowMs: number;
}

export interface ClaimOutput {
  booking: Booking;
  icsContent: string;
  manageUrl?: string;
  replayed: boolean;
  /** Was the confirmation actually EMAILED? False while no real transport is
   *  configured (the console stub's `send()` is a no-op). Transient — never
   *  persisted — and present so a caller can say "confirmed, but we could not
   *  email you the invite" instead of implying delivery. */
  confirmationEmailed: boolean;
}

/** Mint a `booking_manage` capability token via the sharing seam. Dynamic import
 *  avoids the crm↔sharing module cycle (sharing statically imports this feature
 *  for its resolver — the same shape commerce uses, `commerceService.ts`). */
async function mintManageToken(tenantId: string, orgId: string, bookingId: string): Promise<string | null> {
  try {
    const { createLink } = await import('../sharing/sharingService.js');
    const link = await createLink(tenantId, orgId, 'system:crm-booking', { resourceType: 'booking_manage', resourceId: bookingId, expiresInDays: 365 });
    return link.token;
  } catch (err) {
    log.warn('booking manage-token mint failed', { bookingId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function revokeManageTokens(tenantId: string, bookingId: string): Promise<void> {
  try {
    const { purgeLinksForResource } = await import('../sharing/sharingService.js');
    await purgeLinksForResource(tenantId, 'booking_manage', bookingId);
  } catch (err) {
    log.warn('booking manage-token revoke failed', { bookingId, error: err instanceof Error ? err.message : String(err) });
  }
}

function icsFor(link: BookingLink, booking: Booking, method: 'REQUEST' | 'CANCEL', sequence: number, stampMs: number): string {
  return buildIcs({
    uid: `${booking.bookingId}@openwop`,
    sequence,
    startUtcMs: booking.slotStartUtcMs,
    endUtcMs: booking.slotStartUtcMs + booking.durationMin * MS_MIN,
    summary: link.title,
    ...(link.description ? { description: link.description } : {}),
    ...(booking.videoLink ? { location: booking.videoLink } : link.location ? { location: link.location } : {}),
    attendeeEmail: booking.inviteeEmail,
    method,
    stampMs,
  });
}

/**
 * Claim a slot on a published link. The durable CAS claim happens first; contact
 * capture, the meeting activity, the owner notification, and the confirmation
 * email are best-effort after it.
 */
export async function claimSlot(link: BookingLink, input: ClaimInput): Promise<ClaimOutput> {
  const inviteeName = cleanString(input.inviteeName, 160, '');
  const inviteeEmail = cleanString(input.inviteeEmail, 254, '');
  if (!inviteeName || !inviteeEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inviteeEmail)) {
    throw new OpenwopError('validation_error', 'A name and a valid email are required to book.', 400, {});
  }
  if (!link.durations.includes(input.durationMin)) {
    throw new OpenwopError('validation_error', 'Requested duration is not offered.', 400, { field: 'durationMin' });
  }
  if (!Number.isInteger(input.slotStartUtcMs)) {
    throw new OpenwopError('validation_error', 'Invalid slot.', 400, { field: 'slotStartUtcMs' });
  }

  const nowIso = new Date(input.nowMs).toISOString();
  const bookingId = bookingIdFor(link.bookingLinkId, input.slotStartUtcMs);
  const cleanKey = input.idempotencyKey ? (cleanString(input.idempotencyKey, 128, '') || undefined) : undefined;

  // Idempotent replay short-circuit: a retry carrying the same key returns the
  // existing booking WITHOUT re-checking availability (the slot is already ours).
  if (cleanKey) {
    const prior = await getBookingById(bookingId);
    if (prior && prior.idempotencyKey === cleanKey) {
      const token = await mintManageToken(prior.tenantId, prior.orgId, prior.bookingId);
      return {
        booking: prior,
        icsContent: icsFor(link, prior, 'REQUEST', 0, input.nowMs),
        ...(token ? { manageUrl: `${input.baseUrl}/book/manage/${token}` } : {}),
        replayed: true,
        // A replay re-emails nobody, so it must not claim it did.
        confirmationEmailed: false,
      };
    }
  }

  // Per-link daily abuse cap (confirmed bookings created today, UTC).
  const linkRows = await listBookingsForLink(link.bookingLinkId);
  const todayPrefix = nowIso.slice(0, 10);
  if (countBookingsCreatedOn(linkRows, todayPrefix) >= dailyCap()) {
    throw new OpenwopError('rate_limited', 'This booking link has reached its daily limit. Please try again tomorrow.', 429, {});
  }

  // The slot must be a currently-offered slot (real local time, within the
  // window, not buffered-out) — validated against live availability.
  if (!(await isOfferedSlot(link, input.slotStartUtcMs, input.durationMin, input.nowMs))) {
    throw new OpenwopError('conflict', 'That time is no longer available. Please pick another slot.', 409, { reason: 'slot_taken' });
  }
  const row: Booking = {
    bookingId,
    tenantId: link.tenantId,
    orgId: link.orgId,
    bookingLinkId: link.bookingLinkId,
    slotStartUtcMs: input.slotStartUtcMs,
    durationMin: input.durationMin,
    status: 'confirmed',
    ...(cleanKey ? { idempotencyKey: cleanKey } : {}),
    inviteeName,
    inviteeEmail,
    ...(optionalCleanString(input.inviteeNote, 2000) ? { inviteeNote: optionalCleanString(input.inviteeNote, 2000) } : {}),
    ...(link.videoLink ? { videoLink: link.videoLink } : {}),
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const result = await claimBookingRow(row);
  if (result.outcome === 'slot_taken') {
    throw new OpenwopError('conflict', 'That time was just taken. Please pick another slot.', 409, { reason: 'slot_taken' });
  }
  if (result.outcome === 'replayed') {
    // Idempotent retry — return the existing booking + a fresh manage token/ICS.
    const existing = result.booking;
    const token = await mintManageTokenIfMissing(existing);
    return {
      booking: existing,
      icsContent: icsFor(link, existing, 'REQUEST', 0, input.nowMs),
      ...(token ? { manageUrl: `${input.baseUrl}/book/manage/${token}` } : {}),
      replayed: true,
        // A replay re-emails nobody, so it must not claim it did.
        confirmationEmailed: false,
    };
  }

  // ── best-effort side effects (claim already durable) ──
  const finalized = { ...result.booking };
  try {
    // ADR 0627 D2 — a public booking IS a new lead: `contact.created` fires inside
    // `createContact` (stated: it ignites `route-new-lead` where bound). D6 review
    // N3 — through the ONE find-or-create seam: a concurrent create at the same
    // address is ADOPTED (the 409 → survivor map), never swallowed by the
    // best-effort catch below with the booking's contactId lost.
    const contact = await ensureContact({ tenantId: link.tenantId, name: inviteeName, email: inviteeEmail, leadSource: 'booking', actor: 'system:crm-booking' });
    if (!contact) throw new OpenwopError('validation_error', 'A valid email is required to book.', 400, { field: 'inviteeEmail' });
    finalized.contactId = contact.contactId;
    const activity = await createActivity({
      tenantId: link.tenantId,
      orgId: link.orgId,
      kind: 'meeting',
      body: `Booked "${link.title}" via ${link.slug}${input.inviteeNote ? ` — ${cleanString(input.inviteeNote, 500, '')}` : ''}`,
      contactId: contact.contactId,
      createdBy: 'system:crm-booking',
      createdAt: new Date(input.slotStartUtcMs).toISOString(),
      validators: makeLinkValidators(link.tenantId, link.orgId),
    });
    finalized.activityId = activity.activityId;
    await putBooking(finalized);
  } catch (err) {
    log.warn('booking contact/activity capture failed', { bookingId, error: err instanceof Error ? err.message : String(err) });
  }

  const token = await mintManageToken(link.tenantId, link.orgId, bookingId);

  try {
    await getNotificationEmitter().emit({
      tenantId: link.tenantId,
      recipientUserId: link.ownerUserId,
      type: 'task.assigned',
      priority: 'normal',
      title: 'New booking',
      message: `${inviteeName} booked "${link.title}".`,
      actionUrl: `/crm?tab=booking&org=${encodeURIComponent(link.orgId)}`,
      ...(finalized.contactId ? { metadata: { contactId: finalized.contactId, bookingId } } : { metadata: { bookingId } }),
    });
  } catch (err) {
    log.warn('booking owner-notification emit failed', { bookingId, error: err instanceof Error ? err.message : String(err) });
  }

  const icsContent = icsFor(link, finalized, 'REQUEST', 0, input.nowMs);
  const manageUrl = token ? `${input.baseUrl}/book/manage/${token}` : undefined;
  void sendConfirmationEmail(link, finalized, icsContent, manageUrl);

  // Honest about DELIVERY, not just about the booking. `sendConfirmationEmail`
  // is best-effort by design, but with the console stub as the transport its
  // `send()` is a no-op, the catch only warns, and the call is dispatched with
  // `void` — so an invitee who was told "confirmed" received nothing and the
  // only trace was a server log. The caller can now say "confirmed — we could
  // not email you the invite" and hand over the ICS it already has.
  const confirmationEmailed = emailTransportConfigured();
  return { booking: finalized, icsContent, ...(manageUrl ? { manageUrl } : {}), replayed: false, confirmationEmailed };
}

/** A replay didn't mint — reuse any live token, else mint one. */
async function mintManageTokenIfMissing(booking: Booking): Promise<string | null> {
  return mintManageToken(booking.tenantId, booking.orgId, booking.bookingId);
}

/** Best-effort confirmation email (the console provider no-ops; a brokered
 *  provider carries the ICS + manage link). Never blocks the claim. */
async function sendConfirmationEmail(link: BookingLink, booking: Booking, ics: string, manageUrl?: string): Promise<void> {
  try {
    const body = [
      `Your booking for "${link.title}" is confirmed.`,
      '',
      `When: ${new Date(booking.slotStartUtcMs).toISOString()} (UTC) — see the attached calendar invite for your local time.`,
      booking.videoLink ? `Join: ${booking.videoLink}` : link.location ? `Where: ${link.location}` : '',
      manageUrl ? `Reschedule or cancel: ${manageUrl}` : '',
    ].filter(Boolean).join('\n');
    await activeProvider().send({
      to: booking.inviteeEmail,
      subject: `Confirmed: ${link.title}`,
      body,
      attachments: [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar' }],
    });
  } catch (err) {
    log.warn('booking confirmation email failed', { bookingId: booking.bookingId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Delete a booking link AND cascade: remove its booking rows and revoke each
 *  booking's `booking_manage` capability token (else the rows orphan in the org
 *  list forever and the tokens linger until their 365-day expiry). */
export async function deleteBookingLinkCascade(tenantId: string, orgId: string, bookingLinkId: string): Promise<boolean> {
  const removed = await deleteBookingsForLink(bookingLinkId);
  for (const b of removed) await revokeManageTokens(tenantId, b.bookingId);
  return svcDeleteBookingLink(tenantId, orgId, bookingLinkId);
}

// ── sharing resolver hooks (booking_manage capability token) ─────────────────
// Called by the sharing feature's RESOLVERS map (sharing → crm static import).
// crm → sharing is only the DYNAMIC mint import above, so there is no eval cycle
// (the same shape commerce uses for `commerce_order`).

/** Mint-time existence gate for a `booking_manage` share token. */
export async function bookingShareValidate(tenantId: string, orgId: string, bookingId: string): Promise<void> {
  const b = await getBookingById(bookingId);
  if (!b || b.tenantId !== tenantId || b.orgId !== orgId) {
    throw new OpenwopError('not_found', 'Booking not found.', 404, { bookingId });
  }
}

/** Public projection behind the token (fail-closed: booking-off ⇒ dark). */
export async function bookingShareLoad(tenantId: string, orgId: string, bookingId: string): Promise<Record<string, unknown> | null> {
  if (!bookingEnabled()) return null;
  const b = await getBookingById(bookingId);
  if (!b || b.tenantId !== tenantId || b.orgId !== orgId) return null;
  const { getBookingLink } = await import('./entities/bookingLinks.js');
  const link = await getBookingLink(tenantId, orgId, b.bookingLinkId);
  if (!link) return null;
  return { kind: 'booking_manage', ...manageView(b, link) };
}

// ── manage: reschedule / cancel (behind the capability token) ────────────────

/** Resolve the booking a `booking_manage` token authorizes, with its link. */
export async function resolveManagedBooking(bookingId: string): Promise<{ booking: Booking; link: BookingLink } | null> {
  const booking = await getBookingById(bookingId);
  if (!booking) return null;
  // Load the link by (tenant, org) via the slug-less path: the booking carries
  // the link id; re-read through the org-guarded accessor is not available
  // publicly, so read the published link and re-verify tenant/org match.
  const { getBookingLink } = await import('./entities/bookingLinks.js');
  const link = await getBookingLink(booking.tenantId, booking.orgId, booking.bookingLinkId);
  if (!link) return null;
  return { booking, link };
}

export async function cancelBooking(bookingId: string, nowMs: number, opts?: { rescheduledToMs?: number; reason?: string }): Promise<Booking | null> {
  const resolved = await resolveManagedBooking(bookingId);
  if (!resolved) return null;
  const { booking, link } = resolved;
  if (booking.status === 'cancelled') return booking;
  const cancelled: Booking = { ...booking, status: 'cancelled', cancelledAt: new Date(nowMs).toISOString() };
  await putBooking(cancelled);
  await revokeManageTokens(booking.tenantId, bookingId);
  // The meeting activity is append-only (a historical record that the meeting
  // WAS booked), so record the cancellation as its own timeline note rather than
  // mutating history — the honest reflection of the state change. Best-effort.
  if (booking.contactId) {
    try {
      await createActivity({
        tenantId: booking.tenantId,
        orgId: booking.orgId,
        kind: 'note',
        // R2 CRMPUB2-8 — a reschedule's cancel leg is not a cancellation to the
        // timeline: say what actually happened.
        // R3-CP1 — the visitor's optional cancellation reason (the catalog's
        // manage-page convention) rides the SAME timeline note the host already
        // reads. Absent ⇒ the note is byte-identical to before. The visitor was
        // told at the input that this is shared with the host; it is authored
        // free text on an internal surface, sanitized+bounded at the route.
        body: opts?.rescheduledToMs !== undefined
          ? `Booking rescheduled: "${link.title}" (${new Date(booking.slotStartUtcMs).toISOString()} → ${new Date(opts.rescheduledToMs).toISOString()})`
          : `Booking cancelled: "${link.title}" (${new Date(booking.slotStartUtcMs).toISOString()})${opts?.reason ? ` — visitor's note: "${opts.reason}"` : ''}`,
        contactId: booking.contactId,
        createdBy: 'system:crm-booking',
        validators: makeLinkValidators(booking.tenantId, booking.orgId),
      });
    } catch (err) {
      log.warn('booking cancel note-activity failed', { bookingId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Re-send a CANCEL ICS so the invitee's calendar drops the event; best-effort.
  void sendConfirmationCancel(link, cancelled, nowMs, opts?.rescheduledToMs);
  return cancelled;
}

async function sendConfirmationCancel(link: BookingLink, booking: Booking, nowMs: number, rescheduledToMs?: number): Promise<void> {
  try {
    // R2 CRMPUB2-8 — an invitee who RESCHEDULED used to receive "Cancelled:
    // {title}" beside the new confirmation, with nothing saying "rescheduled".
    // The CANCEL ics still rides (the old calendar entry must drop — the new
    // confirmation carries a NEW UID); only the human-readable copy changes.
    const rescheduled = rescheduledToMs !== undefined;
    await activeProvider().send({
      to: booking.inviteeEmail,
      subject: rescheduled ? `Rescheduled: ${link.title}` : `Cancelled: ${link.title}`,
      body: rescheduled
        ? `Your booking for "${link.title}" has been rescheduled. The previous time (${new Date(booking.slotStartUtcMs).toISOString()}) is cancelled — your new confirmation is in a separate email.`
        : `Your booking for "${link.title}" has been cancelled.`,
      attachments: [{ filename: 'invite.ics', content: icsFor(link, booking, 'CANCEL', 1, nowMs), contentType: 'text/calendar' }],
    });
  } catch (err) {
    log.warn('booking cancel email failed', { bookingId: booking.bookingId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Reschedule = cancel-then-claim under the manage token. Frees the old slot and
 * claims the new one atomically-enough: the new claim goes through the same CAS
 * gate, so a double-book is still impossible; if the new slot is taken the old
 * booking is left intact (we only cancel AFTER the new claim succeeds).
 */
export async function rescheduleBooking(bookingId: string, newSlotStartUtcMs: number, baseUrl: string, nowMs: number): Promise<ClaimOutput | null> {
  const resolved = await resolveManagedBooking(bookingId);
  if (!resolved) return null;
  const { booking, link } = resolved;
  if (booking.status === 'cancelled') {
    throw new OpenwopError('validation_error', 'A cancelled booking cannot be rescheduled.', 409, { reason: 'cancelled_booking' });
  }
  if (newSlotStartUtcMs === booking.slotStartUtcMs) {
    throw new OpenwopError('validation_error', 'Pick a different time to reschedule.', 400, { reason: 'same_slot' });
  }
  // Claim the NEW slot first (CAS gate). Reuse the invitee identity.
  const out = await claimSlot(link, {
    slotStartUtcMs: newSlotStartUtcMs,
    durationMin: booking.durationMin,
    inviteeName: booking.inviteeName,
    inviteeEmail: booking.inviteeEmail,
    ...(booking.inviteeNote ? { inviteeNote: booking.inviteeNote } : {}),
    baseUrl,
    nowMs,
  });
  // New slot secured — now free the old one (with reschedule context so the
  // email + timeline note say what actually happened — R2 CRMPUB2-8).
  await cancelBooking(booking.bookingId, nowMs, { rescheduledToMs: newSlotStartUtcMs });
  return out;
}
