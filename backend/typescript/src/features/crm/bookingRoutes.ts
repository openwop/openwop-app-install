/**
 * CRM booking routes (ADR 0402 §a) — host-extension surface.
 *   Authed (org-scoped, RBAC):  /v1/host/openwop-app/crm/orgs/:orgId/booking-links[...]
 *   Public (unauthed):          /v1/host/openwop-app/public-book/:slug[...]
 *                               /v1/host/openwop-app/public-book/manage/:token[...]
 *
 * The public prefix is on PUBLIC_PATH_PREFIXES (auth.ts) — `public-book` does NOT
 * shadow the authed `…/crm/*`. The four public invariants mirror forms exactly:
 * published-only, tenant-from-resource, uniform 404, rate-limit + per-link daily
 * cap + honeypot. The manage routes authorize by CAPABILITY TOKEN (the sharing
 * `booking_manage` link), the commerce-quote public-accept precedent.
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString, optionalString, publicBaseUrl } from '../featureRoute.js';
import { getUser } from '../users/usersService.js';
import { checkEntitlement } from '../../host/entitlementSeam.js';
import { createLogger } from '../../observability/logger.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import {
  listBookingLinks, getBookingLink, createBookingLink, updateBookingLink,
  getPublishedBookingLinkBySlug, type BookingLink,
} from './entities/bookingLinks.js';
import { listBookings, type Booking } from './entities/bookings.js';
import {
  availableSlots, claimSlot, publicLinkView, manageView, resolveManagedBooking,
  cancelBooking, rescheduleBooking, bookingEnabled, deleteBookingLinkCascade,
} from './bookingService.js';

const FEATURE = { toggleId: 'crm', label: 'CRM' };
const ORG = '/v1/host/openwop-app/crm/orgs/:orgId';
const PUB = '/v1/host/openwop-app/public-book';
const HONEYPOT = '_hp_ref';
const log = createLogger('crm.booking.routes');

type Scope = 'workspace:read' | 'workspace:write';

export function registerCrmBookingRoutes(deps: RouteDeps): void {
  const { app } = deps;
  // ADR 0419 — authed management gates on toggle + org RBAC + plan/bundle entitlement
  // (CRM is sellable). PUBLIC booking routes (below, under PUB) never use `authz`, so a
  // public booker is never 403'd on the operator's plan (the ADR 0176 exemption).
  const authz = async (req: Request, scope: Scope) => {
    const ctx = await authorizeOrgScope(req, FEATURE, scope);
    await checkEntitlement(req, FEATURE.toggleId);
    return ctx;
  };

  // ───────────────────────── authed org-scoped management ─────────────────────
  app.get(`${ORG}/booking-links`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      res.json({ bookingLinks: await listBookingLinks(tenantId, orgId) });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/booking-links`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const link = await createBookingLink({
        tenantId,
        orgId,
        ownerUserId: optionalString(body.ownerUserId) ?? user.userId,
        title: requireString(body.title, 'title'),
        description: body.description,
        ...(body.status !== undefined ? { status: body.status as BookingLink['status'] } : {}),
        timezone: requireString(body.timezone, 'timezone'),
        weeklyHours: body.weeklyHours,
        durations: body.durations,
        bufferBeforeMin: body.bufferBeforeMin,
        bufferAfterMin: body.bufferAfterMin,
        minNoticeMin: body.minNoticeMin,
        maxAdvanceDays: body.maxAdvanceDays,
        videoLink: body.videoLink,
        location: body.location,
        createdBy: user.userId,
        ...(optionalString(body.slug) ? { slug: optionalString(body.slug) } : {}),
      });
      res.status(201).json(link);
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/booking-links/:bookingLinkId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const link = await getBookingLink(tenantId, orgId, req.params.bookingLinkId);
      if (!link) throw new OpenwopError('not_found', 'Booking link not found.', 404, {});
      res.json(link);
    } catch (err) { next(err); }
  });

  app.patch(`${ORG}/booking-links/:bookingLinkId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const link = await updateBookingLink(tenantId, orgId, req.params.bookingLinkId, body);
      if (!link) throw new OpenwopError('not_found', 'Booking link not found.', 404, {});
      res.json(link);
    } catch (err) { next(err); }
  });

  app.delete(`${ORG}/booking-links/:bookingLinkId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:write');
      const ok = await deleteBookingLinkCascade(tenantId, orgId, req.params.bookingLinkId);
      if (!ok) throw new OpenwopError('not_found', 'Booking link not found.', 404, {});
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/booking-links/:bookingLinkId/bookings`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const link = await getBookingLink(tenantId, orgId, req.params.bookingLinkId);
      if (!link) throw new OpenwopError('not_found', 'Booking link not found.', 404, {});
      res.json({ bookings: await listBookings(tenantId, orgId, { bookingLinkId: req.params.bookingLinkId }) });
    } catch (err) { next(err); }
  });

  // ───────────────────────── public unauthed surface ──────────────────────────
  // Uniform 404 on missing / unpublished / crm-off / booking-disabled — no leak.
  const resolvePublic = async (slug: string): Promise<BookingLink> => {
    const notFound = (): never => { throw new OpenwopError('not_found', 'Booking link not found.', 404, {}); };
    if (!bookingEnabled()) return notFound();
    const link = await getPublishedBookingLinkBySlug(slug);
    if (!link) return notFound();
    const assignment = await resolveOne(FEATURE.toggleId, { tenantId: link.tenantId });
    if (!assignment || !assignment.enabled) return notFound();
    return link;
  };

  // Manage routes registered BEFORE `/:slug` (both are distinct path shapes, but
  // keeping the literal `manage` segment first avoids any future ambiguity). The
  // capability TOKEN is the credential (booking_manage share link) — NOT gated by
  // the `sharing` content toggle, but dark when the owning `crm` toggle is off.
  const bookingNotFound = (): OpenwopError => new OpenwopError('not_found', 'Booking not found.', 404, {});
  const resolveManaged = async (token: string): Promise<{ resourceId: string; booking: Booking; link: BookingLink }> => {
    if (!bookingEnabled()) throw bookingNotFound();
    const { resolveActiveResource } = await import('../sharing/sharingService.js');
    const { resourceId } = await resolveActiveResource(token, 'booking_manage');
    const resolved = await resolveManagedBooking(resourceId);
    if (!resolved) throw bookingNotFound();
    const assignment = await resolveOne(FEATURE.toggleId, { tenantId: resolved.booking.tenantId });
    if (!assignment || !assignment.enabled) throw bookingNotFound();
    return { resourceId, booking: resolved.booking, link: resolved.link };
  };

  app.get(`${PUB}/manage/:token`, async (req, res, next) => {
    try {
      const { booking, link } = await resolveManaged(req.params.token);
      res.json(manageView(booking, link));
    } catch (err) { next(err); }
  });

  app.post(`${PUB}/manage/:token/cancel`, async (req, res, next) => {
    try {
      const { resourceId } = await resolveManaged(req.params.token);
      // R3-CP1 — optional visitor reason, bounded like every authored public
      // string (500 chars; whitespace-only clears to absent).
      const rawReason = (req.body ?? {}) as { reason?: unknown };
      const reason = typeof rawReason.reason === 'string' ? rawReason.reason.trim().slice(0, 500) : '';
      const cancelled = await cancelBooking(resourceId, Date.now(), reason ? { reason } : undefined);
      if (!cancelled) throw bookingNotFound();
      res.json({ status: cancelled.status });
    } catch (err) { next(err); }
  });

  app.post(`${PUB}/manage/:token/reschedule`, async (req, res, next) => {
    try {
      const { resourceId } = await resolveManaged(req.params.token);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const slotStartUtcMs = Number(body.slotStartUtcMs);
      if (!Number.isInteger(slotStartUtcMs)) throw new OpenwopError('validation_error', 'A `slotStartUtcMs` is required.', 400, {});
      const out = await rescheduleBooking(resourceId, slotStartUtcMs, publicBaseUrl(req), Date.now());
      if (!out) throw bookingNotFound();
      // R2 CRMPUB2-5/6 — forward the .ics the service already built (the
      // rescheduled invitee ends the flow holding the new time durably) and
      // the email-honesty flag #2686 added, which used to die at this boundary.
      res.json({
        status: out.booking.status,
        slotStartUtcMs: out.booking.slotStartUtcMs,
        ...(out.manageUrl ? { manageUrl: out.manageUrl } : {}),
        icsContent: out.icsContent,
        confirmationEmailed: out.confirmationEmailed,
      });
    } catch (err) { next(err); }
  });

  app.get(`${PUB}/:slug`, async (req, res, next) => {
    try {
      const link = await resolvePublic(req.params.slug);
      // R2 low batch (UX_UPGRADE-crm-public) — the page said WHAT you're
      // booking but never WITH WHOM. Display name only: an unauthed surface
      // must not leak the owner's email.
      const owner = await getUser(link.ownerUserId).catch(() => null);
      // Suppress a displayName that IS an email (imports/SCIM do this) — the
      // no-email rule on this unauthed surface beats the identity line (F10).
      const hostName = owner?.displayName && !owner.displayName.includes('@') ? owner.displayName : undefined;
      res.json({ ...publicLinkView(link), ...(hostName ? { hostName } : {}) });
    } catch (err) { next(err); }
  });

  app.get(`${PUB}/:slug/slots`, async (req, res, next) => {
    try {
      const link = await resolvePublic(req.params.slug);
      const durationMin = Number(req.query.durationMin);
      const fromMs = Number(req.query.from);
      const toMs = Number(req.query.to);
      if (!Number.isInteger(durationMin) || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
        throw new OpenwopError('validation_error', '`from`, `to` (epoch ms) and `durationMin` are required.', 400, {});
      }
      // Bound the requested window on an UNAUTHED endpoint: cap at the link's
      // advance horizon AND a hard per-request span, so slot generation (which
      // does a few Intl conversions per candidate) can't be driven into a CPU
      // DoS by a huge from→to. The client paginates for longer horizons.
      const MAX_QUERY_SPAN_MS = 62 * 86_400_000;
      const cappedTo = Math.min(toMs, fromMs + Math.min((link.maxAdvanceDays + 1) * 86_400_000, MAX_QUERY_SPAN_MS));
      const slots = await availableSlots(link, { fromMs, toMs: cappedTo, durationMin }, Date.now());
      res.json({ slots, timezone: link.timezone });
    } catch (err) { next(err); }
  });

  app.post(`${PUB}/:slug/claim`, async (req, res, next) => {
    try {
      const link = await resolvePublic(req.params.slug);
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Honeypot: any non-empty decoy ⇒ silent success, no booking (forms posture).
      const hp = body[HONEYPOT];
      const hpFilled = hp !== undefined && hp !== null && hp !== false && !(typeof hp === 'string' && hp.trim() === '');
      if (hpFilled) {
        log.warn('honeypot_dropped', { slug: link.slug, tenantId: link.tenantId });
        res.status(200).json({ ok: true });
        return;
      }
      const idempotencyKey = req.header('Idempotency-Key') ?? optionalString(body.idempotencyKey);
      const out = await claimSlot(link, {
        slotStartUtcMs: Number(body.slotStartUtcMs),
        durationMin: Number(body.durationMin),
        inviteeName: requireString(body.inviteeName, 'inviteeName'),
        inviteeEmail: requireString(body.inviteeEmail, 'inviteeEmail'),
        ...(optionalString(body.inviteeNote) ? { inviteeNote: optionalString(body.inviteeNote) } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        baseUrl: publicBaseUrl(req),
        nowMs: Date.now(),
      });
      res.status(out.replayed ? 200 : 201).json({
        ok: true,
        bookingId: out.booking.bookingId,
        slotStartUtcMs: out.booking.slotStartUtcMs,
        icsContent: out.icsContent,
        ...(out.manageUrl ? { manageUrl: out.manageUrl } : {}),
        // R2 CRMPUB-6 — #2686's honesty flag used to die at this boundary: the
        // UI could never say "confirmed — but we could not email you".
        confirmationEmailed: out.confirmationEmailed,
      });
    } catch (err) { next(err); }
  });
}
