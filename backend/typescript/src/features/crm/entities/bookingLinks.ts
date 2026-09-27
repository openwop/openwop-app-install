/**
 * CRM booking links (ADR 0402 §a) — a published, self-serve availability
 * surface a visitor books a slot on (`/book/:slug`). Org-scoped and RBAC-gated
 * like the other ADR 0008 CRM entities; a KV-blob `DurableCollection` over
 * `host_ext_kv` (ADR 0383 family — NO SQL migration).
 *
 * The public page resolves by SLUG ALONE (tenant-from-resource), so slugs are
 * GLOBALLY unique. Uniqueness is enforced atomically through a separate slug
 * index collection claimed with insert-if-absent CAS — a point lookup on the
 * public path, never a cross-tenant scan.
 *
 * @see docs/adr/0402-crm-booking-and-esign.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import { slugify } from '../../../host/slug.js';
import { MAX, MAX_PER_ORG_ENTITIES, assertUnderCap, cleanStr, nowIso, optStr } from './shared.js';
import { isValidTimeZone, parseHhmm, type WeeklyHours } from '../bookingTime.js';
import { crmMutated, emitOptsOf, type CrmEmitOptions } from '../emit.js';

export type BookingLinkStatus = 'draft' | 'published' | 'disabled';
export const BOOKING_LINK_STATUSES: BookingLinkStatus[] = ['draft', 'published', 'disabled'];

/** Guard-rails on the availability config (bound scan cost + abuse). */
const LIMITS = {
  weeklyHours: 40, // ≤ ~6 windows/day
  durations: 8,
  maxDurationMin: 8 * 60,
  maxAdvanceDays: 365,
  maxNoticeMin: 90 * 24 * 60,
  slugTries: 50,
} as const;

export interface BookingLink {
  bookingLinkId: string;
  tenantId: string;
  orgId: string;
  slug: string;
  /** Whose calendar/meeting this books. */
  ownerUserId: string;
  title: string;
  description?: string;
  status: BookingLinkStatus;
  /** IANA zone the availability is expressed in (display/compute-only). */
  timezone: string;
  weeklyHours: WeeklyHours[];
  /** Offered slot lengths, minutes. */
  durations: number[];
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  maxAdvanceDays: number;
  /** Optional static video-call link (v1: static only; `'generate'` deferred). */
  videoLink?: string;
  location?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function isBookingLink(v: unknown): BookingLink | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  if (typeof b.bookingLinkId !== 'string' || typeof b.tenantId !== 'string' || typeof b.slug !== 'string') return null;
  if (!Array.isArray(b.weeklyHours) || !Array.isArray(b.durations)) return null;
  return v as BookingLink;
}

const links = new DurableCollection<BookingLink>('crm:booking-link', (b) => b.bookingLinkId, isBookingLink, (b) => b.tenantId);

interface SlugEntry { slug: string; bookingLinkId: string; tenantId: string }
// `tenantOf` arms the tenant secondary index so tenant teardown (ADR 0284
// purgeTenantRows) reclaims slug rows — otherwise a deleted tenant's slugs
// orphan and could block a future tenant from reusing them.
const slugIndex = new DurableCollection<SlugEntry>('crm:booking-link-slug', (s) => s.slug, undefined, (s) => s.tenantId);

// ── availability validation (fail-closed) ──────────────────────────────────

function cleanWeeklyHours(raw: unknown): WeeklyHours[] {
  if (!Array.isArray(raw)) return [];
  const out: WeeklyHours[] = [];
  for (const item of raw) {
    if (out.length >= LIMITS.weeklyHours) break;
    if (!item || typeof item !== 'object') continue;
    const w = item as Record<string, unknown>;
    const day = typeof w.day === 'number' ? w.day : NaN;
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    const start = typeof w.start === 'string' ? w.start : '';
    const end = typeof w.end === 'string' ? w.end : '';
    const s = parseHhmm(start);
    const e = parseHhmm(end);
    if (s === null || e === null || e <= s) continue;
    out.push({ day, start, end });
  }
  return out;
}

function cleanDurations(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    if (out.length >= LIMITS.durations) break;
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > LIMITS.maxDurationMin) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out.sort((a, b) => a - b);
}

function boundedInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return fallback;
  return v;
}

export interface BookingLinkInput {
  tenantId: string;
  orgId: string;
  ownerUserId: string;
  title: string;
  description?: unknown;
  status?: BookingLinkStatus;
  timezone: string;
  weeklyHours: unknown;
  durations: unknown;
  bufferBeforeMin?: unknown;
  bufferAfterMin?: unknown;
  minNoticeMin?: unknown;
  maxAdvanceDays?: unknown;
  videoLink?: unknown;
  location?: unknown;
  createdBy: string;
  slug?: string;
  /** Deterministic id (ADR 0162). MUST be `booking-link:`-prefixed. */
  bookingLinkId?: string;
}

function assertConfig(input: { timezone: string; weeklyHours: WeeklyHours[]; durations: number[] }): void {
  if (!isValidTimeZone(input.timezone)) {
    throw new OpenwopError('validation_error', '`timezone` MUST be a valid IANA zone id.', 400, { field: 'timezone' });
  }
  if (input.durations.length === 0) {
    throw new OpenwopError('validation_error', 'At least one valid `durations` entry (minutes) is required.', 400, { field: 'durations' });
  }
  if (input.weeklyHours.length === 0) {
    throw new OpenwopError('validation_error', 'At least one valid `weeklyHours` window is required.', 400, { field: 'weeklyHours' });
  }
}

/** Claim a globally-unique slug via insert-if-absent CAS (never a scan). */
async function claimSlug(desired: string, bookingLinkId: string, tenantId: string): Promise<string> {
  const base = slugify(desired, 'meeting');
  for (let i = 0; i < LIMITS.slugTries; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const ok = await slugIndex.compareAndSwap(null, { slug: candidate, bookingLinkId, tenantId });
    if (ok) return candidate;
  }
  throw new OpenwopError('validation_error', 'Could not allocate a unique booking-link slug — try a different title.', 409, {});
}

export async function listBookingLinks(tenantId: string, orgId: string): Promise<BookingLink[]> {
  return (await links.listForTenantIndexed(tenantId))
    .filter((b) => b.orgId === orgId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getBookingLink(tenantId: string, orgId: string, bookingLinkId: string): Promise<BookingLink | null> {
  const b = await links.get(bookingLinkId);
  return b && b.tenantId === tenantId && b.orgId === orgId ? b : null;
}

/** Public resolve by slug — point lookup on the slug index, tenant-from-resource. */
export async function getPublishedBookingLinkBySlug(slug: string): Promise<BookingLink | null> {
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > 80) return null;
  const entry = await slugIndex.get(slug);
  if (!entry) return null;
  const link = await links.get(entry.bookingLinkId);
  if (!link || link.status !== 'published') return null;
  return link;
}

export async function createBookingLink(input: BookingLinkInput & CrmEmitOptions): Promise<BookingLink> {
  if (input.bookingLinkId !== undefined) {
    if (!input.bookingLinkId.startsWith('booking-link:')) {
      throw new OpenwopError('validation_error', 'bookingLinkId must be `booking-link:`-prefixed.', 400, { bookingLinkId: input.bookingLinkId });
    }
    const existing = await links.get(input.bookingLinkId);
    if (existing) {
      if (existing.tenantId === input.tenantId && existing.orgId === input.orgId) return existing;
      throw new OpenwopError('not_found', 'Booking link not found.', 404, { bookingLinkId: input.bookingLinkId });
    }
  }
  assertUnderCap((await listBookingLinks(input.tenantId, input.orgId)).length, MAX_PER_ORG_ENTITIES, 'booking links');
  const weeklyHours = cleanWeeklyHours(input.weeklyHours);
  const durations = cleanDurations(input.durations);
  assertConfig({ timezone: input.timezone, weeklyHours, durations });

  const bookingLinkId = input.bookingLinkId ?? `booking-link:${randomUUID()}`;
  const title = cleanStr(input.title, MAX.name, 'Meeting');
  const slug = await claimSlug(input.slug || title, bookingLinkId, input.tenantId);
  const ts = nowIso();
  const link: BookingLink = {
    bookingLinkId,
    tenantId: input.tenantId,
    orgId: input.orgId,
    slug,
    ownerUserId: input.ownerUserId,
    title,
    ...(optStr(input.description, MAX.body) ? { description: optStr(input.description, MAX.body) } : {}),
    status: input.status && BOOKING_LINK_STATUSES.includes(input.status) ? input.status : 'draft',
    timezone: input.timezone,
    weeklyHours,
    durations,
    bufferBeforeMin: boundedInt(input.bufferBeforeMin, 0, LIMITS.maxNoticeMin, 0),
    bufferAfterMin: boundedInt(input.bufferAfterMin, 0, LIMITS.maxNoticeMin, 0),
    minNoticeMin: boundedInt(input.minNoticeMin, 0, LIMITS.maxNoticeMin, 0),
    maxAdvanceDays: boundedInt(input.maxAdvanceDays, 1, LIMITS.maxAdvanceDays, 60),
    ...(optStr(input.videoLink, MAX.short) ? { videoLink: optStr(input.videoLink, MAX.short) } : {}),
    ...(optStr(input.location, MAX.short) ? { location: optStr(input.location, MAX.short) } : {}),
    createdBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await links.put(link);
  // ADR 0627 D2 — the ONE `booking-link.created` site (route + surface verb).
  crmMutated({ entity: 'booking-link', verb: 'created', tenantId: link.tenantId, orgId: link.orgId, entityId: link.bookingLinkId, ...emitOptsOf(input) });
  return link;
}

export async function updateBookingLink(
  tenantId: string,
  orgId: string,
  bookingLinkId: string,
  patch: Partial<Pick<BookingLinkInput, 'title' | 'description' | 'status' | 'timezone' | 'weeklyHours' | 'durations' | 'bufferBeforeMin' | 'bufferAfterMin' | 'minNoticeMin' | 'maxAdvanceDays' | 'videoLink' | 'location'>>,
): Promise<BookingLink | null> {
  const cur = await getBookingLink(tenantId, orgId, bookingLinkId);
  if (!cur) return null;
  const next: BookingLink = { ...cur, updatedAt: nowIso() };
  if (patch.title !== undefined) next.title = cleanStr(patch.title, MAX.name, cur.title);
  if (patch.description !== undefined) {
    const d = optStr(patch.description, MAX.body);
    if (d) next.description = d; else delete next.description;
  }
  if (patch.status !== undefined && BOOKING_LINK_STATUSES.includes(patch.status)) next.status = patch.status;
  if (patch.timezone !== undefined) next.timezone = String(patch.timezone);
  if (patch.weeklyHours !== undefined) next.weeklyHours = cleanWeeklyHours(patch.weeklyHours);
  if (patch.durations !== undefined) next.durations = cleanDurations(patch.durations);
  if (patch.bufferBeforeMin !== undefined) next.bufferBeforeMin = boundedInt(patch.bufferBeforeMin, 0, LIMITS.maxNoticeMin, cur.bufferBeforeMin);
  if (patch.bufferAfterMin !== undefined) next.bufferAfterMin = boundedInt(patch.bufferAfterMin, 0, LIMITS.maxNoticeMin, cur.bufferAfterMin);
  if (patch.minNoticeMin !== undefined) next.minNoticeMin = boundedInt(patch.minNoticeMin, 0, LIMITS.maxNoticeMin, cur.minNoticeMin);
  if (patch.maxAdvanceDays !== undefined) next.maxAdvanceDays = boundedInt(patch.maxAdvanceDays, 1, LIMITS.maxAdvanceDays, cur.maxAdvanceDays);
  if (patch.videoLink !== undefined) {
    const v = optStr(patch.videoLink, MAX.short);
    if (v) next.videoLink = v; else delete next.videoLink;
  }
  if (patch.location !== undefined) {
    const l = optStr(patch.location, MAX.short);
    if (l) next.location = l; else delete next.location;
  }
  // Re-validate the (possibly changed) availability config before persisting.
  assertConfig({ timezone: next.timezone, weeklyHours: next.weeklyHours, durations: next.durations });
  await links.put(next);
  return next;
}

export async function deleteBookingLink(tenantId: string, orgId: string, bookingLinkId: string): Promise<boolean> {
  const cur = await getBookingLink(tenantId, orgId, bookingLinkId);
  if (!cur) return false;
  await links.delete(bookingLinkId);
  await slugIndex.delete(cur.slug);
  return true;
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __clearBookingLinks(): Promise<void> {
  await links.__clear();
  await slugIndex.__clear();
}
