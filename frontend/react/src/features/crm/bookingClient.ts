/**
 * CRM booking API client (ADR 0402 §a).
 *   Authed (operator):  /host/openwop-app/crm/orgs/:orgId/booking-links/*
 *   Public (visitor):   /host/openwop-app/public-book/*   (no auth)
 * The public calls carry no auth header — a visitor books without a session.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type BookingLinkStatus = 'draft' | 'published' | 'disabled';

export interface WeeklyHours { day: number; start: string; end: string }

export interface BookingLink {
  bookingLinkId: string;
  slug: string;
  ownerUserId: string;
  title: string;
  description?: string;
  status: BookingLinkStatus;
  timezone: string;
  weeklyHours: WeeklyHours[];
  durations: number[];
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  maxAdvanceDays: number;
  videoLink?: string;
  location?: string;
  createdAt: string;
  updatedAt: string;
}

export type BookingStatus = 'confirmed' | 'cancelled';
export interface Booking {
  bookingId: string;
  bookingLinkId: string;
  slotStartUtcMs: number;
  durationMin: number;
  status: BookingStatus;
  inviteeName: string;
  inviteeEmail: string;
  inviteeNote?: string;
  contactId?: string;
  createdAt: string;
}

export interface BookingLinkInput {
  title: string;
  timezone: string;
  weeklyHours: WeeklyHours[];
  durations: number[];
  description?: string;
  status?: BookingLinkStatus;
  ownerUserId?: string;
  location?: string;
  videoLink?: string;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  minNoticeMin?: number;
  maxAdvanceDays?: number;
  slug?: string;
}

const root = `${config.baseUrl}/host/openwop-app`;
const orgBase = (orgId: string): string => `${root}/crm/orgs/${encodeURIComponent(orgId)}/booking-links`;
const pubBase = `${root}/public-book`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    let reason = '';
    try {
      const body = (await res.json()) as { message?: string; details?: { reason?: string } };
      detail = body?.message ?? '';
      reason = body?.details?.reason ?? '';
    } catch { /* non-JSON */ }
    const err = new Error(detail || `${ctx} returned ${res.status}`) as Error & { status?: number; reason?: string };
    err.status = res.status;
    if (reason) err.reason = reason;
    throw err;
  }
  return (await res.json()) as T;
}

// ── authed operator management ───────────────────────────────────────────────

export async function listBookingLinks(orgId: string): Promise<BookingLink[]> {
  const res = await fetch(orgBase(orgId), fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ bookingLinks: BookingLink[] }>(res, 'listBookingLinks')).bookingLinks;
}

export async function createBookingLink(orgId: string, input: BookingLinkInput): Promise<BookingLink> {
  const res = await fetch(orgBase(orgId), fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<BookingLink>(res, 'createBookingLink');
}

export async function updateBookingLink(orgId: string, bookingLinkId: string, patch: Partial<BookingLinkInput>): Promise<BookingLink> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(bookingLinkId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<BookingLink>(res, 'updateBookingLink');
}

export async function deleteBookingLink(orgId: string, bookingLinkId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(bookingLinkId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson<unknown>(res, 'deleteBookingLink');
}

export async function listBookingsForLink(orgId: string, bookingLinkId: string): Promise<Booking[]> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(bookingLinkId)}/bookings`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ bookings: Booking[] }>(res, 'listBookingsForLink')).bookings;
}

// ── public visitor surface (unauthed) ────────────────────────────────────────

export interface PublicLinkView {
  slug: string;
  title: string;
  description?: string;
  timezone: string;
  durations: number[];
  location?: string;
  minNoticeMin: number;
  maxAdvanceDays: number;  /** R2 — the host's display name (never their email) for the identity line. */
  hostName?: string;
}

export interface ManageView {
  bookingId: string;
  status: BookingStatus;
  slotStartUtcMs: number;
  durationMin: number;
  inviteeName: string;
  timezone: string;
  title: string;
  slug: string;
  videoLink?: string;
  location?: string;
  /** R2 CRMPUB2-14 — the link's real horizon (was a hardcoded client 60). */
  maxAdvanceDays?: number;
  /** R2 CRMPUB2-5 — the confirmed booking's current invite, for add-to-calendar. */
  icsContent?: string;
}

export interface ClaimResult {
  ok: boolean;
  bookingId: string;
  slotStartUtcMs: number;
  icsContent: string;
  manageUrl?: string;
  /** R2 CRMPUB-6 — honesty: was the confirmation actually emailed? */
  confirmationEmailed?: boolean;
}

const publicHeaders = (): Record<string, string> => ({ 'content-type': 'application/json' });

export async function getPublicLink(slug: string): Promise<PublicLinkView> {
  const res = await fetch(`${pubBase}/${encodeURIComponent(slug)}`, fetchOpts({ headers: publicHeaders() }));
  return asJson<PublicLinkView>(res, 'getPublicLink');
}

export async function getPublicSlots(slug: string, fromMs: number, toMs: number, durationMin: number): Promise<{ slots: number[]; timezone: string }> {
  const qs = `?from=${fromMs}&to=${toMs}&durationMin=${durationMin}`;
  const res = await fetch(`${pubBase}/${encodeURIComponent(slug)}/slots${qs}`, fetchOpts({ headers: publicHeaders() }));
  return asJson<{ slots: number[]; timezone: string }>(res, 'getPublicSlots');
}

export async function claimSlot(
  slug: string,
  input: { slotStartUtcMs: number; durationMin: number; inviteeName: string; inviteeEmail: string; inviteeNote?: string; idempotencyKey: string; _hp_ref?: string },
): Promise<ClaimResult> {
  const { idempotencyKey, ...body } = input;
  const res = await fetch(`${pubBase}/${encodeURIComponent(slug)}/claim`, fetchOpts({
    method: 'POST',
    headers: { ...publicHeaders(), 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  }));
  return asJson<ClaimResult>(res, 'claimSlot');
}

export async function getManageView(token: string): Promise<ManageView> {
  const res = await fetch(`${pubBase}/manage/${encodeURIComponent(token)}`, fetchOpts({ headers: publicHeaders() }));
  return asJson<ManageView>(res, 'getManageView');
}

export async function cancelBooking(token: string, reason?: string): Promise<{ status: BookingStatus }> {
  // R3-CP1 — the optional visitor reason; omitted entirely when empty so the
  // wire (and the host's timeline note) stays byte-identical to before.
  const res = await fetch(`${pubBase}/manage/${encodeURIComponent(token)}/cancel`, fetchOpts({
    method: 'POST',
    headers: { ...publicHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(reason?.trim() ? { reason: reason.trim() } : {}),
  }));
  return asJson<{ status: BookingStatus }>(res, 'cancelBooking');
}

export interface RescheduleResult { status: BookingStatus; slotStartUtcMs: number; manageUrl?: string; icsContent?: string; confirmationEmailed?: boolean }
export async function rescheduleBooking(token: string, slotStartUtcMs: number): Promise<RescheduleResult> {
  const res = await fetch(`${pubBase}/manage/${encodeURIComponent(token)}/reschedule`, fetchOpts({ method: 'POST', headers: publicHeaders(), body: JSON.stringify({ slotStartUtcMs }) }));
  return asJson<RescheduleResult>(res, 'rescheduleBooking');
}
